/**
 * Perceptual colour spaces for authored palettes.
 *
 * Hand-picked hex colours cannot promise that two hues carry the same weight: `#34d399` and
 * `#8b5cf6` sit at very different lightness, so a green line pops off a grey STEP shell while a
 * violet line of nominally equal importance goes quiet. OKLCH fixes that — lightness and chroma
 * are independent of hue, so a palette can hold both constant and vary only the hue.
 *
 * Used by the 3D cut palette (`THICKNESS_COLORS` in `lib/parsers/ncProject.ts`), where the first
 * two thicknesses must stand out equally from the STEP rendering and from each other.
 */

/** Lightness `0…1`, chroma (`0…~0.37` in sRGB), hue in degrees `0…360`. */
export type Oklch = readonly [lightness: number, chroma: number, hue: number]

/** Encodes a linear-sRGB channel to the sRGB transfer function's 0–255 range. */
function encodeChannel(linear: number): number {
  const clamped = Math.min(1, Math.max(0, linear))
  const encoded = clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055
  return Math.round(encoded * 255)
}

/** OKLab → linear sRGB (Björn Ottosson's matrices), unclamped. */
function linearRgbFromOklab(lightness: number, a: number, b: number): [number, number, number] {
  const l_ = lightness + 0.3963377774 * a + 0.2158037573 * b
  const m_ = lightness - 0.1055613458 * a - 0.0638541728 * b
  const s_ = lightness - 0.0894841775 * a - 1.291485548 * b
  const l = l_ ** 3
  const m = m_ ** 3
  const s = s_ ** 3
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
}

function inGamut(rgb: [number, number, number]): boolean {
  return rgb.every((channel) => channel >= -1e-6 && channel <= 1 + 1e-6)
}

/**
 * Converts an OKLCH colour to a three.js `0xRRGGBB` number.
 *
 * An out-of-gamut colour is brought back by lowering its chroma (the hue and lightness, which
 * carry the readability, are kept), rather than clipping channels — clipping shifts the hue and
 * is exactly the artefact this module exists to avoid. The reduced chroma is found by bisection:
 * stepping down in coarse increments dulls a hue that only just overflows.
 */
export function oklchToHex(color: Oklch): number {
  const [lightness, chroma, hue] = color
  const radians = (hue * Math.PI) / 180
  const at = (c: number) =>
    linearRgbFromOklab(lightness, c * Math.cos(radians), c * Math.sin(radians))
  let rgb = at(chroma)
  if (!inGamut(rgb)) {
    let low = 0
    let high = chroma
    for (let i = 0; i < 16; i++) {
      const mid = (low + high) / 2
      if (inGamut(at(mid))) low = mid
      else high = mid
    }
    rgb = at(low)
  }
  const [r, g, b] = rgb.map(encodeChannel)
  return (r << 16) | (g << 8) | b
}

/** CSS `oklch()` string for a swatch that must hit the browser's own OKLCH conversion. */
export function oklchToCss([lightness, chroma, hue]: Oklch): string {
  return `oklch(${(lightness * 100).toFixed(2)}% ${chroma.toFixed(4)} ${hue.toFixed(2)})`
}
