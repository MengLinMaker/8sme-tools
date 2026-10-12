import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { nw31Top, OUTPUT_DIR } from '@test/fixtures'
import { measureVolume } from 'replicad'
import { describe, expect, it } from 'vitest'
import { parseDstv } from '@/lib/parsers/dstv'
import { getUb } from '@/lib/sections/ub'
import { buildCutBeamStep } from './cutBeam'
import { inflateProfile, type Profile, penFromProfile, placeRealPart, teeProfiles } from './occ'
import { ensureOc, setOcWasmUrl } from './occInit'

const require = createRequire(import.meta.url)
setOcWasmUrl(require.resolve('replicad-opencascadejs/wasm'))

/**
 * Validation against the NW31 Top frames job on this machine. The 31 `BT100*15` tees are the
 * ground-truth set: each has a matching `.nc1` (lengths) and `.stp` (real geometry). Uses the
 * real STEP so the model exercises holes/curves/mitres exactly as the job does. Skipped when
 * the fixtures are absent.
 */

const BASE = nw31Top()
const ncPath = (m: string) => join(BASE, 'NC files', `${m}.nc1`)
const stpPath = (m: string) => join(BASE, 'STP files', `${m}.stp`)

const TEES = [
  'm118',
  'm134',
  'm135',
  'm143',
  'm144',
  'm145',
  'm146',
  'm149',
  'm153',
  'm164',
  'm170',
  'm198',
  'm199',
  'm200',
  'm201',
  'm202',
  'm203',
  'm204',
  'm205',
  'm206',
  'm207',
  'm208',
  'm209',
  'm217',
  'm218',
  'm227',
  'm228',
  'm229',
  'm230',
  'm231',
  'm232',
]

const HAVE = existsSync(ncPath('m118')) && existsSync(stpPath('m118'))

interface ShapeOps {
  intersect: (other: unknown) => unknown
}

function prismOf(profile: Profile, length: number) {
  return import('replicad').then(({ draw }) =>
    penFromProfile(draw(profile.start), profile).close().sketchOnPlane('XY').extrude(length),
  )
}

const lengthOf = (mark: string): number =>
  parseDstv(readFileSync(ncPath(mark), 'utf8')).header.length ?? 0

describe.skipIf(!HAVE)('NW31 tee validation', () => {
  it('every real tee sits inside the ideal T profile (features carried, not clipped)', async () => {
    await ensureOc()
    const section = getUb('200UB29.8')
    expect(section).toBeDefined()
    if (!section) return
    const { top } = teeProfiles(section, 3)

    let worst = 1
    let worstMark = ''
    const bad: string[] = []
    for (const mark of TEES) {
      const bytes = new Uint8Array(readFileSync(stpPath(mark)))
      const real = await placeRealPart(
        new Blob([bytes], { type: 'model/step' }),
        section.d / 4,
        false,
      )
      const realVol = measureVolume(real.shape as never)
      // Same hair-line blow-up the production carve uses, so an exact face coincidence doesn't
      // make OCC's intersect return empty (which would falsely read as a misfit).
      const ideal = await prismOf(inflateProfile(top), real.length)
      const clipped = (real.shape as unknown as ShapeOps).intersect(ideal)
      const clippedVol = measureVolume(clipped as never)
      const ratio = realVol > 0 ? clippedVol / realVol : 0
      // eslint-disable-next-line no-console
      console.log(`${mark}: len=${real.length.toFixed(1)} fit=${(ratio * 100).toFixed(1)}%`)
      if (ratio < 0.9) bad.push(mark)
      if (ratio < worst) {
        worst = ratio
        worstMark = mark
      }
    }
    // eslint-disable-next-line no-console
    console.log(`worst fit: ${worstMark} ${(worst * 100).toFixed(1)}% | bad: ${bad.join(', ')}`)
    // The healthy tees (the "manufacturing NC and STEP match" examples) all align. The 4
    // known-corrupted exports (m170/m198/m217/m200) are reported and fall back to the clean prism.
    expect(TEES.length - bad.length).toBeGreaterThanOrEqual(27)
    expect(bad).not.toContain('m118')
  }, 600000)

  it('builds a whole beam from real tees', async () => {
    const section = getUb('200UB29.8')
    if (!section) return
    const chunk = TEES.slice(0, 8)
    const pieces = chunk.map((mark) => ({
      mark,
      length: lengthOf(mark),
      bytes: new Uint8Array(readFileSync(stpPath(mark))),
    }))
    const step = await buildCutBeamStep({
      section,
      name: 'nw31',
      stockLength: 12000,
      left: pieces.slice(0, 4),
      right: pieces.slice(4),
      kerf: 3,
    })
    expect(step).toContain('AUTOMOTIVE_DESIGN')
    const bodies = (step.match(/MANIFOLD_SOLID_BREP/g) ?? []).length
    expect(bodies).toBeGreaterThan(0)
    mkdirSync(OUTPUT_DIR, { recursive: true })
    const out = join(OUTPUT_DIR, 'nw31-cutbeam.step')
    writeFileSync(out, step)
    // eslint-disable-next-line no-console
    console.log(`nw31 whole-beam bodies=${bodies} -> ${out}`)
  }, 600000)
})
