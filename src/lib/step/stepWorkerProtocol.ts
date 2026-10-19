import type { SectionGuess } from '@/lib/sections/detect'
import type { StepMeasure } from './measure'
import type { MeshedStep } from './mesh'
import type { DiffPayload } from './occDiff'

/**
 * Message protocol between the preflight UI and the STEP worker pool.
 *
 * The OCC kernel is instantiated once per worker (~23 MB WASM), so all CPU-bound geometry work —
 * importing, measuring, meshing and NC reconstruction — is funnelled through a few long-lived
 * workers instead of blocking the main thread.
 */

/** Import a STEP once and run every geometry check that needs it. */
export interface InspectResult {
  measure: StepMeasure | null
  /** Section inferred from the cross-section geometry — only when the job carries no NC / drawing. */
  section: SectionGuess | null
}

/** Rebuild a solid from its DSTV `.nc1`, optionally measuring the result. */
export interface ReconstructResult {
  step: string | null
  measure: StepMeasure | null
}

/** A real part STEP re-seated into the canonical manufacturing orientation. */
export interface SeatResult {
  step: string
}

export type StepRequest =
  | {
      id: number
      kind: 'inspect'
      step: Uint8Array
      /**
       * Also read the cross-section and infer the section — the STEP-only fallback when no NC /
       * drawing carries a profile code. Slower (a slab boolean), so off unless asked.
       */
      detectSection?: boolean
    }
  | {
      id: number
      kind: 'reconstruct'
      ncText: string
      measure?: boolean
      simplify?: boolean
      /**
       * Measure-only: skip the STEP export (the analysis phase compares measures and discards the
       * text, so the export is pure waste there).
       */
      measureOnly?: boolean
    }
  | {
      id: number
      kind: 'seat'
      step: Uint8Array
      /** Canonical cross-section points to seat the real part against. */
      profile: [number, number][]
    }
  | { id: number; kind: 'mesh'; step: Uint8Array; name: string }
  | {
      id: number
      kind: 'diff'
      primary: Uint8Array
      compare: Uint8Array
      /**
       * Column-major 4×4 seating matrix (as `Matrix4.toArray`) mapping the STEP's raw frame onto the
       * manufactured model's raw frame — the viewer's canonical seating. Absent = identity.
       */
      compareMatrix?: number[]
    }
  | { id: number; kind: 'warm' }

export type StepResponse =
  | { id: number; kind: 'inspect'; ok: true; value: InspectResult }
  | { id: number; kind: 'reconstruct'; ok: true; value: ReconstructResult }
  | { id: number; kind: 'seat'; ok: true; value: SeatResult }
  | { id: number; kind: 'mesh'; ok: true; value: MeshedStep }
  | { id: number; kind: 'diff'; ok: true; value: DiffPayload | null }
  | { id: number; kind: 'warm'; ok: true; value: null }
  | { id: number; kind: 'error'; ok: false; error: string }
