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
  OrthographicCamera,
  Path,
  Scene,
  Shape,
  Vector3,
  WebGLRenderer,
} from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { detectOrientation } from '@/lib/sections/orient'
import type { StockOutline } from '@/lib/sections/stock'
import { meshStepFile } from '@/lib/step/mesh'
import { attachOrbit, type OrbitBus } from './orbitSync'

const GHOST_COLOR = 0x3ddc84
const FACE_MATERIAL = { color: 0xaebfd0, metalness: 0.55, roughness: 0.45 }

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

function unit(axis: number, sign: number): Vector3 {
  const vector = new Vector3()
  vector.setComponent(axis, sign)
  return vector
}

interface SceneHandle {
  dispose: () => void
  overlays: Group[]
}

/** Builds the three.js scene for a set of meshes and returns a disposer. */
function mountScene(
  container: HTMLElement,
  replicadMeshes: ReplicadMesh[],
  stock: StockOutline | null,
  beam: BeamOutline | null,
  bus: OrbitBus | null,
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

  // Centre the part at the origin.
  const bounds = new Box3().setFromObject(group)
  const size = bounds.getSize(new Vector3())
  const centre = bounds.getCenter(new Vector3())
  group.position.sub(centre)

  const overlays: Group[] = []
  const extents = [size.x, size.y, size.z]
  const longAxis = extents.indexOf(Math.max(...extents))
  const stockPoints = stock?.points
  if (Array.isArray(stockPoints) && stockPoints.length >= 3 && extents[longAxis] > 0) {
    const cross = [0, 1, 2].filter((axis) => axis !== longAxis)
    const crossA = cross[0]
    const crossB = cross[1]
    const vertices = replicadMeshes[0]?.faces.vertices ?? []
    const orientation = vertices.length
      ? detectOrientation(stockPoints, vertices, crossA, crossB, [centre.x, centre.y, centre.z])
      : 0
    const eA = unit(crossA, 1)
    const eB = unit(crossB, 1)
    const [xAxis, yAxis] = [
      [eA, eB],
      [eB, eA.clone().negate()],
      [eA.clone().negate(), eB.clone().negate()],
      [eB.clone().negate(), eA],
    ][orientation]
    const overlay = extrudeOverlay(
      stockPoints,
      Array.isArray(stock?.holes) ? stock.holes : [],
      extents[longAxis],
      xAxis,
      yAxis,
    )
    scene.add(overlay)
    overlays.push(overlay)
  }
  if (beam && Array.isArray(beam.profile) && beam.profile.length >= 3 && beam.length > 0) {
    // Authored in the same frame as the generated STEP, so no re-orientation.
    const overlay = extrudeOverlay(beam.profile, [], beam.length, unit(0, 1), unit(1, 1))
    scene.add(overlay)
    overlays.push(overlay)
  }

  // Frame the part and overlays in view.
  const fit = new Box3().expandByObject(group)
  for (const overlay of overlays) fit.expandByObject(overlay)
  const fitSize = fit.getSize(new Vector3())
  const fitCentre = fit.getCenter(new Vector3())

  const maxDim = Math.max(fitSize.x, fitSize.y, fitSize.z) || 1
  const aspect = (container.clientWidth || 1) / (container.clientHeight || 1)
  const frustumHeight = maxDim * 1.4
  const halfHeight = frustumHeight / 2
  const halfWidth = halfHeight * aspect
  const camera = new OrthographicCamera(
    -halfWidth,
    halfWidth,
    halfHeight,
    -halfHeight,
    Math.max(maxDim / 1000, 0.01),
    maxDim * 100,
  )

  // Default to a true isometric angle: equal X/Y/Z so no axis is foreshortened.
  const distance = maxDim * 2
  camera.position
    .copy(fitCentre)
    .add(new Vector3(distance, distance, distance).multiplyScalar(1 / Math.sqrt(3)))
  camera.lookAt(fitCentre)

  const controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  controls.dampingFactor = 0.08
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
    const halfH = frustumHeight / 2
    const halfW = halfH * (width / height)
    camera.left = -halfW
    camera.right = halfW
    camera.top = halfH
    camera.bottom = -halfH
    camera.updateProjectionMatrix()
  }
  const observer = new ResizeObserver(resize)
  observer.observe(container)

  return {
    overlays,
    dispose() {
      cancelAnimationFrame(raf)
      observer.disconnect()
      detachOrbit?.()
      controls.dispose()
      for (const geometry of geometries) {
        geometry.faces.dispose()
        geometry.lines.dispose()
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
  stock?: StockOutline | null
  beam?: BeamOutline | null
  bus?: OrbitBus | null
}

export default function PartViewer({
  name,
  bytes,
  stock = null,
  beam = null,
  bus = null,
}: PartViewerProps) {
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
        handle = mountScene(containerRef.current, meshes, stock, beam, bus)
        for (const overlay of handle.overlays) overlay.visible = showStockRef.current
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
  }, [name, bytes, stock, beam, bus])

  useEffect(() => {
    showStockRef.current = showStock
    for (const overlay of handleRef.current?.overlays ?? []) overlay.visible = showStock
  }, [showStock])

  const hasOverlay = Boolean(stock || beam)

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full touch-none" />
      {hasOverlay && status === 'ready' && (
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
