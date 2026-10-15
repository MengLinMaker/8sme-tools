/**
 * Projects a seated STEP part's cut edges onto its **DSTV face planes** as 2-D contours
 * (`X` along the member, `Y` across the face) — the geometry an NC `AK` contour would carry.
 *
 * The key idea (vs. a plain rim projection): the **across** coordinate is the cut point's position
 * on the face, but the **along** coordinate is where the *cut plane* crosses the *nominal face
 * plane*, not the rim's own X. On a rounded corner the rim curves away from the face; tracing the
 * cut plane instead keeps the contour straight and lets it reach the theoretical sharp corner, which
 * is exactly what the NC (authored on the sharp-cornered section) expects.
 *
 * Faces are taken from the resolved DSTV frame (`ncFaces`), so it works for any family whose DSTV
 * faces are flats. A point on a rounded corner is emitted onto **both** adjacent faces (within the
 * corner radius), so each face's contour reaches its end. Pure (no three.js / OCC): the caller seats
 * the model and passes the already-transformed faces + frame.
 */

import {
  faceHalf,
  faceSpanAxis,
  type NcFaceFrame,
  ncAuthoredAcrossSign,
  resolveFaceSign,
} from '@/lib/parsers/ncFaces'
import type { NcFace } from '@/lib/parsers/ncGeometry'
import type { SeatedBrepFace, Vec3 } from './cutEdges'

/** One projected contour point: `X` along the member (mm), `Y` across the face (mm from the edge). */
export interface FacePoint {
  X: number
  Y: number
}

/** A projected cut segment on a face (`a`→`b`), in face coordinates. */
export interface FaceSegment {
  a: FacePoint
  b: FacePoint
}

export interface CutProjectionOptions {
  /** Outer corner radius (mm) — how far a corner point reaches onto the adjacent face. Default 0. */
  radius?: number
}

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

function scale(v: Vec3, s: number): Vec3 {
  return [v[0] * s, v[1] * s, v[2] * s]
}

/**
 * Projects every cut edge (a stock-face edge bordering a cut face) onto the DSTV faces it sits on,
 * returning one 2-D contour per face. A planar cut face gives the along-coordinate by intersecting
 * its plane with the face plane; a curved cut face (or one parallel to the member) falls back to the
 * rim's own X.
 */
export function projectCutEdgesToFaces(
  faces: SeatedBrepFace[],
  section: [number, number][],
  frame: NcFaceFrame,
  xAxis: Vec3,
  yAxis: Vec3,
  memberAxis: Vec3,
  options: CutProjectionOptions = {},
): Record<NcFace, FaceSegment[]> {
  const radius = options.radius ?? 0
  const stock = faces.map((face) => Math.abs(dot(face.normal, memberAxis)) <= 0.3)
  const crossAxis = (axis: 0 | 1): Vec3 => (axis === 0 ? xAxis : yAxis)

  // Each DSTV face's nominal plane: outward normal axis + side, plane offset, and span axis.
  const planes = (['v', 'o', 'u', 'h'] as NcFace[]).map((face) => {
    const spanAxis = faceSpanAxis(frame, face)
    const axis = (1 - spanAxis) as 0 | 1
    const sign = resolveFaceSign(frame, section, face)
    return {
      face,
      axis,
      sign,
      normal: scale(crossAxis(axis), sign),
      q: faceHalf(frame, axis),
      spanAxis,
      spanVec: crossAxis(spanAxis),
      halfSpan: faceHalf(frame, spanAxis),
      acrossSign: ncAuthoredAcrossSign(frame, face),
    }
  })

  const out: Record<NcFace, FaceSegment[]> = { v: [], o: [], u: [], h: [] }

  faces.forEach((face, i) => {
    if (!stock[i]) return
    for (const wire of face.wires) {
      for (const edge of wire.edges) {
        const cutIndex = edge.neighbours.find((n) => n !== i && !stock[n])
        if (cutIndex == null) continue
        const cut = faces[cutIndex]
        if (!cut) continue
        const planarCut = cut.planar
        const nCut = cut.normal
        const cCut = dot(nCut, cut.center)
        const nMember = dot(nCut, memberAxis)

        // Project this edge's points onto each face, then emit the consecutive pairs that land on
        // the same face as segments (so the caller can draw clean polylines).
        const count = edge.points.length / 3
        const onFace = new Map<NcFace, (FacePoint | null)[]>()
        for (const plane of planes) onFace.set(plane.face, new Array(count).fill(null))
        for (let s = 0; s < count; s++) {
          const k = s * 3
          const p: Vec3 = [
            edge.points[k] as number,
            edge.points[k + 1] as number,
            edge.points[k + 2] as number,
          ]
          const X = dot(p, memberAxis)
          for (const plane of planes) {
            const cN = dot(p, plane.normal) // signed distance along the outward normal
            const d = plane.q - cN // 0 on the face, >0 inside
            if (d > radius + 0.6 || d < -Math.max(radius, 1) - 0.6) continue
            const cSpan = dot(p, plane.spanVec)
            // Along: the cut plane's trace on this face plane (the rim X when not exploitable).
            const Xp =
              planarCut && Math.abs(nMember) >= 0.2
                ? (cCut -
                    dot(nCut, plane.spanVec) * cSpan -
                    dot(nCut, crossAxis(plane.axis)) * plane.sign * plane.q) /
                  nMember
                : X
            ;(onFace.get(plane.face) as (FacePoint | null)[])[s] = {
              X: Xp,
              Y: plane.halfSpan + plane.acrossSign * cSpan,
            }
          }
        }
        for (const plane of planes) {
          const arr = onFace.get(plane.face) as (FacePoint | null)[]
          for (let s = 0; s + 1 < count; s++) {
            const a = arr[s]
            const b = arr[s + 1]
            if (a && b) out[plane.face].push({ a, b })
          }
        }
      }
    }
  })

  return out
}
