import { useNavigate } from '@tanstack/react-router'
import { FolderOpen, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DropZone } from '@/components/DropZone'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog } from '@/components/ui/dialog'
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
  storageEstimate,
} from '@/lib/projects/store'
import type { InputBundle } from '@/lib/readInput'

const savedAtFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
})

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
  const [usage, setUsage] = useState<{ usage?: number; quota?: number }>({})
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<ProjectMeta | null>(null)

  const refresh = useCallback(async () => {
    try {
      setProjects(await listProjects())
      setUsage(await storageEstimate())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setProjects([])
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

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
          {usage.usage != null && usage.quota != null && (
            <span className="text-xs text-muted-foreground">
              {t('preflight.projects.usage', {
                used: formatBytes(usage.usage),
                quota: formatBytes(usage.quota),
              })}
            </span>
          )}
        </CardHeader>
        <CardContent>
          {projects === null ? (
            <p className="py-4 text-sm text-muted-foreground">{t('preflight.projects.loading')}</p>
          ) : projects.length === 0 ? (
            <p className="py-4 text-sm text-muted-foreground">
              {saving ? t('preflight.projects.saving') : t('preflight.projects.empty')}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>{t('preflight.projects.name')}</TableHead>
                  <TableHead className="w-px">{t('preflight.projects.saved')}</TableHead>
                  <TableHead className="w-px text-right">{t('preflight.projects.files')}</TableHead>
                  <TableHead className="w-px text-right">{t('preflight.projects.size')}</TableHead>
                  <TableHead className="w-px" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {projects.map((project) => (
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
