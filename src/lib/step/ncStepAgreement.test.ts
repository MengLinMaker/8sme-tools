import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { nw30Bottom, nw31Bottom, nw31Top } from '@test/fixtures'
import { Box3, Matrix4, Quaternion, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { parseDstv } from '@/lib/parsers/dstv'
import { faceNormal, type NcFaceFrame, resolveNcFaceFrame } from '@/lib/parsers/ncFaces'
import { type NcFace, parseNcGeometry } from '@/lib/parsers/ncGeometry'
import { projectNc } from '@/lib/parsers/ncProject'
import { detectOrientation } from '@/lib/sections/orient'
import { partSectionForCode } from '@/lib/sections/stock'
import { distanceToOutline, type Vec3 } from './cutEdges'
import { meshStepFile } from './mesh'
import { setOcWasmUrl } from './occInit'

const require = createRequire(import.meta.url)
setOcWasmUrl(require.resolve('replicad-opencascadejs/wasm'))

/**
 * Fixture-backed agreement check between a part's **NC toolpath** and its **STEP cut geometry**:
 * the NC contours are placed onto the 3D model through the shared face frame (`projectNc`), and the
 * distance from each NC cut segment to the nearest STEP cut edge is measured. Where the two agree
 * (~0 mm) any STEP→NC projection is trustworthy; a large gap means the NC genuinely differs from the
 * STEP geometry (not a projection bug). Angles and simple PFCs agree; a weird-curve-side-cut PFC and
 * the tubes do not. Skipped when fixtures are absent.
 */

const SEAT_ANGLES = [0, -Math.PI / 2, Math.PI, Math.PI / 2]
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

function unit(axis: number, sign: number): Vector3 {
  const v = new Vector3()
  v.setComponent(axis, sign)
  return v
}

function transform(vertices: number[], matrix: Matrix4): number[] {
  const out = new Array<number>(vertices.length)
  const p = new Vector3()
  for (let i = 0; i + 2 < vertices.length; i += 3) {
    p.set(vertices[i], vertices[i + 1], vertices[i + 2]).applyMatrix4(matrix)
    out[i] = p.x
    out[i + 1] = p.y
    out[i + 2] = p.z
  }
  return out
}

/** Distance from a point to a segment in 3D. */
function pointSeg(p: Vec3, a: Vec3, b: Vec3): number {
  const ab: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
  const l2 = dot(ab, ab)
  let t = l2 > 0 ? dot([p[0] - a[0], p[1] - a[1], p[2] - a[2]], ab) / l2 : 0
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(p[0] - (a[0] + t * ab[0]), p[1] - (a[1] + t * ab[1]), p[2] - (a[2] + t * ab[2]))
}

/** Mean/max distance (mm) from the NC cut lines, seated on the model, to the STEP cut edges. */
async function ncToStepGap(
  mark: string,
  ncPath: string,
  stpPath: string,
): Promise<{ mean: number; max: number }> {
  const ncText = readFileSync(ncPath, 'utf8')
  const header = parseDstv(ncText).header
  const geo = parseNcGeometry(ncText)
  const section = partSectionForCode(header.profile, header.dimensions)
  if (!section) throw new Error(`no section for ${header.profile}`)

  const meshed = await meshStepFile(mark, new Uint8Array(readFileSync(stpPath)))
  const raw = meshed.vertices
  const box = new Box3()
  const probe = new Vector3()
  for (let i = 0; i + 2 < raw.length; i += 3)
    box.expandByPoint(probe.set(raw[i] as number, raw[i + 1] as number, raw[i + 2] as number))
  const size = box.getSize(new Vector3())
  const centre = box.getCenter(new Vector3())
  const longAxis = [size.x, size.y, size.z].indexOf(Math.max(size.x, size.y, size.z))
  const toX = new Quaternion()
  if (longAxis !== 0) toX.setFromUnitVectors(unit(longAxis, 1), unit(0, 1))
  const centred = raw.map((v, i) =>
    i % 3 === 0 ? v - centre.x : i % 3 === 1 ? v - centre.y : v - centre.z,
  )
  const seated = transform(centred, new Matrix4().makeRotationFromQuaternion(toX))
  const roll = new Quaternion().setFromAxisAngle(
    unit(0, 1),
    SEAT_ANGLES[detectOrientation(section.points, seated, 1, 2, [0, 0, 0])],
  )
  const seat = new Quaternion().multiplyQuaternions(roll, toX)
  const world = transform(raw, new Matrix4().makeRotationFromQuaternion(seat))
  const orientation = detectOrientation(section.points, world, 1, 2, [0, 0, 0])
  const eA = unit(1, 1)
  const eB = unit(2, 1)
  const table: [Vector3, Vector3][] = [
    [eA, eB],
    [eB, eA.clone().negate()],
    [eA.clone().negate(), eB.clone().negate()],
    [eB.clone().negate(), eA],
  ]
  const [fx0, fy0] = table[orientation] as [Vector3, Vector3]
  const rollAngle = -Math.atan2(fy0.z, fy0.y)
  const about = new Vector3(1, 0, 0)
  const xAxis = fx0.clone().applyAxisAngle(about, rollAngle)
  const yAxis = fy0.clone().applyAxisAngle(about, rollAngle)
  const rotation = new Quaternion().multiplyQuaternions(
    new Quaternion().setFromAxisAngle(about, rollAngle),
    seat,
  )
  const box2 = new Box3()
  const probe2 = new Vector3()
  for (let i = 0; i + 2 < raw.length; i += 3)
    box2.expandByPoint(probe2.set(raw[i] as number, raw[i + 1] as number, raw[i + 2] as number))
  const placement = new Matrix4().compose(
    box2.getCenter(new Vector3()).applyQuaternion(seat).negate(),
    rotation,
    new Vector3(1, 1, 1),
  )
  const xa: Vec3 = [xAxis.x, xAxis.y, xAxis.z]
  const ya: Vec3 = [yAxis.x, yAxis.y, yAxis.z]
  const member: Vec3 = [1, 0, 0]

  // NC contours → 3D through the shared face frame.
  const frame: NcFaceFrame = resolveNcFaceFrame(section.points, geo, header.profile)
  const length = size.getComponent(longAxis)
  const toScene = (along: number, cross: [number, number], _face: NcFace): Vec3 => {
    const x = along - length / 2
    return [
      x + cross[0] * xAxis.x + cross[1] * yAxis.x,
      cross[0] * xAxis.y + cross[1] * yAxis.y,
      cross[0] * xAxis.z + cross[1] * yAxis.z,
    ]
  }
  const normal = (face: NcFace): Vec3 => {
    const n = faceNormal(frame, face, section.points)
    const base = n.axis === 0 ? xAxis : yAxis
    return [base.x * n.sign, base.y * n.sign, base.z * n.sign]
  }
  const projected = projectNc(geo, { frame, section: section.points, toScene, normal })
  const ncSegs: [Vec3, Vec3][] = []
  for (const cut of projected.cuts) {
    const pts = cut.points
    for (let i = 0; i + 5 < pts.length; i += 6)
      ncSegs.push([
        [pts[i] as number, pts[i + 1] as number, pts[i + 2] as number],
        [pts[i + 3] as number, pts[i + 4] as number, pts[i + 5] as number],
      ])
  }

  // STEP cut edges: stock-face edges bordering a cut face.
  const isStockFace = (nrm: Vec3, samples: number[]): boolean => {
    if (Math.abs(dot(nrm, member)) > 0.3) return false
    if (samples.length === 0) return false
    let on = 0
    let total = 0
    for (let i = 0; i + 2 < samples.length; i += 3) {
      const cross: [number, number] = [
        dot([samples[i], samples[i + 1], samples[i + 2]] as Vec3, xa),
        dot([samples[i], samples[i + 1], samples[i + 2]] as Vec3, ya),
      ]
      total++
      if (distanceToOutline(section.points, cross) <= 2.5) on++
    }
    return total > 0 && on / total >= 0.7
  }
  const stepPts: Vec3[] = []
  for (const body of meshed.bodies) {
    const brep = body.brep ?? []
    const faces = brep.map((face) => {
      const n = new Vector3(...face.normal).applyQuaternion(rotation)
      const normalV: Vec3 = [n.x, n.y, n.z]
      return { normal: normalV, stock: isStockFace(normalV, transform(face.samples, placement)) }
    })
    brep.forEach((face, i) => {
      if (!faces[i]?.stock) return
      for (const wire of face.wires)
        for (const edge of wire.edges) {
          if (!edge.neighbours.some((n) => faces[n] && !faces[n]?.stock)) continue
          const pts = transform(edge.points, placement)
          for (let k = 0; k + 2 < pts.length; k += 3)
            stepPts.push([pts[k] as number, pts[k + 1] as number, pts[k + 2] as number])
        }
    })
  }

  let sum = 0
  let max = 0
  for (const [a, b] of ncSegs) {
    const mid: Vec3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]
    let m = Number.POSITIVE_INFINITY
    for (let i = 0; i + 1 < stepPts.length; i++)
      m = Math.min(m, pointSeg(mid, stepPts[i] as Vec3, stepPts[i + 1] as Vec3))
    sum += m
    max = Math.max(max, m)
  }
  return { mean: ncSegs.length ? sum / ncSegs.length : 0, max }
}

/**
 * Parts whose NC and STEP geometry agree — a projection must land on the STEP to ~0. `m40` is the
 * reference example: the NC and STEP cut lines agree everywhere except a ~1.5 mm divergence in the
 * curved section near the end (mean stays well under the bar; the max is that localised end).
 */
const AGREES = [
  ['a1', 'angle', nw31Top('NC files', 'a1.nc1'), nw31Top('STP files', 'a1.stp')],
  ['a2', 'angle', nw30Bottom('a2.nc1'), nw30Bottom('a2.stp')],
  ['m31', 'PFC', nw31Top('NC files', 'm31.nc1'), nw31Top('STP files', 'm31.stp')],
  ['m130', 'PFC', nw31Top('NC files', 'm130.nc1'), nw31Top('STP files', 'm130.stp')],
  ['m40', 'PFC', nw31Top('NC files', 'm40.nc1'), nw31Top('STP files', 'm40.stp')],
] as const
/**
 * Parts whose NC genuinely differs from the STEP geometry (recorded, not fixed). m40 (PFC) is the
 * reference example: its NC and STEP cut lines visibly diverge, and that divergence is the thing to
 * surface — not a projection bug to paper over.
 */
const DIVERGES = [
  ['m116', 'PFC', nw31Bottom('m116.nc1'), nw31Bottom('m116.stp')],
  ['m117', 'RHS', nw31Top('NC files', 'm117.nc1'), nw31Top('STP files', 'm117.stp')],
  ['m150', 'RHS', nw31Top('NC files', 'm150.nc1'), nw31Top('STP files', 'm150.stp')],
  ['m105', 'SHS', nw30Bottom('m105.nc1'), nw30Bottom('m105.stp')],
] as const

describe('NC vs STEP cut-edge agreement', () => {
  for (const [mark, family, nc, stp] of AGREES) {
    it.skipIf(!existsSync(stp) || !existsSync(nc))(
      `${mark} (${family}) NC lands on the STEP cut edges`,
      async () => {
        const { mean } = await ncToStepGap(mark, nc, stp)
        expect(mean).toBeLessThan(0.5)
      },
      120000,
    )
  }

  for (const [mark, family, nc, stp] of DIVERGES) {
    it.skipIf(!existsSync(stp) || !existsSync(nc))(
      `${mark} (${family}) NC diverges from STEP (known mismatch, projected cuts won't match)`,
      async () => {
        const { mean } = await ncToStepGap(mark, nc, stp)
        // Locks in the known divergence; if this ever drops under the bar the part now agrees.
        expect(mean).toBeGreaterThan(0.5)
      },
      120000,
    )
  }
})
