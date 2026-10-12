import { describe, expect, it } from 'vitest'
import { flattenZipEntries } from './zip'

const bytes = (n: number) => new Uint8Array([n])

describe('flattenZipEntries', () => {
  it('strips folders down to basenames', () => {
    const out = flattenZipEntries([
      ['drawings/a1 - ANGLE.pdf', bytes(1)],
      ['models/a1.stp', bytes(2)],
      ['nc/a1.nc1', bytes(3)],
    ])
    expect(Object.keys(out).sort()).toEqual(['a1 - ANGLE.pdf', 'a1.nc1', 'a1.stp'])
  })

  it('keeps a single entry when the same bytes appear twice under one name', () => {
    const same = bytes(9)
    const out = flattenZipEntries([
      ['a/x.nc1', same],
      ['b/x.nc1', same],
    ])
    expect(Object.keys(out)).toEqual(['x.nc1'])
    expect(out['x.nc1']).toBe(same)
  })

  it('suffixes filename collisions from different sources', () => {
    const out = flattenZipEntries([
      ['a/part.stp', bytes(1)],
      ['b/part.stp', bytes(2)],
      ['c/part.stp', bytes(3)],
    ])
    expect(Object.keys(out)).toEqual(['part.stp', 'part (2).stp', 'part (3).stp'])
  })

  it('suffixes before the extension and handles extensionless names', () => {
    const out = flattenZipEntries([
      ['a/README', bytes(1)],
      ['b/README', bytes(2)],
    ])
    expect(Object.keys(out)).toEqual(['README', 'README (2)'])
  })
})
