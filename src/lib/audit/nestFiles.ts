import type { ZipEntry } from '@/lib/zip'

/**
 * Nesting exports (`.ncexa` / `.ncex`) are counted in the Nesting counts tab. They are deliberately
 * not stored in a preflight project: a real nest package is hundreds of KB to several MB, and the
 * project already carries the NC/STEP/PDF ground truth.
 */
export const NEST_FILE = /\.ncex(a)?$/i

export function isNestFile(path: string): boolean {
  return NEST_FILE.test(path)
}

export function withoutNestFiles(entries: ZipEntry[]): ZipEntry[] {
  return entries.filter((entry) => !NEST_FILE.test(entry.path))
}
