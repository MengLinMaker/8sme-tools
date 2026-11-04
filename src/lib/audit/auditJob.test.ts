import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import type { ZipEntry } from '@/lib/zip'
import { auditEntries, markFromFilename } from './auditJob'

function makeNc(mark: string, qty: number, length: number): string {
  return `ST
** ${mark}.nc1
  CO-7255
  ${mark}
  ${mark}
  8
  C300
  ${qty}
  EA75*75*6
  L
    ${length}
      75.00
      75.00
       6.00
AK
  v      0.00u      0.00
EN`
}

const VALID_STEP = `ISO-10303-21;
HEADER;
FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));
ENDSEC;
DATA;
#1 = CARTESIAN_POINT('',(0.,0.,0.));
ENDSEC;
END-ISO-10303-21;`

const PDF_BYTES = strToU8(`%PDF-1.4\n${'x'.repeat(200)}\n%%EOF`)

const SHARED = ['Part', 'Qty', 'Profile', 'Grade', 'Length (mm)', 'Weight (kg)', 'a1', 'a3', 'm9']

function buildPartListZip(): Uint8Array {
  const sst = `<sst>${SHARED.map((s) => `<si><t>${s}</t></si>`).join('')}</sst>`
  const sCell = (ref: string, v: number) => `<c r="${ref}" t="s"><v>${v}</v></c>`
  const nCell = (ref: string, v: number) => `<c r="${ref}"><v>${v}</v></c>`
  const hdr = `<row r="1">${[0, 1, 2, 3, 4, 5].map((i, idx) => sCell(`${'ABCDEF'[idx]}1`, i)).join('')}</row>`
  const row = (r: number, part: number, qty: number) =>
    `<row r="${r}">${sCell(`A${r}`, part)}${nCell(`B${r}`, qty)}${sCell(`C${r}`, 0)}${sCell(`D${r}`, 0)}${nCell(`E${r}`, 100)}${nCell(`F${r}`, 1)}</row>`
  const sheet = `<worksheet><sheetData>${hdr}${row(2, 6, 1)}${row(3, 7, 9)}${row(4, 8, 2)}</sheetData></worksheet>`
  return zipSync({
    'xl/sharedStrings.xml': strToU8(sst),
    'xl/worksheets/sheet1.xml': strToU8(sheet),
  })
}

function buildAssemblyPartList(): Uint8Array {
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ['Assembly', 'Part', 'Qty', 'Profile', 'Grade', 'Length (mm)', 'Weight (kg)'],
      ['A1', '', 2, 'EA75*75*6', '', '', ''],
      ['', 'p1', 1, 'EA75*75*6', 'C300', 100, 1],
      ['', 'p2', 3, 'EA75*75*6', 'C300', 100, 1],
      ['A2', '', 4, 'EA75*75*6', '', '', ''],
      ['', 'p1', 2, 'EA75*75*6', 'C300', 100, 1],
      ['', 'p2', 1, 'EA75*75*6', 'C300', 100, 1],
      ['', 'p3', 1, 'EA75*75*6', 'C300', 100, 1],
    ]),
    'Assembly Part List',
  )
  return new Uint8Array(XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }))
}

function makeEntries(): ZipEntry[] {
  return [
    { path: 'a1.nc1', bytes: strToU8(makeNc('a1', 1, 4165.75)) },
    { path: 'a1.stp', bytes: strToU8(VALID_STEP) },
    { path: 'a1 - ANGLE.pdf', bytes: PDF_BYTES },
    { path: 'a3.nc1', bytes: strToU8(makeNc('a3', 5, 4165.75)) },
    { path: 'a3.stp', bytes: strToU8(VALID_STEP) },
    { path: 'a3 - ANGLE.pdf', bytes: PDF_BYTES },
    { path: 'part list.xlsx', bytes: buildPartListZip() },
  ]
}

describe('markFromFilename', () => {
  it('strips leading dots from hidden/AppleDouble filenames', () => {
    expect(markFromFilename('.a1.nc1')).toBe('a1')
    expect(markFromFilename('._M-1.nc1')).toBe('m-1')
  })

  it('leaves normal marks alone', () => {
    expect(markFromFilename('a1.nc1')).toBe('a1')
    expect(markFromFilename('M-1.nc1')).toBe('m-1')
  })
})

describe('auditEntries', () => {
  it('cross-checks quantities against the part list', () => {
    const result = auditEntries('job.zip', makeEntries())
    expect(result.summary.hasPartList).toBe(true)
    expect(result.parts).toHaveLength(2)

    const mismatch = result.findings.find((f) => f.code === 'QTY_MISMATCH')
    expect(mismatch?.mark).toBe('a3')
    expect(mismatch?.severity).toBe('error')

    expect(result.findings.some((f) => f.code === 'PART_LIST_NO_FILES' && f.mark === 'm9')).toBe(
      true,
    )
    expect(result.summary.errors).toBe(1)
  })

  it('totals quantities across assemblies and keeps each usage', () => {
    const result = auditEntries('job.zip', [
      { path: 'p1.nc1', bytes: strToU8(makeNc('p1', 10, 100)) },
      { path: 'p2.nc1', bytes: strToU8(makeNc('p2', 10, 100)) },
      { path: 'Assembly Part List.xlsx', bytes: buildAssemblyPartList() },
    ])

    expect(result.summary.hasPartList).toBe(true)
    expect(result.parts.find((part) => part.mark === 'p1')?.expected?.qty).toBe(10)
    expect(result.parts.find((part) => part.mark === 'p2')?.expected?.qty).toBe(10)
    expect(result.parts.find((part) => part.mark === 'p1')?.assemblies).toEqual([
      { assembly: 'A1', assemblyQty: 2, qtyPerAssembly: 1, total: 2 },
      { assembly: 'A2', assemblyQty: 4, qtyPerAssembly: 2, total: 8 },
    ])
    expect(result.findings.some((finding) => finding.code === 'QTY_MISMATCH')).toBe(false)
    expect(result.findings.filter((finding) => finding.code === 'PART_LIST_NO_FILES')).toHaveLength(
      1,
    )
  })

  it('reports the missing part list and missing companion files', () => {
    const entries = makeEntries().filter((entry) => !entry.path.endsWith('.xlsx'))
    const result = auditEntries('job.zip', entries)
    expect(result.summary.hasPartList).toBe(false)
    expect(result.findings.some((f) => f.code === 'NO_PART_LIST')).toBe(true)

    const stepOnly = auditEntries('job.zip', [
      { path: 'b1.nc1', bytes: strToU8(makeNc('b1', 1, 100)) },
    ])
    const missingStep = stepOnly.findings.find((f) => f.code === 'MISSING_STEP' && f.mark === 'b1')
    expect(missingStep?.severity).toBe('info')
    expect(stepOnly.findings.some((f) => f.code === 'MISSING_PDF' && f.mark === 'b1')).toBe(true)
  })

  it('ignores duplicate NC/STEP/PDF copies and keeps the first', () => {
    const result = auditEntries('job.zip', [
      { path: 'a1.nc1', bytes: strToU8(makeNc('a1', 4, 100)) },
      { path: 'duplicate/a1.nc1', bytes: strToU8(makeNc('a1', 4, 100)) },
      { path: 'a1.stp', bytes: strToU8(VALID_STEP) },
      { path: 'duplicate/a1.stp', bytes: strToU8(VALID_STEP) },
      { path: 'a1 - ANGLE.pdf', bytes: PDF_BYTES },
      { path: 'duplicate/a1 - ANGLE.pdf', bytes: PDF_BYTES },
    ])
    expect(result.findings.some((f) => f.code.startsWith('DUPLICATE_'))).toBe(false)
    expect(result.parts).toHaveLength(1)
    expect(result.parts[0]?.nc?.path).toBe('a1.nc1')
    expect(result.parts[0]?.step?.path).toBe('a1.stp')
    expect(result.parts[0]?.pdf?.path).toBe('a1 - ANGLE.pdf')
  })

  it('ignores slash/underscore differences in the NC internal mark', () => {
    const result = auditEntries('job.zip', [
      { path: 'a_1.nc1', bytes: strToU8(makeNc('A/1', 1, 100)) },
    ])
    expect(result.findings.some((f) => f.code === 'NC_MARK_MISMATCH')).toBe(false)
  })

  it('skips marks with neither an NC nor a STEP as non-parts', () => {
    const result = auditEntries('job.zip', [
      { path: 'a1.nc1', bytes: strToU8(makeNc('a1', 1, 100)) },
      { path: 'a1.stp', bytes: strToU8(VALID_STEP) },
      { path: 'x9 - ASSEMBLY.pdf', bytes: PDF_BYTES },
    ])
    expect(result.parts.map((part) => part.mark)).toEqual(['a1'])
    expect(result.findings.some((f) => f.code === 'NOT_A_PART' && f.mark === 'x9')).toBe(true)
    expect(result.findings.some((f) => f.code === 'MISSING_NC' && f.mark === 'x9')).toBe(false)
    expect(result.findings.some((f) => f.code === 'MISSING_STEP' && f.mark === 'x9')).toBe(false)
  })
})
