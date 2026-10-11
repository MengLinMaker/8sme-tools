import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { syncGeometries } from 'replicad-threejs-helper'
import {
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
  MeshStandardMaterial,
  OrthographicCamera,
  Path,
  Quaternion,
  Scene,
  Shape,
  Vector3,
  WebGLRenderer,
} from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { faceNormal, resolveNcFaceFrame } from '@/lib/parsers/ncFaces'
import type { NcFace, NcGeometry } from '@/lib/parsers/ncGeometry'
import { type NcLineSets, type NcProjection, projectNc, type Vec3 } from '@/lib/parsers/ncProject'
import { detectOrientation } from '@/lib/sections/orient'
import type { StockOutline } from '@/lib/sections/stock'
import {
  booleanDiff,
  cachedBooleanDiff,
  type DiffPresence,
  diffAlpha,
  probeDiffPresence,
} from '@/lib/step/booleanDiff'
import { computeDiffMasks, diffFraction, resolveDiffTolerance } from '@/lib/step/diffHighlight'
import type { MeshedStep } from '@/lib/step/mesh'
import { type SabreFailure, sabreBoundary } from '@/lib/step/sabre'
import { meshForViewer } from '@/lib/step/viewerModel'
import { cn } from '@/lib/utils'
import { NcLegend } from './NcLegend'
import { attachOrbit, type OrbitBus, requestFocus } from './orbitSync'
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
const UNDERCUT_RGB: [number, number, number] = [0x3b / 255, 0x82 / 255, 0xf6 / 255]
const FACE_MATERIAL = { color: 0x9aa3ad, metalness: 0.15, roughness: 0.75 }
/** Roll about the length axis for each `detectOrientation` result (world YZ → profile-local). */
const SEAT_ANGLES = [0, -Math.PI / 2, Math.PI, Math.PI / 2]

/** Projected NC toolpath colours: plain cuts, welding bevels, inner cut-outs, holes. */
const NC_COLOR = {
  outer: 0x3ddc84,
  bevel: 0xe879f9,
  inner: 0xf59e0b,
  holes: 0x38bdf8,
} as const

/** Builds one `LineSegments` from a flat XYZ pair list, or null when there is nothing to draw. */
function ncLineObject(points: number[], color: number): LineSegments | null {
  if (points.length === 0) return null
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(points, 3))
  const material = new LineBasicMaterial({ color, transparent: true, opacity: 0.95 })
  return new LineSegments(geometry, material)
}

/** Appends the four NC line sets to a scene as coloured segments, returning them for disposal. */
function addNcLines(nc: NcGeometry, projection: NcProjection): LineSegments[] {
  const sets: NcLineSets = projectNc(nc, projection)
  const entries: [number[], number][] = [
    [sets.outer, NC_COLOR.outer],
    [sets.bevel, NC_COLOR.bevel],
    [sets.inner, NC_COLOR.inner],
    [sets.holes, NC_COLOR.holes],
  ]
  const lines: LineSegments[] = []
  for (const [points, color] of entries) {
    const line = ncLineObject(points, color)
    if (line) lines.push(line)
  }
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
  /** Pull every synced viewport toward the geometry behind a finding code (null = whole model). */
  focus: (code: string | null) => void
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
  sabre?: SabreFailure[] | null,
  nc?: NcGeometry | null,
  ncSection?: [number, number][] | null,
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

  // Overlay mode (a second model is present): the base keeps the grey but goes only slightly
  // translucent (no depth write) so the red/blue diffs show through, while still reading as the
  // same grey base as the other panes. The compare (STEP) shell is more see-through still.
  const isOverlay = Boolean(compareStep && compareStep.bodies.length > 0)
  if (isOverlay) {
    faceMaterial.transparent = true
    faceMaterial.opacity = 0.8
    faceMaterial.depthWrite = false
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
  const ncObjects: LineSegments[] = []
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

    // Project the NC toolpath onto the face each cut lands on, using the shared section face
    // frame (the same rule the NC→solid rebuild uses). A cut with no material on its face (the
    // edge of the stock) is dropped. The projection uses the *exact* section (`ncSection`) when
    // available, so cuts and holes land exactly on the manufactured surface; a hair of offset
    // keeps them clear of z-fighting.
    if (nc) {
      const section = ncSection ?? profile
      const frame = resolveNcFaceFrame(section, nc)
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
      for (const line of addNcLines(nc, { frame, section, toScene, normal })) {
        scene.add(line)
        ncObjects.push(line)
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
      for (const line of addNcLines(nc, { frame, section: beam.profile, toScene, normal })) {
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

  // Boolean difference overlays, with the STEP treated as ideal. Both groups are
  // already seated in the same frame, so the booleans run in world coordinates:
  // red = STEP-minus-manufactured (overcut — scrap, cannot fix), blue =
  // manufactured-minus-STEP (undercut — leftover that can still be cut).
  // Coincident surfaces cancel, leaving only the volumetric leftovers. When the
  // CSG kernel can't run (over budget or failing input), fall back to red
  // surface-distance flagging.
  //
  // The multi-second boolean is deferred: the component paints the models plus
  // a fast presence verdict first, then runs the exact solids after paint.
  const diffMeshes: Mesh[] = []
  let diffStats: DiffStats | null = null
  let diffPresence: DiffPresence | null = null
  const soups = (meshed: MeshedStep) =>
    meshed.bodies.map((body) => ({
      vertices: body.mesh.faces.vertices,
      triangles: body.mesh.faces.triangles,
    }))
  const runDiff = (): DiffStats | null => {
    if (!compareStep || !compareGroup || diffStats) return diffStats
    const diagonal = Math.hypot(fitSize.x, fitSize.y, fitSize.z)
    const tolerance = resolveDiffTolerance(diagonal)
    const boolean =
      primaryBytes && compareBytes
        ? cachedBooleanDiff(
            soups(step),
            soups(compareStep),
            primary.group.matrixWorld,
            compareGroup.matrixWorld,
            primaryBytes,
            compareBytes,
          )
        : booleanDiff(
            soups(step),
            soups(compareStep),
            primary.group.matrixWorld,
            compareGroup.matrixWorld,
          )
    if (boolean) {
      // X-ray style: colours drawn after the shells with no depth test, so the
      // diffs composite over everything instead of being dimmed by the
      // translucent bases in front of them. Strength is per-face alpha from
      // the clearance distance (faint just past tolerance, solid a few mm
      // out), so thin skins whisper while real cuts pop — via RGBA vertex
      // colours, which is why the materials themselves stay white.
      const overcutMaterial = new MeshStandardMaterial({
        color: 0xffffff,
        vertexColors: true,
        emissive: 0xff2222,
        emissiveIntensity: 1.2,
        metalness: 0,
        roughness: 0.5,
        transparent: true,
        depthTest: false,
        depthWrite: false,
      })
      const undercutMaterial = new MeshStandardMaterial({
        color: 0xffffff,
        vertexColors: true,
        emissive: 0x2f7bff,
        emissiveIntensity: 1.2,
        metalness: 0,
        roughness: 0.5,
        transparent: true,
        depthTest: false,
        depthWrite: false,
      })
      materials.push(overcutMaterial, undercutMaterial)
      if (boolean.over) {
        paintDiffAlpha(boolean.over, boolean.overDistance, OVERCUT_RGB)
        const mesh = new Mesh(boolean.over, overcutMaterial)
        mesh.renderOrder = 10
        scene.add(mesh)
        diffMeshes.push(mesh)
      }
      if (boolean.under) {
        paintDiffAlpha(boolean.under, boolean.underDistance, UNDERCUT_RGB)
        const mesh = new Mesh(boolean.under, undercutMaterial)
        mesh.renderOrder = 10
        scene.add(mesh)
        diffMeshes.push(mesh)
      }
      const volume = boolean.primaryVolume > 0 ? boolean.primaryVolume : 1
      diffStats = {
        over: boolean.overVolume / volume,
        under: boolean.underVolume / volume,
        tolerance,
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
      const diffMaterial = new MeshStandardMaterial({
        color: OVERCUT_COLOR,
        emissive: 0xff2222,
        emissiveIntensity: 1,
        metalness: 0,
        roughness: 0.5,
        transparent: true,
        depthTest: false,
        depthWrite: false,
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
        mesh.renderOrder = 10
        primary.group.add(mesh)
        diffMeshes.push(mesh)
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
        mesh.renderOrder = 10
        compareGroup.add(mesh)
        diffMeshes.push(mesh)
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

  // Light-sabre overlay: red cut lines tracing the guilty patch perimeter. Only boundary
  // edges draw — shared internal diagonals are dropped, so a tiled patch reads as one loop,
  // not a hatch. The bevel itself is a side cut line with a specified angle (kept in the NC
  // weld-prep data and shown as a label), never a face-normal arrow. Local coordinates,
  // parented to the seated primary group so the marks follow the model. Depth test off +
  // high render order, so the guilty lines read through the solid.
  const sabreObjects: LineSegments[] = []
  if (sabre && sabre.length > 0) {
    const biggest = [...sabre].sort((a, b) => b.area - a.area).slice(0, 200)
    const cutPts: number[] = []
    for (const edge of sabreBoundary(biggest)) {
      const n = edge.normal
      // Nudge just off the surface along the outward normal so lines never z-fight.
      const off = (p: [number, number, number]): [number, number, number] => [
        p[0] + n[0] * 0.15,
        p[1] + n[1] * 0.15,
        p[2] + n[2] * 0.15,
      ]
      cutPts.push(...off(edge.a), ...off(edge.b))
    }
    if (cutPts.length > 0) {
      const lineGeometry = new BufferGeometry()
      lineGeometry.setAttribute('position', new Float32BufferAttribute(cutPts, 3))
      const lineMaterial = new LineBasicMaterial({
        color: SABRE_CUT_COLOR,
        depthTest: false,
        depthWrite: false,
        transparent: true,
        opacity: 0.95,
      })
      const lines = new LineSegments(lineGeometry, lineMaterial)
      lines.renderOrder = 11
      primary.group.add(lines)
      sabreObjects.push(lines)
      materials.push(lineMaterial)
    }
  }

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
  controls.target.copy(fitCentre)
  const detachOrbit = bus
    ? attachOrbit(bus, camera, controls, {
        centre: [fitCentre.x, fitCentre.y, fitCentre.z],
        distance,
        radius: baseHalf,
      })
    : null

  let raf = 0
  const render = () => {
    controls.update()
    renderer.render(scene, camera)
    raf = requestAnimationFrame(render)
  }
  render()

  const resize = () => {
    const width = container.clientWidth
    const height = container.clientHeight
    if (!width || !height) return
    renderer.setSize(width, height)
    applyFrustum(width, height)
  }
  const observer = new ResizeObserver(resize)
  observer.observe(container)

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
    },
    setSabreVisible(visible: boolean) {
      for (const lines of sabreObjects) lines.visible = visible
    },
    focus(code: string | null) {
      if (!bus) return
      const box = new Box3()
      const cut = code?.startsWith('CUT') ?? false
      if (cut && sabreObjects.length > 0) {
        for (const lines of sabreObjects) box.expandByObject(lines)
      } else if (cut && ncObjects.length > 0) {
        for (const line of ncObjects) box.expandByObject(line)
      } else {
        box.expandByObject(primary.group)
      }
      if (box.isEmpty()) return
      const centre = box.getCenter(new Vector3())
      const size = box.getSize(new Vector3())
      const radius = Math.max(size.x, size.y, size.z) / 2
      requestFocus(bus, { point: [centre.x, centre.y, centre.z], radius })
    },
    dispose() {
      cancelAnimationFrame(raf)
      observer.disconnect()
      detachOrbit?.()
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
      for (const line of ncObjects) {
        line.geometry.dispose()
        ;(line.material as LineBasicMaterial).dispose()
      }
      for (const lines of sabreObjects) {
        primary.group.remove(lines)
        lines.geometry.dispose()
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
  /** light-sabre failures — drawn as red cut lines tracing the guilty patch perimeter */
  sabreFailures?: SabreFailure[] | null
  /** bevel angle (whole degrees) the NC specifies at the guilty cut, for the legend */
  sabreBevelAngle?: number | null
  /** NC toolpath geometry to project onto this (manufactured) model */
  nc?: NcGeometry | null
  /** Exact (un-inflated) section outline the NC was matched against, for the projection */
  ncSection?: [number, number][] | null
  /** Show the NC toolpath colour legend in-pane (off when it lives in the shared header strip) */
  showNcLegend?: boolean
  /** Clicked-finding focus: bump `token` to pull every synced viewport to `code`'s geometry. */
  focus?: { code: string; token: number } | null
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
  sabreBevelAngle = null,
  nc = null,
  ncSection = null,
  showNcLegend = true,
  focus = null,
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

  // Clicking a finding pans/zooms the synced viewports to its geometry.
  const focusToken = focus?.token
  const focusCode = focus?.code ?? null
  useEffect(() => {
    if (focusToken === undefined) return
    handleRef.current?.focus(focusCode)
  }, [focusToken, focusCode])
  const hasOverlay = Boolean((stock || beam) && status === 'ready')
  const hasCompare = Boolean(compareBytes && status === 'ready')
  const hasSabre = Boolean(sabreFailures && sabreFailures.length > 0 && status === 'ready')
  const hasNc = Boolean(nc && status === 'ready')
  const hasDiff = Boolean(hasCompare && diffInfo)
  const diffClean = diffInfo != null && diffInfo.over < 0.001 && diffInfo.under < 0.001
  // Fast probe verdict, shown while the exact boolean still runs.
  const diffFound = Boolean(hasCompare && !diffInfo && diffPresence?.found)

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full touch-none" />
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
      {hasSabre && showSabre && (
        <div className="absolute bottom-3 right-3 z-10 flex items-center gap-2 rounded-md border border-border bg-card/80 px-2.5 py-1 text-xs font-medium backdrop-blur">
          <span
            className="inline-block size-3 rounded-sm border border-red-400"
            style={{ background: 'rgba(255, 43, 43, 0.65)' }}
          />
          <span className="text-red-300">{t('viewer.sabreCut')}</span>
          {sabreBevelAngle != null && (
            <>
              <span
                className="inline-block size-3 rounded-sm border border-amber-400"
                style={{ background: 'rgba(251, 191, 36, 0.65)' }}
              />
              <span className="text-amber-300">
                {t('viewer.sabreBevelAngle', { angle: sabreBevelAngle })}
              </span>
            </>
          )}
        </div>
      )}
      {hasNc && showNcLegend && (
        <div className="absolute left-3 top-12 z-10 flex flex-wrap items-center gap-2 rounded-md border border-border bg-card/80 px-2.5 py-1 text-xs font-medium backdrop-blur">
          <NcLegend />
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
