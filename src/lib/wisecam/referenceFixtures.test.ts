import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { inflateRawSync } from 'node:zlib'
import { fixture } from '@test/fixtures'
import { describe, expect, it } from 'vitest'
import { crc32 } from './ncex'
import { readZipRaw } from './probeZip'

interface ManifestFile {
  path: string
  sha256: string
  bytes: number
}

const manifest = JSON.parse(readFileSync(fixture('ncep', 'manifest.json'), 'utf8')) as {
  note: string
  files: ManifestFile[]
}

/**
 * These are the known-good imports every NCEP probe is measured against. The test is deliberately
 * a hard failure, not a skip: deleting a reference must break the suite (see the fixture README).
 */
describe('reference NCEP fixtures', () => {
  it('keeps every reference present and byte-identical', () => {
    expect(manifest.files.length).toBeGreaterThanOrEqual(22)
    for (const file of manifest.files) {
      const bytes = new Uint8Array(readFileSync(fixture('ncep', file.path)))
      expect(bytes.length, file.path).toBe(file.bytes)
      expect(createHash('sha256').update(bytes).digest('hex'), file.path).toBe(file.sha256)
    }
  })

  it('reads as a valid ZIP with matching CRCs', () => {
    for (const file of manifest.files) {
      const entries = readZipRaw(new Uint8Array(readFileSync(fixture('ncep', file.path))))
      expect(entries.length, file.path).toBeGreaterThan(1)
      for (const entry of entries) {
        const data =
          entry.method === 0 ? entry.compressed : new Uint8Array(inflateRawSync(entry.compressed))
        expect(crc32(data), `${file.path}:${entry.name}`).toBe(entry.crc)
        expect(data.length, `${file.path}:${entry.name}`).toBe(entry.uncompressedSize)
      }
    }
  })
})
