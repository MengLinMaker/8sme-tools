import { describe, expect, it } from 'vitest'
import { oklchToCss, oklchToHex } from './colour'

describe('oklchToHex', () => {
  it('matches the sRGB hex the palette tokens are based on', () => {
    // oklch(0.7729 0.1535 163.22) is Tailwind's emerald-400 (#34d399).
    expect(oklchToHex([0.7729, 0.1535, 163.22])).toBe(0x34d399)
    expect(oklchToHex([0.7686, 0.1647, 70.08])).toBe(0xf59e0b)
  })

  it('keeps equal lightness and chroma while the hue changes', () => {
    const green = oklchToHex([0.7729, 0.1535, 163.22])
    const purple = oklchToHex([0.7729, 0.1535, 305])
    expect(purple).not.toBe(green)
    // oklch(0.7729 0.1535 305) is #cc9aff; the violet sits a hair outside sRGB, so the chroma
    // trim lands one red step under it rather than several shades duller.
    const channels = (hex: number) => [(hex >> 16) & 0xff, (hex >> 8) & 0xff, hex & 0xff]
    for (const [actual, expected] of channels(purple).map((value, i) => [
      value,
      channels(0xcc9aff)[i] as number,
    ])) {
      expect(Math.abs(actual - expected)).toBeLessThanOrEqual(2)
    }
  })

  it('brings an out-of-gamut colour back by dropping chroma, not clipping channels', () => {
    const hex = oklchToHex([0.6, 0.4, 30])
    const channels = [(hex >> 16) & 0xff, (hex >> 8) & 0xff, hex & 0xff]
    for (const channel of channels) expect(channel).toBeGreaterThanOrEqual(0)
    for (const channel of channels) expect(channel).toBeLessThanOrEqual(255)
    // Still a warm red-orange: clipping would drag the hue toward magenta or yellow.
    expect(channels[0]).toBeGreaterThan(channels[1])
    expect(channels[1]).toBeGreaterThan(channels[2])
  })
})

describe('oklchToCss', () => {
  it('writes a CSS oklch() from the same triplet', () => {
    expect(oklchToCss([0.7729, 0.1535, 305])).toBe('oklch(77.29% 0.1535 305.00)')
  })
})
