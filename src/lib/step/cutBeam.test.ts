import { createRequire } from 'node:module'
import { measureVolume } from 'replicad'
import { describe, expect, it } from 'vitest'
import { getUb } from '@/lib/sections/ub'
import { buildCutBeamStep, type CutBeamPiece } from './cutBeam'
import { mirrorY, penFromProfile, teeProfiles } from './occ'
import { setOcWasmUrl } from './occInit'

const require = createRequire(import.meta.url)
setOcWasmUrl(require.resolve('replicad-opencascadejs/wasm'))

async function measure(step: string) {
  const { importSTEP } = await import('replicad')
  const shape = await importSTEP(new Blob([step], { type: 'model/step' }))
  const [min, max] = shape.boundingBox.bounds
  return {
    size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] as [number, number, number],
    volume: measureVolume(shape as never),
  }
}

/** A synthetic T-half matching `teeProfiles`, optionally with a rectangular through-notch. */
async function makeTee(sign: number, length: number, notch = false): Promise<Uint8Array> {
  const { draw } = await import('replicad')
  const section = getUb('200UB29.8')
  if (!section) throw new Error('missing section')
  const { top } = teeProfiles(section, 3)
  const profile = sign > 0 ? top : mirrorY(top)
  let solid = penFromProfile(draw(profile.start), profile)
    .close()
    .sketchOnPlane('XY')
    .extrude(length)
  if (notch) {
    const hd = section.d / 2
    const tf = section.tf
    const hole = draw([-5, sign * (hd - tf - 2)])
      .lineTo([5, sign * (hd - tf - 2)])
      .lineTo([5, sign * (hd + 2)])
      .lineTo([-5, sign * (hd + 2)])
      .close()
      .sketchOnPlane('XY')
      .extrude(10)
      .translate(0, 0, length / 2 - 5)
    solid = (solid as unknown as { cut: (o: unknown) => typeof solid }).cut(hole)
  }
  const blob = (solid as unknown as { blobSTEP: () => Blob }).blobSTEP()
  return new Uint8Array(await blob.arrayBuffer())
}

describe('whole-beam manufactured STEP', () => {
  it('keeps the beam whole and stock-length with a local split', async () => {
    const section = getUb('200UB29.8')
    expect(section).toBeDefined()
    if (!section) return
    const step = await buildCutBeamStep({
      section,
      name: 'local',
      stockLength: 12000,
      left: [
        { mark: 'm1', length: 3000 },
        { mark: 'm2', length: 2000 },
      ],
      right: [{ mark: 'm3', length: 4000 }],
      kerf: 3,
    })
    const { size } = await measure(step)
    expect(size[0]).toBeCloseTo(section.b, 0)
    expect(size[1]).toBeCloseTo(section.d, 0)
    expect(size[2]).toBeCloseTo(12000, 0)
    // Unlike a laid-out compound, the scrap beyond the last part keeps most of the beam joined:
    // only the leading piece is released, so far fewer bodies than pieces.
    const bodies = (step.match(/MANIFOLD_SOLID_BREP/g) ?? []).length
    expect(bodies).toBeGreaterThan(0)
    expect(bodies).toBeLessThan(3)
  }, 180000)

  it('severs the pieces when the split is full', async () => {
    const section = getUb('200UB29.8')
    if (!section) return
    const step = await buildCutBeamStep({
      section,
      name: 'full',
      stockLength: 12000,
      left: [
        { mark: 'm1', length: 3000 },
        { mark: 'm2', length: 2000 },
      ],
      right: [{ mark: 'm3', length: 4000 }],
      kerf: 3,
      split: 'full',
    })
    expect((step.match(/MANIFOLD_SOLID_BREP/g) ?? []).length).toBeGreaterThan(1)
  }, 180000)

  it('carries real part holes into the beam (lighter than clean)', async () => {
    const section = getUb('200UB29.8')
    if (!section) return
    const clean = await buildCutBeamStep({
      section,
      name: 'clean',
      stockLength: 6000,
      left: [{ mark: 'm1', length: 6000 }],
      right: [],
      kerf: 3,
    })
    const holed: CutBeamPiece = { mark: 'm1', length: 6000, bytes: await makeTee(1, 6000, true) }
    const withHole = await buildCutBeamStep({
      section,
      name: 'hole',
      stockLength: 6000,
      left: [holed],
      right: [],
      kerf: 3,
    })
    const cleanVol = (await measure(clean)).volume
    const holedVol = (await measure(withHole)).volume
    expect(holedVol).toBeLessThan(cleanVol - 1000) // notch removes ~20x12x10 ≈ 2400 mm³
  }, 180000)
})
