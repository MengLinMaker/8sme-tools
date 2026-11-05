/**
 * Lazily loads the OpenCASCADE WASM kernel (via `replicad`) exactly once and
 * shares the same promise across every consumer. The ~23 MB WASM is only
 * fetched when a feature actually needs the kernel (STEP generation, 3D
 * preview), so it never lands in the initial bundle.
 */

let ocReady: Promise<void> | null = null
let wasmUrlOverride: string | undefined
let wasmBinaryOverride: ArrayBuffer | Uint8Array | undefined
let wasmBinaryProvider: (() => Promise<ArrayBuffer | Uint8Array>) | undefined

/** Override the WASM location (used by tests; the browser uses the bundled `?url`). */
export function setOcWasmUrl(url: string): void {
  wasmUrlOverride = url
}

/**
 * Supply the WASM bytes directly. Used by the single-file build (embedded bytes) and by the STEP
 * worker (bytes arrive in its init message) so no `fetch` of a separate `.wasm` file is needed.
 */
export function setOcWasmBinary(binary: ArrayBuffer | Uint8Array): void {
  wasmBinaryOverride = binary
}

/** Lazy version of {@link setOcWasmBinary}, for browser boot code that only decodes on first use. */
export function setOcWasmProvider(provider: () => Promise<ArrayBuffer | Uint8Array>): void {
  wasmBinaryProvider = provider
}

export async function ensureOc(): Promise<void> {
  if (!ocReady) {
    ocReady = (async () => {
      const binary =
        wasmBinaryOverride ?? (wasmBinaryProvider ? await wasmBinaryProvider() : undefined)
      if (binary) wasmBinaryOverride = binary
      const [{ default: initOpenCascade }, replicad, wasm] = await Promise.all([
        import('replicad-opencascadejs'),
        import('replicad'),
        binary ? Promise.resolve(null) : import('replicad-opencascadejs/wasm?url'),
      ])
      const oc = await initOpenCascade(
        binary
          ? { wasmBinary: binary }
          : { locateFile: () => wasmUrlOverride ?? (wasm as { default: string }).default },
      )
      replicad.setOC(oc)
    })()
  }
  return ocReady
}
