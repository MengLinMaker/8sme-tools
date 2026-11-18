import { ChevronDown, FolderOpen, Trash2 } from 'lucide-react'
import { Fragment, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge'
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
import { cn } from '@/lib/utils'
import type { ZipEntry } from '@/lib/zip'

/** Extensions the job uses, shown as a short badge; anything else shows its own extension. */
const KIND_LABEL: Record<string, string> = {
  nc1: 'NC',
  nc: 'NC',
  stp: 'STEP',
  step: 'STEP',
  pdf: 'PDF',
  xlsx: 'XLSX',
  xlsm: 'XLSX',
  xls: 'XLSX',
  zip: 'ZIP',
  rar: 'RAR',
}

/** A file's own name, without its folder path. */
function baseName(path: string): string {
  const parts = path.split('/')
  return parts[parts.length - 1] ?? path
}

/** The folder a file sits in (`''` for the job root). */
function folderOf(path: string): string {
  const index = path.lastIndexOf('/')
  return index < 0 ? '' : path.slice(0, index)
}

function kindOf(path: string): string {
  const name = baseName(path)
  const dot = name.lastIndexOf('.')
  const ext = dot < 0 ? '' : name.slice(dot + 1).toLowerCase()
  return KIND_LABEL[ext] ?? (ext ? ext.toUpperCase() : '—')
}

/** Human-readable byte size (`1.2 MB`), since a job is mostly megabytes of STEP. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${Math.round(kb)} KB`
  return `${(kb / 1024).toFixed(1)} MB`
}

interface FileGroup {
  /** Folder path, `''` for the job root. */
  folder: string
  entries: ZipEntry[]
  bytes: number
}

/** Entries grouped by folder: root first, then folders and files alphabetically. */
function groupFiles(entries: ZipEntry[]): FileGroup[] {
  const groups = new Map<string, FileGroup>()
  for (const entry of entries) {
    const folder = folderOf(entry.path)
    const group = groups.get(folder) ?? { folder, entries: [], bytes: 0 }
    group.entries.push(entry)
    group.bytes += entry.bytes.length
    groups.set(folder, group)
  }
  const list = [...groups.values()]
  for (const group of list) {
    group.entries.sort((a, b) =>
      baseName(a.path).localeCompare(baseName(b.path), undefined, { numeric: true }),
    )
  }
  return list.sort((a, b) => {
    if (a.folder === b.folder) return 0
    if (a.folder === '') return -1
    if (b.folder === '') return 1
    return a.folder.localeCompare(b.folder, undefined, { numeric: true })
  })
}

/**
 * The files currently loaded in the job, grouped by folder, with a remove action per file, per
 * folder and for the whole job. Everything lives in memory for this session — removing a file drops
 * it from the set the audit re-runs over, and the affected part's applied fixes with it, because an
 * NC edit is indexed into the NC text it was made against.
 */
export function FilesPanel({
  entries,
  onDelete,
  onDeleteAll,
}: {
  entries: ZipEntry[]
  onDelete: (paths: string[]) => void
  onDeleteAll: () => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [confirmAll, setConfirmAll] = useState(false)
  const groups = useMemo(() => groupFiles(entries), [entries])
  const totalBytes = useMemo(
    () => entries.reduce((sum, entry) => sum + entry.bytes.length, 0),
    [entries],
  )

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          aria-expanded={open}
          className="flex items-center gap-2 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronDown
            className={cn(
              'size-4 shrink-0 text-muted-foreground transition-transform',
              !open && '-rotate-90',
            )}
          />
          <CardTitle className="flex flex-wrap items-center gap-2">
            {t('preflight.files.title')}
            <span className="text-sm font-normal text-muted-foreground">
              (
              {t('preflight.files.total', { count: entries.length, size: formatBytes(totalBytes) })}
              )
            </span>
          </CardTitle>
        </button>
        <Button
          variant="outline"
          size="sm"
          disabled={entries.length === 0}
          onClick={() => setConfirmAll(true)}
        >
          {t('preflight.files.deleteAll')}
        </Button>
      </CardHeader>
      {open && (
        <CardContent>
          <Table containerClassName="max-h-[50vh] overflow-auto">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>{t('preflight.files.file')}</TableHead>
                <TableHead className="w-px">{t('preflight.files.kind')}</TableHead>
                <TableHead className="w-px text-right">{t('preflight.files.size')}</TableHead>
                <TableHead className="w-px" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {groups.map((group) => (
                <Fragment key={group.folder || '/'}>
                  <TableRow className="bg-muted/40 hover:bg-muted/40">
                    <TableCell className="py-1.5" colSpan={2}>
                      <span className="flex items-center gap-1.5 text-xs">
                        <FolderOpen
                          className="size-3.5 shrink-0 text-muted-foreground"
                          aria-hidden
                        />
                        <span className="font-mono">
                          {group.folder === '' ? t('preflight.files.root') : `${group.folder}/`}
                        </span>
                        <span className="text-muted-foreground">
                          {t('preflight.files.count', { count: group.entries.length })}
                        </span>
                      </span>
                    </TableCell>
                    <TableCell className="py-1.5 text-right font-mono text-xs text-muted-foreground">
                      {formatBytes(group.bytes)}
                    </TableCell>
                    <TableCell className="py-1.5 text-right">
                      <button
                        type="button"
                        title={t('preflight.files.deleteFolder', { folder: group.folder || '.' })}
                        aria-label={t('preflight.files.deleteFolder', {
                          folder: group.folder || '.',
                        })}
                        onClick={() => onDelete(group.entries.map((entry) => entry.path))}
                        className="rounded p-1 text-muted-foreground hover:text-destructive-foreground"
                      >
                        <Trash2 className="size-3.5" aria-hidden />
                      </button>
                    </TableCell>
                  </TableRow>
                  {group.entries.map((entry) => (
                    <TableRow key={entry.path}>
                      <TableCell className="font-mono text-xs" title={entry.path}>
                        {baseName(entry.path)}
                      </TableCell>
                      <TableCell className="w-px">
                        <Badge variant="muted" className="font-mono">
                          {kindOf(entry.path)}
                        </Badge>
                      </TableCell>
                      <TableCell className="w-px text-right font-mono text-xs tabular-nums text-muted-foreground">
                        {formatBytes(entry.bytes.length)}
                      </TableCell>
                      <TableCell className="w-px text-right">
                        <button
                          type="button"
                          title={t('preflight.files.delete', { name: baseName(entry.path) })}
                          aria-label={t('preflight.files.delete', { name: baseName(entry.path) })}
                          onClick={() => onDelete([entry.path])}
                          className="rounded p-1 text-muted-foreground hover:text-destructive-foreground"
                        >
                          <Trash2 className="size-3.5" aria-hidden />
                        </button>
                      </TableCell>
                    </TableRow>
                  ))}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      )}
      <Dialog
        open={confirmAll}
        onClose={() => setConfirmAll(false)}
        title={t('preflight.files.deleteAllTitle')}
      >
        <div className="flex flex-col gap-4 p-5">
          <p className="text-sm text-muted-foreground">
            {t('preflight.files.deleteAllHint', { count: entries.length })}
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setConfirmAll(false)}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              size="sm"
              onClick={() => {
                setConfirmAll(false)
                onDeleteAll()
              }}
            >
              {t('preflight.files.deleteAll')}
            </Button>
          </div>
        </div>
      </Dialog>
    </Card>
  )
}
