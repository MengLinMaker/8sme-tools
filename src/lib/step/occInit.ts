/**
 * Lazily loads the OpenCASCADE WASM kernel (via `replicad`) exactly once and
 * shares the same promise across every consumer. The ~23 MB WASM is only
 * fetched when a feature actually needs the kernel (STEP generation, 3D
 * preview), so it never lands in the initial bundle.
 */

let ocReady: Promise<void> | null = null
let wasmUrlOverride: string | undefined

/** Override the WASM location (used by tests; the browser uses the bundled `?url`). */
export function setOcWasmUrl(url: string): void {
  wasmUrlOverride = url
}

export async function ensureOc(): Promise<void> {
  if (!ocReady) {
    ocReady = (async () => {
      const [{ default: initOpenCascade }, replicad, wasm] = await Promise.all([
        import('replicad-opencascadejs'),
        import('replicad'),
        import('replicad-opencascadejs/wasm?url'),
      ])
      const oc = await initOpenCascade({ locateFile: () => wasmUrlOverride ?? wasm.default })
      replicad.setOC(oc)
    })()
  }
  return ocReady
}
