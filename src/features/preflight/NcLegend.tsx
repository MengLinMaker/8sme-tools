import { useTranslation } from 'react-i18next'

/** Colour key for the projected NC toolpath lines (outer / bevel / inner / holes). */
export function NcLegend() {
  const { t } = useTranslation()
  return (
    <>
      <span className="flex items-center gap-1.5">
        <span
          className="inline-block size-3 rounded-sm border border-emerald-400"
          style={{ background: 'rgba(61, 220, 132, 0.5)' }}
        />
        {t('viewer.ncOuter')}
      </span>
      <span className="flex items-center gap-1.5">
        <span
          className="inline-block size-3 rounded-sm border border-fuchsia-400"
          style={{ background: 'rgba(232, 121, 249, 0.5)' }}
        />
        {t('viewer.ncBevel')}
      </span>
      <span className="flex items-center gap-1.5">
        <span
          className="inline-block size-3 rounded-sm border border-amber-400"
          style={{ background: 'rgba(245, 158, 11, 0.5)' }}
        />
        {t('viewer.ncInner')}
      </span>
      <span className="flex items-center gap-1.5">
        <span
          className="inline-block size-3 rounded-sm border border-sky-400"
          style={{ background: 'rgba(56, 189, 248, 0.5)' }}
        />
        {t('viewer.ncHoles')}
      </span>
    </>
  )
}
