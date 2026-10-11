import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { syncGeometries } from 'replicad-threejs-helper'
import {
  AdditiveBlending,
  AmbientLight,
  Box3,
  BufferGeometry,
  DirectionalLight,
  DoubleSide,
  EdgesGeometry,
  ExtrudeGeometry,
  Float32BufferAttribute,
  Group,
  HemisphereLight,
  LineBasicMaterial,
  LineSegments,
  type Material,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  type Object3D,
  OrthographicCamera,
  Path,
  Quaternion,
  Scene,
  Shape,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { LineMaterial } from 'three/addons/lines/LineMaterial.js'
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js'
import type { CutReachFailure } from '@/lib/audit/cutReach'
import {
  faceNormal,
  type NcFaceFrame,
  placeNcFace,
  resolveNcFaceFrame,
} from '@/lib/parsers/ncFaces'
import type { NcFace, NcGeometry } from '@/lib/parsers/ncGeometry'
import {
  type NcLineSets,
  type NcProjection,
  projectNc,
  THICKNESS_COLORS,
  type Vec3,
} from '@/lib/parsers/ncProject'
import { detectOrientation } from '@/lib/sections/orient'
import type { StockOutline } from '@/lib/sections/stock'
import {
  type DiffPresence,
  diffAlpha,
  probeDiffPresence,
} from '@/lib/step/booleanDiff'
import {
  cachedDeviationDiff,
  DEVIATION_TOLERANCE_MM,
  deviationDiff,
} from '@/lib/step/deviationDiff'
import { computeDiffMasks, diffFraction, resolveDiffTolerance } from '@/lib/step/diffHighlight'
import type { MeshedStep } from '@/lib/step/mesh'
import { meshForViewer } from '@/lib/step/viewerModel'
import { cn } from '@/lib/utils'
import { attachOrbit, attachWheelPan, type OrbitBus, requestFocus } from './orbitSync'
import { smoothLines } from './smoothLines'

const GHOST_COLOR = 0x3ddc84
/** Stock outline: neutral grey so it reads as raw material distinct from the part. */
const STOCK_COLOR = 0x9ca3af
/** Compare (STEP) shell: neutral cool grey, so it reads as reference without tinting the base. */
const COMPARE_COLOR = 0x8a94a6
const STRAY_COLOR = 0xf97316
/** Light-sabre cut lines: perimeter of the patch the beam cannot cut. */
const SABRE_CUT_COLOR = 0xff2b2b
/** Overcut vs the STEP ideal (NC took too much — scrap, cannot fix). */
const OVERCUT_COLOR = 0xef4444
const OVERCUT_RGB: [number, number, number] = [0xef / 255, 0x44 / 255, 0x44 / 255]
/** Undercut vs the STEP ideal (leftover — can still be cut). */
const UNDERCUT_COLOR = 0x3b82f6
const UNDERCUT_RGB: [number, number, number] = [0x3b / 255, 0x82 / 255, 0xf6 / 255]
/**
 * Dihedral bar for the diff-solid outlines — higher than the model edges so only genuine corners
 * draw. The diff is a smooth shell, so its tessellated curves would otherwise clutter it.
 */
const DIFF_EDGE_THRESHOLD_DEG = 55
const FACE_MATERIAL = { color: 0x9aa3ad, metalness: 0.15, roughness: 0.75 }
/** Roll about the length axis for each `detectOrientation` result (world YZ → profile-local). */
const SEAT_ANGLES = [0, -Math.PI / 2, Math.PI, Math.PI / 2]

/** Fallback colour for a cut-thickness bucket when there are more buckets than palette colours. */
const FALLBACK_COLOR = 0x9ca3af

/** NC toolpath line width in screen pixels (fat lines, so they read clearly over the model). */
const NC_LINE_WIDTH = 3
/** Glow used when an issue row is hovered: a wide additive halo behind the marker + a fatter core. */
const SABRE_HALO_WIDTH = 16
const SABRE_HALO_OPACITY = 0.32
const SABRE_HIGHLIGHT_WIDTH = 6
/** The other markers dim to this while one is hovered, so the hovered one reads at a glance. */
const SABRE_DIM_OPACITY = 0.2
/**
 * Length (mm) of the marker drawn for a failure that collapsed to a point — a corner-risk run can
 * be a single sample (`from` == `to`), which would otherwise draw a zero-length, invisible line.
 */
const SABRE_TICK_MM = 4

/** Builds one fat-line (Line2) object from a flat XYZ pair list, or null when there is nothing. */
function ncLineObject(
  points: number[],
  color: number,
  resolution: Vector2,
  materials: LineMaterial[],
  onTop = false,
): LineSegments2 | null {
  if (points.length === 0) return null
  const geometry = new LineSegmentsGeometry()
  geometry.setPositions(points)
  const material = new LineMaterial({
    color,
    transparent: true,
    opacity: 0.98,
    linewidth: NC_LINE_WIDTH,
    worldUnits: false,
    // Error markers draw on top of the model (no occlusion): they render in the second pass
    // (layer 1, after the depth buffer is cleared) and ignore depth.
    depthTest: !onTop,
  })
  material.resolution.copy(resolution)
  materials.push(material)
  const line = new LineSegments2(geometry, material)
  if (onTop) {
    line.renderOrder = 30
    line.layers.set(1)
  }
  return line
}

/** A wide, additive, translucent copy of a marker's line — the glow behind a hovered finding. */
function ncHaloObject(
  points: number[],
  color: number,
  resolution: Vector2,
  materials: LineMaterial[],
): LineSegments2 | null {
  if (points.length === 0) return null
  const geometry = new LineSegmentsGeometry()
  geometry.setPositions(points)
  const material = new LineMaterial({
    color,
    transparent: true,
    opacity: SABRE_HALO_OPACITY,
    linewidth: SABRE_HALO_WIDTH,
    worldUnits: false,
    blending: AdditiveBlending,
    depthTest: false,
    depthWrite: false,
  })
  material.resolution.copy(resolution)
  materials.push(material)
  const line = new LineSegments2(geometry, material)
  line.renderOrder = 29
  line.layers.set(1)
  line.visible = false
  return line
}

/** Builds the NC line sets as coloured fat lines (cut lines + hole rings). */
function addNcLines(
  nc: NcGeometry,
  projection: NcProjection,
  resolution: Vector2,
  materials: LineMaterial[],
): LineSegments2[] {
  const sets: NcLineSets = projectNc(nc, projection)
  const lines: LineSegments2[] = []
  const add = (points: number[], color: number): LineSegments2 | null => {
    const line = ncLineObject(points, color, resolution, materials)
    if (line) lines.push(line)
    return line
  }
  sets.cuts.forEach((cut, index) => {
    add(cut.points, THICKNESS_COLORS[index % THICKNESS_COLORS.length] ?? FALLBACK_COLOR)
  })
  return lines
}

/** Formats a 0–1 fraction as a percentage, keeping a decimal for tiny-but-nonzero shares. */
function percent(value: number): string {
  return `${(value * 100).toFixed(value > 0 && value < 0.01 ? 1 : 0)}%`
}

/**
 * Paints per-face alpha onto a diff geometry from per-triangle clearances, so
 * barely-out faces whisper and far-out faces pop. The geometry must be
 * non-indexed with one triangle per three vertices, and `distances` aligned
 * with it (as `filterDrawableFaces` returns).
 */
function paintDiffAlpha(
  geometry: BufferGeometry,
  distances: number[],
  rgb: [number, number, number],
): void {
  const triCount = Math.floor((geometry.getAttribute('position')?.count ?? 0) / 3)
  const colors = new Float32Array(Math.max(triCount, 0) * 12)
  for (let t = 0; t < triCount; t++) {
    const alpha = diffAlpha(distances[t] ?? 0)
    for (let k = 0; k < 3; k++) {
      const o = (t * 3 + k) * 4
      colors[o] = rgb[0]
      colors[o + 1] = rgb[1]
      colors[o + 2] = rgb[2]
      colors[o + 3] = alpha
    }
  }
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 4))
}

/** An extruded section outline drawn as a translucent overlay. */
export interface BeamOutline {
  profile: [number, number][]
  length: number
}

function unit(axis: number, sign: number): Vector3 {
  const vector = new Vector3()
  vector.setComponent(axis, sign)
  return vector
}

function bboxOfVertices(vertices: number[]): Box3 {
  const box = new Box3()
  const point = new Vector3()
  for (let i = 0; i + 2 < vertices.length; i += 3) {
    box.expandByPoint(point.set(vertices[i], vertices[i + 1], vertices[i + 2]))
  }
  return box
}

function transformVertices(vertices: number[], matrix: Matrix4): number[] {
  const out = new Array<number>(vertices.length)
  const point = new Vector3()
  for (let i = 0; i + 2 < vertices.length; i += 3) {
    point.set(vertices[i], vertices[i + 1], vertices[i + 2]).applyMatrix4(matrix)
    out[i] = point.x
    out[i + 1] = point.y
    out[i + 2] = point.z
  }
  return out
}

/**
 * Seats a model in `profile`'s canonical frame: rotate its length axis to X, then roll about X
 * so the cross-section matches the profile. Manufactured (NC-built) and STEP models therefore
 * land in the *same* orientation, and the two never disagree in split/overlay views.
 */
function seatQuaternion(vertices: number[], profile: [number, number][] | undefined): Quaternion {
  if (!profile || profile.length < 3 || vertices.length < 9) return new Quaternion()
  const box = bboxOfVertices(vertices)
  const size = box.getSize(new Vector3())
  const centre = box.getCenter(new Vector3())
  const extents = [size.x, size.y, size.z]
  const longAxis = extents.indexOf(Math.max(...extents))

  const toX = new Quaternion()
  if (longAxis !== 0) toX.setFromUnitVectors(unit(longAxis, 1), unit(0, 1))

  const seated = transformVertices(
    vertices.map((value, index) =>
      // centre first (every 3rd component set is a point)
      index % 3 === 0 ? value - centre.x : index % 3 === 1 ? value - centre.y : value - centre.z,
    ),
    new Matrix4().makeRotationFromQuaternion(toX),
  )
  const roll = new Quaternion().setFromAxisAngle(
    unit(0, 1),
    SEAT_ANGLES[detectOrientation(profile, seated, 1, 2, [0, 0, 0])],
  )
  return new Quaternion().multiplyQuaternions(roll, toX)
}

/** Extrudes a section outline along a basis and returns a translucent overlay. */
function extrudeOverlay(
  profile: [number, number][],
  holes: [number, number][][],
  length: number,
  xAxis: Vector3,
  yAxis: Vector3,
  dim?: boolean,
  color = GHOST_COLOR,
): Group {
  const shape = new Shape()
  shape.moveTo(profile[0][0], profile[0][1])
  for (let i = 1; i < profile.length; i++) shape.lineTo(profile[i][0], profile[i][1])
  shape.closePath()
  for (const hole of holes) {
    if (hole.length < 3) continue
    const path = new Path()
    path.moveTo(hole[0][0], hole[0][1])
    for (let i = 1; i < hole.length; i++) path.lineTo(hole[i][0], hole[i][1])
    path.closePath()
    shape.holes.push(path)
  }

  const zAxis = new Vector3().crossVectors(xAxis, yAxis)
  const geometry = new ExtrudeGeometry(shape, { depth: length, bevelEnabled: false })
  geometry.translate(0, 0, -length / 2)
  geometry.applyMatrix4(new Matrix4().makeBasis(xAxis, yAxis, zAxis))

  const group = new Group()
  group.add(
    new Mesh(
      geometry,
      new MeshStandardMaterial({
        color,
        transparent: true,
        opacity: dim ? 0.08 : 0.16,
        depthWrite: false,
        side: DoubleSide,
      }),
    ),
  )
  group.add(
    new LineSegments(
      new EdgesGeometry(geometry, 15),
      new LineBasicMaterial({
        color,
        transparent: true,
        opacity: dim ? 0.3 : 0.6,
      }),
    ),
  )
  return group
}

interface SceneHandle {
  dispose: () => void
  overlays: Group[]
  setFlip: (flip: boolean) => void
  setDiffVisible: (visible: boolean) => void
  setSabreVisible: (visible: boolean) => void
  /** Show only the span markers whose index is in `indices` (null = all; [] = none). */
  setVisibleSpans: (indices: number[] | null) => void
  /** Glow the sub-cut marker at `index` and dim the rest (null clears the hover highlight). */
  highlight: (index: number | null) => void
  /** Pull every synced viewport toward the geometry behind a finding code (null = whole model). */
  focus: (code: string | null, index?: number) => void
  diffStats: DiffStats | null
  diffPresence: DiffPresence | null
  runDiff: () => DiffStats | null
}

/** Share of each boolean direction vs the STEP ideal, for the overlay legend. */
export interface DiffStats {
  /** STEP-minus-manufactured share of the manufactured volume (red = overcut, scrap) */
  over: number
  /** manufactured-minus-STEP share (blue = undercut, can still be cut) */
  under: number
  tolerance: number
  /** true when the CSG kernel couldn't run and red surface flagging was used instead */
  approximate: boolean
}

/** Concatenates every body's triangles into one index soup (offsets match `meshed.vertices`). */
function concatTriangles(meshed: MeshedStep): { triangles: number[]; offsets: number[] } {
  const triangles: number[] = []
  const offsets: number[] = []
  let vertexBase = 0
  for (const body of meshed.bodies) {
    offsets.push(Math.floor(triangles.length / 3))
    const local = body.mesh.faces.triangles
    for (let i = 0; i < local.length; i++) triangles.push(local[i] + vertexBase)
    vertexBase += Math.floor(body.mesh.faces.vertices.length / 3)
  }
  return { triangles, offsets }
}

/**
 * Builds a red overlay geometry from the subset of a body's triangles flagged as
 * different. Local coordinates — the mesh joins the model's seated group so it
 * follows the model (including the manual flip).
 */
function buildDiffGeometry(
  localVertices: number[],
  localTriangles: number[],
  mask: Uint8Array,
  triOffset: number,
): BufferGeometry | null {
  const index: number[] = []
  const triCount = Math.floor(localTriangles.length / 3)
  for (let t = 0; t < triCount; t++) {
    if (mask[triOffset + t] === 1) {
      index.push(localTriangles[t * 3], localTriangles[t * 3 + 1], localTriangles[t * 3 + 2])
    }
  }
  if (index.length === 0) return null
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(localVertices, 3))
  geometry.setIndex(index)
  geometry.computeVertexNormals()
  geometry.computeBoundingBox()
  return geometry
}

/** Builds the three.js scene for a set of meshes and returns a disposer. */
function mountScene(
  container: HTMLElement,
  step: MeshedStep,
  compareStep: MeshedStep | null,
  stock: StockOutline | null,
  beam: BeamOutline | null,
  bus: OrbitBus | null,
  highlightStray: boolean,
  smoothModelLines: boolean,
  primaryBytes: Uint8Array | null | undefined,
  compareBytes: Uint8Array | null | undefined,
  deferDiff?: boolean,
  sabre?: CutReachFailure[] | null,
  nc?: NcGeometry | null,
  ncSection?: [number, number][] | null,
  faceFrame?: NcFaceFrame | null,
  onLocationChange?: (locationMm: number) => void,
  onAxisAngleChange?: (degrees: number) => void,
): SceneHandle {
  const renderer = new WebGLRenderer({ antialias: true, alpha: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setSize(container.clientWidth || 1, container.clientHeight || 1)
  container.appendChild(renderer.domElement)

  const scene = new Scene()
  scene.add(new AmbientLight(0xffffff, 0.6))
  scene.add(new HemisphereLight(0xf2f7ff, 0x1a2733, 0.9))
  const key = new DirectionalLight(0xffffff, 2.6)
  key.position.set(0.8, 1, 0.9)
  scene.add(key)
  const fill = new DirectionalLight(0xffffff, 1.1)
  fill.position.set(-1, -0.6, -0.8)
  scene.add(fill)

  const profile =
    Array.isArray(stock?.points) && stock.points.length >= 3 ? stock.points : undefined

  const buildGroup = (
    meshed: MeshedStep,
    material: MeshStandardMaterial,
    withLines: boolean,
    strayMaterial: MeshStandardMaterial | null,
  ) => {
    const geometries = syncGeometries(
      meshed.bodies.map((body) => body.mesh),
      [],
    )
    const group = new Group()
    geometries.forEach((geometry, index) => {
      const body = meshed.bodies[index]
      group.add(new Mesh(geometry.faces, strayMaterial && body.stray ? strayMaterial : material))
      if (withLines) {
        // Manufactured (NC-rebuilt) models carry boolean shards and dense outline chains in
        // their OCC edges — straight lines across flats that read as cuts. Re-derive the
        // lines by dihedral angle so only real cut edges draw.
        if (smoothModelLines) smoothLines(geometry.lines, geometry.faces)
        group.add(new LineSegments(geometry.lines, lineMaterial))
      }
    })
    const raw = meshed.vertices
    const seat = profile ? seatQuaternion(raw, profile) : new Quaternion()
    const box = bboxOfVertices(raw)
    const centre = box.getCenter(new Vector3())
    group.quaternion.copy(seat)
    group.position.copy(centre.applyQuaternion(seat)).negate()
    group.updateMatrixWorld(true)
    return { group, geometries, raw }
  }

  const faceMaterial = new MeshStandardMaterial(FACE_MATERIAL)
  const strayMaterial = new MeshStandardMaterial({
    color: STRAY_COLOR,
    emissive: 0x9a3412,
    emissiveIntensity: 0.45,
    metalness: 0.25,
    roughness: 0.55,
  })
  const lineMaterial = new LineBasicMaterial({ color: 0x0b0f14 })
  const compareMaterial = new MeshStandardMaterial({
    color: COMPARE_COLOR,
    transparent: true,
    opacity: 0.4,
    depthWrite: false,
    side: DoubleSide,
    metalness: 0.2,
    roughness: 0.6,
  })
  const materials: Material[] = [faceMaterial, strayMaterial, lineMaterial]

  // Overlay mode (a second model is present): the manufactured base keeps the *same* solid grey
  // settings as every other pane — only the diff solid gets special treatment. The compare (STEP)
  // shell is see-through, so where the ideal extends past the manufactured part still shows.
  const isOverlay = Boolean(compareStep && compareStep.bodies.length > 0)
  if (isOverlay) {
    compareMaterial.opacity = 0.3
  }

  // Always draw the model's angle-filtered edges (`smoothModelLines`) so sharp corners read on
  // every pane, including the manufactured NC rebuild — the projected toolpath adds to them
  // rather than standing in for them.
  const primary = buildGroup(step, faceMaterial, true, highlightStray ? strayMaterial : null)
  const size = bboxOfVertices(primary.raw).getSize(new Vector3())
  scene.add(primary.group)

  const compareGeometries: ReturnType<typeof syncGeometries>[] = []
  let compareGroup: Group | null = null
  let compareBaseQuaternion: Quaternion | null = null
  if (compareStep && compareStep.bodies.length > 0) {
    materials.push(compareMaterial)
    const compare = buildGroup(compareStep, compareMaterial, false, null)
    compareGeometries.push(compare.geometries)
    compareGroup = compare.group
    compareBaseQuaternion = compare.group.quaternion.clone()
    scene.add(compareGroup)
  }

  // Stock ghost, seated in the same canonical frame as the model.
  const overlays: Group[] = []
  // Projected NC toolpath lines (only on the manufactured pane), parented to the scene in the
  // same seated frame as the model so they land on the surfaces the laser actually cut.
  const ncObjects: LineSegments2[] = []
  const ncMaterials: LineMaterial[] = []
  const ncResolution = new Vector2(container.clientWidth || 1, container.clientHeight || 1)
  // Red bevel arrows at uncuttable cuts (light-sabre failures) — toggled as one object.
  const sabreObjects: LineSegments2[] = []
  /** One span marker per failing sub-cut, indexed like `sabreFailures`, so a finding can zoom in. */
  const sabreSpanObjects: (LineSegments2 | null)[] = []
  /** View direction (scene) to look onto each failing cut's face from, indexed like the markers. */
  const sabreDirections: Vec3[] = []
  /** Glow halo behind each span marker, shown only while its issue row is hovered. */
  const sabreHaloObjects: (LineSegments2 | null)[] = []
  /** Span markers currently shown by the eye toggles (index → visible), before hover overrides. */
  const spanShown: boolean[] = []
  /** Index of the hovered finding's sub-cut, or null when nothing is hovered. */
  let hoverSpan: number | null = null
  /** Whether sabre markers are enabled at all (the toolbar toggle); hover can't reveal them off. */
  let sabreVisible = true
  const extents = [size.x, size.y, size.z]
  const nativeLongAxis = extents.indexOf(Math.max(...extents))
  const length = extents[nativeLongAxis]
  // When a profile is present the model is seated with its length along X, so the ghost's
  // length axis is X too; otherwise fall back to the model's own longest axis.
  const longAxis = profile ? 0 : nativeLongAxis
  if (profile) {
    const worldVertices = transformVertices(primary.raw, primary.group.matrixWorld)
    const cross = [0, 1, 2].filter((axis) => axis !== longAxis)
    const orientation = detectOrientation(profile, worldVertices, cross[0], cross[1], [0, 0, 0])
    const eA = unit(cross[0], 1)
    const eB = unit(cross[1], 1)
    const [xAxis, yAxis] = [
      [eA, eB],
      [eB, eA.clone().negate()],
      [eA.clone().negate(), eB.clone().negate()],
      [eB.clone().negate(), eA],
    ][orientation]
    const overlay = extrudeOverlay(
      profile,
      Array.isArray(stock?.holes) ? stock.holes : [],
      length,
      xAxis,
      yAxis,
      isOverlay,
      STOCK_COLOR,
    )
    scene.add(overlay)
    overlays.push(overlay)

    // Cut-reach markers project onto the section frame; the NC toolpath is separate (only when
    // `nc` is present, so the STEP/overlay panes show markers without the toolpath).
    const section = ncSection ?? profile
    const frame = faceFrame ?? (nc ? resolveNcFaceFrame(section, nc) : null)
    if (frame) {
      const OFF = 0.4
      const toScene = (along: number, cross: [number, number], face: NcFace): Vec3 => {
        const n = faceNormal(frame, face)
        const local: [number, number] = [cross[0], cross[1]]
        local[n.axis] += n.sign * OFF
        const x = along - length / 2
        return [
          x + local[0] * xAxis.x + local[1] * yAxis.x,
          local[0] * xAxis.y + local[1] * yAxis.y,
          local[0] * xAxis.z + local[1] * yAxis.z,
        ]
      }
      const normal = (face: NcFace): Vec3 => {
        const n = faceNormal(frame, face)
        const base = n.axis === 0 ? xAxis : yAxis
        return [base.x * n.sign, base.y * n.sign, base.z * n.sign]
      }
      // The NC toolpath (cut lines, holes) — only on panes that pass `nc`. Issue markers are
      // drawn separately (toggle-driven), not as toolpath danger marks.
      if (nc) {
        for (const line of addNcLines(
          nc,
          { frame, section, toScene, normal },
          ncResolution,
          ncMaterials,
        )) {
          scene.add(line)
          ncObjects.push(line)
        }
      }
      // The uncuttable subsection of each failing cut, drawn as a red marker spanning from its
      // start to its end (both in NC face coords → projected with the shared `toScene`). One
      // object per failure, so a clicked finding can zoom to its own sub-cut.
      if (sabre && sabre.length > 0) {
        for (const failure of sabre) {
          // Look at the cut from its own face, tilted off-axis so the camera never looks straight
          // down (which would make the up-vector ambiguous).
          const faceDir = normal(failure.face)
          sabreDirections.push([faceDir[0] + 0.45, faceDir[1] + 0.45, faceDir[2] + 0.45])
          // A failure can collapse to a point (a corner-risk run of a single sample). Draw a short
          // tick along the member so it still reads in the 3D.
          let from = failure.from
          let to = failure.to
          if (Math.hypot(to[0] - from[0], to[1] - from[1]) < 0.1) {
            const half = SABRE_TICK_MM / 2
            from = [failure.from[0] - half, failure.from[1]]
            to = [failure.from[0] + half, failure.from[1]]
          }
          const a = placeNcFace(frame, failure.face, from[0], from[1]).cross
          const b = placeNcFace(frame, failure.face, to[0], to[1]).cross
          const pA = toScene(from[0], a, failure.face)
          const pB = toScene(to[0], b, failure.face)
          const positions = [pA[0], pA[1], pA[2], pB[0], pB[1], pB[2]]
          const mark = ncLineObject(positions, SABRE_CUT_COLOR, ncResolution, ncMaterials, true)
          if (mark) {
            scene.add(mark)
            sabreObjects.push(mark)
            sabreSpanObjects.push(mark)
            spanShown.push(false)
            const halo = ncHaloObject(positions, SABRE_CUT_COLOR, ncResolution, ncMaterials)
            if (halo) scene.add(halo)
            sabreHaloObjects.push(halo)
          } else {
            sabreSpanObjects.push(null)
            spanShown.push(false)
            sabreHaloObjects.push(null)
          }
        }
      }
    }
  }
  if (beam && Array.isArray(beam.profile) && beam.profile.length >= 3 && beam.length > 0) {
    const overlay = extrudeOverlay(beam.profile, [], beam.length, unit(0, 1), unit(1, 1), isOverlay)
    scene.add(overlay)
    overlays.push(overlay)

    // The nested cut-beam lives in its own frame (length along Z, width X, depth Y): the NC
    // toolpath for each nested piece sits directly on it, so the transverse cuts and holes
    // read on the solid that the beam NC produces.
    if (nc) {
      const frame = resolveNcFaceFrame(beam.profile, nc)
      const OFF = 0.6
      const toScene = (along: number, cross: [number, number], face: NcFace): Vec3 => {
        const n = faceNormal(frame, face)
        const local: [number, number] = [cross[0], cross[1]]
        local[n.axis] += n.sign * OFF
        return [local[0], local[1], along - beam.length / 2]
      }
      const normal = (face: NcFace): Vec3 => {
        const n = faceNormal(frame, face)
        return n.axis === 0 ? [n.sign, 0, 0] : [0, n.sign, 0]
      }
      for (const line of addNcLines(
        nc,
        { frame, section: beam.profile, toScene, normal },
        ncResolution,
        ncMaterials,
      )) {
        scene.add(line)
        ncObjects.push(line)
      }
    }
  }

  // Frame the model and overlays in view.
  const fit = new Box3().expandByObject(primary.group)
  if (compareGroup) fit.expandByObject(compareGroup)
  for (const overlay of overlays) fit.expandByObject(overlay)
  const fitSize = fit.getSize(new Vector3())
  const fitCentre = fit.getCenter(new Vector3())

  // Signed-distance deviation overlays, with the STEP treated as nominal. Both groups are already
  // seated in the same frame, so the deviation runs in world coordinates: red = overcut (the
  // manufactured surface sits inside the ideal — scrap), blue = undercut (outside the ideal —
  // leftover that can still be cut). Measuring distances rather than intersecting surfaces keeps
  // near-coincident models stable (see docs/architecture.md). When the deviation path can't run
  // (over budget), fall back to red surface-distance flagging.
  //
  // The multi-second measurement is deferred: the component paints the models plus a fast
  // presence verdict first, then runs the full deviation after paint.
  const diffMeshes: Mesh[] = []
  const diffEdgeLines: LineSegments[] = []
  let diffStats: DiffStats | null = null
  let diffPresence: DiffPresence | null = null
  const soups = (meshed: MeshedStep) =>
    meshed.bodies.map((body) => ({
      vertices: body.mesh.faces.vertices,
      triangles: body.mesh.faces.triangles,
    }))
  // The diff fill is an open shell (only the faces standing past tolerance are kept), so on its
  // own it reads as a floating skin. Outlining its sharp corners makes the over/under region read
  // as a bounded volume. A high dihedral bar (`DIFF_EDGE_THRESHOLD_DEG`) keeps only real corners
  // and drops the curve/curve-facet lines across the diff's smooth faces. Depth test off, like
  // the fill, so the edges never hide behind the shell they bound.
  const addDiffEdges = (geometry: BufferGeometry, color: number, parent: Object3D): void => {
    const edges = new EdgesGeometry(geometry, DIFF_EDGE_THRESHOLD_DEG)
    if ((edges.getAttribute('position')?.count ?? 0) === 0) {
      edges.dispose()
      return
    }
    const material = new LineBasicMaterial({
      color,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    })
    const lines = new LineSegments(edges, material)
    lines.renderOrder = 12
    lines.layers.set(1)
    parent.add(lines)
    diffEdgeLines.push(lines)
    materials.push(material)
  }
  const runDiff = (): DiffStats | null => {
    if (!compareStep || !compareGroup || diffStats) return diffStats
    const diagonal = Math.hypot(fitSize.x, fitSize.y, fitSize.z)
    const tolerance = resolveDiffTolerance(diagonal)
    const diff =
      primaryBytes && compareBytes
        ? cachedDeviationDiff(
            soups(step),
            soups(compareStep),
            primary.group.matrixWorld,
            compareGroup.matrixWorld,
            primaryBytes,
            compareBytes,
          )
        : deviationDiff(
            soups(step),
            soups(compareStep),
            primary.group.matrixWorld,
            compareGroup.matrixWorld,
          )
    if (diff) {
      // Signed-distance deviation patches on the manufactured surface: red = overcut (made short
      // vs the ideal), blue = undercut (leftover). Opaque/unlit, and a small polygon offset lifts
      // them just clear of the base surface they sit on, so they win the depth test without
      // z-fighting. No boolean ⇒ no slivers or skins to smooth away (see docs/architecture.md).
      const overcutMaterial = new MeshBasicMaterial({
        color: 0xffffff,
        vertexColors: true,
        side: DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      })
      const undercutMaterial = new MeshBasicMaterial({
        color: 0xffffff,
        vertexColors: true,
        side: DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      })
      materials.push(overcutMaterial, undercutMaterial)
      if (diff.over) {
        paintDiffAlpha(diff.over, diff.overDistance, OVERCUT_RGB)
        const mesh = new Mesh(diff.over, overcutMaterial)
        mesh.layers.set(1)
        scene.add(mesh)
        diffMeshes.push(mesh)
        addDiffEdges(diff.over, OVERCUT_COLOR, scene)
      }
      if (diff.under) {
        paintDiffAlpha(diff.under, diff.underDistance, UNDERCUT_RGB)
        const mesh = new Mesh(diff.under, undercutMaterial)
        mesh.layers.set(1)
        scene.add(mesh)
        diffMeshes.push(mesh)
        addDiffEdges(diff.under, UNDERCUT_COLOR, scene)
      }
      const volume = diff.primaryVolume > 0 ? diff.primaryVolume : 1
      diffStats = {
        over: diff.overVolume / volume,
        under: diff.underVolume / volume,
        tolerance: DEVIATION_TOLERANCE_MM,
        approximate: false,
      }
    } else {
      const primaryWorld = transformVertices(primary.raw, primary.group.matrixWorld)
      const compareWorld = transformVertices(compareStep.vertices, compareGroup.matrixWorld)
      const primaryTris = concatTriangles(step)
      const compareTris = concatTriangles(compareStep)
      const { aDiff, bDiff } = computeDiffMasks(
        primaryWorld,
        primaryTris.triangles,
        compareWorld,
        compareTris.triangles,
        tolerance,
      )
      const diffMaterial = new MeshBasicMaterial({
        color: OVERCUT_COLOR,
        side: DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      })
      materials.push(diffMaterial)
      step.bodies.forEach((body, index) => {
        const geometry = buildDiffGeometry(
          body.mesh.faces.vertices,
          body.mesh.faces.triangles,
          aDiff,
          primaryTris.offsets[index],
        )
        if (!geometry) return
        const mesh = new Mesh(geometry, diffMaterial)
        mesh.layers.set(1)
        primary.group.add(mesh)
        diffMeshes.push(mesh)
        addDiffEdges(geometry, OVERCUT_COLOR, primary.group)
      })
      compareStep.bodies.forEach((body, index) => {
        const geometry = buildDiffGeometry(
          body.mesh.faces.vertices,
          body.mesh.faces.triangles,
          bDiff,
          compareTris.offsets[index],
        )
        if (!geometry) return
        const mesh = new Mesh(geometry, diffMaterial)
        mesh.layers.set(1)
        compareGroup.add(mesh)
        diffMeshes.push(mesh)
        addDiffEdges(geometry, OVERCUT_COLOR, compareGroup)
      })
      diffStats = {
        over: diffFraction(aDiff),
        under: diffFraction(bDiff),
        tolerance,
        approximate: true,
      }
    }
    return diffStats
  }

  // Fast presence probe (~0.3 s on real parts): enough to report "differences
  // found, building the full overlay" long before the multi-second boolean.
  if (compareStep && compareGroup) {
    primary.group.updateMatrixWorld(true)
    compareGroup.updateMatrixWorld(true)
    diffPresence = probeDiffPresence(
      soups(step),
      soups(compareStep),
      primary.group.matrixWorld,
      compareGroup.matrixWorld,
    )
  }
  if (!deferDiff) runDiff()

  // An uncuttable cut (light-sabre failure) is shown as a red error arrow on its bevel — built in
  // `addNcLines` and collected into `sabreObjects` — not as a red surface patch.

  const maxDim = Math.max(fitSize.x, fitSize.y, fitSize.z) || 1
  // Cover the model's bounding-box diagonal, so it is never cropped at any preset view or
  // free-orbit angle (a fixed `maxDim` frame cuts long or wide parts).
  const diameter = Math.hypot(fitSize.x, fitSize.y, fitSize.z) || maxDim
  const MARGIN = 1.06
  const baseHalf = (diameter / 2) * MARGIN

  const camera = new OrthographicCamera(
    -baseHalf,
    baseHalf,
    baseHalf,
    -baseHalf,
    Math.max(maxDim / 1000, 0.01),
    maxDim * 100,
  )

  // Default to a true isometric angle: equal X/Y/Z so no axis is foreshortened.
  const distance = maxDim * 2
  camera.position.copy(fitCentre).add(new Vector3(1, 1, 1).normalize().multiplyScalar(distance))
  camera.lookAt(fitCentre)

  const applyFrustum = (width: number, height: number) => {
    const aspect = width / height || 1
    const halfHeight = Math.max(baseHalf, baseHalf / aspect)
    const halfWidth = halfHeight * aspect
    camera.left = -halfWidth
    camera.right = halfWidth
    camera.top = halfHeight
    camera.bottom = -halfHeight
    camera.updateProjectionMatrix()
  }
  applyFrustum(container.clientWidth || 1, container.clientHeight || 1)

  const controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  controls.dampingFactor = 0.08
  // Zoom where the pointer is, not always toward the centre — far handier for inspecting a part.
  controls.zoomToCursor = true

  // Snap the orbit pivot onto the beam's longitudinal centre line. Seating places the model's
  // bbox centre at the origin, so the centre line is the model's long axis through the origin.
  // Pan may slide along the beam and cursor-zoom may nudge the target, but the pivot can never
  // leave the line — so orbiting always turns the beam about its own axis instead of swinging it
  // around an off-axis point. Mirrors the NC beam viewer's pivot confinement.
  const crossAxes = [0, 1, 2].filter((axis) => axis !== longAxis)
  const axisCentre = fitCentre.clone()
  for (const axis of crossAxes) axisCentre.setComponent(axis, 0)
  const pivotShift = axisCentre.clone().sub(fitCentre)
  camera.position.add(pivotShift)
  controls.target.copy(axisCentre)
  camera.lookAt(controls.target)

  const axisLimit = length / 2
  const confinePivot = (): void => {
    const along = Math.max(-axisLimit, Math.min(axisLimit, controls.target.getComponent(longAxis)))
    const next = new Vector3()
    next.setComponent(longAxis, along)
    if (controls.target.equals(next)) return
    const delta = next.clone().sub(controls.target)
    controls.target.copy(next)
    camera.position.add(delta)
  }
  controls.addEventListener('change', confinePivot)

  const detachOrbit = bus
    ? attachOrbit(bus, camera, controls, {
        centre: [axisCentre.x, axisCentre.y, axisCentre.z],
        distance,
        radius: baseHalf,
        axis: longAxis as 0 | 1 | 2,
        length,
      })
    : null
  const detachWheelPan = attachWheelPan(container, controls, camera, longAxis as 0 | 1 | 2)

  // Report the pivot's location along the member for the toolbar readout. The pivot is snapped to
  // the model's centre line, so along `longAxis` it runs from one end (-length/2) to the other
  // (+length/2); shift to a 0…length location. Fire only on noticeable change (the pivot only
  // moves when panning / focus-zooming, not when orbiting).
  let lastLocation = Number.NaN
  const reportLocation = (): void => {
    if (!onLocationChange) return
    const location = controls.target.getComponent(longAxis) + length / 2
    if (!Number.isFinite(location) || Math.abs(location - lastLocation) < 0.5) return
    lastLocation = location
    onLocationChange(location)
  }
  controls.addEventListener('change', reportLocation)
  reportLocation()

  let raf = 0
  // The diff lives on layer 1 and renders in a second pass after the depth buffer is cleared, so
  // it always sits on top of the base (never hidden by it) yet still self-occludes and shows its
  // own far side hidden — a solid floating over the part.
  renderer.autoClear = false
  // Report the on-screen angle of the member's positive axis (project a unit step of `longAxis`),
  // so the toolbar can show a direction arrow next to the location readout.
  const axisOrigin = new Vector3()
  const axisTip = new Vector3()
  let lastAxisAngle = Number.NaN
  const updateAxisAngle = (): void => {
    if (!onAxisAngleChange) return
    axisOrigin.copy(controls.target).project(camera)
    axisTip.copy(controls.target)
    axisTip.setComponent(longAxis, axisTip.getComponent(longAxis) + 1)
    axisTip.project(camera)
    const dx = axisTip.x - axisOrigin.x
    const dy = axisTip.y - axisOrigin.y
    if (dx * dx + dy * dy < 1e-8) return
    const degrees = (Math.atan2(-dy, dx) * 180) / Math.PI
    if (Math.abs(degrees - lastAxisAngle) < 0.5) return
    lastAxisAngle = degrees
    onAxisAngleChange(degrees)
  }
  const render = () => {
    controls.update()
    renderer.clear()
    camera.layers.set(0)
    renderer.render(scene, camera)
    renderer.clearDepth()
    camera.layers.set(1)
    renderer.render(scene, camera)
    updateAxisAngle()
    raf = requestAnimationFrame(render)
  }
  render()

  const resize = () => {
    const width = container.clientWidth
    const height = container.clientHeight
    if (!width || !height) return
    renderer.setSize(width, height)
    applyFrustum(width, height)
    for (const material of ncMaterials) material.resolution.set(width, height)
  }
  const observer = new ResizeObserver(resize)
  observer.observe(container)

  // Applies the eye toggles, the sabre toggle and the hovered index together: the hovered marker
  // is forced on (even if its eye is off) and pops bright with a halo, while the rest dim so it
  // stands out. Every other marker keeps its toggled visibility at base opacity.
  const refreshSpanAppearance = (): void => {
    for (let i = 0; i < sabreSpanObjects.length; i++) {
      const mark = sabreSpanObjects[i]
      if (!mark) continue
      const highlighted = hoverSpan != null && i === hoverSpan
      const visible = sabreVisible && (highlighted || spanShown[i] === true)
      mark.visible = visible
      const material = mark.material as LineMaterial
      material.linewidth = highlighted ? SABRE_HIGHLIGHT_WIDTH : NC_LINE_WIDTH
      material.opacity = highlighted ? 1 : hoverSpan != null ? SABRE_DIM_OPACITY : 0.98
      const halo = sabreHaloObjects[i]
      if (halo) halo.visible = highlighted && visible
    }
  }

  return {
    overlays,
    diffStats,
    diffPresence,
    runDiff,
    setFlip(flip: boolean) {
      if (!compareGroup || !compareBaseQuaternion) return
      compareGroup.quaternion.copy(compareBaseQuaternion)
      compareGroup.rotateOnAxis(unit(0, 1), flip ? Math.PI : 0)
    },
    setDiffVisible(visible: boolean) {
      for (const mesh of diffMeshes) mesh.visible = visible
      for (const lines of diffEdgeLines) lines.visible = visible
    },
    setSabreVisible(visible: boolean) {
      sabreVisible = visible
      refreshSpanAppearance()
    },
    setVisibleSpans(indices: number[] | null) {
      const set = indices == null ? null : new Set(indices)
      for (let i = 0; i < sabreSpanObjects.length; i++) spanShown[i] = set == null || set.has(i)
      refreshSpanAppearance()
    },
    /** Hover highlight: glow the marker at `index` (force-shown), dim the rest (null = clear). */
    highlight(index: number | null) {
      hoverSpan = index
      refreshSpanAppearance()
    },
    focus(code: string | null, index?: number) {
      if (!bus) return
      const box = new Box3()
      const cut = code?.startsWith('CUT') ?? false
      let direction: Vec3 | undefined
      if (cut) {
        // A specific sub-cut (clicked from the issues list) rotates onto and frames just that one;
        // otherwise frame *all* checked sub-cuts, then every marker, then the toolpath.
        if (index != null && sabreSpanObjects[index]) {
          box.expandByObject(sabreSpanObjects[index])
          direction = sabreDirections[index]
        } else {
          for (const object of sabreSpanObjects) {
            if (object?.visible) box.expandByObject(object)
          }
        }
        if (box.isEmpty()) for (const lines of sabreObjects) box.expandByObject(lines)
        if (box.isEmpty()) for (const line of ncObjects) box.expandByObject(line)
      }
      if (box.isEmpty()) box.expandByObject(primary.group)
      if (box.isEmpty()) return
      const centre = box.getCenter(new Vector3())
      const size = box.getSize(new Vector3())
      // A little margin so the framed cut isn't jammed against the viewport edge.
      const radius = Math.max(Math.hypot(size.x, size.y, size.z) / 2, 1) * 1.4
      requestFocus(bus, { point: [centre.x, centre.y, centre.z], radius, direction })
    },
    dispose() {
      cancelAnimationFrame(raf)
      observer.disconnect()
      detachOrbit?.()
      detachWheelPan()
      controls.removeEventListener('change', confinePivot)
      controls.removeEventListener('change', reportLocation)
      controls.dispose()
      for (const geometry of primary.geometries) {
        geometry.faces.dispose()
        geometry.lines.dispose()
      }
      for (const geometries of compareGeometries) {
        for (const geometry of geometries) {
          geometry.faces.dispose()
          geometry.lines.dispose()
        }
      }
      for (const mesh of diffMeshes) mesh.geometry.dispose()
      for (const lines of diffEdgeLines) lines.geometry.dispose()
      for (const line of ncObjects) {
        line.geometry.dispose()
        ;(line.material as LineMaterial).dispose()
      }
      for (const lines of sabreObjects) {
        scene.remove(lines)
        lines.geometry.dispose()
        ;(lines.material as LineMaterial).dispose()
      }
      for (const halo of sabreHaloObjects) {
        if (!halo) continue
        scene.remove(halo)
        halo.geometry.dispose()
        ;(halo.material as LineMaterial).dispose()
      }
      for (const material of materials) material.dispose()
      for (const overlay of overlays) {
        overlay.traverse((object) => {
          if (object instanceof Mesh || object instanceof LineSegments) {
            object.geometry.dispose()
            const material = object.material
            if (Array.isArray(material)) for (const item of material) item.dispose()
            else material.dispose()
          }
        })
      }
      renderer.dispose()
      renderer.domElement.remove()
    },
  }
}

export interface PartViewerProps {
  name: string
  bytes: Uint8Array | undefined
  /** optional second model rendered translucent on top of `bytes` (e.g. STEP over the NC build) */
  compareBytes?: Uint8Array | null
  compareLabel?: string
  stock?: StockOutline | null
  beam?: BeamOutline | null
  bus?: OrbitBus | null
  /** highlight stray floating bodies in orange, to tell them from the real part (STEP debug) */
  highlightStray?: boolean
  /**
   * Re-derive the primary model's edge lines by dihedral angle instead of drawing OCC's
   * tessellated edges. For manufactured (NC-rebuilt) models, whose booleans leave shard
   * lines across flat faces that read as cuts.
   */
  smoothLines?: boolean
  /** cut-reach failures (a bevel whose bore is past the pierce cap) — drawn at their NC cut */
  sabreFailures?: CutReachFailure[] | null
  /** NC toolpath geometry to project onto this (manufactured) model */
  nc?: NcGeometry | null
  /** Exact (un-inflated) section outline the NC was matched against, for the projection */
  ncSection?: [number, number][] | null
  /** Pre-resolved section face frame, so markers project without needing the NC geometry. */
  faceFrame?: NcFaceFrame | null
  /** Clicked-finding focus: bump `token` to pull every viewport to `code`'s geometry (optionally a
   * specific failing sub-cut, by `index`). */
  focus?: { code: string; token: number; index?: number } | null
  /** Which failing sub-cut markers to show, by index (null/undefined = all; [] = none). */
  visibleSpans?: number[] | null
  /** Hovered finding's sub-cut index: glow that marker and dim the others (null = no highlight). */
  highlight?: number | null
  /** Live location (mm, from one end) of the orbit pivot along the member, for the "where am I". */
  onLocationChange?: (locationMm: number) => void
  /** On-screen angle (deg, clockwise from +x) of the member's positive axis, for the compass arrow. */
  onAxisAngleChange?: (degrees: number) => void
  /** Controlled overlay toggles (shared toolbar). Omit to keep the per-pane buttons. */
  showStock?: boolean
  onShowStockChange?: (visible: boolean) => void
  flipped?: boolean
  onFlippedChange?: (flipped: boolean) => void
  showDiff?: boolean
  onShowDiffChange?: (visible: boolean) => void
  showSabre?: boolean
  onShowSabreChange?: (visible: boolean) => void
  /** Hide the in-pane control buttons (the shared toolbar drives the toggles instead). */
  hideControls?: boolean
}

export default function PartViewer({
  name,
  bytes,
  compareBytes = null,
  compareLabel = 'overlay',
  stock = null,
  beam = null,
  bus = null,
  highlightStray = false,
  smoothLines: smoothModelLines = false,
  sabreFailures = null,
  nc = null,
  ncSection = null,
  faceFrame = null,
  focus = null,
  visibleSpans = null,
  highlight = null,
  onLocationChange,
  onAxisAngleChange,
  showStock: showStockProp,
  onShowStockChange,
  flipped: flippedProp,
  onFlippedChange,
  showDiff: showDiffProp,
  onShowDiffChange,
  showSabre: showSabreProp,
  onShowSabreChange,
  hideControls = false,
}: PartViewerProps) {
  const { t } = useTranslation()
  const containerRef = useRef<HTMLDivElement>(null)
  const handleRef = useRef<SceneHandle | null>(null)
  // Keep the location / axis-angle callbacks in refs so fresh closures never restart the scene.
  const onLocationRef = useRef(onLocationChange)
  onLocationRef.current = onLocationChange
  const onAxisAngleRef = useRef(onAxisAngleChange)
  onAxisAngleRef.current = onAxisAngleChange
  const showStockRef = useRef(true)
  const showDiffRef = useRef(true)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [message, setMessage] = useState<string | null>(null)
  const [stockState, setStockState] = useState(true)
  const [flipState, setFlipState] = useState(false)
  const [hasStray, setHasStray] = useState(false)
  const [diffState, setDiffState] = useState(true)
  const [diffInfo, setDiffInfo] = useState<DiffStats | null>(null)
  const [diffPresence, setDiffPresence] = useState<DiffPresence | null>(null)
  const [sabreState, setSabreState] = useState(true)
  const flippedRef = useRef(false)
  // The four overlay toggles can be driven by a shared toolbar (controlled props) or fall back to
  // local state when the viewer is used standalone (e.g. the nesting viewer).
  const showStock = showStockProp ?? stockState
  const flipped = flippedProp ?? flipState
  const showDiff = showDiffProp ?? diffState
  const showSabre = showSabreProp ?? sabreState
  const toggleStock = () =>
    onShowStockChange ? onShowStockChange(!showStock) : setStockState((value) => !value)
  const toggleFlip = () =>
    onFlippedChange ? onFlippedChange(!flipped) : setFlipState((value) => !value)
  const toggleDiff = () =>
    onShowDiffChange ? onShowDiffChange(!showDiff) : setDiffState((value) => !value)
  const toggleSabre = () =>
    onShowSabreChange ? onShowSabreChange(!showSabre) : setSabreState((value) => !value)

  useEffect(() => {
    if (!bytes) {
      setStatus('error')
      setMessage(t('viewer.noModel'))
      return
    }
    let disposed = false
    let handle: SceneHandle | null = null
    setStatus('loading')
    setMessage(null)
    setFlipState(false)
    flippedRef.current = false
    setHasStray(false)
    setDiffInfo(null)
    setDiffPresence(null)

    meshForViewer(name, bytes)
      .then(async (step) => {
        const compare = compareBytes ? await meshForViewer(`${name}·compare`, compareBytes) : null
        return { step, compare }
      })
      .then(async ({ step, compare }) => {
        if (disposed || !containerRef.current) return
        if (step.bodies[0]?.mesh.faces.triangles.length === 0) {
          setStatus('error')
          setMessage(t('viewer.noGeometry'))
          return
        }
        handle = mountScene(
          containerRef.current,
          step,
          compare,
          stock,
          beam,
          bus,
          highlightStray,
          smoothModelLines,
          bytes,
          compareBytes,
          true,
          sabreFailures,
          nc,
          ncSection,
          faceFrame,
          (mm) => onLocationRef.current?.(mm),
          (degrees) => onAxisAngleRef.current?.(degrees),
        )
        for (const overlay of handle.overlays) overlay.visible = showStockRef.current
        handle.setFlip(false)
        handleRef.current = handle
        setHasStray(highlightStray && step.bodies.some((body) => body.stray))
        setDiffPresence(handle.diffPresence)
        setStatus('ready')
        if (!compare) return
        // Let the models and the presence verdict paint before the multi-second
        // boolean blocks the main thread.
        await new Promise((resolve) => requestAnimationFrame(resolve))
        if (disposed) return
        const stats = handle.runDiff()
        if (disposed) return
        handle.setDiffVisible(showDiffRef.current && !flippedRef.current)
        setDiffInfo(stats)
      })
      .catch((error: unknown) => {
        if (disposed) return
        setStatus('error')
        setMessage(error instanceof Error ? error.message : String(error))
      })

    return () => {
      disposed = true
      handle?.dispose()
      handleRef.current = null
    }
  }, [
    name,
    bytes,
    compareBytes,
    stock,
    beam,
    bus,
    highlightStray,
    smoothModelLines,
    sabreFailures,
    nc,
    ncSection,
    faceFrame,
    t,
  ])

  useEffect(() => {
    showStockRef.current = showStock
    for (const overlay of handleRef.current?.overlays ?? []) overlay.visible = showStock
  }, [showStock])

  useEffect(() => {
    handleRef.current?.setFlip(flipped)
    flippedRef.current = flipped
    // The red diff is only meaningful in the seated alignment — flipping spins the
    // overlay 180° about the length axis, so the diff hides until it is unflipped.
    handleRef.current?.setDiffVisible(showDiff && !flipped)
  }, [flipped, showDiff])

  useEffect(() => {
    showDiffRef.current = showDiff
  }, [showDiff])

  useEffect(() => {
    handleRef.current?.setSabreVisible(showSabre)
  }, [showSabre])

  // Show only the checked failing sub-cuts' markers (null = all, [] = none).
  useEffect(() => {
    if (status !== 'ready') return
    handleRef.current?.setVisibleSpans(showSabre ? visibleSpans : [])
  }, [visibleSpans, showSabre, status])

  // Hover highlight: glow the hovered row's sub-cut marker and dim the rest.
  useEffect(() => {
    if (status !== 'ready') return
    handleRef.current?.highlight(highlight)
  }, [highlight, status])

  // Clicking a finding pans/zooms/rotates the synced viewports to its geometry.
  const focusToken = focus?.token
  const focusCode = focus?.code ?? null
  const focusIndex = focus?.index
  useEffect(() => {
    if (focusToken === undefined) return
    handleRef.current?.focus(focusCode, focusIndex)
  }, [focusToken, focusCode, focusIndex])
  const hasOverlay = Boolean((stock || beam) && status === 'ready')
  const hasCompare = Boolean(compareBytes && status === 'ready')
  const hasSabre = Boolean(sabreFailures && sabreFailures.length > 0 && status === 'ready')
  const hasDiff = Boolean(hasCompare && diffInfo)
  const diffClean = diffInfo != null && diffInfo.over < 0.001 && diffInfo.under < 0.001
  // Fast probe verdict, shown while the exact boolean still runs.
  const diffFound = Boolean(hasCompare && !diffInfo && diffPresence?.found)

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full touch-none" />
      {/* Reticle marking the orbit pivot. It sits at the viewport centre because the camera always
          looks at the pivot (so panning slides the part past a fixed centre). */}
      <svg
        aria-hidden="true"
        viewBox="0 0 22 22"
        className="pointer-events-none absolute left-1/2 top-1/2 z-10 size-[22px] -translate-x-1/2 -translate-y-1/2 text-white/40 drop-shadow-[0_0_2px_rgba(0,0,0,0.85)]"
      >
        <line x1="11" y1="1" x2="11" y2="7.5" stroke="currentColor" strokeWidth="1.5" />
        <line x1="11" y1="14.5" x2="11" y2="21" stroke="currentColor" strokeWidth="1.5" />
        <line x1="1" y1="11" x2="7.5" y2="11" stroke="currentColor" strokeWidth="1.5" />
        <line x1="14.5" y1="11" x2="21" y2="11" stroke="currentColor" strokeWidth="1.5" />
        <circle cx="11" cy="11" r="1" fill="currentColor" />
      </svg>
      <div className={cn('absolute left-3 top-3 flex gap-1', hideControls && 'hidden')}>
        {hasOverlay && (
          <button
            type="button"
            onClick={toggleStock}
            className="rounded-md border border-border bg-card/80 px-2.5 py-1 text-xs font-medium backdrop-blur transition-colors hover:bg-accent"
          >
            {showStock ? t('viewer.hideStock') : t('viewer.showStock')}
          </button>
        )}
        {hasCompare && (
          <button
            type="button"
            onClick={toggleFlip}
            className="rounded-md border border-border bg-card/80 px-2.5 py-1 text-xs font-medium backdrop-blur transition-colors hover:bg-accent"
          >
            {t('viewer.flip', { label: compareLabel })}
          </button>
        )}
        {hasDiff && (
          <button
            type="button"
            onClick={toggleDiff}
            className="rounded-md border border-border bg-card/80 px-2.5 py-1 text-xs font-medium backdrop-blur transition-colors hover:bg-accent"
          >
            {showDiff ? t('viewer.hideDiff') : t('viewer.showDiff')}
          </button>
        )}
        {hasSabre && (
          <button
            type="button"
            onClick={toggleSabre}
            className="rounded-md border border-border bg-card/80 px-2.5 py-1 text-xs font-medium backdrop-blur transition-colors hover:bg-accent"
          >
            {showSabre ? t('viewer.hideSabre') : t('viewer.showSabre')}
          </button>
        )}
      </div>
      {hasStray && (
        <div className="pointer-events-none absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-2 rounded-md border border-orange-500/50 bg-card/80 px-2.5 py-1 text-xs font-medium text-orange-300 backdrop-blur">
          <span
            className="inline-block size-3 rounded-sm border border-orange-400"
            style={{ background: 'rgba(249, 115, 22, 0.5)' }}
          />
          {t('viewer.strayBody')}
        </div>
      )}
      {diffFound && !flipped && (
        <div className="absolute bottom-3 left-3 z-10 flex items-center gap-2 rounded-md border border-amber-500/50 bg-card/80 px-2.5 py-1 text-xs font-medium text-amber-300 backdrop-blur">
          <span
            className="inline-block size-3 animate-pulse rounded-sm border border-amber-400"
            style={{ background: 'rgba(245, 158, 11, 0.5)' }}
          />
          {t('viewer.buildingDiff')}
        </div>
      )}
      {hasDiff && !flipped && diffInfo && showDiff && (
        <div
          className="absolute bottom-3 left-3 z-10 flex items-center gap-2 rounded-md border border-border bg-card/80 px-2.5 py-1 text-xs font-medium backdrop-blur"
          title={
            t('viewer.diffTitle', {
              over: percent(diffInfo.over),
              under: percent(diffInfo.under),
            }) + (diffInfo.approximate ? '' : ` · ${t('viewer.facesHiddenNote')}`)
          }
        >
          {diffClean ? (
            <>
              <span
                className="inline-block size-3 rounded-sm border border-emerald-400"
                style={{ background: 'rgba(52, 211, 153, 0.5)' }}
              />
              <span className="text-emerald-300">{t('viewer.noDifferences')}</span>
            </>
          ) : diffInfo.approximate ? (
            <>
              <span
                className="inline-block size-3 rounded-sm border border-red-400"
                style={{ background: 'rgba(239, 68, 68, 0.65)' }}
              />
              <span className="text-red-300">{t('viewer.differences')}</span>
            </>
          ) : (
            <>
              <span
                className="inline-block size-3 rounded-sm border border-red-400"
                style={{ background: 'rgba(239, 68, 68, 0.65)' }}
              />
              <span className="text-red-300">{t('viewer.overcut')}</span>
              <span
                className="inline-block size-3 rounded-sm border border-blue-400"
                style={{ background: 'rgba(59, 130, 246, 0.65)' }}
              />
              <span className="text-blue-300">{t('viewer.undercut')}</span>
            </>
          )}
        </div>
      )}
      {status !== 'ready' && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center px-6 text-center">
          <p className="max-w-sm text-sm text-muted-foreground">
            {status === 'loading'
              ? t('viewer.loading')
              : t('viewer.couldNotRender', { error: message ?? t('viewer.unknownError') })}
          </p>
        </div>
      )}
    </div>
  )
}
