import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from 'react'
import {
  type OrbitBus,
  type OrbitState,
  requestDirection,
  requestOrbit,
  type ViewDirection,
} from './orbitSync'

/** Half-extent of the cube in gizmo units. */
const SIZE = 1
/** Face inset for the grid lines; the pick regions use the same value so lines and clicks line up. */
const REGION = 0.66
/** Projection scale (gizmo units → SVG units) and half the viewBox. */
const SCALE = 48
const VIEW = 100
/** Orbit radians per pointer pixel while dragging the cube. */
const ROTATE_PER_PIXEL = 0.012
/** Pointer travel (px) past which a press is a drag rather than a view pick. */
const DRAG_SLOP = 4
/** Ray start distance along the view axis, well outside the cube. */
const RAY_START = 10

type V3 = [number, number, number]

interface Basis {
  x: V3
  y: V3
  z: V3
}

interface FaceDef {
  axis: number
  sign: number
  normal: V3
}

const FACES: FaceDef[] = []
for (let axis = 0; axis < 3; axis++) {
  for (const sign of [-1, 1]) {
    const normal: V3 = [0, 0, 0]
    normal[axis] = sign
    FACES.push({ axis, sign, normal })
  }
}

function dot(a: V3, b: V3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

function cross(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

function normalize(v: V3): V3 {
  const length = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / length, v[1] / length, v[2] / length]
}

/** Orthographic camera basis for a view direction (target → camera). */
function basisFor(dir: V3): Basis {
  const z = normalize(dir)
  const up: V3 = Math.abs(z[1]) > 0.999 ? [0, 0, 1] : [0, 1, 0]
  const x = normalize(cross(up, z))
  const y = cross(z, x)
  return { x, y, z }
}

/** A point on a face, `u`/`v` being its two in-plane axes. */
function facePoint(face: FaceDef, u: number, v: number): V3 {
  const ux = (face.axis + 1) % 3
  const vx = (face.axis + 2) % 3
  const p: V3 = [0, 0, 0]
  p[face.axis] = face.sign
  p[ux] = u
  p[vx] = v
  return p
}

function projectToSvg(p: V3, basis: Basis): [number, number] {
  return [dot(p, basis.x) * SCALE, -dot(p, basis.y) * SCALE]
}

function polygon(points: [number, number][]): string {
  return points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
}

/** Maps a point on the cube surface to one of the 26 view directions. */
function regionAt(point: V3): ViewDirection {
  const dir: ViewDirection = [0, 0, 0]
  for (let i = 0; i < 3; i++) {
    const c = point[i] / SIZE
    if (c > REGION) dir[i] = 1
    else if (c < -REGION) dir[i] = -1
  }
  if (dir[0] === 0 && dir[1] === 0 && dir[2] === 0) {
    const axis = maxAbsAxis(point)
    dir[axis] = point[axis] >= 0 ? 1 : -1
  }
  return dir
}

function maxAbsAxis(point: V3): number {
  let axis = 0
  if (Math.abs(point[1]) > Math.abs(point[axis])) axis = 1
  if (Math.abs(point[2]) > Math.abs(point[axis])) axis = 2
  return axis
}

/** Entry point of a ray into the [-SIZE, SIZE] cube, or null when it misses. */
function rayBox(origin: V3, dir: V3): V3 | null {
  let tMin = Number.NEGATIVE_INFINITY
  let tMax = Number.POSITIVE_INFINITY
  for (let i = 0; i < 3; i++) {
    if (Math.abs(dir[i]) < 1e-9) {
      if (Math.abs(origin[i]) > SIZE) return null
    } else {
      let t1 = (-SIZE - origin[i]) / dir[i]
      let t2 = (SIZE - origin[i]) / dir[i]
      if (t1 > t2) {
        const swap = t1
        t1 = t2
        t2 = swap
      }
      tMin = Math.max(tMin, t1)
      tMax = Math.min(tMax, t2)
      if (tMin > tMax) return null
    }
  }
  return [origin[0] + dir[0] * tMin, origin[1] + dir[1] * tMin, origin[2] + dir[2] * tMin]
}

/**
 * The CAD-style navigation cube. An SVG gizmo (no WebGL) shows an oriented, flat-shaded cube with
 * line-defined faces that mirrors the shared orbit bus: click a face/edge/corner to snap every
 * synced viewport to that direction, or drag the cube to orbit the viewports around their target.
 */
export function ViewCube({ bus, className }: { bus: OrbitBus; className?: string }) {
  const svgRef = useRef<SVGSVGElement>(null)
  const orbitRef = useRef<OrbitState | null>(null)
  const drag = useRef({ down: false, dragged: false, startX: 0, startY: 0, lastX: 0, lastY: 0 })
  const [orient, setOrient] = useState<V3>([1, 1, 1])
  const [hover, setHover] = useState<V3 | null>(null)

  useEffect(() => {
    const update = (orbit: OrbitState): void => {
      orbitRef.current = orbit
      setOrient(
        normalize([
          orbit.position[0] - orbit.target[0],
          orbit.position[1] - orbit.target[1],
          orbit.position[2] - orbit.target[2],
        ]),
      )
    }
    bus.listeners.add(update)
    if (bus.orbit) update(bus.orbit)
    return () => {
      bus.listeners.delete(update)
    }
  }, [bus])

  const basis = basisFor(orient)
  const visible = FACES.filter((face) => dot(face.normal, basis.z) > 0)

  const pickAt = (clientX: number, clientY: number): V3 | null => {
    const svg = svgRef.current
    if (!svg) return null
    const rect = svg.getBoundingClientRect()
    const gx = (((clientX - rect.left) / rect.width) * 2 - 1) * VIEW
    const gy = -(((clientY - rect.top) / rect.height) * 2 - 1) * VIEW
    const origin: V3 = [
      basis.x[0] * (gx / SCALE) + basis.y[0] * (gy / SCALE) + basis.z[0] * RAY_START,
      basis.x[1] * (gx / SCALE) + basis.y[1] * (gy / SCALE) + basis.z[1] * RAY_START,
      basis.x[2] * (gx / SCALE) + basis.y[2] * (gy / SCALE) + basis.z[2] * RAY_START,
    ]
    const dir: V3 = [-basis.z[0], -basis.z[1], -basis.z[2]]
    return rayBox(origin, dir)
  }

  const orbitBy = (dx: number, dy: number): void => {
    const orbit = orbitRef.current
    if (!orbit) return
    const [px, py, pz] = orbit.position
    const [tx, ty, tz] = orbit.target
    const ox = px - tx
    const oy = py - ty
    const oz = pz - tz
    const radius = Math.hypot(ox, oy, oz) || 1
    const theta = Math.atan2(ox, oz) - dx * ROTATE_PER_PIXEL
    const phi = Math.min(
      Math.max(Math.acos(Math.min(Math.max(oy / radius, -1), 1)) - dy * ROTATE_PER_PIXEL, 0.08),
      Math.PI - 0.08,
    )
    const sinPhi = Math.sin(phi)
    const nx = tx + radius * sinPhi * Math.sin(theta)
    const ny = ty + radius * Math.cos(phi)
    const nz = tz + radius * sinPhi * Math.cos(theta)
    requestOrbit(bus, { position: [nx, ny, nz], target: [tx, ty, tz], zoom: orbit.zoom })
  }

  const onPointerDown = (event: ReactPointerEvent): void => {
    drag.current = {
      down: true,
      dragged: false,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
    }
    svgRef.current?.setPointerCapture(event.pointerId)
  }

  const onPointerMove = (event: ReactPointerEvent): void => {
    const state = drag.current
    if (state.down) {
      if (
        !state.dragged &&
        Math.hypot(event.clientX - state.startX, event.clientY - state.startY) > DRAG_SLOP
      ) {
        state.dragged = true
        setHover(null)
      }
      if (state.dragged) orbitBy(event.clientX - state.lastX, event.clientY - state.lastY)
      state.lastX = event.clientX
      state.lastY = event.clientY
      return
    }
    setHover(pickAt(event.clientX, event.clientY))
  }

  const onPointerUp = (event: ReactPointerEvent): void => {
    const state = drag.current
    if (state.down && !state.dragged) {
      const point = pickAt(event.clientX, event.clientY)
      if (point) requestDirection(bus, regionAt(point))
    }
    state.down = false
    state.dragged = false
    if (svgRef.current?.hasPointerCapture(event.pointerId)) {
      svgRef.current.releasePointerCapture(event.pointerId)
    }
  }

  const onPointerLeave = (): void => {
    if (!drag.current.down) setHover(null)
  }

  let hoverPoints: string | null = null
  if (hover) {
    const axis = maxAbsAxis(hover)
    const face: FaceDef = { axis, sign: hover[axis] >= 0 ? 1 : -1, normal: [0, 0, 0] }
    const ux = (axis + 1) % 3
    const vx = (axis + 2) % 3
    const band = (value: number): [number, number] => {
      if (value > REGION) return [REGION, 1]
      if (value < -REGION) return [-1, -REGION]
      return [-REGION, REGION]
    }
    const [u0, u1] = band(hover[ux])
    const [v0, v1] = band(hover[vx])
    hoverPoints = polygon(
      (
        [
          [u0, v0],
          [u1, v0],
          [u1, v1],
          [u0, v1],
        ] as [number, number][]
      ).map(([u, v]) => projectToSvg(facePoint(face, u, v), basis)),
    )
  }

  return (
    <svg
      ref={svgRef}
      viewBox={`${-VIEW} ${-VIEW} ${VIEW * 2} ${VIEW * 2}`}
      className={className}
      style={{ touchAction: 'none' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={onPointerLeave}
    >
      <title>View orientation</title>
      <g stroke="#1f2937" strokeWidth={1.5} strokeLinejoin="round">
        {visible.map((face) => (
          <polygon
            key={`${face.axis}:${face.sign}`}
            points={polygon(
              (
                [
                  [-1, -1],
                  [1, -1],
                  [1, 1],
                  [-1, 1],
                ] as [number, number][]
              ).map(([u, v]) => projectToSvg(facePoint(face, u, v), basis)),
            )}
            fill="#cbd5e1"
          />
        ))}
      </g>
      <g stroke="#1f2937" strokeWidth={1}>
        {visible.flatMap((face) =>
          [-REGION, REGION].flatMap((k) => {
            const a = projectToSvg(facePoint(face, k, -1), basis)
            const b = projectToSvg(facePoint(face, k, 1), basis)
            const c = projectToSvg(facePoint(face, -1, k), basis)
            const d = projectToSvg(facePoint(face, 1, k), basis)
            return [
              <line
                key={`${face.axis}:${face.sign}:u${k}`}
                x1={a[0]}
                y1={a[1]}
                x2={b[0]}
                y2={b[1]}
              />,
              <line
                key={`${face.axis}:${face.sign}:v${k}`}
                x1={c[0]}
                y1={c[1]}
                x2={d[0]}
                y2={d[1]}
              />,
            ]
          }),
        )}
      </g>
      {hoverPoints && <polygon points={hoverPoints} fill="#38bdf8" fillOpacity={0.4} />}
    </svg>
  )
}
