/**
 * Raw ZIP reader/writer for probe generation only. Keeps every local/central header field
 * exactly as read, so we can change one thing (compressed bytes, timestamp, flags) at a time.
 * Do not import this from app code.
 */
export interface RawZipEntry {
  name: string
  versionMadeBy: number
  versionNeeded: number
  flags: number
  method: number
  time: number
  date: number
  crc: number
  compressedSize: number
  uncompressedSize: number
  internalAttr: number
  externalAttr: number
  compressed: Uint8Array
}

function u16(view: DataView, at: number): number {
  return view.getUint16(at, true)
}

function u32(view: DataView, at: number): number {
  return view.getUint32(at, true)
}

export function readZipRaw(bytes: Uint8Array): RawZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let eocd = -1
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (u32(view, i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('readZipRaw: no EOCD')
  const count = u16(view, eocd + 10)
  let at = u32(view, eocd + 16)
  const entries: RawZipEntry[] = []
  for (let i = 0; i < count; i++) {
    if (u32(view, at) !== 0x02014b50) throw new Error(`readZipRaw: bad central at ${at}`)
    const nameLen = u16(view, at + 28)
    const extraLen = u16(view, at + 30)
    const commentLen = u16(view, at + 32)
    const localAt = u32(view, at + 42)
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLen))
    const localNameLen = u16(view, localAt + 26)
    const localExtraLen = u16(view, localAt + 28)
    const dataAt = localAt + 30 + localNameLen + localExtraLen
    const compressedSize = u32(view, at + 20)
    entries.push({
      name,
      versionMadeBy: u16(view, at + 4),
      versionNeeded: u16(view, at + 6),
      flags: u16(view, at + 8),
      method: u16(view, at + 10),
      time: u16(view, at + 12),
      date: u16(view, at + 14),
      crc: u32(view, at + 16),
      compressedSize,
      uncompressedSize: u32(view, at + 24),
      internalAttr: u16(view, at + 36),
      externalAttr: u32(view, at + 38),
      compressed: bytes.slice(dataAt, dataAt + compressedSize),
    })
    at += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

class Writer {
  private readonly chunks: Uint8Array[] = []
  private length = 0

  get offset(): number {
    return this.length
  }

  push(bytes: Uint8Array | number[]): void {
    const chunk = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
    this.chunks.push(chunk)
    this.length += chunk.length
  }

  finish(): Uint8Array {
    const out = new Uint8Array(this.length)
    let at = 0
    for (const chunk of this.chunks) {
      out.set(chunk, at)
      at += chunk.length
    }
    return out
  }
}

const u16b = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff]
const u32b = (n: number): number[] => [
  n & 0xff,
  (n >>> 8) & 0xff,
  (n >>> 16) & 0xff,
  (n >>> 24) & 0xff,
]

export function writeZipRaw(entries: RawZipEntry[]): Uint8Array {
  const local = new Writer()
  const central = new Writer()
  const offsets = new Map<string, number>()
  const enc = new TextEncoder()
  for (const entry of entries) {
    const name = enc.encode(entry.name)
    offsets.set(entry.name, local.offset)
    local.push(u32b(0x04034b50))
    local.push(u16b(entry.versionNeeded))
    local.push(u16b(entry.flags))
    local.push(u16b(entry.method))
    local.push(u16b(entry.time))
    local.push(u16b(entry.date))
    local.push(u32b(entry.crc))
    local.push(u32b(entry.compressedSize))
    local.push(u32b(entry.uncompressedSize))
    local.push(u16b(name.length))
    local.push(u16b(0))
    local.push(name)
    local.push(entry.compressed)
  }
  const centralOffset = local.offset
  for (const entry of entries) {
    const name = enc.encode(entry.name)
    central.push(u32b(0x02014b50))
    central.push(u16b(entry.versionMadeBy))
    central.push(u16b(entry.versionNeeded))
    central.push(u16b(entry.flags))
    central.push(u16b(entry.method))
    central.push(u16b(entry.time))
    central.push(u16b(entry.date))
    central.push(u32b(entry.crc))
    central.push(u32b(entry.compressedSize))
    central.push(u32b(entry.uncompressedSize))
    central.push(u16b(name.length))
    central.push(u16b(0))
    central.push(u16b(0))
    central.push(u16b(0))
    central.push(u16b(entry.internalAttr))
    central.push(u32b(entry.externalAttr))
    central.push(u32b(offsets.get(entry.name) ?? 0))
    central.push(name)
  }
  const centralSize = central.offset
  local.push(central.finish())
  local.push(u32b(0x06054b50))
  local.push(u16b(0))
  local.push(u16b(0))
  local.push(u16b(entries.length))
  local.push(u16b(entries.length))
  local.push(u32b(centralSize))
  local.push(u32b(centralOffset))
  local.push(u16b(0))
  return local.finish()
}

export function entryNamed(entries: RawZipEntry[], name: string): RawZipEntry {
  const entry = entries.find((candidate) => candidate.name === name)
  if (!entry) throw new Error(`entryNamed: no ${name}`)
  return entry
}

export function replaceCompressed(
  entries: RawZipEntry[],
  name: string,
  compressed: Uint8Array,
): RawZipEntry[] {
  const uncompressedSize = entryNamed(entries, name).uncompressedSize
  return entries.map((entry) =>
    entry.name === name
      ? { ...entry, compressed, compressedSize: compressed.length, uncompressedSize }
      : entry,
  )
}
