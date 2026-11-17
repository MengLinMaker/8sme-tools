/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/react" />

declare const __BUILD_VERSION__: string

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
