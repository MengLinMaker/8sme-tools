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

/** One assembly a part is used in, and the quantities the assembly part list gives it. */
export interface AssemblyUsage {
  assembly: string
  /** How many copies of the assembly the job makes. */
  assemblyQty: number
  /** How many of this part go into one assembly. */
  qtyPerAssembly: number
  /** `qtyPerAssembly × assemblyQty` across the job. */
  total: number
}

export interface PartRecord {
  mark: string
  nc?: NcFile
  step?: StepFile
  pdf?: PdfFile
  expected?: PartListRow
  /** Assemblies this part is used in, when the job ships an assembly part list. */
  assemblies?: AssemblyUsage[]
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
