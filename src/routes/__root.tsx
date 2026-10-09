import { createRootRoute, Link, Outlet } from '@tanstack/react-router'

export const Route = createRootRoute({
  component: RootLayout,
})

const NAV = [
  { to: '/', label: 'Hub' },
  { to: '/preflight', label: 'Preflight' },
  { to: '/nesting', label: 'Nesting' },
]

function RootLayout() {
  return (
    <div className="mx-auto flex min-h-screen max-w-6xl flex-col px-5">
      <header className="flex items-baseline gap-4 border-b border-border py-5">
        <Link to="/" className="inline-flex items-center gap-2 font-bold tracking-tight">
          <span className="grid size-7 place-items-center rounded-md bg-primary text-sm font-extrabold text-primary-foreground">
            8
          </span>
          <span className="text-lg">SME Tools</span>
        </Link>
        <nav className="ml-auto flex items-center gap-1">
          {NAV.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className="rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
              activeProps={{
                className: 'bg-accent text-accent-foreground',
              }}
              activeOptions={{ exact: item.to === '/' }}
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </header>
      <main className="flex-1 py-7">
        <Outlet />
      </main>
      <footer className="border-t border-border py-5 text-xs text-muted-foreground">
        Built for 8 Star Metal Engineering · runs entirely in your browser
      </footer>
    </div>
  )
}
