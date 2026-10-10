import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { syncGeometries } from 'replicad-threejs-helper'
import {
  AmbientLight,
  Box3,
  DirectionalLight,
  DoubleSide,
  EdgesGeometry,
  ExtrudeGeometry,
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
import { detectOrientation } from '@/lib/sections/orient'
import type { StockOutline } from '@/lib/sections/stock'
import { type MeshedStep, meshStepFile } from '@/lib/step/mesh'
import { attachOrbit, type OrbitBus } from './orbitSync'

const GHOST_COLOR = 0x3ddc84
const COMPARE_COLOR = 0xf59e0b
const STRAY_COLOR = 0xf97316
const FACE_MATERIAL = { color: 0xaebfd0, metalness: 0.55, roughness: 0.45 }
/** Roll about the length axis for each `detectOrientation` result (world YZ → profile-local). */
const SEAT_ANGLES = [0, -Math.PI / 2, Math.PI, Math.PI / 2]

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
        color: GHOST_COLOR,
        transparent: true,
        opacity: 0.16,
        depthWrite: false,
        side: DoubleSide,
      }),
    ),
  )
  group.add(
    new LineSegments(
      new EdgesGeometry(geometry, 15),
      new LineBasicMaterial({ color: GHOST_COLOR, transparent: true, opacity: 0.6 }),
    ),
  )
  return group
}

interface SceneHandle {
  dispose: () => void
  overlays: Group[]
  setFlip: (flip: boolean) => void
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
      if (withLines) group.add(new LineSegments(geometry.lines, lineMaterial))
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
    )
    scene.add(overlay)
    overlays.push(overlay)
  }
  if (beam && Array.isArray(beam.profile) && beam.profile.length >= 3 && beam.length > 0) {
    const overlay = extrudeOverlay(beam.profile, [], beam.length, unit(0, 1), unit(1, 1))
    scene.add(overlay)
    overlays.push(overlay)
  }

  // Frame the model and overlays in view.
  const fit = new Box3().expandByObject(primary.group)
  if (compareGroup) fit.expandByObject(compareGroup)
  for (const overlay of overlays) fit.expandByObject(overlay)
  const fitSize = fit.getSize(new Vector3())
  const fitCentre = fit.getCenter(new Vector3())

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
    setFlip(flip: boolean) {
      if (!compareGroup || !compareBaseQuaternion) return
      compareGroup.quaternion.copy(compareBaseQuaternion)
      compareGroup.rotateOnAxis(unit(0, 1), flip ? Math.PI : 0)
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
}: PartViewerProps) {
  const { t } = useTranslation()
  const containerRef = useRef<HTMLDivElement>(null)
  const handleRef = useRef<SceneHandle | null>(null)
  const showStockRef = useRef(true)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [message, setMessage] = useState<string | null>(null)
  const [showStock, setShowStock] = useState(true)
  const [flipped, setFlipped] = useState(false)
  const [hasStray, setHasStray] = useState(false)

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
    setFlipped(false)
    setHasStray(false)

    meshStepFile(name, bytes)
      .then(async (step) => {
        const compare = compareBytes ? await meshStepFile(`${name}·compare`, compareBytes) : null
        return { step, compare }
      })
      .then(({ step, compare }) => {
        if (disposed || !containerRef.current) return
        if (step.bodies[0]?.mesh.faces.triangles.length === 0) {
          setStatus('error')
          setMessage(t('viewer.noGeometry'))
          return
        }
        handle = mountScene(containerRef.current, step, compare, stock, beam, bus, highlightStray)
        for (const overlay of handle.overlays) overlay.visible = showStockRef.current
        handle.setFlip(false)
        handleRef.current = handle
        setHasStray(highlightStray && step.bodies.some((body) => body.stray))
        setStatus('ready')
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
  }, [name, bytes, compareBytes, stock, beam, bus, highlightStray, t])

  useEffect(() => {
    showStockRef.current = showStock
    for (const overlay of handleRef.current?.overlays ?? []) overlay.visible = showStock
  }, [showStock])

  useEffect(() => {
    handleRef.current?.setFlip(flipped)
  }, [flipped])

  const hasOverlay = Boolean((stock || beam) && status === 'ready')
  const hasCompare = Boolean(compareBytes && status === 'ready')

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full touch-none" />
      <div className="absolute left-3 top-3 flex gap-1">
        {hasOverlay && (
          <button
            type="button"
            onClick={() => setShowStock((value) => !value)}
            className="rounded-md border border-border bg-card/80 px-2.5 py-1 text-xs font-medium backdrop-blur transition-colors hover:bg-accent"
          >
            {showStock ? t('viewer.hideStock') : t('viewer.showStock')}
          </button>
        )}
        {hasCompare && (
          <button
            type="button"
            onClick={() => setFlipped((value) => !value)}
            className="rounded-md border border-border bg-card/80 px-2.5 py-1 text-xs font-medium backdrop-blur transition-colors hover:bg-accent"
          >
            {t('viewer.flip', { label: compareLabel })}
          </button>
        )}
        {hasStray && (
          <span className="flex items-center gap-2 rounded-md border border-orange-500/50 bg-card/80 px-2.5 py-1 text-xs font-medium text-orange-300 backdrop-blur">
            <span
              className="inline-block size-3 rounded-sm border border-orange-400"
              style={{ background: 'rgba(249, 115, 22, 0.5)' }}
            />
            {t('viewer.strayBody')}
          </span>
        )}
      </div>
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
