import type { AnyShape } from 'replicad'
import { outline, outlinePoints } from '@/lib/sections/outline'
import type { StepMeasure } from '@/lib/step/measure'
import { measureStep } from '@/lib/step/measure'
import { writeStep } from '@/lib/step/occ'
import { ensureOc } from '@/lib/step/occInit'
import { detectStepSection } from '@/lib/step/readSection'
import { sectionSketch } from '@/lib/step/sectionBrep'
import { polygonArea, type SatPlan } from './sat'

/**
 * Rebuild a straight section prism from a SAT plan, using the catalogue primitives so every corner
 * is one true arc (one cylindrical brep face), then verify the result the same way the app reads a
 * real part.
 *
 * The cutter construction is deliberately world-frame: the end cuts came from the SAT in world
 * coordinates, and the contour is already seated in the SAT's own XY frame, so the planes land
 * where they were.
 */

export interface PrismFace {
  geomType: string
}

export interface PrismSolid {
  translate: (x: number, y: number, z: number) => PrismSolid
  cut: (tool: PrismSolid) => PrismSolid
  faces?: PrismFace[]
  delete?: () => void
}

export interface SatBuildFindings {
  schema: string
  size: [number, number, number]
  volume: number
  expectedVolume: number
  /** Count of cylindrical faces in the rebuilt solid (one per corner for a good section). */
  arcFaces: number
  /** The section detector's read-back of the exported STEP. */
  detected: string | null
  score: number | null
}

export interface SatBuildResult {
  step: string
  findings: SatBuildFindings
}

const BOUND_PAD = 50

/** Extrude the plan and cut each slanted end plane off as a half-space. */
export async function rebuildSatPrism(
  plan: SatPlan,
  options: { schema?: 'AP203' | 'AP214IS' | 'AP242DIS' } = {},
): Promise<SatBuildResult> {
  await ensureOc()
  const sketch = await sectionSketch(plan.contour)
  if (!sketch) throw new Error('could not sketch the section')

  let solid = sketch.sketchOnPlane('XY').extrude(plan.length) as unknown as PrismSolid
  // The sketch is only needed for the extrusion; releasing it keeps a long-lived worker from
  // accumulating OCCT handles across conversions.
  ;(sketch as unknown as { delete?: () => void }).delete?.()
  if (plan.zMin !== 0) {
    const placed = solid.translate(0, 0, plan.zMin)
    solid.delete?.()
    solid = placed
  }

  const measured = plan.measured
  const centre = [
    (measured.minX + measured.maxX) / 2,
    (measured.minY + measured.maxY) / 2,
    plan.zMin + plan.length / 2,
  ] as const
  const bound = Math.max(plan.length, measured.width, measured.depth, 100) * 2 + 100

  for (const cut of plan.endCuts) {
    const [nx, ny, nz] = cut.normal
    if (Math.abs(nx) > 1e-6 && Math.abs(ny) > 1e-6) {
      throw new Error('compound-mitre end cuts are not supported (the rake must be about X or Y)')
    }
    // Which side is the removed (air) side? The solid's own centre is on the kept side.
    const side =
      nx * (centre[0] - cut.origin[0]) +
      ny * (centre[1] - cut.origin[1]) +
      nz * (centre[2] - cut.origin[2])
    const dirZ = Math.sign(-side * nz) || 1

    // The cut plane's trace, blown out well past the section, as a 2D polygon in the plane the
    // cutter is extruded along: (u, v) = (y, z) for a rake about X, (x, z) for a rake about Y.
    const rakeAboutX = Math.abs(nx) <= 1e-6
    const w0 = rakeAboutX ? measured.minY - BOUND_PAD : measured.minX - BOUND_PAD
    const w1 = rakeAboutX ? measured.maxY + BOUND_PAD : measured.maxX + BOUND_PAD
    const along = rakeAboutX ? ny : nx // ∂z/∂w of the plane
    const originW = rakeAboutX ? cut.origin[1] : cut.origin[0]
    const zAt = (w: number) => cut.origin[2] - (along * (w - originW)) / nz
    const far = dirZ > 0 ? plan.zMin + plan.length + bound : plan.zMin - bound
    const polygon = [
      [w0, zAt(w0)],
      [w1, zAt(w1)],
      [w1, far],
      [w0, far],
    ] as [number, number][]
    const cutterSketch = await sectionSketch(
      outline(polygon[0]!).lineTo(polygon[1]!).lineTo(polygon[2]!).lineTo(polygon[3]!).done(),
    )
    if (!cutterSketch) throw new Error('could not sketch an end-cut cutter')
    const extrudePlane = rakeAboutX ? 'YZ' : 'XZ'
    const cutter = cutterSketch.sketchOnPlane(extrudePlane).extrude(bound) as unknown as PrismSolid
    const placed = rakeAboutX
      ? cutter.translate(-bound / 2, 0, 0)
      : cutter.translate(0, bound / 2, 0)
    const next = solid.cut(placed)
    placed.delete?.()
    cutter.delete?.()
    solid.delete?.()
    solid = next
    ;(cutterSketch as unknown as { delete?: () => void }).delete?.()
  }

  const arcFaces = (solid.faces ?? []).filter((face) => face.geomType === 'CYLINDRE').length
  const schema = options.schema ?? 'AP203'
  let step = await writeStep(solid as unknown as AnyShape, '/sat-section.step', {
    schema,
    name: plan.code,
  })
  solid.delete?.()
  // WiseCAM's known-good Tekla STEPs carry the section designation in FILE_NAME as well as
  // PRODUCT (`docs/nc-to-step.md`); the OCC header default is a generic string.
  step = step
    .replace("FILE_NAME('Open CASCADE Shape Model'", `FILE_NAME('${plan.code}'`)
    .replace(
      /(PRODUCT\()'[^']*'(\s*,\s*)'[^']*'/,
      (_match, head: string, separator: string) =>
        `${head}'${plan.code}'${separator}'${plan.code}'`,
    )

  const bytes = new TextEncoder().encode(step)
  const size: StepMeasure = await measureStep(bytes)
  const detected = await detectStepSection(bytes)

  const area = Math.abs(polygonArea(outlinePoints(plan.contour, 256)))
  let expectedVolume = area * plan.length
  if (plan.endCuts.length === 1) {
    const cut = plan.endCuts[0]!
    const rakeAboutX = Math.abs(cut.normal[0]) <= 1e-6
    const w = rakeAboutX ? centre[1] : centre[0]
    const originW = rakeAboutX ? cut.origin[1] : cut.origin[0]
    const along = rakeAboutX ? cut.normal[1] : cut.normal[0]
    const zEnd = cut.origin[2] - (along * (w - originW)) / cut.normal[2]
    expectedVolume = area * (zEnd - plan.zMin)
  }

  const volumeError = Math.abs(size.volume - expectedVolume) / Math.max(expectedVolume, 1)
  if (plan.endCuts.length === 1 && volumeError > 0.005) {
    throw new Error(
      `rebuilt volume ${Math.round(size.volume)} mm³ is off the expected ${Math.round(
        expectedVolume,
      )} mm³ (end cut misplaced)`,
    )
  }

  return {
    step,
    findings: {
      schema,
      size: size.size,
      volume: size.volume,
      expectedVolume,
      arcFaces,
      detected: detected?.code ?? null,
      score: detected?.score ?? null,
    },
  }
}
