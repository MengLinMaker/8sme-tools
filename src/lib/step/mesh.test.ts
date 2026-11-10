import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { chsLeg, fixtureExists } from '@test/fixtures'
import { describe, expect, it } from 'vitest'
import { meshStepFile } from './mesh'
import { setOcWasmUrl } from './occInit'

const require = createRequire(import.meta.url)
setOcWasmUrl(require.resolve('replicad-opencascadejs/wasm'))

const CHS = chsLeg('7347-18m-Leg-Nest-11980.stp')

describe.skipIf(!fixtureExists('chs', '7347-18m-Leg-Nest-11980.stp'))(
  'meshStepFile — render real geometry',
  () => {
    /**
     * A circular hollow's only faces are its cylindrical shell and its two end caps. Reading the
     * curved shell's normal along an edge used to pass a `{x, y, z}` object where replicad wants a
     * `[x, y, z]` tuple, silently projecting the origin — which lies on the cylinder axis and makes
     * OCC throw, so the whole STEP failed to render.
     */
    it('tessellates a CHS without throwing on its cylindrical faces', async () => {
      const meshed = await meshStepFile('chs', new Uint8Array(readFileSync(CHS)))
      expect(meshed.bodies.length).toBeGreaterThan(0)
      expect(meshed.vertices.length).toBeGreaterThan(0)
      for (const body of meshed.bodies) {
        expect(body.mesh.faces.triangles.length).toBeGreaterThan(0)
        expect(body.brep.length).toBeGreaterThan(0)
      }
    }, 600000)
  },
)
