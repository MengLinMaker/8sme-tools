import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { ubSection } from '@test/fixtures'
import { describe, expect, it } from 'vitest'
import { parseDstv } from '@/lib/parsers/dstv'
import { outlinePoints } from '@/lib/sections/outline'
import { partSectionForCode } from '@/lib/sections/stock'
import { meshStepFile } from '@/lib/step/mesh'
import { setOcWasmUrl } from '@/lib/step/occInit'
import { detectStepSection } from '@/lib/step/readSection'
import { partIrFromNc } from './fromNc'
import { partIrFromStepMesh } from './fromStep'
import type { PartIr } from './ir'

const require = createRequire(import.meta.url)
setOcWasmUrl(require.resolve('replicad-opencascadejs/wasm'))

const ncPath = ubSection('M_12.nc1')
const stpPath = ubSection('M_12.stp')

interface Hole {
  center: [number, number]
  radius: number
}

function holes(ir: PartIr | null): Hole[] {
  return (ir?.features ?? []).flatMap((feature) =>
    feature.kind === 'hole' && feature.shape.form === 'circle'
      ? [{ center: feature.shape.center, radius: feature.shape.radius }]
      : [],
  )
}

describe('M/12 STEP IR holes (UB250*31)', () => {
  it.skipIf(!existsSync(ncPath) || !existsSync(stpPath))(
    'keeps web holes on v and invents no flange holes',
    async () => {
      const ncText = readFileSync(ncPath, 'utf8')
      const header = parseDstv(ncText).header
      const section = partSectionForCode(header.profile, header.dimensions)
      if (!section) throw new Error('no section')
      const ncIr = partIrFromNc(ncText)
      const stepBytes = new Uint8Array(readFileSync(stpPath))
      const guess = await detectStepSection(stepBytes)
      const stepIr = partIrFromStepMesh(await meshStepFile('M_12-ir', stepBytes), {
        mark: 'M/12-step',
        profile: header.profile,
        dimensions: header.dimensions,
        length: header.length,
        section: outlinePoints(section.outline),
        innerSection:
          outlinePoints(section.innerOutline) ?? outlinePoints(section.voidOutlines?.[0]),
        radius: header.dimensions[4] ?? 0,
        seat: guess?.seat,
      })
      if (!stepIr) throw new Error('no STEP IR')

      const ncHoles = holes(ncIr)
      const stepHoles = holes(stepIr)
      // The NC has holes in two columns per flange (±225.1, ±305.1) and two columns in the web
      // (±75). A web hole's cylinder axis is normal to v/h, so it must map to the web — the old
      // centre-direction lookup labelled it as a flange hole and added a phantom column at ±262.1.
      const webHoles = stepHoles.filter((hole) => Math.abs(Math.abs(hole.center[0]) - 75) < 1)
      expect(webHoles).toHaveLength(18)
      expect(stepHoles.some((hole) => Math.abs(Math.abs(hole.center[0]) - 262.1) < 1)).toBe(false)

      // No STEP hole may appear where the NC has none (every hole the STEP adds is a real one).
      const extras = stepHoles.filter(
        (hole) =>
          !ncHoles.some(
            (nc) =>
              Math.abs(nc.radius - hole.radius) < 0.2 &&
              Math.hypot(nc.center[0] - hole.center[0], nc.center[1] - hole.center[1]) < 1,
          ),
      )
      expect(extras).toEqual([])
    },
    300_000,
  )
})
