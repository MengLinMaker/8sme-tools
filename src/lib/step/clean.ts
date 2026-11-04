import { ensureOc } from './occInit'

/**
 * Removes stray solid bodies from a STEP model, keeping the main (largest) body. Everything else —
 * holes, curves, mitres — is untouched, because the kept solid is re-exported as-is. Blind holes
 * capped by a paper-thin skin (a Tekla export quirk) are punched through. Returns `null` when
 * there is nothing to clean.
 */

export interface CleanResult {
  bytes: Uint8Array
  kept: number
  removed: number
  /** blind holes opened by punching through a thin cap during cleaning */
  opened: number
}

/** Bodies with any bounding-box dimension below this (mm) are treated as floating slivers. */
export const STRAY_MIN_DIM = 1

interface BoundaryShape {
  boundingBox: { bounds: [number[], number[]] }
}

/** A live OCC shape with enumerated solids — what booleans and STEP imports both return. */
export interface LiveSolid {
  solids: BoundaryShape[]
}

function isRealSolid(solid: BoundaryShape): boolean {
  const [min, max] = solid.boundingBox.bounds
  const dims = [max[0] - min[0], max[1] - min[1], max[2] - min[2]]
  return Math.min(...dims) >= STRAY_MIN_DIM
}

/**
 * Strips stray/degenerate solids from an already-built OCC shape (e.g. the NC-fabricated
 * solid, whose booleans can leave floating slivers). Same rule as {@link cleanStep}, but
 * with no STEP export/parse round trip: the common single-body case returns the input
 * untouched, and only a genuine multi-body cleanup rebuilds a compound. Returns the shape
 * to use plus counts, so callers can keep measuring/exporting the returned solid.
 */
export interface StripOptions {
  /**
   * Keep only the single largest solid, dropping every other body. Used when cleaning an imported
   * STEP part: one part is one body, so any extra solid — even a large one (a bolt or fitting from
   * the assembly) — is a stray that the viewer already flags as such.
   */
  mainOnly?: boolean
}

export async function stripStraySolids<T extends LiveSolid>(
  solid: T,
  options: StripOptions = {},
): Promise<{ solid: T; kept: number; removed: number }> {
  const solids = solid.solids ?? []
  if (solids.length <= 1) return { solid, kept: solids.length, removed: 0 }

  let keep: BoundaryShape[]
  if (options.mainOnly) {
    keep = [await largestSolid(solids)]
  } else {
    keep = solids.filter(isRealSolid)
    if (keep.length === 0) {
      // All bodies are degenerate — keep the largest rather than emit an empty shape.
      keep = [await largestSolid(solids)]
    }
  }
  const removed = solids.length - keep.length
  if (removed <= 0) return { solid, kept: keep.length, removed: 0 }

  if (keep.length === 1) return { solid: keep[0] as unknown as T, kept: 1, removed }
  const { compoundShapes } = await import('replicad')
  return { solid: compoundShapes(keep as never) as unknown as T, kept: keep.length, removed }
}

async function largestSolid(solids: BoundaryShape[]): Promise<BoundaryShape> {
  const { measureVolume } = await import('replicad')
  let best = solids[0] as BoundaryShape
  let bestVolume = measureVolume(best as never)
  for (const candidate of solids.slice(1)) {
    const volume = measureVolume(candidate as never)
    if (volume > bestVolume) {
      best = candidate
      bestVolume = volume
    }
  }
  return best
}

/** Cap material thinner than this (mm) is an outer skin; anything thicker is an inner cap. */
export const THIN_SKIN_MAX_MM = 3

type Vec = [number, number, number]

interface CleanEdge {
  geomType: string
  wrapped: unknown
}

interface CleanWire {
  edges: CleanEdge[]
  delete: () => void
}

interface CleanFace {
  geomType: string
  wrapped: unknown
  boundingBox: { bounds: [number[], number[]] }
  clone: () => CleanFace
  outerWire: () => CleanWire
  innerWires: () => CleanWire[]
}

interface CleanableSolid {
  boundingBox: { bounds: [number[], number[]] }
  wrapped: unknown
  faces: CleanFace[]
  solids: unknown[]
  cut: (tool: unknown) => CleanableSolid
}

interface OcLike {
  BRepAdaptor_Curve: new (
    edge: unknown,
  ) => {
    GetType: () => string
    Circle: () => {
      Radius: () => number
      Axis: () => {
        Location: () => { X: () => number; Y: () => number; Z: () => number }
        Direction: () => { X: () => number; Y: () => number; Z: () => number }
      }
    }
    FirstParameter: () => number
    LastParameter: () => number
    Value: (t: number) => { X: () => number; Y: () => number; Z: () => number }
  }
  BRepAdaptor_Surface: new (
    face: unknown,
    restricted: boolean,
  ) => {
    GetType: () => string
    Cylinder: () => {
      Radius: () => number
      Axis: () => {
        Location: () => { X: () => number; Y: () => number; Z: () => number }
        Direction: () => { X: () => number; Y: () => number; Z: () => number }
      }
    }
  }
  GeomAbs_CurveType: { GeomAbs_Circle: string }
  GeomAbs_SurfaceType: { GeomAbs_Cylinder: string }
  BRepTools: { Clean: (shape: unknown, force?: boolean) => void }
  BRepBuilderAPI_Sewing: new (
    tolerance?: number,
    ...flags: boolean[]
  ) => {
    Add: (shape: unknown) => void
    Perform: () => void
    SewedShape: () => unknown
    NbFreeEdges: () => number
    NbMultipleEdges: () => number
  }
  BRepCheck_Analyzer: new (shape: unknown, geomControls?: boolean) => { IsValid: () => boolean }
  BRepAlgoAPI_Cut: new (
    shape: unknown,
    tool: unknown,
  ) => {
    SetFuzzyValue: (value: number) => void
    Build: () => void
    Shape: () => unknown
  }
}

const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const scale = (a: Vec, k: number): Vec => [a[0] * k, a[1] * k, a[2] * k]
const dot = (a: Vec, b: Vec): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const length = (a: Vec): number => Math.hypot(a[0], a[1], a[2])

function pointOf(p: { X: () => number; Y: () => number; Z: () => number }): Vec {
  return [p.X(), p.Y(), p.Z()]
}

function directionOf(d: { X: () => number; Y: () => number; Z: () => number }): Vec {
  return [d.X(), d.Y(), d.Z()]
}

interface CircleInfo {
  radius: number
  center: Vec
  normal: Vec
}

function circleInfo(oc: OcLike, edge: CleanEdge): CircleInfo | null {
  try {
    const curve = new oc.BRepAdaptor_Curve(edge.wrapped)
    if (curve.GetType() !== oc.GeomAbs_CurveType.GeomAbs_Circle) return null
    const circle = curve.Circle()
    const axis = circle.Axis()
    return {
      radius: circle.Radius(),
      center: pointOf(axis.Location()),
      normal: directionOf(axis.Direction()),
    }
  } catch {
    return null
  }
}

interface CylinderInfo {
  radius: number
  axisPoint: Vec
  axisDir: Vec
  axial: [number, number]
}

/** Cylinder radius/axis plus the axial extent of its face (from the boundary edges' endpoints). */
function cylinderInfo(oc: OcLike, face: CleanFace): CylinderInfo | null {
  try {
    const surface = new oc.BRepAdaptor_Surface(face.wrapped, true)
    if (surface.GetType() !== oc.GeomAbs_SurfaceType.GeomAbs_Cylinder) return null
    const cylinder = surface.Cylinder()
    const axis = cylinder.Axis()
    const axisPoint = pointOf(axis.Location())
    const axisDir = directionOf(axis.Direction())
    const ends: number[] = []
    // replicad's `outerWire()`/`innerWires()` delete the face they run on, so clone first.
    const wires = [face.clone().outerWire(), ...face.clone().innerWires()]
    for (const wire of wires) {
      for (const edge of wire.edges) {
        const curve = new oc.BRepAdaptor_Curve(edge.wrapped)
        for (const t of [curve.FirstParameter(), curve.LastParameter()]) {
          const point = pointOf(curve.Value(t))
          ends.push(dot(sub(point, axisPoint), axisDir))
        }
      }
      wire.delete()
    }
    if (ends.length === 0) return null
    return {
      radius: cylinder.Radius(),
      axisPoint,
      axisDir,
      axial: [Math.min(...ends), Math.max(...ends)],
    }
  } catch {
    return null
  }
}

function distanceToAxis(point: Vec, axisPoint: Vec, axisDir: Vec): number {
  const delta = sub(point, axisPoint)
  const along = dot(delta, axisDir)
  return length(sub(delta, scale(axisDir, along)))
}

/**
 * Opens capped holes: find a circular face that caps the end of a matching cylindrical bore, then
 * extrude a cutter outward through that cap. The cutter overruns the cap by a few millimetres, so
 * both a paper-thin Tekla skin and an inner membrane are cleared without touching the rest of the
 * part. Bores with no cap are already through and are left alone.
 */
async function openCappedHoles<T extends CleanableSolid>(
  solid: T,
): Promise<{ solid: T; opened: number }> {
  const { getOC, makeCylinder } = await import('replicad')
  const oc = getOC() as unknown as OcLike
  const [min, max] = solid.boundingBox.bounds
  const corners: Vec[] = []
  for (let i = 0; i < 8; i++) {
    corners.push([
      i & 1 ? (max[0] as number) : (min[0] as number),
      i & 2 ? (max[1] as number) : (min[1] as number),
      i & 4 ? (max[2] as number) : (min[2] as number),
    ])
  }
  const cylinders = solid.faces
    .filter((face) => face.geomType === 'CYLINDRE')
    .map((face) => ({ face, info: cylinderInfo(oc, face) }))
    .filter((entry): entry is { face: CleanFace; info: CylinderInfo } => entry.info != null)

  const tools: unknown[] = []
  const seen = new Set<string>()
  for (const cap of solid.faces) {
    if (cap.geomType !== 'PLANE') continue
    let edges: CleanEdge[]
    try {
      // `outerWire()`/`innerWires()` delete the face they are called on — clone first.
      if (cap.clone().innerWires().length > 0) continue
      edges = cap.clone().outerWire().edges
    } catch {
      continue
    }
    if (edges.length === 0) continue
    // A cap can be a full disk or a half-disk split by a seam/web: the circular edges give the
    // radius/centre, straight seam edges are ignored.
    const circles = edges
      .map((edge) => circleInfo(oc, edge))
      .filter((circle): circle is CircleInfo => circle != null)
    if (circles.length === 0) continue
    const first = circles[0] as CircleInfo
    if (!circles.every((circle) => Math.abs(circle.radius - first.radius) <= 0.05)) {
      continue
    }

    for (const { info } of cylinders) {
      if (Math.abs(info.radius - first.radius) > 0.05) continue
      if (Math.abs(dot(info.axisDir, first.normal)) < 0.999) continue
      if (distanceToAxis(first.center, info.axisPoint, info.axisDir) > 0.05) continue

      const capAxial = dot(sub(first.center, info.axisPoint), info.axisDir)
      const atMin = Math.abs(capAxial - info.axial[0]) <= 0.05
      const atMax = Math.abs(capAxial - info.axial[1]) <= 0.05
      if (!atMin && !atMax) continue

      // Outer thin skins are cut from the cap plane outward (no bore overlap). Inner caps are cut
      // by starting inside the bore and punching through the cap into the cavity.
      const punchDir = atMax ? info.axisDir : scale(info.axisDir, -1)
      const cutterRadius = info.radius
      const skin = Math.max(...corners.map((corner) => dot(sub(corner, first.center), punchDir)))
      const key = `${first.center.map((value) => value.toFixed(2)).join(',')}:${info.radius.toFixed(2)}`
      if (seen.has(key)) continue
      seen.add(key)
      if (skin > 0 && skin <= THIN_SKIN_MAX_MM) {
        // Start below the (often tilted) cap so the cutter fully covers it, and run past the skin.
        const start: Vec = [
          (first.center[0] as number) - (punchDir[0] as number) * 2,
          (first.center[1] as number) - (punchDir[1] as number) * 2,
          (first.center[2] as number) - (punchDir[2] as number) * 2,
        ]
        tools.push(makeCylinder(cutterRadius, skin + 4, start, punchDir))
      } else {
        const start: Vec = [
          (first.center[0] as number) - (punchDir[0] as number) * 5,
          (first.center[1] as number) - (punchDir[1] as number) * 5,
          (first.center[2] as number) - (punchDir[2] as number) * 5,
        ]
        tools.push(makeCylinder(cutterRadius, 10, start, punchDir))
      }
      break
    }
  }

  if (tools.length === 0) return { solid, opened: 0 }
  // A plain cut against the existing bore leaves an invalid solid on Tekla's near-coincident
  // skins, so use a tiny fuzzy tolerance (0.001 mm) — enough to heal the seam, far below any
  // real feature.
  const { cast } = await import('replicad')
  let result = solid
  for (const tool of tools) {
    const builder = new oc.BRepAlgoAPI_Cut(
      (result as unknown as { wrapped: unknown }).wrapped,
      (tool as unknown as { wrapped: unknown }).wrapped,
    )
    builder.SetFuzzyValue(0.001)
    builder.Build()
    result = cast(builder.Shape() as never) as unknown as T
  }
  // Drop any zero-area sliver faces the booleans leave behind.
  oc.BRepTools.Clean((result as unknown as { wrapped: never }).wrapped, true)
  return { solid: result, opened: tools.length }
}

/**
 * Removes the degenerate sliver faces a punch can leave (near-zero-height cylinders, zero-area
 * planar wedges), then re-sews the remaining faces into a solid. Returns `null` when there are no
 * slivers or when the rebuild would not be a single valid solid of the same volume.
 */
async function healSliverFaces<T extends CleanableSolid>(solid: T): Promise<T | null> {
  const { getOC, makeSolid, cast, iterTopo, measureVolume } = await import('replicad')
  const oc = getOC() as unknown as OcLike
  const bad = new Set<number>()
  solid.faces.forEach((face, index) => {
    const [min, max] = face.boundingBox.bounds
    const dims = [
      (max[0] as number) - (min[0] as number),
      (max[1] as number) - (min[1] as number),
      (max[2] as number) - (min[2] as number),
    ].sort((a, b) => a - b)
    // A planar face is zero-thick in its normal direction by definition; test its in-plane width.
    const thin = face.geomType === 'PLANE' ? (dims[1] as number) : (dims[0] as number)
    if (thin < 0.1) bad.add(index)
  })
  if (bad.size === 0) return null

  const keep = solid.faces.filter((_, index) => !bad.has(index))
  const sewing = new oc.BRepBuilderAPI_Sewing(0.01, true, true, true, false)
  for (const face of keep) sewing.Add((face as unknown as { wrapped: unknown }).wrapped)
  sewing.Perform()
  if (sewing.NbFreeEdges() !== 0 || sewing.NbMultipleEdges() !== 0) return null

  try {
    const shells = [...iterTopo(sewing.SewedShape() as never, 'shell')].map((shape) =>
      cast(shape as never),
    )
    if (shells.length !== 1) return null
    const healed = makeSolid(shells as never) as unknown as T
    if (healed.solids.length !== 1) return null
    if (!new oc.BRepCheck_Analyzer(healed.wrapped, true).IsValid()) return null
    const before = measureVolume(solid as never)
    const after = measureVolume(healed as never)
    if (Math.abs(after - before) > Math.max(1, before * 0.01)) return null
    return healed
  } catch {
    return null
  }
}

export async function cleanStep(bytes: Uint8Array): Promise<CleanResult | null> {
  await ensureOc()
  const { importSTEP } = await import('replicad')
  const shape = (await importSTEP(
    new Blob([new Uint8Array(bytes)], { type: 'model/step' }),
  )) as unknown as LiveSolid & {
    delete: () => void
    blobSTEP: () => Blob
  }
  try {
    const stripped = await stripStraySolids(shape, { mainOnly: true })
    const punched = await openCappedHoles(stripped.solid as unknown as CleanableSolid)
    // A fuzzy punch can leave a detached half-cap sliver on a split seam. The part must stay one
    // body, so keep only the main solid again after opening the holes.
    const cleaned =
      punched.opened > 0
        ? await stripStraySolids(punched.solid as unknown as LiveSolid, { mainOnly: true })
        : { solid: punched.solid }
    if (stripped.removed <= 0 && punched.opened <= 0) return null

    let bytesOut = new Uint8Array(
      await (cleaned.solid as unknown as { blobSTEP: () => Blob }).blobSTEP().arrayBuffer(),
    )
    // Re-import before healing: the in-memory boolean result can hold an extra split shell, while
    // the STEP round-trip normalises it to the one shell the rebuild expects.
    if (punched.opened > 0) {
      const healed = await healStepBytes(bytesOut)
      if (healed) bytesOut = new Uint8Array(healed)
    }

    return {
      bytes: bytesOut,
      kept: stripped.kept,
      removed: stripped.removed,
      opened: punched.opened,
    }
  } finally {
    shape.delete()
  }
}

/** Runs {@link healSliverFaces} on a STEP round-trip, returning null when no healing is possible. */
async function healStepBytes(bytes: Uint8Array): Promise<Uint8Array | null> {
  await ensureOc()
  const { importSTEP } = await import('replicad')
  const shape = (await importSTEP(
    new Blob([new Uint8Array(bytes)], { type: 'model/step' }),
  )) as unknown as { solids: CleanableSolid[]; delete: () => void }
  try {
    const solid = shape.solids[0]
    if (!solid) return null
    const healed = await healSliverFaces(solid)
    if (!healed) return null
    const blob = (healed as unknown as { blobSTEP: () => Blob }).blobSTEP()
    return new Uint8Array(await blob.arrayBuffer())
  } finally {
    shape.delete()
  }
}
