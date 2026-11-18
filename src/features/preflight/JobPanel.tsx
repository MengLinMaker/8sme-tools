import { ChevronRight, Folder, Trash2 } from 'lucide-react'
import { Fragment, type ReactNode, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DropZone } from '@/components/DropZone'
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
import { formatBytes } from '@/lib/format'
import type { InputBundle } from '@/lib/readInput'
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

function kindOf(path: string): string {
  const name = baseName(path)
  const dot = name.lastIndexOf('.')
  const ext = dot < 0 ? '' : name.slice(dot + 1).toLowerCase()
  return KIND_LABEL[ext] ?? (ext ? ext.toUpperCase() : '—')
}

/** One folder in the job's tree; `path` is its full folder path (`''` for the job root). */
interface TreeNode {
  /** Last path segment, used as the label. */
  name: string
  path: string
  /** Files directly in this folder. */
  files: ZipEntry[]
  folders: TreeNode[]
  /** Files in this folder and everything below it. */
  count: number
  bytes: number
}

function emptyNode(name: string, path: string): TreeNode {
  return { name, path, files: [], folders: [], count: 0, bytes: 0 }
}

/** Builds the folder tree, then sorts and totals it bottom-up. */
function buildTree(entries: ZipEntry[]): TreeNode {
  const root = emptyNode('', '')
  const folders = new Map<string, TreeNode>([['', root]])

  for (const entry of entries) {
    const segments = entry.path.split('/')
    segments.pop()
    let parent = root
    let path = ''
    for (const segment of segments) {
      path = path === '' ? segment : `${path}/${segment}`
      let node = folders.get(path)
      if (!node) {
        node = emptyNode(segment, path)
        folders.set(path, node)
        parent.folders.push(node)
      }
      parent = node
    }
    parent.files.push(entry)
  }

  const sortAndTotal = (node: TreeNode) => {
    node.files.sort((a, b) =>
      baseName(a.path).localeCompare(baseName(b.path), undefined, { numeric: true }),
    )
    node.folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    for (const child of node.folders) sortAndTotal(child)
    node.count = node.files.length + node.folders.reduce((sum, child) => sum + child.count, 0)
    node.bytes =
      node.files.reduce((sum, file) => sum + file.bytes.length, 0) +
      node.folders.reduce((sum, child) => sum + child.bytes, 0)
  }
  sortAndTotal(root)
  return root
}

/** Every file path at or below a folder — what its delete action removes. */
function pathsIn(node: TreeNode): string[] {
  const paths = node.files.map((file) => file.path)
  for (const child of node.folders) paths.push(...pathsIn(child))
  return paths
}

/** Indentation for a tree row: one folder level per 14px. */
function indent(depth: number) {
  return { paddingLeft: `${8 + depth * 14}px` }
}

/**
 * The loaded job: its name, a drop target that **adds** files to it, and a collapsible folder tree
 * with a remove action per file and per folder.
 *
 * Everything is session state — the original `.zip` is untouched. Removing (or replacing) a file
 * drops the affected part's applied fixes with it, because an NC edit is indexed into the NC text it
 * was made against.
 */
export function JobPanel({
  sourceName,
  entries,
  onAdd,
  onError,
  onDelete,
}: {
  sourceName: string
  entries: ZipEntry[]
  /** Adds files to the job; same-path entries replace, everything else is kept. */
  onAdd: (bundle: InputBundle) => void
  onError?: (message: string) => void
  onDelete: (paths: string[]) => void
}) {
  const { t } = useTranslation()
  // Collapsed by default: the header already says which job is loaded and how big it is.
  const [open, setOpen] = useState(false)
  /** Folder paths the operator has expanded; empty means just the root's own files. */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const tree = useMemo(() => buildTree(entries), [entries])
  const totalBytes = tree.bytes

  const toggleFolder = (path: string) => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  /** A file row, indented under its folder. */
  const fileRow = (entry: ZipEntry, depth: number) => (
    <TableRow key={entry.path}>
      <TableCell className="font-mono text-xs" title={entry.path} style={indent(depth)}>
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
  )

  /** A folder row plus, when expanded, its files and subfolders. */
  const folderRows = (node: TreeNode, depth: number): ReactNode => {
    const isOpen = expanded.has(node.path)
    return (
      <Fragment key={node.path}>
        <TableRow className="bg-muted/40 hover:bg-muted/40">
          <TableCell className="py-1.5" colSpan={2} style={indent(depth)}>
            <button
              type="button"
              aria-expanded={isOpen}
              onClick={() => toggleFolder(node.path)}
              className="flex items-center gap-1.5 rounded-sm text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ChevronRight
                className={cn(
                  'size-3.5 shrink-0 text-muted-foreground transition-transform',
                  isOpen && 'rotate-90',
                )}
                aria-hidden
              />
              <Folder className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <span className="font-mono">{node.name}/</span>
              <span className="text-muted-foreground">
                {t('preflight.files.count', { count: node.count })}
              </span>
            </button>
          </TableCell>
          <TableCell className="py-1.5 text-right font-mono text-xs text-muted-foreground">
            {formatBytes(node.bytes)}
          </TableCell>
          <TableCell className="py-1.5 text-right">
            <button
              type="button"
              title={t('preflight.files.deleteFolder', { folder: node.path })}
              aria-label={t('preflight.files.deleteFolder', { folder: node.path })}
              onClick={() => onDelete(pathsIn(node))}
              className="rounded p-1 text-muted-foreground hover:text-destructive-foreground"
            >
              <Trash2 className="size-3.5" aria-hidden />
            </button>
          </TableCell>
        </TableRow>
        {isOpen && (
          <>
            {node.files.map((file) => fileRow(file, depth + 1))}
            {node.folders.map((child) => folderRows(child, depth + 1))}
          </>
        )}
      </Fragment>
    )
  }

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
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
            <span className="text-xs uppercase tracking-wide text-muted-foreground">
              {t('preflight.source')}
            </span>
            <span className="truncate font-mono text-base font-semibold">{sourceName}</span>
            <span className="text-sm font-normal text-muted-foreground">
              (
              {t('preflight.files.total', { count: entries.length, size: formatBytes(totalBytes) })}
              )
            </span>
          </CardTitle>
        </button>
      </CardHeader>
      {open && (
        <CardContent className="flex flex-col gap-3">
          <DropZone compact title={t('dropzone.addTitle')} onBundle={onAdd} onError={onError} />
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
              {entries.length === 0 && (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={4} className="text-sm text-muted-foreground">
                    {t('preflight.files.empty')}
                  </TableCell>
                </TableRow>
              )}
              {tree.files.map((file) => fileRow(file, 0))}
              {tree.folders.map((folder) => folderRows(folder, 0))}
            </TableBody>
          </Table>
        </CardContent>
      )}
    </Card>
  )
}
