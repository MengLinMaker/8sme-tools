import type { AnyShape } from 'replicad'
import { writeStep } from './occ'
import { ensureOc } from './occInit'

/**
 * Connects the separate solids of an already-nested STEP with small tabs.
 *
 * A nested beam STEP is written as one compound with every finished piece as its own solid. That
 * is correct for cutting, but the bodies fall apart when picked up and some importers treat the
 * extra bodies as strays. {@link tabStep} keeps every piece and adds thin bridges between them, so
 * the result is one connected solid without losing any part geometry.
 *
 * Tabs are placed along the beam's long axis. Pieces in the same row are joined once at each
 * end-to-end gap; rows are joined at the requested density (tabs per metre), which is the setting
 * exposed next to the preflight stray-body fix.
 */

/** Tabs per metre along the beam when the user has not chosen a density. */
export const TAB_DENSITY_DEFAULT = 2
export const TAB_DENSITY_MIN = 0.2
export const TAB_DENSITY_MAX = 20

/** Tab cross-section (mm) and how far each tab bites into the two pieces it joins. */
export const TAB_SIZE_MM = 8
export const TAB_PENETRATION_MM = 1.5

export interface TabOptions {
  /** Tabs per metre of overlap between adjacent rows. */
  density?: number
}

export interface TabResult {
  bytes: Uint8Array
  pieces: number
  tabs: number
}

type Vec = [number, number, number]

interface Body {
  solid: AnyShape
  min: Vec
  max: Vec
  center: Vec
  index: number
}

interface Row {
  bodies: Body[]
  center: Vec
}

interface StockWall {
  clip: AnyShape
  /** Axis point in world coordinates (the long coordinate is irrelevant). */
  center: Vec
  outerRadius: number
  innerRadius: number | null
}

interface TabEdge {
  a: number
  b: number
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))

const axisPoint = (values: [number, number, number]): Vec => values

function boxFromRanges(
  makeBox: (a: Vec, b: Vec) => AnyShape,
  ranges: [[number, number], [number, number], [number, number]],
): AnyShape {
  const lo = axisPoint([Math.min(...ranges[0]), Math.min(...ranges[1]), Math.min(...ranges[2])])
  const hi = axisPoint([Math.max(...ranges[0]), Math.max(...ranges[1]), Math.max(...ranges[2])])
  return makeBox(lo, hi)
}

/** Centre of the overlap between two bounding boxes on one axis (midpoint when they miss). */
function overlapCenter(a: Body, b: Body, axis: number): number {
  const lo = Math.max(a.min[axis], b.min[axis])
  const hi = Math.min(a.max[axis], b.max[axis])
  if (hi >= lo) return (lo + hi) / 2
  return (a.max[axis] + b.min[axis]) / 2
}

function gapSpan(
  a: Body,
  b: Body,
  axis: number,
  half: number,
  penetration: number,
): [number, number] {
  const lo = a.max[axis]
  const hi = b.min[axis]
  if (hi - lo > 0.01) return [lo - penetration, hi + penetration]
  const mid = overlapCenter(a, b, axis)
  return [mid - half, mid + half]
}

function bodyAt(row: Row, u: number, longAxis: number, half: number): Body | undefined {
  return row.bodies.find((body) => {
    const lo = body.min[longAxis] + half
    const hi = body.max[longAxis] - half
    return u >= lo && u <= hi
  })
}

/** Simple union-find so the tab plan can prove that every body ends up connected. */
class Components {
  private readonly parent: number[]

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, index) => index)
  }

  find(index: number): number {
    let root = index
    while (this.parent[root] !== root) root = this.parent[root] as number
    while (this.parent[index] !== index) {
      const next = this.parent[index] as number
      this.parent[index] = root
      index = next
    }
    return root
  }

  union(a: number, b: number): void {
    const rootA = this.find(a)
    const rootB = this.find(b)
    if (rootA !== rootB) this.parent[rootB] = rootA
  }

  allConnected(): boolean {
    if (this.parent.length <= 1) return true
    const root = this.find(0)
    for (let index = 1; index < this.parent.length; index++) {
      if (this.find(index) !== root) return false
    }
    return true
  }
}

/**
 * Adds tabs to every separate solid in a nested STEP and returns one fused body. Returns `null`
 * for a single-body STEP (nothing to connect) or when the tabs cannot produce one valid solid.
 */
export async function tabStep(
  bytes: Uint8Array,
  options: TabOptions = {},
): Promise<TabResult | null> {
  await ensureOc()
  const { DistanceQuery, importSTEP, makeBox, makeCylinder, measureVolume } = await import(
    'replicad'
  )
  const { getOC, cast } = await import('replicad')
  const oc = getOC() as {
    BRepAlgoAPI_Fuse: new (
      a: unknown,
      b: unknown,
    ) => {
      SetFuzzyValue: (value: number) => void
      Build: () => void
      IsDone: () => boolean
      Shape: () => unknown
    }
    BRepCheck_Analyzer: new (shape: unknown, geomControls?: boolean) => { IsValid: () => boolean }
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
    GeomAbs_SurfaceType: { GeomAbs_Cylinder: string }
  }

  const shape = (await importSTEP(
    new Blob([new Uint8Array(bytes)], { type: 'model/step' }),
  )) as unknown as { solids?: AnyShape[]; delete: () => void }
  try {
    const solids = shape.solids ?? []
    if (solids.length <= 1) return null

    const density = clamp(
      Number.isFinite(options.density) && (options.density as number) > 0
        ? (options.density as number)
        : TAB_DENSITY_DEFAULT,
      TAB_DENSITY_MIN,
      TAB_DENSITY_MAX,
    )

    const bodies: Body[] = solids.map((solid, index) => {
      const [min, max] = solid.boundingBox.bounds
      const lo: Vec = [min[0] as number, min[1] as number, min[2] as number]
      const hi: Vec = [max[0] as number, max[1] as number, max[2] as number]
      return {
        solid,
        min: lo,
        max: hi,
        center: [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2],
        index,
      }
    })

    // The beam length is the assembly's longest bounding-box axis. The two cross axes split into
    // "rows" (the parallel sides of the stock) and a lateral position on each piece.
    const overallMin: Vec = [0, 1, 2].map((axis) =>
      Math.min(...bodies.map((body) => body.min[axis])),
    ) as Vec
    const overallMax: Vec = [0, 1, 2].map((axis) =>
      Math.max(...bodies.map((body) => body.max[axis])),
    ) as Vec
    const extents = [0, 1, 2].map((axis) => overallMax[axis] - overallMin[axis])
    const longAxis = extents.indexOf(Math.max(...extents))
    const crossAxes = [0, 1, 2].filter((axis) => axis !== longAxis)
    const spread = (axis: number): number =>
      Math.max(...bodies.map((body) => body.center[axis])) -
      Math.min(...bodies.map((body) => body.center[axis]))
    const rowAxis =
      spread(crossAxes[0] as number) >= spread(crossAxes[1] as number)
        ? (crossAxes[0] as number)
        : (crossAxes[1] as number)
    const lateralAxis = (crossAxes.find((axis) => axis !== rowAxis) ?? crossAxes[0]) as number

    const unitLong: Vec = longAxis === 0 ? [1, 0, 0] : longAxis === 1 ? [0, 1, 0] : [0, 0, 1]
    const dot3 = (a: Vec, b: Vec): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
    const sub3 = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
    const len3 = (a: Vec): number => Math.hypot(a[0], a[1], a[2])

    /**
     * For two coaxial round pieces, return the stock wall (outer cylinder minus bore). Wall tabs
     * are intersected with it so they sit flush in the wall instead of sticking out past the OD or
     * into the bore. Non-round sections return null and keep the rectangular tab.
     */
    const stockWall = (a: Body, b: Body): StockWall | null => {
      interface AxialCylinder {
        radius: number
        point: Vec
      }
      const cylindersOf = (body: Body): AxialCylinder[] => {
        const found: AxialCylinder[] = []
        for (const face of (
          body.solid as unknown as { faces?: { geomType: string; wrapped: unknown }[] }
        ).faces ?? []) {
          if (face.geomType !== 'CYLINDRE') continue
          try {
            const surface = new oc.BRepAdaptor_Surface(face.wrapped, true)
            if (surface.GetType() !== oc.GeomAbs_SurfaceType.GeomAbs_Cylinder) continue
            const cylinder = surface.Cylinder()
            const axis = cylinder.Axis()
            const direction = axis.Direction()
            const dir: Vec = [direction.X(), direction.Y(), direction.Z()]
            if (Math.abs(dot3(dir, unitLong)) < 0.99) continue
            const location = axis.Location()
            found.push({
              radius: cylinder.Radius(),
              point: [location.X(), location.Y(), location.Z()],
            })
          } catch {
            // A malformed face is not a usable stock reference.
          }
        }
        return found
      }
      const left = cylindersOf(a)
      const right = cylindersOf(b)
      const shared: AxialCylinder[] = []
      for (const one of left) {
        for (const two of right) {
          if (Math.abs(one.radius - two.radius) > 0.05) continue
          const delta = sub3(two.point, one.point)
          const along = dot3(delta, unitLong)
          const perpendicular = len3([
            delta[0] - unitLong[0] * along,
            delta[1] - unitLong[1] * along,
            delta[2] - unitLong[2] * along,
          ])
          if (perpendicular > 0.1) continue
          if (!shared.some((cylinder) => Math.abs(cylinder.radius - one.radius) < 0.05)) {
            shared.push(one)
          }
        }
      }
      if (shared.length === 0) return null
      shared.sort((one, two) => two.radius - one.radius)
      const outer = shared[0] as AxialCylinder
      // Only treat a genuinely round stock as the envelope. A shared hole with an axial bore
      // would also match radius-for-radius; it is small and off-centre, so reject those.
      const crossExtent = Math.max(
        extents[crossAxes[0] as number] as number,
        extents[crossAxes[1] as number] as number,
      )
      if (outer.radius < crossExtent * 0.25) return null
      const crossMid = (axis: number): number =>
        ((overallMin[axis] as number) + (overallMax[axis] as number)) / 2
      const axisOffset = Math.hypot(
        outer.point[crossAxes[0] as number] - crossMid(crossAxes[0] as number),
        outer.point[crossAxes[1] as number] - crossMid(crossAxes[1] as number),
      )
      if (axisOffset > crossExtent * 0.1) return null
      const inner = shared.find(
        (cylinder) => cylinder.radius > outer.radius * 0.5 && outer.radius - cylinder.radius > 0.5,
      )
      const start: Vec = [...outer.point]
      start[longAxis] = (overallMin[longAxis] as number) - 1
      const height = (overallMax[longAxis] as number) - (overallMin[longAxis] as number) + 2
      let stock = makeCylinder(outer.radius, height, start, unitLong) as unknown as AnyShape
      if (inner) {
        const cutter = makeCylinder(inner.radius, height, start, unitLong) as unknown as AnyShape
        stock = (stock as unknown as { cut: (tool: AnyShape) => AnyShape }).cut(cutter)
      }
      return {
        clip: stock,
        center: outer.point,
        outerRadius: outer.radius,
        innerRadius: inner ? inner.radius : null,
      }
    }

    const sortedByRow = [...bodies].sort((a, b) => a.center[rowAxis] - b.center[rowAxis])
    const rowSpread =
      (sortedByRow[sortedByRow.length - 1] as Body).center[rowAxis] -
      (sortedByRow[0] as Body).center[rowAxis]
    const rowTolerance = Math.max(2, Math.min(20, rowSpread * 0.2))
    const rows: Row[] = []
    for (const body of sortedByRow) {
      const last = rows[rows.length - 1]
      const lastCenter = last ? last.center[rowAxis] : Number.POSITIVE_INFINITY
      if (!last || Math.abs(body.center[rowAxis] - lastCenter) > rowTolerance) {
        rows.push({ bodies: [body], center: [...body.center] })
      } else {
        last.bodies.push(body)
        last.center[rowAxis] =
          (last.center[rowAxis] * (last.bodies.length - 1) + body.center[rowAxis]) /
          last.bodies.length
      }
    }
    for (const row of rows) row.bodies.sort((a, b) => a.min[longAxis] - b.min[longAxis])

    const half = TAB_SIZE_MM / 2
    const penetration = TAB_PENETRATION_MM
    const tabs: AnyShape[] = []
    const edges: TabEdge[] = []

    // Tabs are handling aids, not extra material: every tab must stay inside the stock envelope.
    // Clipping to the assembly bbox keeps a wall tab flush with the tube OD instead of sticking
    // out into air (and keeps nested-beam tabs inside the parent stock section).
    const clipRanges = (
      ranges: [[number, number], [number, number], [number, number]],
    ): [[number, number], [number, number], [number, number]] =>
      ranges.map((range, axis) => {
        const lo = Math.max(range[0], overallMin[axis] as number)
        const hi = Math.min(range[1], overallMax[axis] as number)
        return [lo, Math.max(lo, hi)]
      }) as [[number, number], [number, number], [number, number]]

    /**
     * Half the local material width on one cross axis, measured on a thin slice just inside the
     * body. This is what makes a non-round tab flush with both faces of a web/flange: the tab is
     * no wider than the material it sits in, so neither side sticks out into the section void.
     */
    const localHalf = (
      body: Body,
      u: number,
      otherAxis: number,
      otherCentre: number,
      otherHalf: number,
      measureAxis: number,
    ): number | null => {
      const thickness = 0.2
      const ranges: [[number, number], [number, number], [number, number]] = [
        [0, 0],
        [0, 0],
        [0, 0],
      ]
      ranges[longAxis] = [u - thickness / 2, u + thickness / 2]
      ranges[otherAxis] = [otherCentre - otherHalf, otherCentre + otherHalf]
      ranges[measureAxis] = [
        (overallMin[measureAxis] as number) - 1,
        (overallMax[measureAxis] as number) + 1,
      ]
      try {
        const slab = boxFromRanges(makeBox, ranges)
        const piece = (
          body.solid as unknown as { intersect: (tool: AnyShape) => AnyShape }
        ).intersect(slab)
        const [min, max] = (piece as unknown as { boundingBox: { bounds: [number[], number[]] } })
          .boundingBox.bounds
        const width = (max[measureAxis] as number) - (min[measureAxis] as number)
        return width > 0.5 ? width / 2 : null
      } catch {
        return null
      }
    }

    // 1. Keep each row as one chain: one tab across every end-to-end junction.
    for (const row of rows) {
      for (let index = 0; index < row.bodies.length - 1; index++) {
        const a = row.bodies[index] as Body
        const b = row.bodies[index + 1] as Body
        const [z0, z1] = gapSpan(a, b, longAxis, half, penetration)
        // The bbox centre works for a solid T/L section but sits in the bore of a tube. Try the
        // centre first, then points out towards the cross-section edges until a tab touches both
        // pieces; this keeps the tab small even on a hollow section.
        const fractions = [
          [0.5, 0.5],
          [0.5, 0],
          [0.5, 1],
          [0, 0.5],
          [1, 0.5],
          [0.5, 0.05],
          [0.5, 0.95],
          [0.05, 0.5],
          [0.95, 0.5],
        ] as const
        const crossPoint = (axis: number, fraction: number): number => {
          const lo = Math.max(a.min[axis], b.min[axis])
          const hi = Math.min(a.max[axis], b.max[axis])
          if (hi >= lo) return lo + (hi - lo) * fraction
          return overlapCenter(a, b, axis)
        }
        const wall = stockWall(a, b)
        const wallClip = wall?.clip ?? null
        const makeTab = (
          fractionRow: number,
          fractionLateral: number,
          sizeHalf = half,
        ): AnyShape => {
          const ranges: [[number, number], [number, number], [number, number]] = [
            [0, 0],
            [0, 0],
            [0, 0],
          ]
          const row = crossPoint(rowAxis, fractionRow)
          const lateral = crossPoint(lateralAxis, fractionLateral)
          ranges[longAxis] = [z0, z1]
          if (wall) {
            // A round wall tab must span the whole wall thickness: tangential width stays local,
            // but the radial extent runs from the bore to the OD, then the annulus clip trims it
            // flush on both surfaces. Keeping it only at the OD leaves an inner step which can
            // throw off the tube diameter when the STEP is re-imported.
            const distanceRow = Math.abs(row - wall.center[rowAxis])
            const distanceLateral = Math.abs(lateral - wall.center[lateralAxis])
            const radialAxis = distanceRow >= distanceLateral ? rowAxis : lateralAxis
            const tangentialAxis = radialAxis === rowAxis ? lateralAxis : rowAxis
            const radialCoord = radialAxis === rowAxis ? row : lateral
            const tangentialCoord = radialAxis === rowAxis ? lateral : row
            if (wall.innerRadius != null) {
              const sign = radialCoord >= wall.center[radialAxis] ? 1 : -1
              const inner = wall.center[radialAxis] + sign * (wall.innerRadius - 0.2)
              const outer = wall.center[radialAxis] + sign * (wall.outerRadius + 0.2)
              ranges[radialAxis] = [Math.min(inner, outer), Math.max(inner, outer)]
            } else {
              ranges[radialAxis] = [radialCoord - sizeHalf, radialCoord + sizeHalf]
            }
            ranges[tangentialAxis] = [tangentialCoord - sizeHalf, tangentialCoord + sizeHalf]
          } else {
            let rowHalf = sizeHalf
            let lateralHalf = sizeHalf
            const midpoint = (z0 + z1) / 2
            const positiveGap = b.min[longAxis] - a.max[longAxis] > 0
            const sample = [a, b].map((body) => ({
              body,
              u: positiveGap
                ? body === a
                  ? (a.max[longAxis] as number) - 0.5
                  : (b.min[longAxis] as number) + 0.5
                : midpoint,
            }))
            const rowWidths = sample
              .map(({ body, u }) => localHalf(body, u, lateralAxis, lateral, sizeHalf, rowAxis))
              .filter((value): value is number => value != null && value > 0.5)
            const lateralWidths = sample
              .map(({ body, u }) => localHalf(body, u, rowAxis, row, sizeHalf, lateralAxis))
              .filter((value): value is number => value != null && value > 0.5)
            if (rowWidths.length > 0) rowHalf = Math.min(sizeHalf, ...rowWidths)
            if (lateralWidths.length > 0) lateralHalf = Math.min(sizeHalf, ...lateralWidths)
            ranges[rowAxis] = [row - rowHalf, row + rowHalf]
            ranges[lateralAxis] = [lateral - lateralHalf, lateral + lateralHalf]
          }
          const box = boxFromRanges(makeBox, clipRanges(ranges))
          if (!wallClip) return box
          try {
            return (box as unknown as { intersect: (tool: AnyShape) => AnyShape }).intersect(
              wallClip,
            )
          } catch {
            return box
          }
        }
        const distanceA = new DistanceQuery(a.solid)
        const distanceB = new DistanceQuery(b.solid)
        const touches = (query: InstanceType<typeof DistanceQuery>, shape: AnyShape): boolean => {
          try {
            return query.distanceTo(shape) < 0.05
          } catch {
            return false
          }
        }
        const centreTab = makeTab(0.5, 0.5)
        if (!wallClip && touches(distanceA, centreTab) && touches(distanceB, centreTab)) {
          tabs.push(centreTab)
        } else {
          // A hollow section has no material at the bbox centre. Bridge the seam wherever a small
          // candidate actually touches both pieces (a tube's split normally gives two, top and
          // bottom) rather than widening the tab until it reaches the wall.
          const bridgeHalf = half * 2
          const bridged: AnyShape[] = []
          for (const [rowFraction, lateralFraction] of fractions) {
            const candidate = makeTab(rowFraction, lateralFraction, bridgeHalf)
            if (touches(distanceA, candidate) && touches(distanceB, candidate)) {
              bridged.push(candidate)
            }
          }
          if (bridged.length === 0 && !wallClip) bridged.push(centreTab)
          if (bridged.length > 0) tabs.push(...bridged)
        }
        edges.push({ a: a.index, b: b.index })
      }
    }

    // 2. Join adjacent rows at the requested density, wherever both rows have a piece.
    const orderedRows = [...rows].sort((a, b) => a.center[rowAxis] - b.center[rowAxis])
    for (let rowIndex = 0; rowIndex < orderedRows.length - 1; rowIndex++) {
      const lower = orderedRows[rowIndex] as Row
      const upper = orderedRows[rowIndex + 1] as Row
      const lo = Math.max(
        Math.min(...lower.bodies.map((body) => body.min[longAxis])),
        Math.min(...upper.bodies.map((body) => body.min[longAxis])),
      )
      const hi = Math.min(
        Math.max(...lower.bodies.map((body) => body.max[longAxis])),
        Math.max(...upper.bodies.map((body) => body.max[longAxis])),
      )
      if (!(hi > lo)) continue
      const count = Math.max(1, Math.min(500, Math.round(((hi - lo) * density) / 1000)))
      const step = (hi - lo) / count
      for (let tabIndex = 0; tabIndex < count; tabIndex++) {
        const u = lo + (tabIndex + 0.5) * step
        const a = bodyAt(lower, u, longAxis, half)
        const b = bodyAt(upper, u, longAxis, half)
        if (!a || !b) continue
        const [low, high] = a.center[rowAxis] <= b.center[rowAxis] ? [a, b] : [b, a]
        const [r0, r1] = gapSpan(low, high, rowAxis, half, penetration)
        const lateralCenter = overlapCenter(low, high, lateralAxis)
        const rowCentre = (r0 + r1) / 2
        const rowHalf = Math.max(half, (r1 - r0) / 2)
        const widths = [
          localHalf(low, u, rowAxis, rowCentre, rowHalf, lateralAxis),
          localHalf(high, u, rowAxis, rowCentre, rowHalf, lateralAxis),
        ].filter((value): value is number => value != null && value > 0.5)
        const lateralHalf = widths.length > 0 ? Math.min(half, ...widths) : half
        const u0 = u - half
        const u1 = u + half
        const ranges: [[number, number], [number, number], [number, number]] = [
          [0, 0],
          [0, 0],
          [0, 0],
        ]
        ranges[longAxis] = [u0, u1]
        ranges[rowAxis] = [r0, r1]
        ranges[lateralAxis] = [lateralCenter - lateralHalf, lateralCenter + lateralHalf]
        tabs.push(boxFromRanges(makeBox, clipRanges(ranges)))
        edges.push({ a: low.index, b: high.index })
      }
    }

    // 3. Safety net: if the rows missed a body (for example a one-off stray), bridge from the
    // first body to each remaining component through their centres. Centres lie in the material
    // of the nested beam pieces, so this always closes the graph.
    const components = new Components(bodies.length)
    for (const edge of edges) components.union(edge.a, edge.b)
    if (!components.allConnected()) {
      let cursor = 1
      while (!components.allConnected() && cursor < bodies.length) {
        const first = bodies[0] as Body
        const other = bodies[cursor] as Body
        cursor += 1
        if (components.find(first.index) === components.find(other.index)) continue
        const dx = other.center[0] - first.center[0]
        const dy = other.center[1] - first.center[1]
        const dz = other.center[2] - first.center[2]
        const distance = Math.hypot(dx, dy, dz)
        if (!(distance > 0)) continue
        const dir: Vec = [dx / distance, dy / distance, dz / distance]
        const start: Vec = [
          first.center[0] - dir[0] * penetration,
          first.center[1] - dir[1] * penetration,
          first.center[2] - dir[2] * penetration,
        ]
        tabs.push(makeCylinder(half, distance + penetration * 2, start, dir))
        edges.push({ a: first.index, b: other.index })
        components.union(first.index, other.index)
      }
    }
    if (tabs.length === 0) return null

    const fuse = (a: AnyShape, b: AnyShape): AnyShape => {
      const builder = new oc.BRepAlgoAPI_Fuse(
        (a as unknown as { wrapped: unknown }).wrapped,
        (b as unknown as { wrapped: unknown }).wrapped,
      )
      builder.SetFuzzyValue(0.001)
      builder.Build()
      if (!builder.IsDone()) throw new Error('tab fuse failed')
      return cast(builder.Shape() as never) as unknown as AnyShape
    }

    let fused = solids[0] as AnyShape
    for (const solid of solids.slice(1)) fused = fuse(fused, solid)
    for (const tab of tabs) fused = fuse(fused, tab)

    const fusedSolids = (fused as unknown as { solids?: AnyShape[] }).solids ?? []
    if (fusedSolids.length !== 1) return null
    if (!new oc.BRepCheck_Analyzer(fused.wrapped, true).IsValid()) return null
    // A tab that misses both pieces can leave a floating island; refuse to hand back a partial fix.
    if (!(measureVolume(fused as never) > 0)) return null

    const text = await writeStep(fused, 'tabs.stp')
    return {
      bytes: new TextEncoder().encode(text),
      pieces: bodies.length,
      tabs: tabs.length,
    }
  } finally {
    shape.delete()
  }
}
