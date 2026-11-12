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
  /** Family tag, e.g. `UB`, `UC`, `PFC`, `TFB`, `EA`, `UA`, `SHS`, `RHS`. */
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

/** A hollow stock size: `a` is the longer side, `b` the shorter. */
interface HollowStock {
  a: number
  b: number
  group: 'SHS' | 'RHS'
  thicknesses: number[]
}

/**
 * Common AS/NZS 1163 hollow sizes. This is a representative stock list (the steel table), not
 * every size every distributor carries. The catalogue test keeps each entry drawable.
 */
const SHS_STOCK: HollowStock[] = [
  { a: 20, b: 20, group: 'SHS', thicknesses: [1.6, 2.0] },
  { a: 25, b: 25, group: 'SHS', thicknesses: [1.6, 2.0, 2.5, 3.0] },
  { a: 30, b: 30, group: 'SHS', thicknesses: [1.6, 2.0, 2.5, 3.0] },
  { a: 35, b: 35, group: 'SHS', thicknesses: [1.6, 2.0, 2.5, 3.0] },
  { a: 40, b: 40, group: 'SHS', thicknesses: [1.6, 2.0, 2.5, 3.0, 4.0] },
  { a: 50, b: 50, group: 'SHS', thicknesses: [1.6, 2.0, 2.5, 3.0, 4.0, 5.0, 6.0] },
  { a: 65, b: 65, group: 'SHS', thicknesses: [1.6, 2.0, 2.5, 3.0, 4.0, 5.0, 6.0] },
  { a: 75, b: 75, group: 'SHS', thicknesses: [2.0, 2.5, 3.0, 3.5, 4.0, 5.0, 6.0] },
  { a: 89, b: 89, group: 'SHS', thicknesses: [2.0, 3.5, 5.0, 6.0] },
  { a: 100, b: 100, group: 'SHS', thicknesses: [2.0, 2.5, 3.0, 3.5, 4.0, 5.0, 6.0, 9.0] },
  { a: 125, b: 125, group: 'SHS', thicknesses: [3.0, 4.0, 5.0, 6.0, 9.0] },
  { a: 150, b: 150, group: 'SHS', thicknesses: [3.0, 4.0, 5.0, 6.0, 9.0, 10.0] },
  { a: 200, b: 200, group: 'SHS', thicknesses: [4.0, 5.0, 6.0, 9.0, 10.0, 12.5, 16.0] },
  { a: 250, b: 250, group: 'SHS', thicknesses: [5.0, 6.0, 9.0, 12.5, 16.0] },
  { a: 300, b: 300, group: 'SHS', thicknesses: [6.0, 8.0, 10.0, 12.5, 16.0] },
  { a: 400, b: 400, group: 'SHS', thicknesses: [10.0, 12.5, 16.0] },
]

const RHS_STOCK: HollowStock[] = [
  { a: 50, b: 25, group: 'RHS', thicknesses: [1.6, 2.0, 2.5, 3.0] },
  { a: 60, b: 35, group: 'RHS', thicknesses: [2.0, 2.5, 3.0, 4.0] },
  { a: 65, b: 35, group: 'RHS', thicknesses: [2.0, 2.5, 3.0, 4.0] },
  { a: 75, b: 25, group: 'RHS', thicknesses: [1.6, 2.0, 2.5] },
  { a: 75, b: 50, group: 'RHS', thicknesses: [1.6, 2.0, 2.5, 3.0, 4.0, 5.0, 6.0] },
  { a: 100, b: 50, group: 'RHS', thicknesses: [1.6, 2.0, 2.5, 3.0, 3.5, 4.0, 5.0, 6.0] },
  { a: 100, b: 75, group: 'RHS', thicknesses: [2.0, 2.5, 3.0, 4.0, 5.0, 6.0] },
  { a: 125, b: 75, group: 'RHS', thicknesses: [2.0, 2.5, 3.0, 4.0, 5.0, 6.0] },
  { a: 150, b: 50, group: 'RHS', thicknesses: [2.0, 2.5, 3.0, 4.0, 5.0, 6.0] },
  { a: 150, b: 100, group: 'RHS', thicknesses: [3.0, 4.0, 5.0, 6.0, 8.0, 9.0] },
  { a: 200, b: 100, group: 'RHS', thicknesses: [3.0, 4.0, 5.0, 6.0, 8.0, 9.0, 10.0] },
  { a: 200, b: 150, group: 'RHS', thicknesses: [5.0, 6.0, 8.0, 9.0, 10.0, 12.5, 16.0] },
  { a: 250, b: 150, group: 'RHS', thicknesses: [5.0, 6.0, 8.0, 9.0, 10.0, 12.5, 16.0] },
  { a: 300, b: 200, group: 'RHS', thicknesses: [6.0, 8.0, 9.0, 10.0, 12.5, 16.0] },
  { a: 400, b: 200, group: 'RHS', thicknesses: [8.0, 10.0, 12.5, 16.0] },
  { a: 400, b: 300, group: 'RHS', thicknesses: [8.0, 10.0, 12.5, 16.0] },
]

/** Nominal hollow mass (kg/m) from the flat-wall area; catalogue display only. */
const hollowMass = (stock: HollowStock, t: number): number => {
  const area = stock.group === 'SHS' ? 4 * t * (stock.a - t) : 2 * t * (stock.a + stock.b - 2 * t)
  return Math.round(area * 0.00785 * 10) / 10
}

const fromHollow = (stock: HollowStock): CatalogueSection[] =>
  stock.thicknesses.map((t) => ({
    code: `${stock.group}${stock.a}*${stock.b}*${t.toFixed(1)}`,
    label: `${stock.group}${stock.a}x${stock.b}x${t.toFixed(1)}`,
    group: stock.group,
    mass: hollowMass(stock, t),
    // Corner radius is ~2.5t for cold-formed hollows; the code alone cannot carry it.
    dims: [stock.a, stock.b, t, t, 2.5 * t],
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
  ...SHS_STOCK.flatMap(fromHollow),
  ...RHS_STOCK.flatMap(fromHollow),
]
