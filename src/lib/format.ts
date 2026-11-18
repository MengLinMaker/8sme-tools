/**
 * Display formatting for quantities people read off the screen.
 *
 * Large masses are the reason this exists: a pickup load of `26347.7` kg is hard to size up at a
 * glance, so a value reaching a tonne is shown in tonnes ("26.3 t"). Digits always use the
 * locale's grouping (en-AU: `26,347.7`) — never `_`, which is a source-code convention, not a
 * shop-floor one.
 */

/** A tonne. The switch point for `formatMass`, and the unit the machine shop thinks in. */
export const KG_PER_TONNE = 1000

/** Format a number with fixed decimals and the locale's digit grouping. */
export function formatNumber(value: number, digits = 1, locale?: string): string {
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value)
}

/**
 * Format a mass given in kilograms.
 *
 * Below a tonne it stays in kg (`842.5 kg`); at or above it switches to tonnes, so a big pickup
 * load reads at a glance (`26347.7` → `26.3 t`). Small tonnages keep two decimals (`1.05 t`) so a
 * load just over a tonne is not rounded in 100 kg steps; ten tonnes and up settle at one.
 *
 * The unit is part of the string, so kg and t can share a column without the header naming one.
 */
export function formatMass(kg: number, locale?: string): string {
  const tonnes = Math.abs(kg) / KG_PER_TONNE
  if (tonnes >= 1) {
    return `${formatNumber(kg / KG_PER_TONNE, tonnes < 10 ? 2 : 1, locale)} t`
  }
  return `${formatNumber(kg, 1, locale)} kg`
}

/** Human-readable byte size (`1.2 MB`) for file lists and storage totals. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${Math.round(kb)} KB`
  const mb = kb / 1024
  if (mb < 1024) return `${mb.toFixed(1)} MB`
  return `${(mb / 1024).toFixed(1)} GB`
}
