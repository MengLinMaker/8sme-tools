import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fixture } from '@test/fixtures'
import { describe, expect, it } from 'vitest'
import { parseDstv } from '@/lib/parsers/dstv'
import { frameForProfile, placeNcFace } from '@/lib/parsers/ncFaces'
import { parseNcGeometry } from '@/lib/parsers/ncGeometry'
import { outlinePoints } from '@/lib/sections/outline'
import { partSectionForCode } from '@/lib/sections/stock'
import { meshStepFile } from '@/lib/step/mesh'
import { setOcWasmUrl } from '@/lib/step/occInit'
import { seatedStepGeometry } from '@/lib/wisecam/fromStep'

const require = createRequire(import.meta.url)
setOcWasmUrl(require.resolve('replicad-opencascadejs/wasm'))

const dot = (a: number[], b: number[]): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

describe('raw STEP hole centres', () => {
  it('m137: along matches the NC holes', async () => {
    const ncText = readFileSync(fixture('part-ir', 'm137.nc1'), 'utf8')
    const header = parseDstv(ncText).header
    const section = partSectionForCode(header.profile, header.dimensions)
    if (!section) throw new Error('no section')
    const geometry = parseNcGeometry(ncText)
    const meshed = await meshStepFile(
      'm137-raw',
      new Uint8Array(readFileSync(fixture('part-ir', 'm137.stp'))),
    )
    const seated = seatedStepGeometry(meshed, outlinePoints(section?.outline))
    const raw = seated.faces
      .filter((face) => face.cylinder && Math.abs(face.cylinder.radius - 7) < 0.5)
      .map((face) => dot(face.cylinder?.center as number[], seated.memberAxis) + seated.alongOffset)
      .sort((a, b) => a - b)
    const expected = geometry.holes.map((hole) => hole.x).sort((a, b) => a - b)
    expect(raw).toHaveLength(expected.length)
    for (let index = 0; index < raw.length; index++)
      expect(Math.abs((raw[index] as number) - (expected[index] as number))).toBeLessThan(0.5)
  }, 120_000)

  // Was a canary: m137's STEP hole centres used to translate across the section along the member.
  // That was the PCA seat tilting the member, not the STEP — with the stock-face seat the holes
  // land on the NC cross positions to 0.005 mm, so the straight-section IR assumption holds.
  it('m137: raw STEP hole centres stay at the NC cross-section position', async () => {
    const ncText = readFileSync(fixture('part-ir', 'm137.nc1'), 'utf8')
    const header = parseDstv(ncText).header
    const section = partSectionForCode(header.profile, header.dimensions)
    if (!section) throw new Error('no section')
    const geometry = parseNcGeometry(ncText)
    const frame = frameForProfile(header.profile, outlinePoints(section?.outline))
    const meshed = await meshStepFile(
      'm137-raw-cross',
      new Uint8Array(readFileSync(fixture('part-ir', 'm137.stp'))),
    )
    const seated = seatedStepGeometry(meshed, outlinePoints(section?.outline))
    const raw = seated.faces
      .filter((face) => face.cylinder && Math.abs(face.cylinder.radius - 7) < 0.5)
      .map((face) => {
        const center = face.cylinder?.center as number[]
        return {
          along: dot(center, seated.memberAxis) + seated.alongOffset,
          cross: [dot(center, seated.xAxis), dot(center, seated.yAxis)] as [number, number],
        }
      })
    for (const hole of geometry.holes) {
      const placed = placeNcFace(frame, hole.face, hole.x, hole.y, outlinePoints(section?.outline))
      const nearest = raw.reduce((best, candidate) =>
        Math.abs(candidate.along - hole.x) < Math.abs(best.along - hole.x) ? candidate : best,
      )
      expect(
        Math.hypot(nearest.cross[0] - placed.cross[0], nearest.cross[1] - placed.cross[1]),
      ).toBeLessThan(0.5)
    }
  }, 120_000)
})
