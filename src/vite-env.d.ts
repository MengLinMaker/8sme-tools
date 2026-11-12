/// <reference types="vite/client" />

declare const __COMMIT_ID__: string

declare module 'virtual:8sme-assets' {
  export const ocWasmGzip: string
  export const unrarWasmGzip: string
  export const etchFontGzip: string
}

declare module 'virtual:8sme-worker' {
  export const workerDataUrl: string
}

declare module 'pdfjs-dist/build/pdf.worker.min.mjs' {
  export const WorkerMessageHandler: unknown
}

interface Window {
  showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle>
  /** Dismisses the index.html boot splash once React has mounted (see `index.html`). */
  __8smeAppReady?: () => void
}
