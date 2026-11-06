import { type DroppedInput, snapshotDataTransfer } from './readInput'

const DROP_EVENT = '8sme:drop-input'

let installed = false

function isFileDrop(dataTransfer: DataTransfer | null): boolean {
  return !!dataTransfer && Array.from(dataTransfer.types).includes('Files')
}

/**
 * Stops a file/folder drop anywhere on the page from navigating the browser to the dropped
 * `file://` path (Windows reports that as "the link no longer exists"). Drops inside a DropZone are
 * left to its own handler; drops elsewhere are forwarded as `8sme:drop-input` so the active zone can
 * accept them.
 */
export function installGlobalDropGuard(): void {
  if (installed || typeof window === 'undefined') return
  installed = true
  window.addEventListener('dragover', (event) => {
    if (!isFileDrop(event.dataTransfer)) return
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
  })
  window.addEventListener('drop', (event) => {
    if (!isFileDrop(event.dataTransfer)) return
    event.preventDefault()
    const target = event.target
    if (target instanceof Element && target.closest('[data-dropzone]')) return
    const input = snapshotDataTransfer(event.dataTransfer as DataTransfer)
    window.dispatchEvent(new CustomEvent<DroppedInput>(DROP_EVENT, { detail: input }))
  })
}

/** Subscribe the active DropZone to drops that land anywhere outside it. */
export function onGlobalDrop(handler: (input: DroppedInput) => void): () => void {
  const listener = (event: Event) => handler((event as CustomEvent<DroppedInput>).detail)
  window.addEventListener(DROP_EVENT, listener)
  return () => window.removeEventListener(DROP_EVENT, listener)
}
