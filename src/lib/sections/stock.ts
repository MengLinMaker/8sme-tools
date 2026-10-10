import type { PartRecord } from '@/lib/audit/types'
import { extractDrawingText, findSectionCode } from '@/lib/parsers/pdfText'
import { inferTee } from './infer'
import type { UbSection } from './types'
import { getUb } from './ub'

/**
 * Builds the uncut stock cross-section ("ghost") for a part from its section
 * callout. Sections follow Australian short-forms as they appear on the drawings
 * (and identically in the NC header / part list): `EA75*75*6`, `UA100*75*6`,
 * `RHS150*100*9.0`, `SHS100*100*6.0`, `PFC100*50`, `BT100*15`, `200UB29.8`.
 */

export interface StockOutline {
  /** closed cross-section outline in mm, centred on its bounding box */
  points: [number, number][]
  /** inner voids for hollow sections (RHS/SHS/CHS), in mm */
  holes?: [number, number][][]
  /** human label, e.g. "PFC100*50 stock" */
  label: string
}

type Family = 'tee' | 'angle-equal' | 'angle-unequal' | 'rhs' | 'shs' | 'chs' | 'channel' | 'ub'

const PREFIXES: [RegExp, Family][] = [
  [/^BT/, 'tee'],
  [/^EA/, 'angle-equal'],
  [/^UA/, 'angle-unequal'],
  [/^RHS/, 'rhs'],
  [/^SHS/, 'shs'],
  [/^CHS/, 'chs'],
  [/^TFC/, 'channel'],
  [/^PFC/, 'channel'],
  [/^(?:UB|WB|WC)/, 'ub'],
]

/** Outward inflation (mm) so the part visibly sits inside the stock. */
const INFLATE = 1.5

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

function inflate(points: [number, number][], amount: number): [number, number][] {
  let half = 0
  for (const [x, y] of points) half = Math.max(half, Math.abs(x), Math.abs(y))
  if (half <= 0) return points
  const scale = 1 + amount / half
  return points.map(([x, y]) => [x * scale, y * scale] as [number, number])
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

function angleL(legA: number, legB: number, thickness: number): [number, number][] {
  const t = thickness
  return centre([
    [0, 0],
    [legA, 0],
    [legA, t],
    [t, t],
    [t, legB],
    [0, legB],
  ])
}

function channel(depth: number, flange: number, web: number, tf: number): [number, number][] {
  const hb = flange / 2
  const hd = depth / 2
  return centre([
    [-hb, -hd],
    [hb, -hd],
    [hb, -hd + tf],
    [-hb + web, -hd + tf],
    [-hb + web, hd - tf],
    [hb, hd - tf],
    [hb, hd],
    [-hb, hd],
  ])
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

function teeOutline(b: number, depth: number, tf: number, tw: number): [number, number][] {
  const hb = b / 2
  const hd = depth / 2
  const hw = tw / 2
  return centre([
    [-hb, -hd],
    [hb, -hd],
    [hb, -hd + tf],
    [hw, -hd + tf],
    [hw, hd],
    [-hw, hd],
    [-hw, -hd + tf],
    [-hb, -hd + tf],
  ])
}

function ubOutline(section: UbSection): [number, number][] {
  const hb = section.b / 2
  const hd = section.d / 2
  const hw = section.tw / 2
  const tf = section.tf
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

/** Full I-section from raw dimensions (b, full depth d, tf, tw), e.g. an NC header. */
function ubOutlineFromDims(b: number, d: number, tf: number, tw: number): [number, number][] {
  const hb = b / 2
  const hd = d / 2
  const hw = tw / 2
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

function detectFamily(clean: string): Family | null {
  if (/^\d/.test(clean)) {
    if (/(?:UB|WB|WC)/.test(clean)) return 'ub'
    if (/(?:PFC|TFC)/.test(clean)) return 'channel'
    return null
  }
  return PREFIXES.find(([pattern]) => pattern.test(clean))?.[1] ?? null
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
        points = teeOutline(dims[0], dims[1], dims[2], dims[3])
      } else {
        const match = inferTee(clean, dims)
        if (match)
          points = teeOutline(
            match.section.b,
            match.section.d / 2,
            match.section.tf,
            match.section.tw,
          )
      }
      const match = inferTee(clean, dims)
      if (match) label = `${match.section.designation} tee`
      break
    }
    case 'angle-equal':
      if (n.length >= 3) points = angleL(n[0], n[0], n[2])
      break
    case 'angle-unequal':
      if (n.length >= 3) points = angleL(n[0], n[1], n[2])
      break
    case 'rhs':
    case 'shs': {
      const height = n[0]
      const width = n[1] ?? n[0]
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
      if (depth > 0 && flange > 0) {
        // Thicknesses aren't in the short code; take the larger of the two NC
        // thicknesses for both so the ghost can't be thinner than the part.
        const thickness = Math.max(dims[2] ?? depth * 0.05, dims[3] ?? depth * 0.08)
        points = channel(depth, flange, thickness, thickness)
      }
      break
    }
    case 'ub': {
      const section = getUb(clean)
      if (section) {
        points = ubOutline(section)
        label = `${section.designation} stock`
      } else if (dims.length >= 4 && dims[0] > 0 && dims[1] > 0) {
        // Full UB from an NC header (dims = b, full depth, tf, tw).
        points = ubOutlineFromDims(dims[0], dims[1], dims[2], dims[3])
      }
      break
    }
  }

  if (!points || points.length < 3) return null
  // Solid sections are inflated uniformly; hollow ones are already sized so the
  // outer wall clears the part and the void stays inside it.
  return {
    points: hollow ? points : inflate(points, INFLATE),
    holes: holes.length > 0 ? holes : undefined,
    label,
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
