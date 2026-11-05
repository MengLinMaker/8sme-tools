import * as assets from 'virtual:8sme-assets'
import { workerDataUrl } from 'virtual:8sme-worker'
import type { StepWorkerInit } from './stepWorkerProtocol'

export interface StepWorkerHandle {
  worker: Worker
  init: StepWorkerInit
}

/**
 * Single-file build: the whole worker bundle is embedded as a data URL (blob module workers are
 * blocked on `file://`), and the compressed kernel assets travel in the init message.
 */
export function createStepWorker(): StepWorkerHandle {
  return {
    worker: new Worker(workerDataUrl, { type: 'module' }),
    init: {
      kind: 'init',
      ocWasmGzip: assets.ocWasmGzip,
      fontGzip: assets.etchFontGzip,
    },
  }
}
