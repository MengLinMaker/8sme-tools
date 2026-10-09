import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
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

  it('throws on a non-spreadsheet', () => {
    expect(() => parsePartList(strToU8('nope'))).toThrow()
  })
})
