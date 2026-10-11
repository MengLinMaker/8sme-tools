import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import type { BufferGeometry } from 'three'
import { Matrix4 } from 'three'
import { describe, expect, it } from 'vitest'
import { booleanDiff, type DiffSoup } from './booleanDiff'
import { createMeshQuery, diffFraction } from './diffHighlight'
import { meshStepFile } from './mesh'
import { setOcWasmUrl } from './occInit'
import { reconstructSolidFromNc } from './reconstructFromNc'

const require = createRequire(import.meta.url)
setOcWasmUrl(require.resolve('replicad-opencascadejs/wasm'))

const DIR = join(
  process.env.USERPROFILE ?? '',
  'Downloads',
  'Failed tests',
  '11602-02-01 NW31 BOTTOM & MIDDLE FRAMES - Shafts',
)
const OUT = join(process.env.LOCALAPPDATA ?? '', 'Temp', 'opencode', 'm148')

interface Soup {
  vertices: number[]
  triangles: number[]
}
interface Part extends Soup {
  color: [number, number, number]
  bias: number
  triColors?: [number, number, number][]
}

const BASE: [number, number, number] = [184, 186, 190]
const OVER: [number, number, number] = [214, 45, 45]
const UNDER: [number, number, number] = [45, 105, 214]

function soupOf(meshed: { bodies: { mesh: { faces: Soup } }[] }): Soup {
  const vertices: number[] = []
  const triangles: number[] = []
  for (const body of meshed.bodies) {
    const base = vertices.length / 3
    for (const v of body.mesh.faces.vertices) vertices.push(v)
    for (const t of body.mesh.faces.triangles) triangles.push(t + base)
  }
  return { vertices, triangles }
}

function geoToSoup(geometry: BufferGeometry | null): Soup | null {
  if (!geometry) return null
  const pos = geometry.getAttribute('position')
  if (!pos) return null
  const vertices: number[] = []
  for (let i = 0; i < pos.count * 3; i++) vertices.push(pos.array[i] as number)
  const index = geometry.getIndex()
  const triangles: number[] = []
  if (index) {
    for (let i = 0; i < index.count; i++) triangles.push(index.getX(i))
  } else {
    for (let i = 0; i < pos.count; i++) triangles.push(i)
  }
  return { vertices, triangles }
}

function signedVolume({ vertices, triangles }: Soup): number {
  let v = 0
  for (let t = 0; t < Math.floor(triangles.length / 3); t++) {
    const a = (triangles[t * 3] ?? 0) * 3
    const b = (triangles[t * 3 + 1] ?? 0) * 3
    const c = (triangles[t * 3 + 2] ?? 0) * 3
    const ax = vertices[a] ?? 0
    const ay = vertices[a + 1] ?? 0
    const az = vertices[a + 2] ?? 0
    const bx = vertices[b] ?? 0
    const by = vertices[b + 1] ?? 0
    const bz = vertices[b + 2] ?? 0
    const cx = vertices[c] ?? 0
    const cy = vertices[c + 1] ?? 0
    const cz = vertices[c + 2] ?? 0
    v +=
      (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6
  }
  return Math.abs(v)
}

function signedVolumeSigned({ vertices, triangles }: Soup): number {
  let v = 0
  for (let t = 0; t < Math.floor(triangles.length / 3); t++) {
    const a = (triangles[t * 3] ?? 0) * 3
    const b = (triangles[t * 3 + 1] ?? 0) * 3
    const c = (triangles[t * 3 + 2] ?? 0) * 3
    v +=
      (vertices[a]! * (vertices[b + 1]! * vertices[c + 2]! - vertices[b + 2]! * vertices[c + 1]!) -
        vertices[a + 1]! * (vertices[b]! * vertices[c + 2]! - vertices[b + 2]! * vertices[c]!) +
        vertices[a + 2]! * (vertices[b]! * vertices[c + 1]! - vertices[b + 1]! * vertices[c]!)) /
      6
  }
  return v
}

interface Closest {
  d2: number
  qx: number
  qy: number
  qz: number
  nx: number
  ny: number
  nz: number
}

/** Ericson: closest point on triangle + the triangle normal. */
function closestPointOnTriangle(
  px: number,
  py: number,
  pz: number,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number,
): Closest {
  const abx = bx - ax
  const aby = by - ay
  const abz = bz - az
  const acx = cx - ax
  const acy = cy - ay
  const acz = cz - az
  const apx = px - ax
  const apy = py - ay
  const apz = pz - az
  const d1 = abx * apx + aby * apy + abz * apz
  const d2 = acx * apx + acy * apy + acz * apz
  let qx = ax
  let qy = ay
  let qz = az
  if (!(d1 <= 0 && d2 <= 0)) {
    const bpx = px - bx
    const bpy = py - by
    const bpz = pz - bz
    const d3 = abx * bpx + aby * bpy + abz * bpz
    const d4 = acx * bpx + acy * bpy + acz * bpz
    if (d3 >= 0 && d4 <= d3) {
      qx = bx
      qy = by
      qz = bz
    } else {
      const vc = d1 * d4 - d3 * d2
      if (vc <= 0 && d1 >= 0 && d3 <= 0) {
        const v = d1 / (d1 - d3)
        qx = ax + abx * v
        qy = ay + aby * v
        qz = az + abz * v
      } else {
        const cpx = px - cx
        const cpy = py - cy
        const cpz = pz - cz
        const d5 = abx * cpx + aby * cpy + abz * cpz
        const d6 = acx * cpx + acy * cpy + acz * cpz
        if (d6 >= 0 && d5 <= d6) {
          qx = cx
          qy = cy
          qz = cz
        } else {
          const vb = d5 * d2 - d1 * d6
          if (vb <= 0 && d2 >= 0 && d6 <= 0) {
            const w = d2 / (d2 - d6)
            qx = ax + acx * w
            qy = ay + acy * w
            qz = az + acz * w
          } else {
            const va = d3 * d6 - d5 * d4
            if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
              const w = (d4 - d3) / (d4 - d3 + (d5 - d6))
              qx = bx + (cx - bx) * w
              qy = by + (cy - by) * w
              qz = bz + (cz - bz) * w
            } else {
              const den = 1 / (va + vb + vc)
              const v = vb * den
              const w = vc * den
              qx = ax + abx * v + acx * w
              qy = ay + aby * v + acy * w
              qz = az + abz * v + acz * w
            }
          }
        }
      }
    }
  }
  const dx = qx - px
  const dy = qy - py
  const dz = qz - pz
  let nx = aby * acz - abz * acy
  let ny = abz * acx - abx * acz
  let nz = abx * acy - aby * acx
  const l = Math.hypot(nx, ny, nz) || 1
  nx /= l
  ny /= l
  nz /= l
  return { d2: dx * dx + dy * dy + dz * dz, qx, qy, qz, nx, ny, nz }
}

/**
 * Pseudo-normal signed distance (libigl SIGNED_DISTANCE_TYPE_PSEUDONORMAL): each made vertex gets
 * the distance to the nearest ideal triangle, signed by which side of that triangle's normal it
 * lies on. Robust to near-coincidence — no surface intersection, so no slivers.
 */
function vertexSignedDeviation(made: Soup, ideal: Soup): Float32Array {
  const out = new Float32Array(Math.floor(made.vertices.length / 3))
  const iv = ideal.vertices
  const it = ideal.triangles
  const triCount = Math.floor(it.length / 3)
  for (let v = 0; v < out.length; v++) {
    const px = made.vertices[v * 3] as number
    const py = made.vertices[v * 3 + 1] as number
    const pz = made.vertices[v * 3 + 2] as number
    let best = Number.POSITIVE_INFINITY
    let c: Closest | null = null
    for (let t = 0; t < triCount; t++) {
      const a = (it[t * 3] ?? 0) * 3
      const b = (it[t * 3 + 1] ?? 0) * 3
      const d = (it[t * 3 + 2] ?? 0) * 3
      const r = closestPointOnTriangle(
        px,
        py,
        pz,
        iv[a] as number,
        iv[a + 1] as number,
        iv[a + 2] as number,
        iv[b] as number,
        iv[b + 1] as number,
        iv[b + 2] as number,
        iv[d] as number,
        iv[d + 1] as number,
        iv[d + 2] as number,
      )
      if (r.d2 < best) {
        best = r.d2
        c = r
      }
    }
    if (!c) {
      out[v] = 0
      continue
    }
    const dist = Math.sqrt(best)
    const side = (px - c.qx) * c.nx + (py - c.qy) * c.ny + (pz - c.qz) * c.nz
    out[v] = side >= 0 ? dist : -dist
  }
  return out
}

/** Diverging map: negative deviation (undertaken... made short = overcut) red, positive blue. */
function devColor(dev: number, scale = 0.25): [number, number, number] {
  const t = Math.max(-1, Math.min(1, dev / scale))
  const mix = (a: number, b: number, k: number): number => Math.round(a + (b - a) * k)
  const white: [number, number, number] = [232, 232, 235]
  const target: [number, number, number] = t < 0 ? [212, 45, 45] : [45, 105, 214]
  const k = Math.abs(t)
  return [mix(white[0], target[0], k), mix(white[1], target[1], k), mix(white[2], target[2], k)]
}

type Vec3 = [number, number, number]
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const norm = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1
  return [a[0] / l, a[1] / l, a[2] / l]
}

function render(parts: Part[], W: number, H: number, dir: Vec3, up: Vec3, region?: [Vec3, Vec3]) {
  const ss = 2
  const SW = W * ss
  const SH = H * ss
  const zbuf = new Float32Array(SW * SH).fill(Number.POSITIVE_INFINITY)
  const col = new Uint8ClampedArray(SW * SH * 4)
  for (let i = 0; i < SW * SH; i++) {
    col[i * 4] = 245
    col[i * 4 + 1] = 245
    col[i * 4 + 2] = 246
    col[i * 4 + 3] = 255
  }

  // World bbox centre.
  let mn: Vec3 = [Infinity, Infinity, Infinity]
  let mx: Vec3 = [-Infinity, -Infinity, -Infinity]
  for (const p of parts) {
    for (let i = 0; i + 2 < p.vertices.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        mn[k] = Math.min(mn[k], p.vertices[i + k] as number)
        mx[k] = Math.max(mx[k], p.vertices[i + k] as number)
      }
    }
  }
  const c: Vec3 = [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2]
  const f = norm(dir)
  const r = norm(cross(f, up))
  const u = cross(r, f)
  const L = norm([-f[0] + u[0] * 0.55 + r[0] * 0.3, -f[1] + u[1] * 0.55 + r[1] * 0.3, -f[2] + u[2] * 0.55 + r[2] * 0.3])

  const [rmn, rmx] = region ?? [mn, mx]
  let sxMin = Infinity
  let sxMax = -Infinity
  let syMin = Infinity
  let syMax = -Infinity
  for (let i = 0; i < 8; i++) {
    const p: Vec3 = [
      i & 1 ? rmx[0] : rmn[0],
      i & 2 ? rmx[1] : rmn[1],
      i & 4 ? rmx[2] : rmn[2],
    ]
    const d = sub(p, c)
    const sx = dot(d, r)
    const sy = dot(d, u)
    sxMin = Math.min(sxMin, sx)
    sxMax = Math.max(sxMax, sx)
    syMin = Math.min(syMin, sy)
    syMax = Math.max(syMax, sy)
  }
  const sxMid = (sxMin + sxMax) / 2
  const syMid = (syMin + syMax) / 2
  const pad = 10 * ss
  const scale = Math.min((SW - pad * 2) / (sxMax - sxMin || 1), (SH - pad * 2) / (syMax - syMin || 1))
  const toScreen = (d: Vec3): [number, number, number] => {
    const sx = dot(d, r)
    const sy = dot(d, u)
    const depth = dot(d, f)
    return [(sx - sxMid) * scale + SW / 2, (syMid - sy) * scale + SH / 2, depth]
  }

  for (const part of parts) {
    const n = Math.floor(part.vertices.length / 3)
    const sx = new Float32Array(n)
    const sy = new Float32Array(n)
    const dp = new Float32Array(n)
    for (let v = 0; v < n; v++) {
      const d: Vec3 = [
        (part.vertices[v * 3] as number) - c[0],
        (part.vertices[v * 3 + 1] as number) - c[1],
        (part.vertices[v * 3 + 2] as number) - c[2],
      ]
      const s = toScreen(d)
      sx[v] = s[0]
      sy[v] = s[1]
      dp[v] = s[2]
    }
    for (let t = 0; t < Math.floor(part.triangles.length / 3); t++) {
      const tc = part.triColors ? (part.triColors[t] ?? part.color) : part.color
      const i0 = part.triangles[t * 3] ?? 0
      const i1 = part.triangles[t * 3 + 1] ?? 0
      const i2 = part.triangles[t * 3 + 2] ?? 0
      const x0 = sx[i0]
      const y0 = sy[i0]
      const x1 = sx[i1]
      const y1 = sy[i1]
      const x2 = sx[i2]
      const y2 = sy[i2]
      const area = (x1 - x0) * (y2 - y0) - (y1 - y0) * (x2 - x0)
      if (Math.abs(area) < 1e-9) continue
      // World normal for shading.
      const pa: Vec3 = [part.vertices[i0 * 3] as number, part.vertices[i0 * 3 + 1] as number, part.vertices[i0 * 3 + 2] as number]
      const pb: Vec3 = [part.vertices[i1 * 3] as number, part.vertices[i1 * 3 + 1] as number, part.vertices[i1 * 3 + 2] as number]
      const pc: Vec3 = [part.vertices[i2 * 3] as number, part.vertices[i2 * 3 + 1] as number, part.vertices[i2 * 3 + 2] as number]
      const nrm = norm(cross(sub(pb, pa), sub(pc, pa)))
      const inten = 0.32 + 0.68 * Math.abs(dot(nrm, L))
      const cr = Math.round(Math.min(255, tc[0] * inten))
      const cg = Math.round(Math.min(255, tc[1] * inten))
      const cb = Math.round(Math.min(255, tc[2] * inten))
      const z0 = dp[i0] + part.bias
      const z1 = dp[i1] + part.bias
      const z2 = dp[i2] + part.bias
      const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2)))
      const maxX = Math.min(SW - 1, Math.ceil(Math.max(x0, x1, x2)))
      const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)))
      const maxY = Math.min(SH - 1, Math.ceil(Math.max(y0, y1, y2)))
      if (minX > maxX || minY > maxY) continue
      for (let py = minY; py <= maxY; py++) {
        const fy = py + 0.5
        for (let px = minX; px <= maxX; px++) {
          const fx = px + 0.5
          const w0 = ((x1 - fx) * (y2 - fy) - (y1 - fy) * (x2 - fx)) / area
          const w1 = ((x2 - fx) * (y0 - fy) - (y2 - fy) * (x0 - fx)) / area
          const w2 = ((x0 - fx) * (y1 - fy) - (y0 - fy) * (x1 - fx)) / area
          if ((w0 < 0 || w1 < 0 || w2 < 0) && (w0 > 0 || w1 > 0 || w2 > 0)) continue
          const depth = w0 * z0 + w1 * z1 + w2 * z2
          const o = py * SW + px
          if (depth < (zbuf[o] as number)) {
            zbuf[o] = depth
            col[o * 4] = cr
            col[o * 4 + 1] = cg
            col[o * 4 + 2] = cb
            col[o * 4 + 3] = 255
          }
        }
      }
    }
  }

  // Downsample (box filter).
  const out = new Uint8ClampedArray(W * H * 4)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let rr = 0
      let gg = 0
      let bb = 0
      for (let dy = 0; dy < ss; dy++) {
        for (let dx = 0; dx < ss; dx++) {
          const o = (y * ss + dy) * SW + (x * ss + dx)
          rr += col[o * 4] as number
          gg += col[o * 4 + 1] as number
          bb += col[o * 4 + 2] as number
        }
      }
      const q = ss * ss
      const t = (y * W + x) * 4
      out[t] = rr / q
      out[t + 1] = gg / q
      out[t + 2] = bb / q
      out[t + 3] = 255
    }
  }
  return { rgba: out, W, H }
}

// ---- Minimal PNG writer ----
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()
function crc32(buf: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = (CRC_TABLE[(c ^ buf[i]!) & 0xff] as number) ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type: string, data: Uint8Array): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const t = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0)
  return Buffer.concat([len, t, Buffer.from(data), crc])
}
function png(rgba: Uint8ClampedArray, W: number, H: number): Buffer {
  const raw = Buffer.alloc(H * (1 + W * 4))
  for (let y = 0; y < H; y++) {
    raw[y * (1 + W * 4)] = 0
    for (let x = 0; x < W * 4; x++) raw[y * (1 + W * 4) + 1 + x] = rgba[y * W * 4 + x] as number
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(W, 0)
  ihdr.writeUInt32BE(H, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', new Uint8Array(0)),
  ])
}
function montage(images: { rgba: Uint8ClampedArray; W: number; H: number }[]): {
  rgba: Uint8ClampedArray
  W: number
  H: number
} {
  const gap = 6
  const H = images[0]?.H ?? 0
  const W = images.reduce((s, im) => s + im.W + gap, gap)
  const out = new Uint8ClampedArray(W * H * 4)
  for (let i = 0; i < W * H; i++) {
    out[i * 4] = 40
    out[i * 4 + 1] = 40
    out[i * 4 + 2] = 44
    out[i * 4 + 3] = 255
  }
  let xoff = gap
  for (const im of images) {
    for (let y = 0; y < im.H; y++) {
      for (let x = 0; x < im.W; x++) {
        const s = (y * im.W + x) * 4
        const d = (y * W + (x + xoff)) * 4
        out[d] = im.rgba[s] as number
        out[d + 1] = im.rgba[s + 1] as number
        out[d + 2] = im.rgba[s + 2] as number
        out[d + 3] = 255
      }
    }
    xoff += im.W + gap
  }
  return { rgba: out, W, H }
}

interface Variant {
  name: string
  over: Soup | null
  under: Soup | null
  note: string
  surface?: Part
}

async function meshLive(shape: any): Promise<Soup> {
  const blob = shape.blobSTEP()
  const bytes = new Uint8Array(await blob.arrayBuffer())
  return soupOf(await meshStepFile('live', bytes))
}

function bbox({ vertices }: Soup): string {
  const mn = [Infinity, Infinity, Infinity]
  const mx = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i + 2 < vertices.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      mn[k] = Math.min(mn[k] as number, vertices[i + k] as number)
      mx[k] = Math.max(mx[k] as number, vertices[i + k] as number)
    }
  }
  const f = (n: number) => (Number.isFinite(n) ? n.toFixed(1) : '-')
  return `[${mn.map(f).join(',')}]..[${mx.map(f).join(',')}]`
}

describe('m148 diff comparison', () => {
  const have = existsSync(join(DIR, 'm148.stp')) && existsSync(join(DIR, 'm148.nc1'))
  it.skipIf(!have)(
    'renders current CSG vs OCC vs deviation map',
    async () => {
      mkdirSync(OUT, { recursive: true })
      const stepBytes = new Uint8Array(readFileSync(join(DIR, 'm148.stp')))
      const nc = readFileSync(join(DIR, 'm148.nc1'), 'utf8')
      const built = await reconstructSolidFromNc(nc, { reference: stepBytes })
      expect(built).toBeTruthy()
      if (!built) return
      const madeShape = built.solid as any

      const { importSTEP } = await import('replicad')
      const idealShape = (await importSTEP(
        new Blob([new Uint8Array(stepBytes)], { type: 'model/step' }),
      )) as any

      const madeMeshed = await meshStepFile('made', new TextEncoder().encode(built.step))
      const stepMeshed = await meshStepFile('step', stepBytes)
      const madeSoup = soupOf(madeMeshed)
      const stepSoup = soupOf(stepMeshed)
      const soups = (m: typeof madeMeshed): DiffSoup[] =>
        m.bodies.map((b) => ({
          vertices: b.mesh.faces.vertices,
          triangles: b.mesh.faces.triangles,
        }))

      const variants: Variant[] = []

      // A: current pipeline (three-bvh-csg + filter + prune + smooth)
      try {
        const bd = booleanDiff(soups(madeMeshed), soups(stepMeshed), new Matrix4(), new Matrix4())
        variants.push({
          name: 'A_current',
          over: bd ? geoToSoup(bd.over) : null,
          under: bd ? geoToSoup(bd.under) : null,
          note: bd ? `overVol=${bd.overVolume.toFixed(1)} underVol=${bd.underVolume.toFixed(1)}` : 'null',
        })
      } catch (e) {
        variants.push({ name: 'A_current', over: null, under: null, note: `ERROR ${String(e)}` })
      }

      // B: plain B-rep cut (no glue, no fuzzy) — replicad's supported path
      try {
        const overSoup = await meshLive(idealShape.cut(madeShape))
        const underSoup = await meshLive(madeShape.cut(idealShape))
        variants.push({
          name: 'B_occ_plain',
          over: overSoup.triangles.length ? overSoup : null,
          under: underSoup.triangles.length ? underSoup : null,
          note: `overVol=${signedVolume(overSoup).toFixed(1)} underVol=${signedVolume(underSoup).toFixed(1)}`,
        })
      } catch (e) {
        variants.push({ name: 'B_occ_plain', over: null, under: null, note: `ERROR ${String(e)}` })
      }

      // E: signed-distance deviation map (nominal-vs-actual) — the metrology standard
      try {
        const dev = vertexSignedDeviation(madeSoup, stepSoup)
        const orient = signedVolumeSigned(stepSoup) >= 0 ? 1 : -1
        const triColors: [number, number, number][] = []
        let overVol = 0
        let underVol = 0
        let overVol05 = 0
        let underVol05 = 0
        const triCount = Math.floor(madeSoup.triangles.length / 3)
        for (let t = 0; t < triCount; t++) {
          const i0 = madeSoup.triangles[t * 3] as number
          const i1 = madeSoup.triangles[t * 3 + 1] as number
          const i2 = madeSoup.triangles[t * 3 + 2] as number
          const dm =
            (orient *
              ((dev[i0] as number) + (dev[i1] as number) + (dev[i2] as number))) /
            3
          triColors.push(devColor(dm))
          const ax = madeSoup.vertices[i0 * 3] as number
          const ay = madeSoup.vertices[i0 * 3 + 1] as number
          const az = madeSoup.vertices[i0 * 3 + 2] as number
          const bx = madeSoup.vertices[i1 * 3] as number
          const by = madeSoup.vertices[i1 * 3 + 1] as number
          const bz = madeSoup.vertices[i1 * 3 + 2] as number
          const cx = madeSoup.vertices[i2 * 3] as number
          const cy = madeSoup.vertices[i2 * 3 + 1] as number
          const cz = madeSoup.vertices[i2 * 3 + 2] as number
          const ux = bx - ax
          const uy = by - ay
          const uz = bz - az
          const vx = cx - ax
          const vy = cy - ay
          const vz = cz - az
          const area =
            0.5 *
            Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx)
          if (dm < 0) {
            overVol += area * -dm
            if (-dm >= 0.5) overVol05 += area * -dm
          } else {
            underVol += area * dm
            if (dm >= 0.5) underVol05 += area * dm
          }
        }
        variants.push({
          name: 'E_deviation',
          over: null,
          under: null,
          surface: { ...madeSoup, color: BASE, bias: 0.3, triColors },
          note: `overVol=${overVol.toFixed(0)} underVol=${underVol.toFixed(0)} | @0.5mm over=${overVol05.toFixed(0)} under=${underVol05.toFixed(0)}`,
        })
      } catch (e) {
        variants.push({ name: 'E_deviation', over: null, under: null, note: `ERROR ${String(e)}` })
      }

      const basebbox = (() => {
        let mn: Vec3 = [Infinity, Infinity, Infinity]
        let mx: Vec3 = [-Infinity, -Infinity, -Infinity]
        for (let i = 0; i + 2 < madeSoup.vertices.length; i += 3) {
          for (let k = 0; k < 3; k++) {
            mn[k] = Math.min(mn[k], madeSoup.vertices[i + k] as number)
            mx[k] = Math.max(mx[k], madeSoup.vertices[i + k] as number)
          }
        }
        return { mn, mx }
      })()
      const endRegion: [Vec3, Vec3] = [
        [basebbox.mx[0] - 260, basebbox.mn[1] - 8, basebbox.mn[2] - 8],
        [basebbox.mx[0], basebbox.mx[1] + 8, basebbox.mx[2] + 8],
      ]

      const lines: string[] = []
      const views: { tag: string; dir: Vec3; up: Vec3; region?: [Vec3, Vec3] }[] = [
        { tag: 'side', dir: [0, -1, 0.0001], up: [0, 0, 1] },
        { tag: 'iso', dir: [0.55, -0.72, 0.42], up: [0, 0, 1] },
        { tag: 'end', dir: [-1, 0, 0], up: [0, 0, 1], region: endRegion },
      ]

      for (const view of views) {
        const panels: { rgba: Uint8ClampedArray; W: number; H: number }[] = []
        for (const v of variants) {
          const parts: Part[] = []
          if (v.surface) parts.push(v.surface)
          else parts.push({ ...madeSoup, color: BASE, bias: 0.3 })
          if (v.over) parts.push({ ...v.over, color: OVER, bias: -0.02 })
          if (v.under) parts.push({ ...v.under, color: UNDER, bias: -0.02 })
          panels.push(render(parts, 620, 420, view.dir, view.up, view.region))
        }
        const img = montage(panels)
        writeFileSync(join(OUT, `m148_${view.tag}.png`), png(img.rgba, img.W, img.H))
      }

      for (const v of variants) {
        lines.push(
          `${v.name}: overTris=${v.over ? Math.floor(v.over.triangles.length / 3) : 0} underTris=${v.under ? Math.floor(v.under.triangles.length / 3) : 0} ${v.note}`,
        )
        lines.push(`    over bbox ${v.over ? bbox(v.over) : '-'}  under bbox ${v.under ? bbox(v.under) : '-'}`)
      }
      lines.push(`made bbox ${bbox(madeSoup)}`)
      lines.push(`step bbox ${bbox(stepSoup)}`)
      for (const tol of [0.02, 0.05, 0.1, 0.2, 0.5, 1]) {
        const q = createMeshQuery(stepSoup.vertices, stepSoup.triangles, tol)
        const madeMask = q.flagFar(madeSoup.vertices, madeSoup.triangles)
        const qm = createMeshQuery(madeSoup.vertices, madeSoup.triangles, tol)
        const stepMask = qm.flagFar(stepSoup.vertices, stepSoup.triangles)
        lines.push(
          `surface @${tol}mm: made-far=${(diffFraction(madeMask) * 100).toFixed(1)}% step-far=${(diffFraction(stepMask) * 100).toFixed(1)}%`,
        )
      }
      lines.push(`panel order: ${variants.map((v) => v.name).join(' | ')}`)
      writeFileSync(join(OUT, 'results.txt'), lines.join('\n'))
      // eslint-disable-next-line no-console
      console.log(`\n${lines.join('\n')}\n-> ${OUT}\n`)
      expect(true).toBe(true)
    },
    1800000,
  )
})
