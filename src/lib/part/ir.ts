import type { NcFace } from '@/lib/parsers/ncGeometry'
import { layoutCenter, type UnrolledLayout } from '@/lib/wisecam/layout'

/**
 * Canonical part IR — the single representation every format converts through.
 *
 * **Coordinates are 2-D unwrapped UV only:** `[station, along]` in mm. `station` is centred on the
 * chart seam (`0` is the seam; the chart runs `-seam/2 … +seam/2`, and may continue beyond for a
 * curve that crosses the seam). `along` is the member axis. There is no face tag on a feature:
 * the chart's layout maps a station back to a DSTV face + across coordinate, so exporters can split
 * per-face NC contours deterministically.
 *
 * A part has one or more **charts**. A chart is one continuous unwrap with its own mapping. The
 * common case is one `front` chart (the NCEP/machinable surface). An open section may need a
 * `rear` chart to preserve NC `h` work that the front net cannot represent.
 *
 * Keep this deliberately small: no provenance, no confidence, no source-specific blobs. Importers
 * canonicalise; exporters re-project.
 */

/** A point on a chart: `[perimeter station, along the member]` in mm, centred on the seam. */
export type UvPoint = [number, number]

/**
 * DSTV welding-preparation fields at one contour vertex: flat numeric pairs
 * `[angle1, distance1, angle2, distance2]` (the same shape the NC carries).
 */
export type UvBevel = number[]

export type ChartRole = 'front' | 'rear' | 'inner'

/** One connected 2-D unwrap and the face mapping that makes it meaningful. */
export interface PartChart {
  /** Stable id within the part (`front`, `rear`, `face:h`, …). */
  id: string
  role: ChartRole
  /** DSTV faces this chart covers — used by exporters to select the NC block face. */
  faces: NcFace[]
  /** Maps `(face, across)` → centred station. */
  layout: UnrolledLayout
  /** Measured STEP face widths (mm), for debug labels; falls back to the spec width. */
  faceWidths?: Partial<Record<NcFace, number>>
}

export type FeatureKind = 'cut' | 'hole' | 'slot' | 'notch'

/** Canonical geometry of a feature, in chart UV coordinates. */
export type FeatureShape =
  | {
      form: 'polyline'
      points: UvPoint[]
      closed: boolean
      /** Per-segment arc radius to the next point (mm; 0 / omitted = straight). */
      radii?: number[]
    }
  | { form: 'circle'; center: UvPoint; radius: number }
  | { form: 'slot'; center: UvPoint; far: UvPoint; radius: number }

/**
 * A cut, hole, slot or notch. `bevels` are aligned with a polyline's points and use the DSTV pair
 * form; they are derived geometry, not source metadata.
 */
export interface PartFeature {
  kind: FeatureKind
  chart: string
  shape: FeatureShape
  bevels?: UvBevel[]
  /** DSTV contour class for a `cut` (default `outer`). */
  contour?: 'outer' | 'inner'
  /** Per-vertex DSTV reference-edge suffixes, aligned with a polyline's points. */
  refs?: (string | null)[]
  /** Per-vertex stock-edge flag: segment i→i+1 is a raw-stock boundary, not a laser cut. */
  stock?: boolean[]
  /** NC-authored on a tube bevel's root line; the view shifts it to the outer skin. */
  rootLine?: boolean
  /** DSTV `BO` fabrication letter (`l`, `g`, `m`, `s`), for hole round-trip. */
  holeType?: string | null
  /** Remaining `BO` numeric fields (slot length/width, depth, …). */
  extra?: number[]
  /** Notch type for `kind: 'notch'` (DSTV `t`/`w`). */
  notch?: 't' | 'w'
}

/** A non-cutting layout mark (`SI` etch text or `PU`/`KO` scribe). */
export interface PartMark {
  kind: 'etch' | 'marking'
  /** DSTV block (`SI` text, `PU`/`KO` scribe), when known. */
  block?: 'SI' | 'PU' | 'KO'
  chart: string
  shape: FeatureShape
  text?: {
    value: string
    height: number
    /** Text rotation in the chart face plane (deg, CCW). */
    angle: number
  }
}

export interface PartIr {
  /** Part mark / identifier. */
  mark: string
  /** Catalogue profile designation, e.g. `PFC380*100`. */
  profile: string
  /** DSTV profile type letter (`I`, `U`, `M`, `T`, `L`, `RO`). */
  profileType: string
  /** Header dimensions (`[depth, flange, tf, tw, r]` / `[w, h, wall, wall, r]`). */
  dimensions: number[]
  /** Outer stock outline in the canonical stance. */
  section: [number, number][]
  /** Inner outline for hollow sections, when present. */
  innerSection?: [number, number][]
  /** Member length (mm). */
  length: number
  /** Job/part quantity. */
  quantity: number
  /** DSTV header metadata that is part identity rather than geometry. */
  grade?: string
  orderId?: string
  charts: PartChart[]
  features: PartFeature[]
  marks: PartMark[]
  /** Developed start/end trim boundaries when the source carries them (NCEP/derived NC). */
  startCut?: UvPoint[]
  endCut?: UvPoint[]
}

/** The chart a feature or mark belongs to. */
export function chartById(part: PartIr, id: string): PartChart | undefined {
  return part.charts.find((chart) => chart.id === id)
}

/**
 * The chart covering a DSTV face, or undefined. A face belongs to exactly one chart, so this is
 * how an exporter recovers the block face from a UV feature.
 */
export function chartForFace(part: PartIr, face: NcFace): PartChart | undefined {
  return part.charts.find((chart) => chart.faces.includes(face))
}

/**
 * WiseCAM's station → canonical IR station. I/U are already centred; a zero-origin `M` net is
 * wrapped to `0…seam`, so recover the raw station nearest the layout centre and subtract it.
 */
export function centredStation(layout: UnrolledLayout, station: number): number {
  if (layout.origin === 'centered') return station
  const center = layoutCenter(layout)
  const seam = layout.seam
  const low = center - seam / 2
  let raw = station
  while (raw < low) raw += seam
  while (raw > low + seam) raw -= seam
  return raw - center
}

/** Canonical IR station → the station WiseCAM writes in an NCEP part SVG. */
export function ncepStation(layout: UnrolledLayout, station: number): number {
  const raw = station + layoutCenter(layout)
  if (layout.origin === 'centered') return raw
  const seam = layout.seam
  return ((raw % seam) + seam) % seam
}
