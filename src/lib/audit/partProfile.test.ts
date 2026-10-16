import { describe, expect, it } from 'vitest'
import { listedProfile } from './partProfile'
import type { PartRecord } from './types'

const part = (over: Partial<PartRecord>): PartRecord => ({ mark: 'm1', ...over }) as PartRecord

describe('listedProfile', () => {
  it('treats a blank part-list cell as no code', () => {
    expect(listedProfile(part({ expected: { profile: '' } as never }))).toBeNull()
    expect(listedProfile(part({ expected: { profile: '   ' } as never }))).toBeNull()
  })

  it('reads the NC profile, trimmed, over the part list', () => {
    expect(
      listedProfile(
        part({ nc: { profile: ' BT100*15 ' } as never, expected: { profile: 'x' } as never }),
      ),
    ).toBe('BT100*15')
  })

  it('falls back to the part-list profile', () => {
    expect(listedProfile(part({ expected: { profile: 'EA200*200*20' } as never }))).toBe(
      'EA200*200*20',
    )
  })

  it('returns null when neither is present', () => {
    expect(listedProfile(part({}))).toBeNull()
  })
})
