import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { hexModuleFrames } from '@test/fixtures'
import { Matrix4, Quaternion, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { partSectionForCode } from '@/lib/sections/stock'
import { detectStepSection } from '@/lib/step/readSection'
import {
  bboxOfVertices,
  type SectionSeat,
  seatedFromSeat,
  seatedStepProfile,
  transformVertices,
} from '@/lib/step/seat'
import {
  faceFlats,
  fitSectionPlanes,
  ransacSectionPose,
  scoreSeat,
  sectionFlats,
  sectionRotationMatrix,
  sectionTranslation,
} from '@/lib/step/seatFit'
import type { BrepFace } from './mesh'
import { meshStepFile } from './mesh'
import { setOcWasmUrl } from './occInit'

/**
 * Seat technique batches — the experiment rig behind `docs/seat-alignment.md`.
 *
 * Every candidate is scored by the same rig (`seatFit.scoreSeat`): the part's planar stock faces
 * must land on the catalogue section's faces, length-weighted by the catalogue flat. The rig is
 * independent of the seating code — it only reads a matrix — so a technique cannot flatter itself.
 *
 * Batch history (J12095 hex frames, the operator's own complaint list):
 *  1. screened: PCA, boundary-weighted stock faces, area-weighted stock faces, quarter-turn search,
 *     corner/edge matching. Winner: stock faces (area) + plane ICP. Edge/corner matching lost.
 *  2. iterated: damped section-plane ICP fixed the roll (item12 20 mm → 0.77 mm).
 *  3. refined: a robust pass on the residual majority took the tilt to 0.02°.
 *
 * The printed table is the evidence; the assertions pin the outcome so a regression fails.
 */

const require = createRequire(import.meta.url)
setOcWasmUrl(require.resolve('replicad-opencascadejs/wasm'))

/** The operator's list: item11 bad, item1 floating, item10 decent, item12 lopsided. */
const ITEMS = ['item1', 'item9', 'item10', 'item11', 'item12', 'item13', 'item35']

interface Part {
  mark: string
  vertices: number[]
  faces: BrepFace[]
  section: [number, number][]
  code: string
  /** The section detector's frame — the app seats STEP parts with this when it is present. */
  seat: SectionSeat | null
}

/** The seat the app actually applies: detector frame when known, else bbox + profile. */
function baseSeat(part: Part, faces = false): Matrix4 {
  const stockFaces = faces ? part.faces : undefined
  return part.seat
    ? seatedFromSeat(part.vertices, part.seat, part.section, stockFaces).primary
    : seatedStepProfile(part.vertices, part.section, stockFaces).primary
}

/** Applies a correction about the seated frame; the part is re-centred on its own bbox. */
function applyCorrection(vertices: number[], base: Matrix4, correction: Matrix4): Matrix4 {
  const composed = new Matrix4().multiplyMatrices(correction, base)
  const centre = bboxOfVertices(transformVertices(vertices, composed))
    .getCenter(new Vector3())
    .negate()
  const rotation = new Quaternion()
  const position = new Vector3()
  const scale = new Vector3()
  composed.decompose(position, rotation, scale)
  return new Matrix4()
    .makeTranslation(centre.x, centre.y, centre.z)
    .multiply(new Matrix4().compose(position, rotation, scale))
}

/** Damped plane ICP from a given start — the local refinement every technique shares. */
function polish(part: Part, start: Matrix4): Matrix4 {
  const catalogue = sectionFlats(part.section)
  let matrix = start
  for (let iteration = 0; iteration < 24; iteration++) {
    const fit = fitSectionPlanes(catalogue, faceFlats(part.faces, matrix))
    if (!fit) break
    const step = Math.max(-0.12, Math.min(0.12, fit.angle)) * 0.5
    const correction = sectionTranslation(fit.tu, fit.tv).multiply(sectionRotationMatrix(step))
    matrix = applyCorrection(part.vertices, matrix, correction)
    if (Math.abs(fit.angle) < 1e-4 && Math.hypot(fit.tu, fit.tv) < 1e-3) break
  }
  return matrix
}

const TECHNIQUES: { name: string; seat: (part: Part) => Matrix4 | null }[] = [
  {
    // Baseline: the detector's frame + the profile-anchored heuristic seat (PCA + containment).
    name: 'detector',
    seat: (part) => baseSeat(part),
  },
  {
    // Shipped: stock-face member axis + damped plane ICP, accepted only when it scores better.
    name: 'shipped',
    seat: (part) => baseSeat(part, true),
  },
  {
    // Face identification: score all four quarter turns on the stock planes and keep the best.
    name: 'quarter-search',
    seat: (part) => {
      const catalogue = sectionFlats(part.section)
      let best: Matrix4 | null = null
      let bestOffset = Number.POSITIVE_INFINITY
      for (const angle of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]) {
        const candidate = applyCorrection(
          part.vertices,
          baseSeat(part),
          new Matrix4().makeRotationX(angle),
        )
        const score = scoreSeat(catalogue, faceFlats(part.faces, candidate))
        if (score.offset < bestOffset) {
          bestOffset = score.offset
          best = candidate
        }
      }
      return best
    },
  },
  {
    // Plane ICP alone (no member-axis stage), damped, with the corrected sign.
    name: 'plane-icp',
    seat: (part) => polish(part, baseSeat(part)),
  },
  {
    // Batch 4: exhaustive plane-pair RANSAC, then ICP polish. Global — it does not need a good
    // start pose, which is what the "floating"/lopsided cases actually are.
    name: 'ransac',
    seat: (part) => {
      const catalogue = sectionFlats(part.section)
      const base = baseSeat(part)
      const global = ransacSectionPose(catalogue, part.faces, part.vertices, base, 1)
      return global ? polish(part, global.matrix) : null
    },
  },
  {
    // Edges: lengthwise edge directions give the member, the four stock corners give the roll.
    name: 'corners',
    seat: (part) => {
      const base = baseSeat(part)
      const rotation = new Quaternion().setFromRotationMatrix(base)
      const member = new Vector3(1, 0, 0).applyQuaternion(rotation)
      const lines: { point: Vector3; direction: Vector3; length: number }[] = []
      for (const face of part.faces)
        for (const wire of face.wires)
          for (const edge of wire.edges) {
            const count = edge.points.length / 3
            if (count < 2) continue
            const first = new Vector3(
              edge.points[0] as number,
              edge.points[1] as number,
              edge.points[2] as number,
            ).applyMatrix4(base)
            const last = new Vector3(
              edge.points[(count - 1) * 3] as number,
              edge.points[(count - 1) * 3 + 1] as number,
              edge.points[(count - 1) * 3 + 2] as number,
            ).applyMatrix4(base)
            const direction = last.clone().sub(first)
            const length = direction.length()
            if (length < 5) continue
            if (Math.abs(direction.normalize().dot(member)) < 0.999) continue
            lines.push({ point: first.clone().add(last).multiplyScalar(0.5), direction, length })
          }
      if (lines.length < 4) return null
      const axis = new Vector3()
      for (const line of lines) axis.add(line.direction.clone().multiplyScalar(line.length))
      axis.normalize()
      if (Math.abs(axis.x) < 0.98) return null
      const axisFix = new Matrix4().makeRotationFromQuaternion(
        new Quaternion().setFromUnitVectors(axis, new Vector3(1, 0, 0)),
      )
      const cornersAt = lines.map((line) => {
        const point = line.point.clone().applyMatrix4(axisFix)
        return [-point.z, point.y] as [number, number]
      })
      const us = part.section.map(([u]) => u)
      const vs = part.section.map(([, v]) => v)
      const maxU = Math.max(...us)
      const maxV = Math.max(...vs)
      const corners: [number, number][] = (
        [
          [-1, -1],
          [1, -1],
          [1, 1],
          [-1, 1],
        ] as const
      ).map(([su, sv]) => {
        let best = part.section[0] as [number, number]
        let bestDistance = Number.POSITIVE_INFINITY
        for (const point of part.section) {
          const distance = Math.hypot(point[0] - su * maxU, point[1] - sv * maxV)
          if (distance < bestDistance) {
            bestDistance = distance
            best = point
          }
        }
        return best
      })
      const pairs: [[number, number], [number, number]][] = []
      for (const corner of corners) {
        let best: [number, number] | null = null
        let bestDistance = Number.POSITIVE_INFINITY
        for (const point of cornersAt) {
          const distance = Math.hypot(point[0] - corner[0], point[1] - corner[1])
          if (distance < bestDistance) {
            bestDistance = distance
            best = point
          }
        }
        if (best) pairs.push([corner, best])
      }
      if (pairs.length < 4) return null
      let cx = 0
      let cy = 0
      let qx = 0
      let qy = 0
      for (const [p, q] of pairs) {
        cx += p[0]
        cy += p[1]
        qx += q[0]
        qy += q[1]
      }
      cx /= pairs.length
      cy /= pairs.length
      qx /= pairs.length
      qy /= pairs.length
      let sxx = 0
      let sxy = 0
      for (const [p, q] of pairs) {
        sxx += (p[0] - cx) * (q[0] - qx) + (p[1] - cy) * (q[1] - qy)
        sxy += (p[0] - cx) * (q[1] - qy) - (p[1] - cy) * (q[0] - qx)
      }
      const angle = Math.atan2(sxy, sxx)
      return applyCorrection(
        part.vertices,
        new Matrix4().multiplyMatrices(sectionRotationMatrix(-angle), axisFix),
        base,
      )
    },
  },
]

describe('seat technique batches', () => {
  it('scores each batch on the J12095 items and pins the winner', async () => {
    const parts: Part[] = []
    for (const mark of ITEMS) {
      const bytes = new Uint8Array(readFileSync(hexModuleFrames(`${mark}.stp`)))
      const guess = await detectStepSection(bytes)
      if (!guess) {
        console.log(`[batch] ${mark}: no section detected`)
        continue
      }
      const section = partSectionForCode(guess.code, guess.dims)
      if (!section) continue
      const mesh = await meshStepFile(mark, bytes)
      parts.push({
        mark,
        vertices: mesh.vertices,
        faces: mesh.bodies.flatMap((body) => body.brep ?? []),
        section: section.points,
        code: guess.code,
        seat: guess.seat ?? null,
      })
    }
    expect(parts.length).toBeGreaterThan(0)

    console.log(
      `\n[batch] mark   code          technique        offset  worst   tilt  missing  matched`,
    )
    const scores = new Map<string, Map<string, { offset: number; tilt: number }>>()
    for (const part of parts) {
      const catalogue = sectionFlats(part.section)
      const perTechnique = new Map<string, { offset: number; tilt: number }>()
      for (const technique of TECHNIQUES) {
        const matrix = technique.seat(part) ?? baseSeat(part)
        const score = scoreSeat(catalogue, faceFlats(part.faces, matrix))
        perTechnique.set(technique.name, { offset: score.offset, tilt: score.tilt })
        console.log(
          `[batch] ${part.mark.padEnd(6)} ${part.code.padEnd(13)} ${technique.name.padEnd(16)} ` +
            `${score.offset.toFixed(2).padStart(7)} ${score.worst.toFixed(2).padStart(6)} ` +
            `${score.tilt.toFixed(2).padStart(6)} ${String(score.missing).padStart(8)} ${String(score.matched).padStart(8)}`,
        )
      }
      scores.set(part.mark, perTechnique)
    }

    // The shipped seat (stock faces + plane ICP) must never lose to the heuristic baseline, and it
    // must fix the two operator-flagged cases.
    for (const part of parts) {
      const shipped = scores.get(part.mark)?.get('shipped')
      const detector = scores.get(part.mark)?.get('detector')
      if (!shipped || !detector) continue
      expect(shipped.offset, `${part.mark} shipped offset`).toBeLessThanOrEqual(
        detector.offset + 0.05,
      )
      expect(shipped.tilt, `${part.mark} shipped tilt`).toBeLessThanOrEqual(detector.tilt + 0.5)
    }
    const item12 = scores.get('item12')
    expect(item12?.get('detector')?.offset, 'item12 baseline is broken').toBeGreaterThan(10)
    expect(item12?.get('shipped')?.offset, 'item12 shipped').toBeLessThan(2)
    const item13 = scores.get('item13')
    expect(item13?.get('shipped')?.tilt, 'item13 roll').toBeLessThan(1)
    // RANSAC's pose is exact on correct plane pairs, so the seat should not merely be close — it
    // should sit inside a hundredth of a degree on every part (the residual offset is geometry).
    for (const part of parts) {
      const shipped = scores.get(part.mark)?.get('shipped')
      expect(shipped?.tilt, `${part.mark} shipped tilt`).toBeLessThanOrEqual(0.05)
    }
  }, 600_000)

  it('RANSAC recovers a pose that ICP cannot (globality)', async () => {
    // ICP's basin of attraction varies by part (item12 happens to survive 25° of roll), so the
    // assertion is: RANSAC recovers every part, and at least one part is a case ICP loses.
    let trapped = 0
    for (const mark of ['item1', 'item10', 'item11', 'item12', 'item13']) {
      const bytes = new Uint8Array(readFileSync(hexModuleFrames(`${mark}.stp`)))
      const guess = await detectStepSection(bytes)
      if (!guess) continue
      const section = partSectionForCode(guess.code, guess.dims)
      if (!section) continue
      const mesh = await meshStepFile(mark, bytes)
      const part: Part = {
        mark,
        vertices: mesh.vertices,
        faces: mesh.bodies.flatMap((body) => body.brep ?? []),
        section: section.points,
        code: guess.code,
        seat: guess.seat ?? null,
      }
      const catalogue = sectionFlats(part.section)
      const scoreOf = (matrix: Matrix4) => scoreSeat(catalogue, faceFlats(part.faces, matrix))
      // A start nobody would call "close": 25° of roll.
      const broken = applyCorrection(
        part.vertices,
        baseSeat(part),
        sectionRotationMatrix((25 * Math.PI) / 180),
      )
      const brokenScore = scoreOf(broken)
      expect(brokenScore.offset, `${mark} broken start is really broken`).toBeGreaterThan(10)

      // Start-pose invariance: the global stage must return the *same* pose whatever it is given.
      const fromGood = ransacSectionPose(catalogue, part.faces, part.vertices, baseSeat(part), 1)
      const fromBroken = ransacSectionPose(catalogue, part.faces, part.vertices, broken, 1)
      expect(fromGood, `${mark} ransac from good`).not.toBeNull()
      expect(fromBroken, `${mark} ransac from broken`).not.toBeNull()
      expect(
        Math.abs(
          (fromGood as { offset: number }).offset - (fromBroken as { offset: number }).offset,
        ),
        `${mark} start invariance`,
      ).toBeLessThan(1e-3)

      // Local refinement usually cannot escape it — count the cases where it cannot.
      const icp = scoreOf(polish(part, broken))
      if (icp.offset > 10) trapped++

      // The global stage does, and needs no seed: every plane pair is a hypothesis.
      const global = ransacSectionPose(catalogue, part.faces, part.vertices, broken, 1)
      expect(global, `${mark} ransac`).not.toBeNull()
      expect(global?.inliers, `${mark} inliers`).toBeGreaterThanOrEqual(5)
      const recovered = scoreOf(polish(part, (global as { matrix: Matrix4 }).matrix))
      console.log(
        `[globality] ${mark.padEnd(6)} broken ${brokenScore.offset.toFixed(1)} | icp ${icp.offset.toFixed(1)} | ransac ${recovered.offset.toFixed(2)} (${global?.inliers}/8)`,
      )
      expect(recovered.offset, `${mark} ransac recovery`).toBeLessThan(2)
    }
    expect(trapped, 'parts where ICP is trapped by the broken start').toBeGreaterThanOrEqual(1)
  }, 600_000)
})
