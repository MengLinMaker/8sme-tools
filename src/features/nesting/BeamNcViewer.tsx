import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Box3,
  BufferGeometry,
  Float32BufferAttribute,
  LineBasicMaterial,
  LineSegments,
  OrthographicCamera,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { attachOrbit, type OrbitBus } from '@/features/preflight/orbitSync'

/** One nested piece span along the beam, per side. */
export interface BeamSlot {
  side: 'L' | 'R'
  mark: string
  start: number
  end: number
}

const STOCK_COLOR = 0x3ddc84
const SPLIT_COLOR = 0xef4444
const LEFT_COLOR = 0x38bdf8
const RIGHT_COLOR = 0xf59e0b

type V3 = [number, number, number]

function toGeometry(pairs: V3[]): BufferGeometry {
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(pairs.flat(), 3))
  return geometry
}

/**
 * Line visualisation of the generated beam NC: the stock UB as a wireframe prism (X along the
 * beam, Y/Z the section), the lengthwise split slot on the web neutral axis, and one transverse
 * cut rectangle per part boundary on the half it belongs to (left = top, right = bottom).
 *
 * True millimetre scale, no solids — like the preflight NC line view, everything stays visible
 * from any angle. Shares the page orbit bus so it rotates with the STEP panes.
 */
function mountScene(
  container: HTMLElement,
  profile: [number, number][],
  stockLength: number,
  slots: BeamSlot[],
  kerf: number,
  bus: OrbitBus,
): () => void {
  const renderer = new WebGLRenderer({ antialias: true, alpha: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setSize(container.clientWidth || 1, container.clientHeight || 1)
  container.appendChild(renderer.domElement)

  const scene = new Scene()
  const atX = (z: number): number => z - stockLength / 2
  let hb = 1
  let hd = 1
  for (const [px, py] of profile) {
    hb = Math.max(hb, Math.abs(px))
    hd = Math.max(hd, Math.abs(py))
  }

  // Stock wireframe: section loop at both ends + longitudinal edges.
  const stock: V3[] = []
  const x0 = atX(0)
  const x1 = atX(stockLength)
  for (let i = 0; i < profile.length; i++) {
    const a = profile[i]
    const b = profile[(i + 1) % profile.length]
    stock.push([x0, a[0], a[1]], [x0, b[0], b[1]], [x1, a[0], a[1]], [x1, b[0], b[1]])
  }
  for (const [px, py] of profile) stock.push([x0, px, py], [x1, px, py])

  // Lengthwise split: centre line over the split extent + a width tick at its end.
  const lastEnd = Math.max(0, ...slots.map((slot) => slot.end))
  const splitEnd = Math.min(stockLength, lastEnd + Math.max(0, kerf))
  const split: V3[] = []
  if (splitEnd > 0) {
    split.push([x0, 0, 0], [atX(splitEnd), 0, 0])
    split.push([atX(splitEnd), -hb, 0], [atX(splitEnd), hb, 0])
  }

  // Transverse cuts: half-section rectangle at each part boundary (all but the last span).
  const cuts = (side: 'L' | 'R'): V3[] => {
    const list = slots.filter((slot) => slot.side === side)
    const pairs: V3[] = []
    list.forEach((slot, index) => {
      if (index >= list.length - 1) return
      const x = atX(slot.end)
      const z0 = side === 'L' ? 0 : -hd
      const z1 = side === 'L' ? hd : 0
      const corners: V3[] = [
        [x, -hb, z0],
        [x, hb, z0],
        [x, hb, z1],
        [x, -hb, z1],
      ]
      for (let i = 0; i < corners.length; i++) {
        pairs.push(corners[i], corners[(i + 1) % corners.length])
      }
    })
    return pairs
  }

  const lines: LineSegments[] = []
  const materials: LineBasicMaterial[] = []
  const add = (pairs: V3[], color: number, opacity: number): void => {
    if (pairs.length === 0) return
    const material = new LineBasicMaterial({ color, transparent: true, opacity })
    materials.push(material)
    const line = new LineSegments(toGeometry(pairs), material)
    lines.push(line)
    scene.add(line)
  }
  add(stock, STOCK_COLOR, 0.45)
  add(split, SPLIT_COLOR, 0.95)
  add(cuts('L'), LEFT_COLOR, 0.9)
  add(cuts('R'), RIGHT_COLOR, 0.9)

  const bounds = new Box3()
  for (const line of lines) bounds.expandByObject(line)
  const size = bounds.getSize(new Vector3())
  const centre = bounds.getCenter(new Vector3())
  const maxDim = Math.max(size.x, size.y, size.z) || 1

  const aspect = (container.clientWidth || 1) / (container.clientHeight || 1)
  const frustumHeight = maxDim * 1.15
  const halfHeight = frustumHeight / 2
  const camera = new OrthographicCamera(
    -halfHeight * aspect,
    halfHeight * aspect,
    halfHeight,
    -halfHeight,
    Math.max(maxDim / 1000, 0.01),
    maxDim * 100,
  )
  const distance = maxDim * 2
  camera.position.set(distance, distance, distance).multiplyScalar(1 / Math.sqrt(3))
  camera.position.add(centre)
  camera.lookAt(centre)

  const controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  controls.dampingFactor = 0.08
  controls.zoomToCursor = true
  controls.target.copy(centre)

  // Keep the orbit pivot on the beam's longitudinal centre line: pan may slide along the beam
  // and cursor-zoom may try to move the target, but the pivot can never leave the line, so the
  // beam's centre line always passes through the middle of the viewport.
  const axisLimit = stockLength / 2
  const axisY = centre.y
  const axisZ = centre.z
  const confinePivot = (): void => {
    const x = Math.max(-axisLimit, Math.min(axisLimit, controls.target.x))
    const dx = x - controls.target.x
    const dy = axisY - controls.target.y
    const dz = axisZ - controls.target.z
    if (dx === 0 && dy === 0 && dz === 0) return
    controls.target.set(x, axisY, axisZ)
    camera.position.x += dx
    camera.position.y += dy
    camera.position.z += dz
  }
  controls.addEventListener('change', confinePivot)

  const detachOrbit = attachOrbit(bus, camera, controls, {
    centre: [centre.x, centre.y, centre.z],
    distance,
  })

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
    controls.removeEventListener('change', confinePivot)
    controls.dispose()
    for (const line of lines) line.geometry.dispose()
    for (const material of materials) material.dispose()
    renderer.dispose()
    renderer.domElement.remove()
  }
}

export function BeamNcViewer({
  profile,
  stockLength,
  slots,
  kerf,
  bus,
}: {
  profile: [number, number][]
  stockLength: number
  slots: BeamSlot[]
  kerf: number
  bus: OrbitBus
}) {
  const { t } = useTranslation()
  const containerRef = useRef<HTMLDivElement>(null)
  const empty = profile.length < 3 || !(stockLength > 0)

  useEffect(() => {
    if (!containerRef.current || empty) return
    return mountScene(containerRef.current, profile, stockLength, slots, kerf, bus)
  }, [profile, stockLength, slots, kerf, bus, empty])

  return (
    <div className="relative h-full w-full bg-[#0b0f14]">
      <div ref={containerRef} className="h-full w-full touch-none" />
      {!empty && (
        <div className="absolute bottom-3 left-3 z-10 flex flex-wrap items-center gap-2 rounded-md border border-border bg-card/80 px-2.5 py-1 text-xs font-medium backdrop-blur">
          <span className="flex items-center gap-1.5">
            <span
              className="inline-block size-3 rounded-sm border border-emerald-400"
              style={{ background: 'rgba(61, 220, 132, 0.5)' }}
            />
            {t('nesting.viewer.ncLegendStock')}
          </span>
          <span className="flex items-center gap-1.5">
            <span
              className="inline-block size-3 rounded-sm border border-red-400"
              style={{ background: 'rgba(239, 68, 68, 0.65)' }}
            />
            {t('nesting.viewer.ncLegendSplit')}
          </span>
          <span className="flex items-center gap-1.5">
            <span
              className="inline-block size-3 rounded-sm border border-sky-400"
              style={{ background: 'rgba(56, 189, 248, 0.65)' }}
            />
            {t('nesting.viewer.ncLegendLeft')}
          </span>
          <span className="flex items-center gap-1.5">
            <span
              className="inline-block size-3 rounded-sm border border-amber-400"
              style={{ background: 'rgba(245, 158, 11, 0.65)' }}
            />
            {t('nesting.viewer.ncLegendRight')}
          </span>
        </div>
      )}
      {empty && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center text-sm text-muted-foreground">
          {t('nesting.viewer.ncEmpty')}
        </div>
      )}
    </div>
  )
}
