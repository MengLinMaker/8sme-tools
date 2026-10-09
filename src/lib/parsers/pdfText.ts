/**
 * Drawing-text extraction. The full pdf.js build is only pulled in on demand
 * (via dynamic import) so it never lands in the initial bundle.
 */

let workerConfigured = false

async function configureWorker(): Promise<void> {
  const pdfjs = await import('pdfjs-dist')
  if (!workerConfigured && !pdfjs.GlobalWorkerOptions.workerSrc) {
    const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default
    workerConfigured = true
  }
}

/** Concatenates the text layer of every page in a drawing PDF. */
export async function extractPdfText(bytes: Uint8Array): Promise<string> {
  await configureWorker()
  const pdfjs = await import('pdfjs-dist')
  const document = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise
  const parts: string[] = []
  for (let page = 1; page <= document.numPages; page++) {
    const content = await (await document.getPage(page)).getTextContent()
    parts.push(content.items.map((item) => ('str' in item ? item.str : '')).join(' '))
  }
  return parts.join('\n')
}

/**
 * Australian section short-forms as they appear on Tekla drawings, e.g.
 * `EA75*75*6`, `UA100*75*6`, `RHS150*100*9.0`, `SHS100*100*6.0`, `PFC100*50`,
 * `BT100*15`, `200UB29.8`, `150PFC`.
 */
const SECTION_PATTERNS = [
  /\b\d+(?:\.\d+)?(?:UB|WB|WC)\d+(?:\.\d+)?/i,
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
