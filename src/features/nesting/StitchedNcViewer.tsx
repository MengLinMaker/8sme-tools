import { useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Box3,
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineSegments,
  OrthographicCamera,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { type NcPoint, segmentsFor } from '@/features/preflight/Nc3dViewer'
import { attachOrbit, type OrbitBus } from '@/features/preflight/orbitSync'
import type { NcGeometry } from '@/lib/parsers/ncGeometry'

/** One nested piece's real NC geometry at its position along the beam. */
export interface StitchedNcItem {
  mark: string
  side: 'L' | 'R'
  /** Distance from the beam start to this piece's NC origin. */
  start: number
  /** Nominal nest slot length for this piece (drives the length reconciliation). */
  slotLength: number
  /** The NC's own ST-header declared length, if it parsed (the middle of three lengths). */
  headerLength: number | null
  geometry: NcGeometry
}

// Same palette as the preflight NC view: green outer, amber inner, sky holes.
const OUTER_COLOR = 0x3ddc84
const INNER_COLOR = 0xf59e0b
const HOLES_COLOR = 0x38bdf8

/** Member length of one part's NC (X extent), mirroring Nc3dViewer's internal measure. */
export function memberLength(geometry: NcGeometry): number {
  let length = 0
  for (const contour of geometry.contours) {
    for (const [x] of contour.points) length = Math.max(length, x)
  }
  for (const hole of geometry.holes) length = Math.max(length, hole.x + hole.diameter / 2)
  return length
}

/** Widest face extent of one part's NC, mirroring Nc3dViewer's internal measure. */
function faceWidth(geometry: NcGeometry): number {
  let width = 1
  for (const contour of geometry.contours) {
    for (const [, y] of contour.points) width = Math.max(width, y)
  }
  for (const hole of geometry.holes) width = Math.max(width, hole.y + hole.diameter / 2)
  return width
}

function toGeometry(points: NcPoint[]): BufferGeometry {
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(points.flat(), 3))
  return geometry
}

/**
 * The nested NC stitched together: every piece's real NC contours/holes, shifted to its nested
 * slot along the beam, left-half pieces raised and right-half pieces lowered so the two T bars
 * read as separate rows. Same line language as the preflight NC view.
 */
function mountScene(
  container: HTMLElement,
  items: StitchedNcItem[],
  stockLength: number,
  bus: OrbitBus,
): () => void {
  const renderer = new WebGLRenderer({ antialias: true, alpha: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setSize(container.clientWidth || 1, container.clientHeight || 1)
  container.appendChild(renderer.domElement)

  const scene = new Scene()
  const group = new Group()

  const lane = Math.max(1, ...items.map((item) => faceWidth(item.geometry))) / 2 + 12
  const outer: NcPoint[] = []
  const inner: NcPoint[] = []
  const holes: NcPoint[] = []
  for (const item of items) {
    const built = segmentsFor(item.geometry)
    // segmentsFor centres each part on its own origin: re-anchor to the beam, centred overall.
    // The bottom (R) row gets the same 180° roll about the length axis the STEP nest applies
    // (placeRealPart's flip), so stitch and STEP place pieces identically — the projection is
    // roughly section-centred, so negating both cross axes is that roll. Any mismatch left is
    // in the NC itself, not the layout.
    const dx = item.start + memberLength(item.geometry) / 2 - stockLength / 2
    const dy = item.side === 'L' ? lane : -lane
    const flip = item.side === 'R'
    const shift = (points: NcPoint[], target: NcPoint[]): void => {
      for (const [x, y, z] of points) {
        target.push(flip ? [x + dx, -y + dy, -z] : [x + dx, y + dy, z])
      }
    }
    for (const points of built.outerByFace.values()) shift(points, outer)
    shift(built.inner, inner)
    shift(built.holes, holes)
  }

  const lines: LineSegments[] = []
  const materials: LineBasicMaterial[] = []
  const add = (points: NcPoint[], color: number): void => {
    if (points.length === 0) return
    const material = new LineBasicMaterial({ color })
    materials.push(material)
    const line = new LineSegments(toGeometry(points), material)
    lines.push(line)
    group.add(line)
  }
  add(outer, OUTER_COLOR)
  add(inner, INNER_COLOR)
  add(holes, HOLES_COLOR)
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
  const distance = maxDim * 2
  camera.position.set(distance, distance, distance).multiplyScalar(1 / Math.sqrt(3))
  camera.lookAt(0, 0, 0)

  const controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  controls.dampingFactor = 0.08
  controls.zoomToCursor = true
  controls.target.set(0, 0, 0)
  const detachOrbit = attachOrbit(bus, camera, controls, { centre: [0, 0, 0], distance })

  let raf = 0
  const render = (): void => {
    controls.update()
    renderer.render(scene, camera)
    raf = requestAnimationFrame(render)
  }
  render()

  const resize = (): void => {
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
    for (const material of materials) material.dispose()
    renderer.dispose()
    renderer.domElement.remove()
  }
}

export function StitchedNcViewer({
  items,
  stockLength,
  bus,
}: {
  items: StitchedNcItem[]
  stockLength: number
  bus: OrbitBus
}) {
  const { t } = useTranslation()
  const containerRef = useRef<HTMLDivElement>(null)
  const hasContent = useMemo(
    () => items.some((item) => item.geometry.contours.length > 0 || item.geometry.holes.length > 0),
    [items],
  )

  useEffect(() => {
    if (!containerRef.current || !hasContent) return
    return mountScene(containerRef.current, items, stockLength, bus)
  }, [items, stockLength, bus, hasContent])

  return (
    <div className="relative h-full w-full bg-[#0b0f14]">
      <div ref={containerRef} className="h-full w-full touch-none" />
      {hasContent && (
        <div className="absolute bottom-3 left-3 z-10 flex flex-wrap items-center gap-2 rounded-md border border-border bg-card/80 px-2.5 py-1 text-xs font-medium backdrop-blur">
          <span className="flex items-center gap-1.5">
            <span
              className="inline-block size-3 rounded-sm border border-emerald-400"
              style={{ background: 'rgba(61, 220, 132, 0.5)' }}
            />
            {t('nesting.viewer.ncLegendOuter')}
          </span>
          <span className="flex items-center gap-1.5">
            <span
              className="inline-block size-3 rounded-sm border border-amber-400"
              style={{ background: 'rgba(245, 158, 11, 0.5)' }}
            />
            {t('nesting.viewer.ncLegendInner')}
          </span>
          <span className="flex items-center gap-1.5">
            <span
              className="inline-block size-3 rounded-sm border border-sky-400"
              style={{ background: 'rgba(56, 189, 248, 0.5)' }}
            />
            {t('nesting.viewer.ncLegendHoles')}
          </span>
        </div>
      )}
      {!hasContent && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center px-6 text-center text-sm text-muted-foreground">
          {t('nesting.viewer.ncStitchEmpty')}
        </div>
      )}
    </div>
  )
}
