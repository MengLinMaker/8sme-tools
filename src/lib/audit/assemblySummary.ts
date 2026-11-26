import type { PartListRow } from './schemas'
import { markKey } from './stepNames'
import type { AssemblyUsage } from './types'

/**
 * One assembly as the shop floor reads it: the kit of marks it needs, and whether that kit is
 * complete. The grouping is the assembly part list's, not a guess — `auditJob` hands the same rows
 * to `aggregatePartList`, so the card and the parts table can never disagree about membership.
 */

/** A part's status, as the parts table shows it (see `statusForPart`). */
export type AssemblyMemberStatus = 'error' | 'warning' | 'info' | 'ok'

export interface AssemblyPartInput {
  mark: string
  /** Section label for the kit line (the parts table's PROFILE cell). */
  profile: string
  /** Per-piece length in mm, when known. */
  lengthMm: number | null
  /** Per-piece mass in kg, when known. */
  massKg: number | null
  status: AssemblyMemberStatus
  assemblies: AssemblyUsage[]
}

export interface AssemblyMember {
  mark: string
  profile: string
  lengthMm: number | null
  massKg: number | null
  /** Pieces of this mark in one assembly. */
  qtyPerAssembly: number
  /** Pieces of this mark across the whole job. */
  total: number
  /** The mark's finding status; a missing member is a warning (`PART_LIST_NO_FILES`). */
  status: AssemblyMemberStatus
  /** False when the assembly part list names the mark but no NC or STEP arrived for it. */
  present: boolean
}

export interface AssemblyGroup {
  assembly: string
  /** Copies of this assembly the job makes (the largest row quantity, if rows disagree). */
  assemblyQty: number
  members: AssemblyMember[]
  /** Distinct marks in the kit. */
  marks: number
  /** Pieces in one assembly (the sum of every member's per-assembly quantity). */
  piecesPerAssembly: number
  /** Pieces across the job. */
  pieces: number
  /** Cumulative length across the job, mm (only where every member's length is known). */
  lengthMm: number
  /** Cumulative mass across the job, kg (only where every member's mass is known). */
  massKg: number
  /** Members carrying an error finding. */
  errors: number
  /** Members carrying a warning finding, including the missing ones. */
  warnings: number
  /** Marks listed by the assembly with no NC or STEP file to make them from. */
  missing: number
  /** The assembly sheet's file path, when the job ships a drawing under the assembly mark. */
  drawingPath: string | null
}

interface GroupDraft {
  assembly: string
  assemblyQty: number
  members: Map<string, AssemblyMember>
}

/** Numeric-aware, so `B2` sorts before `B10` like the parts table and the assembly filter. */
const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true })

/**
 * Collapses the parts and the assembly part list into one row per assembly.
 *
 * A mark the part list names but that has no NC/STEP still appears (`present: false`): a kit that
 * is missing a piece must not read as complete just because the file never arrived.
 */
export function summarizeAssemblies(
  parts: AssemblyPartInput[],
  partList: PartListRow[] = [],
  /** assembly mark key → drawing path, from the audit's document index. */
  documents: ReadonlyMap<string, string> = new Map(),
): AssemblyGroup[] {
  const drafts = new Map<string, GroupDraft>()
  const partKeys = new Set(parts.map((part) => markKey(part.mark)))

  const draftFor = (assembly: string): GroupDraft => {
    let draft = drafts.get(assembly)
    if (!draft) {
      draft = { assembly, assemblyQty: 1, members: new Map() }
      drafts.set(assembly, draft)
    }
    return draft
  }

  for (const part of parts) {
    const key = markKey(part.mark)
    for (const usage of part.assemblies) {
      const assembly = usage.assembly.trim()
      if (!assembly) continue
      const draft = draftFor(assembly)
      if (draft.members.has(key)) continue
      draft.assemblyQty = Math.max(draft.assemblyQty, usage.assemblyQty)
      draft.members.set(key, {
        mark: part.mark,
        profile: part.profile,
        lengthMm: part.lengthMm,
        massKg: part.massKg,
        qtyPerAssembly: usage.qtyPerAssembly,
        total: usage.total,
        status: part.status,
        present: true,
      })
    }
  }

  for (const row of partList) {
    const assembly = row.assembly?.trim()
    if (!assembly) continue
    const name = row.part.trim()
    if (!name) continue
    const key = markKey(name)
    // A part that arrived owns its own kit line, whatever its row says; only unclaimed marks are
    // added from the list, so nothing is ever counted twice.
    if (partKeys.has(key)) continue

    const draft = draftFor(assembly)
    const existing = draft.members.get(key)
    const qty = row.qty ?? 0
    draft.assemblyQty = Math.max(draft.assemblyQty, row.assemblyQty ?? 1)
    if (existing) {
      existing.qtyPerAssembly += qty
      continue
    }
    draft.members.set(key, {
      mark: name,
      profile: row.profile || '—',
      lengthMm: row.length,
      massKg: row.weight,
      qtyPerAssembly: qty,
      total: 0,
      status: 'warning',
      present: false,
    })
  }

  const groups: AssemblyGroup[] = []
  for (const draft of drafts.values()) {
    const members = [...draft.members.values()].map((member) =>
      // A missing member's total comes from the assembly quantity; a present one keeps the part
      // list's own total, which is what the parts table shows.
      member.present ? member : { ...member, total: member.qtyPerAssembly * draft.assemblyQty },
    )
    members.sort((a, b) => byName(a.mark, b.mark))

    let lengthMm = 0
    let massKg = 0
    for (const member of members) {
      if (member.lengthMm != null) lengthMm += member.lengthMm * member.total
      if (member.massKg != null) massKg += member.massKg * member.total
    }

    groups.push({
      assembly: draft.assembly,
      assemblyQty: draft.assemblyQty,
      members,
      marks: members.length,
      piecesPerAssembly: members.reduce((sum, member) => sum + member.qtyPerAssembly, 0),
      pieces: members.reduce((sum, member) => sum + member.total, 0),
      lengthMm,
      massKg,
      errors: members.filter((member) => member.status === 'error').length,
      warnings: members.filter((member) => member.status === 'warning').length,
      missing: members.filter((member) => !member.present).length,
      drawingPath: documents.get(markKey(draft.assembly)) ?? null,
    })
  }

  return groups.sort((a, b) => byName(a.assembly, b.assembly))
}
