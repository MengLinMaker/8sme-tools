import { Check, ChevronRight, Minus, X } from 'lucide-react'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DropZone } from '@/components/DropZone'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { type ColumnSort, SortHead, toggleColumnSort } from '@/components/ui/sort-head'
import { Table, TableBody, TableCell, TableHeader, TableRow } from '@/components/ui/table'
import { NEST_FILE } from '@/lib/audit/nestFiles'
import { formatNumber } from '@/lib/format'
import type { InputBundle } from '@/lib/readInput'
import { yieldToMain } from '@/lib/scheduler'
import { cn } from '@/lib/utils'
import { type NcexPackage, parseNexPackage } from '@/lib/wisecam/ncexParse'
import { summarizeNests } from '@/lib/wisecam/nestSummary'
import { NestMatchPrototype } from './NestMatchPrototype'

type NestSortKey = 'name' | 'nested' | 'packages'
const EMPTY_FILES: Set<string> = new Set()
/**
 * Direct hover / folder hover: strong green fill with a thick ring.
 *
 * These two colours are the source of the 3D cut palette: the first and second cut thicknesses in
 * the Preflight viewer reuse this green/purple pair, authored in OKLCH at one lightness and chroma
 * (`CUT_COLOURS` in `lib/parsers/ncProject.ts`) so neither hue reads dimmer than the other.
 */
const PRIMARY_ROW = 'bg-emerald-400/35 ring-2 ring-emerald-300'
/** Matched from the other panel: a distinct violet, one ring, lower fill. */
const SECONDARY_ROW = 'bg-violet-500/25 ring-1 ring-violet-300/70'
const SECONDARY_TABLE_ROW = 'bg-violet-500/25 ring-1 ring-inset ring-violet-300/70'

interface LoadedPackage {
  file: string
  package: NcexPackage
}

interface TreeFolder {
  name: string
  path: string
  files: LoadedPackage[]
  folders: TreeFolder[]
  /** Every file path at or below this folder. */
  descendants: string[]
}

function baseName(path: string): string {
  const parts = path.split('/')
  return parts[parts.length - 1] ?? path
}

function buildTree(packages: LoadedPackage[]): TreeFolder {
  const root: TreeFolder = { name: '', path: '', files: [], folders: [], descendants: [] }
  const folders = new Map<string, TreeFolder>([['', root]])
  for (const pkg of packages) {
    const segments = pkg.file.split('/')
    segments.pop()
    let parent = root
    let path = ''
    for (const segment of segments) {
      path = path ? `${path}/${segment}` : segment
      let node = folders.get(path)
      if (!node) {
        node = { name: segment, path, files: [], folders: [], descendants: [] }
        folders.set(path, node)
        parent.folders.push(node)
      }
      parent = node
    }
    parent.files.push(pkg)
  }
  const finalize = (node: TreeFolder) => {
    node.files.sort((a, b) =>
      baseName(a.file).localeCompare(baseName(b.file), undefined, { numeric: true }),
    )
    node.folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    for (const child of node.folders) finalize(child)
    node.descendants = [
      ...node.files.map((file) => file.file),
      ...node.folders.flatMap((child) => child.descendants),
    ]
  }
  finalize(root)
  return root
}

function selectionOf(node: TreeFolder, selected: Set<string>) {
  const total = node.descendants.length
  const count = node.descendants.filter((path) => selected.has(path)).length
  return {
    total,
    count,
    checked: total > 0 && count === total,
    indeterminate: count > 0 && count < total,
  }
}

function folderMatches(folder: TreeFolder, highlightedFiles: Set<string>): boolean {
  return folder.descendants.some((path) => highlightedFiles.has(path))
}

function sortFolders(folders: TreeFolder[], highlightedFiles: Set<string>): TreeFolder[] {
  return [...folders].sort(
    (a, b) =>
      Number(folderMatches(b, highlightedFiles)) - Number(folderMatches(a, highlightedFiles)) ||
      a.name.localeCompare(b.name, undefined, { numeric: true }),
  )
}

function sortFiles(files: LoadedPackage[], highlightedFiles: Set<string>): LoadedPackage[] {
  return [...files].sort(
    (a, b) =>
      Number(highlightedFiles.has(b.file)) - Number(highlightedFiles.has(a.file)) ||
      baseName(a.file).localeCompare(baseName(b.file), undefined, { numeric: true }),
  )
}

function TreeCheckbox({
  checked,
  indeterminate,
  label,
  onChange,
}: {
  checked: boolean
  indeterminate: boolean
  label: string
  onChange: () => void
}) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate
  }, [indeterminate])
  return (
    <label className="inline-flex size-4 shrink-0 cursor-pointer items-center justify-center">
      <input
        ref={ref}
        type="checkbox"
        checked={checked}
        onChange={onChange}
        aria-label={label}
        className="sr-only"
      />
      <span
        aria-hidden
        className={cn(
          'pointer-events-none flex size-4 items-center justify-center rounded-[3px] border transition-colors',
          checked
            ? 'border-primary bg-primary text-primary-foreground'
            : indeterminate
              ? 'border-primary text-primary'
              : 'border-muted-foreground/60 text-transparent',
        )}
      >
        {checked ? (
          <Check className="size-3" />
        ) : indeterminate ? (
          <Minus className="size-3" />
        ) : null}
      </span>
    </label>
  )
}

function FolderRows({
  folder,
  selected,
  primaryFiles,
  secondaryFiles,
  orderBy,
  onToggle,
  onHoverFiles,
}: {
  folder: TreeFolder
  selected: Set<string>
  primaryFiles: Set<string>
  secondaryFiles: Set<string>
  orderBy: Set<string>
  onToggle: (paths: string[], allSelected: boolean) => void
  onHoverFiles: (files: string[]) => void
}) {
  const { t } = useTranslation()
  const [collapsed, setCollapsed] = useState(false)
  const state = selectionOf(folder, selected)
  const secondary = folderMatches(folder, primaryFiles) || folderMatches(folder, secondaryFiles)
  const folders = sortFolders(folder.folders, orderBy)
  const files = sortFiles(folder.files, orderBy)
  const hasChildren = folder.folders.length > 0 || folder.files.length > 0
  const toggleCollapsed = () => setCollapsed((current) => !current)
  return (
    <li>
      <fieldset
        onMouseEnter={() => onHoverFiles(folder.descendants)}
        onMouseLeave={() => onHoverFiles([])}
        className={cn(
          'm-0 flex min-w-0 items-center gap-1.5 rounded border-0 p-0 px-1 py-0.5 text-xs transition-colors',
          secondary && SECONDARY_ROW,
          !secondary && 'hover:bg-accent/50',
        )}
      >
        <TreeCheckbox
          checked={state.checked}
          indeterminate={state.indeterminate}
          label={folder.path}
          onChange={() => onToggle(folder.descendants, state.checked)}
        />
        {hasChildren ? (
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-expanded={!collapsed}
            aria-label={
              collapsed
                ? t('nest.files.expand', { name: folder.name })
                : t('nest.files.collapse', { name: folder.name })
            }
            className="rounded p-0.5 text-muted-foreground hover:text-foreground"
          >
            <ChevronRight
              className={cn('size-3.5 transition-transform', !collapsed && 'rotate-90')}
            />
          </button>
        ) : (
          <span className="size-4 shrink-0" />
        )}
        <button
          type="button"
          onClick={hasChildren ? toggleCollapsed : undefined}
          className="min-w-0 truncate text-left font-medium hover:underline"
        >
          {folder.name}
        </button>
      </fieldset>
      {hasChildren && !collapsed && (
        <ul className="ml-4 border-l border-border pl-2">
          {folders.map((child) => (
            <FolderRows
              key={child.path}
              folder={child}
              selected={selected}
              primaryFiles={primaryFiles}
              secondaryFiles={secondaryFiles}
              orderBy={orderBy}
              onToggle={onToggle}
              onHoverFiles={onHoverFiles}
            />
          ))}
          {files.map((pkg) => {
            const isPrimary = primaryFiles.has(pkg.file)
            const isSecondary = !isPrimary && secondaryFiles.has(pkg.file)
            return (
              <li
                key={pkg.file}
                onMouseEnter={() => onHoverFiles([pkg.file])}
                onMouseLeave={() => onHoverFiles([])}
                className={cn(
                  'flex items-center gap-1.5 rounded px-1 py-0.5 text-xs transition-colors',
                  isPrimary && PRIMARY_ROW,
                  isSecondary && SECONDARY_ROW,
                  !isPrimary && !isSecondary && 'hover:bg-accent/50',
                )}
              >
                <TreeCheckbox
                  checked={selected.has(pkg.file)}
                  indeterminate={false}
                  label={pkg.file}
                  onChange={() => onToggle([pkg.file], selected.has(pkg.file))}
                />
                <span className="min-w-0 truncate font-mono" title={pkg.file}>
                  {baseName(pkg.file)}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </li>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-xl font-semibold">{formatNumber(value, 0)}</div>
    </div>
  )
}

/**
 * Counts the part names inside WiseCAM nestings.
 *
 * This is intentionally *not* a project check: nest names and project marks are spelled too
 * inconsistently to match reliably (`M_29` / `M-29`, `ITEM 35` / `12095, ITEM 35, …`). The page
 * reports what it can extract — each `Part.Name` as written and the pieces its results produce —
 * and lets the operator choose which files/folders take part.
 */
export function NestPage() {
  const { t } = useTranslation()
  const [packages, setPackages] = useState<LoadedPackage[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sort, setSort] = useState<ColumnSort<NestSortKey>>({ key: 'name', dir: 1 })
  const [expandedParts, setExpandedParts] = useState<Set<string>>(new Set())
  const [hoveredFiles, setHoveredFiles] = useState<Set<string>>(new Set())
  const [hoveredPart, setHoveredPart] = useState<string | null>(null)

  const ingest = async (bundle: InputBundle) => {
    const entries = bundle.entries.filter((entry) => NEST_FILE.test(entry.path))
    if (entries.length === 0) {
      setError(t('nest.empty'))
      return
    }
    setBusy(true)
    setError(null)
    try {
      const loaded: LoadedPackage[] = []
      for (const entry of entries) {
        loaded.push({ file: entry.path, package: parseNexPackage(entry.bytes) })
        await yieldToMain()
      }
      setPackages((current) => {
        const byPath = new Map(current.map((pkg) => [pkg.file, pkg]))
        for (const pkg of loaded) byPath.set(pkg.file, pkg)
        return [...byPath.values()].sort((a, b) => a.file.localeCompare(b.file))
      })
      setSelected((current) => {
        const next = new Set(current)
        for (const pkg of loaded) next.add(pkg.file)
        return next
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const tree = useMemo(() => buildTree(packages), [packages])
  const allNames = useMemo(() => {
    const names = new Set<string>()
    for (const pkg of packages) {
      for (const part of pkg.package.parts) {
        const name = part.name?.trim()
        if (name) names.add(name)
      }
    }
    return [...names].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  }, [packages])
  const selectedPackages = useMemo(
    () => packages.filter((pkg) => selected.has(pkg.file)),
    [packages, selected],
  )
  const summary = useMemo(() => summarizeNests(selectedPackages), [selectedPackages])
  const sortedNames = useMemo(() => {
    const direction = sort.dir
    return [...summary.names].sort((a, b) => {
      let compared = 0
      if (sort.key === 'nested') compared = a.nested - b.nested
      else if (sort.key === 'packages') compared = a.files.length - b.files.length
      else compared = a.name.localeCompare(b.name, undefined, { numeric: true })
      return compared * direction || a.name.localeCompare(b.name, undefined, { numeric: true })
    })
  }, [summary.names, sort])
  const displayedNames = useMemo(() => {
    if (hoveredFiles.size === 0) return sortedNames
    return [...sortedNames].sort((a, b) => {
      const aMatch = a.files.some((file) => hoveredFiles.has(file)) ? 1 : 0
      const bMatch = b.files.some((file) => hoveredFiles.has(file)) ? 1 : 0
      return bMatch - aMatch
    })
  }, [sortedNames, hoveredFiles])
  const filesByPart = useMemo(
    () => new Map(summary.names.map((row) => [row.name, new Set(row.files)])),
    [summary.names],
  )
  const secondaryFiles = hoveredPart ? (filesByPart.get(hoveredPart) ?? EMPTY_FILES) : EMPTY_FILES
  /** Sort only the panel that is NOT hovered; the panel under the cursor keeps its order. */
  const treeOrderFiles = secondaryFiles
  const rootFolders = sortFolders(tree.folders, treeOrderFiles)
  const rootFiles = sortFiles(tree.files, treeOrderFiles)
  const highlightedNested = useMemo(() => {
    if (hoveredPart) {
      return summary.names.find((row) => row.name === hoveredPart)?.nested ?? 0
    }
    if (hoveredFiles.size === 0) return null
    const seen = new Set<string>()
    let total = 0
    for (const pkg of selectedPackages) {
      if (!hoveredFiles.has(pkg.file)) continue
      for (const result of pkg.package.results) {
        if (seen.has(result.idref)) continue
        seen.add(result.idref)
        total += result.totalPieces
      }
    }
    return total
  }, [hoveredPart, hoveredFiles, selectedPackages, summary.names])

  const toggle = (paths: string[], allSelected: boolean) => {
    setSelected((current) => {
      const next = new Set(current)
      for (const path of paths) {
        if (allSelected) next.delete(path)
        else next.add(path)
      }
      return next
    })
  }
  const hoverFiles = (files: string[]) => {
    setHoveredFiles(new Set(files))
  }
  const selectAll = () => setSelected(new Set(packages.map((pkg) => pkg.file)))
  const selectNone = () => setSelected(new Set())
  const toggleExpanded = (name: string) => {
    setExpandedParts((current) => {
      const next = new Set(current)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }
  const clear = () => {
    setPackages([])
    setSelected(new Set())
    setExpandedParts(new Set())
    setError(null)
  }

  return (
    <div className="flex flex-col gap-6">
      <section className="max-w-3xl">
        <h1 className="mb-1.5 text-2xl font-bold tracking-tight">{t('nest.title')}</h1>
        <p className="text-muted-foreground">{t('nest.subtitle')}</p>
      </section>

      <DropZone
        onBundle={(bundle) => void ingest(bundle)}
        onError={setError}
        title={t('nest.dropTitle')}
        accept=".ncexa,.ncex"
        chooseLabel={t('nest.chooseFiles')}
        compact={packages.length > 0}
      />

      {busy && (
        <p role="status" className="text-sm text-muted-foreground">
          {t('nest.reading')}
        </p>
      )}
      {error && <p className="text-sm text-red-400">{error}</p>}

      {packages.length > 0 && (
        <div className="flex flex-col gap-6">
          <section className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            <Stat label={t('nest.summary.packages')} value={summary.totals.packages} />
            <Stat label={t('nest.summary.results')} value={summary.totals.results} />
            <Stat label={t('nest.summary.pieces')} value={summary.totals.pieces} />
            <Stat label={t('nest.summary.names')} value={summary.totals.names} />
            <Stat label={t('nest.summary.unnamed')} value={summary.totals.unnamed} />
          </section>

          <div className="grid gap-6 md:max-h-[calc(100dvh-22rem)] md:grid-cols-[minmax(16rem,0.8fr)_minmax(0,1.2fr)] md:items-start">
            <Card className="flex min-h-0 flex-col md:max-h-[calc(100dvh-22rem)] md:overflow-hidden">
              <CardHeader className="flex-row flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <CardTitle>{t('nest.files.title')}</CardTitle>
                  <span className="text-sm font-normal text-muted-foreground">
                    {t('nest.files.selected', {
                      selected: selectedPackages.length,
                      total: packages.length,
                    })}
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  <Button variant="ghost" size="sm" onClick={selectAll}>
                    {t('nest.files.all')}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={selectNone}>
                    {t('nest.files.none')}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={clear}>
                    <X />
                    {t('nest.clear')}
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="flex min-h-0 flex-1 flex-col gap-3">
                <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-border p-2">
                  <ul>
                    {rootFolders.map((folder) => (
                      <FolderRows
                        key={folder.path}
                        folder={folder}
                        selected={selected}
                        primaryFiles={hoveredFiles}
                        secondaryFiles={secondaryFiles}
                        orderBy={treeOrderFiles}
                        onToggle={toggle}
                        onHoverFiles={hoverFiles}
                      />
                    ))}
                    {rootFiles.map((pkg) => {
                      const isPrimary = hoveredFiles.has(pkg.file)
                      const isSecondary = !isPrimary && secondaryFiles.has(pkg.file)
                      return (
                        <li
                          key={pkg.file}
                          onMouseEnter={() => hoverFiles([pkg.file])}
                          onMouseLeave={() => hoverFiles([])}
                          className={cn(
                            'flex items-center gap-1.5 rounded px-1 py-0.5 text-xs transition-colors',
                            isPrimary && PRIMARY_ROW,
                            isSecondary && SECONDARY_ROW,
                            !isPrimary && !isSecondary && 'hover:bg-accent/50',
                          )}
                        >
                          <TreeCheckbox
                            checked={selected.has(pkg.file)}
                            indeterminate={false}
                            label={pkg.file}
                            onChange={() => toggle([pkg.file], selected.has(pkg.file))}
                          />
                          <span className="min-w-0 truncate font-mono" title={pkg.file}>
                            {baseName(pkg.file)}
                          </span>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              </CardContent>
            </Card>

            <Card className="flex min-h-0 flex-col md:max-h-[calc(100dvh-22rem)] md:overflow-hidden">
              <CardHeader className="flex-row flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <CardTitle>{t('nest.names.title')}</CardTitle>
                  <span className="text-sm font-normal text-muted-foreground">
                    ({summary.totals.names})
                  </span>
                  {highlightedNested != null && (
                    <Badge variant="info">
                      {t('nest.highlightedNested', {
                        count: formatNumber(highlightedNested, 0),
                      })}
                    </Badge>
                  )}
                </div>
              </CardHeader>
              <CardContent className="flex min-h-0 flex-1 flex-col gap-4">
                {selectedPackages.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t('nest.files.selectHint')}</p>
                ) : (
                  <>
                    {summary.totals.packagesWithoutResults > 0 && (
                      <p className="text-xs text-amber-400">
                        {t('nest.noResults', { count: summary.totals.packagesWithoutResults })}
                      </p>
                    )}
                    {summary.totals.unnamed > 0 && (
                      <p className="text-xs text-amber-400">
                        {t('nest.unnamedHint', { count: summary.totals.unnamed })}
                      </p>
                    )}

                    <Table containerClassName="min-h-0 flex-1 overflow-auto">
                      <TableHeader>
                        <TableRow className="hover:bg-transparent">
                          <SortHead
                            label={t('nest.names.written')}
                            sortKey="name"
                            sort={sort}
                            onSort={(key) => setSort((current) => toggleColumnSort(current, key))}
                            width="w-full"
                          />
                          <SortHead
                            label={t('nest.names.nested')}
                            sortKey="nested"
                            sort={sort}
                            onSort={(key) => setSort((current) => toggleColumnSort(current, key))}
                            align="right"
                            width="w-px"
                          />
                          <SortHead
                            label={t('nest.names.packages')}
                            sortKey="packages"
                            sort={sort}
                            onSort={(key) => setSort((current) => toggleColumnSort(current, key))}
                            align="right"
                            width="w-px"
                          />
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {displayedNames.map((row) => {
                          const highlighted =
                            hoveredFiles.size > 0 &&
                            row.files.some((file) => hoveredFiles.has(file))
                          const expanded = expandedParts.has(row.name)
                          return (
                            <Fragment key={row.name}>
                              <TableRow
                                onMouseEnter={() => setHoveredPart(row.name)}
                                onMouseLeave={() => setHoveredPart(null)}
                                className={cn(
                                  'transition-colors',
                                  highlighted && SECONDARY_TABLE_ROW,
                                )}
                              >
                                <TableCell>
                                  <div className="flex items-center gap-1.5">
                                    <button
                                      type="button"
                                      onClick={() => toggleExpanded(row.name)}
                                      aria-expanded={expanded}
                                      aria-label={t(
                                        expanded
                                          ? 'nest.names.hideSources'
                                          : 'nest.names.showSources',
                                        { name: row.name },
                                      )}
                                      className="rounded p-0.5 text-muted-foreground hover:text-foreground"
                                    >
                                      <ChevronRight
                                        className={cn(
                                          'size-3.5 transition-transform',
                                          expanded && 'rotate-90',
                                        )}
                                      />
                                    </button>
                                    <span className="font-mono text-xs">{row.name}</span>
                                  </div>
                                </TableCell>
                                <TableCell className="text-right tabular-nums">
                                  {formatNumber(row.nested, 0)}
                                </TableCell>
                                <TableCell className="text-right tabular-nums">
                                  {row.sources.length}
                                </TableCell>
                              </TableRow>
                              {expanded && (
                                <TableRow
                                  className="hover:bg-transparent"
                                  onMouseEnter={() => setHoveredPart(row.name)}
                                  onMouseLeave={() => setHoveredPart(null)}
                                >
                                  <TableCell colSpan={3} className="bg-muted/20 p-0">
                                    <div className="flex flex-col gap-1 px-8 py-2 text-xs">
                                      <span className="font-medium text-muted-foreground">
                                        {t('nest.names.sources')}
                                      </span>
                                      {row.sources.length === 0 ? (
                                        <span className="text-muted-foreground">
                                          {t('nest.names.noSources')}
                                        </span>
                                      ) : (
                                        row.sources.map((source) => (
                                          <div
                                            key={source.file}
                                            className="flex items-center justify-between gap-4"
                                          >
                                            <span
                                              className="min-w-0 truncate font-mono"
                                              title={source.file}
                                            >
                                              {baseName(source.file)}
                                            </span>
                                            <span className="shrink-0 tabular-nums">
                                              {formatNumber(source.quantity, 0)}
                                            </span>
                                          </div>
                                        ))
                                      )}
                                    </div>
                                  </TableCell>
                                </TableRow>
                              )}
                            </Fragment>
                          )
                        })}
                      </TableBody>
                    </Table>
                    {summary.names.length === 0 && (
                      <p className="text-sm text-muted-foreground">{t('nest.names.empty')}</p>
                    )}

                    {summary.findings.length > 0 && (
                      <div className="flex flex-col gap-1 text-xs">
                        <span className="font-medium text-muted-foreground">
                          {t('nest.findings')}
                        </span>
                        {summary.findings.map((finding) => (
                          <span
                            key={`${finding.code}-${finding.message}`}
                            className={
                              finding.severity === 'error' ? 'text-red-400' : 'text-amber-400'
                            }
                          >
                            {finding.message}
                          </span>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </CardContent>
            </Card>
          </div>
          <NestMatchPrototype names={allNames} />
        </div>
      )}
    </div>
  )
}
