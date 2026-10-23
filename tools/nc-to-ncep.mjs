#!/usr/bin/env node
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { createServer } from 'vite'

const HELP = `
Convert DSTV NC (${'.nc1'} / .nc) to a WiseCAM .ncep package.

Usage:
  pnpm nc-to-ncep -i <file.nc1|directory> [-o <file.ncep|directory>]
                  [-m <mark>] [-s <suffix>] [--stock <mm>] [--json]

  -i, --input     .nc1/.nc file or a directory of them
  -o, --output    output .ncep file (single input) or directory
  -m, --mark      part mark/name (single input; default: file stem)
  -s, --suffix    appended to the mark, e.g. --suffix=-A -> M-1-A (use for repeated probes)
      --stock     adobe stock length in mm (default: 3000)
      --json      print the report as JSON
  -h, --help

Supported profiles today: I (UB/WB/UC/WC), U (PFC), M (RHS/SHS).
T, angle and round profiles return "unsupported" until they have a real NCEP sample.
`

const { values } = parseArgs({
  options: {
    input: { type: 'string', short: 'i' },
    output: { type: 'string', short: 'o' },
    mark: { type: 'string', short: 'm' },
    suffix: { type: 'string', short: 's' },
    stock: { type: 'string' },
    json: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
})

if (values.help || !values.input) {
  process.stdout.write(HELP)
  process.exit(values.help ? 0 : 2)
}

const input = resolve(values.input)
const inputStat = await stat(input)
const isDir = inputStat.isDirectory()
const outArg = values.output ? resolve(values.output) : resolve('ncep-out')
const outIsFile = !isDir && /\.ncep$/i.test(outArg)
const outDir = outIsFile ? dirname(outArg) : outArg
const stockLength = values.stock == null ? undefined : Number(values.stock)
if (stockLength != null && !(Number.isFinite(stockLength) && stockLength > 0)) {
  throw new Error(`--stock must be a positive number, got ${values.stock}`)
}

function ncFiles(dir) {
  return readdir(dir, { withFileTypes: true }).then((entries) =>
    entries
      .filter((entry) => entry.isFile() && /\.nc1?$/i.test(entry.name))
      .map((entry) => join(dir, entry.name))
      .sort(),
  )
}

const files = isDir ? await ncFiles(input) : [input]
if (files.length === 0) throw new Error(`no .nc1/.nc files in ${input}`)
if (values.mark && files.length > 1) throw new Error('--mark only works with one input file')

const server = await createServer({
  configFile: false,
  appType: 'custom',
  logLevel: 'error',
  server: { middlewareMode: true },
  resolve: { alias: { '@': resolve('src') } },
})

const report = []
try {
  const { buildNcepFromNc, partFromNc } = await server.ssrLoadModule('/src/lib/wisecam/fromNc.ts')
  await mkdir(outDir, { recursive: true })

  for (const file of files) {
    const stem = basename(file, extname(file))
    const mark = `${values.mark ?? stem}${values.suffix ?? ''}`
    const text = await readFile(file, 'utf8')
    const options = stockLength == null ? { mark } : { mark, stockLength }
    let part = null
    let bytes = null
    let error = null
    try {
      part = partFromNc(text, options)
      bytes = buildNcepFromNc(text, options)
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
    }
    if (!bytes) {
      const entry = {
        input: file,
        mark,
        ok: false,
        error: error ?? `unsupported profile${part ? ` ${part.profileType}` : ''}`,
      }
      report.push(entry)
      if (!values.json) console.error(`FAIL ${basename(file)}  ${entry.error}`)
      continue
    }
    const output = outIsFile ? outArg : join(outDir, `${mark}.ncep`)
    await writeFile(output, bytes)
    const entry = {
      input: file,
      output,
      mark,
      ok: true,
      profile: part?.profile ?? null,
      profileType: part?.profileType ?? null,
      length: part?.length ?? null,
      quantity: part?.quantity ?? null,
      sectionPaths: part?.innerSection ? 2 : 1,
      sectionVertices: part?.section.length ?? 0,
      innerVertices: part?.innerSection?.length ?? 0,
      holes: part?.holes?.length ?? 0,
      marks: part?.marks?.length ?? 0,
      unrolledPerimeter: part?.unrolledPerimeter ?? null,
      bytes: bytes.length,
    }
    report.push(entry)
    if (!values.json) {
      console.log(
        `${basename(file)} -> ${basename(output)}  ${entry.profileType ?? '?'} ${entry.profile ?? '?'}  ` +
          `${entry.length ?? '?'}mm  ${entry.sectionPaths} path(s)  ${entry.holes} hole(s)  ${entry.bytes} B`,
      )
    }
  }
} finally {
  await server.close()
}

const failed = report.filter((entry) => !entry.ok)
await writeFile(join(outDir, 'conversion-report.json'), `${JSON.stringify(report, null, 2)}\n`)
if (values.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
else
  console.log(
    `\n${report.length - failed.length}/${report.length} converted; report: ${join(outDir, 'conversion-report.json')}`,
  )
if (failed.length > 0) process.exitCode = 1
