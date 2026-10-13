import type { ZipEntry } from './zip'

const RAR_MAGIC = [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07]

export function isRar(bytes: Uint8Array): boolean {
  if (bytes.length < 7) return false
  for (let i = 0; i < RAR_MAGIC.length; i++) {
    if (bytes[i] !== RAR_MAGIC[i]) return false
  }
  return bytes[6] === 0x00 || bytes[6] === 0x01
}

let wasmBinaryPromise: Promise<ArrayBuffer> | undefined

function loadWasmBinary(): Promise<ArrayBuffer> {
  wasmBinaryPromise ??= import('node-unrar-js/esm/js/unrar.wasm?url').then((url) =>
    fetch(url.default).then((response) => response.arrayBuffer()),
  )
  return wasmBinaryPromise
}

export async function extractRarEntries(
  bytes: Uint8Array,
  wasmBinary?: ArrayBuffer,
): Promise<ZipEntry[]> {
  const { createExtractorFromData } = await import('node-unrar-js/esm')
  const data = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer
  const extractor = await createExtractorFromData({ data, wasmBinary })
  const entries: ZipEntry[] = []
  for (const file of extractor.extract().files) {
    if (file.fileHeader.flags.directory) continue
    const extraction = file.extraction
    if (!extraction) continue
    entries.push({ path: file.fileHeader.name, bytes: extraction })
  }
  return entries
}

export async function readRar(bytes: Uint8Array): Promise<ZipEntry[]> {
  return extractRarEntries(bytes, await loadWasmBinary())
}
