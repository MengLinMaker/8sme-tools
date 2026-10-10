import { ensureOc } from './occInit'

/**
 * Measures a STEP model's main body, for validating that a part matches its expected size.
 * Uses the shared OpenCASCADE kernel (lazy-loaded).
 */
export interface StepMeasure {
  /** bounding-box extents (mm) of the main (largest-volume) solid body */
  size: [number, number, number]
  /** number of solid bodies in the model */
  bodies: number
  /** the model's whole bounding box is bigger than the main body — a stray body/surface exists */
  extra: boolean
}

type Bounds = { bounds: [number[], number[]] }
type AnyShapeish = {
  boundingBox: Bounds
  solids: { boundingBox: Bounds }[]
  delete: () => void
}

function extents(box: Bounds): [number, number, number] {
  const [min, max] = box.bounds
  return [max[0] - min[0], max[1] - min[1], max[2] - min[2]]
}

function growsBeyond(whole: [number, number, number], main: [number, number, number]): boolean {
  return whole.some((value, index) => value > main[index] + Math.max(2, main[index] * 0.02))
}

export async function measureStep(bytes: Uint8Array): Promise<StepMeasure> {
  await ensureOc()
  const { importSTEP, measureVolume } = await import('replicad')
  const shape = (await importSTEP(
    new Blob([new Uint8Array(bytes)], { type: 'model/step' }),
  )) as unknown as AnyShapeish
  try {
    const whole = extents(shape.boundingBox)
    const solids = shape.solids
    if (solids.length === 0) return { size: whole, bodies: 0, extra: false }

    let main = solids[0]
    let largest = measureVolume(main as never)
    for (const solid of solids.slice(1)) {
      const volume = measureVolume(solid as never)
      if (volume > largest) {
        largest = volume
        main = solid
      }
    }
    const size = extents(main.boundingBox)
    return { size, bodies: solids.length, extra: solids.length > 1 || growsBeyond(whole, size) }
  } finally {
    shape.delete()
  }
}

export interface SizeCheck {
  ok: boolean
  note: string
}

/**
 * Compares measured bounding-box extents to an expected part length and cross-section.
 * Orientation-agnostic: the longest extent is taken as the length, the other two matched
 * to the cross-section dims in either order. `bodies`/`extra` annotate multi-body models.
 */
export function compareSize(
  measured: [number, number, number],
  expectedLength: number,
  expectedCross: number[],
  bodies = 1,
  extra = false,
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
  const bodyText =
    bodies === 1 && !extra
      ? ''
      : ` · ${bodies} ${bodies === 1 ? 'body' : 'bodies'}${extra ? ' + stray' : ''}`
  const note =
    (lengthOk && crossOk ? `${measuredText} ✓` : `${measuredText} vs expected ${expectedText}`) +
    bodyText

  return { ok: lengthOk && crossOk, note }
}
