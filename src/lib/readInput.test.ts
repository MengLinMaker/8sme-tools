import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { expandArchives } from './readInput'

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
