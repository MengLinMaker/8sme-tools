import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { Matrix4, Quaternion, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { parseDstv } from '@/lib/parsers/dstv'
import { detectOrientation } from '@/lib/sections/orient'
import { partSectionForCode } from '@/lib/sections/stock'
import {
  booleanDiff,
  booleanDiffRaw,
  type DiffSoup,
  extractComponents,
  filterDrawableFaces,
  KEEP_CLEAR_MM,
  pruneThinSkin,
  toWorldSoup,
} from './booleanDiff'
import {
  closeDiffMask,
  computeDiffMasks,
  createMeshQuery,
  diffFraction,
  resolveDiffTolerance,
} from './diffHighlight'
import { meshStepFile } from './mesh'
import { setOcWasmUrl } from './occInit'
import { reconstructStepFromNc } from './reconstructFromNc'

const require = createRequire(import.meta.url)
setOcWasmUrl(require.resolve('replicad-opencascadejs/wasm'))

const NW31 = join(
  process.env.USERPROFILE ?? '',
  'Downloads',
  'Failed tests',
  '11602-02-01 NW31 BOTTOM & MIDDLE FRAMES - Shafts',
)
const FIXTURES = [
  { mark: 'm15', dir: NW31 },
  { mark: 'm16', dir: NW31 },
  { mark: 'm128', dir: NW31 },
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

describe('diff skin diagnostics', () => {
  for (const { mark, dir } of FIXTURES) {
    const have = existsSync(join(dir, `${mark}.stp`)) && existsSync(join(dir, `${mark}.nc1`))
    it.skipIf(!have)(
      `reports ${mark}`,
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
        const primaryParts = soups(made)
        const compareParts = soups(step)
        const I = new Matrix4()

        const raw = booleanDiffRaw(primaryParts, compareParts, I, I)
        if (!raw) {
          console.log(`${mark}: raw null`)
          return
        }
        const primary = toWorldSoup(primaryParts, I)
        const compare = toWorldSoup(compareParts, I)
        const queryPrimary = createMeshQuery(primary.vertices, primary.triangles, KEEP_CLEAR_MM)
        const queryCompare = createMeshQuery(compare.vertices, compare.triangles, KEEP_CLEAR_MM)

        const report = (label: string, filtered: ReturnType<typeof filterDrawableFaces>) => {
          const geometry = filtered.geometry
          if (!geometry) {
            console.log(`${mark} ${label}: empty`)
            return
          }
          const total = Math.floor((geometry.getAttribute('position')?.count ?? 0) / 3)
          const dists = filtered.distances
          const iface = dists.filter((d) => d < KEEP_CLEAR_MM).length
          const row = [0.5, 0.75, 1.0, 1.5].map((t) => {
            const { keep } = pruneThinSkin(geometry, t)
            return `@${t}=${Array.from(keep).filter((k) => k === 0).length}`
          })
          console.log(
            `${mark} ${label}: tris=${total} interface=${iface} far=${dists.length - iface} prune ${row.join(' ')}`,
          )
        }
        if (raw.over) report('OVER', filterDrawableFaces(raw.over, queryPrimary))
        else console.log(`${mark} OVER: raw empty`)
        if (raw.under) report('UNDER', filterDrawableFaces(raw.under, queryCompare))
        else console.log(`${mark} UNDER: raw empty`)

        // Component-level view of the raw CSG so a dropped component is explained.
        for (const [label, geo, query] of [
          ['over', raw.over, queryPrimary],
          ['under', raw.under, queryCompare],
        ] as const) {
          if (!geo) continue
          const vertices = Array.from(geo.getAttribute('position').array as Float32Array)
          const tris = geo.getIndex()
            ? Array.from(geo.getIndex()?.array as Uint16Array | Uint32Array)
            : Array.from({ length: vertices.length / 3 }, (_, i) => i)
          const comps = extractComponents(geo)
          const info = comps.map((c) => {
            const corners: number[] = []
            for (const t of c.triangles) {
              corners.push(tris[t * 3] ?? 0, tris[t * 3 + 1] ?? 0, tris[t * 3 + 2] ?? 0)
            }
            const d = query.distances(vertices, corners)
            const far = d.filter((v) => v >= KEEP_CLEAR_MM).length
            return `vol=${c.volume.toFixed(0)} tris=${c.triangles.length} far=${(far / d.length).toFixed(2)}`
          })
          console.log(`${mark} ${label}: ${comps.length} comps — ${info.join(' | ')}`)
        }

        // The replacement path: distance-field flagging (no CSG).
        const bounds = (s: DiffSoup) => {
          const min = [Infinity, Infinity, Infinity]
          const max = [-Infinity, -Infinity, -Infinity]
          for (let i = 0; i + 2 < s.vertices.length; i += 3) {
            for (let k = 0; k < 3; k++) {
              min[k] = Math.min(min[k] ?? Infinity, s.vertices[i + k] ?? Infinity)
              max[k] = Math.max(max[k] ?? -Infinity, s.vertices[i + k] ?? -Infinity)
            }
          }
          return [max[0] - min[0], max[1] - min[1], max[2] - min[2]]
        }
        const [sx, sy, sz] = bounds(primary)
        const tolerance = resolveDiffTolerance(Math.hypot(sx, sy, sz))
        const { aDiff, bDiff } = computeDiffMasks(
          primary.vertices,
          primary.triangles,
          compare.vertices,
          compare.triangles,
          tolerance,
          'samples',
        )
        const aClosed = closeDiffMask(primary.vertices, primary.triangles, aDiff)
        const bClosed = closeDiffMask(compare.vertices, compare.triangles, bDiff)
        const vMasks = computeDiffMasks(
          primary.vertices,
          primary.triangles,
          compare.vertices,
          compare.triangles,
          tolerance,
          'vertex',
        )
        console.log(
          `${mark} distance-field: tol=${tolerance.toFixed(2)} vertex under=${diffFraction(vMasks.aDiff).toFixed(3)} over=${diffFraction(vMasks.bDiff).toFixed(3)} | samples under=${diffFraction(aDiff).toFixed(3)}->${diffFraction(aClosed).toFixed(3)} over=${diffFraction(bDiff).toFixed(3)}->${diffFraction(bClosed).toFixed(3)}`,
        )

        // The app seats each model on its own bbox. Replicate that and see if it shifts them apart.
        const header = parseDstv(nc).header
        const profile = partSectionForCode(header.profile, header.dimensions)?.points as
          | [number, number][]
          | undefined
        const mfgW = toWorldSoup(primaryParts, seatMatrix(made.vertices, profile))
        const stpW = toWorldSoup(compareParts, seatMatrix(step.vertices, profile))
        const { aDiff: aSeat, bDiff: bSeat } = computeDiffMasks(
          mfgW.vertices,
          mfgW.triangles,
          stpW.vertices,
          stpW.triangles,
          tolerance,
        )
        const centreOf = (s: DiffSoup): [number, number, number] => {
          let x = 0
          let y = 0
          let z = 0
          let n = 0
          for (let i = 0; i + 2 < s.vertices.length; i += 3) {
            x += s.vertices[i] ?? 0
            y += s.vertices[i + 1] ?? 0
            z += s.vertices[i + 2] ?? 0
            n++
          }
          return [x / n, y / n, z / n]
        }
        const cm = centreOf(mfgW)
        const cs = centreOf(stpW)
        const shift = Math.hypot(cm[0] - cs[0], cm[1] - cs[1], cm[2] - cs[2])
        console.log(
          `${mark} seated (app): over=${diffFraction(bSeat).toFixed(3)} under=${diffFraction(aSeat).toFixed(3)} centreShift=${shift.toFixed(2)}mm`,
        )

        // Full pipeline (filter + prune + thickness-weighted smooth): how much thin wall remains?
        const bd = booleanDiff(soups(made), soups(step), I, I)
        for (const label of ['over', 'under'] as const) {
          const geo = bd?.[label] ?? null
          if (!geo) {
            console.log(`${mark} ${label}: none`)
            continue
          }
          const tris = Math.floor((geo.getAttribute('position')?.count ?? 0) / 3)
          const { keep } = pruneThinSkin(geo, 1)
          const remaining = Array.from(keep).filter((k) => k === 0).length
          console.log(`${mark} ${label}: tris=${tris} remainingSkin@1mm=${remaining}`)
        }
        expect(true).toBe(true)
      },
      600000,
    )
  }
})
