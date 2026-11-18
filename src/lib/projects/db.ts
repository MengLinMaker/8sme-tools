/**
 * The one IndexedDB the app uses, shared by the project files and the edits made to them.
 *
 * Two stores: `projects` (one metadata row each, no bytes) and `files` (one record per project file,
 * keyed `[projectId, path]`), plus the `edits` store for the fixes applied to a project's parts.
 */

export const DB_NAME = 'sme-projects'
export const DB_VERSION = 2
export const META_STORE = 'projects'
export const FILE_STORE = 'files'
export const EDIT_STORE = 'edits'

let dbPromise: Promise<IDBDatabase> | null = null

export function openDatabase(): Promise<IDBDatabase> {
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
      if (!db.objectStoreNames.contains(EDIT_STORE)) {
        db.createObjectStore(EDIT_STORE)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB refused to open'))
  })
  return dbPromise
}

export function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export function finished(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

/** The key range covering every record of one project in an out-of-line-keyed store. */
export function projectRange(id: string): IDBKeyRange {
  return IDBKeyRange.bound([id], [id, []])
}
