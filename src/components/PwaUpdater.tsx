import { useRegisterSW } from 'virtual:pwa-register/react'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'

/** How often an open tab asks the server whether a newer deployment exists. */
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000
/** Leave the "ready offline" toast up long enough to read, then get out of the way. */
const OFFLINE_READY_DISMISS_MS = 5000

/** Service-worker lifecycle UI: offline-ready toast, stale-build prompt, background update polls. */
export function PwaUpdater() {
  const { t } = useTranslation()
  const {
    offlineReady: [offlineReady, setOfflineReady],
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_url, registration) {
      if (!registration) return
      // `registerType: 'prompt'` means a new build waits for the user, so check periodically
      // (and whenever the tab wakes up) or a long-lived tab would never learn it went stale.
      const checkForUpdate = () => {
        if (navigator.onLine) void registration.update().catch(() => {})
      }
      window.setInterval(checkForUpdate, UPDATE_CHECK_INTERVAL_MS)
      window.addEventListener('online', checkForUpdate)
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') checkForUpdate()
      })
    },
  })

  useEffect(() => {
    if (!offlineReady) return
    const timer = window.setTimeout(() => setOfflineReady(false), OFFLINE_READY_DISMISS_MS)
    return () => window.clearTimeout(timer)
  }, [offlineReady, setOfflineReady])

  if (!needRefresh && !offlineReady) return null

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-x-4 bottom-4 z-50 mx-auto flex max-w-md flex-col gap-2 rounded-lg border border-border bg-card p-4 text-card-foreground shadow-xl sm:inset-x-auto sm:right-6 sm:bottom-6"
    >
      <p className="text-sm font-semibold">
        {needRefresh ? t('common.pwa.updateTitle') : t('common.pwa.offlineTitle')}
      </p>
      <p className="text-xs text-muted-foreground">
        {needRefresh ? t('common.pwa.updateBody') : t('common.pwa.offlineBody')}
      </p>
      <div className="mt-1 flex gap-2">
        {needRefresh ? (
          <>
            <Button size="sm" onClick={() => void updateServiceWorker(true)}>
              {t('common.pwa.updateAction')}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setNeedRefresh(false)}>
              {t('common.pwa.later')}
            </Button>
          </>
        ) : (
          <Button size="sm" variant="outline" onClick={() => setOfflineReady(false)}>
            {t('common.pwa.dismiss')}
          </Button>
        )}
      </div>
    </div>
  )
}
