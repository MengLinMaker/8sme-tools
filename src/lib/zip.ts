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
