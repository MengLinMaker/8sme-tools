import type { Drawing } from 'replicad'
import { type Pt, sectionPath } from '@/lib/sections/sectionPath'

/**
 * A stock-section contour sketched with **real** primitives, for a brep that has rounded corners
 * rather than a faceted approximation of them.
 *
 * The section builders in `sections/stock.ts` return a sampled polyline: every rounded corner is
 * ~6 chords. Drawing that polyline straight into an extrusion gives a section made of facets, and
 * WiseCAM then reads the part as a custom profile instead of the standard hollow/UB it is — the
 * same failure the UB root fillets had when they were chorded. `sectionPath` fits each run of
 * co-circular samples and returns one circular arc per corner, so the extrusion carries a single
 * cylindrical face per corner:
 *
 * - outer outline **and** inner void (an RHS/SHS has four rounded corners on each),
 * - a full round contour becomes one cylinder (`drawCircle`), so a CHS is truly round.
 *
 * Returns `null` for a degenerate contour (fewer than three distinct points).
 */
export async function sectionSketch(points: Pt[]): Promise<Drawing | null> {
  const path = sectionPath(points)
  if (!path) return null
  const { draw, drawCircle } = await import('replicad')
  const only = path.segments.length === 1 ? path.segments[0] : undefined
  if (only?.kind === 'circle') {
    return drawCircle(only.radius).translate(only.center[0], only.center[1])
  }
  let pen = draw(path.start)
  for (const segment of path.segments) {
    if (segment.kind === 'arc') pen = pen.sagittaArcTo(segment.to, segment.sagitta)
    else if (segment.kind === 'line') pen = pen.lineTo(segment.to)
  }
  return pen.close()
}
