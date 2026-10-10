import type { AnyShape } from 'replicad'
import type { RolledSection } from '@/lib/sections/types'
import {
  engrave,
  ensureFont,
  placeRealPart,
  teeProfiles,
  ubOutline,
  writeStep,
} from './occ'
import { ensureOc } from './occInit'

/**
 * EXPERIMENTAL: model a stock UB as the beam the laser actually cuts.
 *
 * Unlike `buildUbBarStep` (which lays the finished parts out side by side), this keeps the
 * **whole beam together**: the stock UB solid is cut by the real toolpath geometry —
 *   - the lengthwise split (a kerf slot on the web neutral axis),
 *   - each transverse part cut (a kerf slab across the half it belongs to),
 * and every part's real holes / mitres / bevels are carried across by removing the material the
 * real part STEP does not contain. Marks are engraved. Output is one AP214 part.
 *
 * The two halves (top = `left`, bottom = `right`) are cut independently, matching the process
 * rule that the UB stays whole and clamped.
 */

export interface CutBeamPiece {
  mark: string
  /** nominal part length (mm) */
  length: number
  /** the real part STEP bytes (carries holes/curves/mitres when present) */
  bytes?: Uint8Array
}

export interface CutBeamInput {
  section: RolledSection
  name: string
  /** stock beam length (mm) */
  stockLength: number
  /** top-half parts, in cut order (shortest-first is expected from the nest) */
  left: CutBeamPiece[]
  /** bottom-half parts, in cut order */
  right: CutBeamPiece[]
  kerf: number
  /**
   * `local` (default) splits the web only as far as the last part needs, so the scrap keeps the
   * beam whole; `full` splits end-to-end.
   */
  split?: 'local' | 'full'
}

type Ops = {
  translate: (x: number, y: number, z: number) => AnyShape
  cut: (tool: AnyShape) => AnyShape
  intersect: (tool: AnyShape) => AnyShape
  boundingBox: { bounds: [number[], number[]] }
}

interface Slot {
  mark: string
  start: number
  end: number
  length: number
  bytes?: Uint8Array
}

/** Positions each piece along the beam, a kerf gap between neighbours. */
function layout(pieces: CutBeamPiece[], kerf: number): Slot[] {
  const slots: Slot[] = []
  let cursor = 0
  pieces.forEach((piece, index) => {
    if (index > 0) cursor += kerf
    slots.push({
      mark: piece.mark,
      start: cursor,
      end: cursor + piece.length,
      length: piece.length,
      bytes: piece.bytes,
    })
    cursor += piece.length
  })
  return slots
}

export async function buildCutBeamStep(input: CutBeamInput): Promise<string> {
  const { section, kerf } = input
  const splitMode = input.split ?? 'local'
  const k = Math.max(0, kerf)
  const hb = section.b / 2
  const hd = section.d / 2

  await ensureOc()
  const { draw, measureVolume } = await import('replicad')
  const hasFont = await ensureFont()

  const rect = (x0: number, y0: number, x1: number, y1: number): AnyShape => {
    let pen = draw([x0, y0])
    pen = pen.lineTo([x1, y0]).lineTo([x1, y1]).lineTo([x0, y1])
    return pen.close() as unknown as AnyShape
  }

  /** Axis-aligned box spanning [x0..x1] x [y0..y1] x [z0..z1]. */
  const slab = (
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    z0: number,
    z1: number,
  ): AnyShape => {
    const sketch = rect(x0, y0, x1, y1)
    const ops = sketch as unknown as {
      sketchOnPlane: (plane: string) => { extrude: (h: number) => AnyShape }
    }
    const prism = ops.sketchOnPlane('XY').extrude(z1 - z0)
    return (prism as unknown as Ops).translate(0, 0, z0)
  }

  const profilePrism = (profile: [number, number][], length: number, z0: number): AnyShape => {
    let pen = draw(profile[0])
    for (let i = 1; i < profile.length; i++) pen = pen.lineTo(profile[i])
    const sketch = pen.close() as unknown as {
      sketchOnPlane: (plane: string) => { extrude: (h: number) => AnyShape }
    }
    return (sketch.sketchOnPlane('XY').extrude(length) as unknown as Ops).translate(0, 0, z0)
  }

  const left = layout(input.left, k)
  const right = layout(input.right, k)
  const lastEnd = Math.max(0, ...left.map((s) => s.end), ...right.map((s) => s.end))

  // 1. The stock beam: full UB I-section, extruded the whole stock length.
  let beamed = profilePrism(ubOutline(section), input.stockLength, 0) as AnyShape

  const cut = (tool: AnyShape): void => {
    const next = (beamed as unknown as Ops).cut(tool)
    if (next) beamed = next
  }

  // 2. Lengthwise split: a kerf-wide slot on the web neutral axis (only the web is at y≈0).
  const splitEnd = splitMode === 'full' ? input.stockLength : Math.min(input.stockLength, lastEnd + k)
  if (splitEnd > 0) cut(slab(-hb - 2, -k / 2, hb + 2, k / 2, -1, splitEnd))

  // 3. Transverse kerf cuts at each part boundary, across the half the part sits in.
  const gaps = (slots: Slot[], top: boolean): void => {
    for (let i = 0; i < slots.length - 1; i++) {
      const z0 = slots[i].end
      const z1 = z0 + k
      if (z1 <= z0) continue
      const y0 = top ? 0 : -hd - 2
      const y1 = top ? hd + 2 : 0
      cut(slab(-hb - 2, y0, hb + 2, y1, z0, z1))
    }
  }
  gaps(left, true)
  gaps(right, false)

  // 4. Carry each real part's features (holes, mitres, bevels) by removing the ideal material it
  //    does not contain. Skips a piece whose carve would delete the whole slot (a bad import).
  const { top, bottom } = teeProfiles(section, k)
  const carveSide = async (slots: Slot[], topHalf: boolean): Promise<void> => {
    const profile = topHalf ? top : bottom
    const sideOffset = topHalf ? section.d / 4 : -section.d / 4
    for (const slot of slots) {
      if (!slot.bytes) continue
      try {
        const real = await placeRealPart(
          new Blob([new Uint8Array(slot.bytes)], { type: 'model/step' }),
          sideOffset,
          !topHalf,
        )
        const length = real.length || slot.length
        const ideal = profilePrism(profile, length, slot.start)
        const placedReal = (real.shape as unknown as Ops).translate(0, 0, slot.start)
        // Only carve when the real part genuinely sits in the ideal envelope. A corrupted export
        // (a flat sheet, or a mis-oriented body) would fail this and must not delete the slot.
        const realVol = measureVolume(placedReal as never)
        const overlap = (placedReal as unknown as Ops).intersect(ideal)
        const overlapVol = measureVolume(overlap as never)
        if (realVol <= 0 || overlapVol / realVol < 0.5) continue
        cut((ideal as unknown as Ops).cut(placedReal))
      } catch {
        // Leave the clean prism in place when the real geometry can't be used.
      }
    }
  }
  await carveSide(left, true)
  await carveSide(right, false)

  // 5. Engrave the part mark on each piece's outer flange face.
  if (hasFont) {
    for (const slot of left) beamed = await engrave(beamed, slot.mark, slot.start + 4, hd)
    for (const slot of right) beamed = await engrave(beamed, slot.mark, slot.start + 4, -hd)
  }

  return writeStep(beamed, `cut-${input.name}.stp`)
}
