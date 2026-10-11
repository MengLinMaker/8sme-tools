import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { Matrix4 } from 'three'
import { describe, expect, it } from 'vitest'
import { booleanDiff, type DiffSoup, pruneThinSkin } from './booleanDiff'
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

/** Scratch: scan a job and report parts whose diff still has a thin (<gap) skin after the pipeline. */
describe('skin scan (NW31)', () => {
  it('reports remaining skin per part', async () => {
    const marks = readdirSync(NW31)
      .filter((f) => /^m\d+\.nc1$/.test(f))
      .map((f) => f.replace(/\.nc1$/, ''))
      .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))
    const I = new Matrix4()
    let worst = ''
    let worstSkin = 0
    for (const mark of marks) {
      try {
        const stepBytes = new Uint8Array(readFileSync(join(NW31, `${mark}.stp`)))
        const nc = readFileSync(join(NW31, `${mark}.nc1`), 'utf8')
        const madeStep = await reconstructStepFromNc(nc, { reference: stepBytes })
        if (!madeStep) {
          console.log(`${mark}: reconstruct null`)
          continue
        }
        const step = await meshStepFile('s', stepBytes)
        const made = await meshStepFile('m', new TextEncoder().encode(madeStep))
        const soups = (m: typeof step): DiffSoup[] =>
          m.bodies.map((b) => ({
            vertices: b.mesh.faces.vertices,
            triangles: b.mesh.faces.triangles,
          }))
        const bd = booleanDiff(soups(made), soups(step), I, I)
        let skin = 0
        let tris = 0
        for (const label of ['over', 'under'] as const) {
          const geo = bd?.[label] ?? null
          if (!geo) continue
          tris += Math.floor((geo.getAttribute('position')?.count ?? 0) / 3)
          skin += Array.from(pruneThinSkin(geo, 1.5).keep).filter((k) => k === 0).length
        }
        if (skin > 0) console.log(`${mark}: tris=${tris} remainingSkin@1.5=${skin}`)
        if (skin > worstSkin) {
          worstSkin = skin
          worst = mark
        }
      } catch (error) {
        console.log(`${mark}: ERROR ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    console.log(`\nworst: ${worst} (${worstSkin})\n`)
    expect(true).toBe(true)
  }, 1800000)
})
