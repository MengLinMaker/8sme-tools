import { existsSync, readFileSync } from 'node:fs'
import { fixture } from '@test/fixtures'
import { describe, expect, it } from 'vitest'
import { parseDstv } from '@/lib/parsers/dstv'
import { outlinePoints, outlineVoids } from '@/lib/sections/outline'
import { partSectionForCode } from '@/lib/sections/stock'
import { parseNcepPackage } from '@/lib/wisecam/ncepParse'
import { partIrFromNcep } from './fromNcep'
import { partIrSvg } from './svg'

const MARKS = ['M-1', 'M-3', 'M-35', 'M-42'] as const

describe('NCEP → PartIR', () => {
  for (const mark of MARKS) {
    const ncepPath = fixture('ncep', `${mark}.ncep`)
    const ncPath = fixture('ncep', `${mark}.nc1`)
    it.skipIf(!existsSync(ncepPath) || !existsSync(ncPath))(
      `${mark}: imports holes, cuts and marks onto the canonical net`,
      () => {
        const bytes = new Uint8Array(readFileSync(ncepPath))
        const pkg = parseNcepPackage(bytes)
        const header = parseDstv(readFileSync(ncPath, 'utf8')).header
        const section = partSectionForCode(header.profile, header.dimensions)
        if (!section) throw new Error('no section')
        const part = partIrFromNcep(bytes, {
          profile: header.profile,
          dimensions: header.dimensions,
          length: header.length,
          section: outlinePoints(section?.outline),
          innerSection:
            outlinePoints(section?.innerOutline) ?? outlineVoids(section?.voidOutlines)?.[0],
          mark,
        })
        expect(part).not.toBeNull()
        if (!part) return
        const svgPart = pkg.partSvg?.part
        if (!svgPart) throw new Error('no part svg')
        const cutCount =
          svgPart.truncates.reduce(
            (sum, truncate) =>
              sum +
              truncate.paths.length +
              (truncate.bevels ?? []).reduce((inner, bevel) => inner + bevel.paths.length, 0),
            0,
          ) + svgPart.wires.reduce((sum, wire) => sum + wire.paths.length, 0)
        expect(part.features.filter((feature) => feature.kind === 'cut')).toHaveLength(cutCount)
        expect(
          part.features.filter((feature) => feature.kind === 'hole' || feature.kind === 'slot'),
        ).toHaveLength(svgPart.holes.length)
        expect(part.marks.length).toBeGreaterThanOrEqual(
          svgPart.marks.filter((mark) => mark.tag === 'text').length,
        )
        expect(part.quantity).toBe(pkg.quantity ?? 1)
        expect(part.length).toBe(header.length)
        const svg = partIrSvg(part)
        expect(svg).toContain('data-layer="chart:front"')
      },
    )
  }
})
