import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { nw31Bottom, nw31Top } from '@test/fixtures'
import { describe, expect, it } from 'vitest'
import { ensureOc, setOcWasmUrl } from './occInit'
import { type MeshableShape, sabreSamples, sabreTest } from './sabre'

const require = createRequire(import.meta.url)
setOcWasmUrl(require.resolve('replicad-opencascadejs/wasm'))

/**
 * The "light sabre" test against real job parts when the fixtures are present. `m128` (PFC, huge
 * shaved end surface) trips the OCC sabre, so it pins *its* failure behaviour. Note the production
 * analysis no longer uses this 3D test — it flags the shaved end as an 85 mm bore because it fires
 * perpendicular to the finished face, which is wrong for a bevel. The profile cut-reach check in
 * `src/lib/audit/cutReach.ts` is the source of truth; this pins the legacy probe only.
 * Skipped otherwise.
 */

const TOP = nw31Top('STP files')
const BOT = nw31Bottom()
const HAVE = existsSync(join(TOP, 'm117.stp')) && existsSync(join(BOT, 'm128.stp'))

describe.skipIf(!HAVE)('light sabre test', () => {
  it('fails the shaved PFC end', async () => {
    await ensureOc()
    const bad = await sabreTest(new Uint8Array(readFileSync(join(BOT, 'm128.stp'))))
    expect(bad.ok).toBe(false)
    expect(bad.failures.length).toBeGreaterThan(0)
  }, 600000)
})

describe('sabreSamples — cut-line probe', () => {
  /** A 200 × 10 × 200 plate centred on the origin: its +Y face is at y = 5. */
  const plate = async (): Promise<MeshableShape> => {
    await ensureOc()
    const { makeBox } = await import('replicad')
    return makeBox([-100, -5, -100], [100, 5, 100]) as unknown as MeshableShape
  }
  const FACE = { normal: [0, 1, 0] as [number, number, number], depth: 5 }

  it('ignores a line in the middle of a face — another plane’s cut projected onto it', async () => {
    // The beam would end 1.6 mm inside the plate, but the line is not an edge of this face: the
    // material is continuous either side of it, so the normal beam runs along the plate instead of
    // crossing a wall (the Truss 9 shaft's web-tenon end drawn in the flange view).
    const result = sabreSamples(await plate(), [
      { point: [20, 5.4, 0], tangent: [1, 0, 0], ...FACE },
    ])
    expect(result.failures).toHaveLength(0)
  })

  it('still flags a line that is a real edge of the face', async () => {
    const result = sabreSamples(await plate(), [
      { point: [-99.5, 5.4, 0], tangent: [0, 0, 1], ...FACE },
    ])
    expect(result.failures).toHaveLength(1)
  })
})
