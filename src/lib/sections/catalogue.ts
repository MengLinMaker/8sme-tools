import { angleDesignation, EQUAL_ANGLES, UNEQUAL_ANGLES } from './angle'
import { PFC_SECTIONS } from './pfc'
import { TFB_SECTIONS } from './tfb'
import type { RolledSection } from './types'
import { UB_SECTIONS } from './ub'
import { UC_SECTIONS } from './uc'

/**
 * One entry in the section lookup: a catalogue designation plus the NC-style dims the stock
 * builders expect. Fully tabulated rolled sections resolve from the code alone, so `dims` stays
 * empty; the UI can still show the real outline and cut settings.
 */
export interface CatalogueSection {
  /** Parseable designation used by the section builders. */
  code: string
  /** Human label in the lookup list. */
  label: string
  /** Family tag, e.g. `UB`, `UC`, `PFC`, `TFB`, `EA`, `UA`. */
  group: string
  /** Nominal mass (kg/m). */
  mass: number
  /** NC-style cross-section dims; empty when the code alone identifies the section. */
  dims: number[]
}

const fromRolled = (group: string, sections: RolledSection[]): CatalogueSection[] =>
  sections.map((section) => ({
    code: section.designation,
    label: section.designation,
    group,
    mass: section.mass,
    dims: [],
  }))

const fromAngles = (group: string, angles: typeof EQUAL_ANGLES): CatalogueSection[] =>
  angles.map((angle) => ({
    code: angleDesignation(angle),
    label: angleDesignation(angle),
    group,
    mass: angle.mass,
    dims: [],
  }))

/**
 * The tabulated sections the app can draw and suggest cut settings for. Kept in catalogue order
 * within each family so the lookup reads like the steel table.
 */
export const CATALOGUE_SECTIONS: CatalogueSection[] = [
  ...fromRolled('UB', UB_SECTIONS),
  ...fromRolled('UC', UC_SECTIONS),
  ...fromRolled('PFC', PFC_SECTIONS),
  ...fromRolled('TFB', TFB_SECTIONS),
  ...fromAngles('EA', EQUAL_ANGLES),
  ...fromAngles('UA', UNEQUAL_ANGLES),
]
