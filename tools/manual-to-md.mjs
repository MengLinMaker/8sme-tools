#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { parseArgs, promisify } from 'node:util'

const run = promisify(execFile)

const HELP = `
Convert a Weihong (维宏) manual PDF into a page-marked Markdown file.

Usage:
  node tools/manual-to-md.mjs -i <manual.pdf> -o <out.md> [options]

  -i, --input     source PDF
  -o, --output    output .md
      --title     document title (default: PDF basename)
      --issuer    publisher / author line
      --version   edition line (e.g. "2026-01-09 第 1 版")
      --source    canonical download URL
      --keep-pdf  also copy the PDF next to the .md
  -h, --help

Text only: figures and screenshots in the PDF are not carried across. Page numbers in the
source are kept as <!-- p.N --> markers so doc citations (§5.1, p.42) stay checkable.
Requires poppler's pdftotext on PATH.
`

const { values } = parseArgs({
  options: {
    input: { type: 'string', short: 'i' },
    output: { type: 'string', short: 'o' },
    title: { type: 'string' },
    issuer: { type: 'string' },
    version: { type: 'string' },
    source: { type: 'string' },
    'keep-pdf': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
})
if (values.help || !values.input || !values.output) {
  process.stdout.write(HELP)
  process.exit(values.help ? 0 : 2)
}

const input = resolve(values.input)
const output = resolve(values.output)

const pdf = await readFile(input)
const sha256 = createHash('sha256').update(pdf).digest('hex')

const work = await mkdtemp(join(tmpdir(), 'manual-md-'))
let raw
try {
  await run('pdftotext', ['-layout', input, join(work, 'raw.txt')])
  raw = await readFile(join(work, 'raw.txt'), 'utf8')
} finally {
  await rm(work, { recursive: true, force: true })
}

// Repeated running header on every page of the Weihong manuals.
const HEADER = [
  /^\s*上海维宏电子科技股份有限公司\s*$/,
  /^\s*SHANGHAI WEIHONG ELECTRONIC TECHNOLOGY CO\.,? LTD\.\s*$/,
]
// Standalone "12 / 304" style folio.
const FOLIO = /^\s*\d{1,3}\s*\/\s*\d{1,3}\s*$/

function cleanPage(page) {
  const lines = page.split('\n').map((line) => line.replace(/\s+$/, ''))
  const kept = lines.filter((line) => !HEADER.some((re) => re.test(line)) && !FOLIO.test(line))
  // Collapse the runs of blank lines left behind by the stripped header.
  const out = []
  for (const line of kept) {
    if (line === '' && out.at(-1) === '') continue
    out.push(line)
  }
  while (out.length && out[0] === '') out.shift()
  while (out.length && out.at(-1) === '') out.pop()
  return out.join('\n')
}

const pages = raw.split('\f')
if (pages.at(-1)?.trim() === '') pages.pop()

const body = pages
  .map((page, i) => {
    const text = cleanPage(page)
    return text ? `<!-- p.${i + 1} -->\n\n${text}` : `<!-- p.${i + 1} -->`
  })
  .join('\n\n')

const title = values.title ?? basename(input, '.pdf')
const front = [
  `# ${title}`,
  '',
  '> 中文原版说明书，机器可读文本转写（**不含图/截图**）。原 PDF 以 `--source` 为准，',
  '> 版次不符时按原 PDF 重抓。每页开头以 HTML 注释（`p.N`）标记页码，对应原 PDF 页，便于引用。',
  '',
  '| | |',
  '| --- | --- |',
  `| 文档 | ${title} |`,
  values.version ? `| 版次 | ${values.version} |` : null,
  values.issuer ? `| 发布 | ${values.issuer} |` : null,
  `| 页数 | ${pages.length} |`,
  values.source ? `| 来源 | ${values.source} |` : null,
  `| PDF SHA-256 | \`${sha256}\` |`,
  '| 抽取 | text layer only（`pdftotext -layout`），图未保留 |',
  '',
  '---',
  '',
].filter((line) => line !== null)

await mkdir(dirname(output), { recursive: true })
await writeFile(output, `${front.join('\n')}\n${body}\n`)
if (values['keep-pdf']) {
  await writeFile(join(dirname(output), basename(input)), pdf)
}

process.stdout.write(
  `${output}\n  ${pages.length} pages, ${(body.length / 1024).toFixed(0)} KB text\n`,
)
