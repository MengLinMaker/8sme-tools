import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { setOcWasmUrl } from '@/lib/step/occInit'
import { analyzeSat } from './sat'
import { rebuildSatPrism } from './satRebuild'

const require = createRequire(import.meta.url)
setOcWasmUrl(require.resolve('replicad-opencascadejs/wasm'))

const SAMPLE = fileURLToPath(new URL('../../../test/fixtures/sat/150uc_3164.sat', import.meta.url))

/** The documented SolidWorks 2024 / ACIS 33 UC sample (`docs/sat-section.md`). */
function sampleSat(): string {
  return readFileSync(SAMPLE, 'utf8')
}

describe('analyzeSat', () => {
  it('reads the UC sample: section, dims, corners, length and the raked end', () => {
    const analysis = analyzeSat(sampleSat())
    expect(analysis.problems).toEqual([])
    expect(analysis.length).toBeCloseTo(3164.6, 1)
    expect(analysis.sectionEdgeCount).toBe(20)
    // SolidWorks split each 90° root fillet at 45°, so the SAT carries 8 arc faces.
    expect(analysis.cornerArcs).toBe(8)
    expect(analysis.endCuts).toHaveLength(1)
    expect(analysis.endCuts[0]?.angleDeg).toBeGreaterThan(30)

    const measured = analysis.measured
    expect(measured).not.toBeNull()
    expect(measured?.d).toBeCloseTo(152, 1)
    expect(measured?.b).toBeCloseTo(152, 1)
    expect(measured?.tf).toBeCloseTo(6.8, 1)
    expect(measured?.tw).toBeCloseTo(6.1, 1)
    expect(measured?.r).toBeCloseTo(8.9, 2)
    expect(measured?.webAlongY).toBe(true)

    expect(analysis.guess?.code).toBe('150UC23.4')
    expect(analysis.guess?.score).toBeGreaterThan(0.99)
    expect(analysis.plan?.deviation).toBeLessThan(0.05)
  })

  it('plans a chorded section from the catalogue arcs instead of refusing it', () => {
    // Re-writing the square end's ellipse records as straight curves makes the section a faceted
    // polygon — the other common export defect. The section must still match, and the plan must
    // rebuild it with true arcs.
    const chorded = sampleSat().replace(/ellipse-curve/g, 'straight-curve')
    const analysis = analyzeSat(chorded)
    expect(analysis.cornerArcs).toBe(0)
    expect(analysis.problems).toEqual([])
    expect(analysis.plan?.code).toBe('150UC23.4')
    expect(analysis.plan?.deviation).toBeLessThan(1)
  })

  it('refuses a file that is not ACIS', () => {
    const analysis = analyzeSat('not a cad file')
    expect(analysis.plan).toBeNull()
    expect(analysis.problems[0]).toContain('ACIS')
  })
})

describe('rebuildSatPrism', () => {
  it('replaces the 8 split fillets with 4 true arcs and reads back as the same section', async () => {
    const analysis = analyzeSat(sampleSat())
    expect(analysis.plan).not.toBeNull()
    const built = await rebuildSatPrism(analysis.plan!, { schema: 'AP203' })

    expect(built.step).toContain('ISO-10303-21')
    expect(built.step).toContain("FILE_NAME('150UC23.4'")
    expect(built.findings.arcFaces).toBe(4)
    expect(built.findings.detected).toBe('150UC23.4')
    expect(built.findings.score).toBeGreaterThan(0.99)
    expect(built.findings.size[0]).toBeCloseTo(152, 0)
    expect(built.findings.size[1]).toBeCloseTo(152, 0)
    expect(built.findings.size[2]).toBeCloseTo(3164.6, 1)
    const volumeError =
      Math.abs(built.findings.volume - built.findings.expectedVolume) /
      built.findings.expectedVolume
    expect(volumeError).toBeLessThan(0.005)
  }, 120_000)

  it('cleans a chorded section into the same 4-arc STEP', async () => {
    const chorded = sampleSat().replace(/ellipse-curve/g, 'straight-curve')
    const analysis = analyzeSat(chorded)
    expect(analysis.plan).not.toBeNull()
    const built = await rebuildSatPrism(analysis.plan!, { schema: 'AP203' })
    expect(built.findings.arcFaces).toBe(4)
    expect(built.findings.detected).toBe('150UC23.4')
  }, 120_000)
})
