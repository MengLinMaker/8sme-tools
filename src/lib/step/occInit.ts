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

/**
 * The OCCT kernel writes everything it has to say — STEP transfer statistics, progress, asterisk
 * banners, blank separators — to **stdout**, which Emscripten forwards to `console.log`. That is a
 * kernel chatter channel, not app logging: every export buries the console in it, and routing it
 * through one of our functions only makes it look like ours.
 *
 * So the module's `print` hook is silenced by default. Real failures arrive as thrown exceptions
 * (the rebuild reports those) or on `printErr`, which is left alone. To read the kernel's own
 * output when debugging, set `SME_OC_VERBOSE=1` (node/CLI) or
 * `localStorage['sme:oc-verbose'] = '1'` (browser) before the kernel loads.
 */
let ocVerbose: boolean | undefined
function ocPrintEnabled(): boolean {
  if (ocVerbose !== undefined) return ocVerbose
  let verbose = false
  try {
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
      ?.env?.SME_OC_VERBOSE
    if (env && env !== '0') verbose = true
  } catch {}
  if (!verbose) {
    try {
      // Workers have no localStorage; `typeof` keeps that from throwing.
      const storage = typeof localStorage === 'undefined' ? null : localStorage
      if (storage?.getItem('sme:oc-verbose') === '1') verbose = true
    } catch {}
  }
  ocVerbose = verbose
  return verbose
}

function ocPrint(line: string): void {
  if (ocPrintEnabled()) console.log(line)
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
      const oc = await initOpenCascade({
        ...(binary
          ? { wasmBinary: binary }
          : { locateFile: () => wasmUrlOverride ?? (wasm as { default: string }).default }),
        // Emscripten reads `print` from the module options (`g.print && (ma = g.print)`).
        print: ocPrint,
      } as Parameters<typeof initOpenCascade>[0])
      replicad.setOC(oc)
    })()
  }
  return ocReady
}
