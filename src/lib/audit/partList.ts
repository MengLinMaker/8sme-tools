import type { PartListRow } from './schemas'
import type { AssemblyUsage } from './types'

export interface AggregatedPartList {
  /** One row per mark, with `qty` totalled across every assembly it appears in. */
  expected: Map<string, PartListRow>
  /** Per-mark assembly usage, in assembly-name order. */
  assemblies: Map<string, AssemblyUsage[]>
}

/**
 * Collapses an assembly part list into one row per part. A part listed under several
 * assemblies is summed (`qty × assemblyQty` in each), so the total can be held against the
 * NC quantity. Plain part lists (no assembly column) keep their quantities as-is.
 */
export function aggregatePartList(rows: PartListRow[]): AggregatedPartList {
  const groups = new Map<string, PartListRow[]>()
  for (const row of rows) {
    const part = row.part.trim()
    if (!part) continue
    const key = part.toLowerCase()
    const group = groups.get(key)
    if (group) group.push(row)
    else groups.set(key, [row])
  }

  const expected = new Map<string, PartListRow>()
  const assemblies = new Map<string, AssemblyUsage[]>()
  for (const [key, group] of groups) {
    const first = group[0]
    if (!first) continue
    if (!group.some((row) => row.assembly)) {
      expected.set(key, { ...first })
      continue
    }

    let totalQty: number | null = null
    const usage = new Map<string, AssemblyUsage>()
    for (const row of group) {
      if (row.qty === null) continue
      const assemblyQty = row.assemblyQty ?? 1
      const total = row.qty * assemblyQty
      totalQty = (totalQty ?? 0) + total
      if (!row.assembly) continue
      const existing = usage.get(row.assembly)
      if (existing) {
        existing.qtyPerAssembly += row.qty
        existing.total += total
      } else {
        usage.set(row.assembly, {
          assembly: row.assembly,
          assemblyQty,
          qtyPerAssembly: row.qty,
          total,
        })
      }
    }

    expected.set(key, {
      ...first,
      assembly: undefined,
      assemblyQty: undefined,
      qty: totalQty,
    })
    if (usage.size > 0) {
      assemblies.set(
        key,
        [...usage.values()].sort((a, b) => a.assembly.localeCompare(b.assembly)),
      )
    }
  }

  return { expected, assemblies }
}
