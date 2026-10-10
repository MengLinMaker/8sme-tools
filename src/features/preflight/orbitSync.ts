import type { Camera, OrthographicCamera, PerspectiveCamera } from 'three'
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

/** A viewport's fitted frame, used to place preset cameras. */
export interface OrbitFrame {
  centre: [number, number, number]
  distance: number
}

export interface OrbitBus {
  orbit: OrbitState | null
  preset: ViewPreset | null
  listeners: Set<(orbit: OrbitState) => void>
  presetListeners: Set<(preset: ViewPreset) => void>
}

export function createOrbitBus(): OrbitBus {
  return { orbit: null, preset: null, listeners: new Set(), presetListeners: new Set() }
}

/** Broadcasts a named view angle to every locked viewport (and remembers it for late mounts). */
export function requestView(bus: OrbitBus, preset: ViewPreset): void {
  bus.preset = preset
  for (const listener of bus.presetListeners) listener(preset)
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

  const apply = (orbit: OrbitState): void => {
    applying = true
    controls.target.set(orbit.target[0], orbit.target[1], orbit.target[2])
    camera.position.set(orbit.position[0], orbit.position[1], orbit.position[2])
    camera.zoom = orbit.zoom
    camera.updateProjectionMatrix()
    camera.lookAt(controls.target)
    controls.update()
    applying = false
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

  const applyPreset = (preset: ViewPreset): void => {
    const [dx, dy, dz] = PRESET_DIRECTION[preset]
    const length = Math.hypot(dx, dy, dz)
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

  controls.enableDamping = false
  controls.addEventListener('change', onChange)
  bus.listeners.add(apply)
  bus.presetListeners.add(applyPreset)
  if (bus.orbit) apply(bus.orbit)
  else if (bus.preset) applyPreset(bus.preset)

  return () => {
    controls.removeEventListener('change', onChange)
    bus.listeners.delete(apply)
    bus.presetListeners.delete(applyPreset)
  }
}
