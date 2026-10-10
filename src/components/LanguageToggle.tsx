import { Languages } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { SUPPORTED_LANGS } from '@/i18n'
import { cn } from '@/lib/utils'

const LABELS: Record<string, string> = { en: 'EN', zh: '中文' }

export function LanguageToggle() {
  const { t, i18n } = useTranslation()
  const current = i18n.resolvedLanguage ?? 'en'

  return (
    <fieldset
      aria-label={t('common.language.label')}
      className="m-0 inline-flex items-center gap-1 rounded-full border border-border bg-secondary p-1"
    >
      <Languages className="ml-1 size-3.5 text-muted-foreground" aria-hidden />
      {SUPPORTED_LANGS.map((lang) => (
        <button
          key={lang}
          type="button"
          aria-pressed={current === lang}
          onClick={() => void i18n.changeLanguage(lang)}
          className={cn(
            'rounded-full px-2.5 py-0.5 text-xs font-semibold transition-colors',
            current === lang
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {LABELS[lang]}
        </button>
      ))}
    </fieldset>
  )
}
