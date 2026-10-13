import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { extractRarEntries, isRar } from './rar'

const magic = (...bytes: number[]) => new Uint8Array(bytes)

const RAR_B64 =
  'UmFyIRoHAM+QcwAADQAAAAAAAAAYg3QAACkAFAAAABQAAAAD18MF6gAAAAAUMAkAAAAAAGhlbGxvLnR4dGhlbGxvIHJhciBmcm9tIDhzbWUKBLB7AAAHAA=='

function sampleRar(): Uint8Array {
  return Uint8Array.from(atob(RAR_B64), (c) => c.charCodeAt(0))
}

function unrarWasm(): ArrayBuffer {
  const path = new URL('../../node_modules/node-unrar-js/esm/js/unrar.wasm', import.meta.url)
  const buf = fs.readFileSync(path)
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
}

describe('isRar', () => {
  it('detects RAR4 archives', () => {
    expect(isRar(magic(0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00))).toBe(true)
  })

  it('detects RAR5 archives', () => {
    expect(isRar(magic(0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00))).toBe(true)
  })

  it('rejects zip archives', () => {
    expect(isRar(magic(0x50, 0x4b, 0x03, 0x04))).toBe(false)
  })

  it('rejects short input', () => {
    expect(isRar(magic(0x52, 0x61, 0x72, 0x21, 0x1a))).toBe(false)
  })

  it('rejects unrelated bytes', () => {
    expect(isRar(magic(0x52, 0x61, 0x72, 0x21, 0x1a, 0x08, 0x00))).toBe(false)
  })
})

describe('extractRarEntries', () => {
  it('extracts stored files through the unrar wasm', async () => {
    const entries = await extractRarEntries(sampleRar(), unrarWasm())
    expect(entries.map((e) => e.path)).toEqual(['hello.txt'])
    expect(new TextDecoder().decode(entries[0]?.bytes)).toBe('hello rar from 8sme\n')
  })
})
