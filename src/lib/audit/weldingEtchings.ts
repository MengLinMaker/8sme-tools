import { parseNcGeometry } from '@/lib/parsers/ncGeometry'

/**
 * Welding-location etchings carried by a DSTV NC: the `PU`/`KO` scribe bars/lines that mark where
 * adjoining members attach, plus any `SI` text naming a member other than the part itself. An `SI`
 * equal to the part mark is just identification, not a welding mark.
 */
export interface WeldingEtchings {
  /** Number of `PU`/`KO` scribe polylines (weld-location bars/lines). */
  scribeLines: number
  /** Member marks etched for welding (de-duplicated, in NC order). */
  labels: string[]
}

/** A mark with leading dots/whitespace removed, for comparing against an `SI` text. */
function normalizeMark(value: string): string {
  return value.trim().replace(/^\.+/, '').toLowerCase()
}

/** The welding-location etchings in an NC, or null when it only carries part identification. */
export function findWeldingEtchings(ncText: string, partMark: string): WeldingEtchings | null {
  const ownMark = normalizeMark(partMark)
  const labels: string[] = []
  let scribeLines = 0

  for (const mark of parseNcGeometry(ncText).marks) {
    if (mark.kind === 'marking') {
      scribeLines++
      continue
    }
    const value = mark.text?.value.trim() ?? ''
    if (!value || normalizeMark(value) === ownMark) continue
    if (!labels.includes(value)) labels.push(value)
  }

  return scribeLines > 0 || labels.length > 0 ? { scribeLines, labels } : null
}
