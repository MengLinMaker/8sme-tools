import { isZip, readZip, type ZipEntry } from './zip'

export interface InputBundle {
  sourceName: string
  entries: ZipEntry[]
}

export async function readFilesToEntries(files: File[]): Promise<InputBundle> {
  const entries: ZipEntry[] = []
  const names: string[] = []

  for (const file of files) {
    names.push(file.name)
    const bytes = new Uint8Array(await file.arrayBuffer())
    if (isZip(bytes)) entries.push(...readZip(bytes))
    else entries.push({ path: file.name, bytes })
  }

  const sourceName = names.length === 1 ? names[0] : `${names.length} files`
  return { sourceName, entries }
}
