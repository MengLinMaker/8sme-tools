import { existsSync, readFileSync } from 'node:fs'
import { fixture } from '@test/fixtures'
import { describe, expect, it } from 'vitest'
import { parseDstv } from '@/lib/parsers/dstv'
import { outlinePoints, outlineVoids } from '@/lib/sections/outline'
import { partSectionForCode } from '@/lib/sections/stock'
import { parseNcepPackage } from '@/lib/wisecam/ncepParse'
import { partIrFromNc } from './fromNc'
import { partIrFromNcep } from './fromNcep'
import { buildNcepFromIr, partIrToNcepPart } from './toNcep'

const MARKS = ['M-1', 'M-3', 'M-35', 'M-42'] as const

function header(mark: string) {
  return parseDstv(readFileSync(fixture('ncep', `${mark}.nc1`), 'utf8')).header
}

function sectionFor(mark: string) {
  const value = header(mark)
  const section = partSectionForCode(value.profile, value.dimensions)
  if (!section) throw new Error(`no section for ${mark}`)
  return section
}

function near(a: number, b: number, tolerance = 0.05): boolean {
  return Math.abs(a - b) <= tolerance
}

describe('PartIR → NCEP', () => {
  for (const mark of MARKS) {
    const ncPath = fixture('ncep', `${mark}.nc1`)
    it.skipIf(!existsSync(ncPath))(`${mark}: NC → IR → NCEP keeps holes and shaped ends`, () => {
      const ir = partIrFromNc(readFileSync(ncPath, 'utf8'))
      expect(ir).not.toBeNull()
      if (!ir) return
      const part = partIrToNcepPart(ir)
      expect(part).not.toBeNull()
      if (!part) return
      expect(part.startCut?.length ?? 0).toBeGreaterThan(1)
      expect(part.endCut?.length ?? 0).toBeGreaterThan(1)
      const bytes = buildNcepFromIr(ir)
      expect(bytes).not.toBeNull()
      if (!bytes) return
      const pkg = parseNcepPackage(bytes)
      const svgPart = pkg.partSvg?.part
      if (!svgPart) throw new Error('no part svg')
      expect(svgPart.holes).toHaveLength(part.holes?.length ?? 0)
      expect(pkg.quantity).toBe(part.quantity)
      expect(pkg.mark).toBe(part.mark)
    })
  }

  for (const mark of MARKS) {
    const ncPath = fixture('ncep', `${mark}.nc1`)
    const ncepPath = fixture('ncep', `${mark}.ncep`)
    it.skipIf(!existsSync(ncPath) || !existsSync(ncepPath))(
      `${mark}: real NCEP → IR → NCEP keeps holes and trims`,
      () => {
        const value = header(mark)
        const section = sectionFor(mark)
        const source = new Uint8Array(readFileSync(ncepPath))
        const sourcePkg = parseNcepPackage(source)
        const ir = partIrFromNcep(source, {
          profile: value.profile,
          dimensions: value.dimensions,
          length: value.length,
          section: outlinePoints(section?.outline),
          innerSection:
            outlinePoints(section?.innerOutline) ?? outlineVoids(section?.voidOutlines)?.[0],
          mark,
        })
        expect(ir).not.toBeNull()
        if (!ir) return
        const bytes = buildNcepFromIr(ir)
        expect(bytes).not.toBeNull()
        if (!bytes) return
        const output = parseNcepPackage(bytes)
        const sourcePart = sourcePkg.partSvg?.part
        const outputPart = output.partSvg?.part
        if (!sourcePart || !outputPart) throw new Error('no part svg')
        expect(outputPart.holes).toHaveLength(sourcePart.holes.length)
        for (const [index, hole] of sourcePart.holes.entries()) {
          const other = outputPart.holes[index]
          if (!other) throw new Error(`missing hole ${index}`)
          expect(near(other.cx, hole.cx)).toBe(true)
          expect(near(other.cy, hole.cy)).toBe(true)
          expect(near(other.r, hole.r)).toBe(true)
        }
        expect(outputPart.truncates.filter((truncate) => truncate.truncateType === 0)).toHaveLength(
          1,
        )
        expect(outputPart.truncates.filter((truncate) => truncate.truncateType === 1)).toHaveLength(
          1,
        )
      },
    )
  }
})
