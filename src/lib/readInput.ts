import { isRar, readRar } from './rar'
import { isZip, readZip, type ZipEntry } from './zip'

export interface InputBundle {
  sourceName: string
  entries: ZipEntry[]
}

interface DroppedFile {
  path: string
  file: File
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

function entriesFromDataTransfer(dataTransfer: DataTransfer): FileSystemEntry[] {
  const entries: FileSystemEntry[] = []
  const items = dataTransfer.items
  if (!items) return entries
  for (let i = 0; i < items.length; i++) {
    const entry = items[i]?.webkitGetAsEntry?.()
    if (entry) entries.push(entry)
  }
  return entries
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
  const entries: ZipEntry[] = []
  for (const { path, file } of dropped) {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      if (isZip(bytes)) entries.push(...readZip(bytes))
      else if (isRar(bytes)) entries.push(...(await readRar(bytes)))
      else entries.push({ path, bytes })
    } catch {
      // Skip anything unreadable (e.g. a directory handle that slipped through).
    }
  }
  return { sourceName: deriveSourceName(dropped), entries }
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

export async function readDataTransfer(dataTransfer: DataTransfer): Promise<InputBundle> {
  const dataEntries = entriesFromDataTransfer(dataTransfer)
  if (dataEntries.length > 0) {
    const dropped: DroppedFile[] = []
    for (const entry of dataEntries) await walkEntry(entry, '', dropped)
    if (dropped.length > 0) return bundleFromDropped(dropped)
  }
  return readFiles(Array.from(dataTransfer.files))
}
