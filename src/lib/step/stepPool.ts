import type { Matrix4 } from 'three'
import type { MeshedStep } from './mesh'
import type { DiffPayload } from './occDiff'
import type {
  InspectResult,
  ReconstructResult,
  SeatResult,
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
  /** Higher runs first. Background analysis = 0, viewer (on-demand) = 10, warm = -10. */
  priority: number
}

/** Queued behind everything else (worker boot) — must never delay a viewer mesh. */
const PRIORITY_WARM = -10
/** Bulk background analysis across the whole job. */
const PRIORITY_BACKGROUND = 0
/**
 * The marks either side of the one being viewed — cheap to guess (navigation is ±1) and worth
 * building ahead of background analysis, but never ahead of the part the user is actually on.
 */
export const PRIORITY_NEIGHBOR = 5
/** Something the user is looking at right now — jumps ahead of the background queue. */
export const PRIORITY_FOREGROUND = 10

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
  /** Background tasks set aside by {@link pauseBackground} until {@link resumeBackground}. */
  private readonly held: Task[] = []
  private paused = false
  private nextId = 1

  /** Import a STEP and measure it, importing the model only once. */
  inspect(
    bytes: Uint8Array,
    options: { priority?: number; detectSection?: boolean } = {},
  ): Promise<InspectResult> {
    const copy = new Uint8Array(bytes)
    return this.run<InspectResult>(
      { id: this.nextId++, kind: 'inspect', step: copy, detectSection: options.detectSection },
      [copy.buffer],
      options.priority ?? PRIORITY_BACKGROUND,
    )
  }

  /** Rebuild a solid from its DSTV `.nc1`; optionally measure the result in the same task. */
  reconstruct(
    ncText: string,
    options: {
      measure?: boolean
      simplify?: boolean
      measureOnly?: boolean
      priority?: number
    } = {},
  ): Promise<ReconstructResult> {
    return this.run<ReconstructResult>(
      {
        id: this.nextId++,
        kind: 'reconstruct',
        ncText,
        measure: options.measure,
        simplify: options.simplify,
        measureOnly: options.measureOnly,
      },
      [],
      options.priority ?? PRIORITY_BACKGROUND,
    )
  }

  /**
   * Re-seat a real part STEP into the canonical manufacturing orientation, in the OCC worker so the
   * import/mesh/export never blocks the main thread.
   */
  seat(
    bytes: Uint8Array,
    profile: [number, number][],
    options: { priority?: number } = {},
  ): Promise<SeatResult> {
    const copy = new Uint8Array(bytes)
    return this.run<SeatResult>(
      { id: this.nextId++, kind: 'seat', step: copy, profile },
      [copy.buffer],
      options.priority ?? PRIORITY_BACKGROUND,
    )
  }

  /** Tessellate a STEP into three.js-ready meshes, off the main thread and in the warm OCC worker. */
  mesh(name: string, bytes: Uint8Array, options: { priority?: number } = {}): Promise<MeshedStep> {
    const copy = new Uint8Array(bytes)
    return this.run<MeshedStep>(
      { id: this.nextId++, kind: 'mesh', step: copy, name },
      [copy.buffer],
      options.priority ?? PRIORITY_BACKGROUND,
    )
  }

  /**
   * Overlay diff: the OCC fuzzy boolean between the manufactured (`primary`) and ideal (`compare`)
   * STEPs, run in the worker so it neither blocks the main thread nor re-runs per view change. The
   * caller passes the `compareMatrix` that seats the STEP onto the manufactured model's frame (the
   * same seating the viewer uses), so the worker never reorients. The result is plain typed arrays
   * (see {@link DiffPayload}), null when the boolean fails (the viewer falls back to surface
   * flagging).
   */
  diff(
    primary: Uint8Array,
    compare: Uint8Array,
    options: { compareMatrix?: Matrix4; priority?: number } = {},
  ): Promise<DiffPayload | null> {
    const a = new Uint8Array(primary)
    const b = new Uint8Array(compare)
    const compareMatrix = options.compareMatrix?.toArray()
    return this.run<DiffPayload | null>(
      { id: this.nextId++, kind: 'diff', primary: a, compare: b, compareMatrix },
      [a.buffer, b.buffer],
      options.priority ?? PRIORITY_BACKGROUND,
    )
  }

  /**
   * Boot the ~23 MB OCC kernel in every worker ahead of time, so the first real task (e.g. opening
   * the viewer) does not pay for the WASM fetch/compile. Best-effort: a rejected warm is ignored.
   * Queued at the lowest priority so it never delays on-demand viewer work.
   */
  warm(): void {
    for (let i = 0; i < this.max; i++) {
      void this.run<null>({ id: this.nextId++, kind: 'warm' }, [], PRIORITY_WARM).catch(() => {})
    }
  }

  /**
   * Hold back background analysis: queued background tasks are set aside (kept pending, not failed)
   * and no new background task is dispatched, freeing the workers for viewer meshes/reconstruction
   * and neighbour prefetch while the user is opening a part. In-flight tasks still finish — a worker's
   * task can't be interrupted — so this only clears the *queue*, which is the part that piles up.
   */
  pauseBackground(): void {
    this.paused = true
    const keep: Task[] = []
    for (const task of this.queue) {
      if (task.priority <= PRIORITY_BACKGROUND) this.held.push(task)
      else keep.push(task)
    }
    this.queue.length = 0
    this.queue.push(...keep)
  }

  /** Release the tasks held by {@link pauseBackground}, back into priority order. */
  resumeBackground(): void {
    if (!this.paused && this.held.length === 0) return
    this.paused = false
    const released = this.held.splice(0)
    for (const task of released) this.insert(task)
    this.wake()
  }

  /**
   * Drop everything still queued (e.g. a new job was dropped). In-flight tasks keep running — a
   * worker's task can't be interrupted — but their results are delivered to the now-orphaned
   * promises and ignored by the caller.
   */
  abort(): void {
    this.paused = false
    const pending = [...this.queue.splice(0), ...this.held.splice(0)]
    for (const task of pending) {
      task.reject(new DOMException('step worker pool aborted', 'AbortError'))
    }
  }

  /** Stable priority insert: higher priority first, FIFO within a priority. */
  private insert(task: Task): void {
    const index = this.queue.findIndex((queued) => queued.priority < task.priority)
    if (index < 0) this.queue.push(task)
    else this.queue.splice(index, 0, task)
  }

  private run<T>(request: StepRequest, transfer: Transferable[], priority: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const task: Task = {
        request,
        transfer,
        resolve: resolve as (value: unknown) => void,
        reject,
        priority,
      }
      // Background analysis submitted while paused waits in `held` (still pending) instead of the
      // dispatch queue, so it cannot occupy a worker the viewer needs.
      if (this.paused && priority <= PRIORITY_BACKGROUND) {
        this.held.push(task)
        return
      }
      this.insert(task)
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
