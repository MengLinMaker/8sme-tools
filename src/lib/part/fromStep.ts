import { frameForProfile } from '@/lib/parsers/ncFaces'
import type { NcFace } from '@/lib/parsers/ncGeometry'
import type { MeshedStep } from '@/lib/step/mesh'
import { profileTypeFor, type SeatedStepGeometry, seatedStepGeometry } from '@/lib/wisecam/fromStep'
import { unrolledLayout } from '@/lib/wisecam/layout'
import { developStepRimEdges } from '@/lib/wisecam/surface'
import { centredStation, type PartChart, type PartFeature, type PartIr, type UvPoint } from './ir'

/**
 * STEP → PartIR (cut boundaries).
 *
 * The real part's cut edges are projected onto the stock faces and developed by the shared surface
 * core, then converted from WiseCAM's wrapped station to the IR's centred station. This is the STEP
 * half of the canonical model: no holes/marks yet (the cut-edge boundaries already include hole
 * rims as closed loops), but enough to render and compare against NC-derived IR.
 */

export interface FromStepIrOptions {
  mark: string
  /** Catalogue profile code, e.g. `RHS150*100*9.0`. */
  profile: string
  /** DSTV-header dimensions. */
  dimensions: number[]
  length: number
  section: [number, number][]
  innerSection?: [number, number][]
  quantity?: number
  /** Outer corner radius (mm). */
  radius?: number
}

export function partIrFromStepGeometry(
  seated: SeatedStepGeometry,
  options: FromStepIrOptions,
): PartIr | null {
  const profileType = profileTypeFor(options.profile)
  const layout = unrolledLayout(profileType, options.dimensions)
  if (!layout) return null
  const section = options.section
  const frame = frameForProfile(options.profile, section)
  const cuts = developStepRimEdges(
    { ...seated, section, frame, layout },
    { radius: options.radius, alongOffset: seated.alongOffset },
  )
  const features: PartFeature[] = []
  for (const cut of cuts) {
    const points: UvPoint[] = cut.points.map(([station, along]) => [
      centredStation(layout, station),
      along,
    ])
    if (points.length < 2) continue
    features.push({
      kind: 'cut',
      chart: 'front',
      shape: { form: 'polyline', points, closed: false },
    })
  }
  const chart: PartChart = {
    id: 'front',
    role: 'front',
    faces: (['v', 'o', 'u', 'h'] as NcFace[]).filter((face) => layout.faces[face]),
    layout,
  }
  return {
    mark: options.mark,
    profile: options.profile,
    profileType,
    dimensions: options.dimensions,
    section,
    innerSection: options.innerSection,
    length: options.length,
    quantity: options.quantity ?? 1,
    charts: [chart],
    features,
    marks: [],
  }
}

/** Convenience: seat a meshed STEP and convert it to PartIR. */
export function partIrFromStepMesh(meshed: MeshedStep, options: FromStepIrOptions): PartIr | null {
  const seated = seatedStepGeometry(meshed, options.section)
  return partIrFromStepGeometry({ ...seated, length: options.length || seated.length }, options)
}
