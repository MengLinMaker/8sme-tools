import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { chsLeg, fixtureExists } from '@test/fixtures'
import { describe, expect, it } from 'vitest'
import { ensureOc, setOcWasmUrl } from './occInit'
import { detectTabDefaults, tabStep } from './tabs'

const require = createRequire(import.meta.url)
setOcWasmUrl(require.resolve('replicad-opencascadejs/wasm'))

const CHS = chsLeg('7347-18m-Leg-Nest-11980.stp')
const HAVE_CHS = fixtureExists('chs', '7347-18m-Leg-Nest-11980.stp')

async function stepBytes(shapes: unknown[]): Promise<Uint8Array> {
  const { compoundShapes } = await import('replicad')
  const compound = compoundShapes(shapes as never)
  return new Uint8Array(
    await (compound as unknown as { blobSTEP: () => Blob }).blobSTEP().arrayBuffer(),
  )
}

async function bodyCount(bytes: Uint8Array): Promise<number> {
  const { importSTEP } = await import('replicad')
  const shape = await importSTEP(new Blob([new Uint8Array(bytes)], { type: 'model/step' }))
  const count = shape.solids?.length ?? 0
  shape.delete()
  return count
}

async function bounds(bytes: Uint8Array): Promise<[number[], number[]]> {
  const { importSTEP } = await import('replicad')
  const shape = await importSTEP(new Blob([new Uint8Array(bytes)], { type: 'model/step' }))
  const bounds = (shape as unknown as { boundingBox: { bounds: [number[], number[]] } }).boundingBox
    .bounds
  shape.delete()
  return [bounds[0], bounds[1]]
}

/** Cross-section area (mm²) of a STEP at z, via a thin slab boolean. */
async function sliceArea(bytes: Uint8Array, z: number): Promise<number> {
  const { getOC, importSTEP, makeBox, measureVolume } = await import('replicad')
  const oc = getOC()
  const shape = await importSTEP(new Blob([new Uint8Array(bytes)], { type: 'model/step' }))
  const thickness = 0.2
  const slab = makeBox([-1000, -1000, z - thickness / 2], [1000, 1000, z + thickness / 2])
  const op = new oc.BRepAlgoAPI_Common(shape.wrapped, slab.wrapped)
  op.SetFuzzyValue(0.001)
  op.Build()
  const { cast } = await import('replicad')
  const area = measureVolume(cast(op.Shape() as never) as never) / thickness
  shape.delete()
  slab.delete()
  return area
}

/** Two thin-web T-like rows with a 6 mm web gap, for flush/width checks. */
async function thinWebPair(): Promise<Uint8Array> {
  const { makeBox } = await import('replicad')
  const web = { half: 3, depth: 100 }
  const flange = { half: 50, depth: 10 }
  const lower = makeBox([-web.half, -web.depth, 0], [web.half, -3, 1000]).fuse(
    makeBox([-flange.half, -web.depth - flange.depth, 0], [flange.half, -web.depth, 1000]),
  )
  const upper = makeBox([-web.half, 3, 0], [web.half, web.depth, 1000]).fuse(
    makeBox([-flange.half, web.depth, 0], [flange.half, web.depth + flange.depth, 1000]),
  )
  return stepBytes([lower, upper])
}

describe('tabStep', () => {
  it('returns null for a single-body STEP', async () => {
    await ensureOc()
    const { makeBox } = await import('replicad')
    const bytes = await stepBytes([makeBox([0, 0, 0], [100, 50, 100])])
    expect(await tabStep(bytes, { density: 2 })).toBeNull()
  }, 300000)

  it('joins end-to-end bodies into one solid', async () => {
    await ensureOc()
    const { makeBox } = await import('replicad')
    const bytes = await stepBytes([
      makeBox([0, 0, 0], [100, 50, 100]),
      makeBox([0, 0, 105], [100, 50, 205]),
    ])
    const result = await tabStep(bytes, { density: 2 })
    expect(result).not.toBeNull()
    if (!result) return
    expect(result.pieces).toBe(2)
    expect(result.tabs).toBeGreaterThanOrEqual(1)
    expect(await bodyCount(result.bytes)).toBe(1)
    const [beforeMin, beforeMax] = await bounds(bytes)
    const [afterMin, afterMax] = await bounds(result.bytes)
    for (let axis = 0; axis < 3; axis++) {
      expect(afterMin[axis]).toBeCloseTo(beforeMin[axis] as number, 2)
      expect(afterMax[axis]).toBeCloseTo(beforeMax[axis] as number, 2)
    }
  }, 300000)

  it('joins side-by-side rows at the requested density', async () => {
    await ensureOc()
    const { makeBox } = await import('replicad')
    const bytes = await stepBytes([
      makeBox([0, 0, 0], [100, 50, 1000]),
      makeBox([0, 55, 0], [100, 105, 1000]),
    ])
    const result = await tabStep(bytes, { density: 1 })
    expect(result).not.toBeNull()
    if (!result) return
    expect(result.pieces).toBe(2)
    expect(result.tabs).toBe(1)
    expect(await bodyCount(result.bytes)).toBe(1)
  }, 300000)

  it('detects the local web thickness as the default tab width', async () => {
    await ensureOc()
    const bytes = await thinWebPair()
    const defaults = await detectTabDefaults(bytes)
    expect(defaults.tabLength).toBe(50)
    expect(defaults.tabWidth).toBeCloseTo(6, 1)
    expect(defaults.engagement).toBe(1.5)
    expect(defaults.density).toBe(2)
  }, 300000)

  it('clips a non-round tab flush to a thin web on both faces', async () => {
    await ensureOc()
    const bytes = await thinWebPair()
    const before = await sliceArea(bytes, 500)
    const result = await tabStep(bytes, { density: 1, tabLength: 50, tabWidth: 6, engagement: 1 })
    expect(result).not.toBeNull()
    if (!result) return
    expect(await bodyCount(result.bytes)).toBe(1)
    // One tab bridges the 6 mm web-end gap; flush means 6 mm wide → exactly 36 mm² added.
    // A too-wide 8 mm tab would add 48 mm² and still hide inside the assembly bbox.
    expect((await sliceArea(result.bytes, 500)) - before).toBeCloseTo(36, 0)
  }, 300000)

  it.skipIf(!HAVE_CHS)(
    'bridges the hollow seam of a real CHS pair',
    async () => {
      await ensureOc()
      const bytes = new Uint8Array(readFileSync(CHS))
      const result = await tabStep(bytes, { density: 2 })
      expect(result).not.toBeNull()
      if (!result) return
      expect(result.pieces).toBe(2)
      expect(result.tabs).toBeGreaterThanOrEqual(1)
      expect(await bodyCount(result.bytes)).toBe(1)
      // The tab must not change the stock envelope, and at the joint it must fill the seam
      // without invading the bore: the section should be the full Ø508 × Ø489 annulus.
      const [beforeMin, beforeMax] = await bounds(bytes)
      const [afterMin, afterMax] = await bounds(result.bytes)
      for (let axis = 0; axis < 3; axis++) {
        expect(afterMin[axis]).toBeCloseTo(beforeMin[axis] as number, 2)
        expect(afterMax[axis]).toBeCloseTo(beforeMax[axis] as number, 2)
      }
      const annulus = Math.PI * (254 ** 2 - 244.5 ** 2)
      const area = await sliceArea(result.bytes, 6000)
      expect(area).toBeGreaterThan(annulus - 5)
      expect(area).toBeLessThan(annulus + 5)
    },
    300000,
  )

  it('keeps every body when several pieces are nested in two rows', async () => {
    await ensureOc()
    const { makeBox } = await import('replicad')
    const bytes = await stepBytes([
      makeBox([0, 0, 0], [100, 50, 90]),
      makeBox([0, 0, 95], [100, 50, 185]),
      makeBox([0, 55, 0], [100, 105, 90]),
      makeBox([0, 55, 95], [100, 105, 185]),
    ])
    const result = await tabStep(bytes, { density: 2 })
    expect(result).not.toBeNull()
    if (!result) return
    expect(result.pieces).toBe(4)
    expect(result.tabs).toBeGreaterThanOrEqual(3)
    expect(await bodyCount(result.bytes)).toBe(1)
  }, 300000)
})
