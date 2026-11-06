/**
 * The machine, as data.
 *
 * Every job in these tools runs on one machine — 8 Star Metal Engineering's **KL-90010-T**
 * heavy-duty 5-axis CNC tube/profile laser. Machine facts (`bottomCutMaxGrams`,
 * `unmachinableDepthMm`, stock length, envelope, bevel range) live here as one typed constant
 * so checks read limits from a profile instead of hard-coding literals.
 *
 * Deliberately **no registry and no plugin interface** while there is only one machine: a
 * second machine later is just another object, not a refactor. The human source of truth —
 * envelope, provenance, caveats — is `docs/machine-kl90010t.md`, linked by {@link MachineProfile.doc}.
 *
 * Pure (no three.js / OCC), so it is unit-tested directly.
 */

export interface MachineEnvelope {
  /** Max part length in a single pass (mm). */
  maxLengthMm: number
  /** Max round tube outside diameter (mm). */
  maxRoundMm: number
  /** Max square tube side, or bounding square of a rectangle (mm). */
  maxSquareMm: number
  /** Max H/I-beam section: web/depth height × flange width (mm). */
  hBeam: { depthMm: number; flangeMm: number }
  /** Max material thickness (mm, carbon steel). */
  maxThicknessMm: number
  /** Assist-gas nozzle aperture (mm) — clears slag, and bounds how close a cut can run to a corner. */
  nozzleMm: number
}

export interface MachineBevel {
  /** Most negative bevel angle (degrees). */
  minDeg: number
  /** Most positive bevel angle (degrees). */
  maxDeg: number
}

export interface MachineLaser {
  /** Rated source power (W). Cutting power is programmed as a percentage of this. */
  ratedPowerW: number
  /** Lowest stable power the source will hold (%). Below this it cannot cut reliably. */
  minPowerPct: number
}

export interface MachineFocus {
  /**
   * Sign the controller/CAM uses for `FocusPos` relative to the physical focus
   * (+1 = positive means above the surface, −1 = inverted).
   */
  sign: 1 | -1
}

export interface MachineProfile {
  id: string
  name: string
  /** Human source of truth for this machine. */
  doc: string
  envelope: MachineEnvelope
  bevel: MachineBevel
  /** Source power + the lowest stable power percentage. */
  laser: MachineLaser
  /** How the controller/CAM labels focus position. */
  focus: MachineFocus
  /** Largest slug a bottom cut may drop without endangering the head (grams). */
  bottomCutMaxGrams: number
  /** Deepest thickness step the head can reach sweeping one face (mm). */
  unmachinableDepthMm: number
  /**
   * Cut-placement accuracy (mm, ±): how far the head may sit off the programmed cut line,
   * perpendicular to the cut. A cut that is nominally on a flat face but lands on the section's
   * corner radius within this band is a bevel with no flat escape for the slag (see
   * `cutReach.ts`).
   */
  placementToleranceMm: number
  /** Raw/stock bar length assumed when none is chosen (mm). */
  defaultStockLengthMm: number
  /** Uncut tail left at the outfeed end so the beam stays supported (mm). */
  minEndSupportMm: number
}

/** A cross-section / part size to test against an envelope (any field may be omitted). */
export interface SectionSize {
  lengthMm?: number
  /** round tube OD (mm) */
  roundMm?: number
  /** square side / rectangular bounding square (mm) */
  squareMm?: number
  hBeam?: { depthMm: number; flangeMm: number }
  thicknessMm?: number
}

/**
 * 8 Star Metal Engineering's KL-90010-T heavy-duty 5-axis CNC tube/profile laser.
 * Envelope, provenance and caveats: `docs/machine-kl90010t.md`.
 */
export const KL90010T: MachineProfile = {
  id: 'kl-90010-t',
  name: 'KL-90010-T',
  doc: 'docs/machine-kl90010t.md',
  envelope: {
    maxLengthMm: 13_500,
    maxRoundMm: 900,
    maxSquareMm: 400,
    hBeam: { depthMm: 800, flangeMm: 300 },
    maxThicknessMm: 25,
    nozzleMm: 2,
  },
  bevel: { minDeg: -45, maxDeg: 45 },
  // 12 kW source; the control will not hold a stable cut below 7% (~840 W).
  laser: { ratedPowerW: 12_000, minPowerPct: 7 },
  // The shop CAM labels focus inverted: a physical focus above the surface is a negative number.
  focus: { sign: -1 },
  bottomCutMaxGrams: 10,
  unmachinableDepthMm: 30,
  placementToleranceMm: 1,
  defaultStockLengthMm: 12_000,
  minEndSupportMm: 2_000,
}

/** The machine the workshop runs. */
export const MACHINE: MachineProfile = KL90010T

/** Whether a requested bevel / miter angle sits inside the machine's range. */
export function bevelAllowed(angleDeg: number, profile: MachineProfile = MACHINE): boolean {
  return angleDeg >= profile.bevel.minDeg && angleDeg <= profile.bevel.maxDeg
}

/** Whether a part fits the machine's single-pass length. */
export function stockLengthAllowed(lengthMm: number, profile: MachineProfile = MACHINE): boolean {
  return lengthMm <= profile.envelope.maxLengthMm
}

/** Whether a provided size fits the machine envelope (omitted fields are ignored). */
export function envelopeFits(size: SectionSize, profile: MachineProfile = MACHINE): boolean {
  const { envelope } = profile
  if (size.lengthMm !== undefined && size.lengthMm > envelope.maxLengthMm) return false
  if (size.roundMm !== undefined && size.roundMm > envelope.maxRoundMm) return false
  if (size.squareMm !== undefined && size.squareMm > envelope.maxSquareMm) return false
  if (size.thicknessMm !== undefined && size.thicknessMm > envelope.maxThicknessMm) return false
  if (size.hBeam) {
    if (size.hBeam.depthMm > envelope.hBeam.depthMm) return false
    if (size.hBeam.flangeMm > envelope.hBeam.flangeMm) return false
  }
  return true
}
