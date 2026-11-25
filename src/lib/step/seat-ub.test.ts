import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { ubSection } from '@test/fixtures'
import { describe, expect, it } from 'vitest'
import { parseDstv } from '@/lib/parsers/dstv'
import { outlinePoints } from '@/lib/sections/outline'
import { partSectionForCode } from '@/lib/sections/stock'
import { meshStepFile } from './mesh'
import { setOcWasmUrl } from './occInit'
import { seatedStepProfile, transformVertices } from './seat'

const require = createRequire(import.meta.url)
setOcWasmUrl(require.resolve('replicad-opencascadejs/wasm'))

/** Seated extents along the member (`x`) and the two section axes (`y`, `z`). */
function seatedExtents(vertices: number[]): [number, number, number] {
  const min = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY]
  const max = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY]
  for (let i = 0; i + 2 < vertices.length; i += 3)
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis] as number, vertices[i + axis] as number)
      max[axis] = Math.max(max[axis] as number, vertices[i + axis] as number)
    }
  return [
    (max[0] as number) - (min[0] as number),
    (max[1] as number) - (min[1] as number),
    (max[2] as number) - (min[2] as number),
  ]
}

describe('I-section stock seat', () => {
  it('seats the real UB250*31 STEP on its stock faces, not its vertex cloud', async () => {
    const header = parseDstv(readFileSync(ubSection('M_12.nc1'), 'utf8')).header
    const section = partSectionForCode(header.profile, header.dimensions)
    expect(section, 'catalogue section').toBeTruthy()
    if (!section) return
    const mesh = await meshStepFile('M_12', new Uint8Array(readFileSync(ubSection('M_12.stp'))))
    const faces = mesh.bodies.flatMap((body) => body.brep ?? [])
    expect(faces.length).toBeGreaterThan(10)

    const heuristic = seatedStepProfile(mesh.vertices, outlinePoints(section?.outline))
    const refined = seatedStepProfile(mesh.vertices, outlinePoints(section?.outline), faces)
    const before = seatedExtents(transformVertices(mesh.vertices, heuristic.primary))
    const after = seatedExtents(transformVertices(mesh.vertices, refined.primary))

    // The section's true extents: 252 deep × 146 wide, 5309 long (the raw STEP bbox).
    console.log(
      `[ub seat] heuristic ${before.map((v) => v.toFixed(1)).join(' × ')} → stock faces ${after.map((v) => v.toFixed(1)).join(' × ')}`,
    )
    expect(after[0]).toBeCloseTo(5309, 0)
    expect(after[1]).toBeCloseTo(146, 0)
    expect(after[2]).toBeCloseTo(252, 0)
    // The stock faces are the catalogue planes, so the seat is exact to the tessellation.
    expect(Math.abs(after[2] - 252)).toBeLessThan(0.5)
    expect(Math.abs(after[1] - 146)).toBeLessThan(0.5)
  }, 300000)
})
