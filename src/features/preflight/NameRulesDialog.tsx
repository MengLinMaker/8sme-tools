/**
 * Filename name rules — how a STEP name becomes a mark, quantity and section.
 *
 * Tekla exports are not consistent between jobs, so the audit's built-in heuristics (ITEM token /
 * `<n> OFF` / catalogue callout) can be overridden per job. The preview runs the draft rules over
 * the job's real STEP names — and over any name typed into the tester — marking each field that
 * came from the custom rule versus the built-in fallback, so a rule can be checked before it
 * changes the audit.
 */

import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  DEFAULT_STEP_NAME_RULES,
  extractStepName,
  isDefaultStepNameRules,
  type NameSpan,
  nameBody,
  normalizeStepNameRules,
  type StepName,
  type StepNameRules,
  validateStepNameRules,
} from '@/lib/audit/stepNames'
import { cn } from '@/lib/utils'

export interface NameRulesDialogProps {
  open: boolean
  onClose: () => void
  rules: StepNameRules
  /** The job's STEP paths, used for the live preview. */
  stepPaths: string[]
  onApply: (rules: StepNameRules) => void
}

const inputClass =
  'h-8 w-full rounded-md border border-border bg-background px-2 font-mono text-xs text-foreground outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-ring'

type Field = 'mark' | 'quantity' | 'section'

const FIELDS: Field[] = ['mark', 'quantity', 'section']

/** One colour per field, used by both the legend and the highlighted filename. */
const SPAN_CLASS: Record<Field, string> = {
  mark: 'rounded-sm bg-sky-500/25 px-0.5 text-sky-950 dark:text-sky-100',
  quantity: 'rounded-sm bg-emerald-500/25 px-0.5 text-emerald-950 dark:text-emerald-100',
  section: 'rounded-sm bg-violet-500/25 px-0.5 text-violet-950 dark:text-violet-100',
}

const LEGEND_CLASS: Record<Field, string> = {
  mark: 'bg-sky-500/60',
  quantity: 'bg-emerald-500/60',
  section: 'bg-violet-500/60',
}

/**
 * The filename the rules actually see (`nameBody`), with each captured range marked in its
 * field's colour. Overlapping matches (rare, and usually a sign of a bad pattern) keep the first.
 */
function HighlightedName({ path, spans }: { path: string; spans: NameSpan[] }) {
  const { t } = useTranslation()
  const body = nameBody(path)
  const extension = /\.[^.]+$/.exec(path)?.[0] ?? ''
  const sorted = [...spans]
    .filter((span) => span.start >= 0 && span.end > span.start && span.end <= body.length)
    .sort((a, b) => a.start - b.start)

  const parts: ReactNode[] = []
  let at = 0
  for (const span of sorted) {
    if (span.start < at) continue
    if (span.start > at) parts.push(body.slice(at, span.start))
    parts.push(
      <mark
        key={`${span.field}-${span.start}`}
        className={SPAN_CLASS[span.field]}
        title={t('preflight.nameRules.matchTitle', {
          field: t(`preflight.nameRules.${span.field}`),
          value: span.text,
        })}
      >
        {body.slice(span.start, span.end)}
      </mark>,
    )
    at = span.end
  }
  if (at < body.length) parts.push(body.slice(at))

  return (
    <span className="whitespace-nowrap font-mono text-[11px] text-muted-foreground">
      {parts}
      {extension && <span className="text-muted-foreground/60">{extension}</span>}
    </span>
  )
}

/** True when this field came from the built-in rule because the custom one missed. */
function fellBack(name: StepName, field: Field, active: Record<Field, boolean>): boolean {
  return active[field] && !name[`${field}FromRule`]
}

/**
 * The matched section callout when it differs from the resolved code (`200UB25` →
 * `200UB25.4`), so the preview shows both what the rule read and what it resolved to.
 */
function sectionDetail(name: StepName): string | undefined {
  if (!name.section || !name.sectionCallout) return undefined
  const compact = (value: string) => value.replace(/\s+/g, '').toUpperCase()
  return compact(name.sectionCallout) === compact(name.section.code)
    ? undefined
    : name.sectionCallout
}

export function NameRulesDialog({
  open,
  onClose,
  rules,
  stepPaths,
  onApply,
}: NameRulesDialogProps) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState<StepNameRules>(() => normalizeStepNameRules(rules))
  /** A filename typed into the tester; empty means the loaded job's STEP files. */
  const [testName, setTestName] = useState('')
  const [query, setQuery] = useState('')
  const [onlyFallback, setOnlyFallback] = useState(false)

  useEffect(() => {
    if (!open) return
    setDraft(normalizeStepNameRules(rules))
    setTestName('')
    setQuery('')
    setOnlyFallback(false)
  }, [open, rules])

  const errors = useMemo(() => validateStepNameRules(draft), [draft])
  const invalid = Boolean(errors.mark || errors.quantity || errors.section)
  const active = useMemo<Record<Field, boolean>>(
    () => ({
      mark: Boolean(draft.mark),
      quantity: Boolean(draft.quantity),
      section: Boolean(draft.section),
    }),
    [draft.mark, draft.quantity, draft.section],
  )

  /** Every row the preview could show: the tester's name, or the job's STEP files. */
  const allRows = useMemo(() => {
    const typed = testName.trim()
    if (typed) return [{ path: typed, name: extractStepName(typed, draft) }]
    return stepPaths.map((path) => ({ path, name: extractStepName(path, draft) }))
  }, [testName, stepPaths, draft])

  /** How many names each active rule matched, out of the names in view. */
  const matches = useMemo(() => {
    const count = (field: Field) => allRows.filter((row) => row.name[`${field}FromRule`]).length
    return { mark: count('mark'), quantity: count('quantity'), section: count('section') }
  }, [allRows])

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return allRows.filter((row) => {
      if (onlyFallback && !FIELDS.some((field) => fellBack(row.name, field, active))) return false
      if (!needle) return true
      return (
        row.path.toLowerCase().includes(needle) ||
        row.name.mark.includes(needle) ||
        (row.name.section?.code.toLowerCase().includes(needle) ?? false)
      )
    })
  }, [allRows, query, onlyFallback, active])

  const field = (key: Field, hint: string, placeholder: string) => (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-foreground">{t(`preflight.nameRules.${key}`)}</span>
      <input
        type="text"
        value={draft[key]}
        onChange={(event) => setDraft((current) => ({ ...current, [key]: event.target.value }))}
        placeholder={placeholder}
        spellCheck={false}
        aria-invalid={Boolean(errors[key])}
        className={cn(
          inputClass,
          errors[key] && 'border-destructive focus-visible:ring-destructive',
        )}
      />
      <span className="text-[11px] text-muted-foreground">{hint}</span>
      {errors[key] && (
        <span className="text-[11px] text-destructive-foreground">
          {t('preflight.nameRules.invalid', { error: errors[key] })}
        </span>
      )}
    </label>
  )

  /** One extracted value, with a badge saying where it came from. */
  const valueCell = (name: StepName, key: Field, value: string, detail?: string) => {
    const fallback = fellBack(name, key, active)
    return (
      <TableCell className="whitespace-nowrap font-mono text-xs">
        <span className={cn(fallback && 'text-amber-600 dark:text-amber-400')}>{value}</span>{' '}
        {detail && (
          <span className="text-[10px] font-sans text-muted-foreground">
            {t('preflight.nameRules.previewFrom', { value: detail })}
          </span>
        )}
        {active[key] && (
          <span
            className={cn(
              'rounded px-1 py-0.5 text-[9px] uppercase tracking-wide',
              fallback
                ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
                : 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
            )}
          >
            {t(fallback ? 'preflight.nameRules.badgeFallback' : 'preflight.nameRules.badgeRule')}
          </span>
        )}
      </TableCell>
    )
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('preflight.nameRules.title')}
      className="max-w-3xl"
    >
      <div className="flex flex-col gap-4 p-5">
        <p className="text-xs text-muted-foreground">{t('preflight.nameRules.intro')}</p>

        <div className="grid gap-3 sm:grid-cols-3">
          {field('mark', t('preflight.nameRules.markHint'), 'ITEM-([0-9]+)')}
          {field('quantity', t('preflight.nameRules.quantityHint'), 'QTY\\s*([0-9]+)')}
          {field('section', t('preflight.nameRules.sectionHint'), '(SHS|RHS)[\\s_]*[0-9x.*]+')}
        </div>

        <label className="flex items-start gap-2 rounded-md border border-border px-2.5 py-2">
          <input
            type="checkbox"
            checked={draft.underscoreSeparator}
            onChange={(event) =>
              setDraft((current) => ({ ...current, underscoreSeparator: event.target.checked }))
            }
            className="mt-0.5 accent-primary"
          />
          <span className="flex flex-col gap-0.5">
            <span className="text-xs font-medium text-foreground">
              {t('preflight.nameRules.underscore')}
            </span>
            <span className="text-[11px] text-muted-foreground">
              {t('preflight.nameRules.underscoreHint')}
            </span>
          </span>
        </label>

        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-xs font-medium text-foreground">
              {t('preflight.nameRules.preview')}
            </span>
            <span className="text-[11px] text-muted-foreground">
              {isDefaultStepNameRules(draft)
                ? t('preflight.nameRules.defaults')
                : t('preflight.nameRules.custom')}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              value={testName}
              onChange={(event) => setTestName(event.target.value)}
              placeholder={t('preflight.nameRules.testPlaceholder')}
              aria-label={t('preflight.nameRules.testPlaceholder')}
              spellCheck={false}
              className={cn(inputClass, 'min-w-52 flex-1')}
            />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('preflight.nameRules.filterPlaceholder')}
              aria-label={t('preflight.nameRules.filterPlaceholder')}
              className={cn(inputClass, 'w-44 font-sans')}
            />
            <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <input
                type="checkbox"
                checked={onlyFallback}
                onChange={(event) => setOnlyFallback(event.target.checked)}
                className="accent-primary"
              />
              {t('preflight.nameRules.onlyFallback')}
            </label>
          </div>

          {/* Per-rule score: how many of the names in view each custom rule matched. */}
          {FIELDS.some((key) => active[key]) && (
            <div className="flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">
              {FIELDS.filter((key) => active[key]).map((key) => (
                <span key={key} className="rounded border border-border px-1.5 py-0.5">
                  {t(`preflight.nameRules.${key}`)}:{' '}
                  <span className="font-mono text-foreground tabular-nums">
                    {matches[key]}/{allRows.length}
                  </span>{' '}
                  {t('preflight.nameRules.matched')}
                </span>
              ))}
            </div>
          )}

          {/* Which colour means which capture in the file column. */}
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
            <span>{t('preflight.nameRules.highlightLegend')}</span>
            {FIELDS.map((key) => (
              <span key={key} className="inline-flex items-center gap-1">
                <span className={cn('inline-block size-2.5 rounded-sm', LEGEND_CLASS[key])} />
                {t(`preflight.nameRules.${key}`)}
              </span>
            ))}
          </div>

          {rows.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {allRows.length === 0
                ? t('preflight.nameRules.previewEmpty')
                : t('preflight.nameRules.previewNoMatch')}
            </p>
          ) : (
            <>
              <div className="max-h-64 overflow-auto rounded-lg border border-border">
                <Table>
                  <TableHeader className="[&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:bg-card">
                    <TableRow className="hover:bg-transparent">
                      <TableHead>{t('preflight.nameRules.previewFile')}</TableHead>
                      <TableHead>{t('preflight.nameRules.previewMark')}</TableHead>
                      <TableHead className="text-right">
                        {t('preflight.nameRules.previewQty')}
                      </TableHead>
                      <TableHead>{t('preflight.nameRules.previewSection')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.slice(0, 200).map(({ path, name }) => (
                      <TableRow key={path}>
                        <TableCell className="whitespace-nowrap" title={path}>
                          <HighlightedName path={path} spans={name.spans} />
                        </TableCell>
                        {valueCell(name, 'mark', name.mark)}
                        {valueCell(
                          name,
                          'quantity',
                          name.quantity === null ? '—' : String(name.quantity),
                        )}
                        {valueCell(name, 'section', name.section?.code ?? '—', sectionDetail(name))}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <span className="text-[11px] text-muted-foreground">
                {testName.trim()
                  ? t('preflight.nameRules.testHint')
                  : t('preflight.nameRules.previewCount', {
                      shown: Math.min(rows.length, 200),
                      total: allRows.length,
                    })}
              </span>
            </>
          )}
        </div>

        <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-3">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setDraft({ ...DEFAULT_STEP_NAME_RULES })}
          >
            {t('preflight.nameRules.reset')}
          </Button>
          <Button variant="outline" size="sm" onClick={onClose}>
            {t('common.actions.cancel')}
          </Button>
          <Button
            size="sm"
            disabled={invalid}
            onClick={() => {
              onApply(normalizeStepNameRules(draft))
              onClose()
            }}
          >
            {t('preflight.nameRules.apply')}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
