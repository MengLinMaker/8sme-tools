import type { Finding } from '@/lib/audit/schemas'
import type { DrawingMaterial } from '@/lib/parsers/pdfText'
import type { ModelComparison, SizeCheck } from '@/lib/step/measure'
import type { ZipEntry } from '@/lib/zip'

/**
 * Dev-only, short-lived cache of the last preflight run so a hot reload doesn't re-parse the
 * drawings and re-measure every STEP through the OCC kernel from scratch. Holds the dropped
 * entries (the expensive part) plus the analysis results derived from them. Keyed by a content
 * fingerprint so re-dropping the same job is instant too.
 */
export interface PreflightCacheEntry {
  sourceName: string
  entries: ZipEntry[]
  drawingMaterials: Map<string, DrawingMaterial>
  modelChecks: Map<string, SizeCheck>
  manufactureChecks: Map<string, ModelComparison>
  cutIssues: Map<string, Finding[]>
  /** Content fingerprint of `entries` — see {@link fingerprintEntries}. */
  fingerprint: string
  savedAt: number
}

const DB_NAME = '8sme-preflight'
const DB_VERSION = 1
const STORE = 'analysis'
const KEY = 'last'
/** A work session, not permanent storage: older than this and we start fresh. */
const TTL_MS = 12 * 60 * 60 * 1000

/** Caching is a dev convenience (hot reload); production always re-analyzes. */
export const preflightCacheEnabled = import.meta.env.DEV

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null)
      return
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => resolve(null)
    request.onblocked = () => resolve(null)
  })
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export async function loadPreflightCache(): Promise<PreflightCacheEntry | null> {
  if (!preflightCacheEnabled) return null
  const db = await openDb()
  if (!db) return null
  try {
    const entry = await requestResult<PreflightCacheEntry | undefined>(
      db.transaction(STORE, 'readonly').objectStore(STORE).get(KEY),
    )
    if (!entry) return null
    if (Date.now() - entry.savedAt > TTL_MS) {
      await clearPreflightCache()
      return null
    }
    return entry
  } catch {
    return null
  } finally {
    db.close()
  }
}

export async function savePreflightCache(entry: PreflightCacheEntry): Promise<void> {
  if (!preflightCacheEnabled) return
  const db = await openDb()
  if (!db) return
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(entry, KEY)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  } catch {
    // caching is best-effort — never let it break the run
  } finally {
    db.close()
  }
}

export async function clearPreflightCache(): Promise<void> {
  const db = await openDb()
  if (!db) return
  try {
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).delete(KEY)
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
      tx.onabort = () => resolve()
    })
  } finally {
    db.close()
  }
}

const FNV_OFFSET = 0x811c9dc5
const FNV_PRIME = 0x01000193

function hashByte(hash: number, byte: number): number {
  return Math.imul(hash ^ byte, FNV_PRIME)
}

/** FNV-1a over every entry's path + bytes, order-independent (entries are sorted by path). */
export function fingerprintEntries(entries: ZipEntry[]): string {
  let hash = FNV_OFFSET
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  for (const entry of sorted) {
    for (let i = 0; i < entry.path.length; i++)
      hash = hashByte(hash, entry.path.charCodeAt(i) & 0xff)
    hash = hashByte(hash, 0x1f)
    const bytes = entry.bytes
    for (let i = 0; i < bytes.length; i++) hash = hashByte(hash, bytes[i])
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}
