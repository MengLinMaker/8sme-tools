import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { nw30Bottom } from '@test/fixtures'
import { Matrix4 } from 'three'
import { describe, expect, it } from 'vitest'
import { parseDstv } from '@/lib/parsers/dstv'
import { alignedOverlap, alignToReference, occFuzzyDiff } from './occDiff'
import { setOcWasmUrl } from './occInit'
import { reconstructSolidFromNc } from './reconstructFromNc'

const require = createRequire(import.meta.url)
setOcWasmUrl(require.resolve('replicad-opencascadejs/wasm'))

const IDENTITY = new Matrix4()

/**
 * Regression guard for the **"overgrown diff solid"**: the OCC fuzzy boolean can merge the whole
 * near-coincident pair and return ≈ the entire operand, which the old `over/under < 0.99` sanity
 * gate accepted (e.g. `a2`, EA75×75×6, reported ~96 %/95 % despite a 99.95 % material overlap).
 *
 * Each manufactured model is rebuilt and oriented to its own STEP the way the viewer does, then
 * diffed against that STEP. When the two genuinely coincide (true overlap ≈ 100 %), the reported
 * diff must be a near-zero solid — never a merged, whole-part one.
 */
const MARKS = ['m71', 'm87', 'a2', 'm105', 'm106', 'm107', 'm108']

describe('occ fuzzy diff does not overgrow on matching models (NW30)', () => {
  for (const mark of MARKS.filter(
    (m) => existsSync(nw30Bottom(`${m}.nc1`)) && existsSync(nw30Bottom(`${m}.stp`)),
  )) {
    it(`${mark}: a matching rebuild reports a near-zero diff`, async () => {
      const ncText = readFileSync(nw30Bottom(`${mark}.nc1`), 'utf8')
      const stepBytes = new Uint8Array(readFileSync(nw30Bottom(`${mark}.stp`)))
      const profile = parseDstv(ncText).header.profile
      // The NC builds in its own canonical frame; the diff aligns it to the STEP (the only place the
      // two independent pipelines meet), so no reference is fed to the rebuild.
      const built = await reconstructSolidFromNc(ncText)
      expect(built, `${mark} rebuild`).not.toBeNull()
      if (!built) return
      const madeBytes = new TextEncoder().encode(built.step)

      // True material agreement, independent of the diff kernel: aligned (made ∩ ref) / ref.
      const { importSTEP, measureVolume } = await import('replicad')
      const toBlob = (b: Uint8Array) => new Blob([new Uint8Array(b)], { type: 'model/step' })
      const madeVol = measureVolume((await importSTEP(toBlob(madeBytes))) as never)
      const refVol = measureVolume((await importSTEP(toBlob(stepBytes))) as never)
      const overlap = await alignedOverlap(madeBytes, stepBytes)

      const compareMatrix = await alignToReference(stepBytes, madeBytes)
      const diff = await occFuzzyDiff(madeBytes, stepBytes, IDENTITY, compareMatrix)
      const over = diff ? diff.overVolume / (refVol || 1) : 0
      const under = diff ? diff.underVolume / (madeVol || 1) : 0
      console.log(
        `[occDiff guard] ${mark} (${profile}): trueOverlap ${(overlap * 100).toFixed(2)}% · ` +
          `made ${(madeVol / 1e6).toFixed(3)}e6 ref ${(refVol / 1e6).toFixed(3)}e6 · ` +
          `occ ${diff ? `over ${(over * 100).toFixed(1)}% under ${(under * 100).toFixed(1)}%` : 'FAILED (probe fallback)'}`,
      )
      // Models that materially coincide must not read as a large diff. (A null result just falls
      // back to the surface probe, which also shows ≈0 here, so only an overgrown result fails.)
      if (diff && overlap > 0.98) {
        expect(over, `${mark} overcut share`).toBeLessThan(0.1)
        expect(under, `${mark} undercut share`).toBeLessThan(0.1)
      }
    }, 300000)
  }
})
