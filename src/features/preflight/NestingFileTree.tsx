import { Check, ChevronRight, Minus } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'

interface TreeFile {
  path: string
}

interface TreeFolder {
  name: string
  path: string
  files: TreeFile[]
  folders: TreeFolder[]
  descendants: string[]
}

function baseName(path: string): string {
  const parts = path.split('/')
  return parts[parts.length - 1] ?? path
}

function buildTree(paths: string[]): TreeFolder {
  const root: TreeFolder = { name: '', path: '', files: [], folders: [], descendants: [] }
  const folders = new Map<string, TreeFolder>([['', root]])
  for (const filePath of paths) {
    const segments = filePath.split('/')
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
    parent.files.push({ path: filePath })
  }
  const finalize = (node: TreeFolder) => {
    node.files.sort((a, b) =>
      baseName(a.path).localeCompare(baseName(b.path), undefined, { numeric: true }),
    )
    node.folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    for (const child of node.folders) finalize(child)
    node.descendants = [
      ...node.files.map((file) => file.path),
      ...node.folders.flatMap((child) => child.descendants),
    ]
  }
  finalize(root)
  return root
}

function matchCount(node: TreeFolder, selected: Set<string>): { count: number; total: number } {
  const total = node.descendants.length
  const count = node.descendants.filter((path) => selected.has(path)).length
  return { count, total }
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

/**
 * Bars actually cut, typed by the operator. The `.ncexa` has no cut-progress field, and NcStudio
 * keeps its counts on the controller (`TaskListInfo.tld` / run report), so this is the only
 * record the app can hold — see `docs/architecture.md` §18.
 */
function CutInput({
  file,
  planned,
  cut,
  onChange,
}: {
  file: string
  planned: number
  cut: number
  onChange: (file: string, value: number) => void
}) {
  if (planned <= 0) return null
  return (
    <span className="flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground">
      <input
        type="number"
        min={0}
        step={1}
        value={cut}
        onChange={(event) => {
          const value = Number(event.target.value)
          onChange(file, Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0)
        }}
        aria-label={`Cut count for ${baseName(file)}`}
        className="h-5 w-10 rounded border border-input bg-transparent px-1 text-right tabular-nums text-foreground outline-none focus-visible:border-primary focus-visible:ring-1 focus-visible:ring-ring"
      />
      <span>/{planned}</span>
    </span>
  )
}

function FolderRows({
  folder,
  selected,
  primaryFiles,
  secondaryFiles,
  plannedByFile,
  cutByFile,
  onToggle,
  onHoverFiles,
  onCutChange,
}: {
  folder: TreeFolder
  selected: Set<string>
  primaryFiles: Set<string>
  secondaryFiles: Set<string>
  plannedByFile: Map<string, number>
  cutByFile: Map<string, number>
  onToggle: (paths: string[], allSelected: boolean) => void
  onHoverFiles: (files: string[]) => void
  onCutChange: (file: string, value: number) => void
}) {
  const { t } = useTranslation()
  const [collapsed, setCollapsed] = useState(false)
  const state = matchCount(folder, selected)
  const checked = state.total > 0 && state.count === state.total
  const indeterminate = state.count > 0 && state.count < state.total
  const hasChildren = folder.folders.length > 0 || folder.files.length > 0
  const toggleCollapsed = () => setCollapsed((current) => !current)
  const folders = folder.folders
  const files = [...folder.files].sort((a, b) =>
    baseName(a.path).localeCompare(baseName(b.path), undefined, { numeric: true }),
  )

  return (
    <li>
      <fieldset
        onMouseEnter={() => onHoverFiles(folder.descendants)}
        onMouseLeave={() => onHoverFiles([])}
        className="m-0 flex w-full min-w-0 items-center gap-1.5 rounded border-0 p-0 px-1 py-0.5 text-xs transition-colors"
      >
        <TreeCheckbox
          checked={checked}
          indeterminate={indeterminate}
          label={folder.path}
          onChange={() => onToggle(folder.descendants, checked)}
        />
        {hasChildren ? (
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-expanded={!collapsed}
            aria-label={
              collapsed
                ? t('preflight.nestingCoverage.expand', { name: folder.name })
                : t('preflight.nestingCoverage.collapse', { name: folder.name })
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
              plannedByFile={plannedByFile}
              cutByFile={cutByFile}
              onToggle={onToggle}
              onHoverFiles={onHoverFiles}
              onCutChange={onCutChange}
            />
          ))}
          {files.map((file) => {
            const primary = primaryFiles.has(file.path)
            const isSecondary = !primary && secondaryFiles.has(file.path)
            return (
              <li
                key={file.path}
                onMouseEnter={() => onHoverFiles([file.path])}
                onMouseLeave={() => onHoverFiles([])}
                className={cn(
                  'flex items-center gap-1.5 rounded px-1 py-0.5 text-xs transition-colors',
                  primary && 'bg-emerald-400/35 ring-2 ring-inset ring-emerald-300',
                  isSecondary && 'bg-emerald-400/35 ring-2 ring-inset ring-emerald-300',
                  !primary && !isSecondary && 'hover:bg-accent/50',
                )}
              >
                <TreeCheckbox
                  checked={selected.has(file.path)}
                  indeterminate={false}
                  label={file.path}
                  onChange={() => onToggle([file.path], selected.has(file.path))}
                />
                <span className="min-w-0 flex-1 truncate font-mono" title={file.path}>
                  {baseName(file.path)}
                </span>
                <CutInput
                  file={file.path}
                  planned={plannedByFile.get(file.path) ?? 0}
                  cut={cutByFile.get(file.path) ?? 0}
                  onChange={onCutChange}
                />
              </li>
            )
          })}
        </ul>
      )}
    </li>
  )
}

export function NestingFileTree({
  paths,
  selected,
  primaryFiles,
  secondaryFiles,
  plannedByFile,
  cutByFile,
  onToggle,
  onHoverFiles,
  onCutChange,
}: {
  paths: string[]
  selected: Set<string>
  primaryFiles: Set<string>
  secondaryFiles: Set<string>
  plannedByFile: Map<string, number>
  cutByFile: Map<string, number>
  onToggle: (paths: string[], allSelected: boolean) => void
  onHoverFiles: (files: string[]) => void
  onCutChange: (file: string, value: number) => void
}) {
  const tree = buildTree(paths)
  return (
    <ul>
      {tree.folders.map((folder) => (
        <FolderRows
          key={folder.path}
          folder={folder}
          selected={selected}
          primaryFiles={primaryFiles}
          secondaryFiles={secondaryFiles}
          plannedByFile={plannedByFile}
          cutByFile={cutByFile}
          onToggle={onToggle}
          onHoverFiles={onHoverFiles}
          onCutChange={onCutChange}
        />
      ))}
      {tree.files.map((file) => {
        const primary = primaryFiles.has(file.path)
        const isSecondary = !primary && secondaryFiles.has(file.path)
        return (
          <li
            key={file.path}
            onMouseEnter={() => onHoverFiles([file.path])}
            onMouseLeave={() => onHoverFiles([])}
            className={cn(
              'flex items-center gap-1.5 rounded px-1 py-0.5 text-xs transition-colors',
              primary && 'bg-emerald-400/35 ring-2 ring-inset ring-emerald-300',
              isSecondary && 'bg-emerald-400/35 ring-2 ring-inset ring-emerald-300',
              !primary && !isSecondary && 'hover:bg-accent/50',
            )}
          >
            <TreeCheckbox
              checked={selected.has(file.path)}
              indeterminate={false}
              label={file.path}
              onChange={() => onToggle([file.path], selected.has(file.path))}
            />
            <span className="min-w-0 flex-1 truncate font-mono" title={file.path}>
              {baseName(file.path)}
            </span>
            <CutInput
              file={file.path}
              planned={plannedByFile.get(file.path) ?? 0}
              cut={cutByFile.get(file.path) ?? 0}
              onChange={onCutChange}
            />
          </li>
        )
      })}
    </ul>
  )
}
