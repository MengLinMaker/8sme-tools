/// <reference types="vite/client" />

declare const __COMMIT_ID__: string

interface Window {
  showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle>
}
