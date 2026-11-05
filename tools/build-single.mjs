#!/usr/bin/env node
/**
 * Build the portable, single-file version of 8SME Tools.
 *
 * Output: dist-single/8sme-tools.html — one HTML file with every script, style, wasm kernel,
 * font and worker embedded. It can be opened directly from disk (file://) with no server, no
 * network and no CLI knowledge.
 */

import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { build } from 'vite'

const root = process.cwd()
const workerDir = resolve(root, 'dist-single-worker')
const outDir = resolve(root, 'dist-single')

await build({ configFile: resolve(root, 'vite.config.worker.ts'), mode: 'production' })
await build({ configFile: resolve(root, 'vite.config.single.ts'), mode: 'production' })
rmSync(workerDir, { recursive: true, force: true })

const files = readdirSync(outDir, { recursive: true }).sort()
if (files.length !== 1 || files[0] !== '8sme-tools.html') {
  throw new Error(`Expected exactly one output file, got: ${files.join(', ')}`)
}

const htmlPath = join(outDir, '8sme-tools.html')
const html = readFileSync(htmlPath, 'utf8')

// Only inspect real markup, not JS strings that happen to contain `src=`/`href=`.
const styles = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n')
const markup = html
  .replace(/<script[\s\S]*?<\/script>/gi, '')
  .replace(/<style[\s\S]*?<\/style>/gi, '')
const external = [
  ...[
    ...markup.matchAll(
      /<(?:script|link|img|source|audio|video|iframe)\b[^>]*\b(?:src|href)="([^"]+)"/gi,
    ),
  ],
  ...[...styles.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)],
]
  .map((match) => match[2] ?? match[1])
  .filter((url) => !url.startsWith('data:') && !url.startsWith('#'))

if (external.length > 0) {
  throw new Error(`Single-file HTML still references external files:\n${external.join('\n')}`)
}

const size = statSync(htmlPath).size
console.log(`\nPortable build: ${htmlPath}`)
console.log(`Size: ${(size / 1024 / 1024).toFixed(1)} MB`)
console.log('Open this file directly in a browser — it works offline.')
