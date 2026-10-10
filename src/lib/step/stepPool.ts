import type { MeshedStep } from './mesh'
import type {
  InspectResult,
  ReconstructResult,
  StepRequest,
  StepResponse,
} from './stepWorkerProtocol'

/**
 * A small pool of {@link ./stepWorker} OpenCASCADE workers.
 *
 * Each worker holds its own ~23 MB WASM kernel, so the pool is deliberately tiny (memory, not CPU,
 * is the constraint). The OCC work in preflight — measuring, meshing/light-sabre testing and NC
 * reconstruction — is per-part and independent, so it fans out across the pool: the main thread
 * stays free (the UI keeps animating) and wall-time drops roughly by the pool size.
 */

interface Task {
  request: StepRequest
  transfer: Transferable[]
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
}

interface WorkerHandle {
  worker: Worker
  task: Task | null
}

// Cap well below hardwareConcurrency: each worker is a full OCC kernel, so 2–3 is the sweet spot
// before memory (WASM + per-part B-reps) starts to bite. Leave a core for the UI.
const MAX_WORKERS = Math.max(1, Math.min(3, (globalThis.navigator?.hardwareConcurrency ?? 4) - 1))

class StepWorkerPool {
  private readonly max = MAX_WORKERS
  private readonly workers: WorkerHandle[] = []
  private readonly idle: WorkerHandle[] = []
  private readonly queue: Task[] = []
  private nextId = 1

  /** Measure a STEP and run the light-sabre test on it, importing the model only once. */
  inspect(bytes: Uint8Array, sabreLength?: number): Promise<InspectResult> {
    const copy = new Uint8Array(bytes)
    return this.run<InspectResult>(
      { id: this.nextId++, kind: 'inspect', step: copy, sabreLength },
      [copy.buffer],
    )
  }

  /** Rebuild a solid from its DSTV `.nc1`; optionally measure the result in the same task. */
  reconstruct(
    ncText: string,
    options: { reference?: Uint8Array; measure?: boolean; simplify?: boolean } = {},
  ): Promise<ReconstructResult> {
    const reference = options.reference ? new Uint8Array(options.reference) : undefined
    return this.run<ReconstructResult>(
      {
        id: this.nextId++,
        kind: 'reconstruct',
        ncText,
        reference,
        measure: options.measure,
        simplify: options.simplify,
      },
      reference ? [reference.buffer] : [],
    )
  }

  /** Tessellate a STEP into three.js-ready meshes, off the main thread and in the warm OCC worker. */
  mesh(name: string, bytes: Uint8Array): Promise<MeshedStep> {
    const copy = new Uint8Array(bytes)
    return this.run<MeshedStep>({ id: this.nextId++, kind: 'mesh', step: copy, name }, [
      copy.buffer,
    ])
  }

  /**
   * Boot the ~23 MB OCC kernel in every worker ahead of time, so the first real task (e.g. opening
   * the viewer) does not pay for the WASM fetch/compile. Best-effort: a rejected warm is ignored.
   */
  warm(): void {
    for (let i = 0; i < this.max; i++) {
      void this.run<null>({ id: this.nextId++, kind: 'warm' }, []).catch(() => {})
    }
  }

  /**
   * Drop everything still queued (e.g. a new job was dropped). In-flight tasks keep running — a
   * worker's task can't be interrupted — but their results are delivered to the now-orphaned
   * promises and ignored by the caller.
   */
  abort(): void {
    const pending = this.queue.splice(0)
    for (const task of pending) {
      task.reject(new DOMException('step worker pool aborted', 'AbortError'))
    }
  }

  private run<T>(request: StepRequest, transfer: Transferable[]): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ request, transfer, resolve: resolve as (value: unknown) => void, reject })
      this.wake()
    })
  }

  private wake(): void {
    while (this.queue.length > 0) {
      let worker = this.idle.pop()
      if (!worker) worker = this.spawn() ?? undefined
      if (!worker) return
      const task = this.queue.shift()
      if (!task) return
      worker.task = task
      worker.worker.postMessage(task.request, task.transfer)
    }
  }

  private spawn(): WorkerHandle | null {
    if (this.workers.length >= this.max) return null
    const worker = new Worker(new URL('./stepWorker.ts', import.meta.url), { type: 'module' })
    const handle: WorkerHandle = { worker, task: null }
    worker.onmessage = (event: MessageEvent<StepResponse>) => this.onMessage(handle, event.data)
    worker.onerror = (event) => this.onError(handle, event)
    this.workers.push(handle)
    return handle
  }

  private onMessage(handle: WorkerHandle, response: StepResponse): void {
    const task = handle.task
    handle.task = null
    if (this.workers.includes(handle)) this.idle.push(handle)
    if (task) {
      if (response.ok) task.resolve(response.value)
      else task.reject(new Error(response.error))
    }
    this.wake()
  }

  private onError(handle: WorkerHandle, event: ErrorEvent): void {
    const task = handle.task
    handle.task = null
    this.dispose(handle)
    if (task) {
      task.reject(
        event.error instanceof Error
          ? event.error
          : new Error(event.message || 'step worker failed'),
      )
    }
    this.wake()
  }

  private dispose(handle: WorkerHandle): void {
    handle.worker.terminate()
    const inWorkers = this.workers.indexOf(handle)
    if (inWorkers >= 0) this.workers.splice(inWorkers, 1)
    const inIdle = this.idle.indexOf(handle)
    if (inIdle >= 0) this.idle.splice(inIdle, 1)
  }
}

let pool: StepWorkerPool | null = null

/** The shared STEP worker pool, created lazily on first use. */
export function getStepWorkerPool(): StepWorkerPool {
  if (!pool) pool = new StepWorkerPool()
  return pool
}

let prebooted = false

/** Boot the shared worker pool's OCC kernels once, early, in the background. */
export function prebootStepWorkers(): void {
  if (prebooted) return
  prebooted = true
  getStepWorkerPool().warm()
}
