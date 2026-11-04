import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import { parsePartList } from './xlsx'

const SHARED = [
  'Part',
  'Qty',
  'Profile',
  'Grade',
  'Length (mm)',
  'Weight (kg)',
  'a1',
  'EA75*75*6',
  'C300',
  'a3',
  'm105',
  'SHS100*100*6.0',
  'C350',
]

function cell(ref: string, value: string, shared: boolean): string {
  const type = shared ? ' t="s"' : ''
  return `<c r="${ref}"${type}><v>${value}</v></c>`
}

function buildWorkbook(): Uint8Array {
  const sharedStrings = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${SHARED.map((s) => `<si><t>${s}</t></si>`).join('')}</sst>`

  const rows = [
    `<row r="1">${cell('A1', '0', true)}${cell('B1', '1', true)}${cell('C1', '2', true)}${cell('D1', '3', true)}${cell('E1', '4', true)}${cell('F1', '5', true)}</row>`,
    `<row r="2">${cell('A2', '6', true)}${cell('B2', '1', false)}${cell('C2', '7', true)}${cell('D2', '8', true)}${cell('E2', '4131', false)}${cell('F2', '28.1', false)}</row>`,
    `<row r="3">${cell('A3', '9', true)}${cell('B3', '5', false)}${cell('C3', '7', true)}${cell('D3', '8', true)}${cell('E3', '4131', false)}${cell('F3', '28.1', false)}</row>`,
    `<row r="4">${cell('A4', '10', true)}${cell('B4', '4', false)}${cell('C4', '11', true)}${cell('D4', '12', true)}${cell('E4', '3966.1', false)}${cell('F4', '58.5', false)}</row>`,
  ]

  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.join('')}</sheetData></worksheet>`

  return zipSync({
    'xl/sharedStrings.xml': strToU8(sharedStrings),
    'xl/worksheets/sheet1.xml': strToU8(sheet),
  })
}

const ASSEMBLY_SHARED = [
  'Assembly',
  'Part',
  'Qty',
  'Profile',
  'Grade',
  'Length (mm)',
  'Weight (kg)',
  'A1',
  'A2',
  'p1',
  'p2',
  'RHS100',
  'C350',
]

function buildAssemblyWorkbook(): Uint8Array {
  const sharedStrings = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${ASSEMBLY_SHARED.map((s) => `<si><t>${s}</t></si>`).join('')}</sst>`
  const header = [0, 1, 2, 3, 4, 5, 6]
    .map((index, column) => cell(`${'ABCDEFG'[column]}1`, String(index), true))
    .join('')
  const assemblyRow = (r: number, assembly: number, qty: number) =>
    `<row r="${r}">${cell(`A${r}`, String(assembly), true)}${cell(`C${r}`, String(qty), false)}${cell(`D${r}`, '3', true)}${cell(`G${r}`, '35', false)}</row>`
  const partRow = (r: number, part: number, qty: number) =>
    `<row r="${r}">${cell(`B${r}`, String(part), true)}${cell(`C${r}`, String(qty), false)}${cell(`D${r}`, '3', true)}${cell(`E${r}`, '4', true)}${cell(`F${r}`, '100', false)}${cell(`G${r}`, '2', false)}</row>`
  const rows = [
    `<row r="1">${header}</row>`,
    assemblyRow(2, 7, 2),
    partRow(3, 9, 1),
    partRow(4, 10, 3),
    assemblyRow(5, 8, 4),
    partRow(6, 9, 1),
  ]
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.join('')}</sheetData></worksheet>`
  return zipSync({
    'xl/sharedStrings.xml': strToU8(sharedStrings),
    'xl/worksheets/sheet1.xml': strToU8(sheet),
  })
}

const HTML_ASSEMBLY = `<!DOCTYPE HTML><HTML><BODY>
<TABLE><TR><TD>Project</TD><TD>demo</TD></TR></TABLE>
<TABLE>
<TR><TH>Assembly</TH><TH>Part</TH><TH>Qty</TH><TH>Profile</TH><TH>Grade</TH><TH>Length (mm)</TH><TH>Weight (kg)</TH></TR>
<TR><TD>A1</TD><TD>PRIMED</TD><TD>2</TD><TD>RHS100</TD><TD></TD><TD></TD><TD>35</TD></TR>
<TR><TD></TD><TD>p1</TD><TD>1</TD><TD>RHS100</TD><TD>C350</TD><TD>100</TD><TD>2</TD></TR>
<TR><TD></TD><TD>p2</TD><TD>3</TD><TD>RHS100</TD><TD>C350</TD><TD>100</TD><TD>2</TD></TR>
</TABLE>
</BODY></HTML>`

describe('parsePartList', () => {
  it('reads rows from an OOXML workbook', () => {
    const rows = parsePartList(buildWorkbook())
    expect(rows).toHaveLength(3)
    expect(rows[0]).toEqual({
      part: 'a1',
      qty: 1,
      profile: 'EA75*75*6',
      grade: 'C300',
      length: 4131,
      weight: 28.1,
    })
    expect(rows[2]?.part).toBe('m105')
    expect(rows[2]?.profile).toBe('SHS100*100*6.0')
    expect(rows[2]?.qty).toBe(4)
  })

  it('reads assembly grouping from an OOXML workbook', () => {
    const rows = parsePartList(buildAssemblyWorkbook())
    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({
      part: 'p1',
      qty: 1,
      assembly: 'A1',
      assemblyQty: 2,
    })
    expect(rows[1]).toMatchObject({ part: 'p2', qty: 3, assembly: 'A1', assemblyQty: 2 })
    expect(rows[2]).toMatchObject({ part: 'p1', qty: 1, assembly: 'A2', assemblyQty: 4 })
  })

  it('reads an HTML-table .xls report', () => {
    const rows = parsePartList(strToU8(HTML_ASSEMBLY))
    expect(rows.map((row) => [row.part, row.qty, row.assembly, row.assemblyQty])).toEqual([
      ['p1', 1, 'A1', 2],
      ['p2', 3, 'A1', 2],
    ])
  })

  it('reads a legacy BIFF .xls report', () => {
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ['Project', 'x'],
        ['Assembly', 'Part', 'Qty', 'Profile', 'Grade', 'Length (mm)', 'Weight (kg)'],
        ['A1', '', 2, 'RHS100', '', '', 35],
        ['', 'p1', 1, 'RHS100', 'C350', 100, 2],
      ]),
      'Report',
    )
    const bytes = new Uint8Array(XLSX.write(workbook, { type: 'array', bookType: 'biff8' }))
    const rows = parsePartList(bytes)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ part: 'p1', assembly: 'A1', assemblyQty: 2 })
  })

  it('throws on a non-spreadsheet', () => {
    expect(() => parsePartList(strToU8('nope'))).toThrow()
  })
})
