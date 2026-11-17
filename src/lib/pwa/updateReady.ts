/**
 * Header's view of a waiting service-worker build.
 *
 * `useRegisterSW` registers the worker, so it may only run once (`PwaUpdater` owns it) and
 * publishes the result here. The version label then reads it with `useSyncExternalStore`.
 *
 * The flag is sticky on purpose: dismissing the toast ("Later") hides the prompt but the running
 * build is still stale, so the label must keep saying so. Applying the update reloads the page,
 * which resets this module anyway.
 */

let updateReady = false
let applyUpdate: (() => void) | null = null
const listeners = new Set<() => void>()

export function subscribeUpdateReady(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function isUpdateReady(): boolean {
  return updateReady
}

export function markUpdateReady(): void {
  if (updateReady) return
  updateReady = true
  for (const listener of listeners) listener()
}

/** The action that swaps in the waiting build (the toast's "Reload now"). */
export function setUpdateAction(action: () => void): void {
  applyUpdate = action
}

export function applyUpdateNow(): void {
  applyUpdate?.()
}
