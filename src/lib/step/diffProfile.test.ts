import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { BoxGeometry, Matrix4, Quaternion, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { parseDstv } from '@/lib/parsers/dstv'
import { detectOrientation } from '@/lib/sections/orient'
import { partSectionForCode } from '@/lib/sections/stock'
import {
  booleanDiff,
  booleanDiffRaw,
  type DiffSoup,
  probeDiffPresence,
  toWorldSoup,
} from '@/lib/step/booleanDiff'
import { createMeshQuery, diffFraction } from '@/lib/step/diffHighlight'
import { type MeshedStep, meshStepFile } from '@/lib/step/mesh'
import { ensureOc, setOcWasmUrl } from '@/lib/step/occInit'
import { reconstructSolidFromNc } from '@/lib/step/reconstructFromNc'

const require = createRequire(import.meta.url)
setOcWasmUrl(require.resolve('replicad-opencascadejs/wasm'))

const IDENTITY = new Matrix4()

function boxSoup(w: number, h: number, d: number, cx = 0): DiffSoup {
  const geometry = new BoxGeometry(w, h, d)
  geometry.translate(cx, 0, 0)
  const position = geometry.getAttribute('position')
  const index = geometry.getIndex()
  return {
    vertices: Array.from(position.array as Float32Array),
    triangles: index ? Array.from(index.array as Uint16Array | Uint32Array) : [],
  }
}

describe('diff presence probe (no fixtures needed)', () => {
  it('reports no diff for identical models', () => {
    const soup = [boxSoup(10, 10, 10)]
    const presence = probeDiffPresence(soup, soup, IDENTITY, IDENTITY)
    expect(presence).not.toBeNull()
    expect(presence?.found).toBe(false)
    expect(presence?.overShare).toBe(0)
    expect(presence?.underShare).toBe(0)
  })

  it('reports a diff for offset models', () => {
    const presence = probeDiffPresence(
      [boxSoup(10, 10, 10, 0)],
      [boxSoup(10, 10, 10, 5)],
      IDENTITY,
      IDENTITY,
    )
    expect(presence?.found).toBe(true)
    expect(presence ? Math.max(presence.overShare, presence.underShare) : 0).toBeGreaterThan(0.3)
  })

  it('reports a total diff against an empty model', () => {
    const presence = probeDiffPresence([], [boxSoup(10, 10, 10)], IDENTITY, IDENTITY)
    expect(presence?.found).toBe(true)
    expect(presence?.overShare).toBe(1)
    expect(presence?.underShare).toBe(0)
  })
})

const DIR = join(
  process.env.USERPROFILE ?? '',
  'Downloads',
  'Failed tests',
  '11601-02-01 NW30 BOTTOM FRAMES - SHAFTS',
)
const HAVE_M87 = existsSync(join(DIR, 'm87.nc1')) && existsSync(join(DIR, 'm87.stp'))

const SEAT_ANGLES = [0, -Math.PI / 2, Math.PI, Math.PI / 2]

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
  const unit = (axis: number, sign: number) => {
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

/**
 * Bottleneck profile for the overlay diff on a real part (m87: PFC with notch
 * diffs on both sides). Times each pipeline stage so slow steps show up by
 * name. Order-of-magnitude asserts only — tri counts and volumes drift with
 * tessellation settings, but presence and rough volumes must hold.
 */
describe.skipIf(!HAVE_M87)('overlay diff profile (m87)', () => {
  it('times every stage and finds both diffs', async () => {
    await ensureOc()
    const ncText = readFileSync(join(DIR, 'm87.nc1'), 'utf8')
    const stepBytes = new Uint8Array(readFileSync(join(DIR, 'm87.stp')))
    const header = parseDstv(ncText).header
    const section = partSectionForCode(header.profile, header.dimensions)
    const profile = section?.points as [number, number][] | undefined
    const triTotal = (m: MeshedStep) =>
      m.bodies.reduce((n, b) => n + Math.floor(b.mesh.faces.triangles.length / 3), 0)

    let start = performance.now()
    const built = await reconstructSolidFromNc(ncText, { reference: stepBytes })
    expect(built).not.toBeNull()
    const reconstructMs = performance.now() - start

    start = performance.now()
    const mfg = await meshStepFile('m87·mfg', new TextEncoder().encode(built?.step ?? ''))
    const stp = await meshStepFile('m87·step', stepBytes)
    const meshMs = performance.now() - start

    const soups = (m: typeof mfg) =>
      m.bodies.map((b) => ({ vertices: b.mesh.faces.vertices, triangles: b.mesh.faces.triangles }))
    start = performance.now()
    const mfgMatrix = seatMatrix(mfg.vertices, profile)
    const stpMatrix = seatMatrix(stp.vertices, profile)
    const seatMs = performance.now() - start

    start = performance.now()
    const presence = probeDiffPresence(soups(mfg), soups(stp), mfgMatrix, stpMatrix)
    const probeMs = performance.now() - start
    expect(presence?.found).toBe(true)

    // Split the probe open: index builds vs queries.
    const mfgSoup = toWorldSoup(soups(mfg), mfgMatrix)
    const stpSoup = toWorldSoup(soups(stp), stpMatrix)
    start = performance.now()
    const queryMfg = createMeshQuery(mfgSoup.vertices, mfgSoup.triangles, 1)
    const queryStp = createMeshQuery(stpSoup.vertices, stpSoup.triangles, 1)
    const indexMs = performance.now() - start
    start = performance.now()
    const overShare = diffFraction(queryMfg.flagFar(stpSoup.vertices, stpSoup.triangles))
    const underShare = diffFraction(queryStp.flagFar(mfgSoup.vertices, mfgSoup.triangles))
    const queryMs = performance.now() - start

    start = performance.now()
    const raw = booleanDiffRaw(soups(mfg), soups(stp), mfgMatrix, stpMatrix)
    const rawMs = performance.now() - start
    expect(raw).not.toBeNull()

    start = performance.now()
    const full = booleanDiff(soups(mfg), soups(stp), mfgMatrix, stpMatrix)
    const fullMs = performance.now() - start
    expect(full?.over).not.toBeNull()
    expect(full?.under).not.toBeNull()
    // Loose order-of-magnitude guards for m87's known notch diffs (red ~2.7k,
    // blue ~4k mm³ as measured): presence and rough scale must hold.
    expect(full?.overVolume ?? 0).toBeGreaterThan(1000)
    expect(full?.underVolume ?? 0).toBeGreaterThan(2000)

    const rows: [string, string][] = [
      ['reconstruct (OCC booleans)', `${(reconstructMs / 1000).toFixed(1)}s`],
      [`mesh both (${triTotal(mfg)}/${triTotal(stp)} tris)`, `${(meshMs / 1000).toFixed(1)}s`],
      ['seat + soup', `${seatMs.toFixed(0)}ms`],
      [
        `probe (shares ${(presence ? presence.overShare * 100 : 0).toFixed(1)}%/${(presence ? presence.underShare * 100 : 0).toFixed(1)}%)`,
        `${probeMs.toFixed(0)}ms = index ${indexMs.toFixed(0)} + queries ${queryMs.toFixed(0)} (recomputed ${(overShare * 100).toFixed(1)}%/${(underShare * 100).toFixed(1)}%)`,
      ],
      ['raw CSG both directions', `${(rawMs / 1000).toFixed(1)}s`],
      [
        `full booleanDiff incl. 2nd CSG (over ${(full?.overVolume ?? 0).toFixed(0)} / under ${(full?.underVolume ?? 0).toFixed(0)} mm³)`,
        `${(fullMs / 1000).toFixed(1)}s`,
      ],
    ]
    const width = Math.max(...rows.map(([stage]) => stage.length))
    console.log(
      `\noverlay diff profile (m87):\n${rows.map(([stage, time]) => `  ${stage.padEnd(width)}  ${time}`).join('\n')}`,
    )
  }, 600000)
})
