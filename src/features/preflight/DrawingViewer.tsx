/**
 * Minimal PDF drawing viewer: rasterises the drawing to a canvas and offers only
 * zoom and scroll/pan. The browser's built-in PDF plugin brings its own toolbar
 * (print, download, page nav, sidebar overview) which is clutter for a drawing
 * check, so the pages are drawn here instead.
 */

import type { PDFDocumentProxy } from 'pdfjs-dist'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'

type PdfjsModule = typeof import('pdfjs-dist')

let pdfjsPromise: Promise<PdfjsModule> | null = null

/** Lazily pulls in pdf.js (and its worker) so it stays off the boot path. */
function loadPdfjs(): Promise<PdfjsModule> {
  pdfjsPromise ??= (async () => {
    const pdfjs = await import('pdfjs-dist')
    if (!pdfjs.GlobalWorkerOptions.workerSrc) {
      const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default
    }
    return pdfjs
  })()
  return pdfjsPromise
}

const MIN_ZOOM = 0.2
const MAX_ZOOM = 8
const ZOOM_STEP = 1.25

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

interface PageSize {
  width: number
  height: number
}

export function DrawingViewer({ bytes }: { bytes: Uint8Array }) {
  const { t } = useTranslation()
  const scrollRef = useRef<HTMLDivElement>(null)
  const canvasRefs = useRef<(HTMLCanvasElement | null)[]>([])
  const dragRef = useRef<{ x: number; y: number; left: number; top: number } | null>(null)

  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null)
  const [sizes, setSizes] = useState<PageSize[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [zoom, setZoom] = useState(1)
  const [fit, setFit] = useState(true)
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom

  // Load the document, then measure each page at scale 1 so "fit" can be computed.
  useEffect(() => {
    let cancelled = false
    setDoc(null)
    setSizes([])
    setStatus('loading')
    let task: { destroy: () => Promise<void> } | null = null

    void (async () => {
      try {
        const pdfjs = await loadPdfjs()
        // pdf.js transfers the buffer it is handed; hand it a copy of ours.
        const loadingTask = pdfjs.getDocument({ data: new Uint8Array(bytes) })
        task = loadingTask
        const document = await loadingTask.promise
        if (cancelled) return
        const measured: PageSize[] = []
        for (let page = 1; page <= document.numPages; page++) {
          const viewport = (await document.getPage(page)).getViewport({ scale: 1 })
          measured.push({ width: viewport.width, height: viewport.height })
        }
        if (cancelled) return
        setSizes(measured)
        setDoc(document)
        setStatus('ready')
      } catch {
        if (!cancelled) setStatus('error')
      }
    })()

    return () => {
      cancelled = true
      void task?.destroy()
    }
  }, [bytes])

  // Keep the drawing fitted to the pane's width (tall pages scroll vertically) until the user zooms.
  useEffect(() => {
    if (!fit || sizes.length === 0) return
    const el = scrollRef.current
    if (!el) return
    const compute = () => {
      const availableWidth = el.clientWidth
      if (availableWidth <= 0) return
      const width = Math.max(...sizes.map((size) => size.width))
      setZoom(clamp(availableWidth / width, MIN_ZOOM, MAX_ZOOM))
    }
    compute()
    const observer = new ResizeObserver(compute)
    observer.observe(el)
    return () => observer.disconnect()
  }, [fit, sizes])

  // Rasterise every page at the current zoom (scaled for the display's DPR).
  useEffect(() => {
    if (!doc || sizes.length === 0) return
    let cancelled = false
    const tasks: { cancel: () => void }[] = []

    void (async () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      for (let page = 1; page <= doc.numPages; page++) {
        const canvas = canvasRefs.current[page - 1]
        if (!canvas) continue
        const proxy = await doc.getPage(page)
        if (cancelled) return
        const viewport = proxy.getViewport({ scale: zoom * dpr })
        canvas.width = Math.max(1, Math.floor(viewport.width))
        canvas.height = Math.max(1, Math.floor(viewport.height))
        canvas.style.width = `${Math.floor(sizes[page - 1].width * zoom)}px`
        canvas.style.height = `${Math.floor(sizes[page - 1].height * zoom)}px`
        const renderTask = proxy.render({ canvas, viewport })
        tasks.push(renderTask)
        try {
          await renderTask.promise
        } catch {
          // superseded by a newer zoom; the replacement render draws the page.
        }
        if (cancelled) return
      }
    })()

    return () => {
      cancelled = true
      for (const renderTask of tasks) renderTask.cancel()
    }
  }, [doc, sizes, zoom])

  const zoomBy = useCallback((factor: number) => {
    setFit(false)
    setZoom((current) => clamp(current * factor, MIN_ZOOM, MAX_ZOOM))
  }, [])

  const fitWidth = useCallback(() => {
    setFit(true)
    const el = scrollRef.current
    if (el && sizes.length > 0) {
      const availableWidth = el.clientWidth
      if (availableWidth > 0) {
        const width = Math.max(...sizes.map((size) => size.width))
        setZoom(clamp(availableWidth / width, MIN_ZOOM, MAX_ZOOM))
      }
    }
  }, [sizes])

  // Ctrl/⌘ + wheel zooms toward the pointer; plain wheel is left alone so it
  // scrolls the page instead of the drawing. Drag to pan.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      const rect = el.getBoundingClientRect()
      const pointerX = event.clientX - rect.left + el.scrollLeft
      const pointerY = event.clientY - rect.top + el.scrollTop
      const factor = event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP
      const next = clamp(zoomRef.current * factor, MIN_ZOOM, MAX_ZOOM)
      const ratio = next / zoomRef.current
      setFit(false)
      setZoom(next)
      requestAnimationFrame(() => {
        el.scrollLeft = pointerX * ratio - (event.clientX - rect.left)
        el.scrollTop = pointerY * ratio - (event.clientY - rect.top)
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    const el = scrollRef.current
    if (!el) return
    dragRef.current = { x: event.clientX, y: event.clientY, left: el.scrollLeft, top: el.scrollTop }
    el.setPointerCapture(event.pointerId)
  }

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    const el = scrollRef.current
    if (!drag || !el) return
    el.scrollLeft = drag.left - (event.clientX - drag.x)
    el.scrollTop = drag.top - (event.clientY - drag.y)
  }

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = null
    scrollRef.current?.releasePointerCapture(event.pointerId)
  }

  return (
    <div className="relative h-full w-full bg-[#15181c]">
      <div
        ref={scrollRef}
        className="absolute inset-0 cursor-grab overflow-auto active:cursor-grabbing"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <div className="flex min-h-full w-max min-w-full flex-col items-center gap-4">
          {sizes.map((size, index) => (
            <canvas
              // biome-ignore lint/suspicious/noArrayIndexKey: pages are ordered and never reordered.
              key={index}
              ref={(node) => {
                canvasRefs.current[index] = node
              }}
              className="block shrink-0 rounded-sm bg-white shadow-lg"
              style={{ width: size.width * zoom, height: size.height * zoom }}
            />
          ))}
        </div>
      </div>

      {status === 'ready' ? (
        <div
          className="absolute bottom-3 right-3 z-10 flex items-center gap-0.5 rounded-md border border-border bg-card/85 p-1 backdrop-blur"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            aria-label={t('preflight.viewer.zoomOut')}
            title={t('preflight.viewer.zoomOut')}
            onClick={() => zoomBy(1 / ZOOM_STEP)}
            className="grid size-7 place-items-center rounded text-lg leading-none text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            −
          </button>
          <button
            type="button"
            aria-label={t('preflight.viewer.fitWidth')}
            title={t('preflight.viewer.fitWidth')}
            onClick={fitWidth}
            className={cn(
              'min-w-12 rounded px-1 text-center text-xs font-medium tabular-nums transition-colors hover:bg-accent hover:text-accent-foreground',
              fit ? 'text-accent-foreground' : 'text-muted-foreground',
            )}
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            type="button"
            aria-label={t('preflight.viewer.zoomIn')}
            title={t('preflight.viewer.zoomIn')}
            onClick={() => zoomBy(ZOOM_STEP)}
            className="grid size-7 place-items-center rounded text-lg leading-none text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            +
          </button>
        </div>
      ) : (
        <div className="grid h-full w-full place-items-center text-sm text-muted-foreground">
          {status === 'error'
            ? t('preflight.viewer.drawingError')
            : t('preflight.viewer.loadingShort')}
        </div>
      )}
    </div>
  )
}
