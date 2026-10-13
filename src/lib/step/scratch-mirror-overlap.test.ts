import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { Matrix4, Quaternion, Vector3 } from 'three'
import { nw30Bottom, nw31Bottom, nw31Top } from '@test/fixtures'
import { describe, it } from 'vitest'
import { ensureOc, setOcWasmUrl } from './occInit'
import { reconstructStepFromNc } from './reconstructFromNc'

const require = createRequire(import.meta.url)
setOcWasmUrl(require.resolve('replicad-opencascadejs/wasm'))

const PARTS: [string, string, string][] = [
  ['m31  PFC', join(nw31Top('NC files'), 'm31.nc1'), join(nw31Top('STP files'), 'm31.stp')],
  ['m41  PFC', join(nw31Top('NC files'), 'm41.nc1'), join(nw31Top('STP files'), 'm41.stp')],
  ['m89  PFC', nw30Bottom('m89.nc1'), nw30Bottom('m89.stp')],
  ['m116 PFC', nw31Bottom('m116.nc1'), nw31Bottom('m116.stp')],
  ['m222 PFC', join(nw31Top('NC files'), 'm222.nc1'), join(nw31Top('STP files'), 'm222.stp')],
  ['m148 SHS6', nw31Bottom('m148.nc1'), nw31Bottom('m148.stp')],
  ['m122 SHS9', nw31Bottom('m122.nc1'), nw31Bottom('m122.stp')],
  ['m143 T', join(nw31Top('NC files'), 'm143.nc1'), join(nw31Top('STP files'), 'm143.stp')],
  ['m199 T', join(nw31Top('NC files'), 'm199.nc1'), join(nw31Top('STP files'), 'm199.stp')],
  ['m164 T', join(nw31Top('NC files'), 'm164.nc1'), join(nw31Top('STP files'), 'm164.stp')],
]

describe('scratch: mirrored vs proper overlap for a PFC', () => {
  it('compares', async () => {
    await import('replicad')
    await ensureOc()
    const { getOC, importSTEP, measureVolume, cast } = await import('replicad')
    const oc = getOC() as any
    const toBlob = (b: Uint8Array) => new Blob([new Uint8Array(b)], { type: 'model/step' })
    const move = (shape: any, m: Matrix4) => {
      const e = m.elements
      const trsf = new oc.gp_Trsf()
      trsf.SetValues(e[0], e[4], e[8], e[12], e[1], e[5], e[9], e[13], e[2], e[6], e[10], e[14])
      return new oc.BRepBuilderAPI_Transform(shape.wrapped, trsf, true).Shape()
    }
    const common = (a: any, b: unknown, f: number): number => {
      try {
        const op = new oc.BRepAlgoAPI_Common(a, b)
        op.SetNonDestructive(true)
        op.SetFuzzyValue(f)
        op.Build()
        if (!op.IsDone()) return 0
        return Math.abs(measureVolume(cast(op.Shape()) as never))
      } catch {
        return 0
      }
    }
    const bbox = (s: any) => {
      const [mn, mx] = s.boundingBox.bounds as [number[], number[]]
      return {
        centre: mn.map((v, k) => (v + mx[k]) / 2),
        size: mn.map((v, k) => mx[k] - v),
        long: (mn.map((v, k) => mx[k] - v) as number[]).indexOf(Math.max(...mn.map((v, k) => mx[k] - v))),
      }
    }
    for (const [label, ncPath, stpPath] of PARTS) {
      const built = await reconstructStepFromNc(readFileSync(ncPath, 'utf8'))
      if (!built) {
        console.log(`${label}: NO BUILD`)
        continue
      }
      const ref = (await importSTEP(toBlob(new Uint8Array(readFileSync(stpPath))))) as any
      const sub = (await importSTEP(toBlob(new TextEncoder().encode(built)))) as any
      const rc = bbox(ref)
      const sc = bbox(sub)
      const unit = (a: number) => new Vector3().setComponent(a, 1)
      const toMember = new Matrix4().makeRotationFromQuaternion(
        new Quaternion().setFromUnitVectors(unit(sc.long), unit(0)),
      )
      const pre = new Matrix4().multiplyMatrices(
        toMember,
        new Matrix4().makeTranslation(-sc.centre[0], -sc.centre[1], -sc.centre[2]),
      )
      const toRef = new Matrix4().makeTranslation(rc.centre[0], rc.centre[1], rc.centre[2])
      let bestProper = 0
      let bestMirror = 0
      for (const mirrored of [false, true]) {
        for (const angle of [0, 90, 180, 270]) {
          const section = new Matrix4()
          if (angle) section.makeRotationX((angle * Math.PI) / 180)
          if (mirrored) section.multiply(new Matrix4().makeScale(1, -1, 1))
          const cand = new Matrix4().multiplyMatrices(toRef, new Matrix4().multiplyMatrices(section, pre))
          const v = common(ref.wrapped, move(sub, cand), 0.1)
          if (mirrored) bestMirror = Math.max(bestMirror, v)
          else bestProper = Math.max(bestProper, v)
        }
      }
      const rv = Math.abs(measureVolume(ref as never))
      console.log(
        `${label}: proper ${(bestProper / rv).toFixed(3)} | mirror ${(bestMirror / rv).toFixed(3)} (ref vol ${(rv / 1e6).toFixed(3)}e6)`,
      )
    }
  }, 900000)
})
