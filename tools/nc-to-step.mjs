#!/usr/bin/env node
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { createServer } from 'vite'

const require = createRequire(import.meta.url)

const HELP = `
Rebuild a STEP from DSTV NC (.nc1 / .nc).

Usage:
  pnpm nc-to-step -i <file.nc1|directory> [-o <file.stp|directory>]

  -i, --input     .nc1/.nc file or a directory of them
  -o, --output    output .stp file (single input) or directory (default: step-out)
  -h, --help

Uses the same NC→solid reconstruction as the viewer. Overlapping holes are cut sequentially
because OCC crashes when they are batched into one boolean compound.
`

const { values } = parseArgs({
  options: {
    input: { type: 'string', short: 'i' },
    output: { type: 'string', short: 'o' },
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
const outArg = values.output ? resolve(values.output) : resolve('step-out')
const outIsFile = !isDir && /\.(?:stp|step)$/i.test(outArg)
const outDir = outIsFile ? dirname(outArg) : outArg

async function ncFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && /\.nc1?$/i.test(entry.name))
    .map((entry) => join(dir, entry.name))
    .sort()
}
const files = isDir ? await ncFiles(input) : [input]
if (files.length === 0) throw new Error(`no .nc1/.nc files in ${input}`)

const server = await createServer({
  configFile: false,
  appType: 'custom',
  logLevel: 'error',
  server: { middlewareMode: true },
  resolve: { alias: { '@': resolve('src') } },
})

try {
  const { setOcWasmUrl } = await server.ssrLoadModule('/src/lib/step/occInit.ts')
  const { reconstructStepFromNc } = await server.ssrLoadModule('/src/lib/step/reconstructFromNc.ts')
  setOcWasmUrl(require.resolve('replicad-opencascadejs/wasm'))
  await mkdir(outDir, { recursive: true })

  for (const file of files) {
    const stem = basename(file, extname(file))
    const output = outIsFile ? outArg : join(outDir, `${stem}.stp`)
    const nc = await readFile(file, 'utf8')
    const step = await reconstructStepFromNc(nc)
    if (!step) {
      console.error(`FAIL ${basename(file)}  could not rebuild solid`)
      process.exitCode = 1
      continue
    }
    await writeFile(output, step)
    console.log(`OK   ${basename(file)} -> ${output}`)
  }
} finally {
  await server.close()
}
