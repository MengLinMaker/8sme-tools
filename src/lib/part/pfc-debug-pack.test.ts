import { readFileSync } from 'node:fs'
import { fixture, nw31Bottom, nw31Top } from '@test/fixtures'
import { describe, expect, it } from 'vitest'
import { frameForProfile } from '@/lib/parsers/ncFaces'
import { type NcFace, parseNcGeometry } from '@/lib/parsers/ncGeometry'
import { cutThicknesses, faceThickness, THICKNESS_COLORS } from '@/lib/parsers/ncProject'
import { outlinePoints } from '@/lib/sections/outline'
import { partSectionForCode } from '@/lib/sections/stock'
import { faceAtCenteredStation } from '@/lib/wisecam/layout'
import { partIrFromNc } from './fromNc'
import type { PartIr } from './ir'
import { partIrSvg } from './svg'

/**
 * Debug pack `debug-pack-sections-2026-11-25` — the six PFC/TFC members (see
 * `docs/debug-pack.md`). These are the reference results for the per-face cut colouring: a
 * PFC100*50 has two plates, and every one of these parts cuts both:
 *
 * - flanges `o`/`u` — 6.7 mm → `THICKNESS_COLORS[1]` = `#cb9cff`
 * - web `v` (and its hidden back `h`) — 4.2 mm → `THICKNESS_COLORS[0]` = `#34d399`
 *
 * The IR must render both colours on every part. Keying a cut polyline off its first vertex
 * collapsed the flanges onto the web colour, which is the PFC regression this locks out.
 */
const PFC_PACK: {
  mark: string
  path: string
  length: number
  qty: number
}[] = [
  { mark: 'm124', path: nw31Top('NC files', 'm124.nc1'), length: 2055.75, qty: 1 },
  { mark: 'm116', path: nw31Bottom('m116.nc1'), length: 2980.61, qty: 1 },
  { mark: 'm65', path: fixture('part-ir', 'm65.nc1'), length: 2021.3, qty: 1 },
  { mark: 'm128', path: nw31Bottom('m128.nc1'), length: 1515.55, qty: 24 },
  { mark: 'm31', path: nw31Top('NC files', 'm31.nc1'), length: 4113.84, qty: 1 },
  { mark: 'm222', path: nw31Top('NC files', 'm222.nc1'), length: 1669.15, qty: 1 },
]

/** The palette index for a thickness, exactly as the preflight IR pane keys it. */
function paletteHex(thicknesses: number[], thickness: number): string {
  const index = thicknesses.indexOf(thickness)
  const color = THICKNESS_COLORS[index] as number
  return `#${color.toString(16).padStart(6, '0')}`
}

/** Every DSTV face a cut segment rides, using the segment midpoint (the IR's colour key). */
function cutFaces(part: PartIr): Set<NcFace> {
  const faces = new Set<NcFace>()
  const chart = part.charts[0]
  if (!chart) return faces
  for (const feature of part.features) {
    if (feature.kind !== 'cut' || feature.shape.form !== 'polyline') continue
    const points = feature.shape.points
    for (let index = 1; index < points.length; index++) {
      const a = points[index - 1] as [number, number]
      const b = points[index] as [number, number]
      const face = faceAtCenteredStation(chart.layout, (a[0] + b[0]) / 2)?.face
      if (face) faces.add(face)
    }
  }
  return faces
}

describe('debug pack PFC results (debug-pack-sections-2026-11-25)', () => {
  for (const { mark, path, length, qty } of PFC_PACK) {
    it(`${mark}: PFC100*50 cuts both plates and stays colour-keyed`, () => {
      const ir = partIrFromNc(readFileSync(path, 'utf8'))
      if (!ir) throw new Error(`no IR for ${mark}`)

      // Pack identity: the internal mark is what the viewer and machine see.
      expect(ir.mark).toBe(mark)
      expect(ir.profile).toBe('PFC100*50')
      expect(ir.length).toBeCloseTo(length, 2)
      expect(ir.quantity).toBe(qty)

      const section = partSectionForCode(ir.profile, ir.dimensions)
      if (!section) throw new Error(`no section for ${mark}`)
      const points = outlinePoints(section.outline)
      const frame = frameForProfile(ir.profile, points)
      const plate = (face: NcFace): number =>
        Math.round(faceThickness(frame, points, face) * 10) / 10

      // The two plates that must not collapse onto one colour.
      expect(plate('o')).toBe(6.7)
      expect(plate('u')).toBe(6.7)
      expect(plate('v')).toBe(4.2)
      expect(plate('h')).toBe(4.2)

      // The NC carries cuts on both plate thicknesses...
      const thicknesses = cutThicknesses(frame, points, parseNcGeometry(readFileSync(path, 'utf8')))
      expect(thicknesses).toEqual([4.2, 6.7])

      // ...on both flanges and the web, so the IR has to split the colour per face...
      expect([...cutFaces(ir)].sort()).toEqual(['o', 'u', 'v'])

      // ...and the rendered result must show both palette colours.
      const palette: Record<string, string | undefined> = {
        o: paletteHex(thicknesses, plate('o')),
        u: paletteHex(thicknesses, plate('u')),
        v: paletteHex(thicknesses, plate('v')),
        h: paletteHex(thicknesses, plate('h')),
      }
      expect(palette.o).toBe('#cb9cff')
      expect(palette.u).toBe('#cb9cff')
      expect(palette.v).toBe('#34d399')
      expect(palette.h).toBe('#34d399')

      const svg = partIrSvg(ir, { colorForFace: (face) => palette[face] })
      expect(svg).toContain('stroke="#cb9cff"')
      expect(svg).toContain('stroke="#34d399"')
    })
  }
})
