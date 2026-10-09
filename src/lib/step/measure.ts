import { ensureOc } from './occInit'

/**
 * Measures a STEP file's bounding-box extents (mm), for validating that a part model
 * matches its expected size. Uses the shared OpenCASCADE kernel (lazy-loaded).
 */
export async function measureStepBounds(bytes: Uint8Array): Promise<[number, number, number]> {
  await ensureOc()
  const { importSTEP } = await import('replicad')
  const shape = await importSTEP(new Blob([new Uint8Array(bytes)], { type: 'model/step' }))
  const bounds = (shape as unknown as { boundingBox: { bounds: [number[], number[]] } }).boundingBox
    .bounds
  const [min, max] = bounds
  return [max[0] - min[0], max[1] - min[1], max[2] - min[2]]
}

export interface SizeCheck {
  ok: boolean
  note: string
}

/**
 * Compares measured bounding-box extents to an expected part length and cross-section.
 * Orientation-agnostic: the longest extent is taken as the length, the other two matched
 * to the cross-section dims in either order.
 */
export function compareSize(
  measured: [number, number, number],
  expectedLength: number,
  expectedCross: number[],
): SizeCheck {
  const lengthTol = Math.max(3, expectedLength * 0.02)
  const crossTol = Math.max(2, 0.03)

  const sorted = [...measured].sort((a, b) => b - a)
  const length = sorted[0]
  const cross = [sorted[1], sorted[2]]
  const expected = expectedCross.slice(0, 2).sort((a, b) => b - a)

  const lengthOk = Math.abs(length - expectedLength) <= lengthTol
  const crossForward =
    Math.abs(cross[0] - expected[0]) <= crossTol && Math.abs(cross[1] - expected[1]) <= crossTol
  const crossReverse =
    Math.abs(cross[0] - expected[1]) <= crossTol && Math.abs(cross[1] - expected[0]) <= crossTol
  const crossOk = crossForward || crossReverse

  const measuredText = `L${length.toFixed(0)} × ${cross[0].toFixed(0)} × ${cross[1].toFixed(0)}`
  const expectedText = `L${expectedLength.toFixed(0)} × ${expected[0].toFixed(0)} × ${expected[1].toFixed(0)}`
  const note =
    lengthOk && crossOk ? `${measuredText} ✓` : `${measuredText} vs expected ${expectedText}`

  return { ok: lengthOk && crossOk, note }
}
