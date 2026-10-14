import type {
  ReplicadMesh,
  ReplicadMeshedEdges,
  ReplicadMeshedFaces,
} from 'replicad-threejs-helper'
import { ensureOc } from './occInit'

/**
 * Tessellates a STEP file into triangle/edge meshes ready for three.js.
 *
 * The OpenCASCADE kernel is shared through {@link ensureOc}; the returned meshes
 * are plain arrays so the OCC shape can be freed immediately afterwards.
 *
 * Alongside the triangles/edges it also walks the B-rep topology: each *planar* face's outward
 * normal plus its **wires** — the outer boundary (edge-to-edge cuts and the raw-stock silhouette)
 * and any inner wires (each a closed loop *enclosed* by the face: a hole, slot or pocket rim).
 * Each edge carries its curve type and the outward normals of the planar face(s) it is shared with,
 * so the viewer can tell a cut edge from a raw-stock silhouette edge and has the cut-face normal
 * for bevel generation. This is exact (no tessellation noise, no boolean shards) and free of the
 * fragile 2D outline heuristics.
 */

interface MeshableShape {
  mesh(options?: { tolerance?: number; angularTolerance?: number }): ReplicadMeshedFaces
  meshEdges(options?: { tolerance?: number; angularTolerance?: number }): ReplicadMeshedEdges
  delete(): void
}

interface VectorLike {
  x: number
  y: number
  z: number
}

interface EdgeLike {
  geomType: string
  length: number
  startPoint: VectorLike
  endPoint: VectorLike
  pointAt(position?: number): VectorLike
  delete(): void
}

interface WireLike {
  edges: EdgeLike[]
  delete(): void
}

interface FaceLike {
  geomType: string
  UVBounds: { uMin: number; uMax: number; vMin: number; vMax: number }
  pointOnSurface(u: number, v: number): VectorLike
  normalAt(location?: VectorLike): VectorLike
  clone(): FaceLike
  outerWire(): WireLike
  innerWires(): WireLike[]
  delete(): void
}

interface FaceShape extends MeshableShape {
  faces: FaceLike[]
}

interface CompoundShape extends MeshableShape {
  solids: FaceShape[]
  faces: FaceLike[]
}

type Vec3 = [number, number, number]

/** One B-rep edge, flattened to a polyline, with the faces it is shared with. */
export interface BrepEdge {
  /** Polyline, flat XYZ (a straight edge is two points; a curve is sampled). */
  points: number[]
  /** OCC curve type: `LINE`, `CIRCLE`, `BSPLINE_CURVE`, … */
  curveType: string
  /** Indices (into `MeshedBody.brep`) of the other faces this edge bounds. */
  neighbours: number[]
}

/**
 * A face's boundary wire. `enclosed` marks an **inner wire** — a closed loop the face encloses
 * (a hole / slot / pocket rim); the outer wire is the face's edge-to-edge + raw-stock boundary.
 */
export interface BrepWire {
  enclosed: boolean
  edges: BrepEdge[]
}

/**
 * A B-rep face: its representative outward normal, a point on it, whether it is planar, and its
 * outer + inner wires (native frame). All faces are emitted — the viewer decides stock vs cut by
 * topology, so a rounded corner (a cylindrical stock face) is available to project its cut onto the
 * adjacent `o`/`u`/`h` face.
 */
export interface BrepFace {
  normal: Vec3
  /** A representative point on the face (centroid of its wire points), native frame. */
  center: Vec3
  planar: boolean
  /** A few points sampled on the face *surface* (flat XYZ), for the stock/cut outline test. */
  samples: number[]
  wires: BrepWire[]
}

/**
 * Viewer tessellation: linear deflection in mm; `angularTolerance` goes
 * straight to OCC in radians, so 20 is effectively no angular limit and bends
 * mesh purely by deflection. Coarser flats halve triangle counts and CSG time
 * with identical diff verdicts (measured across PFC/SHS/T parts); 0.3 mm
 * facets stay far below the 1 mm diff bar. (A real angular cap was tried and
 * abandoned: 0.2 rad densified fillets 2.3× and slowed CSG ~12×; 0.3 rad still
 * cost +58% tris and 4× CSG for the same verdicts.)
 */
const MESH_OPTIONS = { tolerance: 0.3, angularTolerance: 20 }

/** Curve sampling: ~1 sample per this many mm, clamped, so circles don't read faceted. */
const CURVE_SAMPLE_MM = 1.5
const CURVE_MIN_SAMPLES = 12
const CURVE_MAX_SAMPLES = 72
/** Fallback sample count when an edge's length is unavailable/degenerate. */
const CURVE_FALLBACK_SAMPLES = 24

function pointInto(target: number[], point: VectorLike): void {
  target.push(point.x, point.y, point.z)
}

/** Direction-independent identity for an edge, so its adjacent faces map to one key. */
function edgeIdentity(edge: EdgeLike): string {
  const mid: VectorLike =
    edge.geomType === 'LINE'
      ? {
          x: (edge.startPoint.x + edge.endPoint.x) / 2,
          y: (edge.startPoint.y + edge.endPoint.y) / 2,
          z: (edge.startPoint.z + edge.endPoint.z) / 2,
        }
      : edge.pointAt(0.5)
  return edgeKey(edge, mid)
}

/** Samples an edge into a polyline (straight edges two points; curves ~1/1.5mm, clamped). */
function sampleEdge(edge: EdgeLike): number[] {
  const points: number[] = []
  if (edge.geomType === 'LINE') {
    pointInto(points, edge.startPoint)
    pointInto(points, edge.endPoint)
    return points
  }
  const length = edge.length
  const steps = Number.isFinite(length)
    ? Math.min(CURVE_MAX_SAMPLES, Math.max(CURVE_MIN_SAMPLES, Math.round(length / CURVE_SAMPLE_MM)))
    : CURVE_FALLBACK_SAMPLES
  for (let i = 0; i <= steps; i++) pointInto(points, edge.pointAt(i / steps))
  return points
}

/** Direction-independent identity for an edge, so its adjacent faces map to one key. */
function edgeKey(edge: EdgeLike, mid: VectorLike): string {
  const quantize = (value: number): number => Math.round(value * 100)
  const p1 = `${quantize(edge.startPoint.x)},${quantize(edge.startPoint.y)},${quantize(edge.startPoint.z)}`
  const p2 = `${quantize(edge.endPoint.x)},${quantize(edge.endPoint.y)},${quantize(edge.endPoint.z)}`
  const [lo, hi] = p1 < p2 ? [p1, p2] : [p2, p1]
  return `${lo}|${hi}|${quantize(mid.x)},${quantize(mid.y)},${quantize(mid.z)}`
}

/**
 * The planar B-rep faces of a shape, each with its outward unit normal and its outer/inner wires.
 * Non-planar faces (fillets, copes, hole walls) are skipped as *reported* faces — the cut edges we
 * colour live on planar stock faces — but their edges still join the adjacency map, so an edge on a
 * stock face can be recognised as a cut when the face behind it is a curved cut face (a coped end,
 * a hole wall). Each edge carries the normals of its adjacent faces (native frame): a cut (a
 * transverse neighbour) is told from a raw-stock silhouette edge (a lengthwise neighbour).
 */
function extractBrepFaces(faces: FaceLike[]): BrepFace[] {
  interface RawEdge {
    points: number[]
    curveType: string
    key: string
  }
  interface RawWire {
    enclosed: boolean
    edges: RawEdge[]
  }
  interface RawFace {
    normal: Vec3
    center: Vec3
    planar: boolean
    samples: number[]
    wires: RawWire[]
  }

  const raw: RawFace[] = []
  const edgeOwners = new Map<string, number[]>()
  const kept: FaceLike[] = []

  faces.forEach((face, index) => {
    kept.push(face)
    let planar = false
    let normal: Vec3 = [0, 0, 0]
    const surface: number[] = []
    const wires: RawWire[] = []
    try {
      planar = face.geomType === 'PLANE'
      const normalVec = face.normalAt()
      const length = Math.hypot(normalVec.x, normalVec.y, normalVec.z) || 1
      normal = [normalVec.x / length, normalVec.y / length, normalVec.z / length]
      // Sample a curved face's *surface* (its UV bounds are finite); a plane's UV bounds are
      // unbounded, so a planar face uses its boundary centroid instead (below).
      if (!planar) {
        const uv = face.UVBounds
        for (const fu of [0.25, 0.5, 0.75]) {
          for (const fv of [0.25, 0.5, 0.75]) {
            const point = face.pointOnSurface(
              uv.uMin + (uv.uMax - uv.uMin) * fu,
              uv.vMin + (uv.vMax - uv.vMin) * fv,
            )
            surface.push(point.x, point.y, point.z)
          }
        }
      }
      const outer = face.clone().outerWire()
      const inner = face.clone().innerWires()
      const wireList: [WireLike, boolean][] = [[outer, false]]
      for (const wire of inner) wireList.push([wire, true])
      for (const [wire, enclosed] of wireList) {
        const edges: RawEdge[] = []
        for (const edge of wire.edges) {
          const key = edgeIdentity(edge)
          const owners = edgeOwners.get(key)
          if (owners) owners.push(index)
          else edgeOwners.set(key, [index])
          edges.push({ points: sampleEdge(edge), curveType: edge.geomType, key })
          edge.delete()
        }
        wires.push({ enclosed, edges })
        wire.delete()
      }
    } catch {
      // A degenerate/unreadable face — keep the slot (so indices stay aligned) but with no wires.
    }
    let cx = 0
    let cy = 0
    let cz = 0
    let count = 0
    for (const wire of wires) {
      for (const edge of wire.edges) {
        for (let i = 0; i + 2 < edge.points.length; i += 3) {
          cx += edge.points[i] as number
          cy += edge.points[i + 1] as number
          cz += edge.points[i + 2] as number
          count++
        }
      }
    }
    raw.push({
      normal,
      center: count > 0 ? [cx / count, cy / count, cz / count] : [0, 0, 0],
      planar,
      samples: planar && count > 0 ? [cx / count, cy / count, cz / count] : surface,
      wires,
    })
  })

  const result = raw.map((face, index) => ({
    normal: face.normal,
    center: face.center,
    planar: face.planar,
    samples: face.samples,
    wires: face.wires.map((wire) => ({
      enclosed: wire.enclosed,
      edges: wire.edges.map((edge) => ({
        points: edge.points,
        curveType: edge.curveType,
        neighbours: (edgeOwners.get(edge.key) ?? []).filter((owner) => owner !== index),
      })),
    })),
  }))

  for (const face of kept) face.delete()
  return result
}

function meshShape(name: string, shape: MeshableShape): ReplicadMesh {
  return {
    name,
    faces: shape.mesh(MESH_OPTIONS),
    edges: shape.meshEdges(MESH_OPTIONS),
  }
}

/** A single solid body meshed for three.js, flagged as stray or the real part. */
export interface MeshedBody {
  mesh: ReplicadMesh
  /** true when this body is a floating stray — i.e. not the main (largest) part */
  stray: boolean
  /** Planar B-rep faces with their outward normals and outer/inner wires (native frame). */
  brep: BrepFace[]
}

export interface MeshedStep {
  bodies: MeshedBody[]
  /** every body's vertices concatenated, for seating / centring / framing */
  vertices: number[]
}

/**
 * Tessellates a STEP file per solid body. A clean single-body part comes back as one body; a
 * part carrying stray floating solids comes back as several, with every body except the largest
 * (the real part) flagged `stray` so the viewer can colour the problem pieces apart.
 */
export async function meshStepFile(name: string, bytes: Uint8Array): Promise<MeshedStep> {
  await ensureOc()
  const { importSTEP, measureVolume } = await import('replicad')
  const blob = new Blob([new Uint8Array(bytes)], { type: 'model/step' })
  const shape = (await importSTEP(blob)) as unknown as CompoundShape
  try {
    const solids = shape.solids ?? []
    let bodies: MeshedBody[]
    if (solids.length <= 1) {
      bodies = [{ mesh: meshShape(name, shape), stray: false, brep: extractBrepFaces(shape.faces) }]
    } else {
      let mainIndex = 0
      let mainVolume = Number.NEGATIVE_INFINITY
      for (let i = 0; i < solids.length; i++) {
        const volume = measureVolume(solids[i] as never)
        if (volume > mainVolume) {
          mainVolume = volume
          mainIndex = i
        }
      }
      bodies = solids.map((solid, index) => ({
        mesh: meshShape(`${name}·body${index}`, solid),
        stray: index !== mainIndex,
        brep: extractBrepFaces(solid.faces),
      }))
    }
    return { bodies, vertices: bodies.flatMap((body) => body.mesh.faces.vertices) }
  } finally {
    shape.delete()
  }
}
