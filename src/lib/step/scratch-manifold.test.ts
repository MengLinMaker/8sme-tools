import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { Matrix4, Quaternion, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { parseDstv } from '@/lib/parsers/dstv'
import { detectOrientation } from '@/lib/sections/orient'
import { partSectionForCode } from '@/lib/sections/stock'
import type { DiffSoup } from './booleanDiff'
import { manifoldBooleanDiff } from './manifoldDiff'
import { ensureManifold, setManifoldWasmUrl } from './manifoldInit'
import { meshStepFile } from './mesh'
import { setOcWasmUrl } from './occInit'
import { reconstructStepFromNc } from './reconstructFromNc'

const require = createRequire(import.meta.url)
setOcWasmUrl(require.resolve('replicad-opencascadejs/wasm'))
setManifoldWasmUrl(require.resolve('manifold-3d/manifold.wasm'))

const SEAT_ANGLES = [0, -Math.PI / 2, Math.PI, Math.PI / 2]

/** The viewer's per-model seating, replicated: seat each mesh into the profile frame on its own bbox. */
function seatMatrix(vertices: number[], profile: [number, number][] | undefined): Matrix4 {
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i + 2 < vertices.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k] ?? Infinity, vertices[i + k] ?? Infinity)
      max[k] = Math.max(max[k] ?? -Infinity, vertices[i + k] ?? -Infinity)
    }
  }
  const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]]
  const centre = new Vector3((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2)
  const extents = [size[0] ?? 0, size[1] ?? 0, size[2] ?? 0]
  const longAxis = extents.indexOf(Math.max(...extents))
  const unit = (axis: number, sign: number): Vector3 => {
    const v = new Vector3()
    v.setComponent(axis, sign)
    return v
  }
  const toX = new Quaternion()
  if (longAxis !== 0) toX.setFromUnitVectors(unit(longAxis, 1), unit(0, 1))
  let seat = toX.clone()
  if (profile && profile.length >= 3 && vertices.length >= 9) {
    const point = new Vector3()
    const seated: number[] = new Array(vertices.length)
    for (let i = 0; i + 2 < vertices.length; i += 3) {
      point
        .set(vertices[i] - centre.x, vertices[i + 1] - centre.y, vertices[i + 2] - centre.z)
        .applyQuaternion(toX)
      seated[i] = point.x
      seated[i + 1] = point.y
      seated[i + 2] = point.z
    }
    seat = new Quaternion()
      .setFromAxisAngle(
        unit(0, 1),
        SEAT_ANGLES[detectOrientation(profile, seated, 1, 2, [0, 0, 0])] ?? 0,
      )
      .multiply(toX)
  }
  return new Matrix4().compose(
    centre.clone().applyQuaternion(seat).negate(),
    seat,
    new Vector3(1, 1, 1),
  )
}

const FIXTURES = [
  {
    mark: 'm128',
    dir: join(
      process.env.USERPROFILE ?? '',
      'Downloads',
      'Failed tests',
      '11602-02-01 NW31 BOTTOM & MIDDLE FRAMES - Shafts',
    ),
  },
  {
    mark: 'm87',
    dir: join(
      process.env.USERPROFILE ?? '',
      'Downloads',
      'Failed tests',
      '11601-02-01 NW30 BOTTOM FRAMES - SHAFTS',
    ),
  },
]

describe('manifold diff', () => {
  for (const { mark, dir } of FIXTURES) {
    const have = existsSync(join(dir, `${mark}.stp`)) && existsSync(join(dir, `${mark}.nc1`))
    it.skipIf(!have)(
      `differs ${mark}`,
      async () => {
        const stepBytes = new Uint8Array(readFileSync(join(dir, `${mark}.stp`)))
        const nc = readFileSync(join(dir, `${mark}.nc1`), 'utf8')
        const madeStep = await reconstructStepFromNc(nc, { reference: stepBytes })
        expect(madeStep).toBeTruthy()
        const step = await meshStepFile('step', stepBytes)
        const made = await meshStepFile('made', new TextEncoder().encode(madeStep as string))
        const soups = (m: typeof step): DiffSoup[] =>
          m.bodies.map((b) => ({
            vertices: b.mesh.faces.vertices,
            triangles: b.mesh.faces.triangles,
          }))
        const top = await ensureManifold()
        const I = new Matrix4()
        const result = manifoldBooleanDiff(top, soups(made), soups(step), I, I)
        expect(result).not.toBeNull()
        if (!result) return
        const tris = (g: { getAttribute: (n: string) => { count: number } } | null) =>
          g ? g.getAttribute('position').count / 3 : 0
        console.log(
          `${mark} identity: over vol=${result.overVolume.toFixed(0)} under vol=${result.underVolume.toFixed(0)} primaryVol=${result.primaryVolume.toFixed(0)}`,
        )

        // The app seats each model into the profile frame on its own bbox.
        const header = parseDstv(nc).header
        const profile = partSectionForCode(header.profile, header.dimensions)?.points as
          | [number, number][]
          | undefined
        const seated = manifoldBooleanDiff(
          top,
          soups(made),
          soups(step),
          seatMatrix(made.vertices, profile),
          seatMatrix(step.vertices, profile),
        )
        if (seated) {
          console.log(
            `${mark} seated:   over vol=${seated.overVolume.toFixed(0)} under vol=${seated.underVolume.toFixed(0)} over tris=${tris(seated.over)} under tris=${tris(seated.under)}`,
          )
        } else {
          console.log(`${mark} seated:   null`)
        }
        expect(true).toBe(true)
      },
      600000,
    )
  }
})
