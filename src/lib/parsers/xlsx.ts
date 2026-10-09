import { strFromU8, unzipSync } from 'fflate'
import { partListRowSchema } from '@/lib/audit/schemas'
import type { PartListRow } from '@/lib/audit/types'

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(Number(d)))
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

/**
 * Reads a `.xlsx` part list entirely in-memory: unzips the OOXML container and
 * parses the shared-string table plus the first worksheet. No external sheet lib.
 */
export function parsePartList(bytes: Uint8Array): PartListRow[] {
  const files = unzipSync(bytes)
  const decodeFile = (name: string): string | undefined =>
    files[name] ? strFromU8(files[name]) : undefined

  const shared = parseSharedStrings(decodeFile('xl/sharedStrings.xml'))
  const sheetXml = decodeFile('xl/worksheets/sheet1.xml')
  if (!sheetXml) return []

  const grid = parseSheet(sheetXml, shared)

  let headerRow = -1
  const columns: Record<keyof typeof HEADER_KEYS, number> = {
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
    if (found.part !== -1 && hits >= 3) {
      headerRow = r
      Object.assign(columns, found)
      break
    }
  }

  if (headerRow === -1) return []

  const rows: PartListRow[] = []
  for (let r = headerRow + 1; r < grid.length; r++) {
    const parsed = partListRowSchema.safeParse({
      part: readCell(grid, r, columns.part),
      qty: columns.qty === -1 ? null : toNumber(readCell(grid, r, columns.qty)),
      profile: columns.profile === -1 ? '' : readCell(grid, r, columns.profile),
      grade: columns.grade === -1 ? '' : readCell(grid, r, columns.grade),
      length: columns.length === -1 ? null : toNumber(readCell(grid, r, columns.length)),
      weight: columns.weight === -1 ? null : toNumber(readCell(grid, r, columns.weight)),
    })
    if (parsed.success) rows.push(parsed.data)
  }
  return rows
}
