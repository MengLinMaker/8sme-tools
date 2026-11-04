import { strFromU8, unzipSync } from 'fflate'
import * as XLSX from 'xlsx'
import { partListRowSchema } from '@/lib/audit/schemas'
import type { PartListRow } from '@/lib/audit/types'

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(Number(d)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/g, '&')
}

/** Concatenates every `<t>` run inside each shared-string `<si>` entry. */
function parseSharedStrings(xml: string | undefined): string[] {
  if (!xml) return []
  const out: string[] = []
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g
  let si: RegExpExecArray | null = siRe.exec(xml)
  while (si) {
    let text = ''
    const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g
    let t: RegExpExecArray | null = tRe.exec(si[1])
    while (t) {
      text += decodeXml(t[1])
      t = tRe.exec(si[1])
    }
    out.push(text)
    si = siRe.exec(xml)
  }
  return out
}

function columnIndex(ref: string): number {
  const letters = ref.replace(/[^A-Za-z]/g, '').toUpperCase()
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

function parseSheet(xml: string, shared: string[]): string[][] {
  const rows: string[][] = []
  const rowRe = /<row\b([^>]*)>([\s\S]*?)<\/row>/g
  let rowMatch: RegExpExecArray | null = rowRe.exec(xml)
  while (rowMatch) {
    const rowAttr = rowMatch[1]
    const rowNumMatch = rowAttr.match(/\br="(\d+)"/)
    const rowIndex = rowNumMatch ? Number(rowNumMatch[1]) - 1 : rows.length
    const cells = rowMatch[2]
    const arr: string[] = []

    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g
    let cellMatch: RegExpExecArray | null = cellRe.exec(cells)
    while (cellMatch) {
      const attrs = cellMatch[1]
      const body = cellMatch[2] ?? ''
      const refMatch = attrs.match(/\br="([A-Za-z]+\d+)"/)
      const col = refMatch ? columnIndex(refMatch[1]) : arr.length
      const isShared = /\bt="s"/.test(attrs)

      let value = ''
      const vMatch = body.match(/<v>([\s\S]*?)<\/v>/)
      if (vMatch) {
        value = isShared ? (shared[Number(vMatch[1])] ?? '') : decodeXml(vMatch[1])
      } else {
        const tMatch = body.match(/<t\b[^>]*>([\s\S]*?)<\/t>/)
        if (tMatch) value = decodeXml(tMatch[1])
      }
      arr[col] = value
      cellMatch = cellRe.exec(cells)
    }

    rows[rowIndex] = arr
    rowMatch = rowRe.exec(xml)
  }
  return rows
}

function readCell(grid: string[][], row: number, col: number): string {
  return (grid[row]?.[col] ?? '').trim()
}

const HEADER_KEYS = {
  assembly: ['assembly', 'assemblies', 'assembly mark', 'assembly no'],
  part: ['part', 'mark', 'item'],
  qty: ['qty', 'quantity', 'qty.'],
  profile: ['profile', 'section', 'type'],
  grade: ['grade', 'material', 'steel'],
  length: ['length'],
  weight: ['weight', 'mass'],
} as const

function toNumber(value: string): number | null {
  const cleaned = value.replace(/,/g, '').match(/-?\d+(\.\d+)?/)
  if (!cleaned) return null
  const n = Number(cleaned[0])
  return Number.isFinite(n) ? n : null
}

function isZip(bytes: Uint8Array): boolean {
  return bytes[0] === 0x50 && bytes[1] === 0x4b
}

function isOle(bytes: Uint8Array): boolean {
  return bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0
}

function looksHtml(bytes: Uint8Array): boolean {
  const head = new TextDecoder()
    .decode(bytes.subarray(0, Math.min(bytes.length, 1024)))
    .replace(/^\uFEFF/, '')
    .trimStart()
    .toLowerCase()
  return head.startsWith('<')
}

/** Reads the first worksheet of an OOXML workbook with the dependency-free parser. */
function readOoxmlGrid(bytes: Uint8Array): string[][] | null {
  const files = unzipSync(bytes)
  const decodeFile = (name: string): string | undefined =>
    files[name] ? strFromU8(files[name]) : undefined
  const shared = parseSharedStrings(decodeFile('xl/sharedStrings.xml'))
  const sheetXml = decodeFile('xl/worksheets/sheet1.xml')
  if (!sheetXml) return null
  return parseSheet(sheetXml, shared)
}

/** Reads BIFF (legacy .xls) workbooks via SheetJS. */
function readSheetJsGrid(bytes: Uint8Array): string[][] {
  const workbook = XLSX.read(bytes, { type: 'array', raw: true })
  const sheet = workbook.Sheets[workbook.SheetNames[0] ?? '']
  if (!sheet) return []
  const rows = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: true,
    defval: '',
    blankrows: true,
  }) as unknown[][]
  return rows.map((row) => (row ?? []).map((cell) => (cell == null ? '' : String(cell))))
}

/** Reads the HTML-table `.xls` files Tekla's report export writes. */
function readHtmlGrid(html: string): string[][] {
  const rows: string[][] = []
  const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi
  let rowMatch: RegExpExecArray | null = rowRe.exec(html)
  while (rowMatch) {
    const cells: string[] = []
    const cellRe = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi
    let cellMatch: RegExpExecArray | null = cellRe.exec(rowMatch[1])
    while (cellMatch) {
      const text = decodeXml(cellMatch[1].replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' '))
        .replace(/\u00a0/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
      cells.push(text)
      cellMatch = cellRe.exec(rowMatch[1])
    }
    if (cells.some((cell) => cell !== '')) rows.push(cells)
    rowMatch = rowRe.exec(html)
  }
  return rows
}

function readGrid(bytes: Uint8Array): string[][] {
  if (isZip(bytes)) {
    try {
      const grid = readOoxmlGrid(bytes)
      if (grid) return grid
    } catch {
      // Not the OOXML layout we expect; SheetJS can still try it.
    }
    return readSheetJsGrid(bytes)
  }
  if (isOle(bytes)) return readSheetJsGrid(bytes)
  if (looksHtml(bytes)) return readHtmlGrid(new TextDecoder().decode(bytes))
  throw new Error('not a spreadsheet')
}

/** Finds the report header row and returns the column indexes it names. */
function headerColumns(
  grid: string[][],
): { row: number; columns: Record<keyof typeof HEADER_KEYS, number> } | null {
  const columns: Record<keyof typeof HEADER_KEYS, number> = {
    assembly: -1,
    part: -1,
    qty: -1,
    profile: -1,
    grade: -1,
    length: -1,
    weight: -1,
  }

  for (let r = 0; r < grid.length; r++) {
    const row = grid[r]
    if (!row) continue
    const found = { ...columns }
    let hits = 0
    for (let c = 0; c < row.length; c++) {
      const text = (row[c] ?? '').trim().toLowerCase()
      if (!text) continue
      for (const key of Object.keys(HEADER_KEYS) as (keyof typeof HEADER_KEYS)[]) {
        if (
          found[key] === -1 &&
          HEADER_KEYS[key].some((kw) => text === kw || text.startsWith(kw))
        ) {
          found[key] = c
          hits++
        }
      }
    }
    if (found.part !== -1 && hits >= 3) return { row: r, columns: found }
  }
  return null
}

function rowsFromGrid(grid: string[][]): PartListRow[] {
  const header = headerColumns(grid)
  if (!header) return []
  const { row: headerRow, columns } = header

  const rows: PartListRow[] = []
  let currentAssembly: string | undefined
  let currentAssemblyQty = 1

  for (let r = headerRow + 1; r < grid.length; r++) {
    const part = readCell(grid, r, columns.part)
    const assembly = columns.assembly === -1 ? '' : readCell(grid, r, columns.assembly)
    const qty = columns.qty === -1 ? null : toNumber(readCell(grid, r, columns.qty))
    const grade = columns.grade === -1 ? '' : readCell(grid, r, columns.grade)
    const length = columns.length === -1 ? null : toNumber(readCell(grid, r, columns.length))

    // Assembly rows carry the assembly quantity but have no grade/length of their own. Some
    // exports put a description ("PRIMED") in the Part column, so don't rely on it being blank.
    if (columns.assembly !== -1 && assembly && grade === '' && length === null) {
      currentAssembly = assembly
      currentAssemblyQty = qty && qty > 0 ? qty : 1
      continue
    }
    if (!part) continue

    const parsed = partListRowSchema.safeParse({
      part,
      qty,
      profile: columns.profile === -1 ? '' : readCell(grid, r, columns.profile),
      grade,
      length,
      weight: columns.weight === -1 ? null : toNumber(readCell(grid, r, columns.weight)),
      assembly: columns.assembly === -1 ? undefined : assembly || currentAssembly,
      assemblyQty: columns.assembly === -1 ? undefined : currentAssemblyQty,
    })
    if (parsed.success) rows.push(parsed.data)
  }
  return rows
}

/**
 * Reads a Tekla part list entirely in memory. Supports OOXML `.xlsx`, legacy BIFF `.xls`, and
 * the HTML-table `.xls` that Tekla's report exporter writes. The first worksheet is used.
 */
export function parsePartList(bytes: Uint8Array): PartListRow[] {
  return rowsFromGrid(readGrid(bytes))
}
