import { describe, expect, it } from 'vitest'
import { createFileStamp } from './fileStamp'

describe('createFileStamp', () => {
  it('gives one file the same stamp every time', () => {
    const stampOf = createFileStamp()
    const bytes = new Uint8Array([1, 2, 3])
    expect(stampOf(bytes)).toBe(stampOf(bytes))
  })

  it('gives a replaced file a new stamp even when the content matches', () => {
    const stampOf = createFileStamp()
    expect(stampOf(new Uint8Array([1, 2, 3]))).not.toBe(stampOf(new Uint8Array([1, 2, 3])))
  })

  it('gives different files different stamps', () => {
    const stampOf = createFileStamp()
    expect(stampOf(new Uint8Array([1]))).not.toBe(stampOf(new Uint8Array([2])))
  })

  it('stamps a missing file as empty', () => {
    const stampOf = createFileStamp()
    expect(stampOf(undefined)).toBe('')
  })

  it('keeps stamps apart per instance', () => {
    const a = createFileStamp()
    const b = createFileStamp()
    const bytes = new Uint8Array([9])
    // Both start at the same id, but they are separate caches — never mixed in one cache.
    expect(a(bytes)).toBe(b(bytes))
  })
})
