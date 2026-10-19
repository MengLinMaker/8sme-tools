import { createRequire } from 'node:module'
import { type AnyShape, draw, importSTEP } from 'replicad'
import { Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { partSectionForCode } from '@/lib/sections/stock'
import { applyRigid, writeStep } from './occ'
import { ensureOc, setOcWasmUrl } from './occInit'
import { rigidFromMatrix, seatedPair, seatedStepProfile, transformVertices } from './seat'

const require = createRequire(import.meta.url)
setOcWasmUrl(require.resolve('replicad-opencascadejs/wasm'))

interface TransformOps {
  rotate: (a: number, p: number[], d: number[]) => TransformOps
  mesh: () => { vertices: number[] }
}

/** Extrudes a stocked section to `length` mm and rotates it off the world axes. */
async function extrudedSection(
  code: string,
  length: number,
  rotation: [number, number, number],
): Promise<AnyShape> {
  const section = partSectionForCode(code, [])
  if (!section) throw new Error(`no outline for ${code}`)
  let pen = draw(section.points[0] as [number, number])
  for (const point of section.points.slice(1)) pen = pen.lineTo(point)
  let solid = pen.close().sketchOnPlane('XY').extrude(length) as unknown as TransformOps
  if (rotation[0]) solid = solid.rotate(rotation[0], [0, 0, 0], [1, 0, 0])
  if (rotation[1]) solid = solid.rotate(rotation[1], [0, 0, 0], [0, 1, 0])
  if (rotation[2]) solid = solid.rotate(rotation[2], [0, 0, 0], [0, 0, 1])
  return solid as unknown as AnyShape
}

/**
 * The export seat must put a real part STEP into the canonical manufacturing orientation: member
 * along +X, cross-section rolled so section +y is world +Y. Verifying with a part rotated off every
 * world axis proves the seat (not a lucky bbox) did it.
 */
describe('seat STEP for export', () => {
  it('seats a rotated real part into the canonical frame', async () => {
    await ensureOc()
    const profile = partSectionForCode('EA200*200*20', [])?.points
    expect(profile).toBeDefined()
    if (!profile) return

    const shape = await extrudedSection('EA200*200*20', 2000, [30, 20, 45])
    const rigid = rigidFromMatrix(seatedStepProfile(shape.mesh().vertices, profile).primary)
    const seated = applyRigid(shape, rigid)
    const step = await writeStep(seated, 'seat-export-test.stp')

    const back = (await importSTEP(
      new Blob([step], { type: 'model/step' }),
    )) as unknown as TransformOps
    const vertices = back.mesh().vertices

    // The member (longest axis) is now X, and the section lands on the canonical profile.
    let minX = Number.POSITIVE_INFINITY
    let minY = Number.POSITIVE_INFINITY
    let minZ = Number.POSITIVE_INFINITY
    let maxX = Number.NEGATIVE_INFINITY
    let maxY = Number.NEGATIVE_INFINITY
    let maxZ = Number.NEGATIVE_INFINITY
    for (let i = 0; i + 2 < vertices.length; i += 3) {
      minX = Math.min(minX, vertices[i] as number)
      maxX = Math.max(maxX, vertices[i] as number)
      minY = Math.min(minY, vertices[i + 1] as number)
      maxY = Math.max(maxY, vertices[i + 1] as number)
      minZ = Math.min(minZ, vertices[i + 2] as number)
      maxZ = Math.max(maxZ, vertices[i + 2] as number)
    }
    const size = [maxX - minX, maxY - minY, maxZ - minZ]
    expect(size[0]).toBeGreaterThan(size[1] as number)
    expect(size[0]).toBeGreaterThan(size[2] as number)

    // Re-applying the seated frame must be (near) identity: the model is already canonical.
    const pair = seatedPair(vertices, null, profile)
    const reseated = transformVertices(vertices, pair.primary)
    let maxShift = 0
    for (let i = 0; i + 2 < vertices.length; i += 3) {
      const a = new Vector3(vertices[i], vertices[i + 1], vertices[i + 2])
      const b = new Vector3(reseated[i], reseated[i + 1], reseated[i + 2])
      maxShift = Math.max(maxShift, a.distanceTo(b))
    }
    expect(maxShift).toBeLessThan(5)
  }, 600000)
})
