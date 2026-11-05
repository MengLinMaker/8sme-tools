import { createRouter, RouterProvider } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { appHistory } from '@/lib/single/history'
import { installSingleFileAssets } from '@/lib/single/install'
import { routeTree } from './routeTree.gen'
import './i18n'
import './styles/global.css'

installSingleFileAssets()

const router = createRouter({ routeTree, history: appHistory })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('Root element #root not found')

createRoot(rootElement).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
)
