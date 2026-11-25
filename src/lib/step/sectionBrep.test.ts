import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { circleThrough, type Pt } from '@/lib/sections/sectionPath'
import { partSectionForCode } from '@/lib/sections/stock'
import { setOcWasmUrl } from './occInit'
import { sectionSketch } from './sectionBrep'

const require = createRequire(import.meta.url)
setOcWasmUrl(require.resolve('replicad-opencascadejs/wasm'))

interface Vec3 {
  x: number
  y: number
  z: number
}
interface EdgeLike {
  geomType: string
  startPoint: Vec3
  endPoint: Vec3
  pointAt(t?: number): Vec3
}
interface FaceLike {
  geomType: string
  outerWire(): { edges: EdgeLike[] }
}
interface ShapeLike {
  faces: FaceLike[]
}

const { ensureOc } = await import('./occInit')

/** Extrude a section contour into a 100 mm prism, through a STEP round trip like the real export. */
async function prism(points: Pt[], length = 100): Promise<ShapeLike> {
  await ensureOc()
  const { importSTEP } = await import('replicad')
  const sketch = await sectionSketch(points)
  expect(sketch).not.toBeNull()
  const step = await sketch?.sketchOnPlane('XY').extrude(length).blobSTEP()
  const bytes = new Uint8Array(await (step as Blob).arrayBuffer())
  return (await importSTEP(new Blob([bytes], { type: 'model/step' }))) as unknown as ShapeLike
}

function faces(shape: ShapeLike): { planes: number; cylinders: number } {
  const count = (type: string) => shape.faces.filter((f) => f.geomType === type).length
  return { planes: count('PLANE'), cylinders: count('CYLINDRE') }
}

/** Radius of every non-straight edge on the shape, from three points on it (the section is in XY). */
function arcRadii(shape: ShapeLike): number[] {
  const radii: number[] = []
  for (const face of shape.faces) {
    for (const edge of face.outerWire().edges) {
      if (edge.geomType === 'LINE') continue
      const points = [edge.startPoint, edge.pointAt(0.5), edge.endPoint].map((p): Pt => [p.x, p.y])
      const fit = circleThrough(points[0] as Pt, points[1] as Pt, points[2] as Pt)
      if (fit) radii.push(fit.radius)
    }
  }
  return radii
}

const round = (values: number[]): number[] => values.map((v) => Math.round(v * 1000) / 1000).sort()

/** Distinct radii (each arc edges appears on several faces of the prism). */
const uniqueRadii = (values: number[]): number[] => [...new Set(values)]

describe('sectionSketch — rounded stock as real brep', () => {
  it('extrudes an RHS with eight cylindrical corner faces (outer and inner)', async () => {
    const section = partSectionForCode('RHS150*100*9.0', [])
    expect(section?.holes?.length).toBe(1)

    // Outer contour: four 22.5 mm corners, four flats.
    const outer = await prism(section?.points ?? [])
    expect(faces(outer)).toEqual({ planes: 6, cylinders: 4 })
    expect(uniqueRadii(round(arcRadii(outer)))).toEqual([22.5])

    // The void is the part that used to be a chorded 28-gon: four 13.5 mm corners now.
    const inner = await prism(section?.holes?.[0] ?? [])
    expect(faces(inner)).toEqual({ planes: 6, cylinders: 4 })
    expect(uniqueRadii(round(arcRadii(inner)))).toEqual([13.5])
  }, 300_000)

  it('extrudes a CHS as a cylinder, not a many-sided prism', async () => {
    const section = partSectionForCode('CHS508*9.5', [])
    const shape = await prism(section?.points ?? [], 50)
    // The wall is cylindrical (the STEP may carry it as one face or two halves at the seam) and
    // only the two end caps are planar — no facets along the circumference.
    expect(faces(shape).planes).toBe(2)
    expect(faces(shape).cylinders).toBeGreaterThanOrEqual(1)
    expect(faces(shape).cylinders).toBeLessThanOrEqual(2)
    // Round contour: every arc is the section's OD.
    expect(uniqueRadii(round(arcRadii(shape)))[0]).toBeCloseTo(254, 3)
  }, 300_000)

  it('keeps a UB root fillet cylindrical', async () => {
    const section = partSectionForCode('250UB31.4', [])
    const shape = await prism(section?.points ?? [])
    expect(faces(shape).cylinders).toBe(4)
  }, 300_000)
})
