/**
 * i18n Module — 다국어 지원 시스템 (Phase 2.2)
 *
 * 지원 언어: 한국어(ko), 영어(en), 일본어(ja), 중국어 간체(zh-CN)
 *
 * 사용법:
 *   const t = createTranslator('en')
 *   t('search.placeholder')  // "Search anything..."
 *   t('results.empty_title') // "Search the web"
 *
 * 언어 감지 우선순위:
 *   1. URL 파라미터 (?lang=en)
 *   2. HTML lang 속성
 *   3. 브라우저 Accept-Language 헤더
 *   4. 로컬 스토리지 (사용자 설정)
 *   5. 서버 측 env 변수 (DEFAULT_LANG)
 *   6. 기본값 (ko)
 */

import { translations, type TranslationKey } from './translations'

import { logger, toError } from './logger'
// ============================================================
// Types
// ============================================================

export type SupportedLocale = 'ko' | 'en' | 'ja' | 'zh-CN'

export interface I18nConfig {
  defaultLocale?: SupportedLocale
  /** 브라우저 Accept-Language 헤더 값 (서버사이드) */
  acceptLanguage?: string
  /** HTML lang 속성 (서버사이드) */
  htmlLang?: string
  /** URL의 lang 파라미터 */
  urlLang?: string
}

// ============================================================
// Locale detection
// ============================================================

const SUPPORTED_LOCALES: SupportedLocale[] = ['ko', 'en', 'ja', 'zh-CN']

/**
 * Accept-Language 헤더에서 지원되는 언어 감지
 */
export function detectLocaleFromHeader(acceptLanguage?: string): SupportedLocale | null {
  if (!acceptLanguage) return null

  // Parse Accept-Language: "ko-KR,ko;q=0.9,en;q=0.8,ja;q=0.7"
  const locales = acceptLanguage
    .split(',')
    .map((part) => {
      const [locale] = part.trim().split(';')
      return locale?.trim().split('-')[0] // "ko-KR" → "ko"
    })
    .filter(Boolean) as string[]

  for (const locale of locales) {
    if (SUPPORTED_LOCALES.includes(locale as SupportedLocale)) {
      return locale as SupportedLocale
    }
    // "zh" → "zh-CN" (default Chinese)
    if (locale === 'zh') return 'zh-CN'
    // "jp" → "ja"
    if (locale === 'jp') return 'ja'
  }

  return null
}

/**
 * 최종 Locale 결정
 */
export function resolveLocale(config: I18nConfig = {}): SupportedLocale {
  const { defaultLocale = 'ko', acceptLanguage, htmlLang, urlLang } = config

  // 1. URL 파라미터 우선
  if (urlLang && SUPPORTED_LOCALES.includes(urlLang as SupportedLocale)) {
    return urlLang as SupportedLocale
  }

  // 2. HTML lang 속성
  if (htmlLang) {
    const lang = htmlLang.split('-')[0] // "ko-KR" → "ko"
    if (lang && SUPPORTED_LOCALES.includes(lang as SupportedLocale)) {
      return lang as SupportedLocale
    }
    if (lang === 'zh') return 'zh-CN'
  }

  // 3. Accept-Language 헤더
  const headerLocale = detectLocaleFromHeader(acceptLanguage)
  if (headerLocale) return headerLocale

  // 4. 기본값
  return defaultLocale
}

// ============================================================
// Translator
// ============================================================

/**
 * 번역 함수 생성
 *
 * @param locale 언어 코드
 * @param fallbackLocale 폴백 언어 (기본: ko)
 * @returns 번역 함수 (key: string, params?: Record<string, string | number>) => string
 */
export function createTranslator(
  locale: SupportedLocale = 'ko',
  fallbackLocale: SupportedLocale = 'ko',
) {
  const localeTranslations = translations[locale] || {}
  const fallbackTranslations = translations[fallbackLocale] || {}

  /**
   * 키에 해당하는 번역 문자열 반환
   *
   * @param key 점 표기법 키 (예: "search.placeholder")
   * @param params 템플릿 변수 (선택)
   * @returns 번역된 문자열
   */
  return function t(key: TranslationKey, params?: Record<string, string | number>): string {
    // 점 표기법 키를 중첩 객체에서 찾기
    let value: string | undefined

    const keys = key.split('.')
    let current: any = localeTranslations
    for (const k of keys) {
      if (current && typeof current === 'object' && k in current) {
        current = current[k]
      } else {
        current = undefined
        break
      }
    }
    value = typeof current === 'string' ? current : undefined

    // 폴백
    if (!value) {
      current = fallbackTranslations
      for (const k of keys) {
        if (current && typeof current === 'object' && k in current) {
          current = current[k]
        } else {
          current = undefined
          break
        }
      }
      value = typeof current === 'string' ? current : undefined
    }

    // 최종 폴백: 키 자체
    if (!value) {
      value = key
    }

    // 템플릿 변수 치환
    if (params && value) {
      return value.replace(/\{\{(\w+)\}\}/g, (_, name) => {
        return params[name] !== undefined ? String(params[name]) : `{{${name}}}`
      })
    }

    return value
  }
}

/**
 * 숫자/날짜 포맷터 — Intl API 사용
 */
export function formatNumber(n: number, locale: SupportedLocale = 'ko'): string {
  try {
    return new Intl.NumberFormat(locale).format(n)
  } catch (err) {
    logger.warn('[i18n] formatNumber failed:', { error: toError(err) })
    return String(n)
  }
}

export function formatDate(date: Date | string | number, locale: SupportedLocale = 'ko'): string {
  try {
    const d = typeof date === 'string' || typeof date === 'number' ? new Date(date) : date
    return new Intl.DateTimeFormat(locale, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    }).format(d)
  } catch (err) {
    logger.warn('[i18n] formatDate failed:', { error: toError(err) })
    return String(date)
  }
}

/**
 * 상대 시간 포맷 ("3분 전", "2 hours ago", "1日前")
 */
export function formatRelativeTime(
  date: Date | string | number,
  locale: SupportedLocale = 'ko',
): string {
  try {
    const d = typeof date === 'string' || typeof date === 'number' ? new Date(date) : date
    const now = Date.now()
    const diffMs = now - d.getTime()
    const seconds = Math.floor(diffMs / 1000)
    const minutes = Math.floor(seconds / 60)
    const hours = Math.floor(minutes / 60)
    const days = Math.floor(hours / 24)

    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })

    if (days > 30) return formatDate(d, locale)
    if (days > 0) return rtf.format(-days, 'day')
    if (hours > 0) return rtf.format(-hours, 'hour')
    if (minutes > 0) return rtf.format(-minutes, 'minute')
    return rtf.format(-seconds, 'second')
  } catch (err) {
    logger.warn('[i18n] formatRelativeTime failed:', { error: toError(err) })
    return String(date)
  }
}

/**
 * Minimal ClientWindow interface for SSR-safe browser detection.
 */
interface ClientWindow {
  location?: { search?: string }
  localStorage?: { getItem(key: string): string | null }
  navigator?: { language?: string }
}

/**
 * 클라이언트사이드 언어 감지 (브라우저에서 실행)
 */
export function detectClientLocale(): SupportedLocale {
  // This function only runs in browser context during SSR
  if (typeof (globalThis as unknown as Record<string, unknown>).window === 'undefined') return 'ko'

  const w = globalThis as unknown as ClientWindow
  if (!w || !w.location) return 'ko'

  // URL 파라미터
  const urlParams = new URLSearchParams(w.location.search || '')
  const urlLang = urlParams.get('lang')
  if (urlLang && SUPPORTED_LOCALES.includes(urlLang as SupportedLocale)) {
    return urlLang as SupportedLocale
  }

  // 로컬 스토리지
  try {
    const stored = w.localStorage?.getItem('search-engine-lang')
    if (stored && SUPPORTED_LOCALES.includes(stored as SupportedLocale)) {
      return stored as SupportedLocale
    }
  } catch (err) {
    logger.warn('[i18n] localStorage access failed:', { error: toError(err) })
  }

  // 브라우저 언어
  const browserLang = w.navigator?.language?.split('-')[0]
  if (browserLang && SUPPORTED_LOCALES.includes(browserLang as SupportedLocale)) {
    return browserLang as SupportedLocale
  }
  if (browserLang === 'zh') return 'zh-CN'

  return 'ko'
}

export type { Locale, TranslationKey } from './translations'
