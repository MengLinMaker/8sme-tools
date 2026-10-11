import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { Matrix4 } from 'three'
import { describe, expect, it } from 'vitest'
import { parseDstv } from '@/lib/parsers/dstv'
import { booleanDiff, type DiffSoup } from './booleanDiff'
import { DEVIATION_TOLERANCE_MM, deviationDiff } from './deviationDiff'
import { createMeshQuery, diffFraction, pointTriangleDistanceSquared } from './diffHighlight'
import { manifoldBooleanDiff } from './manifoldDiff'
import { ensureManifold, setManifoldWasmUrl } from './manifoldInit'
import { meshStepFile } from './mesh'
import { occFuzzyDiff } from './occDiff'
import { setOcWasmUrl } from './occInit'
import { reconstructSolidFromNc } from './reconstructFromNc'
import { voxelDiff } from './voxelDiff'

const require = createRequire(import.meta.url)
setOcWasmUrl(require.resolve('replicad-opencascadejs/wasm'))
setManifoldWasmUrl(require.resolve('manifold-3d/manifold.wasm'))

const DIR = join(
  process.env.USERPROFILE ?? '',
  'Downloads',
  'Failed tests',
  '11602-02-01 NW31 BOTTOM & MIDDLE FRAMES - Shafts',
)

type Meshed = Awaited<ReturnType<typeof meshStepFile>>

function soups(m: Meshed): DiffSoup[] {
  return m.bodies.map((b) => ({
    vertices: b.mesh.faces.vertices,
    triangles: b.mesh.faces.triangles,
  }))
}
function allSoup(m: Meshed): DiffSoup {
  const vertices: number[] = []
  const triangles: number[] = []
  for (const b of m.bodies) {
    const base = vertices.length / 3
    for (const v of b.mesh.faces.vertices) vertices.push(v)
    for (const t of b.mesh.faces.triangles) triangles.push(t + base)
  }
  return { vertices, triangles }
}

function bbox({ vertices }: DiffSoup): string {
  const mn = [Infinity, Infinity, Infinity]
  const mx = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i + 2 < vertices.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      mn[k] = Math.min(mn[k] as number, vertices[i + k] as number)
      mx[k] = Math.max(mx[k] as number, vertices[i + k] as number)
    }
  }
  const f = (n: number) => n.toFixed(0)
  const size = [mn[0]! - mx[0]!, mn[1]! - mx[1]!, mn[2]! - mx[2]!].map((d) =>
    Math.abs(d).toFixed(0),
  )
  return `size=[${size.join(',')}] min=[${mn.map(f).join(',')}]`
}

/** Brute-force per-vertex min distance (exact ground truth) to cross-check the grid query. */
function bruteFar(made: DiffSoup, target: DiffSoup, tol: number): number {
  const tol2 = tol * tol
  const triCount = Math.floor(target.triangles.length / 3)
  const madeTris = Math.floor(made.triangles.length / 3)
  let flagged = 0
  for (let t = 0; t < madeTris; t++) {
    let far = false
    for (let k = 0; k < 3 && !far; k++) {
      const vi = (made.triangles[t * 3 + k] ?? 0) * 3
      const px = made.vertices[vi] as number
      const py = made.vertices[vi + 1] as number
      const pz = made.vertices[vi + 2] as number
      let best = Number.POSITIVE_INFINITY
      for (let s = 0; s < triCount; s++) {
        const a = (target.triangles[s * 3] ?? 0) * 3
        const b = (target.triangles[s * 3 + 1] ?? 0) * 3
        const c = (target.triangles[s * 3 + 2] ?? 0) * 3
        const dd = pointTriangleDistanceSquared(
          px,
          py,
          pz,
          target.vertices[a] as number,
          target.vertices[a + 1] as number,
          target.vertices[a + 2] as number,
          target.vertices[b] as number,
          target.vertices[b + 1] as number,
          target.vertices[b + 2] as number,
          target.vertices[c] as number,
          target.vertices[c + 1] as number,
          target.vertices[c + 2] as number,
        )
        if (dd < best) best = dd
        if (best <= tol2) break
      }
      if (!(best <= tol2)) far = true
    }
    if (far) flagged++
  }
  return flagged / madeTris
}

function vertexStats(made: DiffSoup, target: DiffSoup): string {
  const triCount = Math.floor(target.triangles.length / 3)
  const dists: number[] = []
  for (let v = 0; v < Math.floor(made.vertices.length / 3); v++) {
    const px = made.vertices[v * 3] as number
    const py = made.vertices[v * 3 + 1] as number
    const pz = made.vertices[v * 3 + 2] as number
    let best = Number.POSITIVE_INFINITY
    for (let s = 0; s < triCount; s++) {
      const a = (target.triangles[s * 3] ?? 0) * 3
      const b = (target.triangles[s * 3 + 1] ?? 0) * 3
      const c = (target.triangles[s * 3 + 2] ?? 0) * 3
      const dd = pointTriangleDistanceSquared(
        px,
        py,
        pz,
        target.vertices[a] as number,
        target.vertices[a + 1] as number,
        target.vertices[a + 2] as number,
        target.vertices[b] as number,
        target.vertices[b + 1] as number,
        target.vertices[b + 2] as number,
        target.vertices[c] as number,
        target.vertices[c + 1] as number,
        target.vertices[c + 2] as number,
      )
      if (dd < best) best = dd
    }
    dists.push(Math.sqrt(best))
  }
  dists.sort((a, b) => a - b)
  const at = (p: number) =>
    (dists[Math.min(dists.length - 1, Math.floor(p * dists.length))] ?? 0).toFixed(2)
  const over = dists.filter((d) => d > 1).length / dists.length
  return `median=${at(0.5)} p95=${at(0.95)} max=${at(0.999)} >1mm=${(over * 100).toFixed(0)}%`
}

/** Where the made model sits >tol from the ideal: ends / inner void / outer wall. */
function farRegions(made: DiffSoup, target: DiffSoup, tol: number): string {
  const triCount = Math.floor(target.triangles.length / 3)
  let mnx = Infinity
  let mxx = -Infinity
  for (let v = 0; v + 2 < made.vertices.length; v += 3)
    mnx = Math.min(mnx, made.vertices[v] as number)
  for (let v = 0; v + 2 < made.vertices.length; v += 3)
    mxx = Math.max(mxx, made.vertices[v] as number)
  const len = mxx - mnx
  let ends = 0
  let inner = 0
  let outer = 0
  let n = 0
  const margin = 60
  for (let v = 0; v < Math.floor(made.vertices.length / 3); v++) {
    const px = made.vertices[v * 3] as number
    const py = made.vertices[v * 3 + 1] as number
    const pz = made.vertices[v * 3 + 2] as number
    let best = Number.POSITIVE_INFINITY
    for (let s = 0; s < triCount; s++) {
      const a = (target.triangles[s * 3] ?? 0) * 3
      const b = (target.triangles[s * 3 + 1] ?? 0) * 3
      const c = (target.triangles[s * 3 + 2] ?? 0) * 3
      const dd = pointTriangleDistanceSquared(
        px,
        py,
        pz,
        target.vertices[a] as number,
        target.vertices[a + 1] as number,
        target.vertices[a + 2] as number,
        target.vertices[b] as number,
        target.vertices[b + 1] as number,
        target.vertices[b + 2] as number,
        target.vertices[c] as number,
        target.vertices[c + 1] as number,
        target.vertices[c + 2] as number,
      )
      if (dd < best) best = dd
    }
    if (Math.sqrt(best) <= tol) continue
    n++
    const r = Math.max(Math.abs(py), Math.abs(pz))
    if (px - mnx < margin || mxx - px < margin) ends++
    else if (r < 45) inner++
    else outer++
  }
  return `far>${tol}: n=${n} ends=${ends} inner(void)=${inner} outer=${outer} len=${len.toFixed(0)}`
}

function vol({ vertices, triangles }: DiffSoup): number {
  let v = 0
  for (let t = 0; t < Math.floor(triangles.length / 3); t++) {
    const a = (triangles[t * 3] ?? 0) * 3
    const b = (triangles[t * 3 + 1] ?? 0) * 3
    const c = (triangles[t * 3 + 2] ?? 0) * 3
    v +=
      ((vertices[a] as number) *
        ((vertices[b + 1] as number) * (vertices[c + 2] as number) -
          (vertices[b + 2] as number) * (vertices[c + 1] as number)) -
        (vertices[a + 1] as number) *
          ((vertices[b] as number) * (vertices[c + 2] as number) -
            (vertices[b + 2] as number) * (vertices[c] as number)) +
        (vertices[a + 2] as number) *
          ((vertices[b] as number) * (vertices[c + 1] as number) -
            (vertices[b + 1] as number) * (vertices[c] as number))) /
      6
  }
  return Math.abs(v)
}

describe('NW31 issue parts', () => {
  for (const mark of ['m148', 'm116', 'm12', 'm122']) {
    it.skipIf(!require('node:fs').existsSync(join(DIR, `${mark}.stp`)))(
      `diagnoses ${mark}`,
      async () => {
        const stepBytes = new Uint8Array(readFileSync(join(DIR, `${mark}.stp`)))
        const nc = readFileSync(join(DIR, `${mark}.nc1`), 'utf8')
        const header = parseDstv(nc).header
        const built = await reconstructSolidFromNc(nc, { reference: stepBytes })
        if (!built) {
          console.log(`${mark} ${header.profile}: reconstruct null`)
          return
        }
        const made = await meshStepFile('made', new TextEncoder().encode(built.step))
        const step = await meshStepFile('step', stepBytes)
        const I = new Matrix4()

        const madeSoup = allSoup(made)
        const stepSoup = allSoup(step)
        const madeTris = Math.floor(madeSoup.triangles.length / 3)
        const stepTris = Math.floor(stepSoup.triangles.length / 3)

        // Surface separation.
        const farLine: string[] = []
        for (const tol of [0.1, 0.5, 1]) {
          const q = createMeshQuery(stepSoup.vertices, stepSoup.triangles, tol)
          const m = q.flagFar(madeSoup.vertices, madeSoup.triangles)
          const qm = createMeshQuery(madeSoup.vertices, madeSoup.triangles, tol)
          const s = qm.flagFar(stepSoup.vertices, stepSoup.triangles)
          farLine.push(`${tol}mm:made ${(diffFraction(m) * 100).toFixed(0)}%/step ${(diffFraction(s) * 100).toFixed(0)}%`)
        }
        // Same, but a triangle is flagged only when the MAJORITY of a spread of samples is far —
        // the fix for one stray corner painting a whole coarse face.
        const sampleLine: string[] = []
        for (const tol of [0.5, 1, 2]) {
          const q = createMeshQuery(stepSoup.vertices, stepSoup.triangles, tol)
          const m = q.flagFarBySamples(madeSoup.vertices, madeSoup.triangles)
          const qm = createMeshQuery(madeSoup.vertices, madeSoup.triangles, tol)
          const s = qm.flagFarBySamples(stepSoup.vertices, stepSoup.triangles)
          sampleLine.push(`${tol}mm:made ${(diffFraction(m) * 100).toFixed(0)}%/step ${(diffFraction(s) * 100).toFixed(0)}%`)
        }

        const a = booleanDiff(soups(made), soups(step), I, I)
        const d = deviationDiff(soups(made), soups(step), I, I, DEVIATION_TOLERANCE_MM)
        const d1 = deviationDiff(soups(made), soups(step), I, I, 1)
        const d1tris =
          (d1?.over ? Math.floor(d1.over.getAttribute('position').count / 3) : 0) +
          (d1?.under ? Math.floor(d1.under.getAttribute('position').count / 3) : 0)
        const t0 = Date.now()
        const vd = voxelDiff(soups(made), soups(step), I, I, 0.5)
        const ms = Date.now() - t0
        const vTris = (g: { getAttribute: (n: string) => { count: number } } | null | undefined) =>
          g ? Math.floor(g.getAttribute('position').count / 3) : 0
        const top = await ensureManifold()
        const mf = manifoldBooleanDiff(top, soups(made), soups(step), I, I)
        const occLine: string[] = []
        for (const f of [0.1, 0.3, 0.5, 1]) {
          const o = await occFuzzyDiff(
            new TextEncoder().encode(built.step),
            stepBytes,
            I,
            I,
            f,
          )
          occLine.push(
            `${f}:over=${o ? o.overVolume.toFixed(0) : '-'}/under=${o ? o.underVolume.toFixed(0) : '-'}/t${o ? (Math.floor((o.over?.getAttribute('position').count ?? 0) / 3) + Math.floor((o.under?.getAttribute('position').count ?? 0) / 3)) : 0}`,
          )
        }
        const dFlagged = d ? Math.floor((d.overDistance.length + d.underDistance.length) * 1) : 0
        const aTris = a ? [a.over, a.under].filter(Boolean).length : 0

        console.log(
          [
            `${mark} ${header.profile} made=${madeTris}t step=${stepTris}t`,
            `  made bbox ${bbox(madeSoup)} vol ${vol(madeSoup).toFixed(0)}`,
            `  step bbox ${bbox(stepSoup)} vol ${vol(stepSoup).toFixed(0)}`,
            `  far ${farLine.join(' | ')}`,
            `  samples ${sampleLine.join(' | ')}`,
            `  brute1mm: made ${(bruteFar(madeSoup, stepSoup, 1) * 100).toFixed(0)}% step ${(bruteFar(stepSoup, madeSoup, 1) * 100).toFixed(0)}%`,
            `  made verts→step: ${vertexStats(madeSoup, stepSoup)}`,
            `  regions ${farRegions(madeSoup, stepSoup, 2)}`,
            `  A boolean:  over=${a ? a.overVolume.toFixed(0) : '-'} under=${a ? a.underVolume.toFixed(0) : '-'} overTris=${a?.over ? Math.floor(a.over.getAttribute('position').count / 3) : 0} underTris=${a?.under ? Math.floor(a.under.getAttribute('position').count / 3) : 0} (${aTris} sides)`,
            `  D deviation: over=${d ? d.overVolume.toFixed(0) : '-'} under=${d ? d.underVolume.toFixed(0) : '-'} flaggedTris=${dFlagged}/${madeTris} (${((dFlagged / madeTris) * 100).toFixed(0)}%) primary=${d ? d.primaryVolume.toFixed(0) : '-'}`,
            `  D1 margin1mm: over=${d1 ? d1.overVolume.toFixed(0) : '-'} under=${d1 ? d1.underVolume.toFixed(0) : '-'} flaggedTris=${d1tris}/${madeTris} (${((d1tris / madeTris) * 100).toFixed(0)}%)`,
            `  V voxel0.5:  over=${vd ? vd.overVolume.toFixed(0) : '-'} under=${vd ? vd.underVolume.toFixed(0) : '-'} primary=${vd ? vd.primaryVolume.toFixed(0) : '-'} geomTris=${vTris(vd?.over) + vTris(vd?.under)} (${ms}ms)`,
            `  M manifold:  over=${mf ? mf.overVolume.toFixed(0) : '-'} under=${mf ? mf.underVolume.toFixed(0) : '-'} primary=${mf ? mf.primaryVolume.toFixed(0) : '-'} geomTris=${vTris(mf?.over) + vTris(mf?.under)}`,
            `  OCC ${occLine.join(' | ')}`,
          ].join('\n'),
        )
        expect(true).toBe(true)
      },
      600000,
    )
  }
})
