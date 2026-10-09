export interface UbSection {
  /** e.g. "200UB29.8" */
  designation: string
  /** kg per metre */
  mass: number
  /** overall depth d (mm) */
  d: number
  /** flange width b (mm) */
  b: number
  /** flange thickness tf (mm) */
  tf: number
  /** web thickness tw (mm) */
  tw: number
  /** root radius r (mm), where known */
  r?: number
}
