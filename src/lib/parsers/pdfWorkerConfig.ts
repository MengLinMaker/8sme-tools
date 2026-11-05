/**
 * pdf.js worker setup.
 *
 * In the normal web build the worker is a separate bundled asset. The single-file build replaces
 * this module with `pdfWorkerConfig.single.ts`, which runs pdf.js on the main thread because
 * module workers cannot be created from a blob on `file://` pages.
 */

type PdfjsModule = typeof import('pdfjs-dist')

export async function configurePdfWorker(pdfjs: PdfjsModule): Promise<void> {
  if (!pdfjs.GlobalWorkerOptions.workerSrc) {
    const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default
  }
}
