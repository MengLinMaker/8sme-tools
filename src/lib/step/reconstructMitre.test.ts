import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { nw31Bottom } from '@test/fixtures'
import { describe, expect, it } from 'vitest'
import { meshStepFile } from './mesh'
import { setOcWasmUrl } from './occInit'
import { reconstructStepFromNc } from './reconstructFromNc'

const require = createRequire(import.meta.url)
setOcWasmUrl(require.resolve('replicad-opencascadejs/wasm'))

/**
 * m128 (a PFC) has a mitred end where the kerf-eroded axis-1 outline lands ~0.1 mm short of the
 * member's global end. The reconstruction's "band" squares a face off to the global extent so an
 * other face's bevel wedge is not severed — but firing on that near-zero (kerf-only) gap squared
 * the mitre into a full-height vertical end wall: an impossible cut with a wedge of extra material
 * past the sloped face. The band must only fire on a genuine gap.
 */
const DIR = nw31Bottom()
const HAVE = existsSync(join(DIR, 'm128.nc1')) && existsSync(join(DIR, 'm128.stp'))

/** Total area (mm²) of triangles lying flat in the max-X plane — a full end wall vs a mitre tip. */
function endWallArea(vertices: number[], triangles: number[]): number {
  let maxX = Number.NEGATIVE_INFINITY
  for (let i = 0; i + 2 < vertices.length; i += 3) maxX = Math.max(maxX, vertices[i] ?? 0)
  let area = 0
  for (let t = 0; t * 3 < triangles.length; t++) {
    const p = [0, 1, 2].map((k) => {
      const o = (triangles[t * 3 + k] ?? 0) * 3
      return [vertices[o] ?? 0, vertices[o + 1] ?? 0, vertices[o + 2] ?? 0] as [
        number,
        number,
        number,
      ]
    })
    if (!p.every((q) => Math.abs(q[0] - maxX) < 0.1)) continue
    const [a, b, c] = p as [
      [number, number, number],
      [number, number, number],
      [number, number, number],
    ]
    const ab: [number, number, number] = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
    const ac: [number, number, number] = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
    const cr: [number, number, number] = [
      ab[1] * ac[2] - ab[2] * ac[1],
      ab[2] * ac[0] - ab[0] * ac[2],
      ab[0] * ac[1] - ab[1] * ac[0],
    ]
    area += Math.hypot(cr[0], cr[1], cr[2]) / 2
  }
  return area
}

describe.skipIf(!HAVE)('NC reconstruction end geometry', () => {
  it('does not square a near-flush mitre end into a vertical wall (m128)', async () => {
    const nc = readFileSync(join(DIR, 'm128.nc1'), 'utf8')
    const step = await reconstructStepFromNc(nc)
    expect(step).toBeTruthy()
    if (!step) return
    const meshed = await meshStepFile('m128·endwall', new TextEncoder().encode(step))
    const body = meshed.bodies[0]
    expect(body).toBeDefined()
    if (!body) return
    const area = endWallArea(body.mesh.faces.vertices, body.mesh.faces.triangles)
    console.log(`end-wall area=${area.toFixed(1)} mm²`)
    // A mitre tip is a near-zero-area edge; a squared-off end is the whole 100x50 section.
    expect(area).toBeLessThan(100)
  }, 300000)
})
