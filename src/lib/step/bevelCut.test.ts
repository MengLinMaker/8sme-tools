import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { nw31Top } from '@test/fixtures'
import { Matrix4, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { parseDstv } from '@/lib/parsers/dstv'
import { partSectionForCode } from '@/lib/sections/stock'
import { measureStep } from './measure'
import { meshStepFile } from './mesh'
import { setOcWasmUrl } from './occInit'
import { reconstructStepFromNc } from './reconstructFromNc'
import { seatedPair } from './seat'

const require = createRequire(import.meta.url)
setOcWasmUrl(require.resolve('replicad-opencascadejs/wasm'))

/** Planar faces that are not parallel to any world axis: the slanted welding-prep walls. */
function tiltedPlanarFaces(meshed: Awaited<ReturnType<typeof meshStepFile>>): number[] {
  const tilts: number[] = []
  for (const body of meshed.bodies) {
    for (const face of body.brep ?? []) {
      if (!face.planar) continue
      const [nx, ny, nz] = face.normal
      const alongAxis = Math.max(Math.abs(nx), Math.abs(ny), Math.abs(nz))
      if (alongAxis < 0.995) tilts.push((Math.acos(alongAxis) * 180) / Math.PI)
    }
  }
  return tilts.sort((a, b) => a - b)
}

/**
 * Sign of the v-face bevel's tilt in the seated frame: the Y component of the bevel face normal.
 * In the canonical stance the two sides of the PFC web give opposite signs, so this catches the
 * DSTV angle sign being ignored (m31 is +20°, m124 is -20°).
 */
function vBevelNormalYs(
  meshed: Awaited<ReturnType<typeof meshStepFile>>,
  matrix?: Matrix4,
): number[] {
  const out: number[] = []
  const rotation = matrix ? new Matrix4().extractRotation(matrix) : undefined
  for (const body of meshed.bodies) {
    for (const face of body.brep ?? []) {
      if (!face.planar) continue
      let [nx, ny, nz] = face.normal
      if (matrix && rotation) {
        const n = new Vector3(nx, ny, nz).applyMatrix4(rotation).normalize()
        ;[nx, ny, nz] = [n.x, n.y, n.z]
      }
      const axis = Math.max(Math.abs(nx), Math.abs(ny), Math.abs(nz))
      const tilt = (Math.acos(axis) * 180) / Math.PI
      // v-face bevel: tilted off the member axis, in the section's Y plane (no depth-Z component).
      if (tilt < 8 || tilt > 46 || Math.abs(nz) > 0.05 || Math.abs(nx) < 0.5) continue
      out.push(ny)
    }
  }
  return out.sort((a, b) => a - b)
}

/**
 * Welding-prep bevels are built as a solid and **subtracted** (approach 2): a triangular wedge
 * anchored on the NC cut line, swept along the edge, its slanted face left in the part. Without it
 * the same cuts are square, so the reconstructed part must gain a tilted planar face and lose the
 * wedge volume.
 */
describe('reconstructed bevel cuts', () => {
  const marks = ['m31', 'm124', 'm130'] as const
  for (const mark of marks) {
    const ncPath = nw31Top('NC files', `${mark}.nc1`)
    const stpPath = nw31Top('STP files', `${mark}.stp`)
    it.skipIf(!existsSync(ncPath) || !existsSync(stpPath))(
      `${mark} subtracts the NC bevel wedge on the correct plate side`,
      async () => {
        const nc = readFileSync(ncPath, 'utf8')
        const header = parseDstv(nc).header
        const section = partSectionForCode(header.profile, header.dimensions)
        if (!section) throw new Error(`no section for ${header.profile}`)

        const squareStep = await reconstructStepFromNc(nc, { bevels: false, sabre: false })
        const bevelStep = await reconstructStepFromNc(nc, { sabre: false })
        expect(squareStep).toBeTruthy()
        expect(bevelStep).toBeTruthy()
        if (!squareStep || !bevelStep) return

        const square = await measureStep(new TextEncoder().encode(squareStep))
        const bevel = await measureStep(new TextEncoder().encode(bevelStep))
        expect(bevel.bodies).toBe(1)
        expect(bevel.volume).toBeLessThan(square.volume)

        const squareMesh = await meshStepFile(
          `${mark}·square`,
          new TextEncoder().encode(squareStep),
        )
        const bevelMesh = await meshStepFile(`${mark}·bevel`, new TextEncoder().encode(bevelStep))
        expect(tiltedPlanarFaces(bevelMesh).length).toBeGreaterThan(
          tiltedPlanarFaces(squareMesh).length,
        )

        // Same seat the viewer uses (NC primary, STEP registered to it), so the bevel normal's
        // sign is directly comparable with the real part's.
        const real = await meshStepFile(`${mark}·real`, new Uint8Array(readFileSync(stpPath)))
        const seats = seatedPair(bevelMesh.vertices, real.vertices, section.points, true)
        const builtYs = vBevelNormalYs(bevelMesh, seats.primary)
        const realYs = seats.compare ? vBevelNormalYs(real, seats.compare) : []
        expect(builtYs.length).toBeGreaterThan(0)
        expect(realYs.length).toBeGreaterThan(0)
        // Every reconstructed bevel face tilts to the same side as the real part; a sign-blind
        // wedge produces both signs on m124 (negative NC angle).
        for (const y of builtYs) expect(Math.sign(y)).toBe(Math.sign(realYs[0] as number))
        expect(builtYs.some((y) => Math.sign(y) !== Math.sign(realYs[0] as number))).toBe(false)
      },
      300000,
    )
  }
})
