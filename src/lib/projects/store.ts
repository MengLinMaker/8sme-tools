import type { InputBundle } from '@/lib/readInput'
import type { ZipEntry } from '@/lib/zip'
import {
  EDIT_STORE,
  FILE_STORE,
  finished,
  META_STORE,
  openDatabase,
  projectRange,
  result,
} from './db'

/**
 * Saved jobs, in IndexedDB.
 *
 * A job is a set of files (the NC/STEP/PDF a `.zip` unpacked to) plus a name; the user reopens it to
 * carry on where they left off. Files are stored individually under `[projectId, path]`, so adding
 * or removing one writes only those records rather than rewriting hundreds of megabytes.
 *
 * IndexedDB rather than localStorage because a real job is tens to hundreds of MB, and rather than
 * the File System Access API because that would drop Safari/Firefox. The bytes still never leave
 * the machine — but they do live in this browser's profile until the project is deleted.
 */

/** What the project list shows — no file bytes, so listing stays cheap. */
export interface ProjectMeta {
  id: string
  name: string
  /** Epoch ms of the last write to this project. */
  savedAt: number
  fileCount: number
  /** Total bytes of the saved files. */
  size: number
  /** How many copies (batches) of the job are being made; planning quantities multiply by this. */
  batches?: number
}

/** A batch count is a positive whole number; anything else means one batch. */
export function normalizeBatches(value: number | null | undefined): number {
  return value != null && Number.isFinite(value) && value >= 1 ? Math.floor(value) : 1
}

/**
 * Older imports suffixed a folder job with its file count (`job/ (351 files)`). That count belongs
 * in the file list, not the title, so show just the folder name for saved jobs too.
 */
function projectDisplayName(name: string): string {
  return name.replace(/\s*\/\s*\(\d+\s+files?\)$/, '')
}

interface FileRecord {
  path: string
  bytes: Uint8Array
}

/**
 * A project id from the job's **contents**, not its name: two exports called `job.zip` are different
 * projects, and re-importing the same export resumes the one already saved.
 *
 * Two FNV-1a passes (different offsets/primes) give 64 bits as 16 hex characters, streamed over the
 * sorted paths and their bytes so the id doesn't depend on the order the archive listed them in.
 * Hashing is a few hundred megabytes a second, so a big job costs a fraction of a second on import.
 */
export function projectIdFor(entries: ZipEntry[]): string {
  let a = 0x811c9dc5
  let b = 0x9e3779b9
  const mix = (byte: number) => {
    a = Math.imul(a ^ byte, 0x01000193) >>> 0
    b = Math.imul(b ^ byte, 0x85ebca6b) >>> 0
  }
  const encoder = new TextEncoder()
  const sorted = [...entries].sort((left, right) => left.path.localeCompare(right.path))
  for (const entry of sorted) {
    for (const byte of encoder.encode(entry.path)) mix(byte)
    mix(0)
    for (let index = 0; index < entry.bytes.length; index++) mix(entry.bytes[index] ?? 0)
    mix(0xff)
  }
  return `${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}`
}

export async function listProjects(): Promise<ProjectMeta[]> {
  const db = await openDatabase()
  const tx = db.transaction(META_STORE, 'readonly')
  const all = (await result(tx.objectStore(META_STORE).getAll())) as ProjectMeta[]
  await finished(tx)
  return all
    .map((meta) => ({ ...meta, name: projectDisplayName(meta.name) }))
    .sort((a, b) => b.savedAt - a.savedAt)
}

export async function getProjectMeta(id: string): Promise<ProjectMeta | null> {
  const db = await openDatabase()
  const tx = db.transaction(META_STORE, 'readonly')
  const meta = (await result(tx.objectStore(META_STORE).get(id))) as ProjectMeta | undefined
  await finished(tx)
  return meta ? { ...meta, name: projectDisplayName(meta.name) } : null
}

/** The saved job as a bundle, or null when nothing is stored under that id. */
export async function loadProject(id: string): Promise<InputBundle | null> {
  const db = await openDatabase()
  const meta = await getProjectMeta(id)
  if (!meta) return null
  const tx = db.transaction(FILE_STORE, 'readonly')
  const records = (await result(
    tx.objectStore(FILE_STORE).getAll(projectRange(id)),
  )) as FileRecord[]
  await finished(tx)
  const entries: ZipEntry[] = records.map((record) => ({
    path: record.path,
    bytes: record.bytes,
  }))
  return { sourceName: meta.name, entries }
}

/**
 * Writes the given files into a project (replacing same-path entries), removes the named ones, and
 * updates the totals. Only the touched records are written, so adding a part to a big job is cheap.
 */
export async function putProjectFiles(
  id: string,
  name: string,
  files: ZipEntry[],
  removed: string[] = [],
): Promise<ProjectMeta> {
  const db = await openDatabase()
  const existing = await getProjectMeta(id)

  // Sizes of the paths being touched: they are what makes the totals exact without re-reading the
  // whole project (and the bytes) on every write.
  const previous = new Map<string, number>()
  if (files.length > 0 || removed.length > 0) {
    const tx = db.transaction(FILE_STORE, 'readonly')
    const store = tx.objectStore(FILE_STORE)
    const paths = [...new Set([...files.map((file) => file.path), ...removed])]
    const records = await Promise.all(
      paths.map((path) => result(store.get([id, path])) as Promise<FileRecord | undefined>),
    )
    paths.forEach((path, index) => {
      const record = records[index]
      if (record) previous.set(path, record.bytes.length)
    })
    await finished(tx)
  }

  let size = existing?.size ?? 0
  let fileCount = existing?.fileCount ?? 0
  for (const file of files) {
    const old = previous.get(file.path)
    if (old === undefined) fileCount += 1
    size += file.bytes.length - (old ?? 0)
  }
  for (const path of removed) {
    const old = previous.get(path)
    if (old === undefined) continue
    size -= old
    fileCount -= 1
  }

  const meta: ProjectMeta = {
    id,
    name,
    savedAt: Date.now(),
    fileCount,
    size,
    // A file write must not reset how many batches the operator set.
    ...(existing?.batches != null ? { batches: existing.batches } : {}),
  }
  const tx = db.transaction([META_STORE, FILE_STORE], 'readwrite')
  tx.objectStore(META_STORE).put(meta)
  const store = tx.objectStore(FILE_STORE)
  for (const file of files) store.put({ path: file.path, bytes: file.bytes }, [id, file.path])
  for (const path of removed) store.delete([id, path])
  await finished(tx)
  return meta
}

/** Removes files from a project, keeping the rest. */
export async function removeProjectFiles(id: string, paths: string[]): Promise<ProjectMeta | null> {
  if (paths.length === 0) return null
  const meta = await getProjectMeta(id)
  if (!meta) return null
  return putProjectFiles(id, meta.name, [], paths)
}

/**
 * Saves the job's batch count. Kept on the meta record so it costs one small write and never
 * touches the files; `savedAt` is left alone because changing a planning setting is not a new save.
 */
export async function saveProjectBatches(id: string, batches: number): Promise<ProjectMeta | null> {
  const meta = await getProjectMeta(id)
  if (!meta) return null
  const next: ProjectMeta = { ...meta, batches: normalizeBatches(batches) }
  const db = await openDatabase()
  const tx = db.transaction(META_STORE, 'readwrite')
  tx.objectStore(META_STORE).put(next)
  await finished(tx)
  return next
}

export async function deleteProject(id: string): Promise<void> {
  const db = await openDatabase()
  const tx = db.transaction([META_STORE, FILE_STORE, EDIT_STORE], 'readwrite')
  tx.objectStore(META_STORE).delete(id)
  tx.objectStore(FILE_STORE).delete(projectRange(id))
  tx.objectStore(EDIT_STORE).delete(projectRange(id))
  await finished(tx)
}

export interface StorageFigures {
  /** Everything the origin holds, exactly as the browser counts it for eviction. */
  usage?: number
  /** The origin's storage limit. */
  quota?: number
  /** Of `usage`, the bytes in Cache Storage — the precached app shell and CAD kernel. */
  cached?: number
}

/**
 * The browser's storage figures for this origin.
 *
 * `usage` is the honest total: it is the number the browser uses for its quota, so it is what
 * "37.9 MB used" means. It includes the service-worker caches — the precached app shell and the
 * ~23 MB CAD kernel — which exist before any job is imported and do not shrink when one is deleted.
 * `usageDetails` splits the cache out where the browser reports it, so the page can show the saved
 * projects and that cache separately instead of letting one masquerade as the other.
 *
 * There is no way to compact IndexedDB from the web: Chrome's LevelDB backend repacks on its own
 * schedule, and after a delete the disk figure can trail the records for a while. Our deletes do
 * remove every record of a project (meta, files and edits), so the jobs figure drops immediately.
 */
export async function storageFigures(): Promise<StorageFigures> {
  try {
    const estimate = (await navigator.storage?.estimate?.()) as
      | { usage?: number; quota?: number; usageDetails?: { caches?: number } }
      | undefined
    return {
      usage: estimate?.usage,
      quota: estimate?.quota,
      cached: estimate?.usageDetails?.caches,
    }
  } catch {
    return {}
  }
}

/** Asks the browser not to evict us under pressure. Returns whether it granted it. */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    return (await navigator.storage?.persist?.()) ?? false
  } catch {
    return false
  }
}

/**
 * One-shot hand-off of a freshly imported bundle to the project page, so an import doesn't have to
 * be written and read straight back from IndexedDB.
 */
let handoff: { id: string; bundle: InputBundle } | null = null

export function handOffProject(id: string, bundle: InputBundle): void {
  handoff = { id, bundle }
}

export function takeHandOffProject(id: string): InputBundle | null {
  if (handoff?.id !== id) return null
  const bundle = handoff.bundle
  handoff = null
  return bundle
}
