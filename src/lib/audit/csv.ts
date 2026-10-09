import type { AuditResult } from './types'

function escapeCsv(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

function toCsv(rows: string[][]): string {
  return `${rows.map((row) => row.map(escapeCsv).join(',')).join('\r\n')}\r\n`
}

export function findingsToCsv(result: AuditResult): string {
  const rows: string[][] = [['severity', 'code', 'mark', 'message']]
  for (const f of result.findings) {
    rows.push([f.severity, f.code, f.mark ?? '', f.message])
  }
  return toCsv(rows)
}

export function partsToCsv(result: AuditResult): string {
  const rows: string[][] = [
    ['mark', 'ncQty', 'listQty', 'profile', 'grade', 'ncLength', 'listLength', 'nc', 'step', 'pdf'],
  ]
  for (const part of result.parts) {
    rows.push([
      part.mark,
      part.nc?.quantity?.toString() ?? '',
      part.expected?.qty?.toString() ?? '',
      part.nc?.profile ?? part.expected?.profile ?? '',
      part.nc?.grade ?? part.expected?.grade ?? '',
      part.nc?.length?.toString() ?? '',
      part.expected?.length?.toString() ?? '',
      part.nc ? (part.nc.valid ? 'ok' : 'invalid') : 'missing',
      part.step ? (part.step.valid ? 'ok' : 'invalid') : 'missing',
      part.pdf ? (part.pdf.valid ? 'ok' : 'invalid') : 'missing',
    ])
  }
  return toCsv(rows)
}
