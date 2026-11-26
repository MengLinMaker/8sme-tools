import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { DrawingViewer } from './DrawingViewer'

/** One assembly sheet: the assembly it belongs to and the drawing's own bytes. */
export interface AssemblyDrawing {
  assembly: string
  path: string
  bytes: Uint8Array
}

function fileName(path: string): string {
  return path.split('/').pop() ?? path
}

/**
 * The assembly sheet, in its own dialog: paper only, no 3D. `DrawingViewer` already rasterises
 * every page of the PDF, so a multi-page Tekla assembly drawing scrolls page by page; the arrows
 * step between assemblies that have a sheet, in the same order as the card.
 */
export function AssemblyDrawingDialog({
  drawings,
  index,
  onIndex,
  onClose,
}: {
  drawings: AssemblyDrawing[]
  /** Index into `drawings`, or null when the dialog is closed. */
  index: number | null
  onIndex: (index: number) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const current = index == null ? null : (drawings[index] ?? null)

  // Arrow keys step between sheets, the way the parts viewer's arrows do.
  useEffect(() => {
    if (index == null) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft' && index > 0) {
        event.preventDefault()
        onIndex(index - 1)
      } else if (event.key === 'ArrowRight' && index < drawings.length - 1) {
        event.preventDefault()
        onIndex(index + 1)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [index, drawings.length, onIndex])

  return (
    <Dialog
      open={index != null}
      onClose={onClose}
      fullscreen
      title={
        current ? (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="min-w-0 flex-1 truncate font-mono text-sm font-semibold">
              {current.assembly}
            </span>
            <span className="min-w-0 max-w-56 truncate text-xs font-normal text-muted-foreground">
              {fileName(current.path)}
            </span>
            <div className="flex shrink-0 items-center gap-0.5">
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                disabled={index == null || index <= 0}
                onClick={() => index != null && onIndex(index - 1)}
                aria-label={t('preflight.assemblies.prevDrawing')}
                title={t('preflight.assemblies.prevDrawing')}
              >
                <ChevronLeft />
              </Button>
              <span className="w-16 whitespace-nowrap text-center text-xs font-normal tabular-nums text-muted-foreground">
                {index == null ? '' : `${index + 1} / ${drawings.length}`}
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                disabled={index == null || index >= drawings.length - 1}
                onClick={() => index != null && onIndex(index + 1)}
                aria-label={t('preflight.assemblies.nextDrawing')}
                title={t('preflight.assemblies.nextDrawing')}
              >
                <ChevronRight />
              </Button>
            </div>
          </div>
        ) : undefined
      }
    >
      {current && (
        <div className="h-full">
          {/* The bytes are copied by the viewer, so stepping back to a sheet re-renders it. */}
          <DrawingViewer bytes={current.bytes} />
        </div>
      )}
    </Dialog>
  )
}
