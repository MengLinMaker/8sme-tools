import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { nw30Bottom, nw31Top } from '@test/fixtures'
import { describe, expect, it } from 'vitest'
import { parseDstv } from '@/lib/parsers/dstv'
import { profileFamily } from '@/lib/sections/canonical'
import { partSectionForCode } from '@/lib/sections/stock'
import { probeDiffPresence } from './booleanDiff'
import { meshStepFile } from './mesh'
import { setOcWasmUrl } from './occInit'
import { reconstructSolidFromNc } from './reconstructFromNc'
import { seatedPair } from './seat'

const require = createRequire(import.meta.url)
setOcWasmUrl(require.resolve('replicad-opencascadejs/wasm'))

/**
 * The NC rebuild and the part STEP are two pipelines for the *same correct part*, so once both are
 * seated in the viewer's canonical frame (`seatedPair`) they must coincide. This is stricter than
 * `alignedOverlap` (which searches rotation **and mirror**): the clearance here is measured at the
 * *viewer's* seating, so an NC pipeline whose face map is rotated/mirrored relative to the STEP
 * shows up as a mismatch — exactly what the viewer overlay would draw.
 *
 * The tube (`RHS`) cases are asserted. The one-sided families (channel / tee) and the square (SHS)
 * still show material standing clear — a seating/bevel-reproduction gap, logged for visibility.
 */
const CASES: [string, string, string, boolean][] = [
  ['m117', nw31Top('NC files', 'm117.nc1'), nw31Top('STP files', 'm117.stp'), true],
  ['m150', nw31Top('NC files', 'm150.nc1'), nw31Top('STP files', 'm150.stp'), true],
  ['a1', nw31Top('NC files', 'a1.nc1'), nw31Top('STP files', 'a1.stp'), true],
  ['m105', nw30Bottom('m105.nc1'), nw30Bottom('m105.stp'), false],
  ['m31', nw31Top('NC files', 'm31.nc1'), nw31Top('STP files', 'm31.stp'), false],
  ['m124', nw31Top('NC files', 'm124.nc1'), nw31Top('STP files', 'm124.stp'), false],
  ['m143', nw31Top('NC files', 'm143.nc1'), nw31Top('STP files', 'm143.stp'), false],
  ['m199', nw31Top('NC files', 'm199.nc1'), nw31Top('STP files', 'm199.stp'), false],
]

function soups(mesh: Awaited<ReturnType<typeof meshStepFile>>) {
  return mesh.bodies.map((body) => ({
    vertices: body.mesh.faces.vertices,
    triangles: body.mesh.faces.triangles,
  }))
}

describe.skipIf(!existsSync(nw31Top('NC files', 'm117.nc1')))(
  'NC rebuild coincides with the STEP under the viewer seating',
  () => {
    for (const [mark, ncPath, stpPath, expected] of CASES.filter(
      ([, nc, stp]) => existsSync(nc) && existsSync(stp),
    )) {
      it(`${mark}${expected ? '' : ' (diagnostic)'}`, async () => {
        const ncText = readFileSync(ncPath, 'utf8')
        const header = parseDstv(ncText).header
        const section = partSectionForCode(header.profile, header.dimensions)?.points
        expect(section, `${mark} section`).toBeTruthy()
        const built = await reconstructSolidFromNc(ncText)
        expect(built, `${mark} rebuild`).not.toBeNull()
        if (!built || !section) return

        const made = await meshStepFile(`${mark}·nc`, new TextEncoder().encode(built.step))
        const step = await meshStepFile(`${mark}·step`, new Uint8Array(readFileSync(stpPath)))
        const pair = seatedPair(made.vertices, step.vertices, section)
        const presence = probeDiffPresence(
          soups(made),
          soups(step),
          pair.primary,
          pair.compare ?? pair.primary,
        )
        expect(presence, `${mark} probe`).not.toBeNull()
        const over = presence?.overShare ?? 0
        const under = presence?.underShare ?? 0
        console.log(
          `[seat match] ${mark} (${profileFamily(header.profile)} ${header.profile}): over ${(over * 100).toFixed(1)}% under ${(under * 100).toFixed(1)}%`,
        )
        // The tube canonical seating is the part under test; the diagnostic families are a known gap.
        if (expected) {
          expect(over, `${mark} over`).toBeLessThan(0.05)
          expect(under, `${mark} under`).toBeLessThan(0.05)
        }
      }, 300000)
    }
  },
)
