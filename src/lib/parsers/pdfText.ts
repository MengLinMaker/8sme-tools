/**
 * Drawing-text extraction. The full pdf.js build is only pulled in on demand
 * (via dynamic import) so it never lands in the initial bundle.
 */

import type { PDFWorker } from 'pdfjs-dist'

type PdfjsModule = typeof import('pdfjs-dist')

let enginePromise: Promise<{ pdfjs: PdfjsModule; pool: PdfWorkerPool }> | null = null

async function loadPdfjs(): Promise<PdfjsModule> {
  const pdfjs = await import('pdfjs-dist')
  if (!pdfjs.GlobalWorkerOptions.workerSrc) {
    const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default
  }
  return pdfjs
}

/** How many pdf.js workers to keep warm. Matches the preflight parse concurrency. */
const MAX_PDF_WORKERS = 6

interface WorkerLease {
  worker: PDFWorker
  release: () => void
}

/**
 * Keeps a small set of pdf.js workers alive and hands them out one document at a
 * time. Spinning up a `Worker` (and compiling the ~800 KB worker script) per PDF
 * is the dominant cost of reading a drawing, so workers are reused instead of
 * being recreated for every document.
 */
class PdfWorkerPool {
  private readonly workers: PDFWorker[] = []
  private readonly idle: PDFWorker[] = []
  private readonly waiters: ((worker: PDFWorker) => void)[] = []

  constructor(private readonly pdfjs: PdfjsModule) {}

  async acquire(): Promise<WorkerLease> {
    const worker = await this.take()
    let released = false
    return {
      worker,
      release: () => {
        if (released) return
        released = true
        const waiter = this.waiters.shift()
        if (waiter) waiter(worker)
        else this.idle.push(worker)
      },
    }
  }

  private async take(): Promise<PDFWorker> {
    let worker = this.idle.pop()
    if (!worker && this.workers.length < MAX_PDF_WORKERS) {
      worker = new this.pdfjs.PDFWorker()
      this.workers.push(worker)
    }
    if (!worker) {
      worker = await new Promise<PDFWorker>((resolve) => this.waiters.push(resolve))
    }
    await worker.promise
    return worker
  }

  destroy(): void {
    for (const worker of this.workers) worker.destroy()
    this.workers.length = 0
    this.idle.length = 0
    this.waiters.length = 0
  }
}

function getEngine(): Promise<{ pdfjs: PdfjsModule; pool: PdfWorkerPool }> {
  enginePromise ??= (async () => {
    const pdfjs = await loadPdfjs()
    return { pdfjs, pool: new PdfWorkerPool(pdfjs) }
  })()
  return enginePromise
}

/** Concatenates the text layer of every page in a drawing PDF. */
export async function extractPdfText(bytes: Uint8Array): Promise<string> {
  const { pdfjs, pool } = await getEngine()
  const { worker, release } = await pool.acquire()
  try {
    // The copy is ours to hand off; pdf.js transfers its buffer to the worker.
    const task = pdfjs.getDocument({ data: new Uint8Array(bytes), worker })
    const document = await task.promise
    try {
      const parts: string[] = []
      for (let page = 1; page <= document.numPages; page++) {
        const content = await (await document.getPage(page)).getTextContent()
        parts.push(content.items.map((item) => ('str' in item ? item.str : '')).join(' '))
      }
      return parts.join('\n')
    } finally {
      // Tears down this document only; the pooled worker is left alive for reuse.
      await task.destroy()
    }
  } finally {
    release()
  }
}

// The same drawing bytes are parsed by both the preflight qty pass and the 3D
// viewer (for the section callout) — cache by identity so each is parsed once.
const textCache = new WeakMap<Uint8Array, Promise<string>>()

/** Cached {@link extractPdfText}; keyed on the input buffer identity. */
export function extractDrawingText(bytes: Uint8Array): Promise<string> {
  const cached = textCache.get(bytes)
  if (cached) return cached
  const promise = extractPdfText(bytes)
  textCache.set(bytes, promise)
  return promise
}

/**
 * Australian section short-forms as they appear on Tekla drawings, e.g.
 * `EA75*75*6`, `UA100*75*6`, `RHS150*100*9.0`, `SHS100*100*6.0`, `PFC100*50`,
 * `BT100*15`, `200UB29.8`, `150PFC`, `310UC158`, `125 TFB`.
 */
const SECTION_PATTERNS = [
  /\b\d+(?:\.\d+)?(?:UB|UC|WB|WC)\d+(?:\.\d+)?/i,
  /\b\d+(?:\.\d+)?\s*TFB\b/i,
  /\b(?:RHS|SHS|CHS)\d+(?:[*xX]\d+)*(?:\.\d+)?/i,
  /\b(?:EA|UA)\d+(?:[*xX]\d+)*(?:\.\d+)?/i,
  /\bBT\d+(?:[*xX]\d+)*(?:\.\d+)?/i,
  /\b(?:PFC|TFC)\d+(?:[*xX]\d+)*(?:\.\d+)?/i,
  /\b\d+(?:\.\d+)?(?:PFC|TFC)\b/i,
]

/** Finds the first section callout in a drawing's text, if any. */
export function findSectionCode(text: string): string | null {
  const compact = text.replace(/\s+/g, ' ')
  for (const pattern of SECTION_PATTERNS) {
    const match = compact.match(pattern)
    if (match) return match[0].replace(/\s+/g, '').toUpperCase()
  }
  return null
}

export interface MaterialEntry {
  mark: string
  section: string
  grade: string
  length: number
  qty: number
}

/** MARK SECTION GRADE LENGTH Qty AREA WEIGHT row from a Tekla "MATERIAL LIST". */
const MATERIAL_ROW =
  /(\b[A-Za-z]\w*\b)\s+(RHS\S*|SHS\S*|PFC\S*|TFC\S*|EA\S*|UA\S*|BT\S*|\d+UB\S*|\d+UC\S*|\d+\s*TFB\S*)\s+(C\d+)\s+([\d.]+)\s+(\d+)\s+([\d.]+)\s+([\d.]+)/gi

/** Extracts every material-list row from a drawing's text. */
export function findMaterialEntries(text: string): MaterialEntry[] {
  const compact = text.replace(/\s+/g, ' ')
  const entries: MaterialEntry[] = []
  for (const match of compact.matchAll(MATERIAL_ROW)) {
    entries.push({
      mark: match[1],
      section: match[2].replace(/\s+/g, '').toUpperCase(),
      grade: match[3].toUpperCase(),
      length: Number(match[4]),
      qty: Number(match[5]),
    })
  }
  return entries
}

export interface DrawingMaterial {
  qty: number
  length: number
  section: string
}

/**
 * Reads a part's ground-truth quantity/length from its drawing. The drawing is
 * authoritative (per the shop's rule), so this is the reference the NC is held to.
 */
export async function resolveDrawingMaterial(
  bytes: Uint8Array,
  mark: string,
): Promise<DrawingMaterial | null> {
  const entries = findMaterialEntries(await extractDrawingText(bytes))
  if (entries.length === 0) return null
  const needle = mark.trim().toLowerCase()
  const match = entries.find((entry) => entry.mark.toLowerCase() === needle) ?? entries[0]
  return { qty: match.qty, length: match.length, section: match.section }
}
