import { readFileSync } from 'node:fs'
import { fixture } from '@test/fixtures'
import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { buildNcepFromNc, partFromNc } from './fromNc'

const CASES = [
  { mark: 'M-1', family: 'PFC380', paths: 2, innerClosed: false },
  { mark: 'M-3', family: 'UB310', paths: 1, innerClosed: null },
  { mark: 'M-34', family: 'PFC300', paths: 2, innerClosed: false },
  { mark: 'M-35', family: 'SHS89', paths: 2, innerClosed: true },
  { mark: 'M-42', family: 'RHS100x50', paths: 2, innerClosed: true },
] as const

function readNc(mark: string): string {
  return readFileSync(fixture('ncep', `${mark}.nc1`), 'utf8')
}

function partSvg(bytes: Uint8Array): string {
  const files = unzipSync(bytes)
  const root = strFromU8(files['CAD/CadRoot.xml'] as Uint8Array)
  const name = /<Part [^>]*svgname="([^"]+)"/.exec(root)?.[1]
  if (!name) throw new Error('no part svg')
  return strFromU8(files[`CAD/${name}`] as Uint8Array)
}

function sectionGroup(svg: string): string {
  const at = svg.indexOf('wh:class="cadgroup"')
  if (at < 0) throw new Error('no section cadgroup')
  return svg.slice(at)
}

function innerPath(svg: string): string {
  const paths = [...sectionGroup(svg).matchAll(/<path\b[^>]*\bd="([^"]+)"/g)]
  return paths[paths.length - 1]?.[1] ?? ''
}

describe('NC -> NCEP conversion gate', () => {
  for (const testCase of CASES) {
    it(`${testCase.mark} (${testCase.family}) emits a complete package`, () => {
      const nc = readNc(testCase.mark)
      const part = partFromNc(nc, { mark: `${testCase.mark}-gate` })
      expect(part).not.toBeNull()
      if (!part) return

      const bytes = buildNcepFromNc(nc, { mark: `${testCase.mark}-gate` })
      expect(bytes).not.toBeNull()
      if (!bytes) return

      const files = unzipSync(bytes)
      const names = Object.keys(files)
      expect(names.some((name) => name.startsWith('CNC/'))).toBe(false)
      expect(names).toHaveLength(9)

      const svg = partSvg(bytes)
      const group = sectionGroup(svg)
      expect(group.match(/<path\b/g)).toHaveLength(testCase.paths)
      expect(svg.match(/<circle\b/g)?.length ?? 0).toBe(part.holes?.length ?? 0)

      if (testCase.innerClosed != null) {
        expect(innerPath(svg).trim().endsWith('Z')).toBe(testCase.innerClosed)
      }

      const root = strFromU8(files['CAD/CadRoot.xml'] as Uint8Array)
      expect(root).toContain(`Name=${testCase.mark}-gate`)
      expect(svg).toContain(`Part=${testCase.mark}-gate`)
      expect(svg).toContain(`LabelContent=${testCase.mark}-gate`)
      expect(svg).toContain(`>${testCase.mark}-gate</text>`)
    })
  }

  it('uses a fresh technologyID for every part and build', () => {
    const ids = (mark: string): string[] => {
      const bytes = buildNcepFromNc(readNc(mark), { mark: `${mark}-gate` })
      if (!bytes) throw new Error(`no package for ${mark}`)
      const root = strFromU8(unzipSync(bytes)['CAD/CadRoot.xml'] as Uint8Array)
      return [...root.matchAll(/technologyID="([^"]+)"/g)].map((match) => match[1] as string)
    }
    const all = CASES.flatMap((testCase) => [...ids(testCase.mark), ...ids(testCase.mark)])
    expect(all.length).toBeGreaterThan(0)
    expect(new Set(all).size).toBe(all.length)
  })

  it('rejects an unsupported T profile instead of writing a bad package', () => {
    const nc = readNc('M-3').replace(/\r?\n {2}I\r?\n/, '\n  T\n')
    expect(partFromNc(nc)).toBeNull()
    expect(buildNcepFromNc(nc)).toBeNull()
  })

  it('keeps the package build deterministic apart from technologyID', () => {
    const a = buildNcepFromNc(readNc('M-1'), { mark: 'M-1-gate' })
    const b = buildNcepFromNc(readNc('M-1'), { mark: 'M-1-gate' })
    if (!a || !b) throw new Error('no package')
    const strip = (bytes: Uint8Array): string =>
      strFromU8(unzipSync(bytes)['CAD/CadRoot.xml'] as Uint8Array).replace(
        /technologyID="[^"]+"/g,
        'technologyID="X"',
      )
    expect(strip(a)).toBe(strip(b))
  })
})
