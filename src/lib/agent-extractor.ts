import { z } from 'zod'
import { isSidecarAvailable, sidecarExtract } from './sidecar-client'
import { jinaExtract } from './jina-search'
import { safeFetchWithRedirects } from './util'
import type { Env } from '../types'

export const AgentToolInputSchema = z.object({
  url: z.string().url({ message: 'Invalid URL format' }),
  extract_depth: z
    .enum(['summary', 'full_markdown', 'structured_facts', 'toc_only', 'code_symbols'])
    .default('full_markdown'),
  section_target: z.string().optional().describe('Target specific heading or topic section in long documents'),
  max_token_budget: z.number().int().min(200).max(16000).default(4000),
  strip_links: z.boolean().default(false),
})

export type AgentToolInput = z.infer<typeof AgentToolInputSchema>

export interface DocumentSection {
  heading: string
  level: number
  content: string
  token_estimate: number
}

export interface AgentToolOutput {
  success: boolean
  url: string
  title?: string
  markdown_content?: string
  structured_data?: Record<string, unknown>
  table_of_contents?: string[]
  code_symbols?: Array<{ heading: string; code: string; language?: string }>
  token_count: number
  took_ms?: number
  escalation_tier?: 'TIER_1_STATIC' | 'TIER_2_JINA_PROXY' | 'TIER_3_STEALTH_SIDECAR'
  metadata: {
    published_time?: string
    author?: string
    content_type: 'article' | 'documentation' | 'forum' | 'structured_json_ld' | 'unknown'
    is_deprecated?: boolean
    freshness_warning?: string
  }
  error?: {
    code: 'BOT_BLOCKED' | 'TIMEOUT' | 'DNS_NOT_FOUND' | 'CONTENT_TOO_SPARSE' | 'INTERNAL_ERROR'
    detail: string
    agent_hint: string
    retryable: boolean
    suggested_action: 'RETRY_WITH_BACKOFF' | 'CHANGE_DOMAIN' | 'REDUCE_TOKEN_BUDGET' | 'USE_SEARCH_SNIPPET'
  }
}

/**
 * 1. JSON-LD / Schema.org Zero-Token Extractor
 */
export function extractJsonLd(rawHtml: string): { data: Record<string, unknown>; type: string } | null {
  const matches = rawHtml.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)
  for (const m of matches) {
    try {
      const parsed = JSON.parse(m[1].trim()) as Record<string, unknown> | Array<Record<string, unknown>>
      const item = Array.isArray(parsed) ? parsed[0] : parsed
      if (item && (item['@context'] || item['@type'])) {
        const authorObj =
          typeof item.author === 'object' && item.author ? (item.author as Record<string, unknown>) : null
        const authorStr = authorObj
          ? String(authorObj.name ?? '')
          : typeof item.author === 'string'
            ? item.author
            : undefined
        return {
          type: String(item['@type'] || 'StructuredData'),
          data: {
            title: item.headline || item.name,
            description: item.description,
            author: authorStr,
            date_published: item.datePublished || item.uploadDate || item.dateCreated,
            date_modified: item.dateModified,
            article_body: item.articleBody,
            faq: Array.isArray(item.mainEntity)
              ? item.mainEntity.map((q: unknown) => {
                  const qObj = q as Record<string, unknown>
                  const ansObj = qObj.acceptedAnswer as Record<string, unknown> | undefined
                  return {
                    question: qObj.name,
                    answer: ansObj?.text,
                  }
                })
              : undefined,
          },
        }
      }
    } catch {
      // Continue to next JSON-LD block
    }
  }
  return null
}

/**
 * 2. Freshness & Deprecation Detection
 */
export function detectFreshness(
  rawHtml: string,
  markdown: string,
): { published_time?: string; is_deprecated?: boolean; freshness_warning?: string } {
  let published_time: string | undefined

  // Match HTML meta tags for date
  const dateMatch =
    rawHtml.match(/<meta\b[^>]*property=["']article:published_time["'][^>]*content=["']([^"']+)["']/i) ||
    rawHtml.match(/<meta\b[^>]*name=["'](?:pubdate|publishdate|date)["'][^>]*content=["']([^"']+)["']/i) ||
    rawHtml.match(/<time\b[^>]*datetime=["']([^"']+)["']/i)

  if (dateMatch) {
    published_time = dateMatch[1]
  }

  const isDeprecated =
    /\b(deprecated|no longer maintained|legacy api|outdated)\b/i.test(markdown.slice(0, 1500)) ||
    /\b(deprecated|legacy)\b/i.test(rawHtml.slice(0, 2000))

  let freshness_warning: string | undefined
  if (isDeprecated) {
    freshness_warning = 'This documentation contains deprecated/legacy markers. Verify against latest release notes.'
  } else if (published_time) {
    const year = parseInt(published_time.slice(0, 4), 10)
    const currentYear = new Date().getFullYear()
    if (year && currentYear - year >= 4) {
      freshness_warning = `Document published in ${year} (${currentYear - year} years ago). API signatures may have changed.`
    }
  }

  return { published_time, is_deprecated: isDeprecated || undefined, freshness_warning }
}

/**
 * 3. Code Symbol & AST Signature Extractor
 */
export function extractCodeSymbols(markdown: string): Array<{ heading: string; code: string; language?: string }> {
  const codeBlocks: Array<{ heading: string; code: string; language?: string }> = []
  const lines = markdown.split('\n')

  let currentHeading = 'Global'
  let inCodeBlock = false
  let currentLang = ''
  let currentCodeLines: string[] = []

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,4})\s+(.+)$/)
    if (headingMatch && !inCodeBlock) {
      currentHeading = headingMatch[2].trim()
      continue
    }

    const codeStart = line.match(/^```(\w*)/)
    if (codeStart && !inCodeBlock) {
      inCodeBlock = true
      currentLang = codeStart[1] || ''
      currentCodeLines = []
      continue
    }

    if (line.startsWith('```') && inCodeBlock) {
      inCodeBlock = false
      const fullCode = currentCodeLines.join('\n').trim()
      if (fullCode.length > 0) {
        codeBlocks.push({
          heading: currentHeading,
          language: currentLang || undefined,
          code: fullCode,
        })
      }
      currentCodeLines = []
      continue
    }

    if (inCodeBlock) {
      currentCodeLines.push(line)
    }
  }

  return codeBlocks
}

/**
 * 4. Semantic Heading Splitter (TOC & On-Demand Section Harvester)
 */
export function extractSemanticSections(markdown: string): { toc: string[]; sections: DocumentSection[] } {
  const lines = markdown.split('\n')
  const sections: DocumentSection[] = []
  const toc: string[] = []

  let currentHeading = 'Introduction'
  let currentLevel = 1
  let currentContent: string[] = []

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,4})\s+(.+)$/)
    if (headingMatch) {
      if (currentContent.length > 0) {
        const text = currentContent.join('\n').trim()
        sections.push({
          heading: currentHeading,
          level: currentLevel,
          content: text,
          token_estimate: Math.ceil(text.length / 3.5),
        })
        currentContent = []
      }
      currentLevel = headingMatch[1].length
      currentHeading = headingMatch[2].trim()
      toc.push(`${'  '.repeat(currentLevel - 1)}- ${currentHeading}`)
    } else {
      currentContent.push(line)
    }
  }

  if (currentContent.length > 0) {
    const text = currentContent.join('\n').trim()
    sections.push({
      heading: currentHeading,
      level: currentLevel,
      content: text,
      token_estimate: Math.ceil(text.length / 3.5),
    })
  }

  return { toc, sections }
}

/**
 * 5. High-Density Text & Markdown Extractor
 */
export function sanitizeToDenseMarkdown(
  rawHtml: string,
  maxTokens: number,
  sectionTarget?: string,
): { markdown: string; toc?: string[] } {
  let clean = rawHtml
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<(nav|footer|aside|header|noscript|svg|form|iframe)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')

  const mainMatch = clean.match(/<(article|main|div class="[^"]*content[^"]*")[^>]*>([\s\S]*?)<\/\1>/i)
  if (mainMatch && mainMatch[2].length > 300) {
    clean = mainMatch[2]
  }

  clean = clean.replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (tableHtml) => {
    const rows = tableHtml.match(/<tr[^>]*>([\s\S]*?)<\/tr>/gi) || []
    if (rows.length === 0) return ''
    let md = '\n'
    rows.forEach((r, idx) => {
      const cols = r.match(/<(td|th)[^>]*>([\s\S]*?)<\/\1>/gi) || []
      const textCols = cols.map((c) => c.replace(/<[^>]+>/g, '').trim())
      md += '| ' + textCols.join(' | ') + ' |\n'
      if (idx === 0) {
        md += '| ' + textCols.map(() => '---').join(' | ') + ' |\n'
      }
    })
    return md + '\n'
  })

  let markdown = clean
    .replace(/<h([1-6])[^>]*>(.*?)<\/h\1>/gi, '\n\n# $2\n')
    .replace(/<p[^>]*>(.*?)<\/p>/gi, '\n\n$1')
    .replace(/<li[^>]*>(.*?)<\/li>/gi, '\n- $1')
    .replace(/<code[^>]*>(.*?)<\/code>/gi, '`$1`')
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, '\n```\n$1\n```\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n/g, '\n\n')
    .trim()

  const { toc, sections } = extractSemanticSections(markdown)

  if (sectionTarget && sectionTarget.trim()) {
    const targetLower = sectionTarget.toLowerCase()
    const matched = sections.filter((s) => s.heading.toLowerCase().includes(targetLower))
    if (matched.length > 0) {
      markdown = matched.map((s) => `# ${s.heading}\n\n${s.content}`).join('\n\n---\n\n')
    }
  }

  const charLimit = Math.floor(maxTokens * 3.5)
  if (markdown.length > charLimit) {
    markdown = markdown.slice(0, charLimit) + '\n\n[...Content truncated by Agent Token Guard...]'
  }

  return { markdown, toc }
}

/**
 * 6. Multi-Tier Anti-Bot Escalation Extractor (95%+ Stealth Evasion)
 */
export async function extractWithStealthEscalation(
  url: string,
  opts: {
    maxTokens: number
    sectionTarget?: string
    extractDepth?: string
    env?: Env
  },
): Promise<AgentToolOutput> {
  const startTime = performance.now()
  const { maxTokens, sectionTarget, extractDepth, env } = opts

  // -------------------------------------------------------------
  // Tier 1: 초고속 정적 Fetch (스텔스 헤더 및 Client Hints 탑재)
  // -------------------------------------------------------------
  try {
    const res = await safeFetchWithRedirects(
      env,
      url,
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9,ko;q=0.8',
          'Sec-CH-UA': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
          'Sec-CH-UA-Mobile': '?0',
          'Sec-CH-UA-Platform': '"macOS"',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          'Sec-Fetch-User': '?1',
          'Upgrade-Insecure-Requests': '1',
        },
      },
      { timeoutMs: 5000, maxRedirects: 3 },
    )

    if (res.ok) {
      const html = await res.text()
      const isChallenge =
        html.includes('cf-browser-verification') ||
        html.includes('challenge-running') ||
        html.includes('Turnstile') ||
        (html.length < 500 && html.includes('captcha'))

      if (!isChallenge) {
        const jsonLd = extractJsonLd(html)
        const freshness = detectFreshness(html, '')

        if (extractDepth === 'structured_facts' && jsonLd) {
          return {
            success: true,
            url,
            structured_data: jsonLd.data,
            token_count: Math.ceil(JSON.stringify(jsonLd.data).length / 3.5),
            took_ms: Math.round(performance.now() - startTime),
            escalation_tier: 'TIER_1_STATIC',
            metadata: { content_type: 'structured_json_ld', ...freshness },
          }
        }

        const { markdown, toc } = sanitizeToDenseMarkdown(html, maxTokens, sectionTarget)

        if (extractDepth === 'toc_only') {
          return {
            success: true,
            url,
            table_of_contents: toc || [],
            token_count: Math.ceil((toc || []).join('\n').length / 3.5),
            took_ms: Math.round(performance.now() - startTime),
            escalation_tier: 'TIER_1_STATIC',
            metadata: { content_type: 'documentation', ...freshness },
          }
        }

        if (extractDepth === 'code_symbols') {
          const symbols = extractCodeSymbols(markdown)
          const symbolMarkdown = symbols
            .map((s) => `### ${s.heading}\n\`\`\`${s.language || ''}\n${s.code}\n\`\`\``)
            .join('\n\n')
          return {
            success: true,
            url,
            markdown_content: symbolMarkdown,
            code_symbols: symbols,
            table_of_contents: toc,
            token_count: Math.ceil(symbolMarkdown.length / 3.5),
            took_ms: Math.round(performance.now() - startTime),
            escalation_tier: 'TIER_1_STATIC',
            metadata: { content_type: 'documentation', ...freshness },
          }
        }

        if (markdown.length >= 50) {
          return {
            success: true,
            url,
            markdown_content: markdown,
            structured_data: jsonLd?.data,
            table_of_contents: toc,
            token_count: Math.ceil(markdown.length / 3.5),
            took_ms: Math.round(performance.now() - startTime),
            escalation_tier: 'TIER_1_STATIC',
            metadata: { content_type: jsonLd ? 'structured_json_ld' : 'article', ...freshness },
          }
        }
      }
    }
  } catch (_err) {
    // Tier 1 실패 시 Tier 2로 에스컬레이션
  }

  // -------------------------------------------------------------
  // Tier 2: Jina Reader Proxy (Edge-to-Edge Clean Reader)
  // -------------------------------------------------------------
  try {
    const jinaRes = await jinaExtract(url, { maxTokens, timeoutMs: 7000 })
    if (jinaRes.content && jinaRes.content.length > 80) {
      const freshness = detectFreshness('', jinaRes.content)
      return {
        success: true,
        url,
        title: jinaRes.title,
        markdown_content: jinaRes.content,
        token_count: Math.ceil(jinaRes.content.length / 3.5),
        took_ms: Math.round(performance.now() - startTime),
        escalation_tier: 'TIER_2_JINA_PROXY',
        metadata: { content_type: 'article', ...freshness },
      }
    }
  } catch (_err) {
    // Tier 2 실패 시 Tier 3으로 에스컬레이션
  }

  // -------------------------------------------------------------
  // Tier 3: Scrapling Stealth Sidecar (Camoufox / Patchright)
  // -------------------------------------------------------------
  if (isSidecarAvailable(env)) {
    try {
      const sidecarRes = await sidecarExtract(url, { maxTokens, env, timeoutMs: 10000 })
      if (sidecarRes?.success && sidecarRes.content && sidecarRes.content.length > 50) {
        const freshness = detectFreshness('', sidecarRes.content)
        return {
          success: true,
          url,
          title: sidecarRes.title || undefined,
          markdown_content: sidecarRes.content,
          token_count: Math.ceil(sidecarRes.content.length / 3.5),
          took_ms: Math.round(performance.now() - startTime),
          escalation_tier: 'TIER_3_STEALTH_SIDECAR',
          metadata: { content_type: 'article', ...freshness },
        }
      }
    } catch (_err) {
      // Sidecar 실패 시
    }
  }

  return handleExtractionError(url, 403, 'Target blocked across all stealth tiers.')
}

export function handleExtractionError(url: string, status: number, rawError: string): AgentToolOutput {
  if (
    status === 403 ||
    status === 503 ||
    rawError.toLowerCase().includes('challenge') ||
    rawError.toLowerCase().includes('blocked')
  ) {
    return {
      success: false,
      url,
      token_count: 0,
      metadata: { content_type: 'unknown' },
      error: {
        code: 'BOT_BLOCKED',
        detail: 'Target host triggered high-security Cloudflare/Anti-bot challenge.',
        agent_hint: 'Do not retry this domain directly. Switch to search snippet or alternate documentation mirror.',
        retryable: false,
        suggested_action: 'CHANGE_DOMAIN',
      },
    }
  }

  if (status === 404) {
    return {
      success: false,
      url,
      token_count: 0,
      metadata: { content_type: 'unknown' },
      error: {
        code: 'DNS_NOT_FOUND',
        detail: 'Page not found (404).',
        agent_hint: 'The link is dead. Re-run web search with refined keywords.',
        retryable: false,
        suggested_action: 'USE_SEARCH_SNIPPET',
      },
    }
  }

  return {
    success: false,
    url,
    token_count: 0,
    metadata: { content_type: 'unknown' },
    error: {
      code: 'TIMEOUT',
      detail: `Request timed out or failed: ${rawError}`,
      agent_hint: 'Target is slow/unresponsive. Rely on search snippet summaries.',
      retryable: true,
      suggested_action: 'RETRY_WITH_BACKOFF',
    },
  }
}
