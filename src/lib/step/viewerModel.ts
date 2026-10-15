import type { MeshedStep } from './mesh'
import type { DiffPayload } from './occDiff'
import { relativeSeat } from './seat'
import { getStepWorkerPool, PRIORITY_FOREGROUND } from './stepPool'

/**
 * Viewer models built on the shared OCC worker pool, memoised by input.
 *
 * The pool workers are already warm from preflight (their ~23 MB kernel is loaded), so routing the
 * viewer's meshing and NC reconstruction through them avoids both a second main-thread WASM load
 * and a re-run every time a dependency (stock outline, view mode, re-opening the part) changes.
 */

const meshCache = new WeakMap<Uint8Array, Promise<MeshedStep>>()

/** Tessellate a STEP for the viewer, reusing the result while the same bytes object is in play. */
export function meshForViewer(
  name: string,
  bytes: Uint8Array,
  options: { priority?: number } = {},
): Promise<MeshedStep> {
  const hit = meshCache.get(bytes)
  if (hit) return hit
  const promise = getStepWorkerPool()
    // On-demand: the user is looking at this right now, so jump ahead of background analysis.
    .mesh(name, bytes, { priority: options.priority ?? PRIORITY_FOREGROUND })
    .catch((error) => {
      meshCache.delete(bytes)
      throw error
    })
  meshCache.set(bytes, promise)
  return promise
}

const reconstructCache = new Map<string, Promise<Uint8Array | null>>()
/**
 * Cap on cached reconstructions: each holds a full STEP text (~0.2–2 MB), so
 * an unbounded map OOMs the tab on 350-part jobs. Evicted parts rebuild on
 * reopen (~seconds, cached meshes stay). Map preserves insertion order, so the
 * first key is the stalest — refresh it on hit to approximate LRU.
 */
const RECONSTRUCT_CACHE_LIMIT = 32

/**
 * Rebuild a part's STEP from its NC for the viewer, in the NC's own canonical frame (independent of
 * the part's STEP file), reusing the result for repeated opens / view-mode switches of the same NC.
 * `priority` defaults to foreground (the user is looking at it now); neighbours prefetch at a lower
 * one so they never delay the open part.
 */
export function reconstructForViewer(
  ncText: string,
  options: { simplify?: boolean; priority?: number } = {},
): Promise<Uint8Array | null> {
  const key = `${options.simplify ? 1 : 0}:${ncText}`
  const hit = reconstructCache.get(key)
  if (hit) {
    reconstructCache.delete(key)
    reconstructCache.set(key, hit)
    return hit
  }
  const promise = getStepWorkerPool()
    // On-demand: the user is looking at this right now, so jump ahead of background analysis.
    .reconstruct(ncText, {
      simplify: options.simplify,
      priority: options.priority ?? PRIORITY_FOREGROUND,
    })
    .then((result) => (result.step ? new TextEncoder().encode(result.step) : null))
    .catch((error) => {
      reconstructCache.delete(key)
      throw error
    })
  reconstructCache.set(key, promise)
  const oldest = reconstructCache.keys().next()
  if (!oldest.done && reconstructCache.size > RECONSTRUCT_CACHE_LIMIT) {
    reconstructCache.delete(oldest.value)
  }
  return promise
}

/** Drop reconstruction results for a superseded job (the mesh cache is keyed weakly, so it self-clears). */
export function clearViewerModels(): void {
  reconstructCache.clear()
}

/**
 * The overlay diff (manufactured vs ideal) computed in the OCC worker, memoised on the two byte
 * objects and the section profile. The viewer has already seated both models in the section's
 * canonical frame, so the diff is given the *same* seating (via `relativeSeat`) rather than
 * reorienting the STEP itself. Keyed weakly so it self-clears with the job. Prewarming it here means
 * the overlay pane draws from cache.
 */
type Profile = [number, number][]

const diffCache = new WeakMap<
  Uint8Array,
  WeakMap<Uint8Array, Map<string, Promise<DiffPayload | null>>>
>()

function profileKey(profile: Profile | undefined): string {
  if (!profile || profile.length < 3) return ''
  let key = ''
  for (const [x, y] of profile) key += `${x},${y};`
  return key
}

export function diffForViewer(
  primary: Uint8Array,
  compare: Uint8Array,
  options: { profile?: Profile | null; priority?: number } = {},
): Promise<DiffPayload | null> {
  const profile = options.profile && options.profile.length >= 3 ? options.profile : undefined
  const key = profileKey(profile)
  let inner = diffCache.get(primary)
  if (!inner) {
    inner = new WeakMap()
    diffCache.set(primary, inner)
  }
  let byProfile = inner.get(compare)
  if (!byProfile) {
    byProfile = new Map()
    inner.set(compare, byProfile)
  }
  const hit = byProfile.get(key)
  if (hit) return hit
  const priority = options.priority ?? PRIORITY_FOREGROUND
  const promise = buildDiff(primary, compare, profile, priority).catch((error) => {
    byProfile?.delete(key)
    throw error
  })
  byProfile.set(key, promise)
  return promise
}

/**
 * Mesh both models (cached) and hand the worker the transform that maps the STEP's raw frame onto
 * the manufactured model's raw frame, so the boolean runs once the two already share the view's
 * orientation. Without a profile there is no seating to apply and the boolean runs as-is.
 */
async function buildDiff(
  primary: Uint8Array,
  compare: Uint8Array,
  profile: Profile | undefined,
  priority: number,
): Promise<DiffPayload | null> {
  if (!profile) return getStepWorkerPool().diff(primary, compare, { priority })
  const [manufactured, step] = await Promise.all([
    meshForViewer('overlay · manufactured', primary, { priority }),
    meshForViewer('overlay · step', compare, { priority }),
  ])
  const compareMatrix = relativeSeat(manufactured.vertices, step.vertices, profile)
  return getStepWorkerPool().diff(primary, compare, { compareMatrix, priority })
}
