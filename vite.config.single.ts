import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'

const srcDir = fileURLToPath(new URL('./src', import.meta.url))
const root = fileURLToPath(new URL('.', import.meta.url))

/** Short git hash of the built revision, `-dirty` when the tree has uncommitted changes. */
function commitId(): string {
  try {
    const hash = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim()
    const dirty = execSync('git status --porcelain', { encoding: 'utf8' }).trim().length > 0
    return dirty ? `${hash}-dirty` : hash
  } catch {
    return 'dev'
  }
}

function gzipBase64(path: string): string {
  return gzipSync(readFileSync(path), { level: 9 }).toString('base64')
}

/** Embeds the wasm/font assets and the prebuilt STEP worker as virtual modules. */
function embeddedAssets(): Plugin {
  const ocWasm = fileURLToPath(
    new URL('./node_modules/replicad-opencascadejs/dist/replicad_single.wasm', import.meta.url),
  )
  const unrarWasm = fileURLToPath(
    new URL('./node_modules/node-unrar-js/esm/js/unrar.wasm', import.meta.url),
  )
  const etchFont = fileURLToPath(
    new URL('./public/fonts/LiberationSans-Regular.ttf', import.meta.url),
  )
  const workerBundle = fileURLToPath(new URL('./dist-single-worker/stepWorker.js', import.meta.url))

  return {
    name: '8sme-embedded-assets',
    enforce: 'pre',
    resolveId(id) {
      if (id === 'virtual:8sme-assets') return '\0virtual:8sme-assets'
      if (id === 'virtual:8sme-worker') return '\0virtual:8sme-worker'
      return null
    },
    load(id) {
      if (id === '\0virtual:8sme-assets') {
        return [
          `export const ocWasmGzip = ${JSON.stringify(gzipBase64(ocWasm))}`,
          `export const unrarWasmGzip = ${JSON.stringify(gzipBase64(unrarWasm))}`,
          `export const etchFontGzip = ${JSON.stringify(gzipBase64(etchFont))}`,
        ].join('\n')
      }
      if (id === '\0virtual:8sme-worker') {
        let code: Buffer
        try {
          code = readFileSync(workerBundle)
        } catch {
          throw new Error(
            `Missing ${workerBundle}. Run the single-file build script (tools/build-single.mjs), not vite directly.`,
          )
        }
        const dataUrl = `data:text/javascript;base64,${code.toString('base64')}`
        return `export const workerDataUrl = ${JSON.stringify(dataUrl)}`
      }
      return null
    },
  }
}

/** No separate files are allowed in the portable build, including the favicon. */
function inlineFavicon(): Plugin {
  const favicon = readFileSync(fileURLToPath(new URL('./public/favicon.svg', import.meta.url)))
  return {
    name: '8sme-inline-favicon',
    transformIndexHtml(html) {
      const dataUrl = `data:image/svg+xml;base64,${favicon.toString('base64')}`
      return html.replace(
        /<link rel="icon"[^>]*>/,
        `<link rel="icon" type="image/svg+xml" href="${dataUrl}" />`,
      )
    },
  }
}

/**
 * The app normally imports these through `?url`, but the single-file build supplies them as
 * embedded bytes (or does not use them at all). Stub them so no 22 MB asset file is emitted.
 */
function stubEmbeddedUrls(): Plugin {
  const stubs = new Set([
    'replicad-opencascadejs/wasm?url',
    'node-unrar-js/esm/js/unrar.wasm?url',
    'pdfjs-dist/build/pdf.worker.min.mjs?url',
  ])
  return {
    name: '8sme-stub-embedded-urls',
    enforce: 'pre',
    resolveId(id) {
      if (stubs.has(id) || /(?:replicad_single|unrar)\.wasm(?:\?|$)/.test(id)) {
        return '\0stub-embedded-url'
      }
      return null
    },
    load(id) {
      if (id === '\0stub-embedded-url') return 'export default ""'
      return null
    },
    transform(code, id) {
      if (id.endsWith('replicad_single.js')) {
        // A data:/file: URL is not a valid base for `new URL(..., import.meta.url)`, and Vite
        // would inline the whole 22 MB kernel through that fallback. We always supply the bytes
        // directly, so point the glue's base at a harmless absolute URL instead.
        return code.replace(/import\.meta\.url/g, JSON.stringify('http://localhost/'))
      }
      return null
    },
  }
}

export default defineConfig({
  publicDir: false,
  define: {
    __COMMIT_ID__: JSON.stringify(commitId()),
  },
  resolve: {
    alias: [
      {
        find: /^@\/lib\/single\/install$/,
        replacement: fileURLToPath(new URL('./src/lib/single/install.single.ts', import.meta.url)),
      },
      {
        find: /^@\/lib\/single\/history$/,
        replacement: fileURLToPath(new URL('./src/lib/single/history.single.ts', import.meta.url)),
      },
      {
        find: /^@\/lib\/step\/stepWorkerFactory$/,
        replacement: fileURLToPath(
          new URL('./src/lib/step/stepWorkerFactory.single.ts', import.meta.url),
        ),
      },
      {
        find: /^@\/lib\/parsers\/pdfWorkerConfig$/,
        replacement: fileURLToPath(
          new URL('./src/lib/parsers/pdfWorkerConfig.single.ts', import.meta.url),
        ),
      },
      { find: '@', replacement: srcDir },
    ],
  },
  plugins: [
    tanstackRouter({ target: 'react', autoCodeSplitting: false }),
    react(),
    tailwindcss(),
    embeddedAssets(),
    stubEmbeddedUrls(),
    inlineFavicon(),
    viteSingleFile({ outputFileName: '8sme-tools.html' }),
  ],
  build: {
    outDir: 'dist-single',
    emptyOutDir: true,
    target: 'esnext',
    chunkSizeWarningLimit: 100000000,
  },
  root,
})
