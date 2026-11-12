/**
 * Suggested O₂ cut parameters for carbon steel.
 *
 * The shop cuts structural carbon steel with **oxygen by default**; nitrogen is reserved for
 * stainless, so there is one gas strategy here. The table is seeded from published 12 kW O₂
 * charts and scaled 6 kW O₂ rows (3–8 mm), **not** from a shop-maintained override — the intent
 * is to show what repeated tests say, then let the operator verify a suggestion visually.
 *
 * Power is a percentage of `MachineProfile.laser.ratedPowerW` (12 kW), clamped to the source's
 * minimum stable percentage. Focus is stored **physically** (positive = above the surface) and
 * flipped to the controller's sign at {@link suggestCut}'s output.
 *
 * Pure (no three.js / OCC), so it is unit-tested directly.
 */

import { MACHINE, type MachineProfile } from './profile'

/** Surface condition of the incoming stock. */
export type SurfaceCondition = 'normal' | 'rust' | 'primed' | 'galvanised'

/** Cut regime: the normal recipe, or the wide-kerf mirror window. */
export type CutRegime = 'normal' | 'mirror'

/** Weld-prep bevel presets (degrees off square), including the default square cut. */
export const BEVEL_PRESETS_DEG = [0, 15, 30, 45] as const

/**
 * Thickness the beam actually traverses on a bevel cut: `t / cos θ`.
 *
 * A 0° cut is the square wall; a 45° bevel cuts a ≈1.41× longer path, so speed, focus and power
 * follow the effective thickness rather than the nominal plate.
 */
export function bevelThicknessMm(thicknessMm: number, bevelDeg: number): number {
  if (!(thicknessMm > 0) || !Number.isFinite(bevelDeg)) return thicknessMm
  const angle = Math.min(Math.abs(bevelDeg), 89)
  return thicknessMm / Math.cos((angle * Math.PI) / 180)
}

/** Where a row sits in the source data. */
export interface CutSource {
  /** Human-readable provenance, shown next to the suggestion. */
  label: string
}

/** One measured/estimated point on the O₂ thickness curve. */
export interface CutRecipe {
  thicknessMm: number
  powerPct: number
  speedMinMmMin: number
  speedMaxMmMin: number
  /** Physical focus: positive = above the surface (mm). */
  focusMm: number
  /** Nozzle standoff / following height (mm). */
  heightMm: number
  pressureBar: number
  frequencyHz: number
  dutyPct: number
  source: string
}

/** Nozzle the shop fits for this cut. */
export interface CutNozzle {
  sizeMm: number
  type: 'single' | 'double'
}

/** Extra context the suggestion needs to pick a nozzle / rotary speed. */
export interface CutOptions {
  /** Open section (UB/PFC/T/angle) or hollow (SHS/RHS/CHS). */
  kind?: 'open' | 'hollow'
  /** Distance from the rotary axis to the reference outer surface (mm). */
  rotationRadiusMm?: number
  /** Largest thickness in the section; the shop fits one nozzle per section. */
  governingThicknessMm?: number
  /** `mirror` selects the wide-kerf, high-focus window for open sections. */
  regime?: CutRegime
  /** Optional severance-energy target; when set, speed is derived from S, power and thickness. */
  targetSeveranceJPerMm2?: number
  /** Optional speed target for the selected thickness (paired with the severance target). */
  targetSpeedMmMin?: number
}

/** A suggestion ready for display / for the `Technology.xml` fields. */
export interface CutSuggestion extends CutRecipe {
  /** The `FocusPos` value to enter in the shop CAM (physical focus × machine sign). */
  camFocusMm: number
  /** Shop nozzle for this cut, when the section kind is known. */
  nozzle: CutNozzle | null
  /** Equivalent rotary speed range at `rotationRadiusMm` (r/min), when known. */
  angularSpeedMinRpm: number | null
  angularSpeedMaxRpm: number | null
  /** Which regime this row came from. */
  regime: CutRegime
  /** Adjustments / caveats applied on top of the base row. */
  notes: string[]
}

const O2_CARBON: CutRecipe[] = [
  // 3–8 mm: conventional O₂, power scaled from the 6 kW chart onto the 12 kW source.
  {
    thicknessMm: 3,
    powerPct: 20,
    speedMinMmMin: 3.5,
    speedMaxMmMin: 4.2,
    focusMm: 3,
    heightMm: 0.8,
    pressureBar: 0.7,
    frequencyHz: 5000,
    dutyPct: 100,
    source: 'GWEIKE 6 kW O₂ (scaled)',
  },
  {
    thicknessMm: 4,
    powerPct: 20,
    speedMinMmMin: 3.3,
    speedMaxMmMin: 3.8,
    focusMm: 3,
    heightMm: 0.8,
    pressureBar: 0.7,
    frequencyHz: 5000,
    dutyPct: 100,
    source: 'GWEIKE 6 kW O₂ (scaled)',
  },
  {
    thicknessMm: 5,
    powerPct: 25,
    speedMinMmMin: 3.0,
    speedMaxMmMin: 3.6,
    focusMm: 4,
    heightMm: 0.8,
    pressureBar: 0.7,
    frequencyHz: 5000,
    dutyPct: 100,
    source: 'GWEIKE 6 kW O₂ (scaled)',
  },
  {
    thicknessMm: 6,
    powerPct: 28,
    speedMinMmMin: 2.7,
    speedMaxMmMin: 3.2,
    focusMm: 4,
    heightMm: 0.8,
    pressureBar: 0.7,
    frequencyHz: 5000,
    dutyPct: 100,
    source: 'GWEIKE 6 kW O₂ (scaled)',
  },
  {
    thicknessMm: 8,
    powerPct: 35,
    speedMinMmMin: 2.2,
    speedMaxMmMin: 2.5,
    focusMm: 4,
    heightMm: 0.8,
    pressureBar: 0.7,
    frequencyHz: 5000,
    dutyPct: 100,
    source: 'GWEIKE 6 kW O₂ (scaled)',
  },
  // 10–25 mm: explicit 12 kW O₂ rows.
  {
    thicknessMm: 10,
    powerPct: 50,
    speedMinMmMin: 2.0,
    speedMaxMmMin: 2.3,
    focusMm: 6,
    heightMm: 0.8,
    pressureBar: 0.6,
    frequencyHz: 5000,
    dutyPct: 100,
    source: 'SBM 12 kW O₂',
  },
  {
    thicknessMm: 12,
    powerPct: 63,
    speedMinMmMin: 1.9,
    speedMaxMmMin: 2.1,
    focusMm: 7,
    heightMm: 0.8,
    pressureBar: 0.6,
    frequencyHz: 5000,
    dutyPct: 100,
    source: 'SBM 12 kW O₂',
  },
  {
    thicknessMm: 14,
    powerPct: 71,
    speedMinMmMin: 1.7,
    speedMaxMmMin: 1.9,
    focusMm: 7,
    heightMm: 0.8,
    pressureBar: 0.6,
    frequencyHz: 5000,
    dutyPct: 100,
    source: 'SBM 12 kW O₂',
  },
  {
    thicknessMm: 16,
    powerPct: 79,
    speedMinMmMin: 1.5,
    speedMaxMmMin: 1.7,
    focusMm: 8,
    heightMm: 0.8,
    pressureBar: 0.6,
    frequencyHz: 5000,
    dutyPct: 100,
    source: 'SBM 12 kW O₂',
  },
  {
    thicknessMm: 18,
    powerPct: 88,
    speedMinMmMin: 1.4,
    speedMaxMmMin: 1.6,
    focusMm: 8,
    heightMm: 0.8,
    pressureBar: 0.6,
    frequencyHz: 5000,
    dutyPct: 100,
    source: 'interpolated 16–20 mm',
  },
  {
    thicknessMm: 20,
    powerPct: 100,
    speedMinMmMin: 1.3,
    speedMaxMmMin: 1.5,
    focusMm: 8,
    heightMm: 0.8,
    pressureBar: 0.6,
    frequencyHz: 5000,
    dutyPct: 100,
    source: 'SBM 12 kW O₂',
  },
  {
    thicknessMm: 22,
    powerPct: 100,
    speedMinMmMin: 1.1,
    speedMaxMmMin: 1.3,
    focusMm: 11,
    heightMm: 0.5,
    pressureBar: 0.7,
    frequencyHz: 5000,
    dutyPct: 100,
    source: 'SBM 12 kW O₂',
  },
  {
    thicknessMm: 25,
    powerPct: 100,
    speedMinMmMin: 0.85,
    speedMaxMmMin: 1.05,
    focusMm: 12,
    heightMm: 0.5,
    pressureBar: 0.7,
    frequencyHz: 5000,
    dutyPct: 100,
    source: 'SBM 12 kW O₂',
  },
]

// Shop point for the open-section mirror window (150UB14 web, 5 mm).
// 9 mm is the measured good focus; below ~8 mm the cut loses stability.
const MIRROR_OPEN_5MM: CutRecipe = {
  thicknessMm: 5,
  powerPct: 28,
  speedMinMmMin: 3.0,
  speedMaxMmMin: 3.0,
  focusMm: 9,
  heightMm: 0.8,
  pressureBar: 0.7,
  frequencyHz: 5000,
  dutyPct: 100,
  source: 'shop mirror regime (5 mm, focus 9)',
}

interface SurfaceAdjustment {
  /** Extra physical focus (mm) — more positive for uneven/coated surfaces. */
  focusMm: number
  /** Speed multiplier. */
  speed: number
  /** Extra O₂ pressure (bar). */
  pressureBar: number
  note: string | null
}

const SURFACE: Record<SurfaceCondition, SurfaceAdjustment> = {
  normal: { focusMm: 0, speed: 1, pressureBar: 0, note: null },
  rust: {
    focusMm: 1.5,
    speed: 0.85,
    pressureBar: 0.05,
    note: 'Rust: focus +1.5 mm, speed −15%; the height sensor may read the scale, not the steel.',
  },
  primed: {
    focusMm: 1,
    speed: 0.9,
    pressureBar: 0,
    note: 'Primed/painted SHS: run a CUTFILM pass first; focus +1 mm, speed −10%.',
  },
  galvanised: {
    focusMm: 1,
    speed: 0.85,
    pressureBar: 0.05,
    note: 'Galvanised: O₂ tends to dross on the zinc; N₂ is the clean option.',
  },
}

const MIN_THICKNESS_MM = O2_CARBON[0]?.thicknessMm ?? 3
const MAX_THICKNESS_MM = O2_CARBON[O2_CARBON.length - 1]?.thicknessMm ?? 25

const round1 = (value: number) => Math.round(value * 10) / 10
const round2 = (value: number) => Math.round(value * 100) / 100

/** Linear interpolation between the two bracketing table rows. */
function interpolateRow(thicknessMm: number): CutRecipe {
  const first = O2_CARBON[0] as CutRecipe
  const last = O2_CARBON[O2_CARBON.length - 1] as CutRecipe
  if (thicknessMm <= first.thicknessMm) return first
  if (thicknessMm >= last.thicknessMm) return last

  for (let index = 1; index < O2_CARBON.length; index++) {
    const high = O2_CARBON[index] as CutRecipe
    const low = O2_CARBON[index - 1] as CutRecipe
    if (thicknessMm > high.thicknessMm) continue
    const span = high.thicknessMm - low.thicknessMm
    const t = span > 0 ? (thicknessMm - low.thicknessMm) / span : 0
    const mix = (a: number, b: number) => a + (b - a) * t
    return {
      thicknessMm,
      powerPct: mix(low.powerPct, high.powerPct),
      speedMinMmMin: mix(low.speedMinMmMin, high.speedMinMmMin),
      speedMaxMmMin: mix(low.speedMaxMmMin, high.speedMaxMmMin),
      focusMm: mix(low.focusMm, high.focusMm),
      heightMm: mix(low.heightMm, high.heightMm),
      pressureBar: mix(low.pressureBar, high.pressureBar),
      frequencyHz: high.frequencyHz,
      dutyPct: high.dutyPct,
      source: `${low.source} ↔ ${high.source}`,
    }
  }
  return last
}

/**
 * Suggests O₂ parameters for a carbon-steel wall/flange thickness.
 *
 * Values are interpolated between published rows; focus is returned in the shop CAM's sign
 * (`camFocusMm`) as well as physically (`focusMm`). The operator is expected to verify a
 * suggestion on a scrap cut — this is a starting point, not a guarantee.
 */
export function suggestCut(
  thicknessMm: number,
  surface: SurfaceCondition = 'normal',
  profile: MachineProfile = MACHINE,
  options: CutOptions = {},
): CutSuggestion {
  const notes: string[] = []
  let wanted = thicknessMm
  if (!Number.isFinite(wanted) || wanted <= 0) wanted = MIN_THICKNESS_MM
  if (wanted < MIN_THICKNESS_MM) {
    notes.push(`Thinner than the ${MIN_THICKNESS_MM} mm table floor — using that row.`)
    wanted = MIN_THICKNESS_MM
  }
  if (wanted > MAX_THICKNESS_MM) {
    notes.push(`Thicker than the ${MAX_THICKNESS_MM} mm table ceiling — using that row.`)
    wanted = MAX_THICKNESS_MM
  }

  const mirror = options.regime === 'mirror'
  const shopMirrorPoint = mirror && Math.abs(wanted - 5) <= 0.8
  const base = shopMirrorPoint ? MIRROR_OPEN_5MM : interpolateRow(wanted)
  const adjust = mirror ? SURFACE.normal : SURFACE[surface]
  if (adjust.note) notes.push(adjust.note)
  if (mirror) {
    notes.push(
      shopMirrorPoint
        ? 'Mirror regime: measured 5 mm open-section point; physical focus 9 mm (CAM −9).'
        : 'Mirror regime: provisional wide-focus setting; power/speed follow the normal row.',
    )
  }

  const physicalFocus = mirror ? 9 + Math.max(0, wanted - 5) * 0.5 : base.focusMm + adjust.focusMm
  const { minPowerPct, ratedPowerW } = profile.laser
  let powerPct = Math.min(100, Math.max(minPowerPct, Math.round(base.powerPct)))
  let speedMin = round1(base.speedMinMmMin * adjust.speed)
  let speedMax = round1(base.speedMaxMmMin * adjust.speed)

  const targetS = options.targetSeveranceJPerMm2
  const targetSpeed = options.targetSpeedMmMin
  if (targetS && targetS > 0 && targetSpeed && targetSpeed > 0) {
    speedMin = round1(targetSpeed)
    speedMax = speedMin
    const powerW = (targetS * targetSpeed * wanted) / 0.06
    powerPct = Math.min(100, Math.max(minPowerPct, Math.round((powerW / ratedPowerW) * 100)))
  } else if (targetS && targetS > 0) {
    const speed = (0.06 * ((powerPct / 100) * ratedPowerW)) / (targetS * wanted)
    speedMin = round1(speed)
    speedMax = speedMin
  }

  notes.push(
    `${powerPct}% of ${(ratedPowerW / 1000).toFixed(0)} kW ≈ ${round1((powerPct / 100) * (ratedPowerW / 1000))} kW.`,
  )
  notes.push('Speed is the quality lever: start at the low end of the range.')
  notes.push('Source values are published O₂ charts — verify on scrap before a production run.')

  // Shop nozzle rule: one nozzle per section, sized by the largest thickness —
  // 1.5 single ≤15 mm, 2.0 single >15 mm for open sections; 1.8 double for hollow sections.
  const nozzleThickness = options.governingThicknessMm ?? wanted
  const nozzle: CutNozzle | null =
    options.kind === 'hollow'
      ? { sizeMm: 1.8, type: 'double' }
      : options.kind === 'open'
        ? {
            sizeMm: mirror
              ? MIRROR_OPEN_5MM.focusMm > 15
                ? 2.0
                : 1.5
              : nozzleThickness <= 15
                ? 1.5
                : 2.0,
            type: 'single',
          }
        : null

  const radiusM = options.rotationRadiusMm ? options.rotationRadiusMm / 1000 : 0
  const angularSpeedMinRpm = radiusM > 0 ? round1(speedMin / (2 * Math.PI * radiusM)) : null
  const angularSpeedMaxRpm = radiusM > 0 ? round1(speedMax / (2 * Math.PI * radiusM)) : null

  return {
    ...base,
    thicknessMm: round1(wanted),
    powerPct,
    speedMinMmMin: speedMin,
    speedMaxMmMin: speedMax,
    focusMm: round1(physicalFocus),
    camFocusMm: round1(physicalFocus * profile.focus.sign),
    heightMm: round2(base.heightMm),
    pressureBar: round2(mirror ? 0.7 : base.pressureBar + adjust.pressureBar),
    nozzle,
    angularSpeedMinRpm,
    angularSpeedMaxRpm,
    regime: mirror ? 'mirror' : 'normal',
    notes,
  }
}

/** The thickness band the published table covers. */
export const CUT_TABLE_RANGE_MM = { min: MIN_THICKNESS_MM, max: MAX_THICKNESS_MM } as const
