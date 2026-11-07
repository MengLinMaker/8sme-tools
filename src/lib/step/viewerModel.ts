import type { MeshedStep } from './mesh'
import type { DiffPayload } from './occDiff'
import type { SabreFailure } from './sabre'
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
/** Resolved meshes, so a cache hit can mount a scene synchronously (no "loading" flash). */
const resolvedMeshCache = new WeakMap<Uint8Array, MeshedStep>()

/** Synchronous peek at an already-tessellated STEP, or null while it is still meshing. */
export function peekMeshForViewer(bytes: Uint8Array): MeshedStep | null {
  return resolvedMeshCache.get(bytes) ?? null
}

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
    .then((meshed) => {
      resolvedMeshCache.set(bytes, meshed)
      return meshed
    })
    .catch((error) => {
      meshCache.delete(bytes)
      resolvedMeshCache.delete(bytes)
      throw error
    })
  meshCache.set(bytes, promise)
  return promise
}

interface ViewerReconstruct {
  bytes: Uint8Array | null
  sabre: SabreFailure[]
}

const reconstructCache = new Map<string, Promise<ViewerReconstruct>>()
/** Resolved manufactured bytes, so a cache hit paints immediately (no "building" flash). */
const resolvedCache = new Map<string, Uint8Array | null>()
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
function reconstructDetailed(
  ncText: string,
  options: {
    simplify?: boolean
    priority?: number
    measureOnly?: boolean
    sabre?: boolean
  } = {},
): Promise<ViewerReconstruct> {
  const key = `${options.simplify ? 1 : 0}:${options.measureOnly ? 'm' : 'f'}:${options.sabre === false ? 'n' : 's'}:${ncText}`
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
      measureOnly: options.measureOnly,
      sabre: options.sabre,
    })
    .then((result) => {
      const value = {
        bytes: result.step ? new TextEncoder().encode(result.step) : null,
        sabre: result.sabre ?? [],
      }
      resolvedCache.set(key, value.bytes)
      return value
    })
    .catch((error) => {
      reconstructCache.delete(key)
      resolvedCache.delete(key)
      throw error
    })
  reconstructCache.set(key, promise)
  trimReconstructCache()
  return promise
}

function trimReconstructCache(): void {
  while (reconstructCache.size > RECONSTRUCT_CACHE_LIMIT) {
    const oldest = reconstructCache.keys().next()
    if (oldest.done) break
    reconstructCache.delete(oldest.value)
    resolvedCache.delete(oldest.value)
  }
}

/**
 * Rebuild once and return **both** the viewer STEP and the CUT_DEPTH probe, priming the normal
 * viewer cache key so the subsequent `reconstructForViewer`/`peekReconstructForViewer` is a hit.
 * The probe does not change the solid, so its STEP is valid for the plain viewer key.
 */
export function reconstructViewerWithSabre(
  ncText: string,
  options: { simplify?: boolean; priority?: number } = {},
): Promise<ViewerReconstruct> {
  return reconstructDetailed(ncText, { ...options, sabre: true }).then((result) => {
    const viewerKey = `${options.simplify ? 1 : 0}:f:n:${ncText}`
    const primed = reconstructCache.get(viewerKey)
    if (primed) {
      // A plain viewer build already exists (neighbour prefetch / analysis / background pass). Its
      // bytes object is the one whose mesh may be warmed, so return those to keep a single stable
      // identity — otherwise setting a fresh equivalent `Uint8Array` misses the mesh cache and the
      // viewer flashes "loading" on an already-loaded part. The probe does not change the solid.
      return primed
        .then((viewer) => ({ bytes: viewer.bytes, sabre: result.sabre }))
        .catch(() => result)
    }
    reconstructCache.set(viewerKey, Promise.resolve(result))
    resolvedCache.set(viewerKey, result.bytes)
    trimReconstructCache()
    return result
  })
}

/**
 * Prime the plain viewer cache from a STEP produced elsewhere (the analysis/fastTrack rebuild),
 * so opening the part is a cache hit and the viewer never rebuilds it.
 */
export function primeReconstructForViewer(ncText: string, step: string): void {
  const key = `0:f:n:${ncText}`
  if (reconstructCache.has(key)) return
  const bytes = new TextEncoder().encode(step)
  resolvedCache.set(key, bytes)
  reconstructCache.set(key, Promise.resolve({ bytes, sabre: [] }))
  trimReconstructCache()
}

/** Synchronous cache peek for the viewer: cached manufactured bytes, or null if not built yet. */
export function peekReconstructForViewer(ncText: string): Uint8Array | null {
  return resolvedCache.get(`0:f:n:${ncText}`) ?? null
}

export function reconstructForViewer(
  ncText: string,
  options: { simplify?: boolean; priority?: number } = {},
): Promise<Uint8Array | null> {
  return reconstructDetailed(ncText, { ...options, sabre: false }).then((result) => result.bytes)
}

/** Light-sabre failures on the same manufactured rebuild `reconstructForViewer` returns. */
export function sabreForViewer(
  ncText: string,
  options: { simplify?: boolean; priority?: number; measureOnly?: boolean } = {},
): Promise<SabreFailure[]> {
  return reconstructDetailed(ncText, { ...options, sabre: true }).then((result) => result.sabre)
}

/** Drop reconstruction results for a superseded job (the mesh cache is keyed weakly, so it self-clears). */
export function clearViewerModels(): void {
  reconstructCache.clear()
  resolvedCache.clear()
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
  const compareMatrix = relativeSeat(manufactured.vertices, step.vertices, profile, true)
  return getStepWorkerPool().diff(primary, compare, { compareMatrix, priority })
}
