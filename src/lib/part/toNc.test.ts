import { existsSync, readFileSync } from 'node:fs'
import { fixture } from '@test/fixtures'
import { describe, expect, it } from 'vitest'
import { parseDstv } from '@/lib/parsers/dstv'
import { type NcFace, parseNcGeometry, slotOffset } from '@/lib/parsers/ncGeometry'
import { centeredStationFor } from '@/lib/wisecam/layout'
import { partIrFromNc } from './fromNc'
import { chartForFace, type PartIr } from './ir'
import { partIrToNc } from './toNc'

const FIXTURES = [
  ...['M-1', 'M-3', 'M-35', 'M-42', 'M_12'].map((mark) => ({ dir: 'ncep', mark })),
  ...['M-16', 'M-18', 'M-27', 'M-29', 'M-32', 'M-41', '3uc-16', 'm203', 'm88'].map((mark) => ({
    dir: 'part-ir',
    mark,
  })),
] as const

function close(a: number, b: number, tolerance = 0.05): boolean {
  return Math.abs(a - b) <= tolerance
}

/** Canonical chart station for a DSTV face point — face letters may legitimately change at a shared edge. */
function station(part: PartIr, face: NcFace, y: number): number | null {
  const chart = chartForFace(part, face)
  return chart ? centeredStationFor(chart.layout, face, y) : null
}

describe('NC → PartIR → NC', () => {
  for (const { dir, mark } of FIXTURES) {
    const path = fixture(dir, `${mark}.nc1`)
    it.skipIf(!existsSync(path))(`${mark}: preserves the semantic NC geometry`, () => {
      const source = readFileSync(path, 'utf8')
      const before = parseNcGeometry(source)
      const beforeHeader = parseDstv(source).header
      const part = partIrFromNc(source)
      expect(part).not.toBeNull()
      if (!part) return
      const emitted = partIrToNc(part)
      const after = parseNcGeometry(emitted)
      const afterHeader = parseDstv(emitted).header

      expect(afterHeader.profile).toBe(beforeHeader.profile)
      expect(afterHeader.profileType).toBe(beforeHeader.profileType)
      expect(close(afterHeader.length, beforeHeader.length)).toBe(true)
      expect(
        afterHeader.dimensions.map((value, index) =>
          close(value, beforeHeader.dimensions[index] ?? Number.NaN),
        ),
      ).toEqual(beforeHeader.dimensions.map(() => true))
      expect(afterHeader.quantity).toBe(beforeHeader.quantity)

      expect(after.contours).toHaveLength(before.contours.length)
      for (const [index, expected] of before.contours.entries()) {
        const actual = after.contours[index]
        if (!actual) throw new Error(`missing contour ${index}`)
        expect(actual.kind).toBe(expected.kind)
        expect(actual.points).toHaveLength(expected.points.length)
        for (const [pointIndex, point] of expected.points.entries()) {
          const other = actual.points[pointIndex] as [number, number]
          const sourceStation = station(part, expected.face, point[1])
          const outputStation = station(part, actual.face, other[1])
          expect(outputStation).not.toBeNull()
          expect(close(outputStation ?? 0, sourceStation ?? 0, 0.1)).toBe(true)
          expect(close(other[0], point[0], 0.1)).toBe(true)
          expect(close(actual.radii?.[pointIndex] ?? 0, expected.radii?.[pointIndex] ?? 0)).toBe(
            true,
          )
          expect(actual.refs?.[pointIndex] ?? null).toBe(expected.refs?.[pointIndex] ?? null)
          const bevel = expected.bevels[pointIndex] ?? []
          const otherBevel = actual.bevels[pointIndex] ?? []
          for (let field = 0; field < 4; field++)
            expect(close(otherBevel[field] ?? 0, bevel[field] ?? 0)).toBe(true)
        }
      }

      expect(after.holes).toHaveLength(before.holes.length)
      for (const [index, expected] of before.holes.entries()) {
        const actual = after.holes[index]
        if (!actual) throw new Error(`missing hole ${index}`)
        const sourceStation = station(part, expected.face, expected.y)
        const outputStation = station(part, actual.face, actual.y)
        expect(outputStation).not.toBeNull()
        expect(close(outputStation ?? 0, sourceStation ?? 0, 0.1)).toBe(true)
        expect(close(actual.x, expected.x, 0.1)).toBe(true)
        expect(close(actual.diameter, expected.diameter, 0.1)).toBe(true)
        const expectedSlot = expected.slot ? slotOffset(expected.slot) : null
        const actualSlot = actual.slot ? slotOffset(actual.slot) : null
        if (expectedSlot) {
          expect(actualSlot).not.toBeNull()
          const expectedFar = station(part, expected.face, expected.y + expectedSlot[1])
          const actualFar = station(part, actual.face, actual.y + (actualSlot?.[1] ?? 0))
          expect(close(actualFar ?? 0, expectedFar ?? 0, 0.1)).toBe(true)
          expect(close(actual.x + (actualSlot?.[0] ?? 0), expected.x + expectedSlot[0], 0.1)).toBe(
            true,
          )
        } else {
          expect(actualSlot).toBeNull()
        }
      }

      expect(after.notches).toHaveLength(before.notches.length)
      for (const [index, expected] of before.notches.entries()) {
        const actual = after.notches[index]
        if (!actual) throw new Error(`missing notch ${index}`)
        expect(actual.type).toBe(expected.type)
        expect(close(actual.x, expected.x, 0.1)).toBe(true)
        expect(
          close(
            station(part, actual.face, actual.y) ?? 0,
            station(part, expected.face, expected.y) ?? 0,
            0.1,
          ),
        ).toBe(true)
      }

      expect(after.marks).toHaveLength(before.marks.length)
      for (const [index, expected] of before.marks.entries()) {
        const actual = after.marks[index]
        if (!actual) throw new Error(`missing mark ${index}`)
        expect(actual.kind).toBe(expected.kind)
        expect(actual.block ?? null).toBe(expected.block ?? null)
        expect(actual.text?.value).toBe(expected.text?.value)
        expect(actual.points).toHaveLength(expected.points.length)
        for (const [pointIndex, point] of expected.points.entries()) {
          const other = actual.points[pointIndex] as [number, number]
          expect(
            close(
              station(part, actual.face, other[1]) ?? 0,
              station(part, expected.face, point[1]) ?? 0,
              0.1,
            ),
          ).toBe(true)
          expect(close(other[0], point[0], 0.1)).toBe(true)
        }
      }
    })
  }
})
