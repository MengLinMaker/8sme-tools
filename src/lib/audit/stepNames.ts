import {
  type FilenameProfile,
  profileFromCallout,
  profileFromFilename,
} from '@/lib/sections/fromFilename'

/**
 * How a Tekla filename is read into the fields the audit keys parts by.
 *
 * Tekla's own exports are not consistent: the same job can arrive as
 * `12095, ITEM 35, SHS 75x75x6, 24 OFF[C].STEP` (comma separated) or
 * `ITEM_35_SHS_75x75x6_24_OFF.step` (underscore separated), and renamed parts often drop the
 * ITEM token entirely. The shipped defaults encode the historical heuristics; a job with a
 * different convention can override any field with its own regex, and clearing a field falls back
 * to the same built-in heuristic.
 *
 * A custom pattern is a JavaScript regex source applied to the **basename without extension**.
 * Capture group 1 is the value; a pattern with no group uses the whole match. An invalid or
 * non-matching custom pattern never loses a part: the built-in heuristic runs instead.
 */
export interface StepNameRules {
  /** Mark pattern. Default captures the ITEM token; unmatched names use the first-token rule. */
  mark: string
  /** Piece-count pattern. Default is `<n> OFF`. */
  quantity: string
  /** Section-callout pattern. Default scans the name for a catalogue family callout. */
  section: string
  /** Treat `_` as a separator as well as whitespace (`ITEM_35_...`). */
  underscoreSeparator: boolean
}

export const DEFAULT_STEP_NAME_RULES: StepNameRules = {
  // The ITEM token (`12095, ITEM 35, ...`), captured whole so a spaced token still becomes `item35`.
  // Names without ITEM do not match and the built-in first-token rule still applies.
  mark: String.raw`\b(item[\s_]*[0-9]+[A-Za-z]?)(?![0-9A-Za-z])`,
  quantity: String.raw`(?:^|[^0-9])([0-9]{1,4})[\s_]*off\b`,
  // Depth-first designations (`200UB25`, `150UB14`, `310UB32`) must be matched whole, otherwise
  // the second branch only sees `UB25` and the catalogue lookup falls back.
  section: String.raw`(?:[0-9]{2,3}[\s_]*(?:UB|UC|TFB)[\s_]*[0-9]+(?:\.[0-9]+)?)|(?:(?:SHS|RHS|EA|UA|PFC|TFC|UB|UC|TFB|CHS)[\s_]*[0-9][0-9xX×*.\s_-]*)`,
  underscoreSeparator: false,
}

/** A field's matched range inside the filename body, for highlighting. */
export interface NameSpan {
  field: 'mark' | 'quantity' | 'section'
  /** Index into `nameBody(path)`. */
  start: number
  end: number
  /** The exact text at those indices (`ITEM 10`, `24`, `200UB25`). */
  text: string
}

/** One extracted filename, with any rule errors so the UI can explain a fallback. */
export interface StepName {
  /** Lower-case part mark, matching the historical `markFromFilename` output. */
  mark: string
  /** Pieces declared by the name, or null when the name carries none. */
  quantity: number | null
  /** Section callout, when the name resolves against the catalogue. */
  section: FilenameProfile | null
  /** The text the section rule matched (`200UB25`), before catalogue resolution (`200UB25.4`). */
  sectionCallout: string | null
  /** Where each rule matched in `nameBody(path)`, for the preview's colour-coded highlights. */
  spans: NameSpan[]
  /** True when a custom rule produced the value; false means the built-in heuristic did. */
  markFromRule: boolean
  quantityFromRule: boolean
  sectionFromRule: boolean
  markError: string | null
  quantityError: string | null
  sectionError: string | null
}

/** Fills missing fields so callers can pass a stored partial config directly. */
export function normalizeStepNameRules(rules?: Partial<StepNameRules> | null): StepNameRules {
  // A blank field uses the shipped pattern: the field is a starting point to edit, not a way to
  // accidentally disable identification.
  return {
    mark: rules?.mark?.trim() || DEFAULT_STEP_NAME_RULES.mark,
    quantity: rules?.quantity?.trim() || DEFAULT_STEP_NAME_RULES.quantity,
    section: rules?.section?.trim() || DEFAULT_STEP_NAME_RULES.section,
    underscoreSeparator: rules?.underscoreSeparator ?? DEFAULT_STEP_NAME_RULES.underscoreSeparator,
  }
}

/** True when the rules are the shipped defaults, so the UI can label them as defaults. */
export function isDefaultStepNameRules(rules?: Partial<StepNameRules> | null): boolean {
  const normalized = normalizeStepNameRules(rules)
  return (
    normalized.mark === DEFAULT_STEP_NAME_RULES.mark &&
    normalized.quantity === DEFAULT_STEP_NAME_RULES.quantity &&
    normalized.section === DEFAULT_STEP_NAME_RULES.section &&
    !normalized.underscoreSeparator
  )
}

/** The basename with the extension removed — what the patterns are matched against. */
export function nameBody(path: string): string {
  return (path.split(/[\\/]/).pop() ?? path).replace(/\.[^.]+$/, '').replace(/^[^A-Za-z0-9]+/, '')
}

/** Checks every pattern once, so the settings UI can invalidate a field without auditing a job. */
export function validateStepNameRules(rules?: Partial<StepNameRules> | null): {
  mark: string | null
  quantity: string | null
  section: string | null
} {
  const normalized = normalizeStepNameRules(rules)
  const errorOf = (pattern: string): string | null => {
    if (!pattern) return null
    const compiled = compile(pattern)
    return 'error' in compiled ? compiled.error : null
  }
  return {
    mark: errorOf(normalized.mark),
    quantity: errorOf(normalized.quantity),
    section: errorOf(normalized.section),
  }
}

function compile(pattern: string): { regex: RegExp } | { error: string } {
  if (!pattern) return { error: 'empty' }
  try {
    return { regex: new RegExp(pattern, 'i') }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/** A captured value and where it sits in the text. */
interface Capture {
  value: string
  start: number
  end: number
}

/**
 * Runs a rule and returns its value plus the offsets of the capture in `text` (group 1, or the
 * whole match when the pattern has no group). The offsets drive the preview's highlighting.
 */
function capture(regex: RegExp, text: string): Capture | null {
  const match = regex.exec(text)
  if (!match) return null
  const group = match.length > 1 ? 1 : 0
  const raw = match[group] ?? ''
  const value = raw.trim()
  if (!value) return null
  const rawStart = match[0].indexOf(raw)
  const base = match.index + (rawStart >= 0 ? rawStart : 0)
  const start = base + raw.indexOf(value)
  return { value, start, end: start + value.length }
}

/** The built-in mark rule, with the span of the token it chose. */
function defaultMark(body: string, underscoreSeparator: boolean): Capture | null {
  // The common Tekla STEP shape: the `ITEM <n>` token is the part, not the project number.
  const separator = underscoreSeparator ? '[\\s_]*' : '\\s*'
  const item = new RegExp(`\\bitem${separator}([0-9]+[A-Za-z]?)(?![0-9A-Za-z])`, 'i').exec(body)
  if (item) {
    return {
      value: `item${item[1]}`.toLowerCase(),
      start: item.index,
      end: item.index + item[0].length,
    }
  }
  // Otherwise the first token is the mark and the rest is description.
  const token = (underscoreSeparator ? /[^\s_]+/ : /\S+/).exec(body)
  if (!token) return null
  return { value: token[0].toLowerCase(), start: token.index, end: token.index + token[0].length }
}

/** The built-in `<n> OFF` rule, with the span of the digits. */
function defaultQuantity(
  body: string,
  underscoreSeparator: boolean,
): (Capture & { quantity: number }) | null {
  // Strict on purpose: only a whole number directly followed by OFF counts, so a number in the
  // mark itself (`TR9-1`, `3ub-1`) is never read as a quantity.
  const separator = underscoreSeparator ? '[\\s_]*' : '\\s*'
  const found = capture(new RegExp(`(?:^|[^0-9])([0-9]{1,4})${separator}off\\b`, 'i'), body)
  if (!found) return null
  const quantity = Number(found.value)
  return Number.isInteger(quantity) && quantity > 0 ? { ...found, quantity } : null
}

function toQuantity(value: string | null): number | null {
  if (!value) return null
  const digits = value.match(/[0-9]+/)
  if (!digits) return null
  const quantity = Number(digits[0])
  return Number.isInteger(quantity) && quantity > 0 ? quantity : null
}

/**
 * Reads one filename into mark, quantity and section. Built-in defaults are used for any field
 * without a usable custom pattern, so a rule that misses a renamed file still yields a part.
 */
export function extractStepName(path: string, rules?: Partial<StepNameRules> | null): StepName {
  const normalized = normalizeStepNameRules(rules)
  const body = nameBody(path)
  const spans: NameSpan[] = []
  const spanOf = (field: NameSpan['field'], found: Capture): NameSpan => ({
    field,
    start: found.start,
    end: found.end,
    text: body.slice(found.start, found.end),
  })

  let mark = ''
  let markFromRule = false
  let markError: string | null = null
  if (normalized.mark) {
    const compiled = compile(normalized.mark)
    if ('error' in compiled) markError = compiled.error
    else {
      const found = capture(compiled.regex, body)
      if (found) {
        mark = found.value
        markFromRule = true
        spans.push(spanOf('mark', found))
      }
    }
  }
  if (!mark) {
    const fallback = defaultMark(body, normalized.underscoreSeparator)
    if (fallback) {
      mark = fallback.value
      spans.push(spanOf('mark', fallback))
    } else {
      mark = body
    }
  }
  // A captured token can carry the separator (`ITEM 35`), but a mark never contains whitespace;
  // `_` is also Tekla's stand-in for `/`, so an `item_35` prefix collapses to `item35`.
  mark = mark
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/^item_+/, 'item')

  let quantity: number | null = null
  let quantityFromRule = false
  let quantityError: string | null = null
  if (normalized.quantity) {
    const compiled = compile(normalized.quantity)
    if ('error' in compiled) quantityError = compiled.error
    else {
      const found = capture(compiled.regex, body)
      quantity = toQuantity(found?.value ?? null)
      if (found && quantity !== null) {
        quantityFromRule = true
        spans.push(spanOf('quantity', found))
      }
    }
  }
  if (quantity === null) {
    const fallback = defaultQuantity(body, normalized.underscoreSeparator)
    if (fallback) {
      quantity = fallback.quantity
      spans.push(spanOf('quantity', fallback))
    }
  }

  let section: FilenameProfile | null = null
  let sectionFromRule = false
  let sectionCallout: string | null = null
  let sectionError: string | null = null
  if (normalized.section) {
    const compiled = compile(normalized.section)
    if ('error' in compiled) sectionError = compiled.error
    else {
      const found = capture(compiled.regex, body)
      sectionCallout = found?.value ?? null
      section = profileFromCallout(sectionCallout ?? '')
      sectionFromRule = section !== null
      // Only highlight a callout the catalogue actually resolved; a miss keeps the "built-in"
      // badge honest rather than pointing at text that produced nothing.
      if (found && section) spans.push(spanOf('section', found))
    }
  }
  if (!section && !sectionError) {
    section = profileFromFilename(path)
    sectionCallout = null
  }

  return {
    mark,
    quantity,
    section,
    sectionCallout,
    spans,
    markFromRule,
    quantityFromRule,
    sectionFromRule,
    markError,
    quantityError,
    sectionError,
  }
}

/** The mark as written in a filename, with the built-in heuristics and optional rules. */
export function markFromFilename(path: string, rules?: Partial<StepNameRules> | null): string {
  return extractStepName(path, rules).mark
}

/** Pieces declared in a filename (`24 OFF`), with optional custom rules. */
export function quantityFromFilename(
  path: string,
  rules?: Partial<StepNameRules> | null,
): number | null {
  return extractStepName(path, rules).quantity
}

/**
 * The comparison key for a mark.
 *
 * Tekla writes the same part differently across files — `ITEM 35` in the part list, `item35` in a
 * STEP name, `A/1` internally but `A_1` on disk — so spaces, underscores, slashes and commas must
 * not split a part. Hyphens and dots are kept: `TR9-1` and `TR9-2` (or `1.1` and `11`) differ.
 */
export function markKey(mark: string): string {
  return mark.toLowerCase().replace(/[\s_/,]+/g, '')
}
