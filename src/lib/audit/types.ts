import type { Finding, PartListRow } from './schemas'

export type { Finding, NcHeader, PartListRow, Severity, SeverityFilter } from './schemas'

export interface NcFile {
  path: string
  programCode: string
  mark: string
  markAlt: string
  profileCode: string
  grade: string
  quantity: number | null
  profile: string
  orientation: string
  length: number | null
  dimensions: number[]
  /** Nominal mass per metre (kg/m) from the DSTV header (column 15), where present. */
  weightPerMetre: number | null
  valid: boolean
  problems: string[]
}

export interface StepFile {
  path: string
  valid: boolean
  schema: string | null
  entityCount: number
  problems: string[]
}

export interface PdfFile {
  path: string
  valid: boolean
  problems: string[]
}

export interface PartRecord {
  mark: string
  nc?: NcFile
  step?: StepFile
  pdf?: PdfFile
  expected?: PartListRow
}

export interface AuditSummary {
  parts: number
  errors: number
  warnings: number
  infos: number
  ncCount: number
  stepCount: number
  pdfCount: number
  hasPartList: boolean
}

export interface AuditResult {
  sourceName: string
  entriesTotal: number
  parts: PartRecord[]
  findings: Finding[]
  summary: AuditSummary
}
