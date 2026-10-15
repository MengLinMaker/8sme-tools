import { Matrix4 } from 'three'
import { type MeasurableShape, measureShape, type StepMeasure } from './measure'
import { meshStepFile } from './mesh'
import { occFuzzyDiff, serializeDiff } from './occDiff'
import { ensureOc } from './occInit'
import { reconstructSolidFromNc } from './reconstructFromNc'
import type {
  InspectResult,
  ReconstructResult,
  StepRequest,
  StepResponse,
} from './stepWorkerProtocol'

/**
 * OpenCASCADE worker. Owns its own instance of the ~23 MB WASM kernel (initialised lazily on the
 * first request) and runs all CPU-bound STEP work off the main thread so the preflight UI stays
 * responsive and parts can be processed in parallel across the pool.
 */

interface WorkerScope {
  onmessage: ((event: MessageEvent<StepRequest>) => void) | null
  postMessage: (message: StepResponse) => void
}

const scope = self as unknown as WorkerScope

scope.onmessage = (event) => {
  void handle(event.data)
}

async function handle(request: StepRequest): Promise<void> {
  try {
    if (request.kind === 'inspect') {
      const value = await inspect(request.step)
      scope.postMessage({ id: request.id, kind: 'inspect', ok: true, value })
    } else if (request.kind === 'mesh') {
      const value = await meshStepFile(request.name, request.step)
      scope.postMessage({ id: request.id, kind: 'mesh', ok: true, value })
    } else if (request.kind === 'warm') {
      await ensureOc()
      scope.postMessage({ id: request.id, kind: 'warm', ok: true, value: null })
    } else if (request.kind === 'diff') {
      // Overlay diff: the OCC fuzzy boolean, run here so it never blocks the main thread and can be
      // prewarmed alongside the manufactured rebuild. The viewer supplies the seating that maps the
      // STEP (`compare`, its own frame) onto the manufactured model (`primary`, canonical) — the two
      // are drawn in that same orientation, so the diff never reorients on its own.
      const compareMatrix = request.compareMatrix
        ? new Matrix4().fromArray(request.compareMatrix)
        : undefined
      const diff = await occFuzzyDiff(request.primary, request.compare, undefined, compareMatrix)
      scope.postMessage({ id: request.id, kind: 'diff', ok: true, value: serializeDiff(diff) })
    } else {
      const value = await reconstruct(request)
      scope.postMessage({ id: request.id, kind: 'reconstruct', ok: true, value })
    }
  } catch (error) {
    scope.postMessage({
      id: request.id,
      kind: 'error',
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/** Import the STEP once, then measure it. Cut-reach is a pure profile check, not OCC. */
async function inspect(bytes: Uint8Array): Promise<InspectResult> {
  await ensureOc()
  const { importSTEP } = await import('replicad')
  const shape = (await importSTEP(
    new Blob([new Uint8Array(bytes)], { type: 'model/step' }),
  )) as unknown as MeasurableShape & { delete: () => void }
  try {
    let measure: StepMeasure | null = null
    try {
      measure = await measureShape(shape)
    } catch {
      measure = null
    }
    return { measure }
  } finally {
    shape.delete()
  }
}

async function reconstruct(request: {
  ncText: string
  measure?: boolean
  simplify?: boolean
  measureOnly?: boolean
}): Promise<ReconstructResult> {
  const built = await reconstructSolidFromNc(request.ncText, {
    simplify: request.simplify,
    measureOnly: request.measureOnly,
  })
  let measure: StepMeasure | null = null
  if (built && request.measure) {
    try {
      // Measure the live solid — it is what `step` was exported from, so re-importing the STEP
      // text here would just redo the export + parse for identical geometry.
      measure = await measureShape(built.solid)
    } catch {
      measure = null
    }
  }
  return { step: request.measureOnly ? null : (built?.step ?? null), measure }
}
