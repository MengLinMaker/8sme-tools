import type { InputBundle } from '@/lib/readInput'
import type { ZipEntry } from '@/lib/zip'

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

const DB_NAME = 'sme-projects'
const DB_VERSION = 1
const META_STORE = 'projects'
const FILE_STORE = 'files'

/** What the project list shows — no file bytes, so listing stays cheap. */
export interface ProjectMeta {
  id: string
  name: string
  /** Epoch ms of the last write to this project. */
  savedAt: number
  fileCount: number
  /** Total bytes of the saved files. */
  size: number
}

interface FileRecord {
  path: string
  bytes: Uint8Array
}

let dbPromise: Promise<IDBDatabase> | null = null

function openDatabase(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('This browser has no IndexedDB, so projects cannot be saved.'))
      return
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(FILE_STORE)) {
        db.createObjectStore(FILE_STORE)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB refused to open'))
  })
  return dbPromise
}

function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function finished(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

/** The key range covering every file of one project. Paths never start with an empty string. */
function fileRange(id: string): IDBKeyRange {
  return IDBKeyRange.bound([id, ''], [id, '\uffff'])
}

/**
 * A stable id from the job name, so dropping the same export again resumes that project instead of
 * piling up near-duplicates. Anything that isn't a letter or digit collapses to a dash, which also
 * keeps the URL readable.
 */
export function projectIdFor(name: string): string {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return base || 'job'
}

export async function listProjects(): Promise<ProjectMeta[]> {
  const db = await openDatabase()
  const tx = db.transaction(META_STORE, 'readonly')
  const all = (await result(tx.objectStore(META_STORE).getAll())) as ProjectMeta[]
  await finished(tx)
  return all.sort((a, b) => b.savedAt - a.savedAt)
}

export async function getProjectMeta(id: string): Promise<ProjectMeta | null> {
  const db = await openDatabase()
  const tx = db.transaction(META_STORE, 'readonly')
  const meta = (await result(tx.objectStore(META_STORE).get(id))) as ProjectMeta | undefined
  await finished(tx)
  return meta ?? null
}

/** The saved job as a bundle, or null when nothing is stored under that id. */
export async function loadProject(id: string): Promise<InputBundle | null> {
  const db = await openDatabase()
  const meta = await getProjectMeta(id)
  if (!meta) return null
  const tx = db.transaction(FILE_STORE, 'readonly')
  const records = (await result(tx.objectStore(FILE_STORE).getAll(fileRange(id)))) as FileRecord[]
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

  const meta: ProjectMeta = { id, name, savedAt: Date.now(), fileCount, size }
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

export async function deleteProject(id: string): Promise<void> {
  const db = await openDatabase()
  const tx = db.transaction([META_STORE, FILE_STORE], 'readwrite')
  tx.objectStore(META_STORE).delete(id)
  tx.objectStore(FILE_STORE).delete(fileRange(id))
  await finished(tx)
}

export async function storageEstimate(): Promise<{ usage?: number; quota?: number }> {
  try {
    const estimate = await navigator.storage?.estimate?.()
    return { usage: estimate?.usage, quota: estimate?.quota }
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
