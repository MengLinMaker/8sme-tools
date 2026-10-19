import type { AnyShape, DrawingPen } from 'replicad'
import type { RolledSection } from '@/lib/sections/types'
import { ensureOc } from './occInit'
import type { RigidTransform } from './seat'

/**
 * Nested-UB STEP generation using the real OpenCASCADE kernel (via `replicad`).
 *
 * Each piece is placed from its **real part STEP** (so holes, curves and mitres survive),
 * oriented along the beam and positioned at its cut location; the two sides are placed
 * independently. The part mark is engraved on the outer face. If a piece has no STEP, a
 * clean T prism is used as a fallback. Output is AP214.
 *
 * The ~23 MB OpenCASCADE WASM is lazy-loaded only when this runs.
 */

/**
 * A profile vertex: a straight `lineTo`, or (when `via` is present) a **true circular arc**
 * to `to`, passing through `via`. Real arcs — not a polyline — keep OpenCASCADE booleans
 * stable when the prism is intersected with the imported part STEPs.
 */
export interface ProfileVertex {
  to: [number, number]
  via?: [number, number]
}

/** A closed cross-section profile: a start point followed by its vertices. */
export interface Profile {
  start: [number, number]
  vertices: ProfileVertex[]
}

/** The arc vertex from `start`→`end` (radians) about `(cx, cy)`; `via` is the mid-angle point. */
function arcVertex(cx: number, cy: number, r: number, start: number, end: number): ProfileVertex {
  const mid = (start + end) / 2
  return {
    to: [cx + Math.cos(end) * r, cy + Math.sin(end) * r],
    via: [cx + Math.cos(mid) * r, cy + Math.sin(mid) * r],
  }
}

/** Draws a profile (true arcs where present) into `pen`, which must be positioned at `start`. */
export function penFromProfile(pen: DrawingPen, profile: Profile): DrawingPen {
  let p = pen
  for (const v of profile.vertices) p = v.via ? p.threePointsArcTo(v.to, v.via) : p.lineTo(v.to)
  return p
}

/** Mirrors a profile about the x-axis (y → −y), e.g. the top half → the bottom half. */
export function mirrorY(profile: Profile): Profile {
  const m = ([x, y]: [number, number]): [number, number] => [x, -y]
  return {
    start: m(profile.start),
    vertices: profile.vertices.map((v) => ({ to: m(v.to), via: v.via ? m(v.via) : undefined })),
  }
}

/**
 * A small outward blow-up (mm) applied to an ideal envelope before booleaning it against a real
 * part STEP. OpenCASCADE can return an empty intersection when the two share a face exactly (the
 * real part's outer faces sit on the nominal profile), which would silently drop a part's holes.
 * Far below any rolling tolerance, so it does not change the manufactured shape.
 */
export const ENVELOPE_EPS = 0.05

/** Grows a profile uniformly about its bounding-box centre by ~`eps` mm outward. */
export function inflateProfile(profile: Profile, eps = ENVELOPE_EPS): Profile {
  const pts = [profile.start, ...profile.vertices.flatMap((v) => (v.via ? [v.to, v.via] : [v.to]))]
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2
  const maxR = Math.max(...pts.map(([x, y]) => Math.hypot(x - cx, y - cy))) || 1
  const k = 1 + eps / maxR
  const t = ([x, y]: [number, number]): [number, number] => [cx + (x - cx) * k, cy + (y - cy) * k]
  return {
    start: t(profile.start),
    vertices: profile.vertices.map((v) => ({ to: t(v.to), via: v.via ? t(v.via) : undefined })),
  }
}

/**
 * Tessellates a profile into a closed point list for the 3-D viewer (which draws polylines).
 * Arcs are sampled as quadratic Béziers through their `via` point — smooth enough to render and
 * to feed orientation detection; the STEP path keeps the exact arcs via {@link penFromProfile}.
 */
export function profileToPoints(profile: Profile, arcSteps = 8): [number, number][] {
  const quad = (
    p0: [number, number],
    p1: [number, number],
    p2: [number, number],
    t: number,
  ): [number, number] => {
    const u = 1 - t
    return [
      u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
      u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1],
    ]
  }
  const points: [number, number][] = [profile.start]
  let cur = profile.start
  for (const v of profile.vertices) {
    if (v.via) {
      const ctrl: [number, number] = [
        2 * v.via[0] - (cur[0] + v.to[0]) / 2,
        2 * v.via[1] - (cur[1] + v.to[1]) / 2,
      ]
      for (let i = 1; i <= arcSteps; i++) points.push(quad(cur, ctrl, v.to, i / arcSteps))
    } else {
      points.push(v.to)
    }
    cur = v.to
  }
  return points
}

/**
 * Fallback upper/lower T profile if a part STEP is unavailable. The root fillet `section.r`
 * (from the parent UB) is modelled where the web meets the flange, so the prism matches the
 * real tee; unknown radii stay sharp.
 */
export function teeProfiles(
  section: RolledSection,
  gap: number,
): { top: Profile; bottom: Profile } {
  const hb = section.b / 2
  const hd = section.d / 2
  const hw = section.tw / 2
  const tf = section.tf
  const hk = gap / 2
  const r = Math.max(0, Math.min(section.r ?? 0, hb - hw, hd - tf - hk))

  let top: Profile
  if (r <= 0) {
    top = {
      start: [-hw, hk],
      vertices: [
        { to: [hw, hk] },
        { to: [hw, hd - tf] },
        { to: [hb, hd - tf] },
        { to: [hb, hd] },
        { to: [-hb, hd] },
        { to: [-hb, hd - tf] },
        { to: [-hw, hd - tf] },
      ],
    }
  } else {
    top = {
      start: [-hw, hk],
      vertices: [
        { to: [hw, hk] },
        { to: [hw, hd - tf - r] },
        // Right root fillet (web → flange underside), concave with its centre in the void.
        arcVertex(hw + r, hd - tf - r, r, Math.PI, Math.PI / 2),
        { to: [hb, hd - tf] },
        { to: [hb, hd] },
        { to: [-hb, hd] },
        { to: [-hb, hd - tf] },
        { to: [-hw - r, hd - tf] },
        // Left root fillet (flange underside → web).
        arcVertex(-hw - r, hd - tf - r, r, Math.PI / 2, 0),
      ],
    }
  }
  return { top, bottom: mirrorY(top) }
}

/** Full UB I-section outline (x = width, y = depth), with the four root fillets. */
export function ubOutline(section: RolledSection): Profile {
  const hb = section.b / 2
  const hd = section.d / 2
  const hw = section.tw / 2
  const tf = section.tf
  const r = Math.max(0, Math.min(section.r ?? 0, hb - hw, hd - tf))
  if (r <= 0) {
    return {
      start: [-hb, -hd],
      vertices: [
        { to: [hb, -hd] },
        { to: [hb, -hd + tf] },
        { to: [hw, -hd + tf] },
        { to: [hw, hd - tf] },
        { to: [hb, hd - tf] },
        { to: [hb, hd] },
        { to: [-hb, hd] },
        { to: [-hb, hd - tf] },
        { to: [-hw, hd - tf] },
        { to: [-hw, -hd + tf] },
        { to: [-hb, -hd + tf] },
      ],
    }
  }
  return {
    start: [-hb, -hd],
    vertices: [
      { to: [hb, -hd] },
      { to: [hb, -hd + tf] },
      { to: [hw + r, -hd + tf] },
      arcVertex(hw + r, -hd + tf + r, r, -Math.PI / 2, -Math.PI),
      { to: [hw, hd - tf - r] },
      arcVertex(hw + r, hd - tf - r, r, Math.PI, Math.PI / 2),
      { to: [hb, hd - tf] },
      { to: [hb, hd] },
      { to: [-hb, hd] },
      { to: [-hb, hd - tf] },
      { to: [-hw - r, hd - tf] },
      arcVertex(-hw - r, hd - tf - r, r, Math.PI / 2, 0),
      { to: [-hw, -hd + tf + r] },
      arcVertex(-hw - r, -hd + tf + r, r, 0, -Math.PI / 2),
      { to: [-hb, -hd + tf] },
    ],
  }
}

export interface BarPiece {
  mark: string
  length: number
  /** the real part STEP bytes; engraved/placed as-is when present */
  bytes?: Uint8Array
}

export interface UbBarStepInput {
  section: RolledSection
  name: string
  left: BarPiece[]
  right: BarPiece[]
  kerf: number
}

export interface UbBarStepOptions {
  /**
   * Throw if two pieces clash (overlap in all three axes). Enabled for the download; the 3D
   * viewer disables it so it can still render a layout that clashes.
   */
  strict?: boolean
}

interface OccStep {
  Interface_Static: {
    SetCVal: (key: string, value: string) => void
    SetIVal: (key: string, value: number) => void
  }
  STEPControl_Writer: new () => {
    Transfer: (shape: unknown, mode: unknown) => void
    Write: (path: string) => void
  }
  STEPControl_AsIs: unknown
  FS: { readFile: (path: string, opts?: unknown) => string | Uint8Array }
}

interface ShapeOps {
  rotate: (angle: number, position?: number[], direction?: number[]) => AnyShape
  translate: (x: number, y: number, z: number) => AnyShape
  cut: (tool: AnyShape) => AnyShape
  boundingBox: { bounds: [number[], number[]] }
}

const ETCH_FONT = 'etch'
let fontReady: Promise<boolean> | null = null

export async function ensureFont(): Promise<boolean> {
  if (!fontReady) {
    fontReady = (async () => {
      try {
        const { loadFont } = await import('replicad')
        const response = await fetch(`${import.meta.env.BASE_URL}fonts/LiberationSans-Regular.ttf`)
        if (!response.ok) return false
        await loadFont(await response.arrayBuffer(), ETCH_FONT)
        return true
      } catch {
        return false
      }
    })()
  }
  return fontReady
}

export async function engrave(
  solid: AnyShape,
  mark: string,
  zStart: number,
  yFace: number,
): Promise<AnyShape> {
  try {
    const { drawText } = await import('replicad')
    const plate = drawText(mark, { fontSize: 8, fontFamily: ETCH_FONT })
      .sketchOnPlane('ZX')
      .extrude(0.4)
      .translate(-4, yFace, zStart)
    return (solid as unknown as ShapeOps).cut(plate)
  } catch {
    return solid
  }
}

/**
 * Aligns a real part's longest axis to Z, centres it on X, seats it at `sideOffset` on Y, and
 * returns the shape (starting at Z=0) with its real along-beam length so callers can pack parts
 * without overlapping.
 */
export async function placeRealPart(
  blob: Blob,
  sideOffset: number,
  flip: boolean,
): Promise<{ shape: AnyShape; length: number }> {
  const { importSTEP } = await import('replicad')
  const imported = await importSTEP(blob)
  const ops = imported as unknown as ShapeOps

  const before = ops.boundingBox.bounds
  const extents = [
    before[1][0] - before[0][0],
    before[1][1] - before[0][1],
    before[1][2] - before[0][2],
  ]
  const longAxis = extents.indexOf(Math.max(...extents))
  let shape = imported
  if (longAxis === 0) shape = ops.rotate(90, [0, 0, 0], [0, 1, 0])
  else if (longAxis === 1) shape = ops.rotate(90, [0, 0, 0], [1, 0, 0])
  // Mirror one side about the length axis so the two T halves face outward.
  if (flip) shape = (shape as unknown as ShapeOps).rotate(180, [0, 0, 0], [0, 0, 1])

  const so = shape as unknown as ShapeOps
  const bounds = so.boundingBox.bounds
  const min = bounds[0]
  const max = bounds[1]
  const cx = (min[0] + max[0]) / 2
  const cy = (min[1] + max[1]) / 2
  const length = max[2] - min[2]
  return { shape: so.translate(-cx, sideOffset - cy, -min[2]), length }
}

/**
 * Writes a shape to STEP (AP214, no assembly) and returns the file text. The writer constructor
 * (re)initialises the STEP interface, so its options are set after it exists.
 */
export async function writeStep(shape: AnyShape, path: string): Promise<string> {
  const { getOC } = await import('replicad')
  const occ = getOC() as unknown as OccStep
  const writer = new occ.STEPControl_Writer()
  occ.Interface_Static.SetCVal('write.step.schema', 'AP214IS')
  occ.Interface_Static.SetIVal('write.step.assembly', 0)
  writer.Transfer((shape as unknown as { wrapped: unknown }).wrapped, occ.STEPControl_AsIs)
  writer.Write(path)
  const content = occ.FS.readFile(path, { encoding: 'utf8' })
  return typeof content === 'string' ? content : new TextDecoder().decode(content)
}

/**
 * Applies a {@link RigidTransform} (as produced by `rigidFromMatrix`) to a shape. OCC exposes no
 * arbitrary-matrix transform, so a rigid transform is a rotation about the origin then a
 * translation — exactly the `T · R` a canonical seat matrix is.
 */
export function applyRigid(shape: AnyShape, rigid: RigidTransform): AnyShape {
  interface TransformOps {
    rotate: (angle: number, position?: number[], direction?: number[]) => TransformOps
    translate: (x: number, y: number, z: number) => TransformOps
  }
  let placed = shape as unknown as TransformOps
  if (Math.abs(rigid.angleDeg) > 1e-9) {
    placed = placed.rotate(rigid.angleDeg, [0, 0, 0], rigid.axis)
  }
  placed = placed.translate(rigid.position[0], rigid.position[1], rigid.position[2])
  return placed as unknown as AnyShape
}

export async function buildUbBarStep(
  input: UbBarStepInput,
  options: UbBarStepOptions = {},
): Promise<string> {
  const strict = options.strict ?? true
  const { section, kerf } = input
  await ensureOc()
  const { draw, compoundShapes } = await import('replicad')
  const hasFont = await ensureFont()

  // Pieces sit only the kerf apart — as close as possible, no extra allowance.
  const gap = Math.max(0, kerf)
  const { top, bottom } = teeProfiles(section, gap)
  const hd = section.d / 2

  const solidAt = (profile: Profile, length: number): AnyShape =>
    penFromProfile(draw(profile.start), profile)
      .close()
      .sketchOnPlane('XY')
      .extrude(length) as AnyShape

  // Pack each side independently and tightly: every piece is butted against the previous one
  // using its REAL measured length (plus the kerf), so there is no wasted space between parts.
  interface Placed {
    mark: string
    min: number[]
    max: number[]
  }
  const solids: AnyShape[] = []
  const placed: Placed[] = []
  const buildSide = async (
    profile: Profile,
    pieces: BarPiece[],
    sideSign: number,
  ): Promise<void> => {
    const sideOffset = sideSign * (section.d / 4)
    const flip = sideSign < 0
    let cursor = 0
    for (const piece of pieces) {
      let solid: AnyShape | null = null
      let actual = piece.length
      if (piece.bytes) {
        try {
          const real = await placeRealPart(
            new Blob([new Uint8Array(piece.bytes)], { type: 'model/step' }),
            sideOffset,
            flip,
          )
          solid = real.shape
          actual = real.length || piece.length
        } catch {
          solid = null
        }
      }
      if (!solid) {
        solid = solidAt(profile, piece.length)
        if (hasFont) solid = await engrave(solid, piece.mark, 4, sideSign > 0 ? hd : -hd)
        actual = piece.length
      } else if (hasFont) {
        const topY = (solid as unknown as ShapeOps).boundingBox.bounds[1][1]
        solid = await engrave(solid, piece.mark, 4, topY)
      }
      const shape = (solid as unknown as ShapeOps).translate(0, 0, cursor)
      solids.push(shape)
      const bounds = (shape as unknown as ShapeOps).boundingBox.bounds
      placed.push({ mark: piece.mark, min: bounds[0], max: bounds[1] })
      cursor += actual + gap
    }
  }
  await buildSide(top, input.left, 1)
  await buildSide(bottom, input.right, -1)

  // Safety net: pieces may touch (0 mm) but must never overlap on the laser. A tiny epsilon
  // absorbs modelling noise so a shared/butted face isn't reported as a clash.
  const clashes: string[] = []
  const tol = 0.01
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i]
      const b = placed[j]
      const overlaps = [0, 1, 2].every(
        (axis) => Math.min(a.max[axis], b.max[axis]) - Math.max(a.min[axis], b.min[axis]) > tol,
      )
      if (overlaps) clashes.push(`${a.mark} ↔ ${b.mark}`)
    }
  }
  if (clashes.length > 0 && strict) {
    throw new Error(`parts clash and cannot be cut: ${clashes.join(', ')}`)
  }

  // No tabs for now — write the pieces as-is (a compound of separate bodies).
  const beam = compoundShapes(solids)
  return writeStep(beam, `nested-${input.name}.stp`)
}

export interface StepBody {
  /** bounding-box size (x, y, z) in mm */
  size: [number, number, number]
  /** bounding-box centre (x, y, z) in mm */
  center: [number, number, number]
}

/**
 * Debug helper: lists each separate solid body in a STEP, so a broken join (a floating tab or an
 * unjoined piece) can be identified by its size and position.
 */
export async function inspectStepBodies(bytes: Uint8Array): Promise<StepBody[]> {
  await ensureOc()
  const { importSTEP, iterTopo, cast } = await import('replicad')
  const shape = await importSTEP(new Blob([new Uint8Array(bytes)], { type: 'model/step' }))
  const wrapped = (shape as unknown as { wrapped: unknown }).wrapped
  const bodies: StepBody[] = []
  for (const solid of iterTopo(wrapped as never, 'solid')) {
    const bounds = (cast(solid) as unknown as ShapeOps).boundingBox.bounds
    const [min, max] = bounds
    bodies.push({
      size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
      center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
    })
  }
  return bodies
}
