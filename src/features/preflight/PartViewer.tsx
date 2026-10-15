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
import type { CutMarker } from '@/lib/audit/cutReach'
import {
  faceHalf,
  faceNormal,
  faceSpanAxis,
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
import { CUT_FACES, faceRole, type ProfileFamily, profileFamily } from '@/lib/sections/canonical'
import type { StockOutline } from '@/lib/sections/stock'
import { type DiffPresence, probeDiffPresence } from '@/lib/step/booleanDiff'
import { brepCutSegments, cutEdgeThicknessAt, type SeatedBrepFace } from '@/lib/step/cutEdges'
import { projectCutEdgesToFaces } from '@/lib/step/cutProjection'
import { closeDiffMask, computeDiffMasks, diffFraction } from '@/lib/step/diffHighlight'
import type { MeshedStep } from '@/lib/step/mesh'
import { type DiffPayload, type DiffSolidPayload, OCC_FUZZY_MM } from '@/lib/step/occDiff'
import {
  bboxOfVertices,
  seatedPair,
  seatQuaternion,
  transformVertices,
  unit,
} from '@/lib/step/seat'
import { diffForViewer, meshForViewer } from '@/lib/step/viewerModel'
import { cn } from '@/lib/utils'
import { attachOrbit, attachWheelPan, type OrbitBus, requestFocus } from './orbitSync'
import { SMOOTH_LINE_THRESHOLD_DEG, smoothLines } from './smoothLines'

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
/** Undercut vs the STEP ideal (leftover — can still be cut). */
const UNDERCUT_COLOR = 0x3b82f6
/**
 * Diff margin (mm): the closest-point difference ignores anything within this, so the ~0.05 mm
 * reconstruction offset and tessellation noise never read as a skin — only real features (end
 * mitres, copes) light up. `DIFF_EXTRA_MARGIN_MM` is added on top to swallow the borderline 1–2 mm
 * reconstruction wobble. See docs/architecture.md.
 */
const DIFF_MARGIN_MM = 1
const DIFF_EXTRA_MARGIN_MM = 1
/**
 * Dihedral bar for the diff-solid outlines — higher than the model edges so only genuine corners
 * draw. The diff is a smooth shell, so its tessellated curves would otherwise clutter it.
 */
const DIFF_EDGE_THRESHOLD_DEG = 55
const FACE_MATERIAL = { color: 0x9aa3ad, metalness: 0.15, roughness: 0.75 }

/** Fallback colour for a cut-thickness bucket when there are more buckets than palette colours. */
const FALLBACK_COLOR = 0x9ca3af

/** NC toolpath line width in screen pixels (fat lines, so they read clearly over the model). */
const NC_LINE_WIDTH = 3
/**
 * Opacity of the translucent bevel-area fins. Low enough that overlapping bevels near one another
 * stay readable through each other, high enough that a lone fin still reads. (A fin is drawn
 * double-sided, so its two faces stack — the on-screen density is higher than this value.)
 */
const BEVEL_AREA_OPACITY = 0.34
/** How far (mm) a STEP bevel's translucent area fin sweeps out from its cut line. */
const STEP_BEVEL_LENGTH = 30
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
  linewidth = NC_LINE_WIDTH,
): LineSegments2 | null {
  if (points.length === 0) return null
  const geometry = new LineSegmentsGeometry()
  geometry.setPositions(points)
  const material = new LineMaterial({
    color,
    transparent: true,
    opacity: 0.98,
    linewidth,
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

/** How welding bevels are drawn: the classic stemmed arrows, or translucent swept area fins. */
export type BevelStyle = 'arrow' | 'area'

/**
 * Enables cut-edge colouring: the STEP model's cut edges are drawn as coloured lines, keyed to the
 * wall thickness they pass through. `thicknesses` is the NC legend's thickness list (ascending), so
 * the STEP pane's colours match the legend chips; empty falls back to the model's own cut
 * thicknesses. `faces`/`profile` restrict colouring to those DSTV face sides (default `o`/`u`/`h`),
 * resolved through the canonical stance so one-sided sections map correctly.
 */
export interface CutEdgeOptions {
  thicknesses: number[]
  /** DSTV face letters to colour. Defaults to the side + top faces (`o`/`u`/`h`). */
  faces?: NcFace[]
  /** DSTV/Tekla profile code, so the target faces resolve for the right family. */
  profile?: string | null
  /** Outer corner radius (mm) — how far a rounded-corner cut reaches onto the adjacent face. */
  radius?: number
}

/** Default faces to colour: the two sides and the top (the accessible cut faces, not the bottom). */
const DEFAULT_CUT_FACES: NcFace[] = ['o', 'u', 'h']

/**
 * World-space outward normals of the DSTV faces that should carry cut-edge colouring. The machine
 * role (`faceRole`) gives each face's side — top/bottom lie on the machine-up axis, a side on the
 * cross axis — so the normals never depend on the NC's authored frame. (An angle's authored frame
 * can resolve a quarter-turn off, which used to leak `o` into the targets even when it was not
 * listed.) A symmetric section's two side letters are interchangeable, so a requested side face
 * colours both sides; an asymmetric angle's sides are distinct, so the letter picks its own — `v`
 * the right (`+x`), `h` the left (`−x`).
 */
function targetFaceNormals(
  faces: NcFace[],
  family: ProfileFamily,
  xAxis: Vector3,
  yAxis: Vector3,
): Vec3[] {
  const normals: Vec3[] = []
  for (const face of faces) {
    const role = faceRole(family, face)
    const base = role === 'side' ? xAxis : yAxis
    const signs =
      role === 'side'
        ? family === 'angle'
          ? [face === 'v' ? 1 : -1]
          : [1, -1]
        : [role === 'top' ? 1 : -1]
    for (const sign of signs) {
      normals.push([base.x * sign, base.y * sign, base.z * sign])
    }
  }
  return normals
}

/** The three objects `addNcLines` produces for a projected NC. */
interface NcProjectedObjects {
  /** Plain cut lines + hole rings (always drawn). */
  cutLines: LineSegments2[]
  /** Stemmed welding-bevel arrows. */
  bevelArrows: LineSegments2[]
  /** Translucent welding-bevel area fins. */
  bevelAreas: Mesh[]
}

/** Builds the NC line sets as coloured fat lines (cut lines + hole rings + bevel indications). */
function addNcLines(
  nc: NcGeometry,
  projection: NcProjection,
  resolution: Vector2,
  materials: LineMaterial[],
): NcProjectedObjects {
  const sets: NcLineSets = projectNc(nc, projection)
  const cutLines: LineSegments2[] = []
  const bevelArrows: LineSegments2[] = []
  const bevelAreas: Mesh[] = []
  const colorAt = (index: number): number =>
    THICKNESS_COLORS[index % THICKNESS_COLORS.length] ?? FALLBACK_COLOR
  const lineInto = (target: LineSegments2[], points: number[], color: number): void => {
    const line = ncLineObject(points, color, resolution, materials)
    if (line) target.push(line)
  }
  sets.cuts.forEach((cut, index) => {
    lineInto(cutLines, cut.points, colorAt(index))
  })
  sets.bevelArrows.forEach((bevel, index) => {
    lineInto(bevelArrows, bevel.points, colorAt(index))
  })
  sets.bevelAreas.forEach((bevel, index) => {
    if (bevel.triangles.length === 0) return
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new Float32BufferAttribute(bevel.triangles, 3))
    const area = new Mesh(
      geometry,
      new MeshBasicMaterial({
        color: colorAt(index),
        transparent: true,
        opacity: BEVEL_AREA_OPACITY,
        side: DoubleSide,
        // No depth write so overlapping fins and the model behind them both show through.
        depthWrite: false,
      }),
    )
    bevelAreas.push(area)
  })
  return { cutLines, bevelArrows, bevelAreas }
}

/** Colours a cut thickness by its nearest entry in `scale` (the NC legend's thickness order). */
function edgeColorForThickness(thickness: number, scale: number[]): number {
  if (scale.length === 0) return FALLBACK_COLOR
  let index = 0
  let best = Number.POSITIVE_INFINITY
  scale.forEach((value, i) => {
    const distance = Math.abs(value - thickness)
    if (distance < best) {
      best = distance
      index = i
    }
  })
  return THICKNESS_COLORS[index % THICKNESS_COLORS.length] ?? FALLBACK_COLOR
}

/**
 * Paints per-face alpha onto a diff geometry from per-triangle clearances, so
 * barely-out faces whisper and far-out faces pop. The geometry must be
 * non-indexed with one triangle per three vertices, and `distances` aligned
 * with it (as `filterDrawableFaces` returns).
 */
/** An extruded section outline drawn as a translucent overlay. */
export interface BeamOutline {
  profile: [number, number][]
  length: number
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
  /** Switch the welding-bevel indication between stemmed arrows and translucent area fins. */
  setBevelStyle: (style: BevelStyle) => void
  /** Show/hide the base-plane reference grid. */
  setGridVisible: (visible: boolean) => void
  /** Show only the span markers whose index is in `indices` (null = all; [] = none). */
  setVisibleSpans: (indices: number[] | null) => void
  /** Glow the sub-cut marker at `index` and dim the rest (null clears the hover highlight). */
  highlight: (index: number | null) => void
  /** Pull every synced viewport toward the geometry behind a finding code (null = whole model). */
  focus: (code: string | null, index?: number) => void
  diffStats: DiffStats | null
  diffPresence: DiffPresence | null
  runDiff: () => Promise<DiffStats | null>
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

/** Rebuild a diff solid's geometry from the worker payload (positions + OCC normals, non-indexed). */
function geometryFromSolid(solid: DiffSolidPayload): BufferGeometry {
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(solid.position, 3))
  if (solid.normal) geometry.setAttribute('normal', new Float32BufferAttribute(solid.normal, 3))
  else geometry.computeVertexNormals()
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
  sabre?: CutMarker[] | null,
  nc?: NcGeometry | null,
  ncSection?: [number, number][] | null,
  faceFrame?: NcFaceFrame | null,
  bevelStyle: BevelStyle = 'arrow',
  onLocationChange?: (locationMm: number, lengthMm: number) => void,
  onAxisAngleChange?: (degrees: number) => void,
  cutEdges?: CutEdgeOptions | null,
): SceneHandle {
  const renderer = new WebGLRenderer({ antialias: true, alpha: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setSize(container.clientWidth || 1, container.clientHeight || 1)
  container.appendChild(renderer.domElement)

  const scene = new Scene()
  const ambient = new AmbientLight(0xffffff, 0.6)
  const hemisphere = new HemisphereLight(0xf2f7ff, 0x1a2733, 0.9)
  const key = new DirectionalLight(0xffffff, 2.6)
  key.position.set(0.8, 1, 0.9)
  const fill = new DirectionalLight(0xffffff, 1.1)
  fill.position.set(-1, -0.6, -0.8)
  // The diff solids render in the layer-1 pass (`camera.layers.set(1)`), and a light only joins a pass
  // when it is visible on that pass's layer — without this the lit diff materials come out black.
  for (const light of [ambient, hemisphere, key, fill]) light.layers.enable(1)
  scene.add(ambient, hemisphere, key, fill)

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
  // Crease lines for the boolean diff solids: same near-black as the base body, so the strongly-
  // coloured over/under shells read with the same sharp-edge/smooth-curve look. Offset forward so the
  // lines sit on top of the (polygon-offset) diff fill instead of z-fighting it.
  const diffCreaseMaterial = new LineBasicMaterial({
    color: 0x0b0f14,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  })
  const compareMaterial = new MeshStandardMaterial({
    color: COMPARE_COLOR,
    transparent: true,
    opacity: 0.4,
    depthWrite: false,
    side: DoubleSide,
    metalness: 0.2,
    roughness: 0.6,
  })
  const materials: Material[] = [faceMaterial, strayMaterial, lineMaterial, diffCreaseMaterial]

  // Overlay mode (a second model is present): the manufactured base keeps the *same* solid grey
  // settings as every other pane — only the diff solid gets special treatment. The compare (STEP)
  // shell is see-through, so where the ideal extends past the manufactured part still shows.
  const isOverlay = Boolean(compareStep && compareStep.bodies.length > 0)
  if (isOverlay) {
    compareMaterial.opacity = 0.3
  }
  // NC-specific issue markers (e.g. a cut line whose bevel changes) only make sense on the
  // manufactured NC pane — the STEP ideal and the overlay aren't cut by this NC, so drawing them
  // there misleads. The pane is identified the same way the toolpath is: only it passes `nc`.
  const showNcOnlyMarkers = Boolean(nc) && !isOverlay

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
  /** STEP cut edges (non-stock edges), coloured by wall thickness — drawn when `cutEdges` is set. */
  const cutEdgeObjects: LineSegments2[] = []
  /**
   * STEP welding-bevel area fins — detected from the STEP geometry on the cut edges themselves,
   * never from the NC. Drawn with the STEP cut lines, styled like the NC bevel areas.
   */
  const stepBevelObjects: Mesh[] = []
  /** Welding-bevel indications, split by style so the toggle just flips visibility. */
  const ncArrowObjects: LineSegments2[] = []
  const ncAreaObjects: Mesh[] = []
  let bevelStyleState: BevelStyle = bevelStyle
  const applyBevelStyle = (): void => {
    for (const object of ncArrowObjects) object.visible = bevelStyleState === 'arrow'
    for (const object of ncAreaObjects) object.visible = bevelStyleState === 'area'
    for (const object of stepBevelObjects) object.visible = bevelStyleState === 'area'
  }
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
  let xAxis = unit(0, 1)
  let yAxis = unit(1, 1)
  if (profile) {
    // Canonical display seating, shared with the overlay diff (`viewerModel.diffForViewer`) so the
    // two never reorient independently. `seatedPair` rolls the whole display about the member axis
    // so section `+y` (the machine "up", see canonical-orientation.md) points world +Y — then the
    // model, the stock ghost and the NC projection all share the canonical frame.
    const seats = seatedPair(primary.raw, compareStep?.vertices ?? null, profile)
    const seatScale = new Vector3()
    seats.primary.decompose(primary.group.position, primary.group.quaternion, seatScale)
    primary.group.updateMatrixWorld(true)
    if (compareGroup && seats.compare) {
      seats.compare.decompose(compareGroup.position, compareGroup.quaternion, seatScale)
      compareGroup.updateMatrixWorld(true)
      // The diff pane's flip resets the compare model to this base, so capture it *after* the
      // canonical roll — otherwise the flip undoes the roll and the STEP lands back on its side.
      compareBaseQuaternion = compareGroup.quaternion.clone()
    }
    xAxis = seats.xAxis
    yAxis = seats.yAxis

    // Colour the STEP's cut edges by wall thickness (the NC legend's key). The worker emits every
    // face; `brepCutSegments` classifies stock vs cut by topology and returns the coloured segments
    // for the target `o`/`u`/`h` faces (lengthwise cuts kept; cuts on a rounded corner projected
    // onto the nearest target face so they read flat).
    if (cutEdges) {
      primary.group.updateMatrixWorld(true)
      const matrixWorld = primary.group.matrixWorld
      const rotation = primary.group.quaternion
      const basisX: Vec3 = [xAxis.x, xAxis.y, xAxis.z]
      const basisY: Vec3 = [yAxis.x, yAxis.y, yAxis.z]
      const holes = Array.isArray(stock?.holes) ? stock.holes : []
      const family = cutEdges.profile ? profileFamily(cutEdges.profile) : null
      const frame = faceFrame ?? (nc ? resolveNcFaceFrame(ncSection ?? profile, nc) : null)
      const targetVectors: Vec3[] | null =
        family && frame
          ? targetFaceNormals(
              cutEdges.faces ?? CUT_FACES[family] ?? DEFAULT_CUT_FACES,
              family,
              xAxis,
              yAxis,
            )
          : null
      const groups = new Map<number, number[]>()
      /** Translucent bevel-area triangle soup per thickness (STEP-detected bevels). */
      const bevelGroups = new Map<number, number[]>()
      // Normals only rotate (no translation), unlike the point transforms.
      const rotationMatrix = new Matrix4().makeRotationFromQuaternion(rotation)
      for (const body of step.bodies) {
        const seated: SeatedBrepFace[] = (body.brep ?? []).map((face) => {
          const normal = new Vector3(
            face.normal[0],
            face.normal[1],
            face.normal[2],
          ).applyQuaternion(rotation)
          const center = new Vector3(face.center[0], face.center[1], face.center[2]).applyMatrix4(
            matrixWorld,
          )
          return {
            normal: [normal.x, normal.y, normal.z],
            center: [center.x, center.y, center.z],
            planar: face.planar,
            samples: transformVertices(face.samples, matrixWorld),
            wires: face.wires.map((wire) => ({
              enclosed: wire.enclosed,
              edges: wire.edges.map((edge) => ({
                points: transformVertices(edge.points, matrixWorld),
                neighbours: edge.neighbours,
                neighbourNormals: edge.neighbourNormals?.map((normals) =>
                  normals ? transformVertices(normals, rotationMatrix) : undefined,
                ),
              })),
            })),
          }
        })
        const cuts = brepCutSegments(
          seated,
          profile,
          holes,
          basisX,
          basisY,
          [1, 0, 0],
          targetVectors,
        )
        // Tubes: cut lines come from the face projection — the cut plane's trace on each nominal
        // face, a rounded corner onto BOTH adjacent faces, and all four faces (incl. the bottom).
        // Open sections (PFC/angle/T) keep the topology-based extraction below (the projection is
        // only validated for closed tubes).
        if (frame && family === 'tube') {
          const projected = projectCutEdgesToFaces(
            seated,
            profile,
            frame,
            basisX,
            basisY,
            [1, 0, 0],
            { radius: cutEdges.radius ?? 0 },
          )
          // The projection's X is already the seated member coordinate (centred), so no origin shift.
          const toPoint = (along: number, cross: [number, number]): Vec3 => [
            along + cross[0] * xAxis.x + cross[1] * yAxis.x,
            cross[0] * xAxis.y + cross[1] * yAxis.y,
            cross[0] * xAxis.z + cross[1] * yAxis.z,
          ]
          for (const face of ['v', 'o', 'u', 'h'] as NcFace[]) {
            const segs = projected[face]
            if (segs.length === 0) continue
            const faceCentre = placeNcFace(
              frame,
              face,
              0,
              faceHalf(frame, faceSpanAxis(frame, face)),
              profile,
            ).cross
            const thickness = Math.round(cutEdgeThicknessAt(profile, holes, faceCentre) * 10) / 10
            const positions: number[] = []
            for (const seg of segs) {
              const a = placeNcFace(frame, face, seg.a.X, seg.a.Y, profile)
              const b = placeNcFace(frame, face, seg.b.X, seg.b.Y, profile)
              const pa = toPoint(a.along, a.cross)
              const pb = toPoint(b.along, b.cross)
              positions.push(pa[0], pa[1], pa[2], pb[0], pb[1], pb[2])
              // The fin sweeps the *projected* (straight) segment along the cut plane's lean, so it
              // matches the NC bevel instead of bowing to follow the rounded-corner rim.
              if (!seg.dir) continue
              const rx = seg.dir[0] * STEP_BEVEL_LENGTH
              const ry = seg.dir[1] * STEP_BEVEL_LENGTH
              const rz = seg.dir[2] * STEP_BEVEL_LENGTH
              const quad = [
                pa[0],
                pa[1],
                pa[2],
                pb[0],
                pb[1],
                pb[2],
                pb[0] + rx,
                pb[1] + ry,
                pb[2] + rz,
                pa[0],
                pa[1],
                pa[2],
                pb[0] + rx,
                pb[1] + ry,
                pb[2] + rz,
                pa[0] + rx,
                pa[1] + ry,
                pa[2] + rz,
              ]
              const fins = bevelGroups.get(thickness)
              if (fins) fins.push(...quad)
              else bevelGroups.set(thickness, quad)
            }
            const bucket = groups.get(thickness)
            if (bucket) bucket.push(...positions)
            else groups.set(thickness, positions)
          }
        } else {
          // Open sections: lines *and* bevel fins both come from `brepCutSegments`.
          for (const cut of cuts) {
            const bucket = groups.get(cut.thickness)
            if (bucket) bucket.push(...cut.points)
            else groups.set(cut.thickness, cut.points)
            if (!cut.bevelDir) continue
            const [dx, dy, dz] = cut.bevelDir
            const rx = dx * STEP_BEVEL_LENGTH
            const ry = dy * STEP_BEVEL_LENGTH
            const rz = dz * STEP_BEVEL_LENGTH
            const p = cut.points
            for (let k = 0; k + 5 < p.length; k += 6) {
              const ax = p[k] as number
              const ay = p[k + 1] as number
              const az = p[k + 2] as number
              const bx = p[k + 3] as number
              const by = p[k + 4] as number
              const bz = p[k + 5] as number
              const quad = [
                ax,
                ay,
                az,
                bx,
                by,
                bz,
                bx + rx,
                by + ry,
                bz + rz,
                ax,
                ay,
                az,
                bx + rx,
                by + ry,
                bz + rz,
                ax + rx,
                ay + ry,
                az + rz,
              ]
              const fins = bevelGroups.get(cut.thickness)
              if (fins) fins.push(...quad)
              else bevelGroups.set(cut.thickness, quad)
            }
          }
        }
      }
      const order = [...groups.keys()].sort((a, b) => a - b)
      const scale = cutEdges.thicknesses.length > 0 ? cutEdges.thicknesses : order
      for (const thickness of order) {
        const points = groups.get(thickness)
        if (!points || points.length === 0) continue
        const line = ncLineObject(
          points,
          edgeColorForThickness(thickness, scale),
          ncResolution,
          ncMaterials,
        )
        if (line) {
          // The cut lines sit exactly on the surface (they *are* its edges), so nudge their depth
          // toward the camera to keep them from z-fighting the face behind them.
          const material = line.material as LineMaterial
          material.polygonOffset = true
          material.polygonOffsetFactor = -2
          material.polygonOffsetUnits = -2
          scene.add(line)
          cutEdgeObjects.push(line)
        }
      }
      // Draw the STEP-detected bevels as translucent fins, each swept from its cut line along the
      // bevel direction — the same look the NC bevel areas use, but sourced purely from the STEP.
      for (const thickness of order) {
        const triangles = bevelGroups.get(thickness)
        if (!triangles || triangles.length === 0) continue
        const geometry = new BufferGeometry()
        geometry.setAttribute('position', new Float32BufferAttribute(triangles, 3))
        const area = new Mesh(
          geometry,
          new MeshBasicMaterial({
            color: edgeColorForThickness(thickness, scale),
            transparent: true,
            opacity: BEVEL_AREA_OPACITY,
            side: DoubleSide,
            depthWrite: false,
          }),
        )
        scene.add(area)
        stepBevelObjects.push(area)
      }
    }

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
        const n = faceNormal(frame, face, section)
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
        const n = faceNormal(frame, face, section)
        const base = n.axis === 0 ? xAxis : yAxis
        return [base.x * n.sign, base.y * n.sign, base.z * n.sign]
      }
      // The NC toolpath (cut lines, holes) — only on panes that pass `nc`. Issue markers are
      // drawn separately (toggle-driven), not as toolpath danger marks.
      if (nc) {
        const projected = addNcLines(
          nc,
          { frame, section, toScene, normal },
          ncResolution,
          ncMaterials,
        )
        for (const line of projected.cutLines) {
          scene.add(line)
          ncObjects.push(line)
        }
        for (const line of projected.bevelArrows) {
          scene.add(line)
          ncArrowObjects.push(line)
        }
        for (const area of projected.bevelAreas) {
          scene.add(area)
          ncAreaObjects.push(area)
        }
      }
      // The guilty cut drawn as a red marker, projected with the shared `toScene`. A marker may
      // carry across-face cut `lines` (a cope, whose lengthwise profile edges are not cuts);
      // otherwise it spans `from` → `to`. One object per marker, so a clicked finding can zoom to
      // its own cut.
      if (sabre && sabre.length > 0) {
        for (const failure of sabre) {
          // Look at the cut from its own face, tilted off-axis so the camera never looks straight
          // down (which would make the up-vector ambiguous).
          const faceDir = normal(failure.face)
          sabreDirections.push([faceDir[0] + 0.45, faceDir[1] + 0.45, faceDir[2] + 0.45])
          // NC-specific markers are hidden on panes that don't show the manufactured NC. Keep the
          // slot (a null marker) so every finding's `index` still lines up across panes.
          if (failure.ncOnly && !showNcOnlyMarkers) {
            sabreSpanObjects.push(null)
            spanShown.push(false)
            sabreHaloObjects.push(null)
            continue
          }
          let lines = failure.lines
          if (!lines || lines.length === 0) {
            // A failure can collapse to a point (a corner-risk run of a single sample). Draw a short
            // tick along the member so it still reads in the 3D.
            let from = failure.from
            let to = failure.to
            if (Math.hypot(to[0] - from[0], to[1] - from[1]) < 0.1) {
              const half = SABRE_TICK_MM / 2
              from = [failure.from[0] - half, failure.from[1]]
              to = [failure.from[0] + half, failure.from[1]]
            }
            lines = [[from, to]]
          }
          const positions: number[] = []
          for (const line of lines) {
            for (let i = 0; i < line.length - 1; i++) {
              const [x0, y0] = line[i] as [number, number]
              const [x1, y1] = line[i + 1] as [number, number]
              const pA = toScene(
                x0,
                placeNcFace(frame, failure.face, x0, y0, section).cross,
                failure.face,
              )
              const pB = toScene(
                x1,
                placeNcFace(frame, failure.face, x1, y1, section).cross,
                failure.face,
              )
              positions.push(pA[0], pA[1], pA[2], pB[0], pB[1], pB[2])
            }
          }
          const color = failure.color ?? SABRE_CUT_COLOR
          const mark = ncLineObject(positions, color, ncResolution, ncMaterials, true)
          if (mark) {
            scene.add(mark)
            sabreObjects.push(mark)
            sabreSpanObjects.push(mark)
            spanShown.push(false)
            const halo = ncHaloObject(positions, color, ncResolution, ncMaterials)
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
        const n = faceNormal(frame, face, beam.profile)
        const local: [number, number] = [cross[0], cross[1]]
        local[n.axis] += n.sign * OFF
        return [local[0], local[1], along - beam.length / 2]
      }
      const normal = (face: NcFace): Vec3 => {
        const n = faceNormal(frame, face, beam.profile)
        return n.axis === 0 ? [n.sign, 0, 0] : [0, n.sign, 0]
      }
      const projected = addNcLines(
        nc,
        { frame, section: beam.profile, toScene, normal },
        ncResolution,
        ncMaterials,
      )
      for (const line of projected.cutLines) {
        scene.add(line)
        ncObjects.push(line)
      }
      for (const line of projected.bevelArrows) {
        scene.add(line)
        ncArrowObjects.push(line)
      }
      for (const area of projected.bevelAreas) {
        scene.add(area)
        ncAreaObjects.push(area)
      }
    }
  }

  // Frame the model and overlays in view.
  const fit = new Box3().expandByObject(primary.group)
  if (compareGroup) fit.expandByObject(compareGroup)
  for (const overlay of overlays) fit.expandByObject(overlay)
  const fitSize = fit.getSize(new Vector3())
  const fitCentre = fit.getCenter(new Vector3())

  // Reference grid on the member's base plane (XZ) — a fixed metric ladder (1 cm / 10 cm / 1 m) so a
  // line's spacing is always a known round value: the 1 m lines are thickest, 10 cm the middle,
  // 1 cm the thinnest and faintest. A tier hides itself once its cells fall below a few pixels, so a
  // wide zoom shows only the coarse lines instead of a solid smear. The grid hugs the beam — the
  // length runs its full length, the width only as wide as the section (min 1 m, so there is margin
  // to judge how the beam sits on the roller bed). Placed just under the base and depth-tested, so
  // the part occludes it and it never hides a diff; hidden until the toggle turns it on.
  const snapMetre = (span: number): number => Math.max(1000, Math.ceil(span / 1000) * 1000)
  const gridHalfX = snapMetre(fitSize.x) / 2
  const gridHalfZ = snapMetre(fitSize.z) / 2
  /** Widest tiers keep their lines at least this far apart (px); finer ones drop out as you zoom out. */
  const GRID_MIN_PX = 7
  const gridMaterials: LineMaterial[] = []
  const gridTiers: { step: number; lines: LineSegments2 }[] = []
  const gridGroup = new Group()
  const gridResolution = new Vector2(container.clientWidth || 1, container.clientHeight || 1)
  const makeGridTier = (step: number, color: number, linewidth: number, opacity: number): void => {
    const points: number[] = []
    // Lines parallel to the length (X), one at each z across the width.
    const nz = Math.round((gridHalfZ * 2) / step)
    for (let i = 0; i <= nz; i++) {
      const z = -gridHalfZ + i * step
      points.push(-gridHalfX, 0, z, gridHalfX, 0, z)
    }
    // Lines parallel to the width (Z), one at each x along the length.
    const nx = Math.round((gridHalfX * 2) / step)
    for (let i = 0; i <= nx; i++) {
      const x = -gridHalfX + i * step
      points.push(x, 0, -gridHalfZ, x, 0, gridHalfZ)
    }
    const line = ncLineObject(points, color, gridResolution, gridMaterials, false, linewidth)
    if (!line) return
    ;(line.material as LineMaterial).opacity = opacity
    line.visible = false
    gridGroup.add(line)
    gridTiers.push({ step, lines: line })
  }
  makeGridTier(10, 0x1e2a38, 1, 0.5)
  makeGridTier(100, 0x33495e, 1.5, 0.6)
  makeGridTier(1000, 0x4b6a8a, 2.4, 0.85)
  const gridDrop = Math.max(Math.max(gridHalfX, gridHalfZ) * 2e-4, 0.02)
  gridGroup.position.set(fitCentre.x, fit.min.y - gridDrop, fitCentre.z)
  gridGroup.visible = false
  scene.add(gridGroup)

  // Closest-point margin diff, with the STEP treated as nominal. Both groups are already seated in
  // the same frame, so the difference runs in world coordinates: red = overcut (the ideal surface the
  // manufactured model lacks — scrap), blue = undercut (manufactured outside the ideal — leftover).
  // A face counts only when it clears `DIFF_MARGIN_MM`, so sub-mm noise never reads as a skin (see
  // docs/architecture.md). This is the same grid query the fast presence probe uses — no boolean.
  //
  // The overlay is painted after the models plus a fast presence verdict so the first frame is
  // instant.
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
  // The boolean diff comes back as a watertight solid, shaded with its own OCC normals like the base
  // body. Draw the same angle-filtered crease lines the base body uses (`SMOOTH_LINE_THRESHOLD_DEG`)
  // so sharp edges outline the volume while the curves between them stay smooth.
  const addDiffCreases = (source: BufferGeometry, parent: Object3D): void => {
    const edges = new EdgesGeometry(source, SMOOTH_LINE_THRESHOLD_DEG)
    if ((edges.getAttribute('position')?.count ?? 0) === 0) {
      edges.dispose()
      return
    }
    const lines = new LineSegments(edges, diffCreaseMaterial)
    lines.renderOrder = 12
    lines.layers.set(1)
    parent.add(lines)
    diffEdgeLines.push(lines)
  }
  const runDiff = async (): Promise<DiffStats | null> => {
    if (!compareStep || !compareGroup || diffStats) return diffStats
    // OCC B-rep boolean with a fuzzy margin, run in the OCC worker: the kernel merges faces within
    // `OCC_FUZZY_MM`, so the near-coincident reconstruction offset is absorbed and only the real gap
    // survives — as a solid. The worker is given the *same* canonical seating this view already
    // applies (from `seatedPair`), so it never reorients independently; the result is in the
    // manufactured model's frame, so we seat it here by parenting to the (already seated) primary
    // group.
    let payload: DiffPayload | null = null
    if (primaryBytes && compareBytes) {
      try {
        payload = await diffForViewer(primaryBytes, compareBytes, { profile })
      } catch {
        // Worker boolean failed outright (e.g. kernel error) — fall through to surface flagging.
        payload = null
      }
    }
    if (payload) {
      // Lit like the base body (`FACE_MATERIAL`), so the shell's shaded curves read as a solid rather
      // than a flat coloured silhouette — the crease lines above outline the sharp edges. The fill is
      // polygon-offset *away* from the camera so it never wins the depth test against those coincident
      // lines and hides them (lines ignore polygon offset, only the fill moves).
      const overcutMaterial = new MeshStandardMaterial({
        ...FACE_MATERIAL,
        color: OVERCUT_COLOR,
        side: DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
      })
      const undercutMaterial = new MeshStandardMaterial({
        ...FACE_MATERIAL,
        color: UNDERCUT_COLOR,
        side: DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
      })
      materials.push(overcutMaterial, undercutMaterial)
      if (payload.over) {
        const geometry = geometryFromSolid(payload.over)
        const mesh = new Mesh(geometry, overcutMaterial)
        mesh.layers.set(1)
        primary.group.add(mesh)
        diffMeshes.push(mesh)
        addDiffCreases(geometry, primary.group)
      }
      if (payload.under) {
        const geometry = geometryFromSolid(payload.under)
        const mesh = new Mesh(geometry, undercutMaterial)
        mesh.layers.set(1)
        primary.group.add(mesh)
        diffMeshes.push(mesh)
        addDiffCreases(geometry, primary.group)
      }
      const volume = payload.primaryVolume > 0 ? payload.primaryVolume : 1
      diffStats = {
        over: payload.overVolume / volume,
        under: payload.underVolume / volume,
        tolerance: OCC_FUZZY_MM,
        approximate: false,
      }
    } else {
      // Fallback: surface-distance flagging through the grid query (diffHighlight) — the same query
      // the presence probe uses, no boolean. Manufactured faces beyond the margin are leftover
      // (blue); ideal faces beyond it are material the NC removed (red).
      const primaryWorld = transformVertices(primary.raw, primary.group.matrixWorld)
      const compareWorld = transformVertices(compareStep.vertices, compareGroup.matrixWorld)
      const primaryTris = concatTriangles(step)
      const compareTris = concatTriangles(compareStep)
      const { aDiff, bDiff } = computeDiffMasks(
        primaryWorld,
        primaryTris.triangles,
        compareWorld,
        compareTris.triangles,
        DIFF_MARGIN_MM + DIFF_EXTRA_MARGIN_MM,
        // Majority-of-samples, not "any vertex": a single stray corner on a coarse face must not
        // paint the whole face (the "skin" artifact).
        'samples',
      )
      // Close the masks over the topology: fill pinholes, drop specks, so the region reads as one patch.
      const aClosed = closeDiffMask(primaryWorld, primaryTris.triangles, aDiff, 2)
      const bClosed = closeDiffMask(compareWorld, compareTris.triangles, bDiff, 2)
      const undercutMaterial = new MeshStandardMaterial({
        ...FACE_MATERIAL,
        color: UNDERCUT_COLOR,
        side: DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
      })
      const overcutMaterial = new MeshStandardMaterial({
        ...FACE_MATERIAL,
        color: OVERCUT_COLOR,
        side: DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
      })
      materials.push(undercutMaterial, overcutMaterial)
      step.bodies.forEach((body, index) => {
        const geometry = buildDiffGeometry(
          body.mesh.faces.vertices,
          body.mesh.faces.triangles,
          aClosed,
          primaryTris.offsets[index],
        )
        if (!geometry) return
        const mesh = new Mesh(geometry, undercutMaterial)
        mesh.layers.set(1)
        primary.group.add(mesh)
        diffMeshes.push(mesh)
        addDiffEdges(geometry, UNDERCUT_COLOR, primary.group)
      })
      compareStep.bodies.forEach((body, index) => {
        const geometry = buildDiffGeometry(
          body.mesh.faces.vertices,
          body.mesh.faces.triangles,
          bClosed,
          compareTris.offsets[index],
        )
        if (!geometry) return
        const mesh = new Mesh(geometry, overcutMaterial)
        mesh.layers.set(1)
        compareGroup.add(mesh)
        diffMeshes.push(mesh)
        addDiffEdges(geometry, OVERCUT_COLOR, compareGroup)
      })
      diffStats = {
        over: diffFraction(bClosed),
        under: diffFraction(aClosed),
        tolerance: DIFF_MARGIN_MM + DIFF_EXTRA_MARGIN_MM,
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
  if (!deferDiff) void runDiff()

  // An uncuttable cut (light-sabre failure) is shown as a red error arrow on its bevel — built in
  // `addNcLines` and collected into `sabreObjects` — not as a red surface patch.

  const maxDim = Math.max(fitSize.x, fitSize.y, fitSize.z) || 1

  // Snap the orbit pivot onto the beam's longitudinal centre line. Seating places the model's
  // bbox centre at the origin, so the centre line is the model's long axis through the origin.
  // Pan may slide along the beam and cursor-zoom may nudge the target, but the pivot can never
  // leave the line — so orbiting always turns the beam about its own axis instead of swinging it
  // around an off-axis point. Mirrors the NC beam viewer's pivot confinement.
  const crossAxes = [0, 1, 2].filter((axis) => axis !== longAxis)
  const axisCentre = fitCentre.clone()
  for (const axis of crossAxes) axisCentre.setComponent(axis, 0)

  // Default to a true isometric angle: equal X/Y/Z so no axis is foreshortened.
  const distance = maxDim * 2

  const corners: Vector3[] = []
  for (let i = 0; i < 8; i++) {
    corners.push(
      new Vector3(
        i & 1 ? fit.max.x : fit.min.x,
        i & 2 ? fit.max.y : fit.min.y,
        i & 4 ? fit.max.z : fit.min.z,
      ),
    )
  }
  // Measure the model's on-screen footprint (max |x|/|y| in camera space) for a view direction, so
  // a view fills the viewport from the bounding-box corners alone. Sizing to the bbox diagonal (as
  // before) left a long thin beam filling only a fraction of a wide viewport.
  const measure = (dir: Vector3, up?: Vector3): { halfWidth: number; halfHeight: number } => {
    const scratch = new OrthographicCamera()
    const point = new Vector3()
    const toView = new Matrix4()
    scratch.position.copy(axisCentre).add(dir.clone().normalize().multiplyScalar(distance))
    // Match the live camera's roll so a face view's footprint is measured in its own screen frame
    // (with the default up, a top/bottom view is degenerate and the fit comes out wrong).
    if (up) scratch.up.copy(up)
    scratch.lookAt(axisCentre)
    scratch.updateMatrixWorld()
    toView.copy(scratch.matrixWorld).invert()
    let halfWidth = 0
    let halfHeight = 0
    for (const corner of corners) {
      // The pivot sits on the view axis, so camera-space x/y is measured from the frame centre.
      point.copy(corner).applyMatrix4(toView)
      halfWidth = Math.max(halfWidth, Math.abs(point.x))
      halfHeight = Math.max(halfHeight, Math.abs(point.y))
    }
    return { halfWidth, halfHeight }
  }

  const MARGIN = 1.02
  let modelRadius = 0
  for (const corner of corners) modelRadius = Math.max(modelRadius, corner.distanceTo(axisCentre))

  const initialFit = measure(new Vector3(1, 1, 1))
  let frustumHalfWidth = initialFit.halfWidth * MARGIN
  let frustumHalfHeight = initialFit.halfHeight * MARGIN

  const camera = new OrthographicCamera(
    -frustumHalfWidth,
    frustumHalfWidth,
    frustumHalfHeight,
    -frustumHalfHeight,
    Math.max(maxDim / 1000, 0.01),
    maxDim * 100,
  )
  camera.position.copy(axisCentre).add(new Vector3(1, 1, 1).normalize().multiplyScalar(distance))
  camera.lookAt(axisCentre)

  const applyFrustum = (width: number, height: number) => {
    const aspect = width / height || 1
    // Grow the frame's short side so the required extent fits at this aspect (fills the long side).
    const halfHeight = Math.max(frustumHalfHeight, frustumHalfWidth / aspect)
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
    ? attachOrbit(
        bus,
        camera,
        controls,
        {
          centre: [axisCentre.x, axisCentre.y, axisCentre.z],
          distance,
          radius: modelRadius,
          axis: longAxis as 0 | 1 | 2,
          length,
        },
        // Face the right physical side for the named views: `right` is the section's `+x` (`v`),
        // `up` its machine-up (`o`). Without a profile the world axes stand in.
        profile
          ? { right: [xAxis.x, xAxis.y, xAxis.z], up: [yAxis.x, yAxis.y, yAxis.z] }
          : undefined,
      )
    : null
  const detachWheelPan = attachWheelPan(container, controls, camera, longAxis as 0 | 1 | 2)

  // Re-frame from the bbox whenever a preset is chosen, so each preset fills the viewport tightly
  // instead of inheriting the isometric frame. Runs after `attachOrbit`'s preset handler (added
  // first), so the camera is already oriented when we measure.
  const refitPreset = (): void => {
    const dir = new Vector3().subVectors(camera.position, controls.target)
    if (dir.lengthSq() < 1e-9) return
    const fit = measure(dir, camera.up)
    frustumHalfWidth = fit.halfWidth * MARGIN
    frustumHalfHeight = fit.halfHeight * MARGIN
    applyFrustum(container.clientWidth || 1, container.clientHeight || 1)
  }
  bus?.presetListeners.add(refitPreset)
  if (bus?.preset) refitPreset()

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
    onLocationChange(location, length)
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
  // Shows only the grid tiers whose cells stay comfortably apart at the current zoom, so the fine
  // 1 cm lines appear when close in and drop out (leaving 10 cm, then 1 m) as you pull back.
  const updateGridTiers = (): void => {
    if (!gridGroup.visible) return
    const mmPerPx = (camera.top - camera.bottom) / camera.zoom / (container.clientHeight || 1)
    if (!(mmPerPx > 0)) return
    for (const tier of gridTiers) tier.lines.visible = tier.step / mmPerPx >= GRID_MIN_PX
  }
  const render = () => {
    controls.update()
    updateGridTiers()
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
    for (const material of gridMaterials) material.resolution.set(width, height)
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

  applyBevelStyle()

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
    setBevelStyle(style: BevelStyle) {
      bevelStyleState = style
      applyBevelStyle()
    },
    setGridVisible(visible: boolean) {
      gridGroup.visible = visible
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
      // An NC-specific marker isn't drawn on this pane; skip the focus so it stays driven by the
      // manufactured pane (which has the marker) instead of framing every other marker here.
      if (index != null && sabre?.[index]?.ncOnly && !showNcOnlyMarkers) return
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
      bus?.presetListeners.delete(refitPreset)
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
      for (const line of cutEdgeObjects) {
        scene.remove(line)
        line.geometry.dispose()
        ;(line.material as LineMaterial).dispose()
      }
      for (const area of stepBevelObjects) {
        scene.remove(area)
        area.geometry.dispose()
        ;(area.material as MeshBasicMaterial).dispose()
      }
      for (const line of ncArrowObjects) {
        line.geometry.dispose()
        ;(line.material as LineMaterial).dispose()
      }
      for (const area of ncAreaObjects) {
        area.geometry.dispose()
        ;(area.material as MeshBasicMaterial).dispose()
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
      for (const tier of gridTiers) {
        scene.remove(tier.lines)
        tier.lines.geometry.dispose()
      }
      for (const material of gridMaterials) material.dispose()
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
  sabreFailures?: CutMarker[] | null
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
  /** Live location (mm, from one end) of the orbit pivot along the member, and the member's total
   *  length (mm), for the "where am I". */
  onLocationChange?: (locationMm: number, lengthMm: number) => void
  /** On-screen angle (deg, clockwise from +x) of the member's positive axis, for the compass arrow. */
  onAxisAngleChange?: (degrees: number) => void
  /** Overlay diff result, lifted so the shared legend strip can show it (null while building). */
  onDiffInfo?: (info: DiffStats | null) => void
  /** Controlled overlay toggles (shared toolbar). Omit to keep the per-pane buttons. */
  showStock?: boolean
  onShowStockChange?: (visible: boolean) => void
  /** Reference grid on the base plane, for a sense of scale. Omit to keep local state. */
  showGrid?: boolean
  onShowGridChange?: (visible: boolean) => void
  flipped?: boolean
  onFlippedChange?: (flipped: boolean) => void
  showDiff?: boolean
  onShowDiffChange?: (visible: boolean) => void
  showSabre?: boolean
  onShowSabreChange?: (visible: boolean) => void
  /** Hide the in-pane control buttons (the shared toolbar drives the toggles instead). */
  hideControls?: boolean
  /**
   * Colour the STEP model's cut edges (non-stock edges) by wall thickness, keyed to the NC
   * legend's thickness list. Omit to keep the plain dark edges.
   */
  cutEdges?: CutEdgeOptions | null
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
  onDiffInfo,
  showStock: showStockProp,
  onShowStockChange,
  showGrid: showGridProp,
  onShowGridChange,
  flipped: flippedProp,
  onFlippedChange,
  showDiff: showDiffProp,
  onShowDiffChange,
  showSabre: showSabreProp,
  onShowSabreChange,
  hideControls = false,
  cutEdges = null,
}: PartViewerProps) {
  const { t } = useTranslation()
  const containerRef = useRef<HTMLDivElement>(null)
  const handleRef = useRef<SceneHandle | null>(null)
  // Keep the location / axis-angle callbacks in refs so fresh closures never restart the scene.
  const onLocationRef = useRef(onLocationChange)
  onLocationRef.current = onLocationChange
  const onAxisAngleRef = useRef(onAxisAngleChange)
  onAxisAngleRef.current = onAxisAngleChange
  const onDiffInfoRef = useRef(onDiffInfo)
  onDiffInfoRef.current = onDiffInfo
  const showStockRef = useRef(true)
  const showDiffRef = useRef(true)
  const showGridRef = useRef(true)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [message, setMessage] = useState<string | null>(null)
  const [stockState, setStockState] = useState(true)
  const [flipState, setFlipState] = useState(false)
  const [hasStray, setHasStray] = useState(false)
  const [diffState, setDiffState] = useState(true)
  const [diffInfo, setDiffInfo] = useState<DiffStats | null>(null)
  const [diffPresence, setDiffPresence] = useState<DiffPresence | null>(null)
  const [sabreState, setSabreState] = useState(true)
  const [gridState, setGridState] = useState(true)
  const flippedRef = useRef(false)
  // The overlay toggles can be driven by a shared toolbar (controlled props) or fall back to
  // local state when the viewer is used standalone (e.g. the nesting viewer).
  const showStock = showStockProp ?? stockState
  const flipped = flippedProp ?? flipState
  const showDiff = showDiffProp ?? diffState
  const showSabre = showSabreProp ?? sabreState
  const showGrid = showGridProp ?? gridState
  const toggleStock = () =>
    onShowStockChange ? onShowStockChange(!showStock) : setStockState((value) => !value)
  const toggleFlip = () =>
    onFlippedChange ? onFlippedChange(!flipped) : setFlipState((value) => !value)
  const toggleDiff = () =>
    onShowDiffChange ? onShowDiffChange(!showDiff) : setDiffState((value) => !value)
  const toggleSabre = () =>
    onShowSabreChange ? onShowSabreChange(!showSabre) : setSabreState((value) => !value)
  const toggleGrid = () =>
    onShowGridChange ? onShowGridChange(!showGrid) : setGridState((value) => !value)

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
    onDiffInfoRef.current?.(null)
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
          'area',
          (mm, mmLength) => onLocationRef.current?.(mm, mmLength),
          (degrees) => onAxisAngleRef.current?.(degrees),
          cutEdges,
        )
        for (const overlay of handle.overlays) overlay.visible = showStockRef.current
        handle.setGridVisible(showGridRef.current)
        handle.setFlip(false)
        handleRef.current = handle
        setHasStray(highlightStray && step.bodies.some((body) => body.stray))
        setDiffPresence(handle.diffPresence)
        setStatus('ready')
        if (!compare) return
        // Let the models and the presence verdict paint, then pull the diff (already computed in the
        // worker when prewarmed; otherwise it resolves without blocking the main thread).
        await new Promise((resolve) => requestAnimationFrame(resolve))
        if (disposed) return
        const stats = await handle.runDiff()
        if (disposed) return
        handle.setDiffVisible(showDiffRef.current && !flippedRef.current)
        setDiffInfo(stats)
        onDiffInfoRef.current?.(stats)
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
    cutEdges,
    t,
  ])

  useEffect(() => {
    showStockRef.current = showStock
    for (const overlay of handleRef.current?.overlays ?? []) overlay.visible = showStock
  }, [showStock])

  useEffect(() => {
    showGridRef.current = showGrid
    handleRef.current?.setGridVisible(showGrid)
  }, [showGrid])

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
        {status === 'ready' && (
          <button
            type="button"
            onClick={toggleGrid}
            title={t('viewer.gridHint')}
            className="rounded-md border border-border bg-card/80 px-2.5 py-1 text-xs font-medium backdrop-blur transition-colors hover:bg-accent"
          >
            {showGrid ? t('viewer.hideGrid') : t('viewer.showGrid')}
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
