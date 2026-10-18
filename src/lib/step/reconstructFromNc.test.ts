import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { nw30Bottom, nw31Top, OUTPUT_DIR } from '@test/fixtures'
import {
  BufferGeometry,
  Float32BufferAttribute,
  Mesh,
  MeshBasicMaterial,
  Raycaster,
  Vector3,
} from 'three'
import { describe, expect, it } from 'vitest'
import { parseNcGeometry } from '@/lib/parsers/ncGeometry'
import { measureStep } from './measure'
import { meshStepFile } from './mesh'
import { alignedOverlap } from './occDiff'
import { setOcWasmUrl } from './occInit'
import { reconstructStepFromNc } from './reconstructFromNc'

const require = createRequire(import.meta.url)
setOcWasmUrl(require.resolve('replicad-opencascadejs/wasm'))

/**
 * Demonstration / regression for the standalone NC → STEP reconstruction, run against the
 * real NW31 Top job when the fixtures happen to be on this machine. Skipped otherwise.
 */

const BASE = nw31Top()
const ncPath = (m: string) => join(BASE, 'NC files', `${m}.nc1`)
const stpPath = (m: string) => join(BASE, 'STP files', `${m}.stp`)

async function measure(bytes: string | Buffer): Promise<{ size: number[]; vol: number }> {
  const { importSTEP, measureVolume } = await import('replicad')
  const u8 = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : new Uint8Array(bytes)
  const shape = await importSTEP(new Blob([u8], { type: 'model/step' }))
  const [min, max] = (shape as { boundingBox: { bounds: [number[], number[]] } }).boundingBox.bounds
  return {
    size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
    vol: measureVolume(shape as never),
  }
}

const HAVE = existsSync(ncPath('m199')) && existsSync(stpPath('m199'))

/**
 * Fraction of the reference STEP's volume the NC-built solid covers once the **diff's** alignment
 * (not the NC build) has seated them — the NC pipeline is independent of the STEP, so the two are
 * reconciled here, exactly as `alignToReference` does for the overlay.
 */
async function overlapWithReference(mark: string): Promise<number> {
  const reference = new Uint8Array(readFileSync(stpPath(mark)))
  const built = await reconstructStepFromNc(readFileSync(ncPath(mark), 'utf8'))
  if (!built) return 0
  return alignedOverlap(new TextEncoder().encode(built), reference)
}

describe.skipIf(!HAVE)('reconstruct parts from NC (experimental)', () => {
  it('aligns to the part STEP file via the diff (m41/m31 are both PFCs needing opposite flips)', async () => {
    for (const mark of ['m41', 'm31', 'm124', 'm117', 'a1', 'm143']) {
      expect(await overlapWithReference(mark), `${mark} overlap`).toBeGreaterThan(0.9)
    }
  }, 900000)

  it('matches healthy sibling parts within tolerance (T, RHS, PFC, angle)', async () => {
    for (const mark of ['m199', 'm143', 'm117', 'm124', 'a1', 'm150', 'm153', 'm164']) {
      const step = await reconstructStepFromNc(readFileSync(ncPath(mark), 'utf8'))
      expect(step).toBeTruthy()
      if (!step) continue
      const built = await measure(step)
      const real = await measure(readFileSync(stpPath(mark)))
      const builtSorted = [...built.size].sort((a, b) => b - a)
      const realSorted = [...real.size].sort((a, b) => b - a)
      const dvol = Math.abs((built.vol - real.vol) / real.vol)
      console.log(
        `${mark}: built ${builtSorted.map((v) => v.toFixed(1)).join('x')} vol ${(built.vol / 1e6).toFixed(3)} | ` +
          `real ${realSorted.map((v) => v.toFixed(1)).join('x')} vol ${(real.vol / 1e6).toFixed(3)} | Δvol ${(dvol * 100).toFixed(1)}%`,
      )
      for (let i = 0; i < 3; i++) expect(Math.abs(builtSorted[i] - realSorted[i])).toBeLessThan(6)
      // volume within 4% (end-arc radii are drawn straight)
      expect(dvol).toBeLessThan(0.04)
    }
  }, 300000)

  it('keeps a mitred end attached with the union silhouette (a1)', async () => {
    const nc = readFileSync(ncPath('a1'), 'utf8')
    const real = await measureStep(new Uint8Array(readFileSync(stpPath('a1'))))
    // Faces disagree in X at a sloped/bevel end; the straight rebuild follows the union
    // silhouette, so the mitred end the STEP keeps attached stays attached...
    const straight = await reconstructStepFromNc(nc)
    expect(straight).toBeTruthy()
    if (!straight) return
    const built = await measureStep(new TextEncoder().encode(straight))
    expect(built.bodies).toBe(1)
    // ...at full member length (no severed tip, no dropped end).
    const longest = (size: number[]) => Math.max(...size)
    expect(Math.abs(longest(built.size) - longest(real.size))).toBeLessThan(6)
    // ...and the simplify fix still yields one solid.
    const simple = await reconstructStepFromNc(nc, { simplify: true })
    expect(simple).toBeTruthy()
    if (!simple) return
    expect((await measureStep(new TextEncoder().encode(simple))).bodies).toBe(1)
  }, 300000)

  it('produces usable geometry for the corrupted parts', async () => {
    for (const mark of ['m170', 'm198', 'm217']) {
      const step = await reconstructStepFromNc(readFileSync(ncPath(mark), 'utf8'))
      expect(step).toBeTruthy()
      if (!step) continue
      const built = await measure(step)
      // a real T part, not the 0.07 mm sheet the STEP held
      expect(Math.min(...built.size)).toBeGreaterThan(50)
      expect(Math.max(...built.size)).toBeGreaterThan(1500)
      mkdirSync(OUTPUT_DIR, { recursive: true })
      writeFileSync(join(OUTPUT_DIR, `nc-${mark}.stp`), step)
    }
  }, 300000)

  it('drills v-face holes on the one-sided T flange (m201)', async () => {
    // The BT tee flange lives on one side only (flange down, −Z). Drilling from
    // the face-pair side (+Z) cuts air and leaves every hole undrilled — the
    // drill side must follow section occupancy, not symmetry. m201 carries 8
    // Ø14 v-face holes through the 9.6 mm flange: a ray from the flange side
    // (−Z) passes the void untouched (0 hits); undrilled it strikes the face.
    if (!existsSync(ncPath('m201'))) return
    const ncText = readFileSync(ncPath('m201'), 'utf8')
    const step = await reconstructStepFromNc(ncText)
    expect(step).toBeTruthy()
    if (!step) return
    const meshed = await meshStepFile('m201·holes', new TextEncoder().encode(step))
    const meshes = meshed.bodies.map((body) => {
      const geometry = new BufferGeometry()
      geometry.setAttribute('position', new Float32BufferAttribute(body.mesh.faces.vertices, 3))
      geometry.setIndex(body.mesh.faces.triangles)
      geometry.computeBoundingSphere()
      return new Mesh(geometry, new MeshBasicMaterial())
    })
    const raycaster = new Raycaster()
    raycaster.far = Infinity
    const holes = parseNcGeometry(ncText).holes.filter((hole) => hole.diameter > 0)
    expect(holes.length).toBeGreaterThan(0)
    for (const hole of holes) {
      // v-face spans the 134 mm flange width, centred: cross position in Y.
      raycaster.set(new Vector3(hole.x, hole.y - 67, -500), new Vector3(0, 0, 1))
      const hits = raycaster.intersectObjects(meshes, false).length
      expect(hits, `vØ${hole.diameter} at x=${hole.x} y=${hole.y} drilled`).toBe(0)
    }
  }, 300000)
})

/**
 * A clean rectangular I-section (UB) with no features, as DSTV text. The four face outlines are
 * the full face rectangles, so the rebuild is the bare prism — enough to pin its cross-section
 * size and orientation.
 */
function cleanUbNc(
  length: number,
  depth: number,
  width: number,
  tf: number,
  tw: number,
  r: number,
): string {
  const number = (v: number): string => v.toFixed(2)
  const rect = (face: string, xs: number[], ys: number[]): string => {
    const first = `  ${face}       0.00s      0.00       0.00       0.00       0.00       0.00       0.00`
    const rows = xs.map(
      (x, i) =>
        `       ${number(x)}       ${number(ys[i] as number)}       0.00       0.00       0.00       0.00       0.00`,
    )
    return ['AK', first, ...rows].join('\n')
  }
  return [
    'ST',
    '** clean.nc1',
    '  100',
    '  M30',
    '  M30',
    '  1',
    '  300PLUS',
    '  1',
    '  UB360*57',
    '  I',
    `    ${number(length)}`,
    `     ${number(depth)}`,
    `     ${number(width)}`,
    `      ${number(tf)}`,
    `       ${number(tw)}`,
    `      ${number(r)}`,
    '     56.700',
    '      1.370',
    '      0.000',
    '      0.000',
    '      0.000',
    '      0.000',
    rect('v', [0, length, length, 0, 0], [0, 0, depth, depth, 0]),
    rect('o', [0, 0, length, length, 0], [0, width, width, 0, 0]),
    rect('u', [length, length, 0, 0], [0, width, width, 0]),
    'EN',
    '',
  ].join('\n')
}

describe('reconstructFromNc — clean I-section cross-section (synthetic)', () => {
  it('keeps the full depth, flange width on the other axis', async () => {
    // 360UB56.7: the NC header dims are [depth 359, flange width 172, tf 13, tw 8, r 11.4].
    // The header order is height-then-width, the *opposite* of a T's, so feeding it straight
    // into the section builder used to build the beam 90° wrong (359 wide × 172 deep).
    const nc = cleanUbNc(2000, 359, 172, 13, 8, 11.4)
    const step = await reconstructStepFromNc(nc)
    expect(step).toBeTruthy()
    if (!step) return
    const built = await measure(step)
    // Rolled into the canonical H frame: X = member, Y = depth (vertical in display), Z = flange width.
    expect(Math.abs((built.size[0] as number) - 2000)).toBeLessThan(6)
    expect(Math.abs((built.size[1] as number) - 359)).toBeLessThan(2)
    // Deeper than 300 mm: the old fixed `400 / −150` trim prism clipped the depth to 329 mm.
    expect(Math.abs((built.size[2] as number) - 172)).toBeLessThan(2)
  }, 120000)
})

const M71 = nw30Bottom('m71.nc1')

describe.skipIf(!existsSync(M71))('reconstruct slotted holes (NW30)', () => {
  it('removes the slot material a plain circle would leave (m71)', async () => {
    // m71's `o` face carries four Ø10 slots (`0.00l 0.00 10.00 0.00`). Rebuilding the same NC
    // with the slot type stripped leaves four plain Ø10 circles, so the difference in built
    // volume is exactly the slot material: 4 × (10 mm × 10 mm extension) × ~6.7 mm flange.
    const ncText = readFileSync(M71, 'utf8')
    const withSlots = await reconstructStepFromNc(ncText)
    const circles = ncText.replace(/(\b0\.00l)\s+[\d.-]+\s+[\d.-]+\s+[\d.-]+/g, '')
    expect(circles).not.toBe(ncText)
    const withCircles = await reconstructStepFromNc(circles)
    expect(withSlots).toBeTruthy()
    expect(withCircles).toBeTruthy()
    if (!withSlots || !withCircles) return
    const slotted = await measure(withSlots)
    const round = await measure(withCircles)
    expect(round.vol - slotted.vol).toBeGreaterThan(500)
  }, 300000)
})
