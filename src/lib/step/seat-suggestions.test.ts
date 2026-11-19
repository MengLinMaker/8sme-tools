import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { hexModuleFrames, ubSection } from '@test/fixtures'
import { Matrix4, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { parseDstv } from '@/lib/parsers/dstv'
import { partSectionForCode } from '@/lib/sections/stock'
import { detectStepSection } from '@/lib/step/readSection'
import { seatedFromSeat, seatedStepProfile } from '@/lib/step/seat'
import {
  type Flat,
  faceFlats,
  ransacSectionPose,
  recentreSeat,
  scoreSeat,
  sectionFlats,
  sectionRotationMatrix,
  sectionTranslation,
} from '@/lib/step/seatFit'
import type { BrepFace } from './mesh'
import { meshStepFile } from './mesh'
import { setOcWasmUrl } from './occInit'

const require = createRequire(import.meta.url)
setOcWasmUrl(require.resolve('replicad-opencascadejs/wasm'))

/**
 * The measured answer to a "CAD-grade refinement pipeline" suggestion (sampling with analytical
 * normals → robust point-to-plane ICP → dense datum matching). See `docs/architecture.md` §17.
 *
 * Four claims are pinned here, because each one decides a piece of our design:
 *  1. Sampling costs nothing *when the points come from CAD* — a plane fitted to a face's own
 *     boundary reproduces the analytic plane, so sampling cannot beat the analytic parameters.
 *  2. Outlier rejection is essential: without it a 2° rough pose "converges" to ≥2° of tilt.
 *  3. An M-estimator is not a free upgrade over a hard gate: they tie on some parts, and each wins
 *     on others — so refinement must propose both and keep the better score.
 *  4. No refinement reaches RANSAC's own result: RANSAC *solves* the planes instead of minimising
 *     residuals, which is why the shipped seat has no refinement stage.
 */

/** One weighted plane-ICP step, with either a hard distance gate or a Tukey robust loss. */
function icpStep(
  catalogue: readonly Flat[],
  model: readonly Flat[],
  mode: 'all' | 'gate' | 'tukey',
  gate: number,
): { angle: number; tu: number; tv: number } | null {
  const cos = Math.cos((10 * Math.PI) / 180)
  const pairs: {
    normal: [number, number]
    point: [number, number]
    target: number
    weight: number
  }[] = []
  for (const flat of catalogue) {
    let best: { flat: Flat; residual: number } | null = null
    for (const candidate of model) {
      const dot = flat.normal[0] * candidate.normal[0] + flat.normal[1] * candidate.normal[1]
      if (dot < cos) continue
      const residual = Math.abs(candidate.offset - flat.offset)
      if (!best || residual < best.residual) best = { flat: candidate, residual }
    }
    if (!best) continue
    let weight = 1
    if (mode === 'gate') {
      if (best.residual > gate) continue
    } else if (mode === 'tukey') {
      const u = best.residual / gate
      if (u >= 1) continue
      weight = (1 - u * u) ** 2
    }
    pairs.push({
      normal: flat.normal,
      point: best.flat.point,
      target: flat.offset,
      weight: weight * Math.max(1, best.flat.length),
    })
  }
  if (pairs.length < 3) return null
  const ata = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ]
  const atb = [0, 0, 0]
  for (const pair of pairs) {
    const [nx, ny] = pair.normal
    const [px, py] = pair.point
    // A section rotation by δ moves p to p + δ(−py, px); one plane gives one equation.
    const row = [nx * -py + ny * px, nx, ny]
    const residual = pair.target - (nx * px + ny * py)
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) (ata[i] as number[])[j] += pair.weight * row[i]! * row[j]!
      atb[i] += pair.weight * row[i]! * residual
    }
  }
  for (let i = 0; i < 3; i++) (ata[i] as number[])[i] += 1e-12
  const m = ata.map((row, index) => [...row, atb[index] as number])
  for (let column = 0; column < 3; column++) {
    let pivot = column
    for (let row = column + 1; row < 3; row++)
      if (Math.abs(m[row]?.[column] as number) > Math.abs(m[pivot]?.[column] as number)) pivot = row
    if (Math.abs(m[pivot]?.[column] as number) < 1e-14) return null
    ;[m[column], m[pivot]] = [m[pivot] as number[], m[column] as number[]]
    const divisor = m[column]?.[column] as number
    for (let k = column; k <= 3; k++)
      (m[column] as number[])[k] = (m[column] as number[])[k]! / divisor
    for (let row = 0; row < 3; row++) {
      if (row === column) continue
      const factor = m[row]?.[column] as number
      for (let k = column; k <= 3; k++)
        (m[row] as number[])[k] = (m[row] as number[])[k]! - factor * (m[column] as number[])[k]!
    }
  }
  return { angle: m[0]?.[3] as number, tu: m[1]?.[3] as number, tv: m[2]?.[3] as number }
}

/** Plane fitted from a face's sampled boundary (Newell) vs the analytic parameters OCC gives us. */
function sampledPlaneError(face: BrepFace): { normalDeg: number; offsetMm: number } | null {
  const wire = face.wires[0]
  if (!wire) return null
  const points: [number, number, number][] = []
  for (const edge of wire.edges)
    for (let i = 0; i + 2 < edge.points.length; i += 3)
      points.push([
        edge.points[i] as number,
        edge.points[i + 1] as number,
        edge.points[i + 2] as number,
      ])
  if (points.length < 3) return null
  let nx = 0
  let ny = 0
  let nz = 0
  for (let i = 0; i < points.length; i++) {
    const a = points[i] as [number, number, number]
    const b = points[(i + 1) % points.length] as [number, number, number]
    nx += (a[1] - b[1]) * (a[2] + b[2])
    ny += (a[2] - b[2]) * (a[0] + b[0])
    nz += (a[0] - b[0]) * (a[1] + b[1])
  }
  const fitted = new Vector3(nx, ny, nz)
  if (fitted.lengthSq() < 1e-12) return null
  fitted.normalize()
  const analytic = new Vector3(...(face.normal as [number, number, number])).normalize()
  if (fitted.dot(analytic) < 0) fitted.negate()
  const centre = new Vector3(...(face.center as [number, number, number]))
  return {
    normalDeg: (analytic.angleTo(fitted) * 180) / Math.PI,
    offsetMm: Math.abs(fitted.dot(centre) - analytic.dot(centre)),
  }
}

interface Part {
  mark: string
  vertices: number[]
  faces: BrepFace[]
  catalogue: Flat[]
  reference: Matrix4
}

async function loadPart(mark: string, bytes: Uint8Array, ncText?: string): Promise<Part | null> {
  const guess = ncText
    ? (() => {
        const header = parseDstv(ncText).header
        return { code: header.profile, dims: header.dimensions, seat: null }
      })()
    : await detectStepSection(bytes)
  if (!guess) return null
  const section = partSectionForCode(guess.code, guess.dims)
  if (!section) return null
  const mesh = await meshStepFile(mark, bytes)
  const faces = mesh.bodies.flatMap((body) => body.brep ?? [])
  const catalogue = sectionFlats(section.points)
  const base = guess.seat
    ? seatedFromSeat(mesh.vertices, guess.seat, section.points).primary
    : seatedStepProfile(mesh.vertices, section.points).primary
  const reference = ransacSectionPose(catalogue, faces, mesh.vertices, base, 0.1)
  if (!reference) return null
  return { mark, vertices: mesh.vertices, faces, catalogue, reference: reference.matrix }
}

describe('CAD refinement suggestions, measured', () => {
  it('pins what sampling, robust ICP and RANSAC each contribute', async () => {
    const parts: Part[] = []
    for (const mark of ['item1', 'item9', 'item10', 'item11', 'item12', 'item13', 'item35']) {
      const part = await loadPart(
        mark,
        new Uint8Array(readFileSync(hexModuleFrames(`${mark}.stp`))),
      )
      if (part) parts.push(part)
    }
    const ub = await loadPart(
      'M_12',
      new Uint8Array(readFileSync(ubSection('M_12.stp'))),
      readFileSync(ubSection('M_12.nc1'), 'utf8'),
    )
    if (ub) parts.push(ub)
    expect(parts.length).toBeGreaterThan(4)

    const results = new Map<
      string,
      { truth: number; wild: number; gate: number; tukeyTight: number; tukeyLoose: number }
    >()
    let worstSampledNormal = 0
    let worstSampledOffset = 0

    for (const part of parts) {
      const scoreOf = (matrix: Matrix4) => scoreSeat(part.catalogue, faceFlats(part.faces, matrix))
      for (const face of part.faces) {
        if (!face.planar) continue
        const sampled = sampledPlaneError(face)
        if (!sampled) continue
        worstSampledNormal = Math.max(worstSampledNormal, sampled.normalDeg)
        worstSampledOffset = Math.max(worstSampledOffset, sampled.offsetMm)
      }

      // A rough pose nobody would call close: 2° of roll and 3 mm of shift.
      const rough = recentreSeat(
        part.vertices,
        new Matrix4().multiplyMatrices(
          sectionTranslation(3, -3).multiply(sectionRotationMatrix((2 * Math.PI) / 180)),
          part.reference,
        ),
      )
      const refine = (mode: 'all' | 'gate' | 'tukey', gate: number): number => {
        let matrix = rough
        for (let iteration = 0; iteration < 30; iteration++) {
          const step = icpStep(part.catalogue, faceFlats(part.faces, matrix), mode, gate)
          if (!step) break
          const delta = Math.max(-0.12, Math.min(0.12, step.angle)) * 0.5
          matrix = recentreSeat(
            part.vertices,
            new Matrix4().multiplyMatrices(
              sectionTranslation(step.tu, step.tv).multiply(sectionRotationMatrix(delta)),
              matrix,
            ),
          )
          if (Math.abs(step.angle) < 1e-5 && Math.hypot(step.tu, step.tv) < 1e-4) break
        }
        return scoreOf(matrix).tilt
      }
      results.set(part.mark, {
        truth: scoreOf(part.reference).tilt,
        wild: refine('all', 0),
        gate: refine('gate', 0.05),
        tukeyTight: refine('tukey', 0.05),
        tukeyLoose: refine('tukey', 0.5),
      })
    }

    for (const [mark, result] of results) {
      console.log(
        `[suggestions] ${mark.padEnd(6)} truth ${result.truth.toFixed(2)}° | wild ${result.wild.toFixed(2)}° | ` +
          `gate .05 ${result.gate.toFixed(2)}° | tukey .05 ${result.tukeyTight.toFixed(2)}° | tukey .5 ${result.tukeyLoose.toFixed(2)}°`,
      )
    }
    console.log(
      `[suggestions] sampled plane vs analytic: worst normal ${worstSampledNormal.toFixed(4)}°, worst offset ${worstSampledOffset.toFixed(4)} mm`,
    )

    // 1. CAD sampling reproduces the analytic plane: it cannot improve on it.
    expect(worstSampledNormal, 'sampled plane normal').toBeLessThan(0.05)
    expect(worstSampledOffset, 'sampled plane offset').toBeLessThan(0.05)

    // 2. No rejection lets an inconsistent plane rotate the part by degrees.
    expect(results.get('item11')?.wild, 'wild ICP on item11').toBeGreaterThan(1)
    expect(results.get('item13')?.wild, 'wild ICP on item13').toBeGreaterThan(1)

    // 3. Tukey at the gate radius is the hard gate to within numerical noise (inside the gate its
    // weights are <1, so the fit differs in the sixth decimal); at a wider radius it trades wins.
    for (const [mark, result] of results) {
      expect(Math.abs(result.tukeyTight - result.gate), `${mark} tukey@gate ≡ gate`).toBeLessThan(
        1e-3,
      )
    }
    expect(results.get('item1')?.gate, 'item1 hard gate').toBeGreaterThan(0.2)
    expect(results.get('item1')?.tukeyLoose, 'item1 wide Tukey').toBeLessThan(0.1)
    expect(results.get('M_12')?.tukeyLoose, 'M_12 wide Tukey').toBeGreaterThan(
      (results.get('M_12')?.gate ?? 0) + 0.05,
    )

    // 4. No refinement beats the solved pose — the reason the seat runs no refinement.
    for (const [mark, result] of results) {
      const best = Math.min(result.wild, result.gate, result.tukeyTight, result.tukeyLoose)
      expect(best, `${mark} best refinement vs RANSAC`).toBeGreaterThanOrEqual(result.truth - 0.01)
    }
  }, 900_000)
})
