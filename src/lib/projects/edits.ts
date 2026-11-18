import type { Finding } from '@/lib/audit/schemas'
import { EDIT_STORE, finished, openDatabase, projectRange, result } from './db'

/** One NC edit applied by a finding — an op the NC writer can replay. */
export type NcOp =
  | { key: string; kind: 'unifyBevel'; contourIndex: number; vertices: number[]; angle: number }
  | { key: string; kind: 'outOfRangeBevel'; contourIndex: number; vertex: number; angle: number }
  | { key: string; kind: 'removeCut'; contourIndex: number; removeVertices: [number, number] }
  | { key: string; kind: 'moveCut'; contourIndex: number; vertices: number[]; deltaY: number }

/** How a part's STEP geometry was replaced. */
export type StepFixKind = 'cleaned' | 'tabbed' | 'regenerated' | 'simplified' | 'repaired'

/** A STEP replacement, already in the canonical frame when it came from the NC. */
export interface StepOverride {
  bytes: Uint8Array
  kind: StepFixKind
  /** Bytes are already canonical (NC-derived); skip export re-seating. */
  seated?: boolean
}

/** A part's NC with its edits applied, plus the ops that produced it. */
export interface NcOverride {
  bytes: Uint8Array
  ops: NcOp[]
}

/** Everything saved for one part of a project. */
export interface ProjectEdit {
  nc?: NcOverride
  step?: StepOverride
  /** Fixed findings kept as resolved rows, so the list still offers Undo after a reopen. */
  resolved?: Finding[]
}

export type ProjectEdits = Map<string, ProjectEdit>

/**
 * The fixes applied to a project's parts, saved with the project.
 *
 * The NC bytes are kept as well as the ops: they are kilobytes, and replaying ops on open would
 * have to guard against a file that changed underneath them. A STEP override is megabytes but is
 * already the finished replacement, so it is stored as-is rather than rebuilt on every reopen.
 */
export async function loadProjectEdits(id: string): Promise<ProjectEdits> {
  const db = await openDatabase()
  const tx = db.transaction(EDIT_STORE, 'readonly')
  const rows = (await result(tx.objectStore(EDIT_STORE).getAll(projectRange(id)))) as Array<{
    mark: string
    edit: ProjectEdit
  }>
  await finished(tx)
  return new Map(rows.map((row) => [row.mark, row.edit]))
}

/** Writes one part's edit, or removes it when nothing is left. */
export async function saveProjectEdit(
  id: string,
  mark: string,
  edit: ProjectEdit | null,
): Promise<void> {
  const db = await openDatabase()
  const tx = db.transaction(EDIT_STORE, 'readwrite')
  const store = tx.objectStore(EDIT_STORE)
  if (edit) store.put({ mark, edit }, [id, mark])
  else store.delete([id, mark])
  await finished(tx)
}

/** Removes every saved edit for a project. */
export async function clearProjectEdits(id: string): Promise<void> {
  const db = await openDatabase()
  const tx = db.transaction(EDIT_STORE, 'readwrite')
  tx.objectStore(EDIT_STORE).delete(projectRange(id))
  await finished(tx)
}
