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
  /** volume (mm³) of the main (largest-volume) solid body */
  volume: number
}

type Bounds = { bounds: [number[], number[]] }
type AnyShapeish = {
  boundingBox: Bounds
  solids: { boundingBox: Bounds }[]
  delete: () => void
}

/** The minimum a shape must expose to be measured — an already-imported OCC shape. */
export interface MeasurableShape {
  boundingBox: Bounds
  solids: { boundingBox: Bounds }[]
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
  const { importSTEP } = await import('replicad')
  const shape = (await importSTEP(
    new Blob([new Uint8Array(bytes)], { type: 'model/step' }),
  )) as unknown as AnyShapeish
  try {
    return await measureShape(shape)
  } finally {
    shape.delete()
  }
}

/**
 * Measures an already-imported OCC shape. Split out from {@link measureStep} so a worker can
 * import a STEP once and reuse the same shape for several checks (measure + light-sabre).
 */
export async function measureShape(shape: MeasurableShape): Promise<StepMeasure> {
  const { measureVolume } = await import('replicad')
  const whole = extents(shape.boundingBox)
  const solids = shape.solids
  if (solids.length === 0) return { size: whole, bodies: 0, extra: false, volume: 0 }

  // Rank solids by bounding-box volume (a Bnd_Box pass, no surface integration) and only run the
  // expensive exact volume on candidates that can still win: a solid's true volume never exceeds
  // its bounding-box volume, so anything at or below the best exact volume so far is out. This
  // returns exactly what measuring every solid would — usually with a single GProp call.
  const ranked = solids
    .map((solid) => {
      const size = extents(solid.boundingBox)
      return { solid, size, boxVolume: size[0] * size[1] * size[2] }
    })
    .sort((a, b) => b.boxVolume - a.boxVolume)
  let main = ranked[0]
  let largest = measureVolume(main.solid as never)
  for (const candidate of ranked.slice(1)) {
    if (!(candidate.boxVolume > largest)) break
    const volume = measureVolume(candidate.solid as never)
    if (volume > largest) {
      largest = volume
      main = candidate
    }
  }
  const size = main.size
  return {
    size,
    bodies: solids.length,
    extra: solids.length > 1 || growsBeyond(whole, size),
    volume: largest,
  }
}

export interface SizeCheck {
  ok: boolean
  /** number of solid bodies (1 = clean single part) */
  bodies?: number
  /** the model carries extra floating body/bodies */
  stray?: boolean
  /** measured `[length, crossA, crossB]` (length first); absent when not measurable */
  measured?: [number, number, number]
  /** expected `[length, crossA, crossB]` (length first) */
  expected?: [number, number, number]
  /**
   * Why the check could not run, or how it ran — the UI localises this. `stepOnly` means there was
   * no expected size to compare against (no NC / drawing / part list), so the measured STEP size
   * stands in for the model size on its own. `ncOnly` is the mirror: no STEP to measure, so the
   * nominal size is read from the NC header instead.
   */
  error?: 'noDims' | 'measureFailed' | 'stepOnly' | 'ncOnly'
}

/**
 * The STEP-only size: no expected dims to compare against, so the check just reports what the
 * STEP measures (extents sorted length-first, matching {@link compareSize}). Drives the "model
 * size" column for a job that ships no NC / drawing / part-list size.
 */
export function stepOnlySizeCheck(measure: StepMeasure): SizeCheck {
  return {
    ok: false,
    error: 'stepOnly',
    measured: [...measure.size].sort((a, b) => b - a) as [number, number, number],
    bodies: measure.bodies,
    stray: measure.extra,
  }
}

/**
 * The NC-only size: there is no STEP to measure, so the part's nominal size is read straight from
 * the NC header — the member length plus the two cross-section dimensions (extents sorted
 * length-first, matching {@link stepOnlySizeCheck}). This is the mirror of {@link stepOnlySizeCheck}
 * for a job that ships no STEP files, so the "model size" column still shows a size. Returns `null`
 * when the NC carries no usable dims, so the caller can fall back to "no dims".
 */
export function ncOnlySizeCheck(length: number, dims: number[]): SizeCheck | null {
  const cross = dims.filter((value) => Number.isFinite(value) && value > 0).slice(0, 2)
  if (!(length > 0) || cross.length < 2) return null
  return {
    ok: false,
    error: 'ncOnly',
    measured: [length, cross[0], cross[1]].sort((a, b) => b - a) as [number, number, number],
  }
}

/**
 * Compares measured bounding-box extents to an expected part length and cross-section.
 * Orientation-agnostic: the longest extent is taken as the length, the other two matched
 * to the cross-section dims in either order. `bodies`/`extra` annotate multi-body models.
 * Returns raw extents so the UI can format and localise the note.
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

  return {
    ok: lengthOk && crossOk,
    bodies,
    stray: extra,
    measured: [length, cross[0], cross[1]],
    expected: [expectedLength, expected[0], expected[1]],
  }
}

export interface ModelComparison {
  ok: boolean
  sizeOk: boolean
  volumeOk: boolean
  /** measured `[a, b, c]` extents, largest first */
  size?: [number, number, number]
  /** reference (STEP) `[a, b, c]` extents, largest first */
  referenceSize?: [number, number, number]
  /** relative volume difference of `other` vs `reference` */
  volumeDelta: number
}

/**
 * Checks whether a model (e.g. the NC-built "manufactured" geometry) matches a reference
 * (the STEP export), by bounding-box size and volume. Orientation-agnostic: the extents are
 * sorted largest-first before matching, so a part seated differently still lines up.
 * Returns raw numbers so the UI can format and localise the note.
 */
export function compareModels(reference: StepMeasure, other: StepMeasure): ModelComparison {
  const ref = [...reference.size].sort((a, b) => b - a)
  const got = [...other.size].sort((a, b) => b - a)
  const sizeOk = ref.every((value, index) => {
    const tol = Math.max(3, value * 0.02)
    return Math.abs(value - got[index]) <= tol
  })
  const volRef = reference.volume
  const volumeDelta = volRef > 0 ? (other.volume - volRef) / volRef : 0
  // The NC rebuild omits end-arc radii, so allow a few percent slack before calling it a mismatch.
  const volumeOk = Math.abs(volumeDelta) <= 0.05
  return {
    ok: sizeOk && volumeOk,
    sizeOk,
    volumeOk,
    size: got as [number, number, number],
    referenceSize: ref as [number, number, number],
    volumeDelta,
  }
}

/** Density of steel (kg/mm³): 7850 kg/m³ = 7.85 g/cm³. */
export const STEEL_DENSITY_KG_PER_MM3 = 7.85e-6

/** Relative slack allowed between the drawing's WEIGHT and the STEP — export/rounding noise. */
const GEOMETRY_TOLERANCE_REL = 0.05

export interface GeometryCheck {
  ok: boolean
  /** density-derived mass (kg) */
  mass: number
  /** drawing mass (kg), when the drawing carried one */
  expectedMass?: number
  /** the mass cross-check passed (or was skipped) */
  massOk: boolean
}

function withinTolerance(measured: number, expected: number): boolean {
  return Math.abs(measured - expected) <= expected * GEOMETRY_TOLERANCE_REL
}

/**
 * Cross-checks a STEP's geometry against the drawing's title-block WEIGHT. Tekla derives it from
 * the real solid, so a matching mass proves holes/cuts/mitres agree without any view alignment.
 *
 * The drawing also carries an AREA column, but Tekla reports the *outer/exposed* surface there,
 * whereas the kernel measures the total boundary surface (outer + inner walls). The two agree for
 * solid profiles but diverge ~1.9× for hollow ones (RHS/SHS/CHS), so area is not compared.
 * Volume tracks the material exactly and already catches any real geometry drift.
 */
export function compareGeometry(
  measured: Pick<StepMeasure, 'volume'>,
  drawing: { weight?: number },
): GeometryCheck {
  const mass = measured.volume * STEEL_DENSITY_KG_PER_MM3
  const massOk = drawing.weight == null || withinTolerance(mass, drawing.weight)
  return {
    ok: massOk,
    mass,
    expectedMass: drawing.weight,
    massOk,
  }
}
