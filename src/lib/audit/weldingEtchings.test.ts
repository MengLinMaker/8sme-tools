import { existsSync, readFileSync } from 'node:fs'
import { fixture } from '@test/fixtures'
import { describe, expect, it } from 'vitest'
import { findWeldingEtchings } from './weldingEtchings'

/** A minimal NC with the given mark blocks. */
function nc(blocks: string): string {
  return `ST\n  M-1\n  C300\n  1\n  UB310*32\n  I\n  1000\n  298\nAK\n  v 0 0\n  1000 0\nEN\n${blocks}`
}

/** A single `SI` text block at the origin. */
function si(text: string): string {
  return `SI\n  v 0 0 0 20 ${text}\n`
}

describe('findWeldingEtchings', () => {
  it('ignores an SI that only repeats the part mark', () => {
    expect(findWeldingEtchings(nc(si('M-1')), 'M-1')).toBeNull()
  })

  it('treats an SI naming another member as a welding label', () => {
    expect(findWeldingEtchings(nc(si('M-2')), 'M-1')).toEqual({
      scribeLines: 0,
      labels: ['M-2'],
    })
  })

  it('ignores a leading dot when matching the part mark', () => {
    expect(findWeldingEtchings(nc(si('M-1')), '.M-1')).toBeNull()
  })

  it('counts PU/KO scribe bars as weld-location etchings', () => {
    const bars = 'KO\n  v 0 0 0\n  v 10 0 0\nPU\n  v 0 0 0\n  v 10 0 0\n'
    expect(findWeldingEtchings(nc(bars), 'M-1')).toEqual({ scribeLines: 2, labels: [] })
  })

  it('finds the weld bars in a real fixture with no SI text', () => {
    const path = fixture('ncep', 'M-3.nc1')
    if (!existsSync(path)) return
    const etchings = findWeldingEtchings(readFileSync(path, 'utf8'), 'M-3')
    expect(etchings?.scribeLines).toBeGreaterThan(0)
    expect(etchings?.labels).toEqual([])
  })
})
