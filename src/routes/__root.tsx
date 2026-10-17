import { createRootRoute, Link, Outlet } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { LanguageToggle } from '@/components/LanguageToggle'

export const Route = createRootRoute({
  component: RootLayout,
})

const NAV = [
  { to: '/', key: 'common.nav.hub' },
  { to: '/preflight', key: 'common.nav.preflight' },
  { to: '/nesting', key: 'common.nav.nesting' },
] as const

function RootLayout() {
  const { t } = useTranslation()
  return (
    <div className="mx-auto flex min-h-screen max-w-6xl flex-col px-5">
      <header className="flex flex-wrap items-center gap-4 border-b border-border py-5">
        <Link to="/" className="inline-flex flex-col leading-tight font-bold tracking-tight">
          <span className="text-lg">{t('common.appName')}</span>
          <span
            title={__COMMIT_ID__}
            className="font-mono text-[10px] leading-none font-normal text-muted-foreground/60"
          >
            {__COMMIT_ID__}
          </span>
        </Link>
        <div className="ml-auto flex items-center gap-3">
          <nav className="flex items-center gap-1">
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
                {t(item.key)}
              </Link>
            ))}
          </nav>
          <LanguageToggle />
        </div>
      </header>
      <main className="flex-1 py-7">
        <Outlet />
      </main>
      <footer className="border-t border-border py-5 text-xs text-muted-foreground">
        {t('common.footer')}
      </footer>
    </div>
  )
}
