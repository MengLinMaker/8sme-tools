import { describe, expect, it } from 'vitest'
import { profileFromFilename } from './fromFilename'
import { partSectionForCode } from './stock'

/**
 * Real Tekla filenames from the J12095 job. `SHS 75x75x6` must resolve to the catalogue's
 * `SHS75*75*6.0`, `200UB25` to `200UB25.4` (the only 200UB at that mass), `PFC 250` to its depth
 * match, and so on — a miss here is a millimetre-scale stock mismatch that no seating can fix.
 */
describe('profile from filename', () => {
  it('reads the callout from Tekla STEP names', () => {
    const cases: [string, string][] = [
      ['12095, ITEM 35, SHS 75x75x6, 2 OFF[C].STEP', 'SHS75*75*6.0'],
      ['12095, ITEM 34, SHS 89x89x5, 4 OFF[C].STEP', 'SHS89*89*5.0'],
      ['12095, ITEM 10, 200UB25, 1 OFF[C].STEP', '200UB25.4'],
      ['12095, ITEM 16, 200UB18, 1 OFF[C].STEP', '200UB18.2'],
      ['12095, ITEM 23, 150UB14, 1 OFF[C].STEP', '150UB14.0'],
      ['12095, ITEM 1, PFC 250, 1 OFF[C].STEP', 'PFC250*90'],
      ['12095, ITEM 5, PFC 150, 1 OFF[C].STEP', 'PFC150*75'],
      ['12095, ITEM 30, EA 200x200x20, 4 OFF[C].STEP', 'EA200*200*20'],
      ['12095, ITEM 31, EA 100x100x10, 1 OFF[C].STEP', 'EA100*100*10'],
    ]
    for (const [name, expected] of cases) {
      const profile = profileFromFilename(name)
      console.log(`[filename] ${name} → ${profile?.code ?? 'none'}`)
      expect(profile, name).not.toBeNull()
      // Compare the *section* the code resolves to, not its spelling: the catalogue writes
      // `SHS75*75*6.0` where the callout says `6`, and both must build the same outline.
      const got = partSectionForCode(profile?.code ?? '', [])
      const want = partSectionForCode(expected, [])
      expect(want, `${expected} catalogue`).not.toBeNull()
      expect(got?.points, `${name} section`).toEqual(want?.points)
    }
  })

  it('declines names with no callout', () => {
    for (const name of ['m117.stp', 'a1.stp', '12095, ITEM 1, 4 OFF[C].STEP']) {
      expect(profileFromFilename(name), name).toBeNull()
    }
  })
})
