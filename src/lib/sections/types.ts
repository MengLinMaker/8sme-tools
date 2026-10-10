/**
 * A hot-rolled structural section from an AS/NZS 3679.1 family — Universal Beam (UB),
 * Universal Column (UC), Parallel Flange Channel (PFC), Taper Flange Beam (TFB) — etc.
 *
 * `b` is the flange width for UB/UC/TFB and the overall flange width for a PFC.
 */
export interface RolledSection {
  /** e.g. "200UB29.8", "310UC158", "150 PFC", "125 TFB" */
  designation: string
  /** kg per metre */
  mass: number
  /** overall depth d (mm) */
  d: number
  /** flange width b / bf (mm) */
  b: number
  /** flange thickness tf (mm) */
  tf: number
  /** web thickness tw (mm) */
  tw: number
  /** root radius r (mm), where known */
  r?: number
}
