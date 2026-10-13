import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { nw31Top } from '@test/fixtures'
import { type BufferGeometry, Matrix4 } from 'three'
import { describe, expect, it } from 'vitest'
import { alignToReference, MIN_SOLID_THICKNESS_MM, occFuzzyDiff } from './occDiff'
import { setOcWasmUrl } from './occInit'
import { reconstructStepFromNc } from './reconstructFromNc'

const require = createRequire(import.meta.url)
setOcWasmUrl(require.resolve('replicad-opencascadejs/wasm'))

const IDENTITY = new Matrix4()
const NC = nw31Top('NC files')
const STP = nw31Top('STP files')
const HAVE = existsSync(join(NC, 'm180.nc1')) && existsSync(join(STP, 'm180.stp'))

/** Implied wall thickness (2·V/A): a thin shell's thickness, a chunky solid's ≈ side/3. */
function impliedThicknessMm(volume: number, geometry: BufferGeometry): number {
  const position = geometry.getAttribute('position')
  const v = position.array as Float32Array
  let area = 0
  for (let t = 0; t < Math.floor(position.count / 3); t++) {
    const o = t * 9
    const ux = (v[o + 3] ?? 0) - (v[o] ?? 0)
    const uy = (v[o + 4] ?? 0) - (v[o + 1] ?? 0)
    const uz = (v[o + 5] ?? 0) - (v[o + 2] ?? 0)
    const wx = (v[o + 6] ?? 0) - (v[o] ?? 0)
    const wy = (v[o + 7] ?? 0) - (v[o + 1] ?? 0)
    const wz = (v[o + 8] ?? 0) - (v[o + 2] ?? 0)
    area += Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx) / 2
  }
  return area > 0 ? (2 * volume) / area : Number.POSITIVE_INFINITY
}

/**
 * Regression guard for the **thin-skin membrane**: on m180 the largest sane fuzzy (1 mm) cut `ideal −
 * made` to a ~0.035 mm, whole-part shell — 391,000 mm² of surface for only 6,900 mm³ — so the
 * volume-based sanity checks passed it straight through and the viewer painted a red skin over the
 * part. The `MIN_SOLID_THICKNESS_MM` gate makes the scan skip that fuzzy for `f = 0.2`, which agrees
 * with the independent surface probe (over ≈ 13,773 vs 13,745 mm³) and leaves real material.
 */
describe.skipIf(!HAVE)('occ fuzzy diff leaves no thin-skin membrane (m180)', () => {
  it('does not cut to a full-length sub-thickness shell', async () => {
    const ncText = readFileSync(join(NC, 'm180.nc1'), 'utf8')
    const stepBytes = new Uint8Array(readFileSync(join(STP, 'm180.stp')))
    const step = await reconstructStepFromNc(ncText)
    expect(step).toBeTruthy()
    if (!step) return
    const madeBytes = new TextEncoder().encode(step)

    const compareMatrix = await alignToReference(stepBytes, madeBytes)
    const diff = await occFuzzyDiff(madeBytes, stepBytes, IDENTITY, compareMatrix)
    expect(diff).not.toBeNull()
    if (!diff) return
    expect(diff.over).not.toBeNull()
    expect(diff.under).not.toBeNull()
    if (!diff.over || !diff.under) return

    const overThickness = impliedThicknessMm(diff.overVolume, diff.over)
    const underThickness = impliedThicknessMm(diff.underVolume, diff.under)
    console.log(
      `[m180 skin guard] over ${diff.overVolume.toFixed(0)} mm³ · t≈${overThickness.toFixed(2)} mm | ` +
        `under ${diff.underVolume.toFixed(0)} mm³ · t≈${underThickness.toFixed(2)} mm`,
    )
    // Both solids must be real material, not a near-coincident membrane.
    expect(overThickness).toBeGreaterThan(MIN_SOLID_THICKNESS_MM)
    expect(underThickness).toBeGreaterThan(MIN_SOLID_THICKNESS_MM)
  }, 300000)
})
