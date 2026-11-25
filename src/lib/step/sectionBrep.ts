import type { Drawing } from 'replicad'
import type { Outline } from '@/lib/sections/outline'

/**
 * A stock contour sketched from its **generated primitives**, so the extruded stock has real
 * rounded corners rather than a faceted approximation.
 *
 * The section builders in `sections/stock.ts` know every corner's centre and radius, so
 * `Outline` carries lines and true arcs (and whole circles) directly — nothing has to be sampled
 * or re-fitted here. An extrusion of this sketch carries one cylindrical brep face per corner,
 * outer outline and inner void alike, which is what WiseCAM's standard-section matcher needs; a
 * chorded/faceted corner makes it read the part as a custom profile. A round contour becomes one
 * cylinder (`drawCircle`), so a CHS is truly round.
 */
export async function sectionSketch(contour: Outline): Promise<Drawing | null> {
  const single = contour.edges.length === 1 ? contour.edges[0] : undefined
  if (single?.kind === 'circle') {
    const { drawCircle } = await import('replicad')
    return drawCircle(single.radius).translate(single.center[0], single.center[1])
  }
  if (contour.edges.length === 0) return null
  const { draw } = await import('replicad')
  let pen = draw(contour.start)
  for (const edge of contour.edges) {
    if (edge.kind === 'line') {
      pen = pen.lineTo(edge.to)
    } else if (edge.kind === 'arc') {
      // Sagitta straight from the swept angle: `r·(1 − cos(sweep/2))`, so no chord is measured.
      // The sign follows replicad's convention — a counter-clockwise sweep bulges left, which is
      // a negative sagitta; the same mapping the NC cut arcs use.
      const sagitta = edge.radius * (1 - Math.cos(Math.abs(edge.sweep) / 2))
      pen = pen.sagittaArcTo(edge.to, edge.sweep > 0 ? -sagitta : sagitta)
    }
  }
  return pen.close()
}
