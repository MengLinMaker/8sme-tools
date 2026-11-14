import { arcSamples, type NcFace } from '@/lib/parsers/ncGeometry'
import { centeredStationFor, faceAtCenteredStation } from '@/lib/wisecam/layout'
import type { FeatureShape, PartChart, PartFeature, PartIr, UvPoint } from './ir'

/**
 * Render a PartIR as a layered 2-D SVG — the inspection/view layer, not the canonical model.
 *
 * Layers:
 * - `section` — the cross-section outline (the "prism" shape).
 * - `chart:<id>` — one unrolled net per chart, with cuts, holes and marks.
 *
 * The IR itself stays format-agnostic; this is just a deterministic view so NC/STEP/NCEP
 * conversions can be compared visually.
 */

export interface PartIrSvgOptions {
  /** Extra space (mm) between the section and the first chart, and between charts. */
  gap?: number
  /** Include the section layer (default true). */
  section?: boolean
  /** Fill the container (`width`/`height` 100%) instead of emitting millimetre dimensions. */
  responsive?: boolean
  /** A second IR drawn over the base cuts (e.g. STEP over NC) in orange dashed lines. */
  overlay?: PartIr
  /** Colour overlay segments by distance from the base cuts (IR diff). */
  diff?: boolean
  /** Distance (mm) above which an overlay segment is treated as a difference. */
  diffTolerance?: number
  /** Stroke-width multiplier (e.g. 1/zoom) to keep lines thin as the view zooms. */
  stroke?: number
  /** Colour a cut/hole/slot by the wall thickness of its DSTV face (3D legend palette). */
  colorForFace?: (face: NcFace) => string | undefined
  /**
   * `wisecam` (default) is a 180° rotation (station mirrored, beam up). `flipY` mirrors only
   * across the horizontal axis. `raw` keeps the canonical UV coordinates unchanged.
   */
  orientation?: 'wisecam' | 'flipY' | 'raw'
}

interface Bounds {
  minX: number
  maxX: number
  minY: number
  maxY: number
}

function shapePoints(shape: FeatureShape): UvPoint[] {
  if (shape.form === 'circle') {
    const points: UvPoint[] = []
    for (let i = 0; i <= 24; i++) {
      const angle = (i / 24) * Math.PI * 2
      points.push([
        shape.center[0] + Math.cos(angle) * shape.radius,
        shape.center[1] + Math.sin(angle) * shape.radius,
      ])
    }
    return points
  }
  if (shape.form === 'slot') {
    const dx = shape.far[0] - shape.center[0]
    const dy = shape.far[1] - shape.center[1]
    const base = Math.atan2(dy, dx)
    const points: UvPoint[] = []
    for (let i = 0; i <= 12; i++) {
      const angle = base - Math.PI / 2 + (i / 12) * Math.PI
      points.push([
        shape.far[0] + Math.cos(angle) * shape.radius,
        shape.far[1] + Math.sin(angle) * shape.radius,
      ])
    }
    for (let i = 0; i <= 12; i++) {
      const angle = base + Math.PI / 2 + (i / 12) * Math.PI
      points.push([
        shape.center[0] + Math.cos(angle) * shape.radius,
        shape.center[1] + Math.sin(angle) * shape.radius,
      ])
    }
    return points
  }
  return shape.points
}

/** Expand a polyline's arc radii into a sampled polyline (view-only). */
function sampledPoints(points: UvPoint[], radii?: number[], closed = false): UvPoint[] {
  if (!radii?.some((radius) => radius) || points.length < 2) return points
  const out: UvPoint[] = []
  const count = closed ? points.length : points.length - 1
  for (let index = 0; index < count; index++) {
    const from = points[index] as UvPoint
    const to = points[(index + 1) % points.length] as UvPoint
    const samples = arcSamples(from, to, radii[index] ?? 0)
    for (let step = 0; step < samples.length - 1; step++) out.push(samples[step] as UvPoint)
  }
  if (!closed) out.push(points[points.length - 1] as UvPoint)
  return out
}

const fmt = (value: number): string => value.toFixed(3)
const pointsAttr = (points: UvPoint[]): string =>
  points.map(([x, y]) => `${fmt(x)},${fmt(y)}`).join(' ')

const escapeXml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const STROKE = '#94a3b8'
const HOLE = '#38bdf8'
const MARK = '#fb923c'
const ETCH = '#f5f5f5'
const STOCK_EDGE = '#334155'
/** Grey reference zones (rounded corners / non-machined areas). */
const ZONE_FILL = '#94a3b8'
const ZONE_OPACITY = '0.22'

function chartLayer(
  chart: PartChart,
  part: PartIr,
  offsetY: number,
  stroke: number,
  overlay?: PartIr,
  options: PartIrSvgOptions = {},
): { body: string; clip: string | null; clipId: string } {
  const half = chart.layout.seam / 2
  const elements: string[] = []
  const reference: string[] = []
  const featureFace = (points: UvPoint[]): NcFace | null => {
    for (const [station] of points) {
      const hit = faceAtCenteredStation(chart.layout, station)
      if (hit) return hit.face
    }
    return null
  }
  const faceColor = (face: NcFace | null, fallback: string): string =>
    (face ? options.colorForFace?.(face) : undefined) ?? fallback
  const aligned = (feature: PartFeature, points: UvPoint[]): UvPoint[] => {
    if (!feature.rootLine || feature.shape.form !== 'polyline') return points
    const wall = part.dimensions[2] ?? 0
    if (!(wall > 0)) return points
    const mid = part.length / 2
    return points.map(([station, along], index) => {
      const a = Math.abs(feature.bevels?.[index]?.[0] ?? 0)
      const b = Math.abs(feature.bevels?.[index + 1]?.[0] ?? 0)
      const deg = Math.max(a, b)
      if (deg <= 8) return [station, along] as UvPoint
      const shift = wall * Math.tan((deg * Math.PI) / 180)
      return [station, along + (along < mid ? shift : -shift)] as UvPoint
    })
  }
  const boundaries = new Map<number, number>()
  for (const face of chart.faces) {
    const region = chart.layout.faces[face]
    if (!region) continue
    const width = region.width ?? region.length
    for (const y of [0, width]) {
      const station = centeredStationFor(chart.layout, face, y)
      if (station == null || station < -half - 0.5 || station > half + 0.5) continue
      const key = Math.round(station * 100) / 100
      boundaries.set(key, Math.max(boundaries.get(key) ?? 0, region.radius ?? 0))
    }
  }
  let seamDrawn = false
  for (const [station, radius] of boundaries) {
    if (radius > 0) {
      // A rounded corner is a developed strip, not a line: its unrolled width is r·π/2.
      const width = (Math.PI / 2) * radius
      const atSeam = Math.abs(Math.abs(station) - half) < 0.5
      if (atSeam) {
        if (seamDrawn) continue
        seamDrawn = true
        // The corner straddles the unwrapped seam: show its half on each edge.
        reference.push(
          `<rect x="${fmt(-half)}" y="0" width="${fmt(width / 2)}" height="${fmt(part.length)}" fill="${ZONE_FILL}" fill-opacity="${ZONE_OPACITY}"/>`,
        )
        reference.push(
          `<rect x="${fmt(half - width / 2)}" y="0" width="${fmt(width / 2)}" height="${fmt(part.length)}" fill="${ZONE_FILL}" fill-opacity="${ZONE_OPACITY}"/>`,
        )
        continue
      }
      const x0 = Math.max(-half, station - width / 2)
      const x1 = Math.min(half, station + width / 2)
      if (x1 > x0) {
        reference.push(
          `<rect x="${fmt(x0)}" y="0" width="${fmt(x1 - x0)}" height="${fmt(part.length)}" fill="${ZONE_FILL}" fill-opacity="${ZONE_OPACITY}"/>`,
        )
      }
    } else if (Math.abs(Math.abs(station) - half) >= 0.5) {
      reference.push(
        `<line x1="${fmt(station)}" y1="0" x2="${fmt(station)}" y2="${fmt(part.length)}" stroke="${STOCK_EDGE}" stroke-width="${fmt(stroke * 0.6)}"/>`,
      )
    }
  }
  for (const feature of part.features) {
    if (feature.chart !== chart.id) continue
    const shape = feature.shape
    if (feature.kind === 'hole') {
      if (shape.form !== 'circle') continue
      elements.push(
        `<circle cx="${fmt(shape.center[0])}" cy="${fmt(shape.center[1])}" r="${fmt(shape.radius)}" fill="none" stroke="${faceColor(featureFace([shape.center]), HOLE)}" stroke-width="${fmt(stroke * 1.6)}"/>`,
      )
      continue
    }
    if (feature.kind === 'slot') {
      if (shape.form !== 'slot') continue
      const points = shapePoints(shape)
      // A slot is a closed stadium; a polyline would omit the final straight segment.
      elements.push(
        `<polygon points="${pointsAttr(points)}" fill="none" stroke="${faceColor(featureFace([shape.center, shape.far]), HOLE)}" stroke-width="${fmt(stroke * 1.6)}"/>`,
      )
      continue
    }
    if (feature.kind === 'notch') {
      const points = shapePoints(shape)
      for (const [x, y] of points)
        elements.push(
          `<circle cx="${fmt(x)}" cy="${fmt(y)}" r="0.8" fill="none" stroke="${MARK}" stroke-width="${fmt(stroke * 0.7)}"/>`,
        )
      continue
    }
    if (shape.form !== 'polyline') continue
    const alignedPoints = aligned(feature, shape.points)
    const color = faceColor(featureFace(alignedPoints), STROKE)
    if (feature.stock?.some(Boolean)) {
      const source = alignedPoints
      const segments: { a: UvPoint; b: UvPoint; stock: boolean }[] = []
      const count = shape.closed ? source.length : source.length - 1
      for (let index = 0; index < count; index++) {
        const a = source[index] as UvPoint
        const b = source[(index + 1) % source.length] as UvPoint
        segments.push({ a, b, stock: Boolean(feature.stock[index]) })
      }
      let run: { a: UvPoint; b: UvPoint; stock: boolean }[] = []
      const flush = (): void => {
        if (run.length === 0) return
        const points = [run[0]?.a as UvPoint, ...run.map((segment) => segment.b)]
        if (points.length >= 2)
          elements.push(
            `<polyline points="${pointsAttr(points)}" fill="none" stroke="${run[0]?.stock ? STOCK_EDGE : color}" stroke-width="${fmt(run[0]?.stock ? stroke * 0.7 : stroke)}" stroke-linecap="round"/>`,
          )
        run = []
      }
      for (const segment of segments) {
        if (run.length > 0 && run[0]?.stock !== segment.stock) flush()
        run.push(segment)
      }
      flush()
      continue
    }
    const points = sampledPoints(alignedPoints, shape.radii, shape.closed)
    if (points.length < 2) continue
    const tag = shape.closed ? 'polygon' : 'polyline'
    elements.push(
      `<${tag} points="${pointsAttr(points)}" fill="none" stroke="${color}" stroke-width="${fmt(stroke)}"${shape.closed ? '' : ' stroke-linecap="round"'}/>`,
    )
  }
  for (const mark of part.marks) {
    if (mark.chart !== chart.id) continue
    const color = mark.kind === 'etch' ? ETCH : MARK
    if (mark.text) {
      const [x, y] = mark.shape.form === 'polyline' ? (mark.shape.points[0] ?? [0, 0]) : [0, 0]
      elements.push(
        `<text x="${fmt(x)}" y="${fmt(y)}" fill="${color}" font-size="${Math.max(2, mark.text.height)}" transform="rotate(${fmt(mark.text.angle + ((options.orientation ?? 'wisecam') !== 'raw' ? 180 : 0))} ${fmt(x)} ${fmt(y)})" text-anchor="middle">${escapeXml(mark.text.value)}</text>`,
      )
      continue
    }
    const points = shapePoints(mark.shape)
    if (points.length < 2) continue
    elements.push(
      `<polyline points="${pointsAttr(points)}" fill="none" stroke="${color}" stroke-width="${fmt(stroke)}" stroke-dasharray="4 3"/>`,
    )
  }
  if (overlay) {
    interface BaseSegment {
      a: UvPoint
      b: UvPoint
      /** Unit normal pointing *into the material* (outside a hole, inside an outer cut). */
      nx: number
      ny: number
    }
    const baseSegments: BaseSegment[] = []
    for (const feature of part.features) {
      if (feature.chart !== chart.id) continue
      if (feature.kind !== 'cut' && feature.kind !== 'hole' && feature.kind !== 'slot') continue
      let points: UvPoint[]
      let closed: boolean
      if (feature.kind === 'cut') {
        if (feature.shape.form !== 'polyline') continue
        points = aligned(feature, feature.shape.points)
        closed = feature.shape.closed
      } else {
        points = shapePoints(feature.shape)
        closed = true
      }
      let orientation = 1
      if (closed && points.length >= 3) {
        let twice = 0
        for (let index = 0; index < points.length; index++) {
          const p = points[index] as UvPoint
          const q = points[(index + 1) % points.length] as UvPoint
          twice += p[0] * q[1] - q[0] * p[1]
        }
        orientation = twice >= 0 ? 1 : -1
      }
      // An outer contour's material is its interior; a hole's material is outside the loop.
      const sign =
        feature.kind !== 'cut' || feature.contour === 'inner' ? -orientation : orientation
      const count = closed ? points.length : points.length - 1
      for (let index = 0; index < count; index++) {
        if (feature.stock?.[index]) continue
        const a = points[index] as UvPoint
        const b = points[(index + 1) % points.length] as UvPoint
        const dx = b[0] - a[0]
        const dy = b[1] - a[1]
        const length = Math.hypot(dx, dy) || 1
        baseSegments.push({ a, b, nx: (-dy / length) * sign, ny: (dx / length) * sign })
      }
    }
    const tolerance = options.diffTolerance ?? 2
    const OVER = '#f87171'
    const UNDER = '#60a5fa'
    for (const feature of overlay.features) {
      if (feature.chart !== chart.id || feature.kind !== 'cut') continue
      if (feature.shape.form !== 'polyline') continue
      const points = sampledPoints(feature.shape.points, feature.shape.radii, feature.shape.closed)
      if (points.length < 2) continue
      if (!options.diff) {
        elements.push(
          `<polyline points="${pointsAttr(points)}" fill="none" stroke="${MARK}" stroke-width="${fmt(stroke * 1.2)}" stroke-dasharray="5 4" stroke-linecap="round"/>`,
        )
        continue
      }
      for (let index = 0; index + 1 < points.length; index++) {
        const a = points[index] as UvPoint
        const b = points[index + 1] as UvPoint
        const mid: UvPoint = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
        let best = Number.POSITIVE_INFINITY
        let signed = 0
        for (const segment of baseSegments) {
          const dx = segment.b[0] - segment.a[0]
          const dy = segment.b[1] - segment.a[1]
          const length2 = dx * dx + dy * dy
          let t =
            length2 > 0
              ? ((mid[0] - segment.a[0]) * dx + (mid[1] - segment.a[1]) * dy) / length2
              : 0
          t = Math.max(0, Math.min(1, t))
          const cx = segment.a[0] + t * dx
          const cy = segment.a[1] + t * dy
          const distance = Math.hypot(mid[0] - cx, mid[1] - cy)
          if (distance < best) {
            best = distance
            signed = (mid[0] - cx) * segment.nx + (mid[1] - cy) * segment.ny
          }
        }
        // Only draw actual deviations: red = STEP cuts deeper into material, blue = undercut.
        if (best <= tolerance && Math.abs(signed) <= tolerance) continue
        const color = best > tolerance * 4 || signed <= 0 ? UNDER : OVER
        elements.push(
          `<line x1="${fmt(a[0])}" y1="${fmt(a[1])}" x2="${fmt(b[0])}" y2="${fmt(b[1])}" stroke="${color}" stroke-width="${fmt(stroke * 1.2)}" stroke-linecap="round"/>`,
        )
      }
    }
  }
  // Debug: label every face interval at the top with its measured STEP width (spec fallback).
  const labelSize = Math.max(2, stroke * 6)
  const orientation = options.orientation ?? 'wisecam'
  const labelTop = labelSize * 1.4
  const labelY = orientation === 'raw' ? labelTop : part.length - labelTop
  for (const face of chart.faces) {
    const region = chart.layout.faces[face]
    if (!region) continue
    const width = chart.faceWidths?.[face] ?? region.width ?? region.length
    const station = centeredStationFor(chart.layout, face, (region.width ?? region.length) / 2)
    if (station == null) continue
    const transform =
      orientation === 'wisecam'
        ? `rotate(180 ${fmt(station)} ${fmt(labelY)})`
        : orientation === 'flipY'
          ? `translate(0 ${fmt(2 * labelY)}) scale(1 -1)`
          : ''
    elements.push(
      `<text data-layer="face-width" data-face="${face}" x="${fmt(station)}" y="${fmt(labelY)}" fill="#94a3b8" font-size="${fmt(labelSize)}" text-anchor="middle"${transform ? ` transform="${transform}"` : ''}>${Math.round(width * 10) / 10}</text>`,
    )
  }
  const body = `${elements.join('\n')}`
  const cutBoundary =
    chart.id === 'front' && part.startCut && part.endCut
      ? (() => {
          const start = [...part.startCut].sort((a, b) => a[0] - b[0])
          const end = [...part.endCut].sort((a, b) => a[0] - b[0])
          return pointsAttr([...start, ...end.reverse()])
        })()
      : null
  const clip = cutBoundary
  const background = clip
    ? `<polygon points="${clip}" fill="#0f172a" stroke="none"/>`
    : `<rect x="${fmt(-half)}" y="0" width="${fmt(chart.layout.seam)}" height="${fmt(part.length)}" fill="#0f172a" stroke="#334155" stroke-width="${fmt(stroke * 0.7)}"/>`
  const mode = options.orientation ?? 'wisecam'
  const groupTransform =
    mode === 'wisecam'
      ? `translate(0 ${fmt(offsetY + part.length)}) scale(-1 -1)`
      : mode === 'flipY'
        ? `translate(0 ${fmt(offsetY + part.length)}) scale(1 -1)`
        : `translate(0 ${fmt(offsetY)})`
  const clipId = `clip-${chart.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`
  const backgroundGroup = clip
    ? `<g clip-path="url(#${clipId})">${background}${reference.join('\n')}</g>`
    : `${background}${reference.join('\n')}`
  return {
    body: `<g data-layer="chart:${escapeXml(chart.id)}" transform="${groupTransform}">
${backgroundGroup}
${body}
</g>`,
    clip,
    clipId,
  }
}

/**
 * Render every layer into one deterministic SVG string. Coordinates are millimetres, so callers
 * can fit the `viewBox` to their viewport.
 */
export interface PartIrSvgParts {
  viewBox: string
  body: string
}

export function partIrSvgParts(part: PartIr, options: PartIrSvgOptions = {}): PartIrSvgParts {
  const includeSection = options.section !== false
  const gap = options.gap ?? Math.max(20, part.length * 0.03)
  const bounds: Bounds = {
    minX: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
  }

  const maxSeam = part.charts.reduce((max, chart) => Math.max(max, chart.layout.seam), 0)
  const extent = Math.max(part.length, maxSeam, 1)
  const stroke = Math.max(0.15, extent / 2000) * (options.stroke ?? 1)
  const layers: string[] = []
  const clips: string[] = []
  let cursor = 0
  for (const chart of part.charts) {
    const half = chart.layout.seam / 2
    bounds.minX = Math.min(bounds.minX, -half)
    bounds.maxX = Math.max(bounds.maxX, half)
    bounds.minY = Math.min(bounds.minY, cursor)
    bounds.maxY = Math.max(bounds.maxY, cursor + part.length)
    const layer = chartLayer(chart, part, cursor, stroke, options.overlay, options)
    layers.push(layer.body)
    if (layer.clip)
      clips.push(`<clipPath id="${layer.clipId}"><polygon points="${layer.clip}"/></clipPath>`)
    cursor += part.length + gap
  }

  if (includeSection) {
    const points = part.section as UvPoint[]
    let minX = Number.POSITIVE_INFINITY
    let maxX = Number.NEGATIVE_INFINITY
    let minY = Number.POSITIVE_INFINITY
    let maxY = Number.NEGATIVE_INFINITY
    for (const [x, y] of points) {
      minX = Math.min(minX, x)
      maxX = Math.max(maxX, x)
      minY = Math.min(minY, y)
      maxY = Math.max(maxY, y)
    }
    // Place the section above the first chart, preserving its own aspect.
    const translateY = -maxY - gap
    const sectionRotate =
      (options.orientation ?? 'wisecam') === 'wisecam'
        ? ` translate(${fmt(minX + maxX)} ${fmt(minY + maxY)}) scale(-1 -1)`
        : ''
    layers.push(
      `<g data-layer="section" transform="translate(0 ${fmt(translateY)})"><g transform="${sectionRotate.trim()}"><polygon points="${pointsAttr(points)}" fill="none" stroke="${STROKE}" stroke-width="${fmt(stroke)}"/></g></g>`,
    )
    bounds.minX = Math.min(bounds.minX, minX)
    bounds.maxX = Math.max(bounds.maxX, maxX)
    bounds.minY = Math.min(bounds.minY, minY + translateY)
    bounds.maxY = Math.max(bounds.maxY, maxY + translateY)
  }

  if (!Number.isFinite(bounds.minX)) {
    bounds.minX = 0
    bounds.maxX = 1
    bounds.minY = 0
    bounds.maxY = 1
  }
  const width = Math.max(1, bounds.maxX - bounds.minX)
  const height = Math.max(1, bounds.maxY - bounds.minY)
  return {
    viewBox: `${fmt(bounds.minX)} ${fmt(bounds.minY)} ${fmt(width)} ${fmt(height)}`,
    body: `${clips.length > 0 ? `<defs>${clips.join('')}</defs>` : ''}
${layers.join('\n')}`,
  }
}

export function partIrSvg(part: PartIr, options: PartIrSvgOptions = {}): string {
  const { viewBox, body } = partIrSvgParts(part, options)
  const size = options.responsive
    ? 'width="100%" height="100%"'
    : (() => {
        const [, , width, height] = viewBox.split(' ')
        return `width="${width}" height="${height}"`
      })()
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" ${size}>
${body}
</svg>`
}
