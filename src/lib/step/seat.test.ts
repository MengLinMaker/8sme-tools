import { createRequire } from 'node:module'
import { draw } from 'replicad'
import { Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { partSectionForCode } from '@/lib/sections/stock'
import { meshStepFile } from './mesh'
import { ensureOc, setOcWasmUrl } from './occInit'
import { seatedPair, transformVertices } from './seat'

const require = createRequire(import.meta.url)
setOcWasmUrl(require.resolve('replicad-opencascadejs/wasm'))

function pointInPolygon(x: number, y: number, polygon: [number, number][]): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]
    const [xj, yj] = polygon[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

function segmentDistance(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax
  const dy = by - ay
  const lengthSq = dx * dx + dy * dy
  let t = lengthSq > 0 ? ((px - ax) * dx + (py - ay) * dy) / lengthSq : 0
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

function nearPolygon(x: number, y: number, polygon: [number, number][], tol = 2): boolean {
  if (pointInPolygon(x, y, polygon)) return true
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    if (segmentDistance(x, y, polygon[j][0], polygon[j][1], polygon[i][0], polygon[i][1]) <= tol) {
      return true
    }
  }
  return false
}

/** Builds a prism by extruding a stocked section's outline to `length` mm, optionally rotated. */
async function extrudeSection(
  code: string,
  length: number,
  rotation: [number, number, number] = [0, 0, 0],
): Promise<Uint8Array> {
  const section = partSectionForCode(code, [])
  if (!section) throw new Error(`no outline for ${code}`)
  let pen = draw(section.points[0] as [number, number])
  for (const point of section.points.slice(1)) pen = pen.lineTo(point)
  type Rotatable = {
    rotate: (a: number, p: number[], d: number[]) => Rotatable
    blobSTEP: () => Blob
  }
  let solid = pen.close().sketchOnPlane('XY').extrude(length) as unknown as Rotatable
  if (rotation[0]) solid = solid.rotate(rotation[0], [0, 0, 0], [1, 0, 0])
  if (rotation[1]) solid = solid.rotate(rotation[1], [0, 0, 0], [0, 1, 0])
  if (rotation[2]) solid = solid.rotate(rotation[2], [0, 0, 0], [0, 0, 1])
  return new Uint8Array(await solid.blobSTEP().arrayBuffer())
}

/** Fraction of the seated model's vertices that land inside the ghost profile. */
function seatedFit(vertices: number[], profile: [number, number][]): { fit: number } {
  const pair = seatedPair(vertices, null, profile)
  const seated = transformVertices(vertices, pair.primary)
  const point = new Vector3()
  let inside = 0
  let total = 0
  const stride = Math.max(3, Math.floor(seated.length / 3 / 2000) * 3)
  for (let i = 0; i + 2 < seated.length; i += stride) {
    point.set(seated[i] as number, seated[i + 1] as number, seated[i + 2] as number)
    const a = point.dot(pair.xAxis)
    const b = point.dot(pair.yAxis)
    total++
    if (nearPolygon(a, b, profile)) inside++
  }
  return { fit: total > 0 ? inside / total : 0 }
}

/**
 * The stock ghost must land on the part. A short part's member axis is not its longest bbox extent
 * (a 20 mm-long EA50*50*3 has 50 mm legs), so seating must not pick the length by longest extent.
 */
describe('seatedPair', () => {
  it('aligns the ghost for a short part whose member axis is not the longest extent', async () => {
    await ensureOc()
    const profile = partSectionForCode('EA50*50*3', [])?.points
    expect(profile).toBeDefined()
    if (!profile) return
    for (const length of [2000, 60, 20]) {
      const bytes = await extrudeSection('EA50*50*3', length)
      const meshed = await meshStepFile(`a-${length}`, bytes)
      const { fit } = seatedFit(meshed.vertices, profile)
      expect(fit, `EA50*50*3 @ ${length} mm — ghost not aligned`).toBeGreaterThan(0.98)
    }
  }, 600000)

  /**
   * A rotated STEP export puts the member on no world axis, so seating must find it from the part's
   * principal axes rather than the world X/Y/Z extent.
   */
  it('aligns the ghost for a part rotated off the world axes', async () => {
    await ensureOc()
    const profile = partSectionForCode('EA200*200*20', [])?.points
    expect(profile).toBeDefined()
    if (!profile) return
    const bytes = await extrudeSection('EA200*200*20', 2000, [30, 20, 45])
    const meshed = await meshStepFile('rot', bytes)
    const { fit } = seatedFit(meshed.vertices, profile)
    expect(fit, 'rotated EA200*200*20 — ghost not aligned').toBeGreaterThan(0.98)
  }, 600000)
})
