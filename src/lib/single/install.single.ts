import * as assets from 'virtual:8sme-assets'
import { gunzipBase64, gunzipBase64ToArrayBuffer } from '@/lib/gzip'
import { setUnrarWasmProvider } from '@/lib/rar'
import { setEtchFontProvider } from '@/lib/step/occ'
import { setOcWasmProvider } from '@/lib/step/occInit'

let ocWasm: Promise<Uint8Array> | null = null
let etchFont: Promise<Uint8Array> | null = null
let unrarWasm: Promise<ArrayBuffer> | null = null

/**
 * Point every runtime asset loader at the compressed bytes embedded in the single HTML file.
 * The promises are lazy, so opening the file does not inflate the 23 MB OCC kernel until a
 * feature needs it.
 */
export function installSingleFileAssets(): void {
  setOcWasmProvider(() => (ocWasm ??= gunzipBase64(assets.ocWasmGzip)))
  setEtchFontProvider(() => (etchFont ??= gunzipBase64(assets.etchFontGzip)))
  setUnrarWasmProvider(() => (unrarWasm ??= gunzipBase64ToArrayBuffer(assets.unrarWasmGzip)))
}
