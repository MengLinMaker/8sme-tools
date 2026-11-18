import { createRootRoute, Link, Outlet } from '@tanstack/react-router'
import { useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { LanguageToggle } from '@/components/LanguageToggle'
import { PwaUpdater } from '@/components/PwaUpdater'
import { applyUpdateNow, isUpdateReady, subscribeUpdateReady } from '@/lib/pwa/updateReady'
import { cn } from '@/lib/utils'

export const Route = createRootRoute({
  component: RootLayout,
})

// The hub lives behind the app title, so it doesn't need its own tab.
const NAV = [{ to: '/preflight', key: 'common.nav.preflight' }] as const

/**
 * Build version under the title. The dot is the permanent freshness indicator: green while this
 * tab runs the deployed build, amber once a newer one is waiting (click reloads into it).
 */
function VersionLabel() {
  const { t } = useTranslation()
  const updateReady = useSyncExternalStore(subscribeUpdateReady, isUpdateReady, () => false)

  const label = (
    <>
      <span
        aria-hidden
        className={cn(
          'size-1.5 shrink-0 rounded-full',
          updateReady ? 'bg-amber-400' : 'bg-primary/70',
        )}
      />
      <span className="font-mono">{__BUILD_VERSION__}</span>
    </>
  )

  if (!updateReady) {
    return (
      <span
        title={t('common.pwa.upToDate', { version: __BUILD_VERSION__ })}
        className="inline-flex items-center gap-1.5 text-[10px] leading-none font-normal text-muted-foreground/60"
      >
        {label}
      </span>
    )
  }

  return (
    <button
      type="button"
      onClick={applyUpdateNow}
      title={t('common.pwa.updateAvailable')}
      className="inline-flex w-fit items-center gap-1.5 text-[10px] leading-none font-normal text-amber-300 transition-colors hover:text-amber-200"
    >
      {label}
      <span className="underline underline-offset-2">{t('common.pwa.reload')}</span>
    </button>
  )
}

function RootLayout() {
  const { t } = useTranslation()
  return (
    <div className="mx-auto flex min-h-screen max-w-6xl flex-col px-5">
      <header className="flex flex-wrap items-center gap-4 border-b border-border py-5">
        <div className="inline-flex flex-col gap-0.5 leading-tight font-bold tracking-tight">
          <Link
            to="/"
            className="text-lg transition-opacity hover:opacity-70"
            title={t('hub.title')}
          >
            {t('common.appName')}
          </Link>
          <VersionLabel />
        </div>
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
      <PwaUpdater />
    </div>
  )
}
