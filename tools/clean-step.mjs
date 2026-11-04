#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { createServer } from 'vite'

const HELP = `
Remove stray bodies from a STEP file, keeping the main (largest) body.

Usage:
  pnpm clean-step -i <file.stp|file.step> [-o <file.stp>] [--json]

  -i, --input     STEP file to clean
  -o, --output    output path (default: <input>.clean.stp beside the input)
      --json      print the report as JSON
  -h, --help

The main body keeps all its holes, curves and mitres; every other solid (a floating sliver;
a bolt/fitting left over from the Tekla assembly) is dropped.
`

const { values } = parseArgs({
  options: {
    input: { type: 'string', short: 'i' },
    output: { type: 'string', short: 'o' },
    json: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
})

if (values.help || !values.input) {
  process.stdout.write(HELP)
  process.exit(values.help ? 0 : 2)
}

const input = resolve(values.input)
const ext = extname(input)
const output = values.output
  ? resolve(values.output)
  : join(dirname(input), `${basename(input, ext)}.clean${ext || '.stp'}`)

const server = await createServer({
  configFile: false,
  appType: 'custom',
  logLevel: 'error',
  server: { middlewareMode: true },
  resolve: { alias: { '@': resolve('src') } },
})

let report
try {
  const { setOcWasmUrl } = await server.ssrLoadModule('/src/lib/step/occInit.ts')
  const require = createRequire(join(resolve('.'), 'package.json'))
  setOcWasmUrl(require.resolve('replicad-opencascadejs/wasm'))

  const { cleanStep } = await server.ssrLoadModule('/src/lib/step/clean.ts')
  const bytes = new Uint8Array(await readFile(input))
  const result = await cleanStep(bytes)

  if (!result) {
    report = { input, output: null, ok: true, kept: 1, removed: 0, opened: 0, bytes: null }
    if (!values.json) console.log(`${basename(input)} has no stray bodies — nothing to do.`)
  } else {
    await writeFile(output, result.bytes)
    report = {
      input,
      output,
      ok: true,
      kept: result.kept,
      removed: result.removed,
      opened: result.opened,
      bytes: result.bytes.length,
    }
    if (!values.json) {
      console.log(
        `${basename(input)} -> ${basename(output)}  kept ${result.kept}  removed ${result.removed}  opened ${result.opened} hole(s)  ${result.bytes.length} B`,
      )
    }
  }
} catch (cause) {
  const error = cause instanceof Error ? cause.message : String(cause)
  report = { input, output: null, ok: false, error }
  if (!values.json) console.error(`FAIL ${basename(input)}  ${error}`)
  process.exitCode = 1
} finally {
  await server.close()
}

if (values.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
