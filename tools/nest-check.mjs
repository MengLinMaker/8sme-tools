#!/usr/bin/env node
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { createServer } from 'vite'

const HELP = `
Check that a WiseCAM nesting's quantities match (and optionally that a set of
nestings covers the job).

Usage:
  pnpm nest-check -i <file.ncexa|directory> [--job <job.ncexa>]
                  [--all] [--json] [--strict]

  -i, --input   .ncexa/.ncex file or a directory (searched recursively)
      --job     reference job package; its Part.TotalCount values are the
                required quantities for the "job totals" section
      --all     list passing packages too
      --json    print the report as JSON
      --strict  exit non-zero on warnings as well as errors
  -h, --help

What is compared, per package:
  required  Part.TotalCount
  nested    sum of Result.PartInfo count x Result.params.Count
  declared  Part.NestedCount
  drawn     placed cadpart instances in CAD/<result>_0.svg (per bar)

Exit code: 0 when every package matches, 1 when a quantity is short/excess or
the package is inconsistent.
`

const { values } = parseArgs({
  options: {
    input: { type: 'string', short: 'i' },
    job: { type: 'string' },
    all: { type: 'boolean' },
    json: { type: 'boolean' },
    strict: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
})

if (values.help || !values.input) {
  process.stdout.write(HELP)
  process.exit(values.help ? 0 : 2)
}

const input = resolve(values.input)
const inputStat = await stat(input)

async function collect(dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await collect(path)))
    else if (/\.ncex(a)?$/i.test(entry.name)) out.push(path)
  }
  return out
}

const files = inputStat.isDirectory() ? (await collect(input)).sort() : [input]
if (files.length === 0) throw new Error(`no .ncexa/.ncex files in ${input}`)
if (!/\.ncex(a)?$/i.test(files[0])) throw new Error(`not a .ncexa/.ncex file: ${files[0]}`)

const server = await createServer({
  configFile: false,
  appType: 'custom',
  logLevel: 'error',
  server: { middlewareMode: true },
  resolve: { alias: { '@': resolve('src') } },
})

const display = (path) => relative(process.cwd(), path) || basename(path)

let report
try {
  const { parseNexPackage } = await server.ssrLoadModule('/src/lib/wisecam/ncexParse.ts')
  const { checkNestSet, nestReference } = await server.ssrLoadModule(
    '/src/lib/wisecam/nestCheck.ts',
  )

  const packages = []
  for (const file of files) {
    packages.push({
      file: display(file),
      package: parseNexPackage(new Uint8Array(await readFile(file))),
    })
  }

  let reference = null
  if (values.job) {
    const jobPath = resolve(values.job)
    const pkg = parseNexPackage(new Uint8Array(await readFile(jobPath)))
    reference = nestReference(pkg, display(jobPath))
  }

  report = checkNestSet(packages, reference)
} finally {
  await server.close()
}

function compact(check) {
  return {
    file: check.file,
    summary: check.summary,
    rows: check.rows,
    findings: check.findings,
  }
}

if (values.json) {
  process.stdout.write(
    `${JSON.stringify(
      {
        files: report.files.map(compact),
        aggregate: report.aggregate,
        findings: report.findings,
        summary: report.summary,
      },
      null,
      2,
    )}\n`,
  )
} else {
  console.log('Nest quantity check')
  console.log('')
  for (const check of report.files) {
    const { summary } = check
    if (check.ok && summary.warnings === 0) {
      if (values.all) {
        console.log(
          `PASS  ${check.file}  (${summary.parts} parts, ${summary.results} results, ${summary.nested} pieces)`,
        )
      }
      continue
    }
    const label = check.ok ? 'WARN' : 'FAIL'
    console.log(
      `${label}  ${check.file}  (${summary.parts} parts, ${summary.results} results, ${summary.nested} pieces)`,
    )
    for (const finding of check.findings) {
      const prefix = finding.severity === 'error' ? '  ✗' : '  !'
      console.log(`${prefix} ${finding.message}`)
    }
  }

  if (report.aggregate.length > 0 && values.job) {
    console.log('')
    console.log(
      `Job totals (${report.summary.distinctResults} distinct result(s); ` +
        'every distinct nest in the input is summed, so alternative attempts show as over)',
    )
    for (const row of report.aggregate) {
      if (row.required == null || row.delta == null) continue
      const tag = row.delta < 0 ? 'short' : row.delta > 0 ? 'over ' : 'ok   '
      const delta = row.delta === 0 ? '' : ` (${row.delta > 0 ? '+' : ''}${row.delta})`
      console.log(`  ${tag} ${row.mark.padEnd(24)} ${row.nested}/${row.required}${delta}`)
    }
    const unknown = report.aggregate.filter((row) => row.required == null)
    if (unknown.length > 0) {
      console.log('')
      console.log('  Nested but not in the job package:')
      for (const row of unknown) console.log(`    ? ${row.mark} (${row.nested})`)
    }
  }

  const duplicateFindings = report.findings.filter(
    (finding) => finding.code === 'duplicate-result' || finding.code === 'conflicting-result',
  )
  if (duplicateFindings.length > 0) {
    console.log('')
    for (const finding of duplicateFindings) console.log(`  ! ${finding.message}`)
  }

  const declarationFindings = report.findings.filter(
    (finding) => finding.code === 'required-mismatch',
  )
  if (declarationFindings.length > 0) {
    console.log('')
    console.log('Quantity declarations that differ:')
    for (const finding of declarationFindings) console.log(`  ! ${finding.message}`)
  }

  console.log('')
  const clean = report.files.filter((check) => check.ok && check.summary.warnings === 0).length
  console.log(
    `${clean}/${report.summary.files} package(s) clean; ` +
      `${report.summary.errors} error(s), ${report.summary.warnings} warning(s), ` +
      `${report.summary.duplicateResults} duplicate result(s)`,
  )
}

process.exitCode =
  report.summary.errors > 0 || (values.strict === true && report.summary.warnings > 0) ? 1 : 0
