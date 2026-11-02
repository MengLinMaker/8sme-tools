/**
 * Cross-section preview + suggested O₂ cut parameters for one profile.
 *
 * Opened from the Profiles table in preflight. The section is drawn from the same builder the
 * stock ghost uses, and each distinct wall thickness gets one suggested recipe (flange/web for a
 * rolled section, wall for a hollow). Values come from `suggestCut`; the operator is expected to
 * verify them on scrap.
 */

import { ChevronLeft, ChevronRight } from 'lucide-react'
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
import { partSectionForCode, sectionThicknesses } from '@/lib/sections/stock'
import { cn } from '@/lib/utils'

const SURFACES: SurfaceCondition[] = ['normal', 'rust', 'primed', 'galvanised']

/** One row of the transposed settings table (parameters down, thicknesses across). */
const PARAM_ROWS: { key: string; value: (cut: CutSuggestion) => string }[] = [
  { key: 'power', value: (cut) => `${cut.powerPct}` },
  { key: 'speed', value: (cut) => `${cut.speedMinMmMin}–${cut.speedMaxMmMin}` },
  { key: 'focus', value: (cut) => `${cut.camFocusMm > 0 ? '+' : ''}${cut.camFocusMm}` },
  { key: 'standoff', value: (cut) => `${cut.heightMm}` },
  { key: 'pressure', value: (cut) => `${cut.pressureBar}` },
  { key: 'frequency', value: (cut) => `${cut.frequencyHz}` },
]

export interface ProfileSettingsDialogProps {
  open: boolean
  onClose: () => void
  profile: string
  dims: number[]
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
  onNavigate,
  canPrevious = false,
  canNext = false,
  position,
}: ProfileSettingsDialogProps) {
  const { t } = useTranslation()
  const [surface, setSurface] = useState<SurfaceCondition>('normal')

  const section = useMemo(() => partSectionForCode(profile, dims), [profile, dims])
  const thicknesses = useMemo(() => sectionThicknesses(profile, dims), [profile, dims])
  const suggestions = useMemo(
    () => thicknesses.map((thickness) => ({ thickness, cut: suggestCut(thickness.mm, surface) })),
    [thicknesses, surface],
  )

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
      <div className="grid gap-5 p-5 md:grid-cols-[14rem_minmax(0,1fr)]">
        <SectionPreview section={section} label={profile} />

        <div className="flex flex-col gap-3">
          <fieldset className="m-0 grid grid-cols-4 gap-1.5 border-0 p-0">
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
                    <TableHead className="h-8 w-40">
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
                      <TableCell className="w-40 whitespace-nowrap px-3 py-1.5 text-xs text-muted-foreground">
                        {t(`preflight.profileSettings.${row.key}`)}
                      </TableCell>
                      {suggestions.map(({ thickness, cut }) => (
                        <TableCell
                          key={`${row.key}-${thickness.role}-${thickness.mm}`}
                          className="w-20 px-3 py-1.5 text-right font-mono text-xs"
                        >
                          {row.value(cut)}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      </div>
    </Dialog>
  )
}

/** Draws the cross-section to scale, centred in a square viewBox. */
function SectionPreview({
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
    <div className="flex h-full min-h-40 w-40 flex-col gap-1.5 rounded-lg border border-border bg-muted/20 p-2 md:w-full">
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
