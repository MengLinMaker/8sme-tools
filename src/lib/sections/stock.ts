import type { PartRecord } from '@/lib/audit/types'
import { extractDrawingText, findSectionCode } from '@/lib/parsers/pdfText'
import { getAngle } from './angle'
import { inferTee } from './infer'
import { getPfcByDepth } from './pfc'
import { getTfbByDepth } from './tfb'
import type { RolledAngle, RolledSection } from './types'
import { getUb } from './ub'
import { getUc, getUcByDepth } from './uc'

/**
 * Builds the uncut stock cross-section ("ghost") for a part from its section
 * callout. Sections follow Australian short-forms as they appear on the drawings
 * (and identically in the NC header / part list): `EA75*75*6`, `UA100*75*6`,
 * `RHS150*100*9.0`, `SHS100*100*6.0`, `PFC100*50`, `BT100*15`, `200UB29.8`.
 *
 * # Canonical orientation (see `docs/canonical-orientation.md`)
 *
 * Every stock beam is cut in one **canonical machine stance**; the section frame is
 * `+x = right, +y = up` and the length runs along the member axis. Target stances:
 *
 *  - UB / UC / TFB (`I`)   → `H`  web vertical, flanges horizontal  → **implemented**
 *  - PFC / TFC (`U`, `C`)  → `n`  web on top, both flanges down     → **implemented**
 *  - RHS / SHS (`M`)       → longer cross-section side horizontal   → **implemented**
 *  - angle EA / UA (`L`)   → `L`  longer leg horizontal, open up-right → **implemented**
 *  - T (`T`)               → flange down, web up                    → **implemented**
 *
 * DSTV faces (`v` front/web, `o` top, `u` bottom, `h` behind) are **profile-relative**, not
 * machine-relative; once seated, a face's machine role is its outward normal (`+y` top,
 * `−y` bottom, `±x` side). Machine-readable form of these rules: `./canonical.ts`. The RHS/SHS
 * builder draws the canonical long-horizontal stance — a 90° rotation of the DSTV/Tekla
 * authored (long-vertical) stance — so its face sides are resolved in `./../parsers/ncFaces.ts`.
 */

export interface StockOutline {
  /** closed cross-section outline in mm, centred on its bounding box */
  points: [number, number][]
  /** inner voids for hollow sections (RHS/SHS/CHS), in mm */
  holes?: [number, number][][]
  /** human label, e.g. "PFC100*50 stock" */
  label: string
  /** nominal mass per metre (kg/m), where known */
  mass?: number
}

type Family =
  | 'tee'
  | 'angle-equal'
  | 'angle-unequal'
  | 'rhs'
  | 'shs'
  | 'chs'
  | 'channel'
  | 'ub'
  | 'uc'
  | 'tfb'

const PREFIXES: [RegExp, Family][] = [
  [/^BT/, 'tee'],
  [/^EA/, 'angle-equal'],
  [/^UA/, 'angle-unequal'],
  [/^RHS/, 'rhs'],
  [/^SHS/, 'shs'],
  [/^CHS/, 'chs'],
  [/^TFC/, 'channel'],
  [/^PFC/, 'channel'],
  [/^UC/, 'uc'],
  [/^TFB/, 'tfb'],
  [/^(?:UB|WB|WC)/, 'ub'],
]

/** Outward inflation (mm) for the stock ghost. 0 = exact size (flush with the part). */
const INFLATE = 0

function numbers(code: string): number[] {
  return (code.match(/\d+(?:\.\d+)?/g) ?? []).map(Number)
}

function centre(points: [number, number][]): [number, number][] {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const [x, y] of points) {
    minX = Math.min(minX, x)
    maxX = Math.max(maxX, x)
    minY = Math.min(minY, y)
    maxY = Math.max(maxY, y)
  }
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  return points.map(([x, y]) => [x - cx, y - cy] as [number, number])
}

/** Signed area of a closed polygon (positive = counter-clockwise). */
function signedArea(points: [number, number][]): number {
  let twice = 0
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    twice += points[j][0] * points[i][1] - points[i][0] * points[j][1]
  }
  return twice / 2
}

/** Intersection of two infinite lines (a→b and c→d), or null when parallel. */
function lineIntersection(
  a: [number, number],
  b: [number, number],
  c: [number, number],
  d: [number, number],
): [number, number] | null {
  const rx = b[0] - a[0]
  const ry = b[1] - a[1]
  const sx = d[0] - c[0]
  const sy = d[1] - c[1]
  const denom = rx * sy - ry * sx
  if (Math.abs(denom) < 1e-9) return null
  const t = ((c[0] - a[0]) * sy - (c[1] - a[1]) * sx) / denom
  return [a[0] + t * rx, a[1] + t * ry]
}

/**
 * Offsets a closed outline outward by a **constant** `distance` — every face moves the same
 * amount along its normal (via mitered corners). A uniform scale would short-change the thin
 * axis of an elongated section (e.g. a PFC flange vs its depth), so the clearance must be a
 * true offset instead.
 */
function inflate(points: [number, number][], distance: number): [number, number][] {
  const n = points.length
  if (n < 3) return points
  const ccw = signedArea(points) >= 0 ? points : ([...points].reverse() as [number, number][])
  const out: [number, number][] = []
  for (let i = 0; i < n; i++) {
    const prev = ccw[(i - 1 + n) % n]
    const cur = ccw[i]
    const next = ccw[(i + 1) % n]
    // Unit edge vectors of the two edges meeting at `cur`.
    const e0x = cur[0] - prev[0]
    const e0y = cur[1] - prev[1]
    const e1x = next[0] - cur[0]
    const e1y = next[1] - cur[1]
    const l0 = Math.hypot(e0x, e0y) || 1
    const l1 = Math.hypot(e1x, e1y) || 1
    // Exterior normals of a CCW polygon point to the right of each edge: (dy, -dx).
    const n0: [number, number] = [e0y / l0, -e0x / l0]
    const n1: [number, number] = [e1y / l1, -e1x / l1]
    const a: [number, number] = [prev[0] + n0[0] * distance, prev[1] + n0[1] * distance]
    const b: [number, number] = [cur[0] + n0[0] * distance, cur[1] + n0[1] * distance]
    const c: [number, number] = [cur[0] + n1[0] * distance, cur[1] + n1[1] * distance]
    const d: [number, number] = [next[0] + n1[0] * distance, next[1] + n1[1] * distance]
    const hit = lineIntersection(a, b, c, d)
    out.push(
      hit ?? [cur[0] + ((n0[0] + n1[0]) / 2) * distance, cur[1] + ((n0[1] + n1[1]) / 2) * distance],
    )
  }
  return out
}

function rectangle(width: number, height: number): [number, number][] {
  const hw = width / 2
  const hh = height / 2
  return [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ]
}

/** Drops consecutive duplicate vertices (within `eps`) — a zero-length edge makes replicad throw. */
function dedupe(points: [number, number][], eps = 1e-6): [number, number][] {
  const out: [number, number][] = []
  for (const point of points) {
    const last = out[out.length - 1]
    if (last && Math.abs(last[0] - point[0]) < eps && Math.abs(last[1] - point[1]) < eps) continue
    out.push(point)
  }
  return out
}

/**
 * Equal/unequal angle outline (x = long leg A, y = short leg B), open corner up-right.
 *
 * An angle is round on **both** corners: the concave **root fillet** `rootRadius` at the inner
 * corner `(t, t)`, and the convex **toe radius** `toeRadius` on the free end of each leg. The
 * toe radius rounds the **inner** corner of the toe — the corner on the same side as the root
 * (the OneSteel 7th Ed figure points R2 there) — while the two **outer** toe corners stay
 * sharp. Either radius may be 0 to keep that corner sharp. The toe arcs' own first points must
 * not be repeated as explicit vertices, so the list is de-duplicated.
 */
function angleL(
  legA: number,
  legB: number,
  thickness: number,
  rootRadius = 0,
  toeRadius = 0,
): [number, number][] {
  const t = thickness
  const r = Math.max(0, Math.min(rootRadius, legA - t, legB - t))
  const rt = Math.max(0, Math.min(toeRadius, t, legA - t, legB - t))
  const points: [number, number][] = [
    [0, 0],
    [legA, 0], // outer corner of the horizontal toe stays sharp
  ]
  // Horizontal leg: round the inner corner of the toe (end face → inner face y = t).
  if (rt > 0) points.push(...arcPoints(legA - rt, t - rt, rt, 0, Math.PI / 2))
  else points.push([legA, t])
  // Inner corner (t, t): root fillet, or a sharp corner.
  if (r > 0) points.push(...arcPoints(t + r, t + r, r, -Math.PI / 2, -Math.PI))
  else points.push([t, t])
  // Vertical leg: round the inner corner of the toe (inner face x = t → end face).
  if (rt > 0) points.push(...arcPoints(t - rt, legB - rt, rt, 0, Math.PI / 2))
  else points.push([t, legB])
  points.push([0, legB]) // outer corner of the vertical toe stays sharp
  return centre(dedupe(points))
}

/**
 * Parallel-flange channel in the **canonical `n` stance** (see `docs/canonical-orientation.md`):
 * web horizontal on top, both flanges pointing straight down, so the C opens **downward** — the
 * head cuts from above and the slag drops out the bottom, clear of the machine. `depth` runs
 * horizontally (x), `flange` vertically (y). Built first in Tekla's web-vertical stance (solid web
 * on the left, C opening right), then rotated 90° so the fillet construction stays in one place.
 * `radius` is the root fillet where the flanges meet the inner web face; 0 keeps those two corners
 * sharp.
 */
function channel(
  depth: number,
  flange: number,
  web: number,
  tf: number,
  radius = 0,
): [number, number][] {
  const hb = flange / 2
  const hd = depth / 2
  const xWeb = -hb + web
  const r = Math.max(0, Math.min(radius, flange - web, hd - tf))
  const webVertical: [number, number][] =
    r <= 0
      ? [
          [-hb, -hd],
          [hb, -hd],
          [hb, -hd + tf],
          [xWeb, -hd + tf],
          [xWeb, hd - tf],
          [hb, hd - tf],
          [hb, hd],
          [-hb, hd],
        ]
      : [
          // Two concave root fillets on the inner web face (arc centres sit in the channel cavity).
          [-hb, -hd],
          [hb, -hd],
          [hb, -hd + tf],
          ...arcPoints(xWeb + r, -hd + tf + r, r, -Math.PI / 2, -Math.PI),
          ...arcPoints(xWeb + r, hd - tf - r, r, Math.PI, Math.PI / 2),
          [hb, hd - tf],
          [hb, hd],
          [-hb, hd],
        ]
  // Rotate 90° CW into the canonical stance (web up, flanges down, C opening downward).
  return centre(webVertical).map(([x, y]) => [y, -x] as [number, number])
}

function circle(od: number): [number, number][] {
  const r = od / 2
  const points: [number, number][] = []
  for (let i = 0; i < 48; i++) {
    const angle = (i / 48) * Math.PI * 2
    points.push([Math.cos(angle) * r, Math.sin(angle) * r])
  }
  return points
}

function reverse(points: [number, number][]): [number, number][] {
  return [...points].reverse()
}

/** Polyline approximation of a circular arc (radians), inclusive of both endpoints. */
function arcPoints(
  cx: number,
  cy: number,
  radius: number,
  start: number,
  end: number,
  steps = 6,
): [number, number][] {
  const points: [number, number][] = []
  for (let i = 0; i <= steps; i++) {
    const angle = start + ((end - start) * i) / steps
    points.push([cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius])
  }
  return points
}

/**
 * Canonical cross-section size for a rectangular hollow (RHS/SHS) from its callout numbers:
 * the longer side becomes `width` (horizontal), the shorter `height` (vertical). The DSTV/Tekla
 * export authors these with the longer side vertical, so the machine stance is a 90° rotation —
 * see `docs/canonical-orientation.md`. A square comes out unchanged.
 */
function hollowCanonicalSize(n: number[]): { width: number; height: number } {
  const a = n[0] ?? 0
  const b = n[1] ?? a
  return { width: Math.max(a, b), height: Math.min(a, b) }
}

/** Rounded rectangle outline (counter-clockwise), radius clamped to the half-size. */
function roundedRect(width: number, height: number, radius: number): [number, number][] {
  const hw = width / 2
  const hh = height / 2
  const r = Math.max(0, Math.min(radius, hw, hh))
  if (r <= 0) {
    return [
      [-hw, -hh],
      [hw, -hh],
      [hw, hh],
      [-hw, hh],
    ]
  }
  const points: [number, number][] = []
  const steps = 6
  const corners: [number, number, number][] = [
    [hw - r, -hh + r, -Math.PI / 2],
    [hw - r, hh - r, 0],
    [-hw + r, hh - r, Math.PI / 2],
    [-hw + r, -hh + r, Math.PI],
  ]
  for (const [cx, cy, start] of corners) {
    for (let i = 0; i <= steps; i++) {
      const angle = start + (i / steps) * (Math.PI / 2)
      points.push([cx + Math.cos(angle) * r, cy + Math.sin(angle) * r])
    }
  }
  return points
}

/** Hollow rectangle: outer grown and void shrunk by `gap` so the part fits inside. */
function hollowRect(
  width: number,
  height: number,
  wall: number,
  radius: number,
  gap: number,
): { points: [number, number][]; holes?: [number, number][][] } {
  const outer = roundedRect(width + 2 * gap, height + 2 * gap, radius + gap)
  const iw = width - 2 * wall - 2 * gap
  const ih = height - 2 * wall - 2 * gap
  if (iw <= 0 || ih <= 0) return { points: outer }
  const hole = reverse(roundedRect(iw, ih, Math.max(0, radius - wall - gap)))
  return { points: outer, holes: [hole] }
}

/**
 * T-section (a UB split lengthwise), flange down, web up. `radius` is the root fillet
 * where the web meets the flange (from the parent UB); 0 keeps the junction sharp.
 */
function teeOutline(
  b: number,
  depth: number,
  tf: number,
  tw: number,
  radius = 0,
): [number, number][] {
  const hb = b / 2
  const hd = depth / 2
  const hw = tw / 2
  const r = Math.max(0, Math.min(radius, hb - hw, hd - tf))
  const points: [number, number][] = [
    [-hb, -hd],
    [hb, -hd],
    [hb, -hd + tf],
  ]
  if (r > 0) {
    // Right root fillet: flange top → web side, concave (centre in the void).
    points.push(...arcPoints(hw + r, -hd + tf + r, r, -Math.PI / 2, -Math.PI))
  } else {
    points.push([hw, -hd + tf])
  }
  points.push([hw, hd], [-hw, hd])
  if (r > 0) {
    // Left root fillet: web side → flange top.
    points.push(...arcPoints(-hw - r, -hd + tf + r, r, 0, -Math.PI / 2))
  } else {
    points.push([-hw, -hd + tf])
  }
  points.push([-hb, -hd + tf])
  return centre(points)
}

/** Full I-section outline (x = width, y = depth) for UB / UC / TFB, with the root fillets. */
function iSectionOutline(section: RolledSection): [number, number][] {
  return ubOutlineFromDims(section.b, section.d, section.tf, section.tw, section.r ?? 0)
}

/**
 * Full I-section from raw dimensions (b, full depth d, tf, tw, root radius). The four web-to-
 * flange junctions carry the concave root fillet `radius`; `radius <= 0` keeps them sharp (as
 * for a TFB, which has no tabulated root radius).
 */
function ubOutlineFromDims(
  b: number,
  d: number,
  tf: number,
  tw: number,
  radius = 0,
): [number, number][] {
  const hb = b / 2
  const hd = d / 2
  const hw = tw / 2
  const r = Math.max(0, Math.min(radius, hb - hw, hd - tf))
  if (r <= 0) {
    return centre([
      [-hb, -hd],
      [hb, -hd],
      [hb, -hd + tf],
      [hw, -hd + tf],
      [hw, hd - tf],
      [hb, hd - tf],
      [hb, hd],
      [-hb, hd],
      [-hb, hd - tf],
      [-hw, hd - tf],
      [-hw, -hd + tf],
      [-hb, -hd + tf],
    ])
  }
  // Root fillets are concave: each arc's centre sits in the void beside/between the flanges.
  return centre([
    [-hb, -hd],
    [hb, -hd],
    [hb, -hd + tf],
    ...arcPoints(hw + r, -hd + tf + r, r, -Math.PI / 2, -Math.PI),
    ...arcPoints(hw + r, hd - tf - r, r, Math.PI, Math.PI / 2),
    [hb, hd - tf],
    [hb, hd],
    [-hb, hd],
    [-hb, hd - tf],
    ...arcPoints(-hw - r, hd - tf - r, r, Math.PI / 2, 0),
    ...arcPoints(-hw - r, -hd + tf + r, r, 0, -Math.PI / 2),
    [-hb, -hd + tf],
  ])
}

function detectFamily(clean: string): Family | null {
  if (/^\d/.test(clean)) {
    if (/UC/.test(clean)) return 'uc'
    if (/TFB/.test(clean)) return 'tfb'
    if (/(?:UB|WB|WC)/.test(clean)) return 'ub'
    if (/(?:PFC|TFC)/.test(clean)) return 'channel'
    return null
  }
  return PREFIXES.find(([pattern]) => pattern.test(clean))?.[1] ?? null
}

/**
 * Resolves an EA/UA angle to its catalogue entry (real rolled thickness + root **and toe**
 * radii) from the callout legs/thickness, or from the NC header dims when the code is short.
 * Returns null when the code is not an angle or no catalogue size matches within tolerance.
 */
function catalogueAngle(clean: string, dims: number[]): RolledAngle | null {
  const family = detectFamily(clean)
  if (family !== 'angle-equal' && family !== 'angle-unequal') return null
  const kind = family === 'angle-equal' ? 'EA' : 'UA'
  const n = numbers(clean)
  let a: number
  let b: number
  let thickness: number
  if (n.length >= 3) {
    a = n[0]
    b = n[1]
    thickness = n[2]
  } else if (dims.length >= 3) {
    a = dims[0]
    b = dims[1] || dims[0]
    thickness = dims[2]
  } else {
    return null
  }
  return getAngle(kind, a, b, thickness) ?? null
}

/** Builds the stock outline for a section code, using NC dimensions where the code is short. */
export function stockOutlineForCode(code: string, dims: number[]): StockOutline | null {
  const clean = code.trim().replace(/\s+/g, '').toUpperCase()
  const family = detectFamily(clean)
  if (!family) return null

  const n = numbers(clean)
  let points: [number, number][] | null = null
  let holes: [number, number][][] = []
  let hollow = false
  let label = `${clean} stock`

  switch (family) {
    case 'tee': {
      if (dims.length >= 4) {
        points = teeOutline(dims[0], dims[1], dims[2], dims[3], dims[4] ?? 0)
      } else {
        const match = inferTee(clean, dims)
        if (match)
          points = teeOutline(
            match.section.b,
            match.section.d / 2,
            match.section.tf,
            match.section.tw,
            match.section.r,
          )
      }
      const match = inferTee(clean, dims)
      if (match) label = `${match.section.designation} tee`
      break
    }
    case 'angle-equal':
    case 'angle-unequal': {
      const angle = catalogueAngle(clean, dims)
      if (angle) {
        points = angleL(angle.a, angle.b, angle.t, angle.r1, angle.r2)
        break
      }
      // Not in the catalogue: fall back to the callout / NC dims, root radius only.
      const legA = n[0] ?? dims[0]
      const legB = family === 'angle-equal' ? legA : (n[1] ?? dims[1] ?? legA)
      const thickness = n[2] ?? dims[2]
      if (legA > 0 && legB > 0 && thickness > 0)
        points = angleL(legA, legB, thickness, dims[4] ?? 0)
      break
    }
    case 'rhs':
    case 'shs': {
      // Canonical stance: longer cross-section side horizontal (see `docs/canonical-orientation.md`).
      const { width, height } = hollowCanonicalSize(n)
      const wall = n[2] ?? dims[2] ?? 0
      const radius = dims[4] ?? 0
      if (height > 0 && width > 0 && wall > 0 && wall < Math.min(height, width) / 2) {
        const rect = hollowRect(width, height, wall, radius, INFLATE)
        points = rect.points
        holes = rect.holes ?? []
        hollow = true
      } else if (height > 0 && width > 0) {
        points = rectangle(width, height)
      }
      break
    }
    case 'chs': {
      const od = n[0]
      const wall = n[1] ?? dims[2] ?? 0
      if (od > 0) {
        points = circle(od + 2 * INFLATE)
        const id = od - 2 * wall - 2 * INFLATE
        if (wall > 0 && id > 0) holes = [reverse(circle(id))]
        hollow = true
      }
      break
    }
    case 'channel': {
      const depth = n[0] || dims[0]
      const flange = n[1] || dims[1] || depth / 2
      // PFCs are fully tabulated (tf, tw, r) — the short callout only carries depth+flange.
      const pfc = /PFC/i.test(clean) ? getPfcByDepth(depth) : undefined
      if (pfc) {
        points = channel(pfc.d, pfc.b, pfc.tw, pfc.tf, pfc.r ?? 0)
        label = `${pfc.designation} stock`
      } else if (depth > 0 && flange > 0) {
        // TFC / unknown channel: thicknesses aren't in the short code, so take the larger of
        // the two NC thicknesses for both so the ghost can't be thinner than the part.
        const thickness = Math.max(dims[2] ?? depth * 0.05, dims[3] ?? depth * 0.08)
        points = channel(depth, flange, thickness, thickness, dims[4] ?? 0)
      }
      break
    }
    case 'ub': {
      const section = getUb(clean)
      if (section) {
        points = iSectionOutline(section)
        label = `${section.designation} stock`
      } else if (dims.length >= 4 && dims[0] > 0 && dims[1] > 0) {
        // Full UB from an NC header (dims = b, full depth, tf, tw).
        points = ubOutlineFromDims(dims[0], dims[1], dims[2], dims[3], dims[4] ?? 0)
      }
      break
    }
    case 'uc': {
      const section = getUc(clean) ?? getUcByDepth(dims[1] ?? n[0] ?? 0)
      if (section) {
        points = iSectionOutline(section)
        label = `${section.designation} stock`
      } else if (dims.length >= 4 && dims[0] > 0 && dims[1] > 0) {
        // Full UC from an NC header (dims = b, full depth, tf, tw).
        points = ubOutlineFromDims(dims[0], dims[1], dims[2], dims[3], dims[4] ?? 0)
      }
      break
    }
    case 'tfb': {
      const section = getTfbByDepth(n[0] || dims[0] || dims[1] || 0)
      if (section) {
        points = iSectionOutline(section)
        label = `${section.designation} stock`
      } else if (dims.length >= 4 && dims[0] > 0 && dims[1] > 0) {
        points = ubOutlineFromDims(dims[0], dims[1], dims[2], dims[3], dims[4] ?? 0)
      }
      break
    }
  }

  if (!points || points.length < 3) return null
  // The stock ghost is drawn at the section's exact size (INFLATE = 0) so it reads to scale.
  return {
    points: hollow ? points : inflate(points, INFLATE),
    holes: holes.length > 0 ? holes : undefined,
    label,
    mass: sectionMassPerMetre(clean, dims) ?? undefined,
  }
}

/**
 * The exact (un-inflated) cross-section for a profile code, for rebuilding a part's solid
 * from its NC. Uses the same builders as the stock ghost, but with no clearance allowance.
 */
export function partSectionForCode(
  code: string,
  dims: number[],
): { points: [number, number][]; holes?: [number, number][][] } | null {
  const clean = code.trim().replace(/\s+/g, '').toUpperCase()
  const family = detectFamily(clean)
  if (!family) return null

  const n = numbers(clean)
  switch (family) {
    case 'tee': {
      if (dims.length >= 4)
        return { points: teeOutline(dims[0], dims[1], dims[2], dims[3], dims[4] ?? 0) }
      const match = inferTee(clean, dims)
      if (match)
        return {
          points: teeOutline(
            match.section.b,
            match.section.d / 2,
            match.section.tf,
            match.section.tw,
            match.section.r,
          ),
        }
      return null
    }
    case 'angle-equal':
    case 'angle-unequal': {
      // Prefer the NC header dims for the real leg sizes/thickness, but take the root **and
      // toe** radii from the catalogue — the NC does not carry the toe radius.
      const angle = catalogueAngle(clean, dims)
      const legA = n[0] ?? dims[0]
      const legB = family === 'angle-equal' ? legA : (n[1] ?? dims[1] ?? legA)
      const thickness = n[2] ?? dims[2] ?? angle?.t
      if (!(legA > 0 && legB > 0 && thickness > 0)) return null
      return {
        points: angleL(legA, legB, thickness, dims[4] ?? angle?.r1 ?? 0, angle?.r2 ?? 0),
      }
    }
    case 'rhs':
    case 'shs': {
      // Canonical stance: the longer cross-section side runs horizontal (see
      // `docs/canonical-orientation.md`), so swap the callout's `long*short` into `width*height`.
      const { width, height } = hollowCanonicalSize(n)
      const wall = n[2] ?? dims[2] ?? 0
      const radius = dims[4] ?? 0
      if (height > 0 && width > 0 && wall > 0 && wall < Math.min(height, width) / 2) {
        const iw = width - 2 * wall
        const ih = height - 2 * wall
        const holes =
          iw > 0 && ih > 0 ? [reverse(roundedRect(iw, ih, Math.max(0, radius - wall)))] : undefined
        return { points: roundedRect(width, height, radius), holes }
      }
      if (height > 0 && width > 0) return { points: rectangle(width, height) }
      return null
    }
    case 'chs': {
      const od = n[0]
      const wall = n[1] ?? dims[2] ?? 0
      if (!(od > 0)) return null
      const id = od - 2 * wall
      return { points: circle(od), holes: wall > 0 && id > 0 ? [reverse(circle(id))] : undefined }
    }
    case 'channel': {
      const depth = n[0] || dims[0]
      const flange = n[1] || dims[1] || depth / 2
      const pfc = /PFC/i.test(clean) ? getPfcByDepth(depth) : undefined
      if (pfc) return { points: channel(pfc.d, pfc.b, pfc.tw, pfc.tf, pfc.r ?? 0) }
      if (!(depth > 0 && flange > 0)) return null
      const tf = dims[2] ?? depth * 0.05
      const web = dims[3] ?? depth * 0.08
      return { points: channel(depth, flange, web, tf, dims[4] ?? 0) }
    }
    case 'ub': {
      const section = getUb(clean)
      if (section) return { points: iSectionOutline(section) }
      if (dims.length >= 4 && dims[0] > 0 && dims[1] > 0)
        return { points: ubOutlineFromDims(dims[0], dims[1], dims[2], dims[3], dims[4] ?? 0) }
      return null
    }
    case 'uc': {
      const section = getUc(clean) ?? getUcByDepth(dims[1] ?? n[0] ?? 0)
      if (section) return { points: iSectionOutline(section) }
      if (dims.length >= 4 && dims[0] > 0 && dims[1] > 0)
        return { points: ubOutlineFromDims(dims[0], dims[1], dims[2], dims[3], dims[4] ?? 0) }
      return null
    }
    case 'tfb': {
      const section = getTfbByDepth(n[0] || dims[0] || dims[1] || 0)
      if (section) return { points: iSectionOutline(section) }
      if (dims.length >= 4 && dims[0] > 0 && dims[1] > 0)
        return { points: ubOutlineFromDims(dims[0], dims[1], dims[2], dims[3], dims[4] ?? 0) }
      return null
    }
  }
}

/** Nominal steel density (kg/m³), per AS/NZS 3679.1 / AS 4100. */
const STEEL_DENSITY = 7850

/** Signed-area magnitude of a closed polygon (shoelace). */
function polygonArea(points: [number, number][]): number {
  let twice = 0
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    twice += points[j][0] * points[i][1] - points[i][0] * points[j][1]
  }
  return Math.abs(twice) / 2
}

/**
 * Nominal mass per metre (kg/m). Tabulated families (UB/UC/PFC/TFB and the EA/UA angle
 * catalogue) use the published unit mass; families whose size + thickness fully define the
 * profile (RHS/SHS/CHS hollows, and any angle not in the catalogue) are integrated from their
 * exact cross-section at 7850 kg/m³ — so the value is right whenever the NC carries the corner
 * radius.
 */
export function sectionMassPerMetre(code: string, dims: number[]): number | null {
  const clean = code.trim().replace(/\s+/g, '').toUpperCase()
  const family = detectFamily(clean)
  if (!family) return null
  const n = numbers(clean)

  if (family === 'angle-equal' || family === 'angle-unequal') {
    const angle = catalogueAngle(clean, dims)
    if (angle) return angle.mass
  }

  switch (family) {
    case 'ub':
      return getUb(clean)?.mass ?? null
    case 'uc':
      return (getUc(clean) ?? getUcByDepth(dims[1] ?? n[0] ?? 0))?.mass ?? null
    case 'channel':
      return /PFC/i.test(clean) ? (getPfcByDepth(n[0] || dims[0] || 0)?.mass ?? null) : null
    case 'tfb':
      return getTfbByDepth(n[0] || dims[0] || dims[1] || 0)?.mass ?? null
    case 'tee': {
      const match = inferTee(clean, dims)
      return match ? match.section.mass / 2 : null
    }
    default: {
      const section = partSectionForCode(clean, dims)
      if (!section) return null
      let area = polygonArea(section.points)
      for (const hole of section.holes ?? []) area -= polygonArea(hole)
      if (!(area > 0)) return null
      return area * STEEL_DENSITY * 1e-6
    }
  }
}

/**
 * Resolves a part's stock outline: the section is read from the drawing PDF when
 * available (preferred), else from the part-list / NC profile code.
 */
export async function resolveStockOutline(
  part: PartRecord,
  pdfBytes: Uint8Array | undefined,
): Promise<StockOutline | null> {
  let code: string | null = null
  if (pdfBytes) {
    try {
      code = findSectionCode(await extractDrawingText(pdfBytes))
    } catch {
      code = null
    }
  }
  code ??= part.expected?.profile.trim() || part.nc?.profile.trim() || null
  if (!code) return null
  return stockOutlineForCode(code, part.nc?.dimensions ?? [])
}
