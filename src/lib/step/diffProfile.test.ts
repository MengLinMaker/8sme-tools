import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { nw30Bottom } from '@test/fixtures'
import { BoxGeometry, Matrix4 } from 'three'
import { describe, expect, it } from 'vitest'
import {
  booleanDiff,
  booleanDiffRaw,
  type DiffSoup,
  probeDiffPresence,
  toWorldSoup,
} from '@/lib/step/booleanDiff'
import { createMeshQuery, diffFraction } from '@/lib/step/diffHighlight'
import { type MeshedStep, meshStepFile } from '@/lib/step/mesh'
import { alignToReference } from '@/lib/step/occDiff'
import { ensureOc, setOcWasmUrl } from '@/lib/step/occInit'
import { reconstructSolidFromNc } from '@/lib/step/reconstructFromNc'

const require = createRequire(import.meta.url)
setOcWasmUrl(require.resolve('replicad-opencascadejs/wasm'))

const IDENTITY = new Matrix4()

function boxSoup(w: number, h: number, d: number, cx = 0): DiffSoup {
  const geometry = new BoxGeometry(w, h, d)
  geometry.translate(cx, 0, 0)
  const position = geometry.getAttribute('position')
  const index = geometry.getIndex()
  return {
    vertices: Array.from(position.array as Float32Array),
    triangles: index ? Array.from(index.array as Uint16Array | Uint32Array) : [],
  }
}

describe('diff presence probe (no fixtures needed)', () => {
  it('reports no diff for identical models', () => {
    const soup = [boxSoup(10, 10, 10)]
    const presence = probeDiffPresence(soup, soup, IDENTITY, IDENTITY)
    expect(presence).not.toBeNull()
    expect(presence?.found).toBe(false)
    expect(presence?.overShare).toBe(0)
    expect(presence?.underShare).toBe(0)
  })

  it('reports a diff for offset models', () => {
    const presence = probeDiffPresence(
      [boxSoup(10, 10, 10, 0)],
      [boxSoup(10, 10, 10, 5)],
      IDENTITY,
      IDENTITY,
    )
    expect(presence?.found).toBe(true)
    expect(presence ? Math.max(presence.overShare, presence.underShare) : 0).toBeGreaterThan(0.3)
  })

  it('reports a total diff against an empty model', () => {
    const presence = probeDiffPresence([], [boxSoup(10, 10, 10)], IDENTITY, IDENTITY)
    expect(presence?.found).toBe(true)
    expect(presence?.overShare).toBe(1)
    expect(presence?.underShare).toBe(0)
  })
})

const DIR = nw30Bottom()
const HAVE_M87 = existsSync(join(DIR, 'm87.nc1')) && existsSync(join(DIR, 'm87.stp'))

/**
 * Bottleneck profile for the overlay diff on a real part (m87: NW30 PFC). Its `o` face carries
 * slotted holes, which the reconstruction used to cut as plain circles — a spurious ~44 % undercut
 * that the deviation/boolean stack reported as "notch diffs on both sides" (red ~1.3k, blue ~4k
 * mm³). With DSTV slots parsed (`0.00l …`) the manufactured solid now matches the STEP, so this
 * profiles each pipeline stage **and** guards that a clean part reads as clean. Order-of-magnitude
 * asserts only — tri counts drift with tessellation settings.
 */
describe.skipIf(!HAVE_M87)('overlay diff profile (m87)', () => {
  it('reconstructs m87 cleanly (slots, not holes) and times every stage', async () => {
    await ensureOc()
    const ncText = readFileSync(join(DIR, 'm87.nc1'), 'utf8')
    const stepBytes = new Uint8Array(readFileSync(join(DIR, 'm87.stp')))
    const triTotal = (m: MeshedStep) =>
      m.bodies.reduce((n, b) => n + Math.floor(b.mesh.faces.triangles.length / 3), 0)

    let start = performance.now()
    // The NC builds in its own canonical frame; the STEP is reconciled by the diff's alignment.
    const built = await reconstructSolidFromNc(ncText)
    expect(built).not.toBeNull()
    const madeBytes = new TextEncoder().encode(built?.step ?? '')
    const reconstructMs = performance.now() - start

    start = performance.now()
    const mfg = await meshStepFile('m87·mfg', madeBytes)
    const stp = await meshStepFile('m87·step', stepBytes)
    const meshMs = performance.now() - start

    const soups = (m: typeof mfg) =>
      m.bodies.map((b) => ({ vertices: b.mesh.faces.vertices, triangles: b.mesh.faces.triangles }))
    start = performance.now()
    const mfgMatrix = new Matrix4()
    const stpMatrix = await alignToReference(stepBytes, madeBytes)
    const seatMs = performance.now() - start

    start = performance.now()
    const presence = probeDiffPresence(soups(mfg), soups(stp), mfgMatrix, stpMatrix)
    const probeMs = performance.now() - start
    // The slot fix makes m87's manufactured solid agree with the STEP: no overcut/undercut.
    expect(presence?.found).toBe(false)
    expect(presence?.overShare ?? 1).toBeLessThan(0.02)
    expect(presence?.underShare ?? 1).toBeLessThan(0.02)

    // Split the probe open: index builds vs queries.
    const mfgSoup = toWorldSoup(soups(mfg), mfgMatrix)
    const stpSoup = toWorldSoup(soups(stp), stpMatrix)
    start = performance.now()
    const queryMfg = createMeshQuery(mfgSoup.vertices, mfgSoup.triangles, 1)
    const queryStp = createMeshQuery(stpSoup.vertices, stpSoup.triangles, 1)
    const indexMs = performance.now() - start
    start = performance.now()
    const overShare = diffFraction(queryMfg.flagFar(stpSoup.vertices, stpSoup.triangles))
    const underShare = diffFraction(queryStp.flagFar(mfgSoup.vertices, mfgSoup.triangles))
    const queryMs = performance.now() - start

    start = performance.now()
    const raw = booleanDiffRaw(soups(mfg), soups(stp), mfgMatrix, stpMatrix)
    const rawMs = performance.now() - start
    expect(raw).not.toBeNull()

    start = performance.now()
    const full = booleanDiff(soups(mfg), soups(stp), mfgMatrix, stpMatrix)
    const fullMs = performance.now() - start
    // Clean part: the boolean finds no over/under solid at all.
    expect(full?.over).toBeNull()
    expect(full?.under).toBeNull()
    expect(full?.overVolume ?? 0).toBeLessThan(200)
    expect(full?.underVolume ?? 0).toBeLessThan(200)

    const rows: [string, string][] = [
      ['reconstruct (OCC booleans)', `${(reconstructMs / 1000).toFixed(1)}s`],
      [`mesh both (${triTotal(mfg)}/${triTotal(stp)} tris)`, `${(meshMs / 1000).toFixed(1)}s`],
      ['seat + soup', `${seatMs.toFixed(0)}ms`],
      [
        `probe (shares ${(presence ? presence.overShare * 100 : 0).toFixed(1)}%/${(presence ? presence.underShare * 100 : 0).toFixed(1)}%)`,
        `${probeMs.toFixed(0)}ms = index ${indexMs.toFixed(0)} + queries ${queryMs.toFixed(0)} (recomputed ${(overShare * 100).toFixed(1)}%/${(underShare * 100).toFixed(1)}%)`,
      ],
      ['raw CSG both directions', `${(rawMs / 1000).toFixed(1)}s`],
      [
        `full booleanDiff incl. 2nd CSG (over ${(full?.overVolume ?? 0).toFixed(0)} / under ${(full?.underVolume ?? 0).toFixed(0)} mm³)`,
        `${(fullMs / 1000).toFixed(1)}s`,
      ],
    ]
    const width = Math.max(...rows.map(([stage]) => stage.length))
    console.log(
      `\noverlay diff profile (m87):\n${rows.map(([stage, time]) => `  ${stage.padEnd(width)}  ${time}`).join('\n')}`,
    )
  }, 600000)
})
