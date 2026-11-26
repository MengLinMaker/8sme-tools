import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import type { SatAnalysis, SatLoopEdge } from '@/lib/convert/sat'
import { type Outline, outlinePoints, type Pt } from '@/lib/sections/outline'

/**
 * A to-scale before/after view of the SAT cross-section.
 *
 * The fix is a section-shape change (split or chorded corners → one true arc per corner), so the
 * section is the honest place to see it. Both contours are drawn in the SAT's own XY frame: the
 * source as its individual edges (alternating arc colours make the splits visible) and the rebuilt
 * catalogue contour as a smooth green curve. The table/result still carries the measurements.
 */

const VIEW_WIDTH = 560
const VIEW_HEIGHT = 300
const PADDING = 22
const ARC_COLOURS = ['#fbbf24', '#f59e0b', '#facc15', '#fb923c']

/** Samples one source edge. Circular edges use the short sweep (a fillet is never a long arc). */
function edgePoints(edge: SatLoopEdge): Pt[] {
  if (edge.type === 'circle' && edge.center && edge.radius != null) {
    const [cx, cy] = edge.center
    const radius = edge.radius
    const a0 = Math.atan2(edge.p1[1] - cy, edge.p1[0] - cx)
    const a1 = Math.atan2(edge.p2[1] - cy, edge.p2[0] - cx)
    let delta = a1 - a0
    while (delta <= -Math.PI) delta += Math.PI * 2
    while (delta > Math.PI) delta -= Math.PI * 2
    if (Math.abs(delta) < 1e-6) delta = Math.PI * 2
    const steps = 16
    return Array.from({ length: steps + 1 }, (_, index) => {
      const angle = a0 + (delta * index) / steps
      return [cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius] as Pt
    })
  }
  return [
    [edge.p1[0], edge.p1[1]],
    [edge.p2[0], edge.p2[1]],
  ]
}

function arcCount(contour: Outline | undefined): number {
  return (contour?.edges ?? []).filter((edge) => edge.kind === 'arc' || edge.kind === 'circle')
    .length
}

export function SatSectionView({ analysis }: { analysis: SatAnalysis }) {
  const { t } = useTranslation()
  const [view, setView] = useState<'overlay' | 'source' | 'rebuilt'>('overlay')

  const source = analysis.section ?? []
  const sourceEdges = useMemo(() => source.map((edge) => edgePoints(edge)), [source])
  const rebuilt = useMemo(
    () => (analysis.plan ? outlinePoints(analysis.plan.contour, 24) : []),
    [analysis.plan],
  )

  const geometry = useMemo(() => {
    const points = [
      ...source.flatMap((edge) => [[edge.p1[0], edge.p1[1]] as Pt, [edge.p2[0], edge.p2[1]] as Pt]),
      ...rebuilt,
    ]
    if (points.length === 0) return null
    const xs = points.map(([x]) => x)
    const ys = points.map(([, y]) => y)
    const minX = Math.min(...xs)
    const maxX = Math.max(...xs)
    const minY = Math.min(...ys)
    const maxY = Math.max(...ys)
    const dx = Math.max(1e-6, maxX - minX)
    const dy = Math.max(1e-6, maxY - minY)
    const scale = Math.min((VIEW_WIDTH - PADDING * 2) / dx, (VIEW_HEIGHT - PADDING * 2) / dy)
    const offsetX = (VIEW_WIDTH - dx * scale) / 2
    const offsetY = (VIEW_HEIGHT - dy * scale) / 2
    const toScreen = ([x, y]: Pt): Pt => [
      offsetX + (x - minX) * scale,
      VIEW_HEIGHT - offsetY - (y - minY) * scale,
    ]
    return { toScreen }
  }, [source, rebuilt])

  if (!geometry || source.length === 0) return null

  const sourceArcs = analysis.cornerArcs
  const rebuiltArcs = arcCount(analysis.plan?.contour)
  const showSource = view !== 'rebuilt'
  const showRebuilt = view !== 'source'

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border px-3 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t('convert.preview.title')}
        </h2>
        <div className="flex items-center gap-1">
          {(['overlay', 'source', 'rebuilt'] as const).map((option) => (
            <Button
              key={option}
              size="sm"
              variant={view === option ? 'default' : 'outline'}
              onClick={() => setView(option)}
            >
              {t(`convert.preview.${option}`)}
            </Button>
          ))}
        </div>
      </div>

      <svg
        viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
        className="w-full rounded-md bg-muted/20"
        role="img"
        aria-label={t('convert.preview.title')}
      >
        {showRebuilt && rebuilt.length > 1 && (
          <>
            {/* A translucent green halo shows the rebuilt contour under the source's edge colours. */}
            <polyline
              points={rebuilt.map((point) => geometry.toScreen(point).join(',')).join(' ')}
              fill="none"
              stroke="#34d399"
              strokeWidth={7}
              strokeLinecap="round"
              strokeLinejoin="round"
              opacity={0.22}
            />
            <polyline
              points={rebuilt.map((point) => geometry.toScreen(point).join(',')).join(' ')}
              fill="none"
              stroke="#34d399"
              strokeWidth={1.4}
              strokeLinecap="round"
              strokeLinejoin="round"
              opacity={0.9}
            />
          </>
        )}
        {showSource &&
          sourceEdges.map((points, index) => {
            const screen = points.map(geometry.toScreen)
            const edge = source[index]
            const isArc = edge?.type === 'circle'
            const colour = isArc ? ARC_COLOURS[index % ARC_COLOURS.length] : '#94a3b8'
            const key = edge
              ? `source-${edge.type}-${edge.p1.join(',')}-${edge.p2.join(',')}`
              : 'source-edge'
            return (
              <polyline
                // The source edge geometry is stable; an index key would lose identity on re-order.
                key={key}
                points={screen.map(([x, y]) => `${x},${y}`).join(' ')}
                fill="none"
                stroke={colour}
                strokeWidth={2.2}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            )
          })}
      </svg>

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <div className="flex flex-wrap items-center gap-3">
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-amber-400" aria-hidden />
            {sourceArcs > 0
              ? t('convert.preview.sourceArcs', { count: sourceArcs })
              : t('convert.preview.sourceChords')}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-emerald-400" aria-hidden />
            {rebuiltArcs > 0
              ? t('convert.preview.rebuiltArcs', { count: rebuiltArcs })
              : t('convert.preview.noRebuild')}
          </span>
        </div>
        <span>{t('convert.preview.note')}</span>
      </div>
    </div>
  )
}
