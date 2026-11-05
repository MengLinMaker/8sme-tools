/**
 * Single-file pdf.js setup.
 *
 * A `file://` page cannot create a module worker from a blob URL, and pdf.js wraps an
 * off-origin `workerSrc` in exactly such a blob. Importing the worker module here installs
 * `globalThis.pdfjsWorker`, which makes pdf.js fall back to its in-thread worker instead.
 */

type PdfjsModule = typeof import('pdfjs-dist')

let workerLoaded: Promise<void> | null = null

export async function configurePdfWorker(_pdfjs: PdfjsModule): Promise<void> {
  workerLoaded ??= import('pdfjs-dist/build/pdf.worker.min.mjs').then(() => {})
  await workerLoaded
}
