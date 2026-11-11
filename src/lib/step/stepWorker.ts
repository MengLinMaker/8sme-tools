import type { AnyShape } from 'replicad'
import { Matrix4 } from 'three'
import { gunzipBase64 } from '@/lib/gzip'
import { cleanStep } from './clean'
import { type MeasurableShape, measureShape, type StepMeasure } from './measure'
import { meshStepFile } from './mesh'
import { applyRigid, setEtchFontBinary, writeStep } from './occ'
import { occFuzzyDiff, serializeDiff } from './occDiff'
import { ensureOc, setOcWasmBinary } from './occInit'
import { inferStepSection, type SectionShape } from './readSection'
import { reconstructSolidFromNc } from './reconstructFromNc'
import { baseMatchesFeatures, buildFaceFilledBase, repairStep } from './repair'
import { rigidFromMatrix, seatedStepProfile } from './seat'
import type {
  InspectResult,
  ReconstructResult,
  SeatResult,
  StepRequest,
  StepResponse,
  StepWorkerInit,
} from './stepWorkerProtocol'
import { tabStep } from './tabs'

/**
 * OpenCASCADE worker. Owns its own instance of the ~23 MB WASM kernel (initialised lazily on the
 * first request) and runs all CPU-bound STEP work off the main thread so the preflight UI stays
 * responsive and parts can be processed in parallel across the pool.
 */

interface WorkerScope {
  onmessage: ((event: MessageEvent<StepRequest | StepWorkerInit>) => void) | null
  postMessage: (message: StepResponse) => void
}

const scope = self as unknown as WorkerScope

let resolveInit: () => void = () => {}
const initReady = new Promise<void>((resolve) => {
  resolveInit = resolve
})
let initError: string | null = null

scope.onmessage = (event) => {
  const message = event.data
  if (message.kind === 'init') {
    void applyInit(message).then(
      () => resolveInit(),
      (error) => {
        initError = error instanceof Error ? error.message : String(error)
        resolveInit()
      },
    )
    return
  }
  void initReady.then(() => {
    if (initError) {
      scope.postMessage({ id: message.id, kind: 'error', ok: false, error: initError })
      return
    }
    return handle(message)
  })
}

/** Apply the embedded assets (single-file build) before the first real request. */
async function applyInit(init: StepWorkerInit): Promise<void> {
  const jobs: Promise<void>[] = []
  if (init.ocWasmGzip) jobs.push(gunzipBase64(init.ocWasmGzip).then(setOcWasmBinary))
  if (init.fontGzip) jobs.push(gunzipBase64(init.fontGzip).then(setEtchFontBinary))
  await Promise.all(jobs)
}

async function handle(request: StepRequest): Promise<void> {
  try {
    if (request.kind === 'inspect') {
      const value = await inspect(request.step, request.detectSection === true)
      scope.postMessage({ id: request.id, kind: 'inspect', ok: true, value })
    } else if (request.kind === 'mesh') {
      const value = await meshStepFile(request.name, request.step)
      scope.postMessage({ id: request.id, kind: 'mesh', ok: true, value })
    } else if (request.kind === 'seat') {
      const value = await seat(request.step, request.profile)
      scope.postMessage({ id: request.id, kind: 'seat', ok: true, value })
    } else if (request.kind === 'repair') {
      let value: import('./stepWorkerProtocol').RepairResult | null = null
      let base = request.base
      if (base) {
        // A corrected base can have moved end/step geometry (a dimensionally wrong Tekla edit).
        // Reject it rather than re-drilling into a part of the wrong size.
        try {
          if (!(await baseMatchesFeatures(base, request.features))) base = null
        } catch {
          base = null
        }
      }
      if (!base) {
        // No usable base: rebuild the stock base from the part's own faces (keeps its dimensions).
        try {
          base = await buildFaceFilledBase(request.features)
        } catch {
          base = null
        }
      }
      if (base) {
        try {
          const repaired = await repairStep(base, request.features, {
            overrun: request.overrun,
          })
          if (repaired.valid) {
            value = {
              bytes: repaired.bytes,
              valid: true,
              redrilled: repaired.redrilled,
              cleaned: false,
            }
          }
        } catch {
          // fall through to the clean fallback
        }
      }
      if (!value) {
        const cleaned = await cleanStep(request.features)
        value = cleaned
          ? { bytes: cleaned.bytes, valid: true, redrilled: 0, cleaned: true }
          : { bytes: request.features, valid: false, redrilled: 0, cleaned: false }
      }
      scope.postMessage({ id: request.id, kind: 'repair', ok: true, value })
    } else if (request.kind === 'tab') {
      const value = await tabStep(request.step, { density: request.density })
      scope.postMessage({ id: request.id, kind: 'tab', ok: true, value })
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

/**
 * Import the STEP once, then measure it — and, when asked, read its cross-section and infer the
 * section (the STEP-only fallback). Cut-reach is a pure profile check, not OCC.
 */
async function inspect(bytes: Uint8Array, detectSection: boolean): Promise<InspectResult> {
  await ensureOc()
  const { importSTEP, makeBox } = await import('replicad')
  const shape = (await importSTEP(
    new Blob([new Uint8Array(bytes)], { type: 'model/step' }),
  )) as unknown as MeasurableShape & SectionShape & { delete: () => void }
  try {
    let measure: StepMeasure | null = null
    try {
      measure = await measureShape(shape)
    } catch {
      measure = null
    }
    let section: InspectResult['section'] = null
    if (detectSection) {
      try {
        section = inferStepSection(
          shape,
          makeBox as unknown as (a: number[], b: number[]) => SectionShape,
        )
      } catch {
        section = null
      }
    }
    return { measure, section }
  } finally {
    shape.delete()
  }
}

async function reconstruct(request: {
  ncText: string
  measure?: boolean
  simplify?: boolean
  measureOnly?: boolean
  sabre?: boolean
}): Promise<ReconstructResult> {
  const built = await reconstructSolidFromNc(request.ncText, {
    simplify: request.simplify,
    measureOnly: request.measureOnly,
    sabre: request.sabre,
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
  return {
    step: request.measureOnly ? null : (built?.step ?? null),
    measure,
    sabre: built?.sabre ?? [],
  }
}

/** The subset of an imported OCC shape the canonical seat needs. */
interface TransformOps {
  rotate: (angle: number, position?: number[], direction?: number[]) => TransformOps
  translate: (x: number, y: number, z: number) => TransformOps
  mesh: () => { vertices: number[] }
  delete: () => void
}

/**
 * Re-seats a real part STEP into the canonical manufacturing orientation: import it, mesh it for
 * the same canonical seat the viewer applies (`seatedStepProfile`), then rotate+translate the real
 * B-rep (holes/curves preserved) and write it back out.
 */
async function seat(bytes: Uint8Array, profile: [number, number][]): Promise<SeatResult> {
  await ensureOc()
  const { importSTEP } = await import('replicad')
  const shape = (await importSTEP(
    new Blob([new Uint8Array(bytes)], { type: 'model/step' }),
  )) as unknown as TransformOps
  try {
    const { vertices } = shape.mesh()
    const rigid = rigidFromMatrix(seatedStepProfile(vertices, profile).primary)
    const placed = applyRigid(shape as unknown as AnyShape, rigid)
    return { step: await writeStep(placed, 'seated.stp') }
  } finally {
    shape.delete()
  }
}
