import { existsSync, readFileSync } from 'node:fs'
import { fixture } from '@test/fixtures'
import { describe, expect, it } from 'vitest'
import { type NcFace, parseNcGeometry } from '@/lib/parsers/ncGeometry'
import { centeredStationFor } from '@/lib/wisecam/layout'
import { partIrFromNc } from './fromNc'
import { chartForFace, type PartIr } from './ir'
import { partIrToNcGeometry } from './toNcGeometry'

const MARKS = ['M-1', 'M-3', 'M-35', 'M-42', 'M-16', 'M-41', '3uc-16', 'm88'] as const
const DIRS: Record<string, string> = {
  'M-16': 'part-ir',
  'M-41': 'part-ir',
  '3uc-16': 'part-ir',
  m88: 'part-ir',
}

function station(part: PartIr, face: NcFace, y: number): number | null {
  const chart = chartForFace(part, face)
  return chart ? centeredStationFor(chart.layout, face, y) : null
}

describe('PartIR → face-space NC geometry', () => {
  for (const mark of MARKS) {
    const path = fixture(DIRS[mark] ?? 'ncep', `${mark}.nc1`)
    it.skipIf(!existsSync(path))(`${mark}: projects the canonical IR back onto faces`, () => {
      const text = readFileSync(path, 'utf8')
      const source = parseNcGeometry(text)
      const part = partIrFromNc(text)
      if (!part) throw new Error('no IR')
      const geometry = partIrToNcGeometry(part)
      expect(geometry.contours).toHaveLength(source.contours.length)
      expect(geometry.holes).toHaveLength(source.holes.length)
      expect(geometry.marks).toHaveLength(source.marks.length)
      for (const [index, expected] of source.contours.entries()) {
        const actual = geometry.contours[index]
        if (!actual) throw new Error(`missing contour ${index}`)
        expect(actual.points).toHaveLength(expected.points.length)
        for (const [pointIndex, point] of expected.points.entries()) {
          const other = actual.points[pointIndex] as [number, number]
          expect(
            Math.abs(
              (station(part, actual.face, other[1]) ?? 0) -
                (station(part, expected.face, point[1]) ?? 0),
            ),
          ).toBeLessThan(0.1)
          expect(Math.abs(other[0] - point[0])).toBeLessThan(0.1)
        }
      }
    })
  }
})
