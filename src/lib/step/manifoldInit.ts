import type { ManifoldToplevel } from 'manifold-3d'

/**
 * Lazily loads the Manifold WASM kernel exactly once and shares the same promise across every
 * consumer. The kernel is only fetched when the overlay diff actually runs, so it never lands in
 * the initial bundle.
 */

let ready: Promise<ManifoldToplevel> | null = null
let wasmUrlOverride: string | undefined

/** Override the WASM location (used by tests; the browser uses the bundled `?url`). */
export function setManifoldWasmUrl(url: string): void {
  wasmUrlOverride = url
}

export async function ensureManifold(): Promise<ManifoldToplevel> {
  if (!ready) {
    ready = (async () => {
      const [{ default: createModule }, wasm] = await Promise.all([
        import('manifold-3d'),
        import('manifold-3d/manifold.wasm?url'),
      ])
      const module = await createModule({ locateFile: () => wasmUrlOverride ?? wasm.default })
      module.setup()
      return module
    })()
  }
  return ready
}
