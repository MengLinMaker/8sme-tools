import { isRar, readRar } from './rar'
import { isZip, readZip, type ZipEntry } from './zip'

/** Guard against archive bombs / pathological nesting: stop expanding past this many layers. */
const MAX_ARCHIVE_DEPTH = 5

export interface InputBundle {
  sourceName: string
  entries: ZipEntry[]
}

/** Prefixes an inner archive's entries with the archive's own path (minus extension) so two
 *  nested archives can never collide on a filename. */
function prefixArchivePath(archivePath: string, innerPath: string): string {
  const stem = archivePath.replace(/\.[^./]+$/, '')
  return innerPath ? `${stem}/${innerPath}` : stem
}

/** Whether an entry should be opened as a job archive. Keyed on extension so document containers
 *  that happen to be zips (`.xlsx`, `.docx`, …) are never mistaken for archives; an extensionless
 *  file falls back to its magic bytes. */
function isArchiveEntry(path: string, bytes: Uint8Array): boolean {
  const dot = path.lastIndexOf('.')
  const ext = dot >= 0 ? path.slice(dot + 1).toLowerCase() : ''
  if (ext === 'zip' || ext === 'rar') return true
  if (ext) return false
  return isZip(bytes) || isRar(bytes)
}

/**
 * Recursively expands every zip/rar entry into its contents, so a job archive that nests further
 * archives (or folders of them) surfaces files at **any** depth, not just the first layer. Nested
 * entries are prefixed with the archive's path to keep them unique. Shared by zip and rar.
 */
export async function expandArchives(entries: ZipEntry[], depth = 0): Promise<ZipEntry[]> {
  const out: ZipEntry[] = []
  for (const entry of entries) {
    const canExpand = depth < MAX_ARCHIVE_DEPTH && isArchiveEntry(entry.path, entry.bytes)
    if (canExpand && isZip(entry.bytes)) {
      const inner = readZip(entry.bytes).map((child) => ({
        path: prefixArchivePath(entry.path, child.path),
        bytes: child.bytes,
      }))
      out.push(...(await expandArchives(inner, depth + 1)))
    } else if (canExpand && isRar(entry.bytes)) {
      const inner = (await readRar(entry.bytes)).map((child) => ({
        path: prefixArchivePath(entry.path, child.path),
        bytes: child.bytes,
      }))
      out.push(...(await expandArchives(inner, depth + 1)))
    } else {
      out.push(entry)
    }
  }
  return out
}

interface DroppedFile {
  path: string
  file: File
}

/**
 * A synchronous snapshot of a `drop` event's `DataTransfer`.
 *
 * The browser invalidates `DataTransfer.items` / `.files` as soon as the event handler returns, and
 * `webkitGetAsEntry` / `getAsFileSystemHandle` must be called while the event is still live. Taking
 * everything up front (and resolving paths afterwards) keeps drops working on Windows, where a
 * lazily-read `DataTransfer` often comes back empty or with shell items that no longer resolve.
 */
export interface DroppedInput {
  files: File[]
  entries: FileSystemEntry[]
  handles: Promise<FileSystemHandle | null>[]
  /** `text/uri-list` from shell items (e.g. dragged shortcuts / virtual archive paths). */
  uriList: string[]
}

type ItemWithHandle = DataTransferItem & {
  getAsFileSystemHandle?: () => Promise<FileSystemHandle | null>
}

export function snapshotDataTransfer(dataTransfer: DataTransfer): DroppedInput {
  const files = Array.from(dataTransfer.files ?? [])
  const entries: FileSystemEntry[] = []
  const handles: Promise<FileSystemHandle | null>[] = []
  const items = dataTransfer.items
  if (items) {
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      if (item?.kind !== 'file') continue
      const entry = item.webkitGetAsEntry?.()
      if (entry) entries.push(entry)
      const getHandle = (item as ItemWithHandle).getAsFileSystemHandle
      if (typeof getHandle === 'function') {
        try {
          handles.push(getHandle.call(item))
        } catch {
          // Older Chromium can throw for shell items backed by a virtual archive path.
        }
      }
    }
  }
  const uriList = (dataTransfer.getData?.('text/uri-list') ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
  return { files, entries, handles, uriList }
}

function readDirectoryEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    const all: FileSystemEntry[] = []
    const next = () => {
      reader.readEntries((batch) => {
        if (batch.length === 0) {
          resolve(all)
          return
        }
        all.push(...batch)
        next()
      }, reject)
    }
    next()
  })
}

async function walkEntry(
  entry: FileSystemEntry,
  prefix: string,
  out: DroppedFile[],
): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File | null>((resolve) => {
      ;(entry as FileSystemFileEntry).file(
        (f) => resolve(f),
        () => resolve(null),
      )
    })
    if (file) out.push({ path: prefix + entry.name, file })
    return
  }
  if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader()
    const children = await readDirectoryEntries(reader)
    for (const child of children) await walkEntry(child, `${prefix}${entry.name}/`, out)
  }
}

function deriveSourceName(dropped: DroppedFile[]): string {
  if (dropped.length === 0) return 'input'
  if (dropped.length === 1) return dropped[0].path
  const folders = new Set(
    dropped.map((d) => (d.path.includes('/') ? d.path.split('/')[0] : d.path)),
  )
  if (folders.size === 1) return `${[...folders][0]}/ (${dropped.length} files)`
  return `${dropped.length} files`
}

async function bundleFromDropped(dropped: DroppedFile[]): Promise<InputBundle> {
  const raw: ZipEntry[] = []
  for (const { path, file } of dropped) {
    try {
      raw.push({ path, bytes: new Uint8Array(await file.arrayBuffer()) })
    } catch {
      // Skip anything unreadable (e.g. a directory handle that slipped through).
    }
  }
  return { sourceName: deriveSourceName(dropped), entries: await expandArchives(raw) }
}

function droppedFromFiles(files: File[]): DroppedFile[] {
  return files.map((file) => ({
    path:
      file.webkitRelativePath && file.webkitRelativePath.length > 0
        ? file.webkitRelativePath
        : file.name,
    file,
  }))
}

export async function readFiles(files: File[]): Promise<InputBundle> {
  return bundleFromDropped(droppedFromFiles(files))
}

async function walkDirectoryHandle(
  dir: FileSystemDirectoryHandle,
  prefix: string,
  out: DroppedFile[],
): Promise<void> {
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind === 'file') {
      out.push({ path: prefix + name, file: await handle.getFile() })
    } else {
      await walkDirectoryHandle(handle, `${prefix}${name}/`, out)
    }
  }
}

export async function readDirectoryHandle(dir: FileSystemDirectoryHandle): Promise<InputBundle> {
  const dropped: DroppedFile[] = []
  await walkDirectoryHandle(dir, `${dir.name}/`, dropped)
  return bundleFromDropped(dropped)
}

async function droppedFromHandles(handles: FileSystemHandle[]): Promise<DroppedFile[]> {
  const out: DroppedFile[] = []
  for (const handle of handles) {
    try {
      if (handle.kind === 'file') {
        out.push({ path: handle.name, file: await (handle as FileSystemFileHandle).getFile() })
      } else {
        await walkDirectoryHandle(handle as FileSystemDirectoryHandle, `${handle.name}/`, out)
      }
    } catch {
      // A shell item can resolve to a handle whose backing file has gone (cloud placeholder, zip
      // member). Let the other items contribute; the caller reports if nothing at all was read.
    }
  }
  return out
}

async function droppedFromEntries(entries: FileSystemEntry[]): Promise<DroppedFile[]> {
  const out: DroppedFile[] = []
  for (const entry of entries) {
    try {
      await walkEntry(entry, '', out)
    } catch {
      // Same as above: skip a single unreadable entry rather than aborting the whole drop.
    }
  }
  return out
}

/**
 * Reads a drop snapshot in order of reliability: the modern File System Access handles first
 * (they work for Windows folders and archives), then `webkitGetAsEntry`, then the plain `File`
 * snapshot. Each path is best-effort so one bad shell item cannot sink the whole drop.
 */
export async function readDroppedInput(input: DroppedInput): Promise<InputBundle> {
  const settled = await Promise.allSettled(input.handles)
  const handles = settled.flatMap((result) =>
    result.status === 'fulfilled' && result.value ? [result.value] : [],
  )
  if (handles.length > 0) {
    const dropped = await droppedFromHandles(handles)
    if (dropped.length > 0) return bundleFromDropped(dropped)
  }
  if (input.entries.length > 0) {
    const dropped = await droppedFromEntries(input.entries)
    if (dropped.length > 0) return bundleFromDropped(dropped)
  }
  return bundleFromDropped(droppedFromFiles(input.files))
}

export async function readDataTransfer(dataTransfer: DataTransfer): Promise<InputBundle> {
  return readDroppedInput(snapshotDataTransfer(dataTransfer))
}
