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

/**
 * A hot-rolled angle (EA/UA) from AS/NZS 3679.1 (Grade 300), or its mill-catalogue entry.
 *
 * Unlike an I-section an angle is not fully described by an overall size — it also has a
 * **root radius** `r1` (the inner fillet) and a **toe radius** `r2` (the round on each leg's
 * free end). The designation thickness is nominal; the rolled `t` differs slightly.
 */
export interface RolledAngle {
  /** equal (EA) or unequal (UA) angle */
  kind: 'EA' | 'UA'
  /** longer leg A (mm) */
  a: number
  /** shorter leg B (mm); equals `a` for an equal angle */
  b: number
  /** nominal thickness as designated (mm), e.g. 10 for `x10EA` */
  tNom: number
  /** actual rolled thickness t (mm), e.g. 9.5 for the nominal 10 */
  t: number
  /** root (inner fillet) radius R1 (mm) */
  r1: number
  /** toe radius R2 (mm) on the free end of each leg */
  r2: number
  /** nominal mass per metre (kg/m) */
  mass: number
}
