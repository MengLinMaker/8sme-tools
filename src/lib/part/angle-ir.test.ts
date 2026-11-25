import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { nw30Bottom, nw31Top } from '@test/fixtures'
import { describe, expect, it } from 'vitest'
import { parseDstv } from '@/lib/parsers/dstv'
import { outlinePoints } from '@/lib/sections/outline'
import { partSectionForCode } from '@/lib/sections/stock'
import { meshStepFile } from '@/lib/step/mesh'
import { setOcWasmUrl } from '@/lib/step/occInit'
import { detectStepSection } from '@/lib/step/readSection'
import { partIrFromNc } from './fromNc'
import { partIrFromStepMesh } from './fromStep'
import type { PartIr, UvPoint } from './ir'
import { partIrSvg } from './svg'

const require = createRequire(import.meta.url)
setOcWasmUrl(require.resolve('replicad-opencascadejs/wasm'))

const a1nc = nw31Top('NC files', 'a1.nc1')
const a1stp = nw31Top('STP files', 'a1.stp')
const a2nc = nw30Bottom('a2.nc1')
const a2stp = nw30Bottom('a2.stp')

/** The cut runs of an IR, as `[minStation, maxStation, minAlong, maxAlong]`. */
function cutBoxes(part: PartIr): [number, number, number, number][] {
  return part.features
    .filter((feature) => feature.kind === 'cut' && feature.shape.form === 'polyline')
    .map((feature) => {
      if (feature.shape.form !== 'polyline') return [0, 0, 0, 0]
      const stations = feature.shape.points.map(([station]) => station)
      const alongs = feature.shape.points.map(([, along]) => along)
      return [
        Math.min(...stations),
        Math.max(...stations),
        Math.min(...alongs),
        Math.max(...alongs),
      ]
    })
}

interface SlotSegment {
  center: UvPoint
  far: UvPoint
  radius: number
}

function slotSegments(part: PartIr): SlotSegment[] {
  return part.features.flatMap((feature) =>
    feature.kind === 'slot' && feature.shape.form === 'slot'
      ? [{ center: feature.shape.center, far: feature.shape.far, radius: feature.shape.radius }]
      : [],
  )
}

/** The same slot, allowing for the near/far end order to differ. */
function sameSlot(a: SlotSegment, b: SlotSegment, tolerance = 1): boolean {
  const near = (p: UvPoint, q: UvPoint) => Math.hypot(p[0] - q[0], p[1] - q[1]) <= tolerance
  return (
    Math.abs(a.radius - b.radius) <= tolerance &&
    ((near(a.center, b.center) && near(a.far, b.far)) ||
      (near(a.center, b.far) && near(a.far, b.center)))
  )
}

describe('angle Surface IR — one continuous prism-section strip', () => {
  for (const [mark, ncPath] of [
    ['a1', a1nc],
    ['a2', a2nc],
  ] as const) {
    it.skipIf(!existsSync(ncPath))(`${mark}: NC develops both legs into one front chart`, () => {
      const ir = partIrFromNc(readFileSync(ncPath, 'utf8'))
      if (!ir) throw new Error(`no IR for ${mark}`)
      // One chart, not a chart per face. `u`/`v` are adjacent halves of the 150 mm strip.
      expect(ir.charts).toHaveLength(1)
      expect(ir.charts[0]?.id).toBe('front')
      expect(ir.charts[0]?.faces).toEqual(['v', 'u'])
      expect(ir.charts[0]?.layout.seam).toBeCloseTo(150, 6)
      // Every cut/hole belongs to that one chart.
      for (const feature of ir.features) expect(feature.chart).toBe('front')
    })
  }

  it.skipIf(!existsSync(a1nc))('a1: the mitre end is continuous across the corner', () => {
    const ir = partIrFromNc(readFileSync(a1nc, 'utf8'))
    if (!ir) throw new Error('no IR')
    // Stations -75 (u toe) → 0 (corner) → 75 (v toe); the mitre rises on the v leg only.
    expect(ir.startCut).toEqual([
      [-75, 0],
      [0, 0],
      [75, 27.57],
    ])
    expect(ir.endCut).toEqual([
      [-75, 4105.6],
      [0, 4105.59],
      [75, 4130.7],
    ])
  })

  it.skipIf(!existsSync(a1nc))('a1: the NC IR stays faithful to the authored end line', () => {
    const ir = partIrFromNc(readFileSync(a1nc, 'utf8'))
    if (!ir) throw new Error('no IR')
    // a1's beveled `u` end is authored on the root/inner line at along 4105.6. The real STEP
    // geometry meets the outer skin ~2 mm earlier, so the STEP IR draws there — but the IR is the
    // faithful canonical record of the NC and must not be offset to hide that (NC/STEP) difference.
    const u = ir.features.find(
      (feature) =>
        feature.kind === 'cut' &&
        feature.shape.form === 'polyline' &&
        feature.shape.points.some(([station]) => station < -1),
    )
    if (u?.shape.form !== 'polyline') throw new Error('no u cut')
    const alongs = u.shape.points.map(([, along]) => along)
    expect(alongs.some((along) => Math.abs(along - 4105.6) < 0.01)).toBe(true)
    expect(alongs.some((along) => Math.abs(along) < 0.01)).toBe(true)

    // The view renders the authored value, not an outer-skin shift.
    const svg = partIrSvg(ir, { orientation: 'raw' })
    expect(svg).toContain(',4105.600')
    expect(svg).not.toContain(',4103.416')
  })

  it.skipIf(!existsSync(a1stp))(
    'a1: STEP IR exists and carries both legs plus the slots',
    async () => {
      const ncText = readFileSync(a1nc, 'utf8')
      const header = parseDstv(ncText).header
      const section = partSectionForCode(header.profile, header.dimensions)
      if (!section) throw new Error('no section')
      const stepBytes = new Uint8Array(readFileSync(a1stp))
      const guess = await detectStepSection(stepBytes)
      const ir = partIrFromStepMesh(await meshStepFile('a1-angle-ir', stepBytes), {
        mark: 'a1-step',
        profile: header.profile,
        dimensions: header.dimensions,
        length: header.length,
        section: outlinePoints(section.outline),
        innerSection:
          outlinePoints(section.innerOutline) ?? outlinePoints(section.voidOutlines?.[0]),
        radius: header.dimensions[4] ?? 0,
        seat: guess?.seat,
      })
      if (!ir) throw new Error('no STEP IR')
      expect(ir.charts).toHaveLength(1)
      expect(ir.charts[0]?.faces).toEqual(['v', 'u'])
      expect(ir.charts[0]?.layout.seam).toBeCloseTo(150, 6)

      // Before the layout existed the whole STEP IR was null. Before the plane filter, every
      // bottom-leg cut was labelled `o` (a face with no chart region) and dropped, so each end
      // line only covered one half of the strip.
      const cuts = cutBoxes(ir)
      expect(cuts).toHaveLength(2)
      for (const [minStation, maxStation] of cuts) {
        expect(minStation).toBeCloseTo(-75, 0)
        expect(maxStation).toBeCloseTo(75, 0)
      }
      const mitre = cuts.find(([, , minAlong]) => minAlong < 100)
      const far = cuts.find(([, , minAlong]) => minAlong > 1000)
      expect(mitre?.[3]).toBeCloseTo(27.37, 1)
      expect(far?.[2]).toBeCloseTo(4103.2, 1)
      expect(far?.[3]).toBeCloseTo(4130.5, 1)

      // The three machined slots survive the open-section projection.
      const slots = slotSegments(ir)
      expect(slots).toHaveLength(3)
      for (const slot of slots) expect(slot.radius).toBeCloseTo(5, 1)

      // The IR is one standardised representation: the STEP slots must land on the same faces
      // and stations as the NC's, not on the opposite half of the strip.
      const ncIr = partIrFromNc(ncText)
      if (!ncIr) throw new Error('no NC IR')
      const ncSlots = slotSegments(ncIr)
      expect(ncSlots).toHaveLength(3)
      for (const slot of slots) {
        expect(
          ncSlots.some((candidate) => sameSlot(candidate, slot)),
          `STEP slot ${JSON.stringify(slot.center)} matches an NC slot`,
        ).toBe(true)
      }
    },
    120_000,
  )

  it.skipIf(!existsSync(a2stp))(
    'a2: the 100 mm stub STEP IR keeps its slot',
    async () => {
      const ncText = readFileSync(a2nc, 'utf8')
      const header = parseDstv(ncText).header
      const section = partSectionForCode(header.profile, header.dimensions)
      if (!section) throw new Error('no section')
      const stepBytes = new Uint8Array(readFileSync(a2stp))
      const guess = await detectStepSection(stepBytes)
      const ir = partIrFromStepMesh(await meshStepFile('a2-angle-ir', stepBytes), {
        mark: 'a2-step',
        profile: header.profile,
        dimensions: header.dimensions,
        length: header.length,
        section: outlinePoints(section.outline),
        innerSection:
          outlinePoints(section.innerOutline) ?? outlinePoints(section.voidOutlines?.[0]),
        radius: header.dimensions[4] ?? 0,
        seat: guess?.seat,
      })
      if (!ir) throw new Error('no STEP IR')
      const slots = slotSegments(ir)
      expect(slots).toHaveLength(1)
      expect(slots[0]?.radius).toBeCloseTo(5, 1)
      const ncIr = partIrFromNc(ncText)
      if (!ncIr) throw new Error('no NC IR')
      const ncSlot = slotSegments(ncIr)[0]
      expect(ncSlot).toBeTruthy()
      if (ncSlot && slots[0]) expect(sameSlot(ncSlot, slots[0])).toBe(true)
      for (const [minStation, maxStation] of cutBoxes(ir)) {
        expect(minStation).toBeCloseTo(-75, 0)
        expect(maxStation).toBeCloseTo(75, 0)
      }
    },
    120_000,
  )
})
