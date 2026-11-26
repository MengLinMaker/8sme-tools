import { ChevronRight, FileText, FileX, Filter, X } from 'lucide-react'
import { Fragment, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import type { AssemblyGroup, AssemblyMemberStatus } from '@/lib/audit/assemblySummary'
import { formatMass } from '@/lib/format'
import { cn } from '@/lib/utils'

/** The status a member's findings give it, as a pill the parts table would recognise. */
const STATUS_VARIANT: Record<AssemblyMemberStatus, 'destructive' | 'warning' | 'info' | 'success'> =
  {
    error: 'destructive',
    warning: 'warning',
    info: 'info',
    ok: 'success',
  }

/** `3`, `3 × 2 = 6`, or `—` when the part list gave no quantity. */
function quantity(qtyPerAssembly: number, assemblyQty: number, total: number): string {
  if (qtyPerAssembly <= 0) return '—'
  if (assemblyQty <= 1) return String(total)
  return `${qtyPerAssembly} × ${assemblyQty} = ${total}`
}

/** The drawing's own file name, for the row and the dialog header. */
function fileName(path: string): string {
  return path.split('/').pop() ?? path
}

/**
 * The assembly kit card: one row per assembly from the job's assembly part list, expanded to the
 * marks it needs, and a click through to the assembly's own drawing. It is a lens on the parts
 * table, not a second table — the funnel sets that filter, so the two views cannot disagree about
 * what a kit contains.
 */
export function AssembliesCard({
  groups,
  filter,
  onFilter,
  onOpenPart,
  onOpenDrawing,
  open,
  onOpenChange,
}: {
  groups: AssemblyGroup[]
  /** The assembly the parts table is filtered to, or null. */
  filter: string | null
  onFilter: (assembly: string | null) => void
  onOpenPart: (mark: string) => void
  /** Open the assembly's drawing; only assemblies the card flags with a drawing call it. */
  onOpenDrawing: (assembly: string) => void
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t, i18n } = useTranslation()
  const [expanded, setExpanded] = useState<string | null>(null)

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => onOpenChange(!open)}
          aria-expanded={open}
          className="flex min-w-0 items-center gap-2 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronRight
            className={cn(
              'size-4 shrink-0 text-muted-foreground transition-transform',
              open && 'rotate-90',
            )}
          />
          <CardTitle className="flex flex-wrap items-center gap-2">
            {t('preflight.assemblies.title')}
            <span className="text-sm font-normal text-muted-foreground">({groups.length})</span>
          </CardTitle>
        </button>
        {filter && (
          <Button variant="outline" size="sm" onClick={() => onFilter(null)}>
            <X className="size-3.5" />
            {t('preflight.assemblies.filterClear', { assembly: filter })}
          </Button>
        )}
      </CardHeader>
      {open && (
        <CardContent className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">
            {filter
              ? t('preflight.assemblies.filterHint', { assembly: filter })
              : t('preflight.assemblies.hint')}
          </p>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-8" />
                <TableHead>{t('preflight.assemblies.columns.assembly')}</TableHead>
                <TableHead className="text-right">
                  {t('preflight.assemblies.columns.parts')}
                </TableHead>
                <TableHead className="text-right">
                  {t('preflight.assemblies.columns.pieces')}
                </TableHead>
                <TableHead className="text-right">
                  {t('preflight.assemblies.columns.mass')}
                </TableHead>
                <TableHead>{t('preflight.assemblies.columns.status')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {groups.map((group) => {
                const isExpanded = expanded === group.assembly
                const isFiltered = filter === group.assembly
                const drawing = group.drawingPath
                return (
                  <Fragment key={group.assembly}>
                    <TableRow
                      className={cn(
                        isFiltered && 'bg-primary/10 hover:bg-primary/15',
                        drawing && 'cursor-pointer',
                      )}
                      onClick={drawing ? () => onOpenDrawing(group.assembly) : undefined}
                    >
                      <TableCell className="px-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-7"
                          onClick={(event) => {
                            event.stopPropagation()
                            setExpanded(isExpanded ? null : group.assembly)
                          }}
                          aria-expanded={isExpanded}
                          aria-label={t('preflight.assemblies.expand', {
                            assembly: group.assembly,
                          })}
                          title={t('preflight.assemblies.expand', { assembly: group.assembly })}
                        >
                          <ChevronRight
                            className={cn('size-4 transition-transform', isExpanded && 'rotate-90')}
                          />
                        </Button>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1.5">
                          <span className="whitespace-nowrap font-mono text-xs font-semibold">
                            {group.assembly}
                          </span>
                          {group.assemblyQty > 1 && (
                            <span className="whitespace-nowrap text-xs text-muted-foreground">
                              ×{group.assemblyQty}
                            </span>
                          )}
                          {drawing ? (
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation()
                                onOpenDrawing(group.assembly)
                              }}
                              aria-label={t('preflight.assemblies.openDrawing', {
                                assembly: group.assembly,
                              })}
                              title={fileName(drawing)}
                              className="rounded-md p-0.5 text-muted-foreground outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-ring"
                            >
                              <FileText className="size-3.5" />
                            </button>
                          ) : (
                            <span
                              title={t('preflight.assemblies.noDrawing')}
                              className="p-0.5 text-muted-foreground/50"
                            >
                              <FileX className="size-3.5" aria-hidden />
                              <span className="sr-only">{t('preflight.assemblies.noDrawing')}</span>
                            </span>
                          )}
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation()
                              onFilter(isFiltered ? null : group.assembly)
                            }}
                            aria-pressed={isFiltered}
                            aria-label={t('preflight.assemblies.filterRow', {
                              assembly: group.assembly,
                            })}
                            title={t('preflight.assemblies.filterRow', {
                              assembly: group.assembly,
                            })}
                            className={cn(
                              'rounded-md p-0.5 outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-ring',
                              isFiltered ? 'text-primary' : 'text-muted-foreground',
                            )}
                          >
                            <Filter className="size-3.5" />
                          </button>
                        </div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{group.marks}</TableCell>
                      <TableCell className="text-right tabular-nums">{group.pieces}</TableCell>
                      <TableCell className="whitespace-nowrap text-right font-mono text-xs">
                        {group.massKg > 0 ? formatMass(group.massKg, i18n.language) : '—'}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap items-center gap-1">
                          {group.errors > 0 && (
                            <Badge variant="destructive">
                              {t('preflight.assemblies.errorCount', { count: group.errors })}
                            </Badge>
                          )}
                          {group.missing > 0 && (
                            <Badge variant="warning">
                              {t('preflight.assemblies.missingCount', { count: group.missing })}
                            </Badge>
                          )}
                          {group.errors === 0 && group.missing === 0 && (
                            <Badge variant="success">{t('preflight.status.ok')}</Badge>
                          )}
                          {group.errors === 0 && group.missing === 0 && group.warnings > 0 && (
                            <Badge variant="warning">
                              {t('preflight.assemblies.warningCount', { count: group.warnings })}
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                    {isExpanded && (
                      <TableRow className="hover:bg-transparent">
                        <TableCell />
                        <TableCell colSpan={5} className="bg-muted/30 py-2">
                          <Table>
                            <TableHeader>
                              <TableRow className="hover:bg-transparent">
                                <TableHead className="pl-3">
                                  {t('preflight.assemblies.columns.mark')}
                                </TableHead>
                                <TableHead className="text-right">
                                  {t('preflight.assemblies.columns.qty')}
                                </TableHead>
                                <TableHead>{t('preflight.assemblies.columns.profile')}</TableHead>
                                <TableHead className="text-right">
                                  {t('preflight.assemblies.columns.status')}
                                </TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {group.members.map((member) => (
                                <TableRow key={member.mark} className="hover:bg-muted/40">
                                  <TableCell className="pl-3">
                                    <button
                                      type="button"
                                      onClick={() => onOpenPart(member.mark)}
                                      title={t('preflight.assemblies.openPart', {
                                        mark: member.mark,
                                      })}
                                      className="rounded-md font-mono text-xs font-semibold outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-ring"
                                    >
                                      {member.mark}
                                    </button>
                                  </TableCell>
                                  <TableCell className="whitespace-nowrap text-right font-mono text-xs tabular-nums">
                                    {quantity(
                                      member.qtyPerAssembly,
                                      group.assemblyQty,
                                      member.total,
                                    )}
                                  </TableCell>
                                  <TableCell className="font-mono text-xs">
                                    {member.profile}
                                  </TableCell>
                                  <TableCell className="text-right">
                                    <div className="flex flex-wrap items-center justify-end gap-1">
                                      <Badge variant={STATUS_VARIANT[member.status]}>
                                        {t(`preflight.status.${member.status}`)}
                                      </Badge>
                                      {!member.present && (
                                        <Badge
                                          variant="muted"
                                          title={t('preflight.assemblies.missingHint')}
                                        >
                                          {t('preflight.assemblies.missingBadge')}
                                        </Badge>
                                      )}
                                    </div>
                                  </TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                )
              })}
            </TableBody>
          </Table>
        </CardContent>
      )}
    </Card>
  )
}
