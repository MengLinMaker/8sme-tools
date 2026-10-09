import { createRootRoute, Link, Outlet } from '@tanstack/react-router'

export const Route = createRootRoute({
  component: RootLayout,
})

function RootLayout() {
  return (
    <div className="app">
      <header className="app-header">
        <Link to="/" className="brand">
          <span className="brand-mark">8</span>
          <span className="brand-name">SME Tools</span>
        </Link>
        <span className="app-tagline">WiseCAM preflight</span>
      </header>
      <main className="app-main">
        <Outlet />
      </main>
      <footer className="app-footer">
        Built for 8 Star Metal Engineering · runs entirely in your browser
      </footer>
    </div>
  )
}
