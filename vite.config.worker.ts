import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'

/**
 * Builds the OpenCASCADE STEP worker as one self-contained ES module. The single-file build
 * embeds this output as a data URL, so it must not emit or fetch any sibling files.
 */

function stubEmbeddedUrls(): Plugin {
  const stubs = new Set(['replicad-opencascadejs/wasm?url', 'node-unrar-js/esm/js/unrar.wasm?url'])
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
      // The glue's own fallback `new URL("replicad_single.wasm", import.meta.url)` would make Vite
      // inline the whole 22 MB kernel as a data URL. We always supply the bytes/locateFile instead,
      // so leave that fallback untouched.
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
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  plugins: [stubEmbeddedUrls()],
  build: {
    outDir: 'dist-single-worker',
    emptyOutDir: true,
    target: 'esnext',
    minify: 'esbuild',
    lib: {
      entry: fileURLToPath(new URL('./src/lib/step/stepWorker.ts', import.meta.url)),
      formats: ['es'],
      fileName: () => 'stepWorker.js',
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
})
