import { describe, expect, it } from 'vitest'
import { parseRotateTransform, parseSvgPath, rotatePoints, SvgPathError } from './svgPath'

describe('parseSvgPath', () => {
  it('parses absolute move/line/close', () => {
    const [subpath] = parseSvgPath('M0,0 L10,0 L10,10 Z')
    expect(subpath?.points).toEqual([
      [0, 0],
      [10, 0],
      [10, 10],
    ])
    expect(subpath?.closed).toBe(true)
  })

  it('parses relative commands and implicit line pairs after M', () => {
    const [subpath] = parseSvgPath('m0,0 10,0 0,10 z')
    expect(subpath?.points).toEqual([
      [0, 0],
      [10, 0],
      [10, 10],
    ])
    expect(subpath?.closed).toBe(true)
  })

  it('keeps scientific notation', () => {
    const [subpath] = parseSvgPath('M1.11e-14,0 L1e2,-3.5e-1')
    expect(subpath?.points[0]?.[0]).toBeCloseTo(0)
    expect(subpath?.points[1]).toEqual([100, -0.35])
  })

  it('flattens an arc and hits its endpoint', () => {
    const [subpath] = parseSvgPath('M0,0 A10,10 0 0,1 10,10')
    expect(subpath).toBeDefined()
    if (!subpath) return
    expect(subpath.points.length).toBeGreaterThan(2)
    expect(subpath.points.at(-1)?.[0]).toBeCloseTo(10)
    expect(subpath.points.at(-1)?.[1]).toBeCloseTo(10)
    for (const [x, y] of subpath.points) {
      expect(Math.hypot(x - 0, y - 10)).toBeCloseTo(10, 1)
    }
  })

  it('reads arc flags without separators', () => {
    const [subpath] = parseSvgPath('M0,0A10,10 0 0110,10')
    expect(subpath?.points.at(-1)?.[0]).toBeCloseTo(10)
    expect(subpath?.points.at(-1)?.[1]).toBeCloseTo(10)
  })

  it('rejects unsupported commands', () => {
    expect(() => parseSvgPath('M0,0 C10,0 10,10 0,10')).toThrow(SvgPathError)
  })
})

describe('rotate transforms', () => {
  it('parses rotate with a centre', () => {
    expect(parseRotateTransform('rotate(180 5,5355.12)')).toEqual({
      angle: 180,
      cx: 5,
      cy: 5355.12,
    })
  })

  it('parses rotate without a centre', () => {
    expect(parseRotateTransform('rotate(90)')).toEqual({ angle: 90, cx: 0, cy: 0 })
  })

  it('rotates a rectangle about its corner', () => {
    const points = rotatePoints(
      [
        [5, 0],
        [155, 0],
      ],
      180,
      5,
      0,
    )
    expect(points[0]?.[0]).toBeCloseTo(5, 9)
    expect(points[1]?.[0]).toBeCloseTo(-145, 9)
    expect(points[0]?.[1]).toBeCloseTo(0, 9)
    expect(points[1]?.[1]).toBeCloseTo(0, 9)
  })
})
