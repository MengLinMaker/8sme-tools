import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

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

export default defineConfig({
  define: {
    __COMMIT_ID__: JSON.stringify(commitId()),
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  plugins: [
    tanstackRouter({ target: 'react', autoCodeSplitting: true }),
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      workbox: {
        // The OpenCASCADE WASM is ~23 MB and lazy-loaded on demand — never precache it.
        globIgnores: ['**/*.wasm'],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
      },
      manifest: {
        name: '8SME Tools',
        short_name: '8SME',
        description: 'Preflight and workflow tools for 8 Star Metal Engineering',
        theme_color: '#0b0f14',
        background_color: '#0b0f14',
        display: 'standalone',
        icons: [
          {
            src: 'favicon.svg',
            sizes: '512x512',
            type: 'image/svg+xml',
            purpose: 'any maskable',
          },
        ],
      },
    }),
  ],
})
