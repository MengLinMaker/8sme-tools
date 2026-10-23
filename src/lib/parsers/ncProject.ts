/**
 * Projects DSTV NC toolpath geometry (outer/inner contours, holes, welding bevels) onto the
 * manufactured solid so the cut lines can be drawn on the part they produced.
 *
 * Face placement is not re-derived here: it comes from the shared cross-section face frame
 * (`ncFaces`), the same rule the NC→solid rebuild uses. So each contour lands on exactly the
 * face the laser cuts, and a cut that lines up with the edge of the stock (no material on that
 * side) is dropped instead of being drawn across the void.
 *
 * The geometry reader is frame-agnostic — points are `(x along the member, y across the face)`.
 * The caller supplies a `toScene` mapper that turns a section-frame point into 3D coordinates in
 * the model's own frame (stock-ghost seated frame for preflight, beam frame for nesting) and a
 * `normal` for orienting bevel spurs.
 */

import { profileFamily } from '@/lib/sections/canonical'
import {
  type Axis,
  faceHalf,
  faceNormal,
  facePlaneHalf,
  faceSpanAxis,
  materialReaches,
  type NcFaceFrame,
  ncAuthoredAcrossSign,
  placeNcFace,
} from './ncFaces'
import { type NcFace, type NcGeometry, type NcHole, type NcMark, slotOffset } from './ncGeometry'
import { selectWeldingPrep } from './weldingPrep'

export type Vec3 = [number, number, number]

/** One colour per distinct cut thickness (indexed by thickness order within a part). */
export const THICKNESS_COLORS = [
  0x3ddc84, 0x38bdf8, 0xf59e0b, 0xa78bfa, 0xf87171, 0x22d3ee, 0xfacc15,
] as const

/** Fixed colours for the non-cut profiles (etch / weld markings). */
export const ETCH_COLOR = 0xf5f5f5
export const MARKING_COLOR = 0xfb923c

export interface NcProjection {
  /** The section face frame the NC was matched against (see `resolveNcFaceFrame`). */
  frame: NcFaceFrame
  /** The section outline the frame came from, for material-reach checks. */
  section: [number, number][]
  /** Maps a section-frame point to scene coordinates (already offset clear of the surface). */
  toScene: (along: number, cross: [number, number], face: NcFace) => Vec3
  /** Outward unit normal of a face, in scene coordinates, for bevel spurs. */
  normal: (face: NcFace) => Vec3
}

/** Cut lines plus their welding-bevel indications, grouped by the wall thickness they cut. */
export interface NcLineSets {
  /** Plain cut lines and hole rings; one entry per distinct cut thickness (mm). */
  cuts: { thickness: number; points: number[] }[]
  /** Stemmed welding-bevel arrows (flat XYZ pair list), coloured like their cut thickness. */
  bevelArrows: { thickness: number; points: number[] }[]
  /**
   * Welding bevels shown as a translucent swept area (flat triangle soup): the cut line swept
   * along the bevel direction, so many bevels in one spot can be read by their overlap instead of
   * a thicket of arrows. Coloured like their cut thickness.
   */
  bevelAreas: { thickness: number; triangles: number[] }[]
  /**
   * Non-cutting layout marks (`PU`/`KO` scribe lines and `SI` etch text), kept separate from the
   * cut lines because they use their own legend colours and are not part of the cut path.
   */
  marks: NcMarkSet[]
}

/** One mark channel (`etch` / `marking`) projected into scene coordinates. */
export interface NcMarkSet {
  kind: NcMark['kind']
  /** Flat XYZ pair list for scribe/marking polylines. */
  points: number[]
  /** Etch text placements; empty for scribe lines. */
  texts: {
    at: Vec3
    /** Outward face normal in scene coordinates, so the label can lie on the face. */
    normal: Vec3
    /** Unit vector along the member (the text baseline at angle 0). */
    along: Vec3
    /** Unit vector across the face, to keep the label upright. */
    across: Vec3
    value: string
    height: number
    angle: number
  }[]
}

/** Segments around each hole ring — enough to read as a circle at part scale. */
const HOLE_STEPS = 24

/**
 * The face-space outline of a hole as a closed polyline (last point repeats the first): a circle,
 * or — for a DSTV slotted (`l`) hole — an **obround** (stadium) whose end centres are the hole's
 * start point `(x, y)` and its far end (the rotated {@link slotOffset}), each of radius
 * `diameter / 2`.
 */
export function holeOutline(hole: NcHole, steps = HOLE_STEPS): [number, number][] {
  const r = hole.diameter / 2
  const slot = hole.slot
  const points: [number, number][] = []
  if (slot && (slot.dx !== 0 || slot.dy !== 0)) {
    const [dx, dy] = slotOffset(slot)
    const base = Math.atan2(dy, dx)
    const half = Math.max(2, Math.round(steps / 2))
    // Far end's semicircle, sweeping through the slot direction (base ± 90°), then the near
    // end's, back to the start — together they trace the full stadium.
    for (let i = 0; i <= half; i++) {
      const a = base - Math.PI / 2 + (i / half) * Math.PI
      points.push([hole.x + dx + Math.cos(a) * r, hole.y + dy + Math.sin(a) * r])
    }
    for (let i = 0; i <= half; i++) {
      const a = base + Math.PI / 2 + (i / half) * Math.PI
      points.push([hole.x + Math.cos(a) * r, hole.y + Math.sin(a) * r])
    }
    points.push([points[0][0], points[0][1]])
    return points
  }
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2
    points.push([hole.x + Math.cos(a) * r, hole.y + Math.sin(a) * r])
  }
  return points
}

/** Samples taken along a cut segment when testing whether any of it has material (see `reached`). */
const REACH_SAMPLES = 8

/** Default spur length (mm) shown for an angle-only bevel that carries no distance. */
const DEFAULT_BEVEL_SPUR = 3

/** Bevel arrow length (mm, tip distance from the cut line), head size (mm) and spacing (mm). */
const ARROW_LENGTH = 30
const ARROW_HEAD = 9
const ARROW_SPACING = 40
/** How far (mm) the translucent bevel area sweeps out from the cut line (same reach as an arrow). */
const BEVEL_AREA_LENGTH = 30
/** A bevel within this many degrees of the surface normal is a plain (regular) cut — no arrow. */
const REGULAR_CUT_DEG = 8

function normalize(v: Vec3): Vec3 {
  const length = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / length, v[1] / length, v[2] / length]
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

/**
 * A stemmed arrow. The stem runs from the cut line outward along `dir`; the head sits at the cut
 * line and points back inward (against `dir`) along the same line.
 */
function arrow(target: number[], at: Vec3, dir: Vec3, spread: Vec3): void {
  const tail: Vec3 = [
    at[0] + dir[0] * ARROW_LENGTH,
    at[1] + dir[1] * ARROW_LENGTH,
    at[2] + dir[2] * ARROW_LENGTH,
  ]
  push(target, at, tail)
  const half = ARROW_HEAD * 0.5
  const bx = at[0] + dir[0] * ARROW_HEAD
  const by = at[1] + dir[1] * ARROW_HEAD
  const bz = at[2] + dir[2] * ARROW_HEAD
  push(target, at, [bx + spread[0] * half, by + spread[1] * half, bz + spread[2] * half])
  push(target, at, [bx - spread[0] * half, by - spread[1] * half, bz - spread[2] * half])
}

/**
 * Signed bevel angle (deg) at a vertex — the cuttable side of its welding preparation. A vertex may
 * carry a prep on both sides of the plate; only a couple within the head's range is a cut the head
 * makes (see `selectWeldingPrep`). `0` = no bevel.
 */
function bevelAngle(bevel: number[] | undefined): number {
  return selectWeldingPrep(bevel).angle
}

/** Bevel distance to draw for a vertex, or 0 when the vertex is a plain cut. */
function bevelDistance(bevel: number[] | undefined): number {
  const { angle, distance } = selectWeldingPrep(bevel)
  if (distance > 0) return distance
  return angle !== 0 ? DEFAULT_BEVEL_SPUR : 0
}

function push(target: number[], a: Vec3, b: Vec3): void {
  target.push(a[0], a[1], a[2], b[0], b[1], b[2])
}

/** One triangle (a, b, c) appended as three vertices, for the translucent bevel-area mesh. */
function pushTriangle(target: number[], a: Vec3, b: Vec3, c: Vec3): void {
  target.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2])
}

/** The quad a → b → c → d as two triangles — a flat fin swept from the cut line. */
function pushQuad(target: number[], a: Vec3, b: Vec3, c: Vec3, d: Vec3): void {
  pushTriangle(target, a, b, c)
  pushTriangle(target, a, c, d)
}

/** Signed area of a closed polygon (positive = counter-clockwise). */
function signedArea(points: [number, number][]): number {
  let twice = 0
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    twice += points[j][0] * points[i][1] - points[i][0] * points[j][1]
  }
  return twice / 2
}

/**
 * Leg thickness (mm) an EA/UA callout names, e.g. `EA75*75*6` → 6. The code itself carries it, so
 * this is exact and needs no geometry; returns 0 when the callout omits the thickness (`EA75*75`).
 */
function angleCodeThickness(profile: string): number {
  const n = profile.match(/\d+(?:\.\d+)?/g)?.map(Number) ?? []
  return n.length >= 3 ? (n[2] as number) : 0
}

/**
 * Wall thickness (mm) a hollow callout names — `RHS150*100*9.0` / `SHS100*100*6.0` → 9 / 6 and
 * `CHS88.9*4.0` → 4. The code carries it (the outer outline alone can't reveal a hollow's wall), so
 * no geometry is needed; 0 when the wall is omitted.
 */
function hollowWallThickness(profile: string): number {
  const clean = profile.trim().toUpperCase()
  const n = clean.match(/\d+(?:\.\d+)?/g)?.map(Number) ?? []
  return /^CHS/.test(clean) ? (n[1] ?? 0) : (n[2] ?? 0)
}

/**
 * Leg thickness (mm) of an angle face: the distance from the face plane to the opposite **long flat**
 * edge of the leg. Measuring to the nearest *vertex* collapses on the toe radius, whose chords sit
 * ~1 mm inside the leg face; the leg's far surface is instead the long flat opposite edge.
 */
function angleFaceThickness(
  normal: { axis: Axis; sign: 1 | -1 },
  section: [number, number][],
  faceCoord: number,
): number {
  const axis = normal.axis
  const ccw = signedArea(section) >= 0
  const candidates: { distance: number; length: number }[] = []
  for (let i = 0; i < section.length; i++) {
    const a = section[i] as [number, number]
    const b = section[(i + 1) % section.length] as [number, number]
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const length = Math.hypot(dx, dy) || 1
    // Outward normal of a CCW polygon edge is (dy, -dx); reversed for a CW polygon.
    const nAxis = (axis === 0 ? (ccw ? dy : -dy) : ccw ? -dx : dx) / length
    // Parallel to the face and facing back toward it (so a same-side silhouette edge is ignored).
    if (nAxis * normal.sign > -0.9) continue
    const distance = Math.abs((a[axis] ?? 0) - faceCoord)
    if (distance > 0.01) candidates.push({ distance, length })
  }
  if (candidates.length > 0) {
    // A rounded toe yields only short chords, so ignore anything much shorter than the longest
    // opposite flat — that flat is the leg's far surface.
    const longest = Math.max(...candidates.map((c) => c.length))
    let min = Number.POSITIVE_INFINITY
    for (const c of candidates) if (c.length >= longest * 0.5 && c.distance < min) min = c.distance
    if (Number.isFinite(min)) return min
  }
  return 0
}

/**
 * Wall thickness (mm) a face cuts through: the distance from the face plane to the nearest opposite
 * edge of the section (the plate the cut passes through) — e.g. the flange/ web thickness.
 *
 * A section's wall is named by its callout where the code carries it — an **angle**'s leg thickness
 * (`EA75*75*6` → 6 mm) and a **hollow**'s wall (`RHS150*100*9.0` → 9, `SHS100*100*6.0` → 6) — so
 * those are used directly. A short code that omits it falls back to the long flat rule (an angle) or
 * the nearest opposite vertex (everything else), as before.
 */
export function faceThickness(
  frame: NcFaceFrame,
  section: [number, number][],
  face: NcFace,
): number {
  const normal = faceNormal(frame, face, section)
  const axis = normal.axis
  // An I-section's web faces are milled through the web plate: its wall is the web thickness, i.e.
  // both halves of `webHalf`. The nearest-vertex rule below measures across the width edge and
  // picks up a root-fillet vertex instead, so report `2·webHalf` directly.
  if (frame.webHalf !== undefined && (face === 'v' || face === 'h')) return 2 * frame.webHalf
  // The face's own surface (for every other family this is the bounding-box edge; for an I-section's
  // `o`/`u` flange faces it is the depth extreme).
  const faceCoord = normal.sign * facePlaneHalf(frame, face)
  if (frame.profile) {
    const family = profileFamily(frame.profile)
    if (family === 'angle') {
      const named = angleCodeThickness(frame.profile)
      if (named > 0) return named
      const value = angleFaceThickness(normal, section, faceCoord)
      if (value > 0) return value
    } else if (family === 'tube' || family === 'round') {
      const wall = hollowWallThickness(frame.profile)
      if (wall > 0) return wall
    }
  }
  let min = Number.POSITIVE_INFINITY
  for (const point of section) {
    const distance = Math.abs((point[axis] ?? 0) - faceCoord)
    if (distance > 0.01 && distance < min) min = distance
  }
  return Number.isFinite(min) ? min : 0
}

/** Projects an NC's contours, holes and bevels into the caller's frame, grouped by cut thickness. */
export function projectNc(nc: NcGeometry, projection: NcProjection): NcLineSets {
  const { frame, section, toScene, normal } = projection
  const byFace: Record<NcFace, number[]> = { v: [], o: [], u: [], h: [] }
  const arrowsByFace: Record<NcFace, number[]> = { v: [], o: [], u: [], h: [] }
  const areasByFace: Record<NcFace, number[]> = { v: [], o: [], u: [], h: [] }
  /** Corner coordinates of the DSTV notch labels on a face — real cuts even where material recedes. */
  const notchCorners = (face: NcFace): [number, number][] =>
    nc.notches.filter((n) => n.face === face).map((n) => [n.x, n.y])

  const place = (face: NcFace, x: number, y: number) => {
    const point = placeNcFace(frame, face, x, y, section)
    return { point, world: toScene(point.along, point.cross, face) }
  }

  for (const contour of nc.contours) {
    const spur = normal(contour.face)
    for (let i = 0; i < contour.points.length - 1; i++) {
      const [x0, y0] = contour.points[i]
      const [x1, y1] = contour.points[i + 1]
      const a = place(contour.face, x0, y0)
      const b = place(contour.face, x1, y1)
      if (contour.kind === 'inner') {
        push(byFace[contour.face], a.world, b.world)
        continue
      }
      // A cut with no material anywhere along it (edge of stock / one-sided section) removes
      // nothing. Sample along the segment: checking only the *ends* wrongly drops a full-width end
      // cut, whose ends sit in the corner radius where the face plane recedes from the material.
      let reached = false
      for (let s = 0; s <= REACH_SAMPLES; s++) {
        const t = s / REACH_SAMPLES
        const cross: [number, number] = [
          a.point.cross[0] + (b.point.cross[0] - a.point.cross[0]) * t,
          a.point.cross[1] + (b.point.cross[1] - a.point.cross[1]) * t,
        ]
        if (materialReaches(frame, section, contour.face, cross)) {
          reached = true
          break
        }
      }
      if (!reached) {
        // A DSTV notch label (`t`/`w`) marks a real cut at a corner where the face plane recedes
        // (e.g. the necked end of a shaft). Keep the segment so its cut line is drawn.
        const notched = notchCorners(contour.face).some(
          ([nx, ny]) => Math.hypot(x0 - nx, y0 - ny) < 2 || Math.hypot(x1 - nx, y1 - ny) < 2,
        )
        if (!notched) continue
      }
      // A segment lying along the stock's own edge (the section boundary, both ends at the same
      // span extreme) removes nothing either — it's the raw-stock outline, not a cut.
      const span = faceSpanAxis(frame, contour.face)
      const halfSpan = faceHalf(frame, span)
      const ca = a.point.cross[span]
      const cb = b.point.cross[span]
      if (
        Math.sign(ca) === Math.sign(cb) &&
        Math.abs(Math.abs(ca) - halfSpan) < 0.5 &&
        Math.abs(Math.abs(cb) - halfSpan) < 0.5
      ) {
        continue
      }
      const d0 = bevelDistance(contour.bevels[i])
      const d1 = bevelDistance(contour.bevels[i + 1])
      // The cut line is grouped by its face's thickness; the bevel just adds its indication.
      push(byFace[contour.face], a.world, b.world)
      if (d0 <= 0 && d1 <= 0) continue

      // The cut face is tilted off the surface normal by the bevel angle; show that tilt either as
      // a stemmed arrow or as a translucent fin swept along the cut line. A bevel within
      // REGULAR_CUT_DEG of the normal is just a plain cut — neither is drawn.
      const deg =
        Math.abs(bevelAngle(contour.bevels[i])) >= Math.abs(bevelAngle(contour.bevels[i + 1]))
          ? bevelAngle(contour.bevels[i])
          : bevelAngle(contour.bevels[i + 1])
      if (Math.abs(deg) < REGULAR_CUT_DEG) continue
      const line = normalize([
        b.world[0] - a.world[0],
        b.world[1] - a.world[1],
        b.world[2] - a.world[2],
      ])
      const perp = normalize(cross(spur, line))
      const theta = (Math.abs(deg) * Math.PI) / 180
      // Bevels lean along the beam: mirroring the across axis flips the contour traversal `line`
      // and with it `perp`. A tube's short faces (`o`/`u`) are authored-traversed the other way in
      // our long-horizontal stance (see `ncAuthoredAcrossSign`), so their lean is negated.
      const mirrored =
        (frame.profile ? profileFamily(frame.profile) : null) === 'tube' &&
        ncAuthoredAcrossSign(frame, contour.face) < 0
      const side = (deg >= 0 ? 1 : -1) * (mirrored ? -1 : 1)
      // Outward tilt from the surface normal: at 0° it is the normal (regular), grows toward perp.
      const dir = normalize([
        spur[0] * Math.cos(theta) + perp[0] * Math.sin(theta) * side,
        spur[1] * Math.cos(theta) + perp[1] * Math.sin(theta) * side,
        spur[2] * Math.cos(theta) + perp[2] * Math.sin(theta) * side,
      ])
      // The translucent area: sweep the cut line out along the bevel direction. Overlapping fins of
      // nearby bevels read by their overlap, instead of a thicket of arrows.
      const reach: Vec3 = [
        dir[0] * BEVEL_AREA_LENGTH,
        dir[1] * BEVEL_AREA_LENGTH,
        dir[2] * BEVEL_AREA_LENGTH,
      ]
      pushQuad(
        areasByFace[contour.face],
        a.world,
        b.world,
        [b.world[0] + reach[0], b.world[1] + reach[1], b.world[2] + reach[2]],
        [a.world[0] + reach[0], a.world[1] + reach[1], a.world[2] + reach[2]],
      )
      const length = Math.hypot(
        b.world[0] - a.world[0],
        b.world[1] - a.world[1],
        b.world[2] - a.world[2],
      )
      const count = Math.max(1, Math.round(length / ARROW_SPACING))
      for (let k = 1; k <= count; k++) {
        const t = k / (count + 1)
        const at: Vec3 = [
          a.world[0] + (b.world[0] - a.world[0]) * t,
          a.world[1] + (b.world[1] - a.world[1]) * t,
          a.world[2] + (b.world[2] - a.world[2]) * t,
        ]
        arrow(arrowsByFace[contour.face], at, dir, line)
      }
    }
  }

  for (const hole of nc.holes) {
    const r = hole.diameter / 2
    if (!(r > 0)) continue
    const outline = holeOutline(hole)
    const ring: Vec3[] = []
    let anyReached = false
    for (const [hx, hy] of outline) {
      const placed = place(hole.face, hx, hy)
      if (materialReaches(frame, section, hole.face, placed.point.cross)) anyReached = true
      ring.push(placed.world)
    }
    // Drop a hole/slot that sits entirely where the section has no material on its face.
    if (!anyReached) continue
    for (let i = 0; i < ring.length - 1; i++) push(byFace[hole.face], ring[i], ring[i + 1])
  }

  // Layout marks (`PU`/`KO` scribe lines, `SI` etch text) are not cuts: project them without the
  // material-reach test, because they deliberately sit on faces that may be almost fully removed.
  const marksByKind = new Map<NcMark['kind'], NcMarkSet>()
  for (const mark of nc.marks) {
    let bucket = marksByKind.get(mark.kind)
    if (!bucket) {
      bucket = { kind: mark.kind, points: [], texts: [] }
      marksByKind.set(mark.kind, bucket)
    }
    if (mark.text) {
      const [mx, my] = mark.points[0] ?? [0, 0]
      const placed = place(mark.face, mx, my)
      // Face-plane basis so the text can be laid flat instead of billboarded (a billboard shows
      // through the solid from behind and leaks around the silhouette).
      const alongPoint = place(mark.face, mx + 1, my)
      const acrossPoint = place(mark.face, mx, my + 1)
      const unit = (dx: number, dy: number, dz: number): Vec3 => {
        const length = Math.hypot(dx, dy, dz) || 1
        return [dx / length, dy / length, dz / length]
      }
      bucket.texts.push({
        at: placed.world,
        normal: normal(mark.face),
        along: unit(
          alongPoint.world[0] - placed.world[0],
          alongPoint.world[1] - placed.world[1],
          alongPoint.world[2] - placed.world[2],
        ),
        across: unit(
          acrossPoint.world[0] - placed.world[0],
          acrossPoint.world[1] - placed.world[1],
          acrossPoint.world[2] - placed.world[2],
        ),
        value: mark.text.value,
        height: mark.text.height,
        angle: mark.text.angle,
      })
      continue
    }
    for (let i = 0; i < mark.points.length - 1; i++) {
      const [x0, y0] = mark.points[i] as [number, number]
      const [x1, y1] = mark.points[i + 1] as [number, number]
      const a = place(mark.face, x0, y0)
      const b = place(mark.face, x1, y1)
      push(bucket.points, a.world, b.world)
    }
  }
  const marks = [...marksByKind.values()].filter(
    (mark) => mark.points.length > 0 || mark.texts.length > 0,
  )

  // Group each buffer by the wall thickness of the face it cuts (same thickness ⇒ same colour).
  const groupByThickness = (
    buffers: Record<NcFace, number[]>,
  ): { thickness: number; points: number[] }[] => {
    const groups = new Map<number, number[]>()
    for (const face of ['v', 'o', 'u', 'h'] as NcFace[]) {
      const points = buffers[face]
      if (points.length === 0) continue
      const key = Math.round(faceThickness(frame, section, face) * 10) / 10
      const bucket = groups.get(key)
      if (bucket) bucket.push(...points)
      else groups.set(key, points)
    }
    return [...groups.entries()]
      .map(([thickness, points]) => ({ thickness, points }))
      .sort((a, b) => a.thickness - b.thickness)
  }
  const cuts = groupByThickness(byFace)
  const bevelArrows = groupByThickness(arrowsByFace)
  const bevelAreas = groupByThickness(areasByFace).map(({ thickness, points }) => ({
    thickness,
    triangles: points,
  }))
  return { cuts, bevelArrows, bevelAreas, marks }
}

/** Distinct cut thicknesses (mm) present in an NC, sorted ascending — for the viewer legend. */
export function cutThicknesses(
  frame: NcFaceFrame,
  section: [number, number][],
  nc: NcGeometry,
): number[] {
  const faces = new Set<NcFace>()
  for (const contour of nc.contours) faces.add(contour.face)
  for (const hole of nc.holes) faces.add(hole.face)
  const values = [...faces].map((face) => Math.round(faceThickness(frame, section, face) * 10) / 10)
  return [...new Set(values)].sort((a, b) => a - b)
}
