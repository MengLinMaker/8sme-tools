import { describe, expect, it } from 'vitest'
import type { NcGeometry } from '@/lib/parsers/ncGeometry'
import type { SabreFailure } from './sabre'
import { locateSabreStations, specifiedBevelAngle } from './sabreToNc'

/** Beam along X (0–1000), cross-section 100×100 in Y/Z. */
function beamVertices(): number[] {
  const out: number[] = []
  for (const x of [0, 1000]) {
    for (const y of [0, 100]) {
      for (const z of [0, 100]) out.push(x, y, z)
    }
  }
  return out
}

function failureAt(x: number): SabreFailure {
  return {
    point: [x, 50, 100],
    normal: [0, 0, 1],
    thickness: Number.POSITIVE_INFINITY,
    area: 60,
    tri: [
      [x - 5, 45, 100],
      [x + 5, 45, 100],
      [x, 55, 100],
    ],
  }
}

/** Outer contours per face; `endInset` slants the far end of faces o/u (ragged max end). */
function ncBeam(endInset = 0): NcGeometry {
  const outer = (face: 'v' | 'o' | 'u' | 'h', x1: number, x2: number) => ({
    face,
    kind: 'outer' as const,
    points: [
      [x1, 0],
      [x2, 0],
      [x2, 100],
      [x1, 100],
    ] as [number, number][],
    bevels: [
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ],
  })
  return {
    contours: [
      outer('v', 0, 1000),
      outer('h', 0, 1000),
      outer('o', 0, 1000 - endInset),
      outer('u', 0, 1000 - endInset),
    ],
    holes: [],
  }
}

describe('locateSabreStations', () => {
  it('maps a far-end cluster onto the NC station without flipping', () => {
    const stations = locateSabreStations(
      beamVertices(),
      [failureAt(978), failureAt(982)],
      ncBeam(15),
    )
    expect(stations).toHaveLength(1)
    expect(stations[0].x).toBeCloseTo(980, 0)
    expect(stations[0].count).toBe(2)
  })

  it('flips when the NC ragged end disagrees with the STEP cluster end', () => {
    // NC slanted at the START end (faces disagree near x=0); STEP failures sit at the far end,
    // so the STEP long axis must run opposite the NC X.
    const slantedStart: NcGeometry = {
      contours: [
        {
          face: 'v',
          kind: 'outer',
          points: [
            [15, 0],
            [1000, 0],
            [1000, 100],
            [15, 100],
          ],
          bevels: [
            [0, 0, 0, 0],
            [0, 0, 0, 0],
            [0, 0, 0, 0],
            [0, 0, 0, 0],
          ],
        },
        {
          face: 'h',
          kind: 'outer',
          points: [
            [15, 0],
            [1000, 0],
            [1000, 100],
            [15, 100],
          ],
          bevels: [
            [0, 0, 0, 0],
            [0, 0, 0, 0],
            [0, 0, 0, 0],
            [0, 0, 0, 0],
          ],
        },
        {
          face: 'o',
          kind: 'outer',
          points: [
            [0, 0],
            [1000, 0],
            [1000, 100],
            [0, 100],
          ],
          bevels: [
            [0, 0, 0, 0],
            [0, 0, 0, 0],
            [0, 0, 0, 0],
            [0, 0, 0, 0],
          ],
        },
        {
          face: 'u',
          kind: 'outer',
          points: [
            [0, 0],
            [1000, 0],
            [1000, 100],
            [0, 100],
          ],
          bevels: [
            [0, 0, 0, 0],
            [0, 0, 0, 0],
            [0, 0, 0, 0],
            [0, 0, 0, 0],
          ],
        },
      ],
      holes: [],
    }
    const stations = locateSabreStations(beamVertices(), [failureAt(980)], slantedStart)
    expect(stations).toHaveLength(1)
    // flipped: STEP s=0.98 lands near the NC start end
    expect(stations[0].x).toBeCloseTo(20, 0)
  })

  it('keeps mid-beam clusters proportional without flipping', () => {
    const stations = locateSabreStations(beamVertices(), [failureAt(500)], ncBeam(0))
    expect(stations).toHaveLength(1)
    expect(stations[0].x).toBeCloseTo(500, 0)
  })

  it('returns no stations without failures or geometry', () => {
    expect(locateSabreStations(beamVertices(), [], ncBeam(0))).toEqual([])
    expect(locateSabreStations([], [failureAt(500)], ncBeam(0))).toEqual([])
    expect(
      locateSabreStations(beamVertices(), [failureAt(500)], { contours: [], holes: [] }),
    ).toEqual([])
  })
})

/**
 * NC beam (length 1000) whose v-face carries a weld-prep bevel `angle` at x=980, and whose
 * o-face runs the full length so the member length stays 1000. Mirrors m110: an angle on one
 * cut-line vertex near a slanted end.
 */
function ncBeamWithBevel(angle: number): NcGeometry {
  const noBevel = [
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]
  return {
    contours: [
      {
        face: 'v',
        kind: 'outer',
        points: [
          [0, 0],
          [980, 0],
          [980, 100],
          [0, 100],
        ],
        bevels: [
          [0, 0, 0, 0],
          [angle, 4.2, 0, 0],
          [0, 0, 0, 0],
          [0, 0, 0, 0],
        ],
      },
      {
        face: 'o',
        kind: 'outer',
        points: [
          [0, 0],
          [1000, 0],
          [1000, 100],
          [0, 100],
        ],
        bevels: noBevel,
      },
    ],
    holes: [],
  }
}

describe('specifiedBevelAngle', () => {
  it('reads the weld-prep angle at the guilty station', () => {
    const stations = locateSabreStations(beamVertices(), [failureAt(980)], ncBeam(0))
    expect(specifiedBevelAngle(ncBeamWithBevel(-20), stations)).toBe(20)
  })

  it('ignores angles outside the station window', () => {
    const stations = locateSabreStations(beamVertices(), [failureAt(500)], ncBeam(0))
    expect(specifiedBevelAngle(ncBeamWithBevel(-20), stations)).toBeNull()
  })

  it('is null when the NC specifies no bevel', () => {
    const stations = locateSabreStations(beamVertices(), [failureAt(980)], ncBeam(0))
    expect(specifiedBevelAngle(ncBeam(0), stations)).toBeNull()
  })
})
