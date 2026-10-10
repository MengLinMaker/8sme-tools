import i18n from 'i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import { initReactI18next } from 'react-i18next'
import { resources } from './resources'

export const SUPPORTED_LANGS = ['en', 'zh'] as const
export type SupportedLang = (typeof SUPPORTED_LANGS)[number]

export const LANG_STORAGE_KEY = '8sme.language'

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    supportedLngs: SUPPORTED_LANGS,
    nonExplicitSupportedLngs: true,
    fallbackLng: 'en',
    load: 'languageOnly',
    defaultNS: 'translation',
    interpolation: { escapeValue: false },
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: LANG_STORAGE_KEY,
      caches: ['localStorage'],
    },
  })

/** Applies the current language to the document (lang attribute + CJK font stack). */
function applyDocumentLanguage(lang: string) {
  document.documentElement.lang = lang
}

applyDocumentLanguage(i18n.resolvedLanguage ?? 'en')
i18n.on('languageChanged', applyDocumentLanguage)

export default i18n
