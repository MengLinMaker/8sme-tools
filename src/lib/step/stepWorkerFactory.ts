import type { StepWorkerInit } from './stepWorkerProtocol'

export interface StepWorkerHandle {
  worker: Worker
  init: StepWorkerInit
}

/** Normal web build: the worker is a separate bundled module. */
export function createStepWorker(): StepWorkerHandle {
  return {
    worker: new Worker(new URL('./stepWorker.ts', import.meta.url), { type: 'module' }),
    init: { kind: 'init' },
  }
}
