#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { createServer } from 'vite'

const HELP = `
Repair a STEP solid by re-drilling intended holes into a clean base.

  -b, --base       clean STEP (for example a Tekla export with the broken features removed)
  -f, --features   STEP to harvest the intended hole positions from (the original)
  -o, --output     output STEP (default: <base>.repaired.stp)
      --overrun    cutter overrun past each hole end in mm (default: 5)
      --json       print the report as JSON
  -h, --help

The base supplies clean, valid geometry. Every cylindrical hole found in --features
that is missing from the base is re-cut as a full cylinder, then the shell is healed
(degenerate faces dropped, re-sewn, re-solidified) and validated.
`

const { values } = parseArgs({
  options: {
    base: { type: 'string', short: 'b' },
    features: { type: 'string', short: 'f' },
    output: { type: 'string', short: 'o' },
    overrun: { type: 'string' },
    json: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
})

if (values.help || !values.base || !values.features) {
  process.stdout.write(HELP)
  process.exit(values.help ? 0 : 2)
}

const basePath = resolve(values.base)
const featurePath = resolve(values.features)
const ext = extname(basePath)
const outputPath = values.output
  ? resolve(values.output)
  : join(dirname(basePath), `${basename(basePath, ext)}.repaired${ext || '.stp'}`)
const overrun = values.overrun == null ? 5 : Number(values.overrun)
if (!(Number.isFinite(overrun) && overrun >= 0)) {
  throw new Error(`--overrun must be a non-negative number, got ${values.overrun}`)
}

const server = await createServer({
  configFile: false,
  appType: 'custom',
  logLevel: 'error',
  server: { middlewareMode: true },
  resolve: { alias: { '@': resolve('src') } },
})

const report = { base: basePath, features: featurePath, output: null, ok: false }

try {
  const { setOcWasmUrl, ensureOc } = await server.ssrLoadModule('/src/lib/step/occInit.ts')
  const require = createRequire(join(resolve('.'), 'package.json'))
  setOcWasmUrl(require.resolve('replicad-opencascadejs/wasm'))
  await ensureOc()

  const replicad = await import('replicad')
  const { getOC, importSTEP, measureVolume, makeCylinder, makeSolid, cast, iterTopo } = replicad
  const oc = getOC()

  const load = async (path) => {
    const shape = await importSTEP(
      new Blob([new Uint8Array(await readFile(path))], { type: 'model/step' }),
    )
    return shape
  }
  const mainOf = (shape) => {
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

  const axisOf = (cylinder) => {
    const axis = cylinder.Axis()
    const loc = axis.Location()
    const dir = axis.Direction()
    const d = [dir.X(), dir.Y(), dir.Z()]
    // Canonical direction sign, so the two half-bores group together.
    const first = d.find((component) => Math.abs(component) > 1e-6) ?? 1
    const sign = first < 0 ? -1 : 1
    return {
      point: [loc.X(), loc.Y(), loc.Z()],
      dir: d.map((component) => component * sign),
      sign,
    }
  }
  const projectOnAxis = (point, axisPoint, axisDir) =>
    (point[0] - axisPoint[0]) * axisDir[0] +
    (point[1] - axisPoint[1]) * axisDir[1] +
    (point[2] - axisPoint[2]) * axisDir[2]
  const keyOf = (radius, axis) => {
    // A point on the line: remove the component along the axis, then round.
    const along =
      axis.point[0] * axis.dir[0] + axis.point[1] * axis.dir[1] + axis.point[2] * axis.dir[2]
    const foot = [
      axis.point[0] - axis.dir[0] * along,
      axis.point[1] - axis.dir[1] * along,
      axis.point[2] - axis.dir[2] * along,
    ]
    const round = (value) => value.toFixed(2)
    return `${radius.toFixed(2)}|${axis.dir[0].toFixed(3)},${axis.dir[1].toFixed(3)},${axis.dir[2].toFixed(3)}|${foot.map(round).join(',')}`
  }

  /** Group cylindrical faces into hole specs: radius + axis line + axial span. */
  const holesOf = (solid) => {
    const holes = new Map()
    for (const face of solid.faces ?? []) {
      if (face.geomType !== 'CYLINDRE') continue
      let cylinder
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
      const ends = []
      try {
        const wires = [face.clone().outerWire(), ...face.clone().innerWires()]
        for (const wire of wires) {
          for (const edge of wire.edges) {
            const curve = new oc.BRepAdaptor_Curve(edge.wrapped)
            for (const t of [curve.FirstParameter(), curve.LastParameter()]) {
              const p = curve.Value(t)
              ends.push(projectOnAxis([p.X(), p.Y(), p.Z()], axis.point, axis.dir))
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
        holes.set(key, { key, radius, axis, lo, hi })
      }
    }
    return holes
  }

  const baseShape = await load(basePath)
  const featureShape = await load(featurePath)
  const baseSolid = mainOf(baseShape)
  const featureSolid = mainOf(featureShape)
  const baseHoles = holesOf(baseSolid)
  const featureHoles = [...holesOf(featureSolid).values()]

  const missing = featureHoles.filter((hole) => !baseHoles.has(hole.key))

  const cut = (shape, tool) => {
    const builder = new oc.BRepAlgoAPI_Cut(shape.wrapped, tool.wrapped)
    builder.Build()
    return cast(builder.Shape())
  }

  let solid = baseSolid
  for (const hole of missing) {
    const start = [
      hole.axis.point[0] + hole.axis.dir[0] * (hole.lo - overrun),
      hole.axis.point[1] + hole.axis.dir[1] * (hole.lo - overrun),
      hole.axis.point[2] + hole.axis.dir[2] * (hole.lo - overrun),
    ]
    const height = hole.hi - hole.lo + overrun * 2
    solid = cut(solid, makeCylinder(hole.radius, height, start, hole.axis.dir))
  }

  // Heal: drop degenerate sliver faces, re-sew the rest, re-solidify.
  let healed = null
  try {
    const faces = solid.faces ?? []
    const bad = new Set()
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
        const shells = [...iterTopo(sewing.SewedShape(), 'shell')].map((shape) => cast(shape))
        const candidate = makeSolid(shells)
        if (new oc.BRepCheck_Analyzer(candidate.wrapped, true).IsValid()) healed = candidate
      }
    } else {
      healed = solid
    }
  } catch {
    // fall back to the unhealed cut result
  }

  const result = healed ?? solid
  const valid = new oc.BRepCheck_Analyzer(result.wrapped, true).IsValid()
  const blob = result.blobSTEP()
  await writeFile(outputPath, new Uint8Array(await blob.arrayBuffer()))

  report.ok = valid
  report.output = outputPath
  report.holesInFeatures = featureHoles.length
  report.holesInBase = baseHoles.size
  report.redrilled = missing.length
  report.redrilledSpecs = missing.map((hole) => ({
    radius: Number(hole.radius.toFixed(2)),
    axis: hole.axis.point.map((value) => Number(value.toFixed(1))),
    dir: hole.axis.dir.map((value) => Number(value.toFixed(2))),
    span: [Number(hole.lo.toFixed(1)), Number(hole.hi.toFixed(1))],
  }))
  report.volume = Number(measureVolume(result).toFixed(1))
  report.valid = valid
  report.faces = result.faces?.length ?? null

  baseShape.delete()
  featureShape.delete()
} catch (cause) {
  report.error = cause instanceof Error ? cause.message : String(cause)
  report.ok = false
  process.exitCode = 1
} finally {
  await server.close()
}

if (values.json) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
} else if (report.ok) {
  console.log(
    `${basename(featurePath)} -> ${basename(outputPath)}  ` +
      `re-drilled ${report.redrilled}/${report.holesInFeatures} hole(s)  ` +
      `${report.volume} mm³  ${report.faces ?? '?'} faces  valid`,
  )
} else {
  console.error(
    `${basename(featurePath)} -> ${basename(outputPath)}  FAILED  ${report.error ?? 'result is not a valid solid'}`,
  )
}
