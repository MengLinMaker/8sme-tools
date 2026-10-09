import { describe, expect, it } from 'vitest'
import { parseNcFile } from './nc'

const VALID_NC = `ST
** a1.nc1
  CO-7255
  a1
  a1
  8
  C300
  1
  EA75*75*6
  L
    4165.75
      75.00
      75.00
       6.00
       6.00
       8.00
       6.81
       0.29
AK
  v      0.00u      0.00       0.00
EN`

describe('parseNcFile', () => {
  it('parses a valid Weihong NC header', () => {
    const nc = parseNcFile('a1.nc1', VALID_NC)
    expect(nc.valid).toBe(true)
    expect(nc.problems).toEqual([])
    expect(nc.programCode).toBe('CO-7255')
    expect(nc.mark).toBe('a1')
    expect(nc.grade).toBe('C300')
    expect(nc.quantity).toBe(1)
    expect(nc.profile).toBe('EA75*75*6')
    expect(nc.orientation).toBe('L')
    expect(nc.length).toBeCloseTo(4165.75)
    expect(nc.dimensions).toEqual([75, 75, 6, 6, 8, 6.81, 0.29])
  })

  it('flags a missing EN terminator', () => {
    const nc = parseNcFile('a1.nc1', VALID_NC.replace(/\nEN$/, ''))
    expect(nc.valid).toBe(false)
    expect(nc.problems).toContain('missing EN terminator')
  })

  it('flags a non-positive quantity', () => {
    const broken = VALID_NC.replace('\n  1\n  EA75*75*6', '\n  0\n  EA75*75*6')
    const nc = parseNcFile('a1.nc1', broken)
    expect(nc.quantity).toBeNull()
    expect(nc.valid).toBe(false)
  })
})
