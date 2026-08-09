/**
 * Scrapling Sidecar Client
 *
 * TypeScript 클라이언트 — Python FastAPI + Scrapling sidecar 서비스를 호출.
 * 동적 페이지, Cloudflare 보호 페이지, Naver Finance 주식 데이터를
 * Scrapling으로 스크래핑할 때 사용.
 *
 * Usage:
 *   import { sidecarScrape, sidecarExtract, sidecarStock } from './sidecar-client'
 *
 *   // Web scraping
 *   const result = await sidecarScrape('https://example.com', { cssSelector: '.content' })
 *
 *   // Content extraction
 *   const text = await sidecarExtract('https://example.com/article')
 *
 *   // Korean stock data
 *   const stock = await sidecarStock('삼성전자 주가')
 */

import type { Env } from '../types'

import { logger, toError } from './logger'
// ============================================================
// Types
// ============================================================

export interface SidecarConfig {
  /** Sidecar base URL (e.g. http://localhost:8000) */
  baseUrl: string
  /** Request timeout in ms */
  timeoutMs?: number
}

export interface ScrapeRequest {
  url: string
  css_selector?: string
  xpath_selector?: string
  text_query?: string
  adaptive?: boolean
  auto_save?: boolean
  headless?: boolean
  solve_cloudflare?: boolean
  network_idle?: boolean
  extract_text?: boolean
  extract_markdown?: boolean
  timeout_seconds?: number
}

export interface ScrapedElement {
  tag: string
  text?: string | null
  html?: string | null
  attributes: Record<string, string>
  css_selector?: string | null
}

export interface ScrapeResponse {
  url: string
  title?: string | null
  status_code: number
  success: boolean
  error?: string | null
  elements: ScrapedElement[]
  text_content?: string | null
  markdown_content?: string | null
  page_text?: string | null
  response_time_ms: number
  scraping_method: string
}

export interface ExtractRequest {
  url: string
  max_tokens?: number
  include_images?: boolean
  headless?: boolean
}

export interface ExtractResponse {
  url: string
  title?: string | null
  content?: string | null
  images?: string[]
  text_length: number
  success: boolean
  error?: string | null
  response_time_ms: number
}

export interface StockRequest {
  query: string
  include_chart?: boolean
  include_financials?: boolean
}

export interface StockPriceData {
  date: string
  close: number
  open: number
  high: number
  low: number
  volume: number
}

export interface StockResponse {
  name: string
  code: string
  exchange: string
  price: number
  currency: string
  change: number
  change_percent: number
  direction: string
  open_price?: number | null
  high_price?: number | null
  low_price?: number | null
  prev_close?: number | null
  volume?: number | null
  market_cap?: number | null
  per?: number | null
  eps?: number | null
  market_status: string
  chart_data: StockPriceData[]
  source: string
  success: boolean
  error?: string | null
  response_time_ms: number
}

// ============================================================
// Sidecar URL Resolution
// ============================================================

/**
 * Get the sidecar base URL from environment.
 * Returns null if not configured.
 */
export function getSidecarUrl(env?: Env): string | null {
  const sidecarUrl = (env as Record<string, string | undefined>)?.['SIDECAR_URL']
  if (!sidecarUrl) return null
  // Clean the URL
  return sidecarUrl.replace(/\/+$/, '')
}

/**
 * Check if sidecar is available.
 */
export function isSidecarAvailable(env?: Env): boolean {
  return getSidecarUrl(env) !== null
}

// ============================================================
// API Calls
// ============================================================

/**
 * Call the sidecar /scrape endpoint — adaptive web scraping.
 */
export async function sidecarScrape(
  url: string,
  opts: Partial<ScrapeRequest> & { env?: Env; timeoutMs?: number } = {},
): Promise<ScrapeResponse | null> {
  const baseUrl = getSidecarUrl(opts.env)
  if (!baseUrl) return null

  const timeout = opts.timeoutMs || 30000

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)

    const body: ScrapeRequest = {
      url,
      css_selector: opts.css_selector,
      adaptive: opts.adaptive ?? false,
      headless: opts.headless ?? true,
      solve_cloudflare: opts.solve_cloudflare ?? false,
      extract_text: opts.extract_text ?? true,
      timeout_seconds: Math.ceil(timeout / 1000),
    }

    const resp = await fetch(`${baseUrl}/scrape`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    clearTimeout(timer)

    if (!resp.ok) {
      logger.warn(`[Sidecar] /scrape returned ${resp.status} for ${url}`)
      return null
    }

    const data: ScrapeResponse = await resp.json()
    return data
  } catch (err) {
    logger.warn(`[Sidecar] /scrape failed for ${url}:`, { error: toError(err) })
    return null
  }
}

/**
 * Call the sidecar /extract endpoint — content extraction.
 * Similar to extractor.ts but with JS rendering support.
 */
export async function sidecarExtract(
  url: string,
  opts: { maxTokens?: number; includeImages?: boolean; env?: Env; timeoutMs?: number } = {},
): Promise<ExtractResponse | null> {
  const baseUrl = getSidecarUrl(opts.env)
  if (!baseUrl) return null

  const timeout = opts.timeoutMs || 30000

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)

    const body: ExtractRequest = {
      url,
      max_tokens: opts.maxTokens ?? 4000,
      include_images: opts.includeImages ?? false,
    }

    const resp = await fetch(`${baseUrl}/extract`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    clearTimeout(timer)

    if (!resp.ok) return null

    const data: ExtractResponse = await resp.json()
    return data
  } catch (err) {
    logger.warn(`[Sidecar] /extract failed for ${url}:`, { error: toError(err) })
    return null
  }
}

/**
 * Call the sidecar /stock/naver endpoint — Korean stock data.
 * Complements stock-finance.ts with HTML fallback rendering.
 */
export async function sidecarStock(
  query: string,
  opts: { includeChart?: boolean; includeFinancials?: boolean; env?: Env; timeoutMs?: number } = {},
): Promise<StockResponse | null> {
  const baseUrl = getSidecarUrl(opts.env)
  if (!baseUrl) return null

  const timeout = opts.timeoutMs || 15000

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)

    const body: StockRequest = {
      query,
      include_chart: opts.includeChart ?? false,
      include_financials: opts.includeFinancials ?? false,
    }

    const resp = await fetch(`${baseUrl}/stock/naver`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    clearTimeout(timer)

    if (!resp.ok) return null

    const data: StockResponse = await resp.json()
    return data
  } catch (err) {
    logger.warn(`[Sidecar] /stock/naver failed for ${query}:`, { error: toError(err) })
    return null
  }
}

/**
 * Call the sidecar /health endpoint — service availability check.
 */
export async function sidecarHealth(
  env?: Env,
): Promise<{ status: string; scrapling_version: string; fetchers_available: boolean } | null> {
  const baseUrl = getSidecarUrl(env)
  if (!baseUrl) return null

  try {
    const resp = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(5000) })
    if (!resp.ok) return null
    return await resp.json()
  } catch (err) {
    logger.warn('[Sidecar] Health check failed:', { error: toError(err) })
    return null
  }
}
