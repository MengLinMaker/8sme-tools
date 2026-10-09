import { useEffect, useRef, useState } from 'react'
import { type ReplicadMesh, syncGeometries } from 'replicad-threejs-helper'
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
  PerspectiveCamera,
  Scene,
  Shape,
  Vector3,
  WebGLRenderer,
} from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { meshStepFile } from '@/lib/step/mesh'

const GHOST_COLOR = 0x3ddc84
const FACE_MATERIAL = { color: 0xaebfd0, metalness: 0.55, roughness: 0.45 }

/** Cross-section of the uncut stock bar a part is cut from (mm). */
export interface StockProfile {
  /** flange width b */
  b: number
  /** total T depth (half the parent UB depth) */
  depth: number
  /** flange thickness tf */
  tf: number
  /** web thickness tw */
  tw: number
}

/** The T-shaped stock cross-section (mm), centred on its bounding box. */
function stockPolygon(profile: StockProfile): [number, number][] {
  const { b, depth, tf, tw } = profile
  const hb = b / 2
  const hd = depth / 2
  const hw = tw / 2
  return [
    [-hb, -hd],
    [hb, -hd],
    [hb, -hd + tf],
    [hw, -hd + tf],
    [hw, hd],
    [-hw, hd],
    [-hw, -hd + tf],
    [-hb, -hd + tf],
  ]
}

function pointInPolygon(x: number, y: number, polygon: [number, number][]): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]
    const [xj, yj] = polygon[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** World→local transform for each 90° rotation about the length axis. */
const ORIENTATIONS: ((u: number, v: number) => [number, number])[] = [
  (u, v) => [u, v],
  (u, v) => [v, -u],
  (u, v) => [-u, -v],
  (u, v) => [-v, u],
]

/**
 * Picks the rotation that best seats the part inside the stock profile by
 * counting how many part cross-section vertices land within a slightly enlarged
 * T polygon. The T is not symmetric end-to-end, so guessing the orientation from
 * bounding-box extents alone seats it wrong roughly half the time.
 */
function chooseOrientation(
  profile: StockProfile,
  vertices: number[],
  crossA: number,
  crossB: number,
  centre: Vector3,
): number {
  const polygon = stockPolygon(profile)
  const scale = 1 + 2 / Math.max(profile.b, profile.depth)
  const enlarged = polygon.map(([x, y]) => [x * scale, y * scale] as [number, number])
  const centreA = centre.getComponent(crossA)
  const centreB = centre.getComponent(crossB)
  const stride = Math.max(3, Math.floor(vertices.length / 3 / 4000) * 3)

  let best = 0
  let bestScore = -1
  for (let orientation = 0; orientation < ORIENTATIONS.length; orientation++) {
    const map = ORIENTATIONS[orientation]
    let score = 0
    for (let i = 0; i + 2 < vertices.length; i += stride) {
      const [lx, ly] = map(vertices[i + crossA] - centreA, vertices[i + crossB] - centreB)
      if (pointInPolygon(lx, ly, enlarged)) score++
    }
    if (score > bestScore) {
      bestScore = score
      best = orientation
    }
  }
  return best
}

/**
 * Builds the translucent "ghost" of the uncut stock bar: the clean T-section
 * extruded to the part's length and rotated to the orientation that seats the
 * finished part inside it.
 */
function buildStockBeam(
  profile: StockProfile,
  length: number,
  crossA: number,
  crossB: number,
  orientation: number,
): Group {
  const polygon = stockPolygon(profile)
  const shape = new Shape()
  shape.moveTo(polygon[0][0], polygon[0][1])
  for (let i = 1; i < polygon.length; i++) shape.lineTo(polygon[i][0], polygon[i][1])
  shape.closePath()

  const unit = (axis: number, sign: number) => {
    const vector = new Vector3()
    vector.setComponent(axis, sign)
    return vector
  }
  const eA = unit(crossA, 1)
  const eB = unit(crossB, 1)
  const bases: [Vector3, Vector3][] = [
    [eA, eB],
    [eB, eA.clone().negate()],
    [eA.clone().negate(), eB.clone().negate()],
    [eB.clone().negate(), eA],
  ]
  const [xAxis, yAxis] = bases[orientation]
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

/** Translucent stock beam: the given cross-section extruded along Z from 0 to length. */
function buildBeamGhost(profile: [number, number][], length: number): Group {
  const shape = new Shape()
  shape.moveTo(profile[0][0], profile[0][1])
  for (let i = 1; i < profile.length; i++) shape.lineTo(profile[i][0], profile[i][1])
  shape.closePath()

  const geometry = new ExtrudeGeometry(shape, { depth: length, bevelEnabled: false })
  const group = new Group()
  group.add(
    new Mesh(
      geometry,
      new MeshStandardMaterial({
        color: GHOST_COLOR,
        transparent: true,
        opacity: 0.12,
        depthWrite: false,
        side: DoubleSide,
      }),
    ),
  )
  group.add(
    new LineSegments(
      new EdgesGeometry(geometry, 15),
      new LineBasicMaterial({ color: GHOST_COLOR, transparent: true, opacity: 0.55 }),
    ),
  )
  return group
}

interface SceneHandle {
  dispose: () => void
  ghost: Group | null
}

/** Builds the three.js scene for a set of meshes and returns a disposer. */
function mountScene(
  container: HTMLElement,
  replicadMeshes: ReplicadMesh[],
  stock: StockProfile | null,
  beam: { profile: [number, number][]; length: number } | null,
): SceneHandle {
  const renderer = new WebGLRenderer({ antialias: true, alpha: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setSize(container.clientWidth || 1, container.clientHeight || 1)
  container.appendChild(renderer.domElement)

  const scene = new Scene()
  const camera = new PerspectiveCamera(45, 1, 0.1, 100000)

  scene.add(new AmbientLight(0xffffff, 0.6))
  scene.add(new HemisphereLight(0xf2f7ff, 0x1a2733, 0.9))
  const key = new DirectionalLight(0xffffff, 2.6)
  key.position.set(0.8, 1, 0.9)
  scene.add(key)
  const fill = new DirectionalLight(0xffffff, 1.1)
  fill.position.set(-1, -0.6, -0.8)
  scene.add(fill)

  const geometries = syncGeometries(replicadMeshes, [])
  const group = new Group()
  const materials: Material[] = []
  for (const geometry of geometries) {
    const face = new MeshStandardMaterial(FACE_MATERIAL)
    const line = new LineBasicMaterial({ color: 0x0b0f14 })
    materials.push(face, line)
    group.add(new Mesh(geometry.faces, face))
    group.add(new LineSegments(geometry.lines, line))
  }
  scene.add(group)

  const bounds = new Box3().setFromObject(group)
  const centre = bounds.getCenter(new Vector3())

  let ghost: Group | null = null
  if (beam) {
    // Keep the part in its own STEP coordinates so it sits inside the stock beam.
    ghost = buildBeamGhost(beam.profile, beam.length)
    scene.add(ghost)
  } else {
    // Centre the part and (optionally) show its uncut stock profile.
    group.position.sub(centre)
    const size = bounds.getSize(new Vector3())
    const extents = [size.x, size.y, size.z]
    const longAxis = extents.indexOf(Math.max(...extents))
    if (stock && extents[longAxis] > 0) {
      const cross = [0, 1, 2].filter((axis) => axis !== longAxis)
      const crossA = cross[0]
      const crossB = cross[1]
      const vertices = replicadMeshes[0]?.faces.vertices ?? []
      const orientation = vertices.length
        ? chooseOrientation(stock, vertices, crossA, crossB, centre)
        : 0
      ghost = buildStockBeam(stock, extents[longAxis], crossA, crossB, orientation)
      scene.add(ghost)
    }
  }

  // Frame the part and (optional) ghost in view.
  const fit = new Box3().expandByObject(group)
  if (ghost) fit.expandByObject(ghost)
  const fitSize = fit.getSize(new Vector3())
  const fitCentre = fit.getCenter(new Vector3())

  const maxDim = Math.max(fitSize.x, fitSize.y, fitSize.z) || 1
  const fitDistance = (maxDim / 2 / Math.tan((camera.fov * Math.PI) / 180 / 2)) * 1.9
  camera.position
    .copy(fitCentre)
    .add(new Vector3(fitDistance * 0.85, fitDistance * 0.65, fitDistance))
  camera.near = Math.max(maxDim / 1000, 0.01)
  camera.far = maxDim * 100
  camera.updateProjectionMatrix()
  camera.lookAt(fitCentre)

  const controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  controls.dampingFactor = 0.08
  controls.target.copy(fitCentre)

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
    camera.aspect = width / height
    camera.updateProjectionMatrix()
  }
  const observer = new ResizeObserver(resize)
  observer.observe(container)

  return {
    ghost,
    dispose() {
      cancelAnimationFrame(raf)
      observer.disconnect()
      controls.dispose()
      for (const geometry of geometries) {
        geometry.faces.dispose()
        geometry.lines.dispose()
      }
      for (const material of materials) material.dispose()
      ghost?.traverse((object) => {
        if (object instanceof Mesh || object instanceof LineSegments) {
          object.geometry.dispose()
          const material = object.material
          if (Array.isArray(material)) for (const item of material) item.dispose()
          else material.dispose()
        }
      })
      renderer.dispose()
      renderer.domElement.remove()
    },
  }
}

export interface PartViewerProps {
  name: string
  bytes: Uint8Array | undefined
  stock?: StockProfile | null
  /** Stock beam to overlay the parts inside (profile in XY, extruded along Z). */
  beam?: { profile: [number, number][]; length: number } | null
}

export default function PartViewer({ name, bytes, stock = null, beam = null }: PartViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const handleRef = useRef<SceneHandle | null>(null)
  const showStockRef = useRef(true)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [message, setMessage] = useState<string | null>(null)
  const [showStock, setShowStock] = useState(true)

  useEffect(() => {
    if (!bytes) {
      setStatus('error')
      setMessage('The STEP file for this part could not be found in the dropped job.')
      return
    }
    let disposed = false
    let handle: SceneHandle | null = null
    setStatus('loading')
    setMessage(null)

    meshStepFile(name, bytes)
      .then((meshes) => {
        if (disposed || !containerRef.current) return
        if (meshes[0]?.faces.triangles.length === 0) {
          setStatus('error')
          setMessage('The STEP file contains no renderable geometry.')
          return
        }
        handle = mountScene(containerRef.current, meshes, stock, beam)
        if (handle.ghost) handle.ghost.visible = showStockRef.current
        handleRef.current = handle
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
  }, [name, bytes, stock, beam])

  useEffect(() => {
    showStockRef.current = showStock
    if (handleRef.current?.ghost) handleRef.current.ghost.visible = showStock
  }, [showStock])

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full touch-none" />
      {(stock || beam) && status === 'ready' && (
        <button
          type="button"
          onClick={() => setShowStock((value) => !value)}
          className="absolute left-3 top-3 rounded-md border border-border bg-card/80 px-2.5 py-1 text-xs font-medium backdrop-blur transition-colors hover:bg-accent"
        >
          {showStock ? 'Hide stock' : 'Show stock'}
        </button>
      )}
      {status !== 'ready' && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center px-6 text-center">
          <p className="max-w-sm text-sm text-muted-foreground">
            {status === 'loading'
              ? 'Loading 3D model… (first view loads the ~23 MB CAD kernel)'
              : `Could not render this STEP file: ${message ?? 'unknown error'}`}
          </p>
        </div>
      )}
    </div>
  )
}
