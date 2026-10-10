import { type MeasurableShape, measureShape, measureStep, type StepMeasure } from './measure'
import { ensureOc } from './occInit'
import { reconstructStepFromNc } from './reconstructFromNc'
import { type MeshableShape, type SabreResult, sabreShape } from './sabre'
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
      const value = await inspect(request.step, request.sabreLength)
      scope.postMessage({ id: request.id, kind: 'inspect', ok: true, value })
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

/** Import the STEP once, then measure and light-sabre test the same shape. */
async function inspect(bytes: Uint8Array, sabreLength?: number): Promise<InspectResult> {
  await ensureOc()
  const { importSTEP } = await import('replicad')
  const shape = (await importSTEP(
    new Blob([new Uint8Array(bytes)], { type: 'model/step' }),
  )) as unknown as MeasurableShape & MeshableShape & { delete: () => void }
  try {
    let measure: StepMeasure | null = null
    let sabre: SabreResult | null = null
    try {
      measure = await measureShape(shape)
    } catch {
      measure = null
    }
    try {
      sabre = sabreShape(shape, sabreLength)
    } catch {
      sabre = null
    }
    return { measure, sabre }
  } finally {
    shape.delete()
  }
}

async function reconstruct(request: {
  ncText: string
  reference?: Uint8Array
  measure?: boolean
  simplify?: boolean
}): Promise<ReconstructResult> {
  const step = await reconstructStepFromNc(request.ncText, {
    reference: request.reference,
    simplify: request.simplify,
  })
  let measure: StepMeasure | null = null
  if (step && request.measure) {
    try {
      measure = await measureStep(new TextEncoder().encode(step))
    } catch {
      measure = null
    }
  }
  return { step, measure }
}
