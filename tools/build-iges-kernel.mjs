#!/usr/bin/env node
/**
 * Build an IGES-enabled OpenCASCADE kernel for the converter tab.
 *
 * The published `replicad-opencascadejs` build only compiles the STEP/STL translators. The OCCT
 * IGES translator is open source, but it is not in that build, so we link a custom build against
 * the same OCCT version and copy the three artefacts over the installed package. Everything else
 * in the app keeps using the same kernel, and `getOC().IGESControl_Reader` becomes available.
 *
 * This is a **one-time developer step** (Docker + the prebuilt OCCT image). The generated wasm is
 * not committed; run it after a fresh install or whenever `replicad-opencascadejs` is upgraded.
 *
 * Usage:
 *   pnpm build-iges-kernel [--image <docker image>] [--force]
 */

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageDir = dirname(require.resolve('replicad-opencascadejs/package.json'))
const distDir = join(packageDir, 'dist')

const HELP = `
Build the IGES-enabled OCCT kernel used by the converter tab.

Usage:
  pnpm build-iges-kernel [--image <docker image>] [--force]

  --image   opencascade.js link image (default: the one matching the installed build)
  --force   rebuild even when the installed wasm already has IGES
  -h, --help
`

const { values } = parseArgs({
  options: {
    image: { type: 'string' },
    force: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
})
if (values.help) {
  process.stdout.write(HELP)
  process.exit(0)
}

const installedWasm = join(distDir, 'replicad_single.wasm')
const installedVersion = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')).version

/** Does the installed wasm already expose the IGES reader symbol? */
function wasmHasIges(path) {
  if (!existsSync(path)) return false
  const bytes = readFileSync(path)
  return bytes.includes(Buffer.from('IGESControl_Reader', 'utf8'))
}

if (!values.force && wasmHasIges(installedWasm)) {
  process.stdout.write(
    `The installed kernel already has IGES (replicad-opencascadejs ${installedVersion}). Use --force to rebuild.\n`,
  )
  process.exit(0)
}

if (!existsSync(join(root, 'tools/occt-iges/custom_build_iges.yml'))) {
  process.stderr.write('Missing tools/occt-iges/custom_build_iges.yml.\n')
  process.exit(1)
}

// The published 1.1.0 build used this image; 1.2.x uses 3.1.0. Keep the mapping explicit so an
// upgrade is a deliberate choice rather than a silently mismatched glue/wasm pair.
const image =
  values.image ??
  (installedVersion.startsWith('1.1')
    ? 'ghcr.io/taucad/opencascade.js:canary-ebd263f1-single-threaded'
    : 'ghcr.io/taucad/opencascade.js:3.1.0-single-threaded')

try {
  execFileSync('docker', ['info'], { stdio: 'ignore' })
} catch {
  process.stderr.write(
    'Docker is not running. Start Docker Desktop (or another daemon) and run this command again.\n',
  )
  process.exit(1)
}

const work = join(root, 'node_modules/.cache/occt-iges')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
cpSync(join(root, 'tools/occt-iges/custom_build_iges.yml'), join(work, 'custom_build_iges.yml'))
cpSync(join(root, 'tools/occt-iges/wrappers'), join(work, 'wrappers'), { recursive: true })

const uid = process.getuid?.()
const gid = process.getgid?.()
const args = [
  'run',
  '--rm',
  '--platform',
  'linux/amd64',
  '-v',
  `${work}:/src`,
  ...(uid != null && gid != null ? ['-u', `${uid}:${gid}`] : []),
  image,
  'link',
  'custom_build_iges.yml',
]

process.stdout.write(`Linking OCCT bindings with IGES (${image})…\n`)
try {
  execFileSync('docker', args, { cwd: work, stdio: 'inherit' })
} catch (error) {
  process.stderr.write(
    `The link step failed. The image is amd64; on Apple Silicon make sure Docker can emulate it.\n${
      error instanceof Error ? error.message : String(error)
    }\n`,
  )
  process.exit(1)
}

const builtWasm = join(work, 'replicad_single.wasm')
const builtJs = join(work, 'replicad_single.js')
const builtTypes = join(work, 'replicad_single.d.ts')
for (const file of [builtWasm, builtJs, builtTypes]) {
  if (!existsSync(file)) {
    process.stderr.write(`The build did not produce ${file}.\n`)
    process.exit(1)
  }
}
if (!wasmHasIges(builtWasm)) {
  process.stderr.write(
    'The built wasm does not contain IGESControl_Reader — check the bindings list in tools/occt-iges/custom_build_iges.yml.\n',
  )
  process.exit(1)
}

cpSync(builtWasm, installedWasm)
cpSync(builtJs, join(distDir, 'replicad_single.js'))
cpSync(builtTypes, join(distDir, 'replicad_single.d.ts'))

const mb = (statSync(installedWasm).size / 1024 / 1024).toFixed(1)
process.stdout.write(
  [
    `Installed the IGES-enabled kernel (${mb} MB) into ${distDir}.`,
    'Restart the dev server (or run `pnpm build`) so the new wasm is bundled.',
    'The converter tab now translates IGES with the real B-rep (curves preserved).',
  ].join('\n') + '\n',
)
