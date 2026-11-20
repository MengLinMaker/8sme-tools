import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import type { ZipEntry } from '@/lib/zip'
import { auditEntries, markFromFilename, quantityFromFilename } from './auditJob'

function makeNc(mark: string, qty: number, length: number, profile = 'EA75*75*6'): string {
  return `ST
** ${mark}.nc1
  CO-7255
  ${mark}
  ${mark}
  8
  C300
  ${qty}
  ${profile}
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

/** A part list whose Part column writes the mark the way Tekla reports it: `ITEM 35`. */
function buildItemPartListZip(): Uint8Array {
  const shared = [
    'Part',
    'Qty',
    'Profile',
    'Grade',
    'Length (mm)',
    'Weight (kg)',
    'ITEM 35',
    'ITEM 36',
  ]
  const sst = `<sst>${shared.map((s) => `<si><t>${s}</t></si>`).join('')}</sst>`
  const sCell = (ref: string, v: number) => `<c r="${ref}" t="s"><v>${v}</v></c>`
  const nCell = (ref: string, v: number) => `<c r="${ref}"><v>${v}</v></c>`
  const hdr = `<row r="1">${[0, 1, 2, 3, 4, 5].map((i, idx) => sCell(`${'ABCDEF'[idx]}1`, i)).join('')}</row>`
  const row = (r: number, part: number, qty: number) =>
    `<row r="${r}">${sCell(`A${r}`, part)}${nCell(`B${r}`, qty)}${sCell(`C${r}`, 0)}${sCell(`D${r}`, 0)}${nCell(`E${r}`, 100)}${nCell(`F${r}`, 1)}</row>`
  const sheet = `<worksheet><sheetData>${hdr}${row(2, 6, 9)}${row(3, 7, 1)}</sheetData></worksheet>`
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
    expect(markFromFilename('3ub-1.nc1')).toBe('3ub-1')
    expect(markFromFilename('3uc-100.nc1')).toBe('3uc-100')
  })

  it('keeps the distinguishing suffix of a mark', () => {
    expect(markFromFilename('TR9-1.nc1')).toBe('tr9-1')
    expect(markFromFilename('TR9-2.nc1')).toBe('tr9-2')
    expect(markFromFilename('TR9-1  Shaft - UC (0).pdf')).toBe('tr9-1')
  })

  it('reads the ITEM token from comma-separated Tekla STEP names', () => {
    expect(markFromFilename('12095, ITEM 1, PFC 250, 1 OFF[C].STEP')).toBe('item1')
    expect(markFromFilename('12095, ITEM 35, SHS 75x75x6, 2 OFF[C].STEP')).toBe('item35')
    expect(markFromFilename('item10.stp')).toBe('item10')
  })
})

describe('quantityFromFilename', () => {
  it('reads the <n> OFF token from comma-separated Tekla STEP names', () => {
    expect(quantityFromFilename('12095, ITEM 1, PFC 250, 1 OFF[C].STEP')).toBe(1)
    expect(quantityFromFilename('12095, ITEM 35, SHS 75x75x6, 24 OFF[C].STEP')).toBe(24)
  })

  it('accepts lowercase and no space', () => {
    expect(quantityFromFilename('item1, SHS 75x75x6, 24off.stp')).toBe(24)
  })

  it('does not mistake a number in the mark for a quantity', () => {
    expect(quantityFromFilename('TR9-1.nc1')).toBeNull()
    expect(quantityFromFilename('3ub-1 offcut.stp')).toBeNull()
    expect(quantityFromFilename('24 pieces.stp')).toBeNull()
  })

  it('rejects zero', () => {
    expect(quantityFromFilename('item1, 0 OFF.stp')).toBeNull()
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

  it('does not flag a missing NC — only quantity matters', () => {
    const result = auditEntries('job.zip', [{ path: 's1.stp', bytes: strToU8(VALID_STEP) }])
    expect(result.findings.some((f) => f.code === 'MISSING_NC')).toBe(false)
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

  it('keeps hyphenated marks that share a prefix as separate parts', () => {
    const result = auditEntries('job.zip', [
      { path: 'IFC shaft NC/TR9-1.nc1', bytes: strToU8(makeNc('TR9-1', 1, 100)) },
      { path: 'IFC shaft NC/TR9-2.nc1', bytes: strToU8(makeNc('TR9-2', 1, 200)) },
      { path: 'IFC shafts PDF/TR9-1  Shaft - UC (0).pdf', bytes: PDF_BYTES },
      { path: 'IFC shafts PDF/TR9-2  Shaft - UC (0).pdf', bytes: PDF_BYTES },
    ])
    expect(result.parts.map((part) => part.mark)).toEqual(['tr9-1', 'tr9-2'])
    expect(result.parts.map((part) => part.nc?.length)).toEqual([100, 200])
    expect(result.parts.map((part) => part.pdf?.path)).toEqual([
      'IFC shafts PDF/TR9-1  Shaft - UC (0).pdf',
      'IFC shafts PDF/TR9-2  Shaft - UC (0).pdf',
    ])
    expect(result.findings.some((finding) => finding.code === 'NC_MARK_MISMATCH')).toBe(false)
  })

  it('still folds duplicate copies of the same mark together', () => {
    const result = auditEntries('job.zip', [
      { path: 'IFC shaft NC/TR9-1.nc1', bytes: strToU8(makeNc('TR9-1', 1, 100)) },
      { path: 'IFC-shaft-NC-selected/TR9-1.nc1', bytes: strToU8(makeNc('TR9-1', 1, 100)) },
      { path: 'IFC shaft NC/TR9-2.nc1', bytes: strToU8(makeNc('TR9-2', 1, 200)) },
    ])
    expect(result.parts.map((part) => part.mark)).toEqual(['tr9-1', 'tr9-2'])
    expect(result.parts.find((part) => part.mark === 'tr9-1')?.nc?.path).toBe(
      'IFC shaft NC/TR9-1.nc1',
    )
  })

  it('keeps comma-separated ITEM STEPs as separate parts and folds true copies', () => {
    const result = auditEntries('j12095.zip', [
      { path: 'STEP/12095, ITEM 1, PFC 250, 1 OFF[C].STEP', bytes: strToU8(VALID_STEP) },
      { path: 'STEP/12095, ITEM 2, PFC 250, 1 OFF[C].STEP', bytes: strToU8(VALID_STEP) },
      { path: 'STEP.zip/STEP/12095, ITEM 1, PFC 250, 1 OFF[C].STEP', bytes: strToU8(VALID_STEP) },
    ])
    expect(result.parts.map((part) => part.mark)).toEqual(['item1', 'item2'])
    expect(result.parts[0]?.step?.path).toBe('STEP/12095, ITEM 1, PFC 250, 1 OFF[C].STEP')
    expect(result.parts[0]?.step?.quantity).toBe(1)
  })

  it('reads a quantity from a STEP filename without an NC or part list', () => {
    const result = auditEntries('j12095.zip', [
      { path: 'STEP/12095, ITEM 7, SHS 75x75x6, 24 OFF[C].STEP', bytes: strToU8(VALID_STEP) },
    ])
    expect(result.parts[0]?.step?.quantity).toBe(24)
  })

  it('joins a part-list `ITEM 35` to a STEP named `item35`', () => {
    const result = auditEntries('j12095.zip', [
      { path: 'STEP/12095, ITEM 35, SHS 75x75x6, 9 OFF[C].STEP', bytes: strToU8(VALID_STEP) },
      { path: 'part list.xlsx', bytes: buildItemPartListZip() },
    ])
    expect(result.parts[0]?.mark).toBe('item35')
    expect(result.parts[0]?.step?.quantity).toBe(9)
    expect(result.parts[0]?.expected?.qty).toBe(9)
    expect(
      result.findings.some((f) => f.code === 'PART_LIST_NO_FILES' && f.mark === 'item35'),
    ).toBe(false)
    // The list's ITEM 36 has no file, so it is still reported.
    expect(
      result.findings.some((f) => f.code === 'PART_LIST_NO_FILES' && f.mark === 'item36'),
    ).toBe(true)
  })

  it('applies custom STEP name rules to mark and quantity', () => {
    const result = auditEntries(
      'job.zip',
      [{ path: 'WALL-2_A17_SHS 75x75x6_3 OFF.step', bytes: strToU8(VALID_STEP) }],
      { stepNames: { mark: 'WALL-\\d+_([A-Z]\\d+)_', quantity: '([0-9]+) OFF' } },
    )
    expect(result.parts[0]?.mark).toBe('a17')
    expect(result.parts[0]?.step?.quantity).toBe(3)
  })

  it('falls back to the built-in name when a custom rule misses', () => {
    const result = auditEntries(
      'job.zip',
      [{ path: 'b1.nc1', bytes: strToU8(makeNc('b1', 1, 100)) }],
      {
        stepNames: { mark: '^ITEM-([0-9]+)$' },
      },
    )
    expect(result.parts[0]?.mark).toBe('b1')
  })

  it('treats underscores as separators when enabled', () => {
    const result = auditEntries(
      'job.zip',
      [{ path: 'ITEM_36_SHS_75x75x6_4_OFF.step', bytes: strToU8(VALID_STEP) }],
      { stepNames: { underscoreSeparator: true } },
    )
    expect(result.parts[0]?.mark).toBe('item36')
    expect(result.parts[0]?.step?.quantity).toBe(4)
  })

  it('accepts a rounded UB mass in the profile cross-check', () => {
    const partList = (profile: string) => {
      const workbook = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(
        workbook,
        XLSX.utils.aoa_to_sheet([
          ['Part', 'Qty', 'Profile', 'Grade', 'Length (mm)', 'Weight (kg)'],
          ['u1', 1, profile, 'C300', 1000, 1],
        ]),
        'Part List',
      )
      return new Uint8Array(XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }))
    }
    const audit = (listed: string) =>
      auditEntries('job.zip', [
        { path: 'u1.nc1', bytes: strToU8(makeNc('u1', 1, 1000, '200UB25.4')) },
        { path: 'part list.xlsx', bytes: partList(listed) },
      ])

    // `200UB25` is the rounded callout for the same 200UB25.4 section.
    expect(audit('200UB25').findings.some((f) => f.code === 'PROFILE_MISMATCH')).toBe(false)
    expect(audit('200UB25.4').findings.some((f) => f.code === 'PROFILE_MISMATCH')).toBe(false)
    // A different mass is still a different section.
    expect(audit('200UB30').findings.some((f) => f.code === 'PROFILE_MISMATCH')).toBe(true)
  })

  it('reads a macro-enabled .xlsm part list', () => {
    const entries = makeEntries().map((entry) =>
      entry.path === 'part list.xlsx' ? { ...entry, path: 'part list.xlsm' } : entry,
    )
    const result = auditEntries('job.zip', entries)
    expect(result.summary.hasPartList).toBe(true)
    expect(result.parts).toHaveLength(2)
    expect(result.findings.find((finding) => finding.code === 'QTY_MISMATCH')?.mark).toBe('a3')
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
