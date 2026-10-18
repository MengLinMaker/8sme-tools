import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { nw31Top } from '@test/fixtures'
import type { Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { parseDstv } from '@/lib/parsers/dstv'
import { partSectionForCode } from '@/lib/sections/stock'
import { meshStepFile } from './mesh'
import { setOcWasmUrl } from './occInit'
import { reconstructStepFromNc } from './reconstructFromNc'
import { CANONICAL_X_AXIS, CANONICAL_Y_AXIS, seatedPair, transformVertices } from './seat'

/**
 * Orientation regression for the alignment work (see `architecture.md`). These pin the *orientation*
 * of the seated models, not their shape: the NC rebuild's cross-section can still differ from the
 * STEP (a known rebuild gap), but the frame must be right.
 *
 * Mark lists come from the operator's visual pass over the NW31 Top job. Only a subset ships in the
 * repo; run against the full job by pointing `SME_NW31_TOP` at the directory that holds its
 * `NC files/` and `STP files/` (skips any mark that isn't present).
 */
const require = createRequire(import.meta.url)
setOcWasmUrl(require.resolve('replicad-opencascadejs/wasm'))

const JOB = process.env.SME_NW31_TOP ?? nw31Top()
const NC_DIR = `${JOB}/NC files`
const STP_DIR = `${JOB}/STP files`

/** Scenario 1 — NC only (the manufactured pane): marks whose orientation reads correctly. */
const NC_ONLY = [
  'm118',
  'm119',
  'm124',
  'm125',
  'm126',
  'm149',
  'm171',
  'a1',
  'a3',
  'a4',
  'm117',
  'm123',
  'm154',
  'm24',
  'm172',
  'm173',
  'm211',
]
/** Scenario 2 — NC + STEP (the overlay): the STEP must land on the NC build. */
const NC_AND_STEP = [
  'm119',
  'm124',
  'm125',
  'm126',
  'm149',
  'm28',
  'm29',
  'm24',
  'm172',
  'm173',
  'm211',
]

/**
 * Known-bad marks from the operator's pass — logged, not asserted, so a regression is visible but
 * the suite stays green while they are worked:
 * - `m32`  overlay: beam-axis offset.
 * - `a3`   STEP: beam direction differs (and the same in NC + Diff).
 * - `m117` RHS: same as the angles.
 */
const DIAGNOSTIC = ['m32', 'a3', 'm117']

function pointInPolygon(x: number, y: number, poly: [number, number][]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i] as [number, number]
    const [xj, yj] = poly[j] as [number, number]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}
function nearPolygon(x: number, y: number, poly: [number, number][], tol = 2): boolean {
  if (pointInPolygon(x, y, poly)) return true
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, ay] = poly[j] as [number, number]
    const [bx, by] = poly[i] as [number, number]
    const dx = bx - ax
    const dy = by - ay
    const l = dx * dx + dy * dy
    let t = l > 0 ? ((x - ax) * dx + (y - ay) * dy) / l : 0
    t = Math.max(0, Math.min(1, t))
    if (Math.hypot(x - (ax + t * dx), y - (ay + t * dy)) <= tol) return true
  }
  return false
}

/** Fraction of a seated model's cross-section landing on (or in) the profile. */
function crossSectionFit(
  seated: number[],
  profile: [number, number][],
  xAxis: Vector3,
  yAxis: Vector3,
): number {
  let inside = 0
  let total = 0
  const stride = Math.max(3, Math.floor(seated.length / 3 / 2000) * 3)
  for (let i = 0; i + 2 < seated.length; i += stride) {
    const x = seated[i] as number
    const y = seated[i + 1] as number
    const z = seated[i + 2] as number
    const u = x * xAxis.x + y * xAxis.y + z * xAxis.z
    const v = x * yAxis.x + y * yAxis.y + z * yAxis.z
    if (nearPolygon(u, v, profile)) inside++
    total++
  }
  return total > 0 ? inside / total : 0
}

/** Fraction of `subject` sitting on the surface of `reference` (coarse 3 mm grid, neighbour check). */
function surfaceHit(reference: number[], subject: number[]): number {
  const grid = new Set<string>()
  const rs = Math.max(3, Math.floor(reference.length / 3 / 4000) * 3)
  for (let i = 0; i + 2 < reference.length; i += rs) {
    grid.add(
      `${Math.round((reference[i] as number) / 3)},${Math.round((reference[i + 1] as number) / 3)},${Math.round((reference[i + 2] as number) / 3)}`,
    )
  }
  let hit = 0
  let n = 0
  const ss = Math.max(3, Math.floor(subject.length / 3 / 4000) * 3)
  for (let i = 0; i + 2 < subject.length; i += ss) {
    n++
    const a = Math.round((subject[i] as number) / 3)
    const b = Math.round((subject[i + 1] as number) / 3)
    const c = Math.round((subject[i + 2] as number) / 3)
    let found = false
    for (let dx = -1; dx <= 1 && !found; dx++)
      for (let dy = -1; dy <= 1 && !found; dy++)
        for (let dz = -1; dz <= 1 && !found; dz++)
          if (grid.has(`${a + dx},${b + dy},${c + dz}`)) found = true
    if (found) hit++
  }
  return n > 0 ? hit / n : 0
}

function load(mark: string): {
  profile: [number, number][]
  nc: string
  stp?: Uint8Array
} | null {
  const ncPath = `${NC_DIR}/${mark}.nc1`
  if (!existsSync(ncPath)) return null
  const header = parseDstv(readFileSync(ncPath, 'utf8')).header
  const section = partSectionForCode(header.profile ?? '', header.dimensions ?? [])
  if (!section) return null
  const stpPath = `${STP_DIR}/${mark}.stp`
  return {
    profile: section.points,
    nc: readFileSync(ncPath, 'utf8'),
    stp: existsSync(stpPath) ? new Uint8Array(readFileSync(stpPath)) : undefined,
  }
}

describe('seat orientation — scenario 1 (NC only, vs stock)', () => {
  for (const mark of NC_ONLY) {
    it(mark, async () => {
      const data = load(mark)
      if (!data) return // absent from the configured job
      const step = await reconstructStepFromNc(data.nc)
      expect(step, `${mark} rebuild`).toBeTruthy()
      if (!step) return
      const meshed = await meshStepFile(`${mark} nc`, new TextEncoder().encode(step))
      const pair = seatedPair(meshed.vertices, null, data.profile, true)
      const seated = transformVertices(meshed.vertices, pair.primary)
      const fit = crossSectionFit(seated, data.profile, CANONICAL_X_AXIS, CANONICAL_Y_AXIS)
      // Orientation is analytic (no seat guess), so the section must land on the profile.
      expect(fit, `${mark} seated orientation`).toBeGreaterThan(0.9)
    }, 300000)
  }
})

describe('seat orientation — scenario 2 (NC + STEP, overlay)', () => {
  for (const mark of NC_AND_STEP) {
    it(mark, async () => {
      const data = load(mark)
      if (!data?.stp) return
      const step = await reconstructStepFromNc(data.nc)
      expect(step, `${mark} rebuild`).toBeTruthy()
      if (!step) return
      const made = await meshStepFile(`${mark} nc`, new TextEncoder().encode(step))
      const stp = await meshStepFile(`${mark} stp`, data.stp)
      const pair = seatedPair(made.vertices, stp.vertices, data.profile, true)
      expect(pair.compare, `${mark} compare`).not.toBeNull()
      if (!pair.compare) return
      const madeSeated = transformVertices(made.vertices, pair.primary)
      const stpSeated = transformVertices(stp.vertices, pair.compare)
      // Orientation only: the registered STEP must sit on the manufactured mesh (a wrong 90°/flip
      // drops this sharply, while a shape mismatch still keeps most of the surface).
      const hit = surfaceHit(madeSeated, stpSeated)
      expect(hit, `${mark} STEP landed on the NC build`).toBeGreaterThan(0.5)
    }, 300000)
  }
})

describe('seat orientation — known-bad (diagnostic, not asserted)', () => {
  for (const mark of DIAGNOSTIC) {
    it(mark, async () => {
      const data = load(mark)
      if (!data) return
      const step = await reconstructStepFromNc(data.nc)
      if (!step) return
      const made = await meshStepFile(`${mark} nc`, new TextEncoder().encode(step))
      const pairMade = seatedPair(made.vertices, null, data.profile, true)
      const madeSeated = transformVertices(made.vertices, pairMade.primary)
      const ncFit = crossSectionFit(madeSeated, data.profile, CANONICAL_X_AXIS, CANONICAL_Y_AXIS)
      if (!data.stp) {
        // eslint-disable-next-line no-console
        console.log(`[seat diag] ${mark}: NC fit ${(ncFit * 100).toFixed(0)}% (no STEP)`)
        return
      }
      const stp = await meshStepFile(`${mark} stp`, data.stp)
      const stepPair = seatedPair(stp.vertices, null, data.profile)
      const stpPane = transformVertices(stp.vertices, stepPair.primary)
      const stepPaneHit = surfaceHit(madeSeated, stpPane)
      const overlay = seatedPair(made.vertices, stp.vertices, data.profile, true)
      const overlayHit = overlay.compare
        ? surfaceHit(madeSeated, transformVertices(stp.vertices, overlay.compare))
        : 0
      // eslint-disable-next-line no-console
      console.log(
        `[seat diag] ${mark}: NC fit ${(ncFit * 100).toFixed(0)}% · STEP pane hit ${(stepPaneHit * 100).toFixed(0)}% · overlay hit ${(overlayHit * 100).toFixed(0)}%`,
      )
    }, 300000)
  }
})
