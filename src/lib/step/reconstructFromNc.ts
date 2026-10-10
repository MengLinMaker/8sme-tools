import { parseDstv } from '@/lib/parsers/dstv'
import { type NcContour, parseNcGeometry } from '@/lib/parsers/ncGeometry'
import { ensureOc } from './occInit'

/**
 * EXPERIMENTAL / standalone: rebuild a T-profile solid from its DSTV `.nc1`.
 *
 * Kept separate from the nesting/preflight pipeline on purpose — nothing imports this yet.
 * The NC is treated as ground truth (as the docs recommend): the cross-section comes from the
 * `ST` header dims, the outline from the `AK` contours (X along the member, Y within each face),
 * and holes from `BO`. Validated against healthy sibling parts whose real STEP exists: the
 * rebuilt bounding box matches to <0.1 mm and volume to within ~2% (the deficit is the end-arc
 * radii, which are currently drawn as straight edges).
 *
 * Currently only handles profile type `T` (`BT…` sections); returns `null` otherwise.
 */

type Pt = [number, number]

function polygon(pts: Pt[]) {
  let pen = drawPen(pts[0])
  for (let i = 1; i < pts.length; i++) pen = pen.lineTo(pts[i])
  return pen.close()
}

// `draw` is imported lazily (OpenCASCADE WASM); keep a module-local handle set by `ensureOc` caller.
let drawPen: (p: Pt) => ReturnType<typeof import('replicad')['draw']>

function dedupe(pts: Pt[]): Pt[] {
  const out = pts.filter((p, i) => i === 0 || p[0] !== pts[i - 1][0] || p[1] !== pts[i - 1][1])
  if (
    out.length > 1 &&
    out[0][0] === out[out.length - 1][0] &&
    out[0][1] === out[out.length - 1][1]
  )
    out.pop()
  return out
}

/** T cross-section outline in the (width, depth) plane. */
function teeSection(b: number, halfD: number, tf: number, tw: number): Pt[] {
  const hb = b / 2
  const htw = tw / 2
  return [
    [-hb, 0],
    [hb, 0],
    [hb, tf],
    [htw, tf],
    [htw, halfD],
    [-htw, halfD],
    [-htw, tf],
    [-hb, tf],
  ]
}

export async function reconstructStepFromNc(ncText: string): Promise<string | null> {
  const header = parseDstv(ncText).header
  if (header.profileType !== 'T') return null

  await ensureOc()
  const { draw, drawCircle } = await import('replicad')
  drawPen = draw as unknown as typeof drawPen

  const geo = parseNcGeometry(ncText)
  const [b, halfD, tf, tw] = header.dimensions
  const hb = b / 2
  const maxX = Math.max(...geo.contours.flatMap((c) => c.points.map((p) => p[0])))

  let solid = polygon(teeSection(b, halfD, tf, tw))
    .sketchOnPlane('YZ')
    .extrude(maxX + 20) as unknown as SolidOps

  // v-face contour lives in (X, width): intersect away everything outside it (trims length + ends).
  for (const c of geo.contours.filter((c) => c.face === 'v') as NcContour[]) {
    const pts = dedupe(c.points).map(([x, y]) => [x, y - hb] as Pt)
    const prism = polygon(pts)
      .sketchOnPlane('XY')
      .extrude(400)
      .translate(0, 0, -150) as unknown as SolidOps
    solid = solid.intersect(prism)
  }

  // o-face contour lives in (X, depth): the coping / web side. `intersect` trips an OCC
  // boolean error here, so remove the *complement* (bounding rect minus contour) with a cut.
  for (const c of geo.contours.filter((c) => c.face === 'o') as NcContour[]) {
    const pts = dedupe(c.points)
    const minX = Math.min(...pts.map((p) => p[0]))
    const maxXo = Math.max(...pts.map((p) => p[0]))
    const rect = polygon([
      [minX, -1],
      [maxXo, -1],
      [maxXo, halfD + 1],
      [minX, halfD + 1],
    ])
    const notch = (rect as unknown as { cut: (other: unknown) => unknown }).cut(
      polygon(pts),
    ) as ReturnType<typeof polygon>
    const notchSolid = notch
      .sketchOnPlane('XZ')
      .extrude(400)
      .translate(0, -150, 0) as unknown as SolidOps
    solid = solid.cut(notchSolid)
  }

  // Holes on the v (flange) face are drilled through the depth.
  for (const h of geo.holes.filter((h) => h.face === 'v' && h.diameter > 0)) {
    const cyl = drawCircle(h.diameter / 2)
      .translate(h.x, h.y - hb)
      .sketchOnPlane('XY')
      .extrude(600)
      .translate(0, 0, -250) as unknown as SolidOps
    solid = solid.cut(cyl)
  }

  const blob = (solid as unknown as { blobSTEP: () => Blob }).blobSTEP()
  return await blob.text()
}

interface SolidOps {
  intersect: (other: SolidOps) => SolidOps
  cut: (other: SolidOps) => SolidOps
}
