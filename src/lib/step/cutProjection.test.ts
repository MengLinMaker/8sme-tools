import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { nw31Top } from '@test/fixtures'
import { Box3, Matrix4, Quaternion, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { parseDstv } from '@/lib/parsers/dstv'
import { type NcFaceFrame, resolveNcFaceFrame } from '@/lib/parsers/ncFaces'
import { type NcFace, parseNcGeometry } from '@/lib/parsers/ncGeometry'
import { detectOrientation } from '@/lib/sections/orient'
import { partSectionForCode } from '@/lib/sections/stock'
import type { SeatedBrepFace } from './cutEdges'
import { type FacePoint, type FaceSegment, projectCutEdgesToFaces } from './cutProjection'
import { meshStepFile } from './mesh'
import { setOcWasmUrl } from './occInit'

const require = createRequire(import.meta.url)
setOcWasmUrl(require.resolve('replicad-opencascadejs/wasm'))
const SEAT_ANGLES = [0, -Math.PI / 2, Math.PI, Math.PI / 2]
const unit = (axis: number, sign: number): Vector3 => {
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
function pointSeg(p: FacePoint, a: FacePoint, b: FacePoint): number {
  const dx = b.X - a.X
  const dy = b.Y - a.Y
  const l2 = dx * dx + dy * dy
  let t = l2 > 0 ? ((p.X - a.X) * dx + (p.Y - a.Y) * dy) / l2 : 0
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(p.X - (a.X + t * dx), p.Y - (a.Y + t * dy))
}
/** Mean distance from a set of projected points to an NC contour (mm). */
function meanToNc(nc: FacePoint[], pts: FacePoint[]): number {
  if (nc.length < 2 || pts.length === 0) return Number.POSITIVE_INFINITY
  let sum = 0
  for (const p of pts) {
    let m = Number.POSITIVE_INFINITY
    for (let i = 0; i < nc.length; i++)
      m = Math.min(m, pointSeg(p, nc[i] as FacePoint, nc[(i + 1) % nc.length] as FacePoint))
    sum += m
  }
  return sum / pts.length
}

async function project(mark: string, ncPath: string, stpPath: string) {
  const header = parseDstv(readFileSync(ncPath, 'utf8')).header
  const geo = parseNcGeometry(readFileSync(ncPath, 'utf8'))
  const section = partSectionForCode(header.profile, header.dimensions)
  if (!section) throw new Error('no section')
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

  const seatedFaces: SeatedBrepFace[] = meshed.bodies
    .flatMap((b) => b.brep ?? [])
    .map((face) => {
      const n = new Vector3(...face.normal).applyQuaternion(rotation)
      const c = new Vector3(...face.center).applyMatrix4(placement)
      return {
        normal: [n.x, n.y, n.z],
        center: [c.x, c.y, c.z],
        planar: face.planar,
        samples: transform(face.samples, placement),
        wires: face.wires.map((w) => ({
          enclosed: w.enclosed,
          edges: w.edges.map((e) => ({
            points: transform(e.points, placement),
            neighbours: e.neighbours,
          })),
        })),
      }
    })
  const frame: NcFaceFrame = resolveNcFaceFrame(section.points, geo, header.profile)
  const projected = projectCutEdgesToFaces(
    seatedFaces,
    section.points,
    frame,
    [xAxis.x, xAxis.y, xAxis.z],
    [yAxis.x, yAxis.y, yAxis.z],
    [1, 0, 0],
    { radius: header.dimensions[4] ?? 0 },
  )
  // NC X runs from the piece's start (0); the seated model is centred, so shift to that origin.
  const seatedAll = transform(raw, placement)
  let minX = Number.POSITIVE_INFINITY
  for (let i = 0; i + 2 < seatedAll.length; i += 3) minX = Math.min(minX, seatedAll[i] as number)
  return { projected, geo, minX }
}

/** Best mean Δ (mm) for an NC face against any projected face (X shifted to the NC origin, either Y). */
function bestMatch(
  nc: FacePoint[],
  projected: Record<NcFace, FaceSegment[]>,
  minX: number,
): number {
  const width = Math.max(...nc.map((p) => p.Y))
  let best = Number.POSITIVE_INFINITY
  for (const f of ['v', 'o', 'u', 'h'] as NcFace[]) {
    const segs = projected[f]
    if (segs.length === 0) continue
    const pts = segs.flatMap((s) => [s.a, s.b]).map((p) => ({ X: p.X - minX, Y: p.Y }))
    const flipped = pts.map((p) => ({ X: p.X, Y: width - p.Y }))
    best = Math.min(best, meanToNc(nc, pts), meanToNc(nc, flipped))
  }
  return best
}

const RHS = {
  m117: { nc: nw31Top('NC files', 'm117.nc1'), stp: nw31Top('STP files', 'm117.stp') },
  m150: { nc: nw31Top('NC files', 'm150.nc1'), stp: nw31Top('STP files', 'm150.stp') },
  m24: { nc: nw31Top('NC files', 'm24.nc1'), stp: nw31Top('STP files', 'm24.stp') },
}

describe('projectCutEdgesToFaces — RHS', () => {
  for (const [mark, f] of Object.entries(RHS)) {
    it.skipIf(!existsSync(f.stp) || !existsSync(f.nc))(
      `${mark} projects cut edges onto the NC face contours`,
      async () => {
        const { projected, geo, minX } = await project(mark, f.nc, f.stp)
        for (const contour of geo.contours) {
          if (contour.kind !== 'outer') continue
          const nc: FacePoint[] = contour.points.map(([x, y]) => ({ X: x, Y: y }))
          const best = bestMatch(nc, projected, minX)
          // The trace+corner projection lands within a few mm of the NC (residual is the bevel
          // reference); it must not be wildly off.
          expect(best).toBeLessThan(3)
        }
      },
      120000,
    )
  }
})
