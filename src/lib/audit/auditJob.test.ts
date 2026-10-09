import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import type { ZipEntry } from '@/lib/zip'
import { auditEntries } from './auditJob'

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

  it('reports the missing part list and missing companion files', () => {
    const entries = makeEntries().filter((entry) => !entry.path.endsWith('.xlsx'))
    const result = auditEntries('job.zip', entries)
    expect(result.summary.hasPartList).toBe(false)
    expect(result.findings.some((f) => f.code === 'NO_PART_LIST')).toBe(true)

    const stepOnly = auditEntries('job.zip', [
      { path: 'b1.nc1', bytes: strToU8(makeNc('b1', 1, 100)) },
    ])
    expect(stepOnly.findings.some((f) => f.code === 'MISSING_STEP' && f.mark === 'b1')).toBe(true)
    expect(stepOnly.findings.some((f) => f.code === 'MISSING_PDF' && f.mark === 'b1')).toBe(true)
  })
})
