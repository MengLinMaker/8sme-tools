import { unzipSync } from 'fflate'

export interface ZipEntry {
  path: string
  bytes: Uint8Array
}

export function isZip(bytes: Uint8Array): boolean {
  return (
    bytes.length > 3 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07)
  )
}

export function readZip(bytes: Uint8Array): ZipEntry[] {
  const files = unzipSync(bytes)
  const entries: ZipEntry[] = []
  for (const [path, data] of Object.entries(files)) {
    if (path.endsWith('/')) continue
    if (!data) continue
    entries.push({ path, bytes: data })
  }
  return entries
}

/**
 * Re-keys source-path → bytes into a zip object whose keys are basenames only, so the archive
 * has no folders (WiseCAM-friendly). Two different sources that share a filename get
 * `name (2).ext`, `name (3).ext`, … ; the same bytes under the same name are kept once.
 */
export function flattenZipEntries(
  entries: Iterable<readonly [string, Uint8Array]>,
): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {}
  for (const [path, bytes] of entries) {
    const base = path.split('/').pop() ?? path
    if (!base) continue
    if (!(base in out)) {
      out[base] = bytes
      continue
    }
    if (out[base] === bytes) continue
    const dot = base.lastIndexOf('.')
    const stem = dot > 0 ? base.slice(0, dot) : base
    const ext = dot > 0 ? base.slice(dot) : ''
    let n = 2
    while (`${stem} (${n})${ext}` in out) n += 1
    out[`${stem} (${n})${ext}`] = bytes
  }
  return out
}
