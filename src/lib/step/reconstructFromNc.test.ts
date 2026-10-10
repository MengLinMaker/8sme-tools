import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
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
import { setOcWasmUrl } from './occInit'
import { reconstructStepFromNc } from './reconstructFromNc'

const require = createRequire(import.meta.url)
setOcWasmUrl(require.resolve('replicad-opencascadejs/wasm'))

/**
 * Demonstration / regression for the standalone NC → STEP reconstruction, run against the
 * real NW31 Top job when the fixtures happen to be on this machine. Skipped otherwise.
 */

const BASE = join(
  process.env.USERPROFILE ?? '',
  'Downloads',
  'Failed tests',
  '11602-03-01 (NW31 Top frames) Shaft part drawings',
  'Shaft part drawings',
)
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

/** Fraction of the reference STEP's volume the NC-built solid covers when aligned to it. */
async function overlapWithReference(mark: string): Promise<number> {
  const { importSTEP, measureVolume } = await import('replicad')
  const reference = new Uint8Array(readFileSync(stpPath(mark)))
  const built = await reconstructStepFromNc(readFileSync(ncPath(mark), 'utf8'), { reference })
  if (!built) return 0
  const b = (await importSTEP(new Blob([new TextEncoder().encode(built)]))) as never
  const r = (await importSTEP(new Blob([reference]))) as never
  const inter = (b as unknown as { intersect: (o: never) => never }).intersect(r)
  return measureVolume(inter as never) / measureVolume(r)
}

describe.skipIf(!HAVE)('reconstruct parts from NC (experimental)', () => {
  it('orients to the part STEP file (m41/m31 are both PFCs needing opposite flips)', async () => {
    for (const mark of ['m41', 'm31', 'm124', 'm117', 'a1', 'm143']) {
      expect(await overlapWithReference(mark), `${mark} overlap`).toBeGreaterThan(0.9)
    }
  }, 600000)

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

  it('simplify keeps a mitred end attached (a1)', async () => {
    const nc = readFileSync(ncPath('a1'), 'utf8')
    // Straight-through cuts sever the mitred v-leg end (which the STEP keeps attached)...
    const straight = await reconstructStepFromNc(nc)
    expect(straight).toBeTruthy()
    if (!straight) return
    expect((await measureStep(new TextEncoder().encode(straight))).bodies).toBeGreaterThan(1)
    // ...and the simplify fix leaves that surface uncut, so it stays one solid.
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
      writeFileSync(join(process.env.TEMP ?? '.', `nc-${mark}.stp`), step)
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
