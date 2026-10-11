import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ensureOc, setOcWasmUrl } from './occInit'
import { sabreTest } from './sabre'

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

const TOP = join(
  process.env.USERPROFILE ?? '',
  'Downloads',
  'Failed tests',
  '11602-03-01 (NW31 Top frames) Shaft part drawings',
  'Shaft part drawings',
  'STP files',
)
const BOT = join(
  process.env.USERPROFILE ?? '',
  'Downloads',
  'Failed tests',
  '11602-02-01 NW31 BOTTOM & MIDDLE FRAMES - Shafts',
)
const HAVE = existsSync(join(TOP, 'm117.stp')) && existsSync(join(BOT, 'm128.stp'))

describe.skipIf(!HAVE)('light sabre test', () => {
  it('fails the shaved PFC end', async () => {
    await ensureOc()
    const bad = await sabreTest(new Uint8Array(readFileSync(join(BOT, 'm128.stp'))))
    expect(bad.ok).toBe(false)
    expect(bad.failures.length).toBeGreaterThan(0)
  }, 600000)
})
