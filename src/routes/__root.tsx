import { createRootRoute, Link, Outlet } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { LanguageToggle } from '@/components/LanguageToggle'
import { PwaUpdater } from '@/components/PwaUpdater'

export const Route = createRootRoute({
  component: RootLayout,
})

// The hub lives behind the app title, so it doesn't need its own tab.
const NAV = [{ to: '/preflight', key: 'common.nav.preflight' }] as const

function RootLayout() {
  const { t } = useTranslation()
  return (
    <div className="mx-auto flex min-h-screen max-w-6xl flex-col px-5">
      <header className="flex flex-wrap items-center gap-4 border-b border-border py-5">
        <Link
          to="/"
          className="inline-flex flex-col leading-tight font-bold tracking-tight transition-opacity hover:opacity-70"
          title={t('hub.title')}
        >
          <span className="text-lg">{t('common.appName')}</span>
          <span
            title={t('common.versionHint')}
            className="font-mono text-[10px] leading-none font-normal text-muted-foreground/60"
          >
            {__BUILD_VERSION__}
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
      <PwaUpdater />
    </div>
  )
}
