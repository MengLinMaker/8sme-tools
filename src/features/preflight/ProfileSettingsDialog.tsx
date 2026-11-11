/**
 * Cross-section preview + suggested O₂ cut parameters for one profile.
 *
 * Opened from the Profiles table in preflight. The section is drawn from the same builder the
 * stock ghost uses, and each distinct wall thickness gets one suggested recipe (flange/web for a
 * rolled section, wall for a hollow). Values come from `suggestCut`; the operator is expected to
 * verify them on scrap.
 */

import { ChevronLeft, ChevronRight, Search } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
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
import { type CutSuggestion, type SurfaceCondition, suggestCut } from '@/lib/machine/cutParams'
import { MACHINE } from '@/lib/machine/profile'
import { profileFamily } from '@/lib/sections/canonical'
import { CATALOGUE_SECTIONS } from '@/lib/sections/catalogue'
import { partSectionForCode, sectionThicknesses } from '@/lib/sections/stock'
import { cn } from '@/lib/utils'

const SURFACES: SurfaceCondition[] = ['normal', 'rust', 'primed', 'galvanised']

/** One mark (part) inside the selected profile, rolled up by quantity. */
export interface ProfileMarkRow {
  mark: string
  pieces: number
  lengthMm: number
  massKg: number
}

type MarkSortKey = 'mark' | 'pieces' | 'length' | 'mass'

/** One row of the transposed settings table (parameters down, thicknesses across). */
const PARAM_ROWS: { key: string; value: (cut: CutSuggestion) => string }[] = [
  { key: 'pressure', value: (cut) => `${cut.pressureBar}` },
  { key: 'speed', value: (cut) => `${cut.speedMinMmMin}` },
  { key: 'standoff', value: (cut) => `${cut.heightMm}` },
  { key: 'focus', value: (cut) => `${cut.camFocusMm > 0 ? '+' : ''}${cut.camFocusMm}` },
  { key: 'power', value: (cut) => `${cut.powerPct}` },
  { key: 'frequency', value: (cut) => `${cut.frequencyHz}` },
  {
    key: 'rpm',
    value: (cut) => (cut.angularSpeedMinRpm != null ? `${cut.angularSpeedMinRpm}` : '—'),
  },
  {
    key: 'nozzle',
    value: (cut) => (cut.nozzle ? `${cut.nozzle.sizeMm.toFixed(1)} ${cut.nozzle.type}` : '—'),
  },
]

export interface ProfileSettingsDialogProps {
  open: boolean
  onClose: () => void
  profile: string
  dims: number[]
  /** Marks cut from this profile, rolled up by quantity. */
  marks?: ProfileMarkRow[]
  /** Move to the previous/next profile in the list. */
  onNavigate?: (delta: -1 | 1) => void
  canPrevious?: boolean
  canNext?: boolean
  /** One-based position in the profile list, for the title. */
  position?: { index: number; total: number }
}

export function ProfileSettingsDialog({
  open,
  onClose,
  profile,
  dims,
  marks = [],
  onNavigate,
  canPrevious = false,
  canNext = false,
  position,
}: ProfileSettingsDialogProps) {
  const { t } = useTranslation()

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft' && canPrevious) {
        event.preventDefault()
        onNavigate?.(-1)
      } else if (event.key === 'ArrowRight' && canNext) {
        event.preventDefault()
        onNavigate?.(1)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, canPrevious, canNext, onNavigate])

  const title = (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <span className="min-w-0 flex-1 truncate">{profile}</span>
      <div className="flex shrink-0 items-center gap-0.5">
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          onClick={() => onNavigate?.(-1)}
          disabled={!canPrevious}
          aria-label={t('preflight.profileSettings.previous')}
          title={t('preflight.profileSettings.previous')}
        >
          <ChevronLeft />
        </Button>
        <span
          className="w-16 whitespace-nowrap text-center text-xs font-normal tabular-nums text-muted-foreground"
          aria-live="polite"
        >
          {position ? `${position.index} / ${position.total}` : ''}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          onClick={() => onNavigate?.(1)}
          disabled={!canNext}
          aria-label={t('preflight.profileSettings.next')}
          title={t('preflight.profileSettings.next')}
        >
          <ChevronRight />
        </Button>
      </div>
    </div>
  )

  return (
    <Dialog open={open} onClose={onClose} title={title} className="max-w-2xl">
      <div className="p-5">
        <ProfileInfo profile={profile} dims={dims} marks={marks} />
      </div>
    </Dialog>
  )
}

export interface ProfileInfoProps {
  profile: string
  dims: number[]
  /** Marks cut from this profile, rolled up by quantity; omit to hide the per-mark tables. */
  marks?: ProfileMarkRow[]
}

/** Cross-section, suggested cut parameters and (optionally) the per-mark rollup for a profile. */
export function ProfileInfo({ profile, dims, marks = [] }: ProfileInfoProps) {
  const { t } = useTranslation()
  const [markSort, setMarkSort] = useState<{ key: MarkSortKey; dir: 1 | -1 }>({
    key: 'mark',
    dir: 1,
  })

  const section = useMemo(() => partSectionForCode(profile, dims), [profile, dims])
  const totals = useMemo(
    () =>
      marks.reduce(
        (acc, row) => ({
          marks: acc.marks + 1,
          pieces: acc.pieces + row.pieces,
          lengthMm: acc.lengthMm + row.lengthMm,
          massKg: acc.massKg + row.massKg,
        }),
        { marks: 0, pieces: 0, lengthMm: 0, massKg: 0 },
      ),
    [marks],
  )

  const sortedMarks = useMemo(() => {
    const direction = markSort.dir
    return [...marks].sort((a, b) => {
      const result =
        markSort.key === 'mark'
          ? a.mark.localeCompare(b.mark, undefined, { numeric: true })
          : markSort.key === 'pieces'
            ? a.pieces - b.pieces
            : markSort.key === 'length'
              ? a.lengthMm - b.lengthMm
              : a.massKg - b.massKg
      return result * direction
    })
  }, [marks, markSort])

  const toggleMarkSort = (key: MarkSortKey) =>
    setMarkSort((current) =>
      current.key === key ? { key, dir: current.dir === 1 ? -1 : 1 } : { key, dir: 1 },
    )

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-5 md:grid-cols-[15.5rem_minmax(0,1fr)]">
        <div className="w-40 md:w-full">
          <SectionPreview section={section} label={profile} />
        </div>

        <CutSettings profile={profile} dims={dims} />
      </div>

      {marks.length > 0 && (
        <div className="flex flex-col gap-3">
          <div className="overflow-x-auto rounded-lg border border-border">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>{t('preflight.profileSettings.summaryMarks')}</TableHead>
                  <TableHead className="text-right">
                    {t('preflight.profileSettings.summaryPieces')}
                  </TableHead>
                  <TableHead className="text-right">
                    {t('preflight.profileSettings.summaryLength')}
                  </TableHead>
                  <TableHead className="text-right">
                    {t('preflight.profileSettings.summaryMass')}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow>
                  <TableCell className="font-mono text-xs">{totals.marks}</TableCell>
                  <TableCell className="text-right font-mono text-xs">{totals.pieces}</TableCell>
                  <TableCell className="text-right font-mono text-xs">
                    {(totals.lengthMm / 1000).toFixed(1)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs">
                    {totals.massKg.toFixed(1)}
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium text-muted-foreground">
              {t('preflight.profileSettings.marksTitle')}
            </span>
            <Table containerClassName="h-48 overflow-auto rounded-lg border border-border">
              <TableHeader className="[&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:bg-card">
                <TableRow className="hover:bg-transparent">
                  <MarkSortHead
                    label={t('preflight.profileSettings.mark')}
                    sortKey="mark"
                    sort={markSort}
                    onSort={toggleMarkSort}
                  />
                  <MarkSortHead
                    label={t('preflight.profileSettings.pieces')}
                    sortKey="pieces"
                    sort={markSort}
                    onSort={toggleMarkSort}
                  />
                  <MarkSortHead
                    label={t('preflight.profileSettings.length')}
                    sortKey="length"
                    sort={markSort}
                    onSort={toggleMarkSort}
                  />
                  <MarkSortHead
                    label={t('preflight.profileSettings.mass')}
                    sortKey="mass"
                    sort={markSort}
                    onSort={toggleMarkSort}
                  />
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedMarks.map((row) => (
                  <TableRow key={row.mark}>
                    <TableCell className="font-mono text-xs">{row.mark}</TableCell>
                    <TableCell className="text-right font-mono text-xs">{row.pieces}</TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {row.lengthMm > 0 ? (row.lengthMm / 1000).toFixed(1) : '—'}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {row.massKg > 0 ? row.massKg.toFixed(1) : '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}
    </div>
  )
}

export interface SectionLookupDialogProps {
  open: boolean
  onClose: () => void
}

/** Searchable list of the tabulated sections, with the same preview and cut settings as a job. */
export function SectionLookupDialog({ open, onClose }: SectionLookupDialogProps) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(CATALOGUE_SECTIONS[0]?.code ?? '')

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return CATALOGUE_SECTIONS
    return CATALOGUE_SECTIONS.filter(
      (section) =>
        section.label.toLowerCase().includes(needle) ||
        section.group.toLowerCase().includes(needle),
    )
  }, [query])

  const current = matches.find((section) => section.code === selected) ?? matches[0]

  useEffect(() => {
    if (!open) return
    setSelected(current?.code ?? '')
  }, [open, current?.code])

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('preflight.profiles.lookupTitle')}
      className="max-w-4xl"
    >
      <div className="grid md:h-[70vh] md:grid-cols-[17rem_minmax(0,1fr)]">
        <div className="flex max-h-64 min-h-0 flex-col border-b border-border md:max-h-none md:border-b-0 md:border-r">
          <div className="border-b border-border p-3">
            <div className="relative">
              <Search
                className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('preflight.profiles.lookupPlaceholder')}
                aria-label={t('preflight.profiles.lookupPlaceholder')}
                className="h-8 w-full rounded-md border border-border bg-background pl-7 pr-2 text-sm text-foreground outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              {t('preflight.profiles.lookupHint')}
            </p>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-1.5">
            {matches.length === 0 ? (
              <p className="p-2 text-sm text-muted-foreground">
                {t('preflight.profiles.lookupEmpty')}
              </p>
            ) : (
              <ul className="flex flex-col gap-0.5">
                {matches.map((section) => (
                  <li key={section.code}>
                    <button
                      type="button"
                      onClick={() => setSelected(section.code)}
                      aria-current={section.code === current?.code}
                      className={cn(
                        'flex w-full items-baseline justify-between gap-2 rounded-md px-2 py-1.5 text-left transition-colors',
                        section.code === current?.code
                          ? 'bg-primary/15 text-foreground'
                          : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                      )}
                    >
                      <span className="truncate font-mono text-xs">{section.label}</span>
                      <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                        {section.group} · {section.mass.toFixed(1)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
        <div className="min-h-0 overflow-auto p-4">
          {current ? (
            <ProfileInfo profile={current.code} dims={current.dims} />
          ) : (
            <p className="text-sm text-muted-foreground">{t('preflight.profiles.lookupEmpty')}</p>
          )}
        </div>
      </div>
    </Dialog>
  )
}

function MarkSortHead({
  label,
  sortKey,
  sort,
  onSort,
}: {
  label: string
  sortKey: MarkSortKey
  sort: { key: MarkSortKey; dir: 1 | -1 }
  onSort: (key: MarkSortKey) => void
}) {
  const active = sort.key === sortKey
  return (
    <TableHead className={sortKey === 'mark' ? undefined : 'text-right'}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className="inline-flex items-center gap-1 uppercase tracking-wide transition-colors hover:text-foreground"
      >
        {label}
        <span className="text-[9px] leading-none">
          {active ? (sort.dir === 1 ? '▲' : '▼') : ''}
        </span>
      </button>
    </TableHead>
  )
}

/** Surface selector + suggested O₂ cut parameters per thickness for a profile. */
export function CutSettings({
  profile,
  dims,
  compact = false,
}: {
  profile: string
  dims: number[]
  compact?: boolean
}) {
  const { t } = useTranslation()
  const family = profileFamily(profile)
  const kind: 'open' | 'hollow' = family === 'tube' || family === 'round' ? 'hollow' : 'open'
  const defaultSurface: SurfaceCondition = kind === 'hollow' ? 'primed' : 'rust'
  const [surface, setSurface] = useState<SurfaceCondition>(defaultSurface)
  useEffect(() => setSurface(defaultSurface), [defaultSurface])
  const thicknesses = useMemo(() => sectionThicknesses(profile, dims), [profile, dims])
  const section = useMemo(() => partSectionForCode(profile, dims), [profile, dims])
  const rotationRadiusMm = useMemo(() => {
    if (!section || section.points.length === 0) return undefined
    const xs = section.points.map(([x]) => x)
    const ys = section.points.map(([, y]) => y)
    const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys))
    return span / 2
  }, [section])
  const governingThicknessMm =
    thicknesses.length > 0 ? Math.max(...thicknesses.map((thickness) => thickness.mm)) : undefined
  const suggestions = useMemo(
    () =>
      thicknesses.map((thickness) => ({
        thickness,
        cut: suggestCut(thickness.mm, surface, MACHINE, {
          kind,
          rotationRadiusMm,
          governingThicknessMm,
        }),
      })),
    [thicknesses, surface, kind, rotationRadiusMm, governingThicknessMm],
  )
  const labelWidth = compact ? 'w-28' : 'w-40'
  const cell = compact ? 'px-2 py-1' : 'px-3 py-1.5'
  return (
    <div className={cn('flex flex-col gap-3', compact && '@container')}>
      <fieldset
        className={cn(
          'm-0 grid gap-1.5 border-0 p-0',
          compact ? 'grid-cols-2 @[18rem]:grid-cols-4' : 'grid-cols-4',
        )}
      >
        <legend className="sr-only">{t('preflight.profileSettings.surface')}</legend>
        {SURFACES.map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setSurface(value)}
            className={cn(
              'min-w-0 truncate rounded-md border px-2 py-1 text-center text-[11px] transition-colors',
              surface === value
                ? 'border-primary bg-primary/15 text-foreground'
                : 'border-border text-muted-foreground hover:bg-accent hover:text-accent-foreground',
            )}
          >
            {t(`preflight.profileSettings.surfaces.${value}`)}
          </button>
        ))}
      </fieldset>

      {thicknesses.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t('preflight.profileSettings.noThickness')}
        </p>
      ) : (
        <div className="w-full overflow-x-auto rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className={cn('h-8', labelWidth)}>
                  {t('preflight.profileSettings.thickness')}
                </TableHead>
                {suggestions.map(({ thickness }) => (
                  <TableHead
                    key={`${thickness.role}-${thickness.mm}`}
                    className="h-8 w-20 text-right font-mono text-xs text-foreground"
                  >
                    {thickness.mm.toFixed(1)}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {PARAM_ROWS.map((row) => (
                <TableRow key={row.key}>
                  <TableCell
                    className={cn(
                      labelWidth,
                      cell,
                      'whitespace-nowrap text-xs text-muted-foreground',
                    )}
                  >
                    {t(`preflight.profileSettings.${row.key}`)}
                  </TableCell>
                  {row.key === 'nozzle' ? (
                    <TableCell
                      colSpan={suggestions.length}
                      className={cn(cell, 'text-center font-mono text-xs')}
                    >
                      {suggestions[0] ? row.value(suggestions[0].cut) : '—'}
                    </TableCell>
                  ) : (
                    suggestions.map(({ thickness, cut }) => (
                      <TableCell
                        key={`${row.key}-${thickness.role}-${thickness.mm}`}
                        className={cn(cell, 'w-20 text-right font-mono text-xs')}
                      >
                        {row.value(cut)}
                      </TableCell>
                    ))
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}

/** Draws the cross-section to scale, centred in a square viewBox. */
export function SectionPreview({
  section,
  label,
}: {
  section: ReturnType<typeof partSectionForCode>
  label: string
}) {
  const { t } = useTranslation()
  const drawing = useMemo(() => {
    if (!section) return null
    const rings = [section.points, ...(section.holes ?? [])]
    const transformed = rings.map((ring) => ring.map(([x, y]): [number, number] => [x, -y]))
    const points = transformed.flat()
    if (points.length === 0) return null
    const xs = points.map(([x]) => x)
    const ys = points.map(([, y]) => y)
    const minX = Math.min(...xs)
    const maxX = Math.max(...xs)
    const minY = Math.min(...ys)
    const maxY = Math.max(...ys)
    // Square viewBox on the section's largest dimension, so every profile's drawing occupies the
    // same visual size regardless of its aspect ratio (a wide UB and a square SHS stay consistent).
    const span = Math.max(maxX - minX, maxY - minY, 1)
    const half = span / 2 + span * 0.08
    const centreX = (minX + maxX) / 2
    const centreY = (minY + maxY) / 2
    const viewBox = `${centreX - half} ${centreY - half} ${half * 2} ${half * 2}`
    const path = transformed
      .map(
        (ring) =>
          `${ring.map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`).join(' ')} Z`,
      )
      .join(' ')
    return { viewBox, path }
  }, [section])

  return (
    <div className="flex aspect-square w-full flex-col gap-1.5 self-start rounded-lg border border-border bg-muted/20 p-2">
      {drawing ? (
        <svg
          viewBox={drawing.viewBox}
          role="img"
          aria-label={t('preflight.profileSettings.sectionAlt', { profile: label })}
          className="min-h-0 w-full flex-1"
        >
          <path
            d={drawing.path}
            fillRule="evenodd"
            className="fill-primary/20 stroke-primary"
            strokeWidth="1.5"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center text-xs text-muted-foreground">
          {t('preflight.profileSettings.noSection')}
        </div>
      )}
      <span className="w-full truncate text-center font-mono text-[11px] text-muted-foreground">
        {label}
      </span>
    </div>
  )
}
