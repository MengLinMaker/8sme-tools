import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { nw31Top } from '@test/fixtures'
import { Box3, Matrix4, Quaternion, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { parseDstv } from '@/lib/parsers/dstv'
import { faceNormal, type NcFaceFrame, resolveNcFaceFrame } from '@/lib/parsers/ncFaces'
import { type NcFace, parseNcGeometry } from '@/lib/parsers/ncGeometry'
import { projectNc } from '@/lib/parsers/ncProject'
import { detectOrientation } from '@/lib/sections/orient'
import { partSectionForCode } from '@/lib/sections/stock'
import type { SeatedBrepFace, Vec3 } from './cutEdges'
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
  return {
    projected,
    geo,
    minX,
    frame,
    section: section.points,
    xAxis: [xAxis.x, xAxis.y, xAxis.z] as Vec3,
    yAxis: [yAxis.x, yAxis.y, yAxis.z] as Vec3,
    length: header.length,
  }
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
  m154: { nc: nw31Top('NC files', 'm154.nc1'), stp: nw31Top('STP files', 'm154.stp') },
  m172: { nc: nw31Top('NC files', 'm172.nc1'), stp: nw31Top('STP files', 'm172.stp') },
  m173: { nc: nw31Top('NC files', 'm173.nc1'), stp: nw31Top('STP files', 'm173.stp') },
  m211: { nc: nw31Top('NC files', 'm211.nc1'), stp: nw31Top('STP files', 'm211.stp') },
}

/**
 * Every way an NC face contour could line up with the STEP projection: each face written in either
 * Y orientation. The STEP projection is geometry-derived, so it is the ideal NC projection; the
 * NC's own face letter + authored Y direction should be the winning (or tied-winning) candidate.
 * Symmetric sections (an RHS's `v`/`h` end cuts are mirror images) legitimately tie, which is why
 * the assertion accepts any candidate within `TIE_MM` of the identity rather than a single one.
 */
interface Candidate {
  face: NcFace
  flip: boolean
  /** Mean distance from the dense STEP points to the NC contour (mm). */
  stepToNc: number
  /** Mean distance from the NC vertices to the STEP contour (mm). */
  ncToStep: number
}

/** Mean distance from points to a set of open segments (the STEP contour can be several loops). */
function meanToSegments(points: FacePoint[], segments: FaceSegment[]): number {
  if (segments.length === 0 || points.length === 0) return Number.POSITIVE_INFINITY
  let sum = 0
  for (const p of points) {
    let min = Number.POSITIVE_INFINITY
    for (const s of segments) min = Math.min(min, pointSeg(p, s.a, s.b))
    sum += min
  }
  return sum / points.length
}

function rankCandidates(
  nc: FacePoint[],
  projected: Record<NcFace, FaceSegment[]>,
  minX: number,
): Candidate[] {
  const width = Math.max(...nc.map((p) => p.Y))
  const out: Candidate[] = []
  for (const face of ['v', 'o', 'u', 'h'] as NcFace[]) {
    const segs = projected[face]
    if (segs.length === 0) continue
    for (const flip of [false, true]) {
      const oriented: FaceSegment[] = segs.map((s) => {
        const a = { X: s.a.X - minX, Y: flip ? width - s.a.Y : s.a.Y }
        const b = { X: s.b.X - minX, Y: flip ? width - s.b.Y : s.b.Y }
        return { a, b, bevel: s.bevel, dir: s.dir }
      })
      out.push({
        face,
        flip,
        stepToNc: meanToNc(
          nc,
          oriented.flatMap((s) => [s.a, s.b]),
        ),
        ncToStep: meanToSegments(nc, oriented),
      })
    }
  }
  return out.sort((a, b) => a.stepToNc - b.stepToNc)
}

/** How much worse than the best candidate an identity match may be (symmetry ties). */
const TIE_MM = 0.5
/** Max mean residual (mm); the trace sits off the bevel reference by ~1–2 mm. */
const NC_STEP_MM = 3
const STEP_NC_MM = 3
/** Parts where the NC projection was checked against the STEP and found wrong in the field. */
const CROSS_CHECK = ['m24', 'm154', 'm172', 'm173', 'm211'] as const

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

describe('NC projection cross-checked against the STEP projection — RHS', () => {
  for (const mark of CROSS_CHECK) {
    const f = RHS[mark]
    it.skipIf(!existsSync(f.stp) || !existsSync(f.nc))(
      `${mark} lands on the same face and authored direction as the STEP cut lines`,
      async () => {
        const { projected, geo, minX } = await project(mark, f.nc, f.stp)
        for (const contour of geo.contours) {
          if (contour.kind !== 'outer') continue
          const nc: FacePoint[] = contour.points.map(([x, y]) => ({ X: x, Y: y }))
          const ranked = rankCandidates(nc, projected, minX)
          const identity = ranked.find((c) => c.face === contour.face && !c.flip)
          const suggestions = ranked
            .map((c) => `${c.face}${c.flip ? '-flip' : ''} ${c.stepToNc.toFixed(2)}mm`)
            .join(', ')
          expect(identity, `${mark} ${contour.face}: ${suggestions}`).toBeDefined()
          if (!identity) return
          const best = ranked[0]?.stepToNc ?? Number.POSITIVE_INFINITY
          // The NC letter + authored Y must be the (possibly tied) best solution, not a mirror or
          // a different face. On failure the message names the candidates that would work.
          expect(
            identity.stepToNc,
            `${mark} ${contour.face} best is not its own face: ${suggestions}`,
          ).toBeLessThanOrEqual(best + TIE_MM)
          expect(identity.stepToNc, `${mark} ${contour.face}: ${suggestions}`).toBeLessThan(
            STEP_NC_MM,
          )
          expect(identity.ncToStep, `${mark} ${contour.face}: ${suggestions}`).toBeLessThan(
            NC_STEP_MM,
          )
        }
      },
      120000,
    )
  }
})

describe('NC bevel arrows cross-checked against the STEP projection — RHS', () => {
  for (const mark of CROSS_CHECK) {
    const f = RHS[mark]
    it.skipIf(!existsSync(f.stp) || !existsSync(f.nc))(
      `${mark} leans each bevel the same way along the beam as the STEP cut`,
      async () => {
        const { projected, geo, minX, frame, section, xAxis, yAxis, length } = await project(
          mark,
          f.nc,
          f.stp,
        )
        const toScene = (along: number, cross: [number, number]): Vec3 => {
          const x = along + minX
          return [
            x + cross[0] * xAxis[0] + cross[1] * yAxis[0],
            cross[0] * xAxis[1] + cross[1] * yAxis[1],
            cross[0] * xAxis[2] + cross[1] * yAxis[2],
          ]
        }
        const normal = (face: NcFace): Vec3 => {
          const n = faceNormal(frame, face, section)
          const base = n.axis === 0 ? xAxis : yAxis
          return [base[0] * n.sign, base[1] * n.sign, base[2] * n.sign]
        }
        for (const face of ['v', 'o', 'u', 'h'] as NcFace[]) {
          const stepSegs = projected[face].filter((s) => s.bevel > 0)
          if (stepSegs.length === 0) continue
          // STEP truth: the along-beam sign of the bevel sweep at each end of the member.
          const stepSign = (end: 'start' | 'end'): number => {
            const segs = stepSegs.filter((s) => ((s.a.X + s.b.X) / 2 < 0 ? 'start' : 'end') === end)
            if (segs.length === 0) return 0
            const sum = segs.reduce((total, s) => total + (s.dir?.[0] ?? 0), 0)
            return Math.sign(sum)
          }
          // Project only this face so every arrow belongs to it.
          const ncFace = {
            ...geo,
            contours: geo.contours.filter((c) => c.kind === 'outer' && c.face === face),
          }
          const sets = projectNc(ncFace, { frame, section, toScene, normal })
          for (const group of sets.bevelArrows) {
            // Each arrow is three pushed segments (18 floats); the first is the stem.
            for (let i = 0; i + 5 < group.points.length; i += 18) {
              const from = group.points[i] as number
              const dx = (group.points[i + 3] as number) - from
              // A lengthwise bevel sweeps across the face, not along the beam — no axis sign.
              if (Math.abs(dx) < 0.1) continue
              const along = from - minX
              const truth = stepSign(along < length / 2 ? 'start' : 'end')
              if (truth === 0) continue
              expect(
                Math.sign(dx),
                `${mark} ${face} ${along < length / 2 ? 'start' : 'end'} bevel leans the wrong way`,
              ).toBe(truth)
            }
          }
        }
      },
      120000,
    )
  }
})
