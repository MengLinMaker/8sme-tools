import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fixture } from '@test/fixtures'
import { describe, expect, it } from 'vitest'
import { ncepErrors, parseNcepPackage } from './ncepParse'

interface BaselineFile {
  path: string
  name: string
  profile: 'U' | 'I' | 'M'
  wisecam: string
  why: string
  bytes: number
  sha256: string
}

const manifest = JSON.parse(
  readFileSync(fixture('ncep', 'generated-baselines', 'manifest.json'), 'utf8'),
) as { note: string; files: BaselineFile[] }

/**
 * Generated probe baselines that document the section/arc theory. Unlike `referenceFixtures.test`,
 * these are converter outputs, not WiseCAM ground truth. Hash-guard them so the successful and
 * negative forms cannot drift silently.
 */
describe('generated NCEP reference baselines', () => {
  it('keeps every baseline present and byte-identical', () => {
    expect(manifest.files.length).toBeGreaterThanOrEqual(8)
    for (const file of manifest.files) {
      const bytes = new Uint8Array(readFileSync(fixture('ncep', 'generated-baselines', file.path)))
      expect(bytes.length, file.path).toBe(file.bytes)
      expect(createHash('sha256').update(bytes).digest('hex'), file.path).toBe(file.sha256)
    }
  })

  it('parses with the expected mark, trim and section structure', () => {
    for (const file of manifest.files) {
      const pkg = parseNcepPackage(
        new Uint8Array(readFileSync(fixture('ncep', 'generated-baselines', file.path))),
      )
      expect(ncepErrors(pkg), file.path).toEqual([])
      expect(pkg.mark, file.path).toBe(file.name)
      expect(pkg.partSvg?.part?.truncates, file.path).toHaveLength(2)
      const sectionPaths =
        pkg.partSvg?.sections.reduce((total, group) => total + group.wires.length, 0) ?? 0
      expect(sectionPaths, file.path).toBe(file.profile === 'I' ? 1 : 2)
      expect(pkg.adobeSvg?.userPaths.length, file.path).toBe(
        file.profile === 'U' || file.profile === 'I' ? 1 : 0,
      )
    }
  })
})
