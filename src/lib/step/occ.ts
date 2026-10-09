import type { AnyShape } from 'replicad'
import type { UbSection } from '@/lib/sections/types'
import { ensureOc } from './occInit'

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

/** Fallback upper/lower T profile if a part STEP is unavailable. */
function teeProfiles(
  section: UbSection,
  gap: number,
): { top: [number, number][]; bottom: [number, number][] } {
  const hb = section.b / 2
  const hd = section.d / 2
  const hw = section.tw / 2
  const tf = section.tf
  const hk = gap / 2
  const top: [number, number][] = [
    [-hw, hk],
    [hw, hk],
    [hw, hd - tf],
    [hb, hd - tf],
    [hb, hd],
    [-hb, hd],
    [-hb, hd - tf],
    [-hw, hd - tf],
  ]
  const bottom = top.map(([x, y]) => [x, -y] as [number, number])
  return { top, bottom }
}

/** Full UB I-section outline (x = width, y = depth), root radii omitted. */
export function ubOutline(section: UbSection): [number, number][] {
  const hb = section.b / 2
  const hd = section.d / 2
  const hw = section.tw / 2
  const tf = section.tf
  return [
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
  ]
}

export interface BarPiece {
  mark: string
  length: number
  /** the real part STEP bytes; engraved/placed as-is when present */
  bytes?: Uint8Array
}

export interface UbBarStepInput {
  section: UbSection
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

async function ensureFont(): Promise<boolean> {
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

async function engrave(
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
async function placeRealPart(
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

export async function buildUbBarStep(
  input: UbBarStepInput,
  options: UbBarStepOptions = {},
): Promise<string> {
  const strict = options.strict ?? true
  const { section, kerf } = input
  await ensureOc()
  const { draw, getOC, compoundShapes } = await import('replicad')
  const hasFont = await ensureFont()

  // Pieces sit only the kerf apart — as close as possible, no extra allowance.
  const gap = Math.max(0, kerf)
  const { top, bottom } = teeProfiles(section, gap)
  const hd = section.d / 2

  const solidAt = (profile: [number, number][], length: number): AnyShape => {
    let pen = draw(profile[0])
    for (let i = 1; i < profile.length; i++) pen = pen.lineTo(profile[i])
    return pen.close().sketchOnPlane('XY').extrude(length)
  }

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
    profile: [number, number][],
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

  const occ = getOC() as unknown as OccStep
  // The writer constructor (re)initialises the STEP interface, so set its options after it
  // exists: schema AP214 and no assembly.
  const writer = new occ.STEPControl_Writer()
  occ.Interface_Static.SetCVal('write.step.schema', 'AP214IS')
  occ.Interface_Static.SetIVal('write.step.assembly', 0)
  // No tabs for now — write the pieces as-is (a compound of separate bodies).
  const beam = compoundShapes(solids)
  writer.Transfer((beam as unknown as { wrapped: unknown }).wrapped, occ.STEPControl_AsIs)

  const path = `nested-${input.name}.stp`
  writer.Write(path)
  const content = occ.FS.readFile(path, { encoding: 'utf8' })
  return typeof content === 'string' ? content : new TextDecoder().decode(content)
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
