import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { nw31Top } from '@test/fixtures'
import { describe, expect, it } from 'vitest'
import type { Outline, Pt } from '@/lib/sections/outline'
import { partSectionForCode } from '@/lib/sections/stock'
import { setOcWasmUrl } from './occInit'
import { reconstructStepFromNc } from './reconstructFromNc'
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

/** Extrude a stock contour into a 100 mm prism, through a STEP round trip like the real export. */
async function prism(contour: Outline | undefined, length = 100): Promise<ShapeLike> {
  await ensureOc()
  expect(contour).toBeDefined()
  if (!contour) throw new Error('no contour')
  const { importSTEP } = await import('replicad')
  const sketch = await sectionSketch(contour)
  expect(sketch).not.toBeNull()
  const step = await sketch?.sketchOnPlane('XY').extrude(length).blobSTEP()
  const bytes = new Uint8Array(await (step as Blob).arrayBuffer())
  return (await importSTEP(new Blob([bytes], { type: 'model/step' }))) as unknown as ShapeLike
}

async function prismFromStep(step: string): Promise<ShapeLike> {
  await ensureOc()
  const { importSTEP } = await import('replicad')
  const bytes = new Uint8Array(new TextEncoder().encode(step))
  return (await importSTEP(new Blob([bytes], { type: 'model/step' }))) as unknown as ShapeLike
}

function faces(shape: ShapeLike): { planes: number; cylinders: number } {
  const count = (type: string) => shape.faces.filter((f) => f.geomType === type).length
  return { planes: count('PLANE'), cylinders: count('CYLINDRE') }
}

/** Circle through three points. */
function circleThrough(a: Pt, b: Pt, c: Pt): { radius: number } | null {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]))
  if (Math.abs(d) < 1e-9) return null
  const aa = a[0] ** 2 + a[1] ** 2
  const bb = b[0] ** 2 + b[1] ** 2
  const cc = c[0] ** 2 + c[1] ** 2
  const cx = (aa * (b[1] - c[1]) + bb * (c[1] - a[1]) + cc * (a[1] - b[1])) / d
  const cy = (aa * (c[0] - b[0]) + bb * (a[0] - c[0]) + cc * (b[0] - a[0])) / d
  return { radius: Math.hypot(b[0] - cx, b[1] - cy) }
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

/** Distinct radii (each arc edge appears on several faces of the prism). */
const uniqueRadii = (values: number[]): number[] => [...new Set(values)]

describe('sectionSketch — rounded stock as real brep', () => {
  it('extrudes an RHS with eight cylindrical corner faces (outer and inner)', async () => {
    const section = partSectionForCode('RHS150*100*9.0', [])
    expect(section?.voidOutlines?.length).toBe(1)

    // Outer contour: four 22.5 mm corners, four flats.
    const outer = await prism(section?.outline)
    expect(faces(outer)).toEqual({ planes: 6, cylinders: 4 })
    expect(uniqueRadii(round(arcRadii(outer)))).toEqual([22.5])

    // The void is the part that used to be chorded: four 13.5 mm corners now.
    const inner = await prism(section?.voidOutlines?.[0])
    expect(faces(inner)).toEqual({ planes: 6, cylinders: 4 })
    expect(uniqueRadii(round(arcRadii(inner)))).toEqual([13.5])
  }, 300_000)

  it('extrudes a CHS as a cylinder, not a many-sided prism', async () => {
    const section = partSectionForCode('CHS508*9.5', [])
    const shape = await prism(section?.outline, 50)
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
    const shape = await prism(section?.outline)
    expect(faces(shape).cylinders).toBe(4)
  }, 300_000)
})

/**
 * End-to-end: a manufactured RHS used to carry its **inner void as a chorded 28-gon** (4 outer
 * cylinders, ~38 planar faces). The void now comes from the same generated arcs, so the part
 * presents a cylindrical face per corner inside and out.
 */
const RHS_NC = nw31Top('NC files', 'm117.nc1')
describe.skipIf(!existsSync(RHS_NC))('manufactured RHS', () => {
  it('rebuilds from NC with cylindrical corners, inside and out', async () => {
    const step = await reconstructStepFromNc(readFileSync(RHS_NC, 'utf8'))
    expect(step).toBeTruthy()
    if (!step) return
    const shape = await prismFromStep(step)
    const { planes, cylinders } = faces(shape)
    // Eight stock corners (4 outer + 4 void) plus the NC hole walls.
    expect(cylinders).toBeGreaterThanOrEqual(8)
    // A chorded void alone would add ~24 planar faces.
    expect(planes).toBeLessThan(20)
  }, 900_000)
})
