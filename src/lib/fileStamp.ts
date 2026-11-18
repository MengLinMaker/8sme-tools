/**
 * Stable string ids for byte arrays, so cached analysis can tell "the same file" from "a file that
 * happens to be the same length".
 *
 * Identity is the right key here rather than a content hash: the readers keep the same `Uint8Array`
 * for an entry that did not change (a delete filters the array, an add keeps the untouched
 * entries), and a replaced file is a new array. Hashing megabytes of STEP per file would cost more
 * than it saves.
 *
 * Ids only need to be unique within one session and one cache, and they are never reused, so a
 * cached result can never be mistaken for a different file's.
 */
export function createFileStamp(): (bytes?: Uint8Array) => string {
  const ids = new WeakMap<Uint8Array, number>()
  let next = 0
  return (bytes?: Uint8Array): string => {
    if (!bytes) return ''
    let id = ids.get(bytes)
    if (id === undefined) {
      id = ++next
      ids.set(bytes, id)
    }
    return String(id)
  }
}
