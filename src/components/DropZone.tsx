import { type DragEvent, type InputHTMLAttributes, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import {
  type DroppedInput,
  type InputBundle,
  readDirectoryHandle,
  readDroppedInput,
  readFiles,
  snapshotDataTransfer,
} from '@/lib/readInput'
import { cn } from '@/lib/utils'

const DIRECTORY_INPUT_PROPS = {
  webkitdirectory: '',
  directory: '',
} as unknown as InputHTMLAttributes<HTMLInputElement>

export interface DropZoneProps {
  onBundle: (bundle: InputBundle) => void
  onError?: (message: string) => void
  title?: string
  /** One-line version, for a page that already has a job loaded. */
  compact?: boolean
}

export function DropZone({ onBundle, onError, title, compact }: DropZoneProps) {
  const { t } = useTranslation()
  const [dragging, setDragging] = useState(false)
  const [reading, setReading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const folderRef = useRef<HTMLInputElement>(null)
  const dragDepth = useRef(0)

  const ingest = async (read: () => Promise<InputBundle>, emptyMessage?: string) => {
    setReading(true)
    try {
      const bundle = await read()
      if (bundle.entries.length === 0) {
        onError?.(emptyMessage ?? t('dropzone.noFiles'))
        return
      }
      onBundle(bundle)
    } catch (err) {
      onError?.(err instanceof Error ? err.message : String(err))
    } finally {
      setReading(false)
    }
  }

  const acceptDrop = (input: DroppedInput) => {
    if (reading) return
    const hasPayload =
      input.files.length > 0 || input.entries.length > 0 || input.handles.length > 0
    void ingest(() => readDroppedInput(input), hasPayload ? undefined : t('dropzone.unreadable'))
  }

  const onDrop = (event: DragEvent<HTMLFieldSetElement>) => {
    event.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    // Snapshot the DataTransfer synchronously — it is invalidated once this handler returns, and
    // lazily reading it later is what breaks folder / zip drops on Windows.
    acceptDrop(snapshotDataTransfer(event.dataTransfer))
  }

  const chooseFolder = async () => {
    const picker = window.showDirectoryPicker
    if (typeof picker !== 'function') {
      folderRef.current?.click()
      return
    }
    try {
      const dir = await picker.call(window)
      await ingest(() => readDirectoryHandle(dir))
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      onError?.(err instanceof Error ? err.message : String(err))
    }
  }

  const label = reading ? t('dropzone.reading') : (title ?? t('dropzone.title'))
  const actions = (
    <div className={cn('flex items-center gap-2', !compact && 'flex-wrap justify-center')}>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={reading}
        onClick={() => inputRef.current?.click()}
      >
        {t('dropzone.chooseZip')}
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={reading}
        onClick={() => void chooseFolder()}
      >
        {t('dropzone.chooseFolder')}
      </Button>
    </div>
  )

  return (
    <fieldset
      data-dropzone=""
      aria-label={t('dropzone.aria')}
      className={cn(
        'rounded-xl border border-dashed transition-colors',
        compact
          ? 'flex flex-wrap items-center gap-2 px-3 py-2 text-xs'
          : 'flex flex-col items-center gap-3 px-5 py-9 text-center',
        dragging
          ? 'border-primary bg-primary/5'
          : 'border-input hover:border-primary/50 hover:bg-accent/40',
        reading && 'cursor-default opacity-70',
      )}
      onDragEnter={(event) => {
        event.preventDefault()
        dragDepth.current++
        setDragging(true)
      }}
      onDragOver={(event) => {
        event.preventDefault()
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1)
        if (dragDepth.current === 0) setDragging(false)
      }}
      onDragEnd={() => {
        dragDepth.current = 0
        setDragging(false)
      }}
      onDrop={onDrop}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".zip,.rar"
        hidden
        onChange={(event) => {
          void ingest(() => readFiles(Array.from(event.target.files ?? [])))
          event.target.value = ''
        }}
      />
      <input
        ref={folderRef}
        type="file"
        multiple
        hidden
        {...DIRECTORY_INPUT_PROPS}
        onChange={(event) => {
          void ingest(() => readFiles(Array.from(event.target.files ?? [])))
          event.target.value = ''
        }}
      />
      <span className={cn(compact ? 'mr-auto text-muted-foreground' : 'text-lg font-semibold')}>
        {label}
      </span>
      {actions}
    </fieldset>
  )
}
