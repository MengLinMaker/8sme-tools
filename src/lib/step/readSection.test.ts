import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { hexModuleFrames, nw30Bottom, nw31Bottom, nw31Top } from '@test/fixtures'
import { draw, importSTEP, makeBox } from 'replicad'
import { describe, expect, it } from 'vitest'
import { partSectionForCode } from '@/lib/sections/stock'
import { ensureOc, setOcWasmUrl } from './occInit'
import { detectStepSection, inferStepSection, type SectionShape } from './readSection'

const require = createRequire(import.meta.url)
setOcWasmUrl(require.resolve('replicad-opencascadejs/wasm'))

/** Real STEP parts with their DSTV profile code — the section the geometry should resolve to. */
const CASES: { path: string; section: string; family: string }[] = [
  { path: nw30Bottom('a2.stp'), section: 'EA75*75*6', family: 'angle' },
  { path: nw30Bottom('m71.stp'), section: 'PFC100*50', family: 'pfc' },
  { path: nw30Bottom('m105.stp'), section: 'SHS100*100*6.0', family: 'shs' },
  { path: nw31Top('STP files', 'm117.stp'), section: 'RHS150*100*9.0', family: 'rhs' },
  { path: nw31Top('STP files', 'm118.stp'), section: 'BT', family: 'tee' },
  { path: nw31Bottom('m122.stp'), section: 'SHS100*100*9.0', family: 'shs' },
  // HEX Module Frames: a 200UB25.4 must not collapse to its thinner 200UB22.3 sibling, and a
  // rotated (diagonal-member) SHS must not read as an oversized oblique RHS.
  { path: hexModuleFrames('item10.stp'), section: '200UB25.4', family: 'ub' },
  { path: hexModuleFrames('item35.stp'), section: 'SHS75*75*6.0', family: 'shs' },
]
const HAVE = CASES.every((testCase) => existsSync(testCase.path))

describe.skipIf(!HAVE)('readSection — detect the section from real STEP geometry', () => {
  it('resolves each fixture to its DSTV profile family and size', async () => {
    for (const testCase of CASES) {
      const guess = await detectStepSection(new Uint8Array(readFileSync(testCase.path)))
      expect(guess, `${testCase.path} — section not recognised`).not.toBeNull()
      expect(guess?.family).toBe(testCase.family)
      expect(guess?.code).toBe(testCase.section)
    }
  }, 600000)

  it('maps a T back to its parent UB', async () => {
    const guess = await detectStepSection(
      new Uint8Array(readFileSync(nw31Top('STP files', 'm118.stp'))),
    )
    expect(guess?.label).toContain('200UB29.8')
  }, 600000)

  /**
   * A short part's member axis is not its longest extent — an angle cut to 20 mm has 50 mm legs —
   * so slicing only the longest axis (a leg) cuts the wrong way and matches nothing. No such short
   * fixture exists, so one is built from the real angle profile.
   */
  it('resolves a short angle whose member axis is not the longest extent', async () => {
    await ensureOc()
    const section = partSectionForCode('EA50*50*3', [])
    expect(section).not.toBeNull()
    if (!section) return
    let pen = draw(section.points[0] as [number, number])
    for (const point of section.points.slice(1)) pen = pen.lineTo(point)
    const bytes = new Uint8Array(
      await pen.close().sketchOnPlane('XY').extrude(20).blobSTEP().arrayBuffer(),
    )
    const shape = (await importSTEP(
      new Blob([bytes], { type: 'model/step' }),
    )) as unknown as SectionShape
    try {
      const guess = inferStepSection(
        shape,
        makeBox as unknown as (a: number[], b: number[]) => SectionShape,
      )
      expect(guess?.family).toBe('angle')
      expect(guess?.code).toBe('EA50*50*3')
    } finally {
      shape.delete()
    }
  }, 600000)

  /**
   * A Tekla STEP export need not be axis-aligned — the member can run diagonally, so slicing world
   * X/Y/Z misses the section and detection falls back to the part's principal axes.
   */
  it('resolves a part whose content is rotated off the world axes', async () => {
    await ensureOc()
    const section = partSectionForCode('EA200*200*20', [])
    expect(section).not.toBeNull()
    if (!section) return
    let pen = draw(section.points[0] as [number, number])
    for (const point of section.points.slice(1)) pen = pen.lineTo(point)
    type Rotatable = {
      rotate: (a: number, p: number[], d: number[]) => Rotatable
      blobSTEP: () => Blob
    }
    let solid = pen.close().sketchOnPlane('XY').extrude(2000) as unknown as Rotatable
    solid = solid.rotate(30, [0, 0, 0], [1, 0, 0])
    solid = solid.rotate(20, [0, 0, 0], [0, 1, 0])
    solid = solid.rotate(45, [0, 0, 0], [0, 0, 1])
    const bytes = new Uint8Array(await solid.blobSTEP().arrayBuffer())
    const shape = (await importSTEP(
      new Blob([bytes], { type: 'model/step' }),
    )) as unknown as SectionShape
    try {
      const guess = inferStepSection(
        shape,
        makeBox as unknown as (a: number[], b: number[]) => SectionShape,
      )
      expect(guess?.family).toBe('angle')
      expect(guess?.code).toBe('EA200*200*20')
    } finally {
      shape.delete()
    }
  }, 600000)
})
