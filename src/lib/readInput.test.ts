import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import {
  type DroppedInput,
  expandArchives,
  readDroppedInput,
  readFiles,
  snapshotDataTransfer,
} from './readInput'

const text = (s: string) => strToU8(s)
const paths = (entries: { path: string }[]) => entries.map((e) => e.path).sort()

describe('expandArchives', () => {
  it('surfaces files at every folder depth in one archive', async () => {
    const zip = zipSync({
      'NC files/a1.nc1': text('nc'),
      'STP files/nested/deep/a1.stp': text('stp'),
    })
    const out = await expandArchives([{ path: 'job.zip', bytes: zip }])
    expect(paths(out)).toEqual(['job/NC files/a1.nc1', 'job/STP files/nested/deep/a1.stp'])
  })

  it('recursively opens an archive nested inside an archive', async () => {
    const inner = zipSync({ 'NC files/a1.nc1': text('nc') })
    const outer = zipSync({ 'sub/job-inner.zip': inner, 'notes.txt': text('hi') })
    const out = await expandArchives([{ path: 'job.zip', bytes: outer }])
    expect(paths(out)).toEqual(['job/notes.txt', 'job/sub/job-inner/NC files/a1.nc1'])
  })

  it('does not expand an xlsx part list (a zip container)', async () => {
    const xlsx = zipSync({ 'xl/workbook.xml': text('<x/>') })
    const out = await expandArchives([{ path: 'part list.xlsx', bytes: xlsx }])
    expect(paths(out)).toEqual(['part list.xlsx'])
  })

  it('leaves ordinary files untouched', async () => {
    const out = await expandArchives([{ path: 'a1.nc1', bytes: text('nc') }])
    expect(paths(out)).toEqual(['a1.nc1'])
  })
})

function file(name: string, contents = 'nc'): File {
  return new File([contents], name)
}

function fileHandle(name: string, contents = 'nc'): FileSystemFileHandle {
  return {
    kind: 'file',
    name,
    getFile: async () => file(name, contents),
  } as unknown as FileSystemFileHandle
}

function dirHandle(name: string, children: FileSystemHandle[]): FileSystemDirectoryHandle {
  return {
    kind: 'directory',
    name,
    async *entries() {
      for (const child of children) yield [child.name, child] as const
    },
  } as unknown as FileSystemDirectoryHandle
}

function dataTransfer(items: Partial<DataTransferItem>[], files: File[] = []): DataTransfer {
  return {
    files,
    items: items as unknown as DataTransferItemList,
    getData: () => '',
  } as unknown as DataTransfer
}

describe('snapshotDataTransfer', () => {
  it('captures files and starts both entry and handle lookups synchronously', () => {
    const entry = { isFile: true, name: 'a.nc1' } as FileSystemEntry
    const handle = Promise.resolve(fileHandle('a.nc1'))
    const item = {
      kind: 'file',
      webkitGetAsEntry: () => entry,
      getAsFileSystemHandle: () => handle,
    }
    const snapshot = snapshotDataTransfer(dataTransfer([item], [file('a.nc1')]))
    expect(snapshot.files.map((f) => f.name)).toEqual(['a.nc1'])
    expect(snapshot.entries).toEqual([entry])
    expect(snapshot.handles).toEqual([handle])
  })

  it('ignores non-file items and items without a handle API', () => {
    const snapshot = snapshotDataTransfer(
      dataTransfer([{ kind: 'string' }, { kind: 'file' }], [file('a.nc1')]),
    )
    expect(snapshot.entries).toEqual([])
    expect(snapshot.handles).toEqual([])
    expect(snapshot.files.map((f) => f.name)).toEqual(['a.nc1'])
  })
})

describe('readDroppedInput', () => {
  const empty = (): DroppedInput => ({ files: [], entries: [], handles: [], uriList: [] })

  it('reads folder contents through modern file-system handles', async () => {
    const input: DroppedInput = {
      ...empty(),
      handles: [Promise.resolve(dirHandle('job', [fileHandle('a.nc1'), fileHandle('b.stp')]))],
    }
    const bundle = await readDroppedInput(input)
    expect(paths(bundle.entries)).toEqual(['job/a.nc1', 'job/b.stp'])
    expect(bundle.sourceName).toBe('job/ (2 files)')
  })

  it('falls back to webkit entries when handles are unavailable', async () => {
    const entry = {
      isFile: true,
      name: 'a.nc1',
      file: (ok: (f: File) => void) => ok(file('a.nc1')),
    } as unknown as FileSystemEntry
    const input: DroppedInput = { ...empty(), entries: [entry] }
    const bundle = await readDroppedInput(input)
    expect(paths(bundle.entries)).toEqual(['a.nc1'])
  })

  it('falls back to the file snapshot when shell handles and entries cannot resolve', async () => {
    // This is the Windows case: a dropped shell item reports an entry, but resolving it fails
    // ("the link does not really exist"). The synchronous `files` snapshot must still work.
    const entry = {
      isFile: true,
      name: 'a.nc1',
      file: (_ok: (f: File) => void, fail: () => void) => fail(),
    } as unknown as FileSystemEntry
    const input: DroppedInput = {
      ...empty(),
      entries: [entry],
      handles: [Promise.reject(new Error('NotFoundError'))],
      files: [file('a.nc1')],
    }
    const bundle = await readDroppedInput(input)
    expect(paths(bundle.entries)).toEqual(['a.nc1'])
    expect((await readFiles([file('a.nc1')])).entries.map((e) => e.path)).toEqual(['a.nc1'])
  })

  it('returns an empty bundle instead of throwing when nothing resolves', async () => {
    const bundle = await readDroppedInput(empty())
    expect(bundle.entries).toEqual([])
  })
})
