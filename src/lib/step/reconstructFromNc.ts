import { contourHasBevel, contourStepDepth } from '@/lib/audit/manufacturability'
import { parseDstv } from '@/lib/parsers/dstv'
import {
  faceHalf,
  faceSpanAxis,
  ncAuthoredStancePoints,
  resolveNcFaceFrame,
  sectionSpanAt,
} from '@/lib/parsers/ncFaces'
import { type NcFace, parseNcGeometry } from '@/lib/parsers/ncGeometry'
import { partSectionForCode } from '@/lib/sections/stock'
import { stripStraySolids } from './clean'
import type { MeasurableShape } from './measure'
import { ensureOc } from './occInit'

/**
 * EXPERIMENTAL / standalone: rebuild a prismatic part's solid from its DSTV `.nc1`.
 *
 * Kept separate from the nesting/preflight pipeline (the preflight viewer is the only caller).
 * The NC is treated as ground truth: the cross-section comes from the profile code + `ST` header
 * dims (via `partSectionForCode`), the outline from the `AK` contours, and holes from `BO`.
 *
 * Faces are paired as DSTV defines them — `v`/`h` share one cross-section axis, `o`/`u` the other
 * — and which is which is matched by comparing the contour's Y-extent to the section's two
 * dimensions. Validated against healthy sibling parts: bounding box within a few mm and volume
 * within ~2% (the deficit is end-arc radii, drawn straight for now).
 *
 * Handles `T`, `RHS`/`SHS`, `PFC`/`TFC`, `EA`/`UA`, `UB` and `CHS`. Returns `null` otherwise.
 */

type Pt = [number, number]
type Axis = 0 | 1

/**
 * How far the modelled cut tool over-reaches into the material — 3–4 cm. An enclosed NC surface
 * (a hole) is only ever cut this deep from its own face, never straight through the section; a
 * notch is stripped from both faces. Distinct from the analysis pierce cap
 * (`MAX_CUT_THICKNESS_MM`), which is the head's real single-pass material limit.
 */
const BEAM_REACH = 35

/**
 * Laser kerf (mm) modelled in the NC fabrication: every outline cut removes a kerf-wide slot,
 * so the removal tool overlaps the finished surface instead of sharing its faces exactly (which
 * makes OCC booleans drop the cut and leave the scrap as floating bodies). 0.2 mm is a thin but
 * real fibre-laser kerf; the 0.1 mm skin it takes off the constrained surfaces costs well under
 * 1% volume (far inside the validation tolerances), while sitting twice clear of the
 * face-coincidence that breaks the booleans.
 */
export const LASER_KERF = 0.2

/**
 * Minimum gap (mm) between a face-outline's own end and the member's global end before the
 * "band" squares that face off to the global extent. The band exists so an OTHER face's
 * bevel/mitre wedge is not severed by this axis's trim. It must not fire on a face that already
 * reaches the end (a near-zero gap), or it squares a mitre off into a full-height end wall.
 */
const BAND_MIN_GAP = 0.5

/**
 * Erodes a closed outline inward by `d` (mm): each edge shifts along its inward normal and
 * adjacent shifted edges re-intersect. Returns `null` when the loop is degenerate, too small,
 * or an intersection blows up (a tight concave spike) — callers fall back to the exact outline,
 * i.e. today's behaviour for that contour. Pure 2D math, no OCC.
 */
export function erodePolygon(pts: Pt[], d: number): Pt[] | null {
  const cleaned = pts.filter(
    (p, i) => i === 0 || Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) > 0.01,
  )
  if (cleaned.length < 3 || !(d > 0)) return null
  let area = 0
  for (let i = 0; i < cleaned.length; i++) {
    const a = cleaned[i] ?? [0, 0]
    const b = cleaned[(i + 1) % cleaned.length] ?? [0, 0]
    area += a[0] * b[1] - b[0] * a[1]
  }
  if (!(Math.abs(area) > 0)) return null
  const inward = area > 0 ? 1 : -1 // CCW: interior is left of each directed edge
  const n = cleaned.length
  const shifted: [Pt, Pt][] = []
  for (let i = 0; i < n; i++) {
    const a = cleaned[i] ?? [0, 0]
    const b = cleaned[(i + 1) % n] ?? [0, 0]
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const len = Math.hypot(dx, dy)
    if (!(len > 0)) return null
    const nx = (-dy / len) * inward * d
    const ny = (dx / len) * inward * d
    shifted.push([
      [a[0] + nx, a[1] + ny],
      [b[0] + nx, b[1] + ny],
    ])
  }
  const out: Pt[] = []
  for (let i = 0; i < n; i++) {
    const prev = shifted[(i + n - 1) % n] ?? [0, 0]
    const cur = shifted[i] ?? [0, 0]
    const p = prev[0]
    const r: Pt = [prev[1][0] - prev[0][0], prev[1][1] - prev[0][1]]
    const q = cur[0]
    const s: Pt = [cur[1][0] - cur[0][0], cur[1][1] - cur[0][1]]
    const cross = r[0] * s[1] - r[1] * s[0]
    const orig = cleaned[i] ?? [0, 0]
    if (Math.abs(cross) < 1e-9) {
      // Collinear neighbours: the shifted point itself is the eroded vertex.
      out.push([q[0], q[1]])
      continue
    }
    const t = ((q[0] - p[0]) * s[1] - (q[1] - p[1]) * s[0]) / cross
    const hit: Pt = [p[0] + t * r[0], p[1] + t * r[1]]
    // A concave spike inverts the offset (intersection shoots far): refuse it.
    if (Math.hypot(hit[0] - orig[0], hit[1] - orig[1]) > 10 * d) return null
    out.push(hit)
  }
  // Crossed offset walls (a solid protrusion narrower than 2d) self-intersect the loop:
  // the offset is meaningless there, so refuse it.
  const orient = (a: Pt, b: Pt, c: Pt): number =>
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
  const sharesEndpoint = (a: Pt, b: Pt): boolean => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-9
  for (let i = 0; i < n; i++) {
    const a = out[i] ?? [0, 0]
    const b = out[(i + 1) % n] ?? [0, 0]
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue // adjacent around the loop closure
      const c = out[j] ?? [0, 0]
      const d2 = out[(j + 1) % n] ?? [0, 0]
      if (
        sharesEndpoint(a, c) ||
        sharesEndpoint(a, d2) ||
        sharesEndpoint(b, c) ||
        sharesEndpoint(b, d2)
      )
        return null
      const o1 = orient(a, b, c)
      const o2 = orient(a, b, d2)
      const o3 = orient(c, d2, a)
      const o4 = orient(c, d2, b)
      if (
        Math.abs(o1) < 1e-9 &&
        Math.abs(o2) < 1e-9 &&
        Math.abs(o3) < 1e-9 &&
        Math.abs(o4) < 1e-9
      ) {
        // Collinear: refuse only on a genuine overlap (disjoint shared-line edges are fine).
        const ax = Math.abs(b[0] - a[0]) >= Math.abs(b[1] - a[1]) ? 0 : 1
        const lo1 = Math.min(a[ax] ?? 0, b[ax] ?? 0)
        const hi1 = Math.max(a[ax] ?? 0, b[ax] ?? 0)
        const lo2 = Math.min(c[ax] ?? 0, d2[ax] ?? 0)
        const hi2 = Math.max(c[ax] ?? 0, d2[ax] ?? 0)
        if (Math.min(hi1, hi2) - Math.max(lo1, lo2) > 1e-9) return null
      } else if (o1 * o2 < 0 && o3 * o4 < 0) return null
    }
  }
  return out
}

interface SolidOps {
  intersect: (other: SolidOps) => SolidOps
  cut: (other: SolidOps) => SolidOps
}

/** Drops consecutive (and closing) duplicate points, keeping the per-vertex arc radii aligned. */
function dedupeWithRadii(pts: Pt[], radii: number[]): { pts: Pt[]; radii: number[] } {
  const outPts: Pt[] = []
  const outRadii: number[] = []
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]
    if (!p) continue
    if (i > 0 && p[0] === pts[i - 1]?.[0] && p[1] === pts[i - 1]?.[1]) continue
    outPts.push(p)
    outRadii.push(radii[i] ?? 0)
  }
  if (
    outPts.length > 1 &&
    outPts[0]?.[0] === outPts[outPts.length - 1]?.[0] &&
    outPts[0]?.[1] === outPts[outPts.length - 1]?.[1]
  ) {
    outPts.pop()
    outRadii.pop()
  }
  return { pts: outPts, radii: outRadii }
}

export interface ReconstructOptions {
  /**
   * Leave a flat surface where a face carries a sudden thickness step (a cut the laser can't
   * sweep), instead of reproducing the step. Used for the "simplify to flat surface" fix.
   */
  simplify?: boolean
  /**
   * Measure-only: skip the STEP export. Measuring is orientation-agnostic, and the analysis phase
   * discards the text — pure waste there.
   */
  measureOnly?: boolean
}

export async function reconstructStepFromNc(
  ncText: string,
  options: ReconstructOptions = {},
): Promise<string | null> {
  const built = await reconstructSolidFromNc(ncText, options)
  return built?.step ?? null
}

/**
 * Rebuilds the part solid from its DSTV `.nc1` and returns both the live OCC shape and its STEP
 * text. The shape is what was exported, so callers that need to measure it (e.g. the STEP worker)
 * should run `measureShape` on `solid` directly — re-importing `step` just to measure it pays for
 * a STEP export + parse round trip of geometry already in memory.
 */
export async function reconstructSolidFromNc(
  ncText: string,
  options: ReconstructOptions = {},
): Promise<{ solid: SolidOps & MeasurableShape; step: string } | null> {
  const header = parseDstv(ncText).header
  const geo = parseNcGeometry(ncText)
  const rawSection = partSectionForCode(header.profile, header.dimensions)
  if (!rawSection || rawSection.points.length < 3) return null
  // The canonical PFC stance (`n`, flanges down) is a 90° rotation of the stance this rebuild's
  // axis logic assumes (web vertical). Build in that authored stance so the tested geometry math is
  // unchanged, then roll the finished solid back to canonical (see `canonicalSectionFlip`).
  const authoredPoints = ncAuthoredStancePoints(header.profile, rawSection.points)
  const canonicalSectionFlip = authoredPoints !== rawSection.points
  const section = canonicalSectionFlip ? { ...rawSection, points: authoredPoints } : rawSection

  await ensureOc()
  const { draw, drawCircle, drawRoundedRectangle } = await import('replicad')
  const poly = (pts: Pt[], radii?: number[]) => {
    let pen = draw(pts[0])
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]
      const b = pts[i]
      if (!a || !b) continue
      // A non-zero DSTV vertex radius is an arc to the next vertex. Draw a real arc (sagitta
      // derived from the chord + radius) instead of the straight chord that used to stand in for
      // it — the standing "end-arc radii drawn straight" deficit.
      const radius = radii?.[i - 1] ?? 0
      if (radius !== 0) {
        const chord = Math.hypot(b[0] - a[0], b[1] - a[1])
        if (chord > 0 && Math.abs(radius) > chord / 2) {
          const sagitta = Math.abs(radius) - Math.sqrt(radius * radius - (chord / 2) ** 2)
          pen = pen.sagittaArcTo(b, radius >= 0 ? sagitta : -sagitta)
          continue
        }
      }
      pen = pen.lineTo(b)
    }
    return pen.close()
  }

  // `v`/`h` faces share one cross-section axis, `o`/`u` the other; the shared frame resolves
  // which by matching a contour's across-extent to the section's two dimensions (the same rule
  // the viewer uses to project cuts onto the face the laser cuts).
  const frame = resolveNcFaceFrame(section.points, geo)
  const outer = geo.contours.filter((c) => c.kind === 'outer')
  const maxX = Math.max(
    ...geo.contours.flatMap((c) => c.points.map((p) => p[0])),
    ...geo.holes.map((h) => Math.max(h.x, h.x + (h.slot?.dx ?? 0)) + h.diameter),
  )
  const faceAxis = (face: string): Axis => faceSpanAxis(frame, face as NcFace)
  const halfOf = (axis: Axis): number => faceHalf(frame, axis)
  const pointsByAxis: Record<Axis, Pt[]> = { 0: [], 1: [] }
  const drawingsByAxis: Record<Axis, ReturnType<typeof poly>[]> = { 0: [], 1: [] }

  // Base prism: cross-section in the (width=Y, depth=Z) plane, extruded along the member (X).
  let solid = poly(section.points)
    .sketchOnPlane('YZ')
    .extrude(maxX + 20) as unknown as SolidOps

  // Holes in the section (hollow RHS/SHS/CHS) are through-cuts too.
  for (const hole of section.holes ?? []) {
    const cut = poly(hole)
      .sketchOnPlane('YZ')
      .extrude(maxX + 20) as unknown as SolidOps
    solid = solid.cut(cut)
  }

  for (const c of outer) {
    const axis = faceAxis(c.face)
    const half = halfOf(axis)
    const { pts: rawPts, radii } = dedupeWithRadii(c.points, c.radii ?? [])
    // Channel web faces (`v`/`h`) run the opposite way across the depth once seated canonically —
    // the same reversal `ncAuthoredAcrossSign` applies for the projection, so the two agree.
    const flip = canonicalSectionFlip && (c.face === 'v' || c.face === 'h')
    const pts = rawPts.map(([x, y]) => [x, (flip ? half - y : y - half) as number] as Pt)
    pointsByAxis[axis].push(...pts)
    // Exact outline for both axes. The axis-1 outline used to be kerf-eroded (0.1 mm inset) to
    // stop OCC sharing the trim's faces with the base prism — but the inset left a 0.1 mm ledge
    // beside every real edge and mis-aligned with the end "band", walling the bevel off as a
    // staircase. stripStraySolids now absorbs any floating debris instead.
    drawingsByAxis[axis].push(poly(pts, radii))
  }

  // Global member-end extent over every outer face outline. Faces routinely disagree in X at
  // an end (a sloped/bevel end runs long on one face, short on another); the union silhouette —
  // never the shortest face — is the true end. Without this the short face's trim severs the
  // long face's end wedge into stray bodies (and deletes a slice at the cut), or squares the
  // member short by dropping the end caps entirely (m106 lost 92 mm silently).
  const endXs = outer.flatMap((c) => c.points.map((p) => p[0]))
  const endMinX = Math.min(...endXs)
  const endMaxX = Math.max(...endXs)

  // Constrain each cross-section axis by the union of that axis's face outlines. A mitre makes
  // the top face shorter than the bottom, so the union (not either face alone) is the true
  // silhouette and stops the intersection from over-trimming the ends.
  for (const axis of [0, 1] as Axis[]) {
    const drawings = drawingsByAxis[axis]
    if (drawings.length === 0) continue
    const half = halfOf(axis)
    // 2D fuse throws (rather than returning null) on some real outlines — a near-tangent
    // band edge can break the curve splitter. Skipping the thrower keeps today's behaviour
    // for the rest instead of failing the rebuild.
    const fusePens = (pens: ReturnType<typeof poly>[]): ReturnType<typeof poly> | null => {
      let fused = pens[0]
      if (!fused) return null
      for (let i = 1; i < pens.length; i++) {
        try {
          const next = (fused as unknown as { fuse: (other: unknown) => unknown }).fuse(pens[i])
          if (next) fused = next as typeof fused
        } catch {
          return null
        }
      }
      return fused
    }
    let shape = fusePens(drawings)
    if (!shape) continue
    const fuseIn = (other: ReturnType<typeof poly>): void => {
      try {
        const fused = (shape as unknown as { fuse: (other: unknown) => unknown }).fuse(other)
        if (fused) shape = fused as typeof shape
      } catch {
        // Leave the band out rather than fail the rebuild (see above).
      }
    }
    // Square each face outline off to the global end extent: material past a face's own end
    // belongs to another face's wall (a bevel-cut end wedge), so this axis's trim must neither
    // cut it away nor let it detach — the other axis's union already shapes the slope itself.
    // Interior copes and chamfers (fully inside the outline's own X range) still carve normally.
    // The bands overlap the outline by 1 mm (an edge-touching fuse does not merge reliably) and
    // stop exactly at the global extent (the trim rect's own ±2 padding stays empty, so no
    // sliver body is kept past the member end). A band is only added where the other axis's
    // outlines already span the whole band range — otherwise the band would keep a full-section
    // slab floating past a sloped face start (m143), instead of joining a wedge (m71/m124).
    const loopXs = pointsByAxis[axis].map((p) => p[0])
    const loopMinX = Math.min(...loopXs)
    const loopMaxX = Math.max(...loopXs)
    const otherXs = pointsByAxis[(1 - axis) as Axis].map((p) => p[0])
    const otherSpans = (x0: number, x1: number): boolean => {
      if (otherXs.length === 0) return true
      const eps = 1e-6
      return Math.min(...otherXs) <= x0 + eps && Math.max(...otherXs) >= x1 - eps
    }
    const band = (x0: number, x1: number): ReturnType<typeof poly> =>
      poly([
        [x0, -half - 2],
        [x1, -half - 2],
        [x1, half + 2],
        [x0, half + 2],
      ])
    if (loopMinX - endMinX > BAND_MIN_GAP && otherSpans(endMinX, loopMinX + 1))
      fuseIn(band(endMinX, loopMinX + 1))
    if (endMaxX - loopMaxX > BAND_MIN_GAP && otherSpans(loopMaxX - 1, endMaxX))
      fuseIn(band(loopMaxX - 1, endMaxX))
    // Simplifying: leave the face flat rather than reproducing a step, or a bevel whose
    // straight-through cut would sever a piece it is meant to keep.
    if (
      options.simplify &&
      axis === 1 &&
      outer.some((c) => faceAxis(c.face) === 1 && (contourStepDepth(c) > 0 || contourHasBevel(c)))
    ) {
      continue
    }
    if (axis === 0) {
      // Face plane is (X, width=Y); extrude across the depth and keep the inside.
      const prism = (shape as ReturnType<typeof poly>)
        .sketchOnPlane('XY')
        .extrude(400)
        .translate(0, 0, -150) as unknown as SolidOps
      solid = solid.intersect(prism)
    } else {
      // Face plane is (X, depth=Z). `intersect` trips an OCC boolean error with the section
      // prism, so remove the complement (bounding rectangle minus the outline) with a cut.
      // The rectangle spans the global end extent (not just this axis's outlines), so a
      // longer face's end wedge is never left standing past the cut as a stray body.
      const rect = poly([
        [endMinX - 2, -half - 2],
        [endMaxX + 2, -half - 2],
        [endMaxX + 2, half + 2],
        [endMinX - 2, half + 2],
      ])
      const notch = (() => {
        try {
          return (rect as unknown as { cut: (other: unknown) => unknown }).cut(shape)
        } catch {
          return null
        }
      })()
      if (!notch) continue
      // `sketchOnPlane('XZ')` extrudes towards −Y, so shift the prism back over the section
      // (which sits at Y = −half..half) rather than away from it.
      //
      // Limited distance: the laser only reaches BEAM_REACH into the material from each
      // face, so the trim cuts a skin that deep from both sides instead of vaporising the
      // whole width. A full-width cut deletes extensions (flange tips past a mitred web)
      // the head physically cannot reach — the manufactured model then runs short and the
      // detached rest shows up as stray bodies.
      const faceOut = halfOf(0 as Axis)
      const skin = (topEdge: number): SolidOps =>
        (notch as ReturnType<typeof poly>)
          .sketchOnPlane('XZ')
          .extrude(BEAM_REACH)
          .translate(0, topEdge, 0) as unknown as SolidOps
      solid = solid.cut(skin(faceOut + 2))
      solid = solid.cut(skin(-faceOut - 2 + BEAM_REACH))
    }
  }

  // Holes, drilled perpendicular to the face they sit on — and ONLY as deep as the beam reaches.
  // An enclosed NC surface (a `BO` hole) is a single 3–4 cm cut: the cutter runs from just outside
  // the face a `BEAM_REACH` inward, so it passes through that face's wall and stops, never
  // crossing to the opposite wall (which the beam could not reach anyway). The NC gives each hole
  // size its own face (e.g. Ø14 on `o`, Ø10 on `u`).
  const positiveFace = (face: string): boolean => face === 'o' || face === 'v'
  for (const h of geo.holes.filter((h) => h.diameter > 0)) {
    const axis = faceAxis(h.face)
    const half = halfOf(axis)
    // The drill runs along the *other* cross-section axis; the face sits at ±(that axis's half).
    const faceOut = halfOf((1 - axis) as Axis)
    let sign: 1 | -1 = positiveFace(h.face) ? 1 : -1
    // One-sided sections (T flange) carry the face on one side only: start the
    // drill where section material actually reaches at this hole's position,
    // not where symmetry assumes it. Symmetric sections reach both sides, so
    // the pairing table stands for them.
    const [lo, hi] = sectionSpanAt(section.points, axis, h.y - half)
    const reached = sign > 0 ? hi >= faceOut - 2 : lo <= -faceOut + 2
    if (!reached) {
      const otherReached = sign > 0 ? lo <= -faceOut + 2 : hi >= faceOut - 2
      if (otherReached) sign = sign > 0 ? -1 : 1
    }
    const outside = faceOut + 2
    // A plain hole is a circle; a DSTV slotted (`l`) hole is an obround (stadium) — a rounded
    // rectangle whose corner radius is the hole radius, so its ends are true semicircles — laid
    // from the start point `(x, y)` to the far end `(x + dx, y + dy)` in the face plane.
    const crossDrawing = (): ReturnType<typeof drawCircle> => {
      const slot = h.slot
      if (slot && (slot.dx !== 0 || slot.dy !== 0)) {
        const length = Math.hypot(slot.dx, slot.dy)
        const angle = (Math.atan2(slot.dy, slot.dx) * 180) / Math.PI
        return drawRoundedRectangle(length + h.diameter, h.diameter, h.diameter / 2)
          .rotate(angle)
          .translate(h.x + slot.dx / 2, h.y + slot.dy / 2 - half)
      }
      return drawCircle(h.diameter / 2).translate(h.x, h.y - half)
    }
    if (axis === 0) {
      // Drill along the 3D Z axis (perpendicular to the `v`/`h` faces).
      const cyl = crossDrawing().sketchOnPlane('XY').extrude(BEAM_REACH)
      const shift = sign > 0 ? outside - BEAM_REACH : -outside
      solid = solid.cut(cyl.translate(0, 0, shift) as unknown as SolidOps)
    } else {
      // Drill along the 3D Y axis (`o`/`u`); `sketchOnPlane('XZ')` extrudes towards −Y.
      const cyl = crossDrawing().sketchOnPlane('XZ').extrude(BEAM_REACH)
      const shift = sign > 0 ? outside : BEAM_REACH - outside
      solid = solid.cut(cyl.translate(0, shift, 0) as unknown as SolidOps)
    }
  }

  // NC booleans can leave floating slivers alongside the real body. Strip them on the
  // live shape — same rule as cleanStep, but with no STEP round trip — so orientation
  // (centre-of-mass ranking), measure and export all see the manufactured body only.
  solid = (await stripStraySolids(solid as unknown as MeasurableShape)).solid as unknown as SolidOps

  // Roll the internal-stance build back to the canonical stance (web down→up) so the viewer, NC
  // projection and exported STEP are all canonical. 90° about the member axis (X).
  if (canonicalSectionFlip) {
    solid = (
      solid as unknown as { rotate: (a: number, p: number[], d: number[]) => SolidOps }
    ).rotate(-90, [0, 0, 0], [1, 0, 0])
  }

  // Measure-only callers (analysis phase 4) compare the live solid and discard
  // the text — skip the STEP export entirely.
  if (options.measureOnly) return { solid: solid as SolidOps & MeasurableShape, step: '' }
  const blob = (solid as unknown as { blobSTEP: () => Blob }).blobSTEP()
  return { solid: solid as SolidOps & MeasurableShape, step: await blob.text() }
}
