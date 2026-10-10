import type { StepMeasure } from './measure'
import type { MeshedStep } from './mesh'
import type { SabreResult } from './sabre'

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
  sabre: SabreResult | null
}

/** Rebuild a solid from its DSTV `.nc1`, optionally measuring the result. */
export interface ReconstructResult {
  step: string | null
  measure: StepMeasure | null
}

export type StepRequest =
  | { id: number; kind: 'inspect'; step: Uint8Array; sabreLength?: number }
  | {
      id: number
      kind: 'reconstruct'
      ncText: string
      reference?: Uint8Array
      measure?: boolean
      simplify?: boolean
      /**
       * Measure-only: skip reference orientation and the STEP export (the
       * analysis phase compares measures and discards the text, so both are
       * pure waste there — orientation alone doubles rebuild cost).
       */
      measureOnly?: boolean
    }
  | { id: number; kind: 'mesh'; step: Uint8Array; name: string }
  | { id: number; kind: 'warm' }

export type StepResponse =
  | { id: number; kind: 'inspect'; ok: true; value: InspectResult }
  | { id: number; kind: 'reconstruct'; ok: true; value: ReconstructResult }
  | { id: number; kind: 'mesh'; ok: true; value: MeshedStep }
  | { id: number; kind: 'warm'; ok: true; value: null }
  | { id: number; kind: 'error'; ok: false; error: string }
