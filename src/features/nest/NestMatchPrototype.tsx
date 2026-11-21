import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { DEFAULT_NEST_NAME_RULE, matchNestNames } from '@/lib/wisecam/nestNameRule'

/**
 * Prototype matcher: paste project marks, tune the two regexes, and see which nest names resolve.
 * This is deliberately a lab, not a silent auto-match — unmatched names stay in the table.
 */
export function NestMatchPrototype({ names }: { names: string[] }) {
  const { t } = useTranslation()
  const [projectText, setProjectText] = useState('')
  const [clean, setClean] = useState(DEFAULT_NEST_NAME_RULE.clean)
  const [extract, setExtract] = useState(DEFAULT_NEST_NAME_RULE.extract)

  const summary = useMemo(
    () => matchNestNames(names, projectText.split(/\r?\n/), { clean, extract }),
    [names, projectText, clean, extract],
  )

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-3">
        <CardTitle>{t('nest.match.title')}</CardTitle>
        <span className="text-xs uppercase tracking-wide text-muted-foreground">
          {t('nest.match.prototype')}
        </span>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-xs text-muted-foreground">{t('nest.match.hint')}</p>

        <div className="grid gap-3 lg:grid-cols-2">
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            {t('nest.match.projectMarks')}
            <textarea
              value={projectText}
              onChange={(event) => setProjectText(event.target.value)}
              placeholder={t('nest.match.projectPlaceholder')}
              rows={6}
              spellCheck={false}
              className="min-h-28 resize-y rounded-md border border-input bg-transparent p-2 font-mono text-xs text-foreground outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-ring"
            />
          </label>

          <div className="flex flex-col gap-2">
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              {t('nest.match.clean')}
              <input
                value={clean}
                onChange={(event) => setClean(event.target.value)}
                spellCheck={false}
                className="h-9 rounded-md border border-input bg-transparent px-2 font-mono text-xs text-foreground outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-ring"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              {t('nest.match.extract')}
              <input
                value={extract}
                onChange={(event) => setExtract(event.target.value)}
                spellCheck={false}
                className="h-9 rounded-md border border-input bg-transparent px-2 font-mono text-xs text-foreground outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-ring"
              />
            </label>
            <p className="text-xs text-muted-foreground">{t('nest.match.ruleHint')}</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Badge variant="success">{t('nest.match.matched', { count: summary.matched })}</Badge>
          <Badge variant="warning">{t('nest.match.unmatched', { count: summary.unmatched })}</Badge>
          <Badge variant="muted">
            {t('nest.match.missing', { count: summary.missingProjectMarks.length })}
          </Badge>
          {summary.ambiguous.length > 0 && (
            <Badge variant="warning">
              {t('nest.match.ambiguous', { count: summary.ambiguous.length })}
            </Badge>
          )}
        </div>

        {summary.error && <p className="text-sm text-red-400">{summary.error}</p>}

        <Table containerClassName="max-h-[45vh] overflow-auto">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>{t('nest.match.name')}</TableHead>
              <TableHead>{t('nest.match.key')}</TableHead>
              <TableHead>{t('nest.match.project')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {summary.rows.map((row) => (
              <TableRow key={row.name}>
                <TableCell className="font-mono text-xs">{row.name}</TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {row.key ?? '—'}
                </TableCell>
                <TableCell className="text-xs">
                  {row.matched ? (
                    <Badge variant="success">{row.projectMark}</Badge>
                  ) : (
                    <span className="text-amber-400">{t('nest.match.noProject')}</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}
