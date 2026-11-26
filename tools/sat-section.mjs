#!/usr/bin/env node
/**
 * Rebuild a straight **section prism** from an ACIS `.sat` as a clean standard-section STEP whose
 * corners are **true circular arcs**.
 *
 * Why: a prism that arrived from a modeller can carry its root fillets as arcs *split into pieces*
 * (a 90° fillet as two 45° faces) or, worse, as chorded polylines. WiseCAM then reads the part as
 * a custom profile instead of a standard section (`sectionBrep.ts` states the same rule for our
 * own output: one cylindrical face per corner). This reads the cross-section the SAT was extruded
 * from, identifies the catalogued section from its measured dims *and* shape, then re-emits the
 * same prism — same length, same planar end cuts — with one exact arc per corner.
 *
 * Scope: one solid, extruded along Z, read at the square end; any number of planar end cuts that
 * rake about X or about Y (a bevel/rake, not a compound mitre). Anything else is refused rather
 * than guessed.
 *
 * Usage:
 *   pnpm sat-section -i "<file.sat>" [-o <file.step>] [--json]
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { createServer } from 'vite'

const require = createRequire(import.meta.url)

const HELP = `
Rebuild a section prism from an ACIS SAT with true circular corner arcs.

Usage:
  pnpm sat-section -i <file.sat> [-o <file.step>] [--json]

  -i, --input     .sat / .acis file (single solid, extruded along Z)
  -o, --output    output .step (default: next to the input, same stem)
      --schema    STEP schema: AP203 (default), AP214IS or AP242DIS
      --json      print the summary as JSON
  -h, --help
`

const { values } = parseArgs({
  options: {
    input: { type: 'string', short: 'i' },
    output: { type: 'string', short: 'o' },
    schema: { type: 'string', default: 'AP203' },
    json: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
})
if (values.help || !values.input) {
  process.stdout.write(HELP)
  process.exit(values.help ? 0 : 2)
}

if (!['AP203', 'AP214IS', 'AP242DIS'].includes(values.schema)) {
  process.stderr.write(`unknown schema ${values.schema} (AP203, AP214IS, AP242DIS)\n`)
  process.exit(2)
}
const input = resolve(values.input)
const output = values.output
  ? resolve(values.output)
  : join(dirname(input), `${basename(input, extname(input))}.step`)

// ---------------------------------------------------------------------------------------------
// ACIS SAT reader
//
// Entity ids are negative in the file; a reference `$41` points at entity `-41`. The records we
// need are `point`, `vertex`, `edge`, `face` (with its `loop`), the curve types and the surface
// types. `$1`-style columns are positional, so a record is parsed by index after the 4-token
// reference header.
// ---------------------------------------------------------------------------------------------

function parseSat(text) {
  const entities = new Map()
  let pending = null
  for (const line of text.split(/\r?\n/)) {
    if (pending) {
      pending.block.push(line)
      if (line.includes('}')) {
        entities.set(pending.id, pending)
        pending = null
      }
      continue
    }
    const m = line.match(/^(-?\d+)\s+([A-Za-z_][\w-]*)\s*(.*)$/)
    if (!m) continue
    const id = Number(m[1])
    const rest = m[3]
    const record = {
      id,
      type: m[2],
      tokens: rest.replace(/#\s*$/, '').trim().split(/\s+/).filter(Boolean),
      block: null,
    }
    if (rest.includes('{') && !rest.includes('}')) {
      record.block = [rest]
      pending = record
    } else {
      entities.set(id, record)
    }
  }
  const byId = (id) => entities.get(id)
  const after = (e) => e.tokens.slice(4)
  const ref = (token) =>
    token && /^\$-?\d+$/.test(token) ? -Math.abs(Number(token.slice(1))) : null
  const nums = (tokens) => tokens.map(Number).filter((n) => Number.isFinite(n))

  const points = new Map()
  const vertices = new Map()
  const edges = []
  const faces = []
  for (const e of entities.values()) {
    const a = after(e)
    if (e.type === 'point') {
      points.set(e.id, [Number(a[0]), Number(a[1]), Number(a[2])])
    } else if (e.type === 'vertex') {
      vertices.set(e.id, ref(a[a.length - 1]))
    } else if (e.type === 'edge') {
      edges.push({ id: e.id, v: [ref(a[0]), ref(a[2])], curve: ref(a[5]) })
    } else if (e.type === 'face') {
      faces.push({ id: e.id, surface: ref(a[4]) })
    }
  }

  const surface = (id) => {
    const e = byId(id)
    if (!e) return { type: 'unknown' }
    const n = nums(after(e))
    if (e.type === 'plane-surface')
      return { type: 'plane', origin: n.slice(0, 3), normal: n.slice(3, 6) }
    if (e.type === 'cone-surface')
      return { type: 'cone', center: n.slice(0, 3), axis: n.slice(3, 6) }
    return { type: e.type }
  }

  const curve = (id) => {
    const e = byId(id)
    if (!e) return { type: 'unknown' }
    const a = after(e)
    if (e.type === 'straight-curve') {
      const n = nums(a)
      return { type: 'line', origin: n.slice(0, 3), dir: n.slice(3, 6) }
    }
    if (e.type === 'ellipse-curve') {
      const n = nums(a)
      const major = n.slice(6, 9)
      return {
        type: 'circle',
        center: n.slice(0, 3),
        normal: n.slice(3, 6),
        radius: Math.hypot(...major),
        ratio: n[9],
      }
    }
    return { type: e.type }
  }

  return {
    points,
    vertices,
    edges,
    faces,
    surface,
    curve,
    pointOfEdge: (edge) => edge.v.map((v) => points.get(vertices.get(v))),
  }
}

/** Edges lying in the plane `z = z0`, i.e. the cross-section at that end. */
function sectionEdges(sat, z0, tol = 1e-6) {
  const out = []
  for (const edge of sat.edges) {
    const [p1, p2] = sat.pointOfEdge(edge)
    if (!p1 || !p2) continue
    if (Math.abs(p1[2] - z0) > tol || Math.abs(p2[2] - z0) > tol) continue
    out.push({ ...sat.curve(edge.curve), p1, p2 })
  }
  return out
}

/** Links the section edges into one closed loop by matching endpoints. */
function orderLoop(edges) {
  const key = (p) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`
  const left = [...edges]
  const loop = [left.shift()]
  let guard = 0
  while (left.length && guard++ < edges.length + 2) {
    const end = key(loop[loop.length - 1].p2)
    const i = left.findIndex((e) => key(e.p1) === end || key(e.p2) === end)
    if (i < 0) throw new Error(`cross-section is not a single closed loop (break at ${end})`)
    const next = left.splice(i, 1)[0]
    if (key(next.p2) === end) [next.p1, next.p2] = [next.p2, next.p1]
    loop.push(next)
  }
  if (left.length) throw new Error('cross-section has more than one loop')
  if (key(loop[loop.length - 1].p2) !== key(loop[0].p1)) {
    throw new Error('cross-section loop does not close')
  }
  return loop
}

/** Samples a loop to a polyline (arcs at `steps` each) for shape matching. */
function sampleLoop(loop, steps = 16) {
  const points = [loop[0].p1.slice(0, 2)]
  for (const edge of loop) {
    if (edge.type === 'circle') {
      const a0 = Math.atan2(edge.p1[1] - edge.center[1], edge.p1[0] - edge.center[0])
      const a1 = Math.atan2(edge.p2[1] - edge.center[1], edge.p2[0] - edge.center[0])
      let sweep = a1 - a0
      while (sweep <= 1e-9) sweep += Math.PI * 2
      for (let i = 1; i <= steps; i++) {
        const a = a0 + (sweep * i) / steps
        points.push([
          edge.center[0] + Math.cos(a) * edge.radius,
          edge.center[1] + Math.sin(a) * edge.radius,
        ])
      }
    } else {
      points.push(edge.p2.slice(0, 2))
    }
  }
  return points
}

/**
 * The fillet centres name the section: a root fillet sits `tw/2 + r` off the web axis and
 * `d/2 − tf − r` off the depth axis, which are far apart, so the pair says which bbox axis is
 * the **depth** (web) and which is the width, even on a square section.
 */
function measureSection(loop) {
  const pts = loop.flatMap((e) => [e.p1, e.p2])
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  const centre = [(minX + maxX) / 2, (minY + maxY) / 2]

  const circles = loop.filter((e) => e.type === 'circle')
  if (circles.length === 0) throw new Error('cross-section has no circular corners to read')
  const r = circles.reduce((s, e) => s + e.radius, 0) / circles.length
  const worstRadius = Math.max(...circles.map((e) => Math.abs(e.radius - r)))
  const cx = Math.max(...circles.map((e) => Math.abs(e.center[0] - centre[0])))
  const cy = Math.max(...circles.map((e) => Math.abs(e.center[1] - centre[1])))

  const webAlongY = cx < cy // fillets sit near the web axis → the web runs along y
  const width = maxX - minX
  const depth = maxY - minY
  const tw = 2 * ((webAlongY ? cx : cy) - r)
  const tf = (webAlongY ? depth : width) / 2 - (webAlongY ? cy : cx) - r

  return {
    minX,
    maxX,
    minY,
    maxY,
    width,
    depth,
    /** true when the web runs along y, i.e. the depth is the y extent */
    webAlongY,
    d: webAlongY ? depth : width,
    b: webAlongY ? width : depth,
    tw,
    tf,
    r,
    worstRadius,
    corners: circles.length,
  }
}

/**
 * Planar faces that are not square to the member axis: the end cuts (bevels/rakes). A face belongs
 * to an end when its plane crosses the member between the two ends, tested at the section centre so
 * a plane written with an origin outside the solid is still found.
 */
function endCuts(sat, centre2d, zMin, zMax) {
  const cuts = []
  const seen = new Set()
  for (const face of sat.faces) {
    const s = sat.surface(face.surface)
    if (s.type !== 'plane') continue
    const [nx, ny, nz] = s.normal
    const len = Math.hypot(nx, ny, nz)
    if (Math.abs(nz / len) < 0.02) continue // parallel to the member: a side face
    if (Math.abs(nz / len) > 0.999) continue // square to the member: a square end
    const normal = [nx / len, ny / len, nz / len]
    const z =
      s.origin[2] -
      (normal[0] * (centre2d[0] - s.origin[0]) + normal[1] * (centre2d[1] - s.origin[1])) /
        normal[2]
    if (z < zMin - 1 || z > zMax + 1) continue
    const key = `${normal.map((v) => v.toFixed(5))}|${z.toFixed(3)}`
    if (seen.has(key)) continue
    seen.add(key)
    cuts.push({ origin: s.origin, normal })
  }
  return cuts
}

// ---------------------------------------------------------------------------------------------

async function main() {
  const text = await readFile(input, 'utf8')
  if (!/ACIS/.test(text.slice(0, 500))) {
    throw new Error(`${basename(input)} does not look like an ACIS SAT file`)
  }

  const sat = parseSat(text)
  const allZ = [...sat.points.values()].map((p) => p[2])
  const zMin = Math.min(...allZ)
  const zMax = Math.max(...allZ)
  /** Length along the member axis. */
  const length = zMax - zMin

  // Read the section at a square end (a slanted end has no planar loop at its extreme z).
  const end = [zMin, zMax].find((z) => sectionEdges(sat, z).length >= 3)
  if (end === undefined) throw new Error('no square end to read the cross-section from')
  const loop = orderLoop(sectionEdges(sat, end))
  const measured = measureSection(loop)
  const cuts = endCuts(
    sat,
    [(measured.minX + measured.maxX) / 2, (measured.minY + measured.maxY) / 2],
    zMin,
    zMax,
  )

  const server = await createServer({
    configFile: false,
    appType: 'custom',
    logLevel: 'error',
    server: { middlewareMode: true },
    resolve: { alias: { '@': resolve('src') } },
  })

  try {
    const { ensureOc, setOcWasmUrl } = await server.ssrLoadModule('/src/lib/step/occInit.ts')
    setOcWasmUrl(require.resolve('replicad-opencascadejs/wasm'))
    await ensureOc()

    const { inferSectionFromCross } = await server.ssrLoadModule('/src/lib/sections/detect.ts')
    const { stockOutlineForCode } = await server.ssrLoadModule('/src/lib/sections/stock.ts')
    const { outline, outlinePoints, rotateOutline, translateOutline } = await server.ssrLoadModule(
      '/src/lib/sections/outline.ts',
    )
    const { sectionSketch } = await server.ssrLoadModule('/src/lib/step/sectionBrep.ts')
    const { writeStep } = await server.ssrLoadModule('/src/lib/step/occ.ts')
    const { measureStep } = await server.ssrLoadModule('/src/lib/step/measure.ts')
    const { detectStepSection } = await server.ssrLoadModule('/src/lib/step/readSection.ts')

    // 1. Which catalogued section is this?
    const guess = inferSectionFromCross({ outer: sampleLoop(loop) })
    if (!guess) throw new Error('cross-section does not match any catalogued section')
    const clean = stockOutlineForCode(guess.code, guess.dims ?? [])
    if (!clean?.outline) throw new Error(`no stock outline for ${guess.code}`)
    if (!/^(uc|ub|tfb|i)$/.test(guess.family)) {
      throw new Error(`detected ${guess.code} (${guess.family}); only I-sections are rebuilt`)
    }

    // 2. Seat the clean outline in the SAT's own frame: the same depth axis and bbox corner, so
    //    the end cuts (defined in world coordinates) land exactly where they were.
    let contour = clean.outline
    if (measured.webAlongY) contour = rotateOutline(contour, Math.PI / 2)
    const cleanBox = outlinePoints(contour)
    const cleanMinX = Math.min(...cleanBox.map((p) => p[0]))
    const cleanMinY = Math.min(...cleanBox.map((p) => p[1]))
    contour = translateOutline(contour, measured.minX - cleanMinX, measured.minY - cleanMinY)

    // 3. The rebuilt section must be the part's section — not just a lookalike.
    const deviation = Math.max(...sampleLoop(loop, 16).map((p) => distanceToOutline(p, contour)))
    if (deviation > 0.05) {
      throw new Error(
        `rebuilt ${guess.code} section deviates ${deviation.toFixed(3)} mm from the SAT outline`,
      )
    }

    // 4. Extrude, then take each end cut off with a half-space prism.
    const sketch = await sectionSketch(contour)
    if (!sketch) throw new Error('could not sketch the section')
    let solid = sketch.sketchOnPlane('XY').extrude(length)
    if (zMin !== 0) solid = solid.translate(0, 0, zMin)

    const bound = Math.max(length, measured.width, measured.depth, 100) * 2 + 100
    const centre = [
      (measured.minX + measured.maxX) / 2,
      (measured.minY + measured.maxY) / 2,
      zMin + length / 2,
    ]
    for (const cut of cuts) {
      const [nx, ny, nz] = cut.normal
      if (Math.abs(nx) > 1e-6 && Math.abs(ny) > 1e-6) {
        throw new Error('compound-mitre end cuts are not supported (rake must be about X or Y)')
      }
      // Which side is the removed (air) side? The solid's own centre is on the kept side.
      const side =
        nx * (centre[0] - cut.origin[0]) +
        ny * (centre[1] - cut.origin[1]) +
        nz * (centre[2] - cut.origin[2])
      const dirZ = Math.sign(-side * nz) || 1

      // The cut plane's trace, blown out well past the section, as a 2D polygon in the plane the
      // cutter is extruded along: (u, v) = (y, z) for a rake about X, (x, z) for a rake about Y.
      const rakeAboutX = Math.abs(nx) <= 1e-6
      const w0 = rakeAboutX ? measured.minY - 50 : measured.minX - 50
      const w1 = rakeAboutX ? measured.maxY + 50 : measured.maxX + 50
      const along = rakeAboutX ? ny : nx // ∂z/∂w of the plane
      const o0 = rakeAboutX ? cut.origin[1] : cut.origin[0]
      const zAt = (w) => cut.origin[2] - (along * (w - o0)) / nz
      const far = dirZ > 0 ? zMax + bound : zMin - bound
      const polygon = [
        [w0, zAt(w0)],
        [w1, zAt(w1)],
        [w1, far],
        [w0, far],
      ]
      const cutterSketch = await sectionSketch(
        outline(polygon[0]).lineTo(polygon[1]).lineTo(polygon[2]).lineTo(polygon[3]).done(),
      )
      let cutter = cutterSketch.sketchOnPlane(rakeAboutX ? 'YZ' : 'XZ').extrude(bound)
      // `YZ` extrudes toward +X and `XZ` toward −Y; centre the cutter on the member.
      cutter = rakeAboutX ? cutter.translate(-bound / 2, 0, 0) : cutter.translate(0, bound / 2, 0)
      solid = solid.cut(cutter)
    }

    // 5. Write and verify with the same reader the app uses to identify a part's section.
    await mkdir(dirname(output), { recursive: true })
    let step = await writeStep(solid, '/out.step', { schema: values.schema, name: guess.code })
    // WiseCAM's known-good Tekla STEPs carry the section designation in FILE_NAME as well as
    // PRODUCT (`docs/nc-to-step.md`); the OCC header default is a generic string.
    step = step
      .replace("FILE_NAME('Open CASCADE Shape Model'", `FILE_NAME('${guess.code}'`)
      .replace(
        /(PRODUCT\()'[^']*'(\s*,\s*)'[^']*'/,
        (_match, head, sep) => `${head}'${guess.code}'${sep}'${guess.code}'`,
      )
    await writeFile(output, step)
    const bytes = new Uint8Array(await readFile(output))
    const size = await measureStep(bytes)
    const detected = await detectStepSection(bytes)

    // A mirrored/offset end cut can keep the same bounding box, so check the volume too: with a
    // symmetric section the centroid is the bbox centre and each rake plane is linear, so the
    // finished volume is exactly `area × (z_end(centroid) − zMin)`.
    const area = Math.abs(polygonArea(outlinePoints(contour, 256)))
    let expectedVolume = area * length
    if (cuts.length === 1) {
      const [nx, ny, nz] = cuts[0].normal
      const w = Math.abs(nx) <= 1e-6 ? centre[1] : centre[0]
      const o = Math.abs(nx) <= 1e-6 ? cuts[0].origin[1] : cuts[0].origin[0]
      const along = Math.abs(nx) <= 1e-6 ? ny : nx
      const zEnd = cuts[0].origin[2] - (along * (w - o)) / nz
      expectedVolume = area * (zEnd - zMin)
    }
    const volumeError = Math.abs(size.volume - expectedVolume) / Math.max(expectedVolume, 1)
    if (cuts.length === 1 && volumeError > 0.005) {
      throw new Error(
        `rebuilt volume ${Math.round(size.volume)} mm³ is off the expected ${Math.round(expectedVolume)} mm³ (end cut misplaced)`,
      )
    }

    const summary = {
      input: basename(input),
      output,
      section: guess.code,
      mass: guess.mass,
      schema: values.schema,
      measured: {
        d: round(measured.d),
        b: round(measured.b),
        tf: round(measured.tf),
        tw: round(measured.tw),
        r: round(measured.r),
        corners: measured.corners,
      },
      length: round(length),
      endCuts: cuts.length,
      rebuilt: {
        deviation,
        size: size.size.map((v) => round(v)),
        volume: Math.round(size.volume),
        expectedVolume: Math.round(expectedVolume),
        detected: detected?.code ?? null,
        score: detected ? round(detected.score, 3) : null,
      },
    }
    if (values.json) {
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
    } else {
      const report = [
        `input      ${summary.input}`,
        `section    ${summary.section}  (d ${summary.measured.d} × b ${summary.measured.b}, tf ${summary.measured.tf}, tw ${summary.measured.tw}, r ${summary.measured.r})`,
        `corners    ${summary.measured.corners} arc faces in the SAT → 4 exact arcs rebuilt`,
        `length     ${summary.length} mm, ${summary.endCuts} end cut(s)`,
        `deviation  ${summary.rebuilt.deviation.toExponential(1)} mm from the SAT outline`,
        `output     ${summary.output}  (${summary.schema})`,
        `verified   ${summary.rebuilt.size.join(' × ')} mm, ${summary.rebuilt.volume} mm³, read back as ${summary.rebuilt.detected} (score ${summary.rebuilt.score})`,
      ].join('\n')
      process.stdout.write(`${report}\n`)
    }
  } finally {
    await server.close()
  }
}

function round(v, digits = 3) {
  const f = 10 ** digits
  return Math.round(v * f) / f
}

/** Signed shoelace area of a closed polygon given as `[x, y]` points. */
function polygonArea(points) {
  let sum = 0
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i]
    const [x2, y2] = points[(i + 1) % points.length]
    sum += x1 * y2 - x2 * y1
  }
  return sum / 2
}

/** Angle wrapped into (−π, π]. */
function wrap(a) {
  let v = a
  while (v <= -Math.PI) v += 2 * Math.PI
  while (v > Math.PI) v -= 2 * Math.PI
  return v
}

function distanceToSegment(p, a, b) {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const len2 = dx * dx + dy * dy
  const t =
    len2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))
}

/**
 * Shortest distance from `p` to a contour of lines and **true arcs** (exact radial projection, not
 * a sampled polyline — the difference between reporting micrometres and nanometres).
 */
function distanceToOutline(p, contour) {
  let best = Number.POSITIVE_INFINITY
  let from = contour.start
  for (const edge of contour.edges) {
    if (edge.kind === 'line') {
      best = Math.min(best, distanceToSegment(p, from, edge.to))
    } else if (edge.kind === 'circle') {
      const d = Math.hypot(p[0] - edge.center[0], p[1] - edge.center[1])
      best = Math.min(best, Math.abs(d - edge.radius))
    } else {
      const [cx, cy] = edge.center
      const distance = Math.hypot(p[0] - cx, p[1] - cy)
      const ap = wrap(Math.atan2(p[1] - cy, p[0] - cx) - edge.start)
      const inside =
        edge.sweep >= 0
          ? ap >= -1e-9 && ap <= edge.sweep + 1e-9
          : ap <= 1e-9 && ap >= edge.sweep - 1e-9
      best = Math.min(
        best,
        inside
          ? Math.abs(distance - edge.radius)
          : Math.min(
              Math.hypot(p[0] - from[0], p[1] - from[1]),
              Math.hypot(p[0] - edge.to[0], p[1] - edge.to[1]),
            ),
      )
    }
    from = edge.to
  }
  return best
}

main().catch((error) => {
  console.error(`FAIL ${error instanceof Error ? error.message : error}`)
  process.exitCode = 1
})
