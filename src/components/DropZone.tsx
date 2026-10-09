import { type DragEvent, type InputHTMLAttributes, useRef, useState } from 'react'
import { type InputBundle, readDataTransfer, readFiles } from '@/lib/readInput'
import { cn } from '@/lib/utils'

const DIRECTORY_INPUT_PROPS = {
  webkitdirectory: '',
  directory: '',
} as unknown as InputHTMLAttributes<HTMLInputElement>

export interface DropZoneProps {
  onBundle: (bundle: InputBundle) => void
  onError?: (message: string) => void
  title?: string
  hint?: string
}

export function DropZone({ onBundle, onError, title, hint }: DropZoneProps) {
  const [dragging, setDragging] = useState(false)
  const [reading, setReading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const folderRef = useRef<HTMLInputElement>(null)

  const ingest = async (read: () => Promise<InputBundle>) => {
    setReading(true)
    try {
      const bundle = await read()
      if (bundle.entries.length === 0) {
        onError?.('No readable NC / STEP / PDF / part-list files found.')
        return
      }
      onBundle(bundle)
    } catch (err) {
      onError?.(err instanceof Error ? err.message : String(err))
    } finally {
      setReading(false)
    }
  }

  const onDrop = (event: DragEvent<HTMLButtonElement>) => {
    event.preventDefault()
    setDragging(false)
    void ingest(() => readDataTransfer(event.dataTransfer))
  }

  return (
    <div className="flex flex-col gap-3">
      <input
        ref={inputRef}
        type="file"
        multiple
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
      <button
        type="button"
        className={cn(
          'flex w-full flex-col items-center gap-1.5 rounded-xl border border-dashed px-5 py-9 text-center transition-colors',
          dragging
            ? 'border-primary bg-primary/5'
            : 'border-input hover:border-primary/50 hover:bg-accent/40',
          reading && 'cursor-default opacity-70',
        )}
        disabled={reading}
        onClick={() => inputRef.current?.click()}
        onDragOver={(event) => {
          event.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <span className="text-lg font-semibold">
          {reading ? 'Reading…' : (title ?? 'Drop a .zip, files, or a folder')}
        </span>
        <span className="text-sm text-muted-foreground">or click to browse files</span>
        <span className="mt-1 text-xs tracking-wide text-muted-foreground">
          {hint ?? '.zip · .nc1 · .stp · .pdf · .xlsx'}
        </span>
      </button>
      <div className="text-center text-sm text-muted-foreground">
        <button
          type="button"
          className="font-medium text-primary underline-offset-4 hover:underline"
          onClick={() => folderRef.current?.click()}
        >
          choose a folder
        </button>
      </div>
    </div>
  )
}
