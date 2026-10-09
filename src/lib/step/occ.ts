import type { AnyShape } from 'replicad'
import type { UbSection } from '@/lib/sections/types'
import { ensureOc } from './occInit'

/**
 * Nested-UB STEP generation using the real OpenCASCADE kernel (via `replicad`).
 *
 * The stock UB is split lengthwise into two T bars, nested independently. Each T part is
 * emitted as a T solid (the upper half for the left bar, the lower half for the right),
 * placed at its own position along the bar — so every T is visible in its cut-out area,
 * with kerf gaps between adjacent cuts. Output is AP214.
 *
 * The ~23 MB OpenCASCADE WASM is lazy-loaded only when this runs.
 */

/** Full UB I-section outline (x = width, y = depth), root radii omitted. */
export function ubOutline(section: UbSection): [number, number][] {
  const hb = section.b / 2
  const hd = section.d / 2
  const hw = section.tw / 2
  const tf = section.tf
  return [
    [-hb, -hd],
    [hb, -hd],
    [hb, -hd + tf],
    [hw, -hd + tf],
    [hw, hd - tf],
    [hb, hd - tf],
    [hb, hd],
    [-hb, hd],
    [-hb, hd - tf],
    [-hw, hd - tf],
    [-hw, -hd + tf],
    [-hb, -hd + tf],
  ]
}

/** The upper and lower T of a UB, each a full-width flange + half-depth web. */
function teeProfiles(
  section: UbSection,
  gap: number,
): { top: [number, number][]; bottom: [number, number][] } {
  const hb = section.b / 2
  const hd = section.d / 2
  const hw = section.tw / 2
  const tf = section.tf
  const hk = gap / 2
  const top: [number, number][] = [
    [-hw, hk],
    [hw, hk],
    [hw, hd - tf],
    [hb, hd - tf],
    [hb, hd],
    [-hb, hd],
    [-hb, hd - tf],
    [-hw, hd - tf],
  ]
  const bottom = top.map(([x, y]) => [x, -y] as [number, number])
  return { top, bottom }
}

export interface UbBarStepInput {
  section: UbSection
  name: string
  /** T part lengths on the left bar */
  left: number[]
  /** T part lengths on the right bar */
  right: number[]
  kerf: number
}

/** Minimal surface of the OCC instance we use (the WASM type defs are incomplete). */
interface OccStep {
  Interface_Static: { SetCVal: (key: string, value: string) => void }
  STEPControl_Writer: new () => {
    Transfer: (shape: unknown, mode: unknown) => void
    Write: (path: string) => void
  }
  STEPControl_AsIs: unknown
  FS: { readFile: (path: string, opts?: unknown) => string | Uint8Array }
}

export async function buildUbBarStep(input: UbBarStepInput): Promise<string> {
  const { section, kerf } = input
  await ensureOc()
  const { draw, getOC } = await import('replicad')

  // Show a visible cut line even when kerf is 0.
  const gap = kerf > 0 ? kerf : 1
  const { top, bottom } = teeProfiles(section, gap)

  const solidAt = (profile: [number, number][], cursor: number, length: number): AnyShape => {
    let pen = draw(profile[0])
    for (let i = 1; i < profile.length; i++) pen = pen.lineTo(profile[i])
    return pen.close().sketchOnPlane('XY').extrude(length).translate(0, 0, cursor)
  }

  const solids: AnyShape[] = []
  const buildSide = (profile: [number, number][], lengths: number[]): void => {
    let cursor = 0
    for (const length of lengths) {
      solids.push(solidAt(profile, cursor, length))
      cursor += length + gap
    }
  }
  buildSide(top, input.left)
  buildSide(bottom, input.right)

  const occ = getOC() as unknown as OccStep
  occ.Interface_Static.SetCVal('write.step.schema', 'AP214IS')

  // Multiple Transfer calls accumulate roots into one file (no BRep_Builder needed).
  const writer = new occ.STEPControl_Writer()
  for (const solid of solids) writer.Transfer(solid.wrapped, occ.STEPControl_AsIs)

  const path = `nested-${input.name}.stp`
  writer.Write(path)
  const content = occ.FS.readFile(path, { encoding: 'utf8' })
  return typeof content === 'string' ? content : new TextDecoder().decode(content)
}
