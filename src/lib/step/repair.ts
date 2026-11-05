import { ensureOc } from './occInit'

/**
 * Repairs a corrupt STEP solid by re-drilling intended holes into a clean base.
 *
 * Tekla assembly exports can contain membrane/skin faces and half-bores that make booleans on the
 * original unreliable. The repair decouples the two jobs: the **base** supplies clean geometry
 * (e.g. a re-export with the broken features removed), and the **feature source** (the original)
 * supplies the intended hole specs. Every cylindrical hole present in the feature source but
 * missing from the base is re-cut as a full cylinder, then the shell is healed into one valid
 * solid. Existing, already-clean holes in the base are not touched.
 */

export interface RepairOptions {
  /** Cutter overrun past each hole end (mm). Default 5. */
  overrun?: number
}

export interface RepairResult {
  bytes: Uint8Array
  /** Holes present in the feature source. */
  holesInFeatures: number
  /** Holes already present in the base. */
  holesInBase: number
  /** Holes re-drilled because the base lacked them. */
  redrilled: number
  valid: boolean
  volume: number
  faces: number | null
}

interface HoleSpec {
  key: string
  radius: number
  axisPoint: [number, number, number]
  axisDir: [number, number, number]
  lo: number
  hi: number
}

// biome-ignore lint/suspicious/noExplicitAny: OCC WASM wrappers are untyped here
type Loose = any

const round3 = (value: number): string => value.toFixed(3)
const round2 = (value: number): string => value.toFixed(2)

function axisOf(cylinder: Loose): {
  point: [number, number, number]
  dir: [number, number, number]
} {
  const axis = cylinder.Axis()
  const loc = axis.Location()
  const dir = axis.Direction()
  const d: [number, number, number] = [dir.X(), dir.Y(), dir.Z()]
  const first = d.find((component) => Math.abs(component) > 1e-6) ?? 1
  const sign = first < 0 ? -1 : 1
  return {
    point: [loc.X(), loc.Y(), loc.Z()],
    dir: [d[0] * sign, d[1] * sign, d[2] * sign],
  }
}

function keyOf(
  radius: number,
  axis: { point: [number, number, number]; dir: [number, number, number] },
): string {
  const along =
    axis.point[0] * axis.dir[0] + axis.point[1] * axis.dir[1] + axis.point[2] * axis.dir[2]
  const foot: [number, number, number] = [
    axis.point[0] - axis.dir[0] * along,
    axis.point[1] - axis.dir[1] * along,
    axis.point[2] - axis.dir[2] * along,
  ]
  return `${round2(radius)}|${axis.dir.map(round3).join(',')}|${foot.map(round2).join(',')}`
}

function holesOf(solid: Loose, oc: Loose): Map<string, HoleSpec> {
  const holes = new Map<string, HoleSpec>()
  for (const face of solid.faces ?? []) {
    if (face.geomType !== 'CYLINDRE') continue
    let cylinder: Loose
    try {
      const surface = new oc.BRepAdaptor_Surface(face.wrapped, true)
      if (surface.GetType() !== oc.GeomAbs_SurfaceType.GeomAbs_Cylinder) continue
      cylinder = surface.Cylinder()
    } catch {
      continue
    }
    const radius = cylinder.Radius()
    if (!(radius > 0.5)) continue
    const axis = axisOf(cylinder)
    const key = keyOf(radius, axis)
    const ends: number[] = []
    try {
      const wires = [face.clone().outerWire(), ...face.clone().innerWires()]
      for (const wire of wires) {
        for (const edge of wire.edges) {
          const curve = new oc.BRepAdaptor_Curve(edge.wrapped)
          for (const t of [curve.FirstParameter(), curve.LastParameter()]) {
            const p = curve.Value(t)
            ends.push(
              (p.X() - axis.point[0]) * axis.dir[0] +
                (p.Y() - axis.point[1]) * axis.dir[1] +
                (p.Z() - axis.point[2]) * axis.dir[2],
            )
          }
        }
        wire.delete()
      }
    } catch {
      continue
    }
    if (ends.length === 0) continue
    const lo = Math.min(...ends)
    const hi = Math.max(...ends)
    const existing = holes.get(key)
    if (existing) {
      existing.lo = Math.min(existing.lo, lo)
      existing.hi = Math.max(existing.hi, hi)
    } else {
      holes.set(key, { key, radius, axisPoint: axis.point, axisDir: axis.dir, lo, hi })
    }
  }
  return holes
}

function mainOf(shape: Loose, measureVolume: (shape: Loose) => number): Loose {
  const solids = shape.solids ?? []
  if (solids.length === 0) throw new Error('no solids in STEP')
  let main = solids[0]
  let volume = measureVolume(main)
  for (const solid of solids.slice(1)) {
    const candidate = measureVolume(solid)
    if (candidate > volume) {
      main = solid
      volume = candidate
    }
  }
  return main
}

export async function repairStep(
  baseBytes: Uint8Array,
  featureBytes: Uint8Array,
  options: RepairOptions = {},
): Promise<RepairResult> {
  await ensureOc()
  const replicad = await import('replicad')
  const { getOC, importSTEP, measureVolume, makeCylinder, makeSolid, cast, iterTopo } = replicad
  const oc = getOC() as Loose
  const overrun = options.overrun ?? 5

  const load = (bytes: Uint8Array): Promise<Loose> =>
    importSTEP(new Blob([new Uint8Array(bytes)], { type: 'model/step' })) as Promise<Loose>

  const baseShape = await load(baseBytes)
  const featureShape = await load(featureBytes)
  try {
    const baseSolid = mainOf(baseShape, measureVolume as never)
    const featureSolid = mainOf(featureShape, measureVolume as never)
    const baseHoles = holesOf(baseSolid, oc)
    const featureHoles = [...holesOf(featureSolid, oc).values()]
    const missing = featureHoles.filter((hole) => !baseHoles.has(hole.key))

    let solid = baseSolid
    for (const hole of missing) {
      const start: [number, number, number] = [
        hole.axisPoint[0] + hole.axisDir[0] * (hole.lo - overrun),
        hole.axisPoint[1] + hole.axisDir[1] * (hole.lo - overrun),
        hole.axisPoint[2] + hole.axisDir[2] * (hole.lo - overrun),
      ]
      const height = hole.hi - hole.lo + overrun * 2
      const tool = makeCylinder(hole.radius, height, start, hole.axisDir)
      const builder = new oc.BRepAlgoAPI_Cut(solid.wrapped, tool.wrapped)
      builder.Build()
      solid = cast(builder.Shape())
    }

    // Heal: drop degenerate sliver faces, re-sew, re-solidify.
    let result = solid
    try {
      const faces: Loose[] = solid.faces ?? []
      const bad = new Set<number>()
      faces.forEach((face, index) => {
        const [min, max] = face.boundingBox.bounds
        const dims = [max[0] - min[0], max[1] - min[1], max[2] - min[2]].sort((a, b) => a - b)
        const thin = face.geomType === 'PLANE' ? dims[1] : dims[0]
        if (thin < 0.1) bad.add(index)
      })
      if (bad.size > 0) {
        const keep = faces.filter((_, index) => !bad.has(index))
        const sewing = new oc.BRepBuilderAPI_Sewing(0.01, true, true, true, false)
        for (const face of keep) sewing.Add(face.wrapped)
        sewing.Perform()
        if (sewing.NbFreeEdges() === 0 && sewing.NbMultipleEdges() === 0) {
          const shells = [...iterTopo(sewing.SewedShape(), 'shell')].map((shape: Loose) =>
            cast(shape),
          )
          const candidate = makeSolid(shells as never)
          if (new oc.BRepCheck_Analyzer(candidate.wrapped, true).IsValid()) result = candidate
        }
      }
    } catch {
      // keep the unhealed cut result
    }

    const valid = new oc.BRepCheck_Analyzer(result.wrapped, true).IsValid()
    const blob = result.blobSTEP()
    return {
      bytes: new Uint8Array(await blob.arrayBuffer()),
      holesInFeatures: featureHoles.length,
      holesInBase: baseHoles.size,
      redrilled: missing.length,
      valid,
      volume: measureVolume(result),
      faces: result.faces?.length ?? null,
    }
  } finally {
    baseShape.delete()
    featureShape.delete()
  }
}

/**
 * Builds a clean stock base from a corrupt part STEP by filling holes at the **face level**:
 * remove the hole bores and caps, rebuild the affected planar faces without their small hole
 * wires (keeping large cavity openings), sew, and solidify. This reconstructs the stock + end
 * cuts from the original alone, so the caller can re-drill the intended holes into it.
 */
export async function buildFaceFilledBase(featureBytes: Uint8Array): Promise<Uint8Array | null> {
  await ensureOc()
  const replicad = await import('replicad')
  const { getOC, importSTEP, measureVolume, makeFace, makeSolid, cast, iterTopo } = replicad
  const oc = getOC() as Loose
  const shape = (await importSTEP(
    new Blob([new Uint8Array(featureBytes)], { type: 'model/step' }),
  )) as Loose
  try {
    const main = mainOf(shape, measureVolume as never)
    const faces: Loose[] = main.faces ?? []
    const point = (edge: Loose): [number, number, number] | null => {
      try {
        const p = edge.pointAt(0.5)
        return [p.x, p.y, p.z]
      } catch {
        return null
      }
    }
    const near = (a: number[] | null, b: number[] | null): boolean =>
      Boolean(a && b && Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 0.05)
    const wireMax = (wire: Loose): number => {
      const min = [Infinity, Infinity, Infinity]
      const max = [-Infinity, -Infinity, -Infinity]
      for (const edge of wire.edges) {
        for (const p of [edge.startPoint, edge.endPoint]) {
          const values = [p.x, p.y, p.z]
          for (let k = 0; k < 3; k++) {
            min[k] = Math.min(min[k], values[k])
            max[k] = Math.max(max[k], values[k])
          }
        }
      }
      return Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2])
    }
    const faceArea = (face: Loose): number => {
      const mesh = face.mesh({ tolerance: 0.01 })
      let area = 0
      for (let t = 0; t < mesh.triangles.length; t += 3) {
        const i0 = mesh.triangles[t]
        const i1 = mesh.triangles[t + 1]
        const i2 = mesh.triangles[t + 2]
        const a = [mesh.vertices[i0 * 3], mesh.vertices[i0 * 3 + 1], mesh.vertices[i0 * 3 + 2]]
        const b = [mesh.vertices[i1 * 3], mesh.vertices[i1 * 3 + 1], mesh.vertices[i1 * 3 + 2]]
        const c = [mesh.vertices[i2 * 3], mesh.vertices[i2 * 3 + 1], mesh.vertices[i2 * 3 + 2]]
        const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
        const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
        area +=
          0.5 *
          Math.hypot(
            u[1] * v[2] - u[2] * v[1],
            u[2] * v[0] - u[0] * v[2],
            u[0] * v[1] - u[1] * v[0],
          )
      }
      return area
    }

    // Small circular planar faces are caps over the corrupt/hole ends.
    const capIndices = new Set<number>()
    const capMids: number[][] = []
    for (let i = 0; i < faces.length; i++) {
      const face = faces[i] as Loose
      if (face.geomType !== 'PLANE') continue
      let edges: Loose[]
      try {
        if (face.clone().innerWires().length > 0) continue
        edges = face.clone().outerWire().edges
      } catch {
        continue
      }
      let hasCircle = false
      let ok = true
      for (const edge of edges) {
        try {
          const curve = new oc.BRepAdaptor_Curve(edge.wrapped)
          if (curve.GetType() === oc.GeomAbs_CurveType.GeomAbs_Circle) hasCircle = true
          else if (curve.GetType() !== oc.GeomAbs_CurveType.GeomAbs_Line) ok = false
        } catch {
          ok = false
        }
      }
      if (!hasCircle || !ok || faceArea(face) > 1000) continue
      capIndices.add(i)
      for (const edge of edges) {
        const m = point(edge)
        if (m) capMids.push(m)
      }
    }

    // Small inner wires are hole openings to fill; large ones are cavity openings to keep.
    const holeMids: number[][] = []
    const keepInner = new Map<number, Loose[]>()
    for (let i = 0; i < faces.length; i++) {
      const face = faces[i] as Loose
      if (face.geomType !== 'PLANE' || capIndices.has(i)) continue
      let inners: Loose[]
      try {
        inners = face.clone().innerWires()
      } catch {
        continue
      }
      if (inners.length === 0) continue
      const keep: Loose[] = []
      for (const wire of inners) {
        if (wireMax(wire) > 40) {
          keep.push(wire)
        } else {
          for (const edge of wire.edges) {
            const m = point(edge)
            if (m) holeMids.push(m)
          }
        }
      }
      keepInner.set(i, keep)
    }

    // Cylinders whose edge matches a hole opening or a cap are hole bores.
    const remove = new Set<number>(capIndices)
    for (let i = 0; i < faces.length; i++) {
      const face = faces[i] as Loose
      if (face.geomType !== 'CYLINDRE') continue
      let isBore = false
      try {
        for (const wire of [face.clone().outerWire(), ...face.clone().innerWires()]) {
          for (const edge of wire.edges) {
            const m = point(edge)
            if (m && (holeMids.some((p) => near(p, m)) || capMids.some((p) => near(p, m)))) {
              isBore = true
              break
            }
          }
          if (isBore) break
        }
      } catch {
        // leave it
      }
      if (isBore) remove.add(i)
    }

    const rebuilt = new Map<number, Loose>()
    for (const [index, keep] of keepInner) {
      const face = faces[index] as Loose
      try {
        rebuilt.set(
          index,
          keep.length
            ? makeFace(face.clone().outerWire(), keep)
            : makeFace(face.clone().outerWire()),
        )
      } catch {
        // keep the original face if the rebuild fails
      }
    }

    const kept: Loose[] = []
    faces.forEach((face, index) => {
      if (remove.has(index)) return
      kept.push(rebuilt.get(index) ?? face)
    })
    const sewing = new oc.BRepBuilderAPI_Sewing(0.01, true, true, true, false)
    for (const face of kept) sewing.Add((face as Loose).wrapped)
    sewing.Perform()
    if (sewing.NbFreeEdges() !== 0) return null

    const shells = [...iterTopo(sewing.SewedShape(), 'shell')].map((s: Loose) => cast(s))
    const base = makeSolid(shells as never) as Loose
    if (!new oc.BRepCheck_Analyzer(base.wrapped, true).IsValid()) return null
    const blob = base.blobSTEP()
    return new Uint8Array(await blob.arrayBuffer())
  } catch {
    return null
  } finally {
    shape.delete()
  }
}

/**
 * Whether a clean base preserves the original's non-hole dimensions. The Tekla correction can
 * change an end/step position (e.g. a 80 mm tab becoming 73 mm); we must not re-drill into a base
 * whose outer geometry disagrees with the original. Compares the bounding box and the positions of
 * the end/step planes perpendicular to the member length.
 */
export async function baseMatchesFeatures(
  baseBytes: Uint8Array,
  featureBytes: Uint8Array,
): Promise<boolean> {
  await ensureOc()
  const { importSTEP, measureVolume, getOC } = await import('replicad')
  const oc = getOC() as Loose
  const load = (bytes: Uint8Array): Promise<Loose> =>
    importSTEP(new Blob([new Uint8Array(bytes)], { type: 'model/step' })) as Promise<Loose>
  const baseShape = await load(baseBytes)
  const featureShape = await load(featureBytes)
  try {
    const base = mainOf(baseShape, measureVolume as never)
    const feature = mainOf(featureShape, measureVolume as never)
    const [bmin, bmax] = base.boundingBox.bounds
    const [fmin, fmax] = feature.boundingBox.bounds
    const extents = (min: number[], max: number[]) =>
      [0, 1, 2].map((k) => (max[k] as number) - (min[k] as number))
    const be = extents(bmin, bmax)
    const fe = extents(fmin, fmax)
    for (let k = 0; k < 3; k++) {
      if (Math.abs((be[k] as number) - (fe[k] as number)) > 1) return false
    }
    const lengthAxis = fe.indexOf(Math.max(...fe))
    const planes = (solid: Loose): number[] => {
      const positions: number[] = []
      for (const face of solid.faces ?? []) {
        if (face.geomType !== 'PLANE') continue
        try {
          const surface = new oc.BRepAdaptor_Surface((face as Loose).wrapped, true)
          const normal = surface.Plane().Axis().Direction()
          const n = [normal.X(), normal.Y(), normal.Z()]
          if (Math.abs(n[lengthAxis] as number) < 0.9) continue
          const [min] = (face as Loose).boundingBox.bounds
          positions.push(Math.round((min[lengthAxis] as number) * 10) / 10)
        } catch {
          // skip
        }
      }
      return [...new Set(positions)].sort((a, b) => a - b)
    }
    const bp = planes(base)
    const fp = planes(feature)
    if (bp.length !== fp.length) return false
    return bp.every((value, index) => Math.abs(value - (fp[index] as number)) <= 0.5)
  } catch {
    return false
  } finally {
    baseShape.delete()
    featureShape.delete()
  }
}
