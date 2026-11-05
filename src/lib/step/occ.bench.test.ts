import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { nw30Bottom, nw31Top } from '@test/fixtures'
import { Matrix4 } from 'three'
import { describe, expect, it } from 'vitest'
import { parseDstv } from '@/lib/parsers/dstv'
import { partSectionForCode } from '@/lib/sections/stock'
import { type DiffSoup, probeDiffPresence } from './booleanDiff'
import { type MeasurableShape, measureShape } from './measure'
import { type MeshedStep, meshStepFile } from './mesh'
import { alignedOverlap, type OccDiffAttempt, occFuzzyDiff } from './occDiff'
import { ensureOc, setOcWasmUrl } from './occInit'
import { reconstructSolidFromNc } from './reconstructFromNc'
import { relativeSeat } from './seat'

const require = createRequire(import.meta.url)
setOcWasmUrl(require.resolve('replicad-opencascadejs/wasm'))

/**
 * OCC hot-path benchmark (opt-in):
 *
 *   SME_BENCH=1 pnpm vitest run src/lib/step/occ.bench.test.ts
 *
 * Reports per-stage speed AND the accuracy of the proposed shortcuts:
 * - probe-gated diff: does the fast mesh probe ever miss a real OCC boolean diff?
 * - coarse sabre mesh: do the same CUT_DEPTH failures survive?
 * - repeated import: how much is spent re-importing the same STEP across tasks?
 *
 * `SME_BENCH_PARTS` caps the part count (default 8); `SME_BENCH_MARKS` overrides the list.
 */

interface BenchPart {
  label: string
  nc: string
  stp: string
}

function candidates(): BenchPart[] {
  const out: BenchPart[] = []
  const add = (label: string, nc: string, stp: string) => {
    if (existsSync(nc) && existsSync(stp)) out.push({ label, nc, stp })
  }
  add('m71 PFC', nw30Bottom('m71.nc1'), nw30Bottom('m71.stp'))
  add('m87 PFC', nw30Bottom('m87.nc1'), nw30Bottom('m87.stp'))
  add('a2 EA', nw30Bottom('a2.nc1'), nw30Bottom('a2.stp'))
  add('m105 SHS', nw30Bottom('m105.nc1'), nw30Bottom('m105.stp'))
  add('m106 SHS', nw30Bottom('m106.nc1'), nw30Bottom('m106.stp'))
  add('m107 SHS', nw30Bottom('m107.nc1'), nw30Bottom('m107.stp'))
  add('m108 SHS', nw30Bottom('m108.nc1'), nw30Bottom('m108.stp'))
  add('m143 T', nw31Top('NC files', 'm143.nc1'), nw31Top('STP files', 'm143.stp'))
  add('m180 SHS', nw31Top('NC files', 'm180.nc1'), nw31Top('STP files', 'm180.stp'))
  const override = process.env.SME_BENCH_MARKS
  if (override) {
    const wanted = new Set(override.split(',').map((mark) => mark.trim()))
    return out.filter((mark) => wanted.has(mark.label.split(' ')[0] as string))
  }
  return out.slice(0, Number(process.env.SME_BENCH_PARTS ?? 8))
}

const RUN = process.env.SME_BENCH === '1' && candidates().length > 0

const soups = (meshed: MeshedStep): DiffSoup[] =>
  meshed.bodies.map((body) => ({
    vertices: body.mesh.faces.vertices,
    triangles: body.mesh.faces.triangles,
  }))

const signature = (failures: { point: number[] }[]): string =>
  failures
    .map((failure) => failure.point.map((value) => value.toFixed(1)).join(','))
    .sort()
    .join('|')

const share = (volume: number, whole: number): number => (whole > 0 ? volume / whole : 0)

const OCC_DIFF_FLOOR_MM3 = 1

const sameDiff = (
  a: { overVolume: number; underVolume: number } | null,
  b: { overVolume: number; underVolume: number } | null,
): boolean => {
  if (!a || !b) return a === b
  return (
    Math.abs(a.overVolume - b.overVolume) < 1e-6 && Math.abs(a.underVolume - b.underVolume) < 1e-6
  )
}

describe.runIf(RUN)('OCC hot-path benchmark', () => {
  it('measures speed and shortcut accuracy across real parts', async () => {
    await ensureOc()
    const { importSTEP, measureVolume } = await import('replicad')
    const parts = candidates()

    const rows: string[][] = []
    let import1Ms = 0
    let import5Ms = 0
    let meshMs = 0
    let rebuildMs = 0
    let rebuildLeanMs = 0
    let probeMs = 0
    let diffMs = 0
    let cutsDiffMs = 0
    let resultMismatches = 0
    let gatedSavingMs = 0
    let falseNegatives = 0
    let occOvergrown = 0
    let probeUnknown = 0
    let occFailed = 0
    let sabreMismatches = 0
    let sabreCoarseMs = 0
    let attemptsTotal = 0
    let cutAttemptsTotal = 0
    let commonMs = 0
    let cutMs = 0
    let wastedCommonMs = 0
    let cutsCommonMs = 0
    let firstTryFuzzy = 0
    let retriedFuzzy = 0
    let exhaustedFuzzy = 0

    for (const part of parts) {
      const ncText = readFileSync(part.nc, 'utf8')
      const stepBytes = new Uint8Array(readFileSync(part.stp))
      const header = parseDstv(ncText).header
      const profile = partSectionForCode(header.profile, header.dimensions)?.points

      let start = performance.now()
      const stepShape = (await importSTEP(
        new Blob([new Uint8Array(stepBytes)], { type: 'model/step' }),
      )) as unknown as MeasurableShape & { delete: () => void }
      const stepMeasure = await measureShape(stepShape).catch(() => null)
      const import1 = performance.now() - start
      import1Ms += import1
      stepShape.delete()

      start = performance.now()
      for (let i = 0; i < 4; i++) {
        const shape = (await importSTEP(
          new Blob([new Uint8Array(stepBytes)], { type: 'model/step' }),
        )) as unknown as { delete: () => void }
        shape.delete()
      }
      const import5 = import1 + (performance.now() - start)
      import5Ms += import5

      start = performance.now()
      const full = await reconstructSolidFromNc(ncText)
      const rebuildTime = performance.now() - start
      rebuildMs += rebuildTime
      if (!full) {
        rows.push([part.label, import1.toFixed(0), '-', '-', '-', 'REBUILD FAILED'])
        continue
      }
      const sabreFine = full.sabre

      start = performance.now()
      const stepMesh = await meshStepFile(`${part.label}·step`, stepBytes)
      const madeMesh = await meshStepFile(`${part.label}·made`, new TextEncoder().encode(full.step))
      meshMs += performance.now() - start

      start = performance.now()
      const lean = await reconstructSolidFromNc(ncText, { measureOnly: true })
      rebuildLeanMs += performance.now() - start

      const coarseStart = performance.now()
      const coarse = await reconstructSolidFromNc(ncText, {
        measureOnly: true,
        sabreMesh: { tolerance: 0.5, angularTolerance: 20 },
      })
      sabreCoarseMs += performance.now() - coarseStart
      if (signature(sabreFine) !== signature(coarse?.sabre ?? [])) sabreMismatches += 1

      const compareMatrix = profile
        ? relativeSeat(madeMesh.vertices, stepMesh.vertices, profile, true)
        : new Matrix4()

      start = performance.now()
      const probe = probeDiffPresence(
        soups(madeMesh),
        soups(stepMesh),
        new Matrix4(),
        compareMatrix,
      )
      const probeTime = performance.now() - start
      probeMs += probeTime

      const madeBytes = new TextEncoder().encode(full.step)
      const runDiff = async (order: 'common-first' | 'cuts-first') => {
        const attempts: OccDiffAttempt[] = []
        const started = performance.now()
        const result = await occFuzzyDiff(
          madeBytes,
          stepBytes,
          new Matrix4(),
          compareMatrix,
          undefined,
          { order, trace: (attempt) => attempts.push(attempt) },
        )
        return { result, attempts, ms: performance.now() - started }
      }
      const base = await runDiff('common-first')
      const cuts = await runDiff('cuts-first')
      const diff = base.result
      const diffTime = base.ms
      diffMs += base.ms
      cutsDiffMs += cuts.ms
      if (!sameDiff(diff, cuts.result)) resultMismatches += 1

      attemptsTotal += base.attempts.length
      cutAttemptsTotal += cuts.attempts.length
      for (const attempt of base.attempts) {
        if (attempt.phase === 'common') commonMs += attempt.ms
        else cutMs += attempt.ms
      }
      for (const attempt of cuts.attempts) {
        if (attempt.phase === 'common') cutsCommonMs += attempt.ms
      }
      const fuzzies = [...new Set(base.attempts.map((attempt) => attempt.fuzzy))]
      const usedFuzzy = diff ? (base.attempts[base.attempts.length - 1]?.fuzzy ?? null) : null
      if (diff && usedFuzzy === fuzzies[0]) firstTryFuzzy += 1
      else if (diff) retriedFuzzy += 1
      if (!diff && base.attempts.length > 0) exhaustedFuzzy += 1
      const wastedCommon = base.attempts
        .filter((attempt) => attempt.phase === 'common' && attempt.fuzzy !== usedFuzzy)
        .reduce((sum, attempt) => sum + attempt.ms, 0)
      wastedCommonMs += wastedCommon

      const occVolume = diff ? diff.overVolume + diff.underVolume : null
      const occFound = occVolume != null && occVolume > OCC_DIFF_FLOOR_MM3
      if (diff == null) occFailed += 1
      if (probe == null) probeUnknown += 1
      if (probe && !probe.found && occFound) {
        const truth = await alignedOverlap(madeBytes, stepBytes)
        if (truth > 0.98) occOvergrown += 1
        else falseNegatives += 1
      }
      if (probe && !probe.found) gatedSavingMs += diffTime

      const refVolume = stepMeasure?.volume ?? 0
      const madeVolume = lean ? measureVolume(lean.solid as never) : 0
      const volumeDelta = refVolume > 0 ? (madeVolume - refVolume) / refVolume : Number.NaN
      const probeOver = probe ? probe.overShare : Number.NaN
      const probeUnder = probe ? probe.underShare : Number.NaN
      const occOver = diff ? share(diff.overVolume, diff.primaryVolume) : Number.NaN
      const occUnder = diff ? share(diff.underVolume, diff.primaryVolume) : Number.NaN

      rows.push([
        part.label,
        import1.toFixed(0),
        import5.toFixed(0),
        probeTime.toFixed(0),
        diffTime.toFixed(0),
        cuts.ms.toFixed(0),
        `${base.attempts.length}/${fuzzies.length}`,
        `${cuts.attempts.length}`,
        wastedCommon.toFixed(0),
        sameDiff(diff, cuts.result) ? 'same' : 'DIFF',
        diff == null ? 'null' : occFound ? 'diff' : 'clean',
        probe == null ? 'null' : `${(probeOver * 100).toFixed(2)}/${(probeUnder * 100).toFixed(2)}`,
        diff == null ? '-' : `${(occOver * 100).toFixed(2)}/${(occUnder * 100).toFixed(2)}`,
        Number.isFinite(volumeDelta) ? `${(volumeDelta * 100).toFixed(2)}%` : '-',
        signature(sabreFine) === signature(coarse?.sabre ?? []) ? 'same' : 'CHANGED',
      ])
    }

    const head = [
      'part',
      'imp1',
      'imp5',
      'probe',
      'occ',
      'cuts',
      'bool/f',
      'cutsN',
      'waste',
      'equal',
      'verdict',
      'probe%',
      'occ%',
      'volΔ',
      'sabre',
    ]
    const width = head.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)))
    const line = (cells: string[]) =>
      `  ${cells.map((cell, i) => cell.padEnd(width[i] ?? 0)).join('  ')}`

    console.log(
      `\nOCC hot-path benchmark (ms per part; probe%/occ% = over/under shares):\n${line(head)}\n${rows
        .map(line)
        .join('\n')}`,
    )
    console.log(
      `\nTOTALS over ${parts.length} parts (ms):\n` +
        `  import×1 ${import1Ms.toFixed(0)}  import×5 ${import5Ms.toFixed(0)}  (per repeat ≈ ${((import5Ms - import1Ms) / (parts.length * 4)).toFixed(1)})\n` +
        `  mesh both ${meshMs.toFixed(0)}  rebuild ${rebuildMs.toFixed(0)}  rebuild lean ${rebuildLeanMs.toFixed(0)}  (export ≈ ${((rebuildMs - rebuildLeanMs) / parts.length).toFixed(1)}/part)\n` +
        `  diff probe ${probeMs.toFixed(0)}  OCC common-first ${diffMs.toFixed(0)}  cuts-first ${cutsDiffMs.toFixed(0)}  ` +
        `(probe is ${(diffMs / Math.max(probeMs, 1)).toFixed(0)}× cheaper)\n` +
        `  OCC booleans common-first ${attemptsTotal} (${(attemptsTotal / parts.length).toFixed(1)}/part): common ${commonMs.toFixed(0)}  cuts ${cutMs.toFixed(0)}  wasted-common ${wastedCommonMs.toFixed(0)} (${((wastedCommonMs / Math.max(commonMs, 1)) * 100).toFixed(0)}%)\n` +
        `  OCC booleans cuts-first ${cutAttemptsTotal} (${(cutAttemptsTotal / parts.length).toFixed(1)}/part): common ${cutsCommonMs.toFixed(0)}  ` +
        `cuts-first result mismatches ${resultMismatches}\n` +
        `  fuzzy outcome: first try ${firstTryFuzzy}, retried ${retriedFuzzy}, exhausted ${exhaustedFuzzy}\n` +
        `  sabre coarse ${sabreCoarseMs.toFixed(0)}  (fine is inside the rebuild time above)\n` +
        `\nGATE ACCURACY: false negatives ${falseNegatives}, OCC overgrown ${occOvergrown}, probe unknown ${probeUnknown}, OCC null ${occFailed}, sabre mismatches ${sabreMismatches}\n` +
        `GATE SPEED: OCC diff skipped on probe-clean parts ≈ ${gatedSavingMs.toFixed(0)} ms ` +
        `(${((gatedSavingMs / Math.max(diffMs, 1)) * 100).toFixed(0)}% of all diff time)`,
    )

    expect(rows.length).toBeGreaterThan(0)
  }, 900_000)
})
