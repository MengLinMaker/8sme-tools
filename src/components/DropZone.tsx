import { type DragEvent, type InputHTMLAttributes, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
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
}

export function DropZone({ onBundle, onError, title }: DropZoneProps) {
  const { t } = useTranslation()
  const [dragging, setDragging] = useState(false)
  const [reading, setReading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const folderRef = useRef<HTMLInputElement>(null)
  const dragDepth = useRef(0)

  const ingest = async (read: () => Promise<InputBundle>) => {
    setReading(true)
    try {
      const bundle = await read()
      if (bundle.entries.length === 0) {
        onError?.(t('dropzone.noFiles'))
        return
      }
      onBundle(bundle)
    } catch (err) {
      onError?.(err instanceof Error ? err.message : String(err))
    } finally {
      setReading(false)
    }
  }

  const onDrop = (event: DragEvent<HTMLFieldSetElement>) => {
    event.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    void ingest(() => readDataTransfer(event.dataTransfer))
  }

  return (
    <fieldset
      aria-label={t('dropzone.aria')}
      className={cn(
        'flex flex-col items-center gap-3 rounded-xl border border-dashed px-5 py-9 text-center transition-colors',
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
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={() => {
        dragDepth.current--
        if (dragDepth.current <= 0) setDragging(false)
      }}
      onDrop={onDrop}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".zip"
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
      <span className="text-lg font-semibold">
        {reading ? t('dropzone.reading') : (title ?? t('dropzone.title'))}
      </span>
      <div className="flex flex-wrap items-center justify-center gap-2">
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
          onClick={() => folderRef.current?.click()}
        >
          {t('dropzone.chooseFolder')}
        </Button>
      </div>
    </fieldset>
  )
}
