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
