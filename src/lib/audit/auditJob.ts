import { parseNcFile } from '@/lib/parsers/nc'
import { parsePdfFile } from '@/lib/parsers/pdf'
import { parseStepFile } from '@/lib/parsers/step'
import { parsePartList } from '@/lib/parsers/xlsx'
import type { ZipEntry } from '@/lib/zip'
import type { AuditResult, AuditSummary, Finding, PartListRow, PartRecord, Severity } from './types'

const LENGTH_TOLERANCE_ABS = 50
const LENGTH_TOLERANCE_REL = 0.02

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 }

type Kind = 'nc' | 'step' | 'pdf' | 'xlsx' | 'other'

function baseName(path: string): string {
  return path.split('/').pop() ?? path
}

function extension(path: string): string {
  const base = baseName(path)
  const dot = base.lastIndexOf('.')
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : ''
}

function classify(path: string): Kind {
  if (baseName(path).startsWith('~$')) return 'other'
  const ext = extension(path)
  if (ext === 'nc1' || ext === 'nc') return 'nc'
  if (ext === 'stp' || ext === 'step') return 'step'
  if (ext === 'pdf') return 'pdf'
  if (ext === 'xlsx') return 'xlsx'
  return 'other'
}

export function markFromFilename(path: string): string {
  const base = baseName(path).replace(/\.[^.]+$/, '')
  const match = base.match(/^[A-Za-z]+\d+/)
  return (match ? match[0] : base).toLowerCase()
}

const decoder = new TextDecoder('utf-8')
function decodeText(bytes: Uint8Array): string {
  return decoder.decode(bytes)
}

export function auditEntries(sourceName: string, entries: ZipEntry[]): AuditResult {
  const findings: Finding[] = []
  const parts = new Map<string, PartRecord>()
  const counts = { nc: 0, step: 0, pdf: 0 }
  let partList: PartListRow[] = []

  const getPart = (mark: string): PartRecord => {
    let part = parts.get(mark)
    if (!part) {
      part = { mark }
      parts.set(mark, part)
    }
    return part
  }

  for (const entry of entries) {
    const kind = classify(entry.path)
    if (kind === 'other') continue

    if (kind === 'xlsx') {
      try {
        const rows = parsePartList(entry.bytes)
        if (rows.length > 0) partList = rows
        else
          findings.push({
            severity: 'warning',
            code: 'PART_LIST_UNREADABLE',
            message: `${baseName(entry.path)} has no recognisable part list rows`,
            params: { file: baseName(entry.path) },
          })
      } catch {
        findings.push({
          severity: 'warning',
          code: 'PART_LIST_UNREADABLE',
          message: `${baseName(entry.path)} could not be opened as a spreadsheet`,
          params: { file: baseName(entry.path) },
        })
      }
      continue
    }

    const mark = markFromFilename(entry.path)
    const part = getPart(mark)

    if (kind === 'nc') {
      counts.nc++
      if (part.nc) {
        findings.push({
          severity: 'warning',
          code: 'DUPLICATE_NC',
          mark,
          message: `Duplicate NC for ${mark}: ${baseName(part.nc.path)} and ${baseName(entry.path)}`,
          params: { mark, a: baseName(part.nc.path), b: baseName(entry.path) },
        })
      }
      part.nc = parseNcFile(entry.path, decodeText(entry.bytes))
    } else if (kind === 'step') {
      counts.step++
      if (part.step) {
        findings.push({
          severity: 'warning',
          code: 'DUPLICATE_STEP',
          mark,
          message: `Duplicate STEP for ${mark}: ${baseName(part.step.path)} and ${baseName(entry.path)}`,
          params: { mark, a: baseName(part.step.path), b: baseName(entry.path) },
        })
      }
      part.step = parseStepFile(entry.path, decodeText(entry.bytes))
    } else {
      counts.pdf++
      if (part.pdf) {
        findings.push({
          severity: 'warning',
          code: 'DUPLICATE_PDF',
          mark,
          message: `Duplicate PDF for ${mark}: ${baseName(part.pdf.path)} and ${baseName(entry.path)}`,
          params: { mark, a: baseName(part.pdf.path), b: baseName(entry.path) },
        })
      }
      part.pdf = parsePdfFile(entry.path, entry.bytes)
    }
  }

  const hasPartList = partList.length > 0
  const expected = new Map<string, PartListRow>()
  for (const row of partList) expected.set(row.part.toLowerCase(), row)

  for (const part of parts.values()) {
    const exp = expected.get(part.mark)
    if (exp) part.expected = exp

    // A mark with neither an NC nor a STEP is almost certainly not a laser part
    // (e.g. a stray drawing or an assembly), so skip it rather than flag missing files.
    if (!part.nc && !part.step) {
      findings.push({
        severity: 'info',
        code: 'NOT_A_PART',
        mark: part.mark,
        message: `${part.mark} has neither an NC nor a STEP file — skipped (not a part)`,
        params: { mark: part.mark },
      })
      continue
    }

    if (part.nc) {
      if (!part.nc.valid) {
        findings.push({
          severity: 'error',
          code: 'NC_INVALID',
          mark: part.mark,
          message: `${baseName(part.nc.path)} may not open: ${part.nc.problems.join('; ')}`,
          params: { file: baseName(part.nc.path), problems: part.nc.problems.join('; ') },
        })
      } else if (part.nc.quantity === null) {
        findings.push({
          severity: 'warning',
          code: 'QTY_MISSING',
          mark: part.mark,
          message: `NC has no usable quantity`,
        })
      }
      if (part.nc.mark && part.nc.mark.toLowerCase() !== part.mark) {
        findings.push({
          severity: 'warning',
          code: 'NC_MARK_MISMATCH',
          mark: part.mark,
          message: `NC internal mark "${part.nc.mark}" does not match filename mark "${part.mark}"`,
          params: { internal: part.nc.mark, mark: part.mark },
        })
      }
    } else {
      findings.push({
        severity: 'warning',
        code: 'MISSING_NC',
        mark: part.mark,
        message: `No NC file found for ${part.mark}`,
        params: { mark: part.mark },
      })
    }

    if (part.step) {
      if (!part.step.valid) {
        findings.push({
          severity: 'error',
          code: 'STEP_INVALID',
          mark: part.mark,
          message: `${baseName(part.step.path)} may not open: ${part.step.problems.join('; ')}`,
          params: { file: baseName(part.step.path), problems: part.step.problems.join('; ') },
        })
      }
    } else {
      findings.push({
        severity: 'warning',
        code: 'MISSING_STEP',
        mark: part.mark,
        message: `No STEP file found for ${part.mark}`,
        params: { mark: part.mark },
      })
    }

    if (part.pdf) {
      if (!part.pdf.valid) {
        findings.push({
          severity: 'error',
          code: 'PDF_INVALID',
          mark: part.mark,
          message: `${baseName(part.pdf.path)} may not open: ${part.pdf.problems.join('; ')}`,
          params: { file: baseName(part.pdf.path), problems: part.pdf.problems.join('; ') },
        })
      }
    } else {
      findings.push({
        severity: 'info',
        code: 'MISSING_PDF',
        mark: part.mark,
        message: `No drawing PDF found for ${part.mark}`,
        params: { mark: part.mark },
      })
    }

    if (exp && part.nc && part.nc.quantity !== null && exp.qty !== null) {
      if (part.nc.quantity !== exp.qty) {
        findings.push({
          severity: 'error',
          code: 'QTY_MISMATCH',
          mark: part.mark,
          message: `NC quantity ${part.nc.quantity} differs from part list quantity ${exp.qty}`,
          params: { nc: part.nc.quantity, list: exp.qty },
        })
      }
    }
    if (exp && part.nc) {
      if (
        part.nc.profile &&
        exp.profile &&
        part.nc.profile.toLowerCase() !== exp.profile.toLowerCase()
      ) {
        findings.push({
          severity: 'warning',
          code: 'PROFILE_MISMATCH',
          mark: part.mark,
          message: `NC profile ${part.nc.profile} differs from part list ${exp.profile}`,
          params: { nc: part.nc.profile, list: exp.profile },
        })
      }
      if (part.nc.grade && exp.grade && part.nc.grade.toLowerCase() !== exp.grade.toLowerCase()) {
        findings.push({
          severity: 'warning',
          code: 'GRADE_MISMATCH',
          mark: part.mark,
          message: `NC grade ${part.nc.grade} differs from part list ${exp.grade}`,
          params: { nc: part.nc.grade, list: exp.grade },
        })
      }
      if (part.nc.length !== null && exp.length !== null) {
        const diff = Math.abs(part.nc.length - exp.length)
        const tolerance = Math.max(LENGTH_TOLERANCE_ABS, exp.length * LENGTH_TOLERANCE_REL)
        if (diff > tolerance) {
          findings.push({
            severity: 'info',
            code: 'LENGTH_DIFFERENCE',
            mark: part.mark,
            message: `NC length ${part.nc.length}mm vs part-list ${exp.length}mm (Δ${diff.toFixed(1)}mm) — verify against drawing`,
            params: { nc: part.nc.length, list: exp.length, diff: diff.toFixed(1) },
          })
        }
      }
    }
  }

  for (const row of partList) {
    if (!parts.has(row.part.toLowerCase())) {
      findings.push({
        severity: 'warning',
        code: 'PART_LIST_NO_FILES',
        mark: row.part.toLowerCase(),
        message: `Part list lists ${row.part} but no NC/STEP/PDF files were found`,
        params: { part: row.part },
      })
    }
  }

  if (!hasPartList) {
    findings.push({
      severity: 'info',
      code: 'NO_PART_LIST',
      message: 'No part list (.xlsx) found — quantity cross-checks were skipped',
    })
  }

  findings.sort((a, b) => {
    const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
    if (bySeverity !== 0) return bySeverity
    return (a.mark ?? '').localeCompare(b.mark ?? '')
  })

  // Only marks with a manufacturable file (NC or STEP) count as parts.
  const partRecords = [...parts.values()]
    .filter((part) => part.nc || part.step)
    .sort((a, b) => a.mark.localeCompare(b.mark))

  const summary: AuditSummary = {
    parts: partRecords.length,
    errors: findings.filter((f) => f.severity === 'error').length,
    warnings: findings.filter((f) => f.severity === 'warning').length,
    infos: findings.filter((f) => f.severity === 'info').length,
    ncCount: counts.nc,
    stepCount: counts.step,
    pdfCount: counts.pdf,
    hasPartList,
  }

  return {
    sourceName,
    entriesTotal: entries.length,
    parts: partRecords,
    findings,
    summary,
  }
}
