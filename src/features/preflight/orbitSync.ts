import { type Camera, type OrthographicCamera, type PerspectiveCamera, Vector3 } from 'three'
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js'

/** A camera whose framing can be scaled by a zoom factor (perspective and orthographic). */
type ZoomableCamera = (PerspectiveCamera | OrthographicCamera) & Camera

/** Full camera state so two 3D viewports stay locked together (rotate + zoom + pan). */
export interface OrbitState {
  position: [number, number, number]
  target: [number, number, number]
  zoom: number
}

/** Named viewing angles for quick technical comparison. */
export type ViewPreset = 'iso' | 'front' | 'top' | 'side'

/** An arbitrary view direction (from the target toward the camera), one of the 26 cube faces. */
export type ViewDirection = [number, number, number]

/** A point in the scene frame to pull the camera toward (clicking a finding jumps here). */
export type FocusPoint = [number, number, number]

/** A focus target: the point plus its radius, so each viewport can zoom to fill the area. */
export interface FocusRequest {
  point: FocusPoint
  /** Half-size (scene units) of the geometry to frame; 0 = don't zoom. */
  radius: number
  /** Optional view direction (from the point toward the camera); set to rotate onto the geometry. */
  direction?: ViewDirection
}

/** A viewport's fitted frame, used to place preset cameras. */
export interface OrbitFrame {
  centre: [number, number, number]
  distance: number
  /** Half-size (scene units) of the fitted model at zoom 1, for framing focus points. */
  radius?: number
  /** Long axis of the member in scene space (defaults to X, 0). */
  axis?: 0 | 1 | 2
  /** Length of the member along `axis`, so a typed location (mm) can be mapped to a scene point. */
  length?: number
}

export interface OrbitBus {
  orbit: OrbitState | null
  preset: ViewPreset | null
  focus: FocusRequest | null
  location: number | null
  listeners: Set<(orbit: OrbitState) => void>
  presetListeners: Set<(preset: ViewPreset) => void>
  focusListeners: Set<(request: FocusRequest) => void>
  locationListeners: Set<(location: number) => void>
}

export function createOrbitBus(): OrbitBus {
  return {
    orbit: null,
    preset: null,
    focus: null,
    location: null,
    listeners: new Set(),
    presetListeners: new Set(),
    focusListeners: new Set(),
    locationListeners: new Set(),
  }
}

/** Broadcasts a named view angle to every locked viewport (and remembers it for late mounts). */
export function requestView(bus: OrbitBus, preset: ViewPreset): void {
  bus.preset = preset
  for (const listener of bus.presetListeners) listener(preset)
}

/** Broadcasts a focus request: every synced viewport centres on — and zooms to — the point. */
export function requestFocus(bus: OrbitBus, request: FocusRequest): void {
  bus.focus = request
  for (const listener of bus.focusListeners) listener(request)
}

/**
 * Broadcasts a location request: every synced viewport slides along the member so its pivot sits at
 * `location` mm (pan only — the viewing angle and zoom are kept), for "go look at this spot".
 */
export function requestLocation(bus: OrbitBus, location: number): void {
  bus.location = location
  for (const listener of bus.locationListeners) listener(location)
}

const EPSILON = 0.001

/** Unit direction from the target toward the camera for each preset angle. */
const PRESET_DIRECTION: Record<ViewPreset, [number, number, number]> = {
  iso: [1, 1, 1],
  front: [0, 0, 1],
  top: [0, 1, 0],
  side: [1, 0, 0],
}

function near(a: [number, number, number], b: [number, number, number]): boolean {
  return (
    Math.abs(a[0] - b[0]) < EPSILON &&
    Math.abs(a[1] - b[1]) < EPSILON &&
    Math.abs(a[2] - b[2]) < EPSILON
  )
}

/** Keeps a viewport's OrbitControls fully in sync (rotation, zoom and pan) with the bus. */
export function attachOrbit(
  bus: OrbitBus,
  camera: ZoomableCamera,
  controls: OrbitControls,
  frame: OrbitFrame,
): () => void {
  let applying = false
  let animRaf = 0

  const cancelAnimation = (): void => {
    if (animRaf) cancelAnimationFrame(animRaf)
    animRaf = 0
  }

  const apply = (orbit: OrbitState): void => {
    cancelAnimation()
    applying = true
    controls.target.set(orbit.target[0], orbit.target[1], orbit.target[2])
    camera.position.set(orbit.position[0], orbit.position[1], orbit.position[2])
    camera.zoom = orbit.zoom
    camera.updateProjectionMatrix()
    camera.lookAt(controls.target)
    controls.update()
    applying = false
  }

  /** Writes an interpolated orbit straight to the camera (used per animation frame). */
  const writeOrbit = (orbit: OrbitState): void => {
    applying = true
    controls.target.set(orbit.target[0], orbit.target[1], orbit.target[2])
    camera.position.set(orbit.position[0], orbit.position[1], orbit.position[2])
    camera.zoom = orbit.zoom
    camera.updateProjectionMatrix()
    camera.lookAt(controls.target)
    controls.update()
    applying = false
  }

  /**
   * Eases the camera from its current state to `to` so a jump to an issue reads as a smooth glide
   * (pan + zoom), which keeps the operator oriented instead of teleporting. The bus isn't updated
   * until it settles (each synced viewport runs its own animation from the shared start state, so
   * they stay locked together).
   */
  const animateTo = (to: OrbitState, duration: number): void => {
    cancelAnimation()
    const from: OrbitState = {
      position: [camera.position.x, camera.position.y, camera.position.z],
      target: [controls.target.x, controls.target.y, controls.target.z],
      zoom: camera.zoom,
    }
    const start = performance.now()
    const ease = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)
    const step = (now: number): void => {
      const t = Math.min((now - start) / duration, 1)
      const e = ease(t)
      // Zoom is multiplicative, so interpolate it geometrically for an even rate of change.
      const zoom = from.zoom > 0 && to.zoom > 0 ? from.zoom * (to.zoom / from.zoom) ** e : to.zoom
      writeOrbit({
        position: [
          from.position[0] + (to.position[0] - from.position[0]) * e,
          from.position[1] + (to.position[1] - from.position[1]) * e,
          from.position[2] + (to.position[2] - from.position[2]) * e,
        ],
        target: [
          from.target[0] + (to.target[0] - from.target[0]) * e,
          from.target[1] + (to.target[1] - from.target[1]) * e,
          from.target[2] + (to.target[2] - from.target[2]) * e,
        ],
        zoom,
      })
      if (t < 1) {
        animRaf = requestAnimationFrame(step)
        return
      }
      animRaf = 0
      // Publish the settled state (as actually clamped by the pivot guard) so late mounts match.
      bus.orbit = {
        position: [camera.position.x, camera.position.y, camera.position.z],
        target: [controls.target.x, controls.target.y, controls.target.z],
        zoom: camera.zoom,
      }
    }
    animRaf = requestAnimationFrame(step)
  }

  const onChange = (): void => {
    if (applying) return
    const orbit: OrbitState = {
      position: [camera.position.x, camera.position.y, camera.position.z],
      target: [controls.target.x, controls.target.y, controls.target.z],
      zoom: camera.zoom,
    }
    const current = bus.orbit
    if (
      current &&
      near(current.position, orbit.position) &&
      near(current.target, orbit.target) &&
      Math.abs(current.zoom - orbit.zoom) < EPSILON
    ) {
      return
    }
    bus.orbit = orbit
    bus.preset = null
    for (const listener of bus.listeners) if (listener !== apply) listener(orbit)
  }

  const applyDirection = (direction: ViewDirection): void => {
    const [dx, dy, dz] = direction
    const length = Math.hypot(dx, dy, dz) || 1
    const orbit: OrbitState = {
      position: [
        frame.centre[0] + (dx / length) * frame.distance,
        frame.centre[1] + (dy / length) * frame.distance,
        frame.centre[2] + (dz / length) * frame.distance,
      ],
      target: [frame.centre[0], frame.centre[1], frame.centre[2]],
      zoom: 1,
    }
    apply(orbit)
    bus.orbit = orbit
    for (const listener of bus.listeners) if (listener !== apply) listener(orbit)
  }

  const applyPreset = (preset: ViewPreset): void => applyDirection(PRESET_DIRECTION[preset])

  /** Slide along the member so the pivot sits at `location` mm, keeping the angle and zoom. */
  const applyLocation = (mm: number): void => {
    const axis = frame.axis ?? 0
    const length = frame.length
    if (length == null) return
    const delta = mm - length / 2 - controls.target.getComponent(axis)
    if (Math.abs(delta) < EPSILON) return
    const to: OrbitState = {
      position: [camera.position.x, camera.position.y, camera.position.z],
      target: [controls.target.x, controls.target.y, controls.target.z],
      zoom: camera.zoom,
    }
    to.target[axis] += delta
    to.position[axis] += delta
    animateTo(to, 320)
  }

  /** Centre on a scene point and zoom to frame it; rotate onto it when a direction is given. */
  const applyFocus = (request: FocusRequest): void => {
    const { point, radius, direction } = request
    let dir: ViewDirection = [1, 1, 1]
    if (direction) {
      const length = Math.hypot(direction[0], direction[1], direction[2]) || 1
      dir = [direction[0] / length, direction[1] / length, direction[2] / length]
    } else {
      const current = bus.orbit
      if (current) {
        const dx = current.position[0] - current.target[0]
        const dy = current.position[1] - current.target[1]
        const dz = current.position[2] - current.target[2]
        const length = Math.hypot(dx, dy, dz) || 1
        dir = [dx / length, dy / length, dz / length]
      } else {
        const length = Math.hypot(dir[0], dir[1], dir[2])
        dir = [dir[0] / length, dir[1] / length, dir[2] / length]
      }
    }
    const distance = frame.distance * 0.5
    // Ortho framing is the zoom factor; zoom in so the area's radius fills the fitted view.
    const base = frame.radius
    const zoom = base && radius > 0 ? Math.min(Math.max(base / radius, 1), 20) : 1
    animateTo(
      {
        position: [
          point[0] + dir[0] * distance,
          point[1] + dir[1] * distance,
          point[2] + dir[2] * distance,
        ],
        target: point,
        zoom,
      },
      450,
    )
  }

  controls.enableDamping = false
  controls.addEventListener('change', onChange)
  // Grabbing the view mid-glide hands control straight back to the user.
  controls.addEventListener('start', cancelAnimation)
  bus.listeners.add(apply)
  bus.presetListeners.add(applyPreset)
  bus.focusListeners.add(applyFocus)
  bus.locationListeners.add(applyLocation)
  if (bus.focus) applyFocus(bus.focus)
  else if (bus.orbit) apply(bus.orbit)
  else if (bus.preset) applyPreset(bus.preset)

  return () => {
    cancelAnimation()
    controls.removeEventListener('change', onChange)
    controls.removeEventListener('start', cancelAnimation)
    bus.listeners.delete(apply)
    bus.presetListeners.delete(applyPreset)
    bus.focusListeners.delete(applyFocus)
    bus.locationListeners.delete(applyLocation)
  }
}

/** The grabbed viewport's visible height in scene units, so a wheel notch pans a fixed fraction. */
function visibleHeight(camera: ZoomableCamera, controls: OrbitControls): number {
  if ((camera as OrthographicCamera).isOrthographicCamera) {
    const ortho = camera as OrthographicCamera
    return Math.abs(ortho.top - ortho.bottom) / ortho.zoom
  }
  const perspective = camera as PerspectiveCamera
  const distance = perspective.position.distanceTo(controls.target)
  return 2 * Math.tan((perspective.fov * Math.PI) / 360) * distance
}

/**
 * Shift + wheel slides the view along one scene axis (the beam's length) instead of zooming, so a
 * long stock/part can be run past the camera without leaving the pointer parked on it. The plain
 * wheel keeps zooming. The listener is captured on the canvas's parent so it fires before
 * OrbitControls' own (bubbling) wheel handler and can suppress that tick's zoom.
 */
export function attachWheelPan(
  container: HTMLElement,
  controls: OrbitControls,
  camera: ZoomableCamera,
  axis: 0 | 1 | 2,
): () => void {
  const delta = new Vector3()
  const onWheel = (event: WheelEvent): void => {
    if (!event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return
    event.preventDefault()
    event.stopImmediatePropagation()
    // Some browsers report shift+wheel as a horizontal scroll (deltaX), so take the dominant axis.
    const amount = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX
    const step = visibleHeight(camera, controls) * 0.15 * Math.sign(amount || 1)
    delta.set(0, 0, 0)
    delta.setComponent(axis, step)
    controls.target.add(delta)
    camera.position.add(delta)
    controls.update()
  }
  container.addEventListener('wheel', onWheel, { passive: false, capture: true })
  return () => container.removeEventListener('wheel', onWheel, { capture: true })
}
