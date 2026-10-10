import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AmbientLight,
  Box3,
  BufferGeometry,
  DirectionalLight,
  Float32BufferAttribute,
  Group,
  HemisphereLight,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  Scene,
  SphereGeometry,
  Vector3,
  WebGLRenderer,
} from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { type NcGeometry, parseNcGeometry } from '@/lib/parsers/ncGeometry'
import type { SabreStation } from '@/lib/step/sabreToNc'
import { attachOrbit, type OrbitBus } from './orbitSync'

type Point = [number, number, number]

/** Guilty light-sabre cut lines draw in strong red, on top of the solid. */
const SABRE_COLOR = 0xff2b2b

export type NcPoint = Point

interface FaceInfo {
  width: number
}

function faceWidth(geometry: NcGeometry, face: string): number {
  let max = 0
  for (const contour of geometry.contours) {
    if (contour.face !== face) continue
    for (const [, y] of contour.points) max = Math.max(max, y)
  }
  for (const hole of geometry.holes) {
    if (hole.face !== face) continue
    max = Math.max(max, hole.y + hole.diameter / 2)
  }
  return max
}

/** Places a per-face (X along member, Y across face) point on the beam's bounding faces. */
function project(face: string, x: number, y: number, length: number, info: FaceInfo): Point {
  const ox = x - length / 2
  const half = info.width / 2 + 2
  const oy = y - info.width / 2
  if (face === 'o') return [ox, half, oy]
  if (face === 'u') return [ox, -half, oy]
  if (face === 'v') return [ox, oy, half]
  return [ox, oy, -half] // h
}

/** Per-face outer segments + inner contours + holes, shared with the nesting stitch view. */
export function segmentsFor(geometry: NcGeometry): {
  outerByFace: Map<string, Point[]>
  /** NC-X range of each outer segment, aligned segment-for-segment with `outerByFace`. */
  outerRanges: Map<string, [number, number][]>
  inner: Point[]
  holes: Point[]
} {
  let length = 0
  for (const contour of geometry.contours) {
    for (const [x] of contour.points) length = Math.max(length, x)
  }
  for (const hole of geometry.holes) length = Math.max(length, hole.x + hole.diameter / 2)
  const width = Math.max(1, ...['v', 'o', 'u', 'h'].map((face) => faceWidth(geometry, face)))
  const info: FaceInfo = { width }
  const outerByFace = new Map<string, Point[]>()
  const outerRanges = new Map<string, [number, number][]>()
  const inner: Point[] = []
  const holes: Point[] = []

  const addContour = (
    target: Point[],
    points: number[][],
    face: string,
    ranges?: [number, number][],
  ) => {
    for (let i = 0; i < points.length - 1; i++) {
      target.push(
        project(face, points[i][0], points[i][1], length, info),
        project(face, points[i + 1][0], points[i + 1][1], length, info),
      )
      ranges?.push([points[i][0], points[i + 1][0]])
    }
  }

  for (const contour of geometry.contours) {
    const points = contour.points.map((p) => [p[0], p[1]])
    if (contour.kind === 'inner') {
      addContour(inner, points, contour.face)
    } else {
      const face = contour.face
      const target = outerByFace.get(face) ?? []
      const ranges = outerRanges.get(face) ?? []
      addContour(target, points, face, ranges)
      outerByFace.set(face, target)
      outerRanges.set(face, ranges)
    }
  }
  for (const hole of geometry.holes) {
    const r = hole.diameter / 2
    const ring: number[][] = []
    const steps = 24
    for (let i = 0; i <= steps; i++) {
      const angle = (i / steps) * Math.PI * 2
      ring.push([hole.x + Math.cos(angle) * r, hole.y + Math.sin(angle) * r] as number[])
    }
    for (let i = 0; i < ring.length - 1; i++) {
      holes.push(
        project(hole.face, ring[i][0], ring[i][1], length, info),
        project(hole.face, ring[i + 1][0], ring[i + 1][1], length, info),
      )
    }
  }
  return { outerByFace, outerRanges, inner, holes }
}

function toGeometry(points: Point[]): BufferGeometry {
  const attribute = new Float32BufferAttribute(points.flat(), 3)
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', attribute)
  return geometry
}

function mountScene(
  container: HTMLElement,
  geometry: NcGeometry,
  bus: OrbitBus,
  badFaces: Set<string>,
  sabreStations?: SabreStation[] | null,
): () => void {
  const renderer = new WebGLRenderer({ antialias: true, alpha: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setSize(container.clientWidth || 1, container.clientHeight || 1)
  container.appendChild(renderer.domElement)

  const scene = new Scene()
  scene.add(new AmbientLight(0xffffff, 0.7))
  scene.add(new HemisphereLight(0xf2f7ff, 0x1a2733, 0.9))
  const key = new DirectionalLight(0xffffff, 1.5)
  key.position.set(0.8, 1, 0.9)
  scene.add(key)

  const group = new Group()
  const { outerByFace, outerRanges, inner, holes } = segmentsFor(geometry)
  const lines: LineSegments[] = []
  const materials: LineBasicMaterial[] = []
  const sabreMarkers: Mesh[] = []
  let sabreMaterial: MeshBasicMaterial | null = null
  // Outer contours, coloured red on any face flagged not-manufacturable and green otherwise.
  const outerLines: [Point[], number][] = [...outerByFace.entries()].map(([face, points]) => [
    points,
    badFaces.has(face) ? 0xef4444 : 0x3ddc84,
  ])
  for (const [points, color] of [...outerLines, [inner, 0xf59e0b], [holes, 0x38bdf8]] as [
    Point[],
    number,
  ][]) {
    if (points.length === 0) continue
    const material = new LineBasicMaterial({ color })
    materials.push(material)
    const line = new LineSegments(toGeometry(points), material)
    lines.push(line)
    group.add(line)
  }
  // Light-sabre guilty cuts: outer segments near a mapped failure station draw strong red on
  // top, with a dot at each face's guilty cluster — so the responsible cut line is obvious.
  // Faces are deliberately not mapped (no shared roll convention), so every face's segments
  // near the station light up and the STEP view carries the exact face.
  const stations = sabreStations ?? []
  if (stations.length > 0) {
    const near = (x0: number, x1: number) =>
      stations.some(
        (station) =>
          (x0 > station.x - station.window && x0 < station.x + station.window) ||
          (x1 > station.x - station.window && x1 < station.x + station.window),
      )
    sabreMaterial = new MeshBasicMaterial({
      color: SABRE_COLOR,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      opacity: 0.95,
    })
    for (const [face, points] of outerByFace.entries()) {
      const ranges = outerRanges.get(face) ?? []
      const guilty: Point[] = []
      const centroid: [number, number, number] = [0, 0, 0]
      let count = 0
      for (let s = 0; s < ranges.length; s++) {
        const [x0, x1] = ranges[s]
        if (!near(x0, x1)) continue
        const p0 = points[s * 2]
        const p1 = points[s * 2 + 1]
        guilty.push(p0, p1)
        centroid[0] += (p0[0] + p1[0]) / 2
        centroid[1] += (p0[1] + p1[1]) / 2
        centroid[2] += (p0[2] + p1[2]) / 2
        count++
      }
      if (guilty.length === 0) continue
      const guiltyMaterial = new LineBasicMaterial({
        color: SABRE_COLOR,
        depthTest: false,
        depthWrite: false,
        transparent: true,
        opacity: 0.95,
      })
      materials.push(guiltyMaterial)
      const guiltyLines = new LineSegments(toGeometry(guilty), guiltyMaterial)
      guiltyLines.renderOrder = 5
      lines.push(guiltyLines)
      group.add(guiltyLines)
      const marker = new Mesh(
        new SphereGeometry(1, 12, 8),
        sabreMaterial,
      )
      marker.position.set(centroid[0] / count, centroid[1] / count, centroid[2] / count)
      marker.renderOrder = 6
      sabreMarkers.push(marker)
      group.add(marker)
    }
  }
  scene.add(group)

  if (lines.length === 0) {
    renderer.dispose()
    renderer.domElement.remove()
    return () => {}
  }

  const bounds = new Box3().setFromObject(group)
  const size = bounds.getSize(new Vector3())
  const centre = bounds.getCenter(new Vector3())
  group.position.sub(centre)
  const maxDim = Math.max(size.x, size.y, size.z) || 1
  // Guilty-cut dots scale with the part so they read on 100 mm brackets and 12 m beams alike.
  if (sabreMarkers.length > 0) {
    const dotRadius = Math.min(8, Math.max(1.5, maxDim * 0.008))
    for (const marker of sabreMarkers) marker.scale.setScalar(dotRadius)
  }

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
  camera.position.set(distance, distance, distance).multiplyScalar(1 / Math.sqrt(3))
  camera.lookAt(0, 0, 0)

  const controls = new OrbitControls(camera, renderer.domElement)
  controls.target.set(0, 0, 0)
  const detachOrbit = attachOrbit(bus, camera, controls, { centre: [0, 0, 0], distance })

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

  return () => {
    cancelAnimationFrame(raf)
    observer.disconnect()
    detachOrbit()
    controls.dispose()
    for (const line of lines) line.geometry.dispose()
    for (const marker of sabreMarkers) marker.geometry.dispose()
    sabreMaterial?.dispose()
    for (const material of materials) material.dispose()
    renderer.dispose()
    renderer.domElement.remove()
  }
}

const NO_BAD_FACES: string[] = []

const NO_SABRE_STATIONS: SabreStation[] = []

export default function Nc3dViewer({
  bytes,
  bus,
  badFaces = NO_BAD_FACES,
  sabreStations = NO_SABRE_STATIONS,
}: {
  bytes: Uint8Array
  bus: OrbitBus
  /** Faces flagged not-manufacturable — their outer contours draw red. */
  badFaces?: string[]
  /** Guilty light-sabre cut stations (NC X coords) — nearby outer segments draw red. */
  sabreStations?: SabreStation[] | null
}) {
  const { t } = useTranslation()
  const containerRef = useRef<HTMLDivElement>(null)
  const [empty, setEmpty] = useState(false)

  useEffect(() => {
    if (!containerRef.current) return
    const geometry = parseNcGeometry(new TextDecoder().decode(bytes))
    if (geometry.contours.length === 0 && geometry.holes.length === 0) {
      setEmpty(true)
      return
    }
    setEmpty(false)
    return mountScene(containerRef.current, geometry, bus, new Set(badFaces), sabreStations)
  }, [bytes, bus, badFaces, sabreStations])

  const stationLabel =
    sabreStations && sabreStations.length > 0
      ? sabreStations.map((station) => `~${Math.round(station.x)}`).join(', ')
      : null

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full touch-none" />
      {stationLabel && !empty && (
        <div className="absolute bottom-3 left-3 z-10 flex items-center gap-2 rounded-md border border-border bg-card/80 px-2.5 py-1 text-xs font-medium backdrop-blur">
          <span
            className="inline-block size-3 rounded-sm border border-red-400"
            style={{ background: 'rgba(255, 43, 43, 0.65)' }}
          />
          <span className="text-red-300">{t('viewer.sabreNc', { stations: stationLabel })}</span>
        </div>
      )}
      {empty && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center text-sm text-muted-foreground">
          {t('viewer.noNc1')}
        </div>
      )}
    </div>
  )
}
