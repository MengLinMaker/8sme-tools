import { useNavigate } from '@tanstack/react-router'
import { FolderOpen, Search, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DropZone } from '@/components/DropZone'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog } from '@/components/ui/dialog'
import { type ColumnSort, SortHead, toggleColumnSort } from '@/components/ui/sort-head'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { formatBytes } from '@/lib/format'
import {
  deleteProject,
  handOffProject,
  listProjects,
  type ProjectMeta,
  projectIdFor,
  putProjectFiles,
  requestPersistentStorage,
  type StorageFigures,
  storageFigures,
} from '@/lib/projects/store'
import type { InputBundle } from '@/lib/readInput'

const savedAtFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
})

/** Columns of the saved-projects table that can carry its sort. */
type ProjectSortKey = 'name' | 'saved' | 'files' | 'size'

/**
 * The preflight start page: drop a job to start (or resume) a project, and reopen one saved earlier.
 *
 * Saving happens on import; the project page keeps the stored files in step as they are added or
 * removed. Nothing leaves the browser, and the bytes live here until the project is deleted.
 */
export function ProjectsPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [projects, setProjects] = useState<ProjectMeta[] | null>(null)
  const [query, setQuery] = useState('')
  /** Saved projects open newest-first, the order a resumed job is most often in. */
  const [sort, setSort] = useState<ColumnSort<ProjectSortKey>>({ key: 'saved', dir: -1 })
  const [figures, setFigures] = useState<StorageFigures>({})
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<ProjectMeta | null>(null)

  const refresh = useCallback(async () => {
    try {
      setProjects(await listProjects())
      setFigures(await storageFigures())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setProjects([])
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const trimmedQuery = query.trim().toLowerCase()
  /** What saved jobs occupy — the part of the total the user can free by deleting one. */
  const projectBytes = useMemo(
    () => (projects ?? []).reduce((total, project) => total + project.size, 0),
    [projects],
  )

  /**
   * Bytes the total holds that are neither a saved project nor the offline cache: the saved fixes
   * and the browser's own bookkeeping. Only meaningful when the browser splits its usage down.
   */
  const otherBytes =
    figures.usage != null && figures.cached != null
      ? Math.max(0, figures.usage - projectBytes - figures.cached)
      : undefined

  /**
   * Hover breakdown of the total. A cache-dominated figure looks alarming on a machine with no
   * projects, so name the parts: jobs (which deleting frees), the app's offline copy, and the rest.
   */
  const usageHint = [
    t('preflight.projects.usageHint'),
    t('preflight.projects.usageProjects', { size: formatBytes(projectBytes) }),
    figures.cached != null
      ? t('preflight.projects.usageAppCache', { size: formatBytes(figures.cached) })
      : undefined,
    otherBytes ? t('preflight.projects.usageOther', { size: formatBytes(otherBytes) }) : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n')

  const filtered = useMemo(
    () =>
      (projects ?? []).filter(
        (project) => !trimmedQuery || project.name.toLowerCase().includes(trimmedQuery),
      ),
    [projects, trimmedQuery],
  )
  const sorted = useMemo(() => {
    const list = [...filtered]
    list.sort((a, b) => {
      const byColumn =
        sort.key === 'name'
          ? a.name.localeCompare(b.name, undefined, { numeric: true })
          : sort.key === 'saved'
            ? a.savedAt - b.savedAt
            : sort.key === 'files'
              ? a.fileCount - b.fileCount
              : a.size - b.size
      if (byColumn !== 0) return byColumn * sort.dir
      return a.name.localeCompare(b.name, undefined, { numeric: true })
    })
    return list
  }, [filtered, sort])
  /** Switch the projects sort: a new column starts ascending, the active one flips. */
  const sortBy = useCallback((key: ProjectSortKey) => {
    setSort((current) => toggleColumnSort(current, key))
  }, [])

  /** Import a dropped job: store it, then open it as a project. */
  const startProject = useCallback(
    async (bundle: InputBundle) => {
      setError(null)
      setSaving(true)
      try {
        const id = projectIdFor(bundle.entries)
        await putProjectFiles(id, bundle.sourceName, bundle.entries)
        void requestPersistentStorage()
        // Hand the parsed bundle straight to the project page; it only reads IndexedDB on reload.
        handOffProject(id, bundle)
        await navigate({ to: '/preflight/$projectId', params: { projectId: id } })
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setSaving(false)
      }
    },
    [navigate],
  )

  const openProject = useCallback(
    (id: string) => {
      void navigate({ to: '/preflight/$projectId', params: { projectId: id } })
    },
    [navigate],
  )

  const confirmDelete = useCallback(async () => {
    const project = pendingDelete
    setPendingDelete(null)
    if (!project) return
    try {
      await deleteProject(project.id)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [pendingDelete, refresh])

  return (
    <div className="flex flex-col gap-6">
      <DropZone onBundle={startProject} onError={setError} />

      {saving && <p className="text-xs text-muted-foreground">{t('preflight.projects.saving')}</p>}

      {error && (
        <div className="rounded-lg border border-destructive bg-destructive/10 px-3.5 py-3 text-sm text-destructive-foreground">
          {error}
        </div>
      )}

      <Card>
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-3">
          <CardTitle>{t('preflight.projects.title')}</CardTitle>
          <div className="flex flex-wrap items-center gap-3">
            {projects !== null && projects.length > 0 && (
              <div className="relative">
                <Search
                  className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
                  aria-hidden
                />
                <input
                  type="text"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t('preflight.projects.searchPlaceholder')}
                  aria-label={t('preflight.projects.searchPlaceholder')}
                  className="h-8 w-56 rounded-md border border-border bg-background pl-7 pr-7 text-sm text-foreground outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-ring"
                />
                {query && (
                  <button
                    type="button"
                    onClick={() => setQuery('')}
                    aria-label={t('preflight.projects.searchClear')}
                    title={t('preflight.projects.searchClear')}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
                  >
                    <X className="size-3.5" />
                  </button>
                )}
              </div>
            )}
            {projects !== null && figures.quota != null && (
              <span className="text-xs text-muted-foreground" title={usageHint}>
                {t('preflight.projects.usage', {
                  used: formatBytes(figures.usage ?? projectBytes),
                  quota: formatBytes(figures.quota),
                })}
              </span>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {projects === null ? (
            <p className="py-4 text-sm text-muted-foreground">{t('preflight.projects.loading')}</p>
          ) : projects.length === 0 ? (
            <p className="py-4 text-sm text-muted-foreground">
              {saving ? t('preflight.projects.saving') : t('preflight.projects.empty')}
            </p>
          ) : filtered.length === 0 ? (
            <p className="py-4 text-sm text-muted-foreground">
              {t('preflight.projects.searchEmpty', { query: query.trim() })}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <SortHead
                    label={t('preflight.projects.name')}
                    sortKey="name"
                    sort={sort}
                    onSort={sortBy}
                  />
                  <SortHead
                    label={t('preflight.projects.saved')}
                    sortKey="saved"
                    sort={sort}
                    onSort={sortBy}
                    width="w-px"
                  />
                  <SortHead
                    label={t('preflight.projects.files')}
                    sortKey="files"
                    sort={sort}
                    onSort={sortBy}
                    align="right"
                    width="w-px"
                  />
                  <SortHead
                    label={t('preflight.projects.size')}
                    sortKey="size"
                    sort={sort}
                    onSort={sortBy}
                    align="right"
                    width="w-px"
                  />
                  <TableHead className="w-px" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {sorted.map((project) => (
                  <TableRow
                    key={project.id}
                    className="cursor-pointer"
                    onClick={() => openProject(project.id)}
                  >
                    <TableCell className="font-mono text-xs">
                      <button
                        type="button"
                        onClick={() => openProject(project.id)}
                        className="flex items-center gap-1.5 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <FolderOpen
                          className="size-3.5 shrink-0 text-muted-foreground"
                          aria-hidden
                        />
                        {project.name}
                      </button>
                    </TableCell>
                    <TableCell className="w-px whitespace-nowrap text-xs text-muted-foreground">
                      {savedAtFormat.format(project.savedAt)}
                    </TableCell>
                    <TableCell className="w-px text-right font-mono text-xs tabular-nums text-muted-foreground">
                      {project.fileCount}
                    </TableCell>
                    <TableCell className="w-px text-right font-mono text-xs tabular-nums text-muted-foreground">
                      {formatBytes(project.size)}
                    </TableCell>
                    <TableCell className="w-px text-right">
                      <button
                        type="button"
                        title={t('preflight.projects.delete')}
                        aria-label={t('preflight.projects.delete', { name: project.name })}
                        onClick={(event) => {
                          event.stopPropagation()
                          setPendingDelete(project)
                        }}
                        className="rounded p-1 text-muted-foreground hover:text-destructive-foreground"
                      >
                        <Trash2 className="size-3.5" aria-hidden />
                      </button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        title={t('preflight.projects.deleteTitle')}
      >
        <div className="flex flex-col gap-4 p-5">
          <p className="text-sm text-muted-foreground">
            {pendingDelete
              ? t('preflight.projects.deleteHint', {
                  name: pendingDelete.name,
                  count: pendingDelete.fileCount,
                })
              : ''}
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setPendingDelete(null)}>
              {t('common.actions.cancel')}
            </Button>
            <Button size="sm" onClick={() => void confirmDelete()}>
              {t('preflight.projects.delete')}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  )
}
