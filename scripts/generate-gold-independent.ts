/**
 * Independent gold generator (T2, tracking .omo/plans/commercial-superiority.md).
 *
 * Problem being fixed: eval/gold-standards.json was iterated against THIS
 * engine's behavior (fix-gold-*.ts scripts), so high NDCG against it partially
 * measures self-agreement. This corpus breaks the loop:
 *
 *   1. Labels are assigned ONLY from a static taxonomy (below + entity
 *      overrides) written from external knowledge of authoritative sources.
 *   2. The engine is never executed during generation.
 *   3. Every entry carries a `rationale` string so a future human adjudication
 *      pass can sample-verify rows.
 *   4. `mustNotDomains` encodes known-bad matches (content farms / SEO
 *      scrapers) so the dataset also measures failure to FILTER.
 *
 * Selection: stratified by (language × query-type) from EVAL_QUERIES.
 * Quotas: KR 100 / EN 100 / ZH 60 / JA 40 = 300 entries.
 *
 * Usage:
 *   npx tsx scripts/generate-gold-independent.ts          # regenerate
 *   npx tsx eval/index.ts --gold eval/gold-independent/gold-independent.json --json
 *   npx tsx eval/index.ts --gold eval/gold-independent/gold-independent.json --tag conversational --json   # smoke subset
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { EVAL_QUERIES } from '../eval/queries'
import type { EvalQuery } from '../eval/types'

type Lang = 'kr' | 'en' | 'zh' | 'ja'
type QType = 'financial' | 'technical' | 'factual' | 'news' | 'academic' | 'general'

const LANG_TAGS: Record<Lang, string> = { kr: 'korean', en: 'english', zh: 'chinese', ja: 'japanese' }

function langOf(q: EvalQuery): Lang | null {
  for (const tag of q.tags ?? []) {
    for (const [lang, t] of Object.entries(LANG_TAGS)) if (tag === t) return lang as Lang
  }
  return null
}

/** Type inference mirrors detectQueryType's six classes; topic takes priority
 *  for finance/news, tag keywords cover technical/factual/academic. */
function typeOf(q: EvalQuery): QType {
  if (q.topic === 'finance') return 'financial'
  if (q.topic === 'news') return 'news'
  const tags = q.tags ?? []
  if (tags.includes('academic')) return 'academic'
  if (tags.includes('technical')) return 'technical'
  if (tags.includes('factual')) return 'factual'
  return 'general'
}

// ── Static authoritative-domain taxonomy (written from external knowledge,
//    never from this engine's outputs). Intentionally narrower than the
//    curated default: precision of "should be there" over recall.
const POOLS: Record<Lang, Partial<Record<QType, string[]>>> = {
  kr: {
    financial: ['krx.co.kr', 'finance.naver.com', 'finance.yahoo.com', 'dart.fss.or.kr', 'investing.com'],
    technical: [
      'developer.mozilla.org',
      'github.com',
      'react.dev',
      'nodejs.org',
      'typescriptlang.org',
      'kr.vuejs.org',
      'developer.android.com',
    ],
    factual: ['wikipedia.org', 'terms.naver.com', 'britannica.com'],
    news: [
      'yna.co.kr',
      'yonhapnewstv.co.kr',
      'hankyung.com',
      'sedaily.com',
      'chosun.com',
      'donga.com',
      'hani.co.kr',
      'khan.co.kr',
      'mk.co.kr',
      'n.news.naver.com',
    ],
    academic: ['arxiv.org', 'pubmed.ncbi.nlm.nih.gov', 'scholar.google.com', 'doi.org', 'dbpia.co.kr', 'kci.go.kr'],
    general: ['wikipedia.org', 'terms.naver.com'],
  },
  en: {
    financial: [
      'finance.yahoo.com',
      'nasdaq.com',
      'sec.gov',
      'investing.com',
      'marketwatch.com',
      'wsj.com',
      'bloomberg.com',
    ],
    technical: [
      'developer.mozilla.org',
      'github.com',
      'stackoverflow.com',
      'react.dev',
      'nodejs.org',
      'typescriptlang.org',
      'developer.android.com',
      'docs.rs',
      'pypi.org',
    ],
    factual: ['wikipedia.org', 'britannica.com'],
    news: [
      'reuters.com',
      'apnews.com',
      'bbc.com',
      'bbc.co.uk',
      'nytimes.com',
      'theguardian.com',
      'techcrunch.com',
      'theverge.com',
    ],
    academic: [
      'arxiv.org',
      'pubmed.ncbi.nlm.nih.gov',
      'scholar.google.com',
      'doi.org',
      'sciencedirect.com',
      'nature.com',
    ],
    general: ['wikipedia.org', 'britannica.com'],
  },
  zh: {
    financial: ['finance.sina.com.cn', 'eastmoney.com', '10jqka.com.cn', 'investing.com'],
    technical: ['developer.mozilla.org', 'github.com', 'csdn.net', 'juejin.cn', 'segmentfault.com', 'react.dev'],
    factual: ['wikipedia.org', 'baike.baidu.com'],
    news: ['news.sina.com.cn', 'thepaper.cn', 'caixin.com', 'people.com.cn', 'cctv.com', '36kr.com'],
    academic: ['arxiv.org', 'cnki.net', 'scholar.google.com', 'doi.org'],
    general: ['baike.baidu.com', 'wikipedia.org', 'zhihu.com'],
  },
  ja: {
    financial: ['kabutan.jp', 'finance.yahoo.co.jp', 'nikkei.com', 'investing.com'],
    technical: ['developer.mozilla.org', 'github.com', 'qiita.com', 'zenn.dev', 'react.dev'],
    factual: ['wikipedia.org'],
    news: ['nhk.or.jp', 'asahi.com', 'mainichi.jp', 'nikkei.com', 'yomiuri.co.jp'],
    academic: ['arxiv.org', 'scholar.google.com', 'ci.nii.ac.jp'],
    general: ['wikipedia.org'],
  },
}

/** Known-bad for open-web evaluation: user-content farms / scraper-heavy
 *  domains that should never dominate an authoritative query's top-10. */
const MUST_NOT = ['pinterest.com', 'answers.yahoo.com', 'slideshare.net', 'scribd.com', 'academia.edu']

/** Entity overrides for high-signal canonical queries (the single best-
 *  measured historical KR anchors). */
const ENTITY_OVERRIDES: Record<string, { relevantDomains: string[]; rationale: string }> = {
  'kr-stock-01': {
    relevantDomains: ['m.stock.naver.com', 'finance.naver.com', 'krx.co.kr', 'samsung.com'],
    rationale: '삼성전자 공식 IR + 한국거래소 공인 공시 + 네이버금융 실시간 시세(외부 지식 기반)',
  },
  'kr-stock-02': {
    relevantDomains: ['m.stock.naver.com', 'finance.naver.com', 'krx.co.kr', 'kakaocorp.com'],
    rationale: '카카오 공식 + 거래소 + 네이버금융',
  },
  'kr-stock-05': {
    relevantDomains: ['krx.co.kr', 'finance.naver.com', 'm.stock.naver.com'],
    rationale: 'KOSPI 지수 공식 출처는 한국거래소',
  },
}

const QUOTA: Record<Lang, number> = { kr: 100, en: 100, zh: 60, ja: 40 }

interface GoldEntry {
  relevantDomains: string[]
  mustNotDomains: string[]
  rationale: string
  source: 'independent-taxonomy-v1'
  lang: Lang
  qtype: QType
}

function main() {
  const counts: Record<Lang, number> = { kr: 0, en: 0, zh: 0, ja: 0 }
  const out: Record<string, GoldEntry | { _comment: string; _methodology: string }> = {
    _meta: {
      _comment:
        'T2 independent gold — labels from static taxonomy (scripts/generate-gold-independent.ts), engine never consulted. Regenerate with the same command; do NOT hand-edit entries.',
      _methodology:
        'expected_domains = authoritative pools per (lang × qtype); must_not = content-farm/scraper domains; rationale present on every row for audit sampling.',
    },
  }

  for (const q of EVAL_QUERIES) {
    const lang = langOf(q)
    if (!lang) continue
    if (counts[lang] >= QUOTA[lang]) continue
    const qtype = typeOf(q)
    // news/finance sub-selections first when pools are narrow (ja.academic is intentionally small —
    // wikipedia-dominated factual sets absorb the slack).
    const base = POOLS[lang][qtype] ?? POOLS[lang].general
    if (!base) continue
    counts[lang]++
    const ent = ENTITY_OVERRIDES[q.id]
    out[q.id] = ent
      ? {
          relevantDomains: ent.relevantDomains,
          mustNotDomains: MUST_NOT,
          rationale: ent.rationale,
          source: 'independent-taxonomy-v1',
          lang,
          qtype,
        }
      : {
          relevantDomains: base,
          mustNotDomains: MUST_NOT,
          rationale: `taxonomy-rule: ${lang}/${qtype} authoritative pool`,
          source: 'independent-taxonomy-v1',
          lang,
          qtype,
        }
  }

  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  const dir = join(process.cwd(), 'eval', 'gold-independent')
  mkdirSync(dir, { recursive: true })
  const filePath = join(dir, 'gold-independent.json')
  writeFileSync(filePath, JSON.stringify(out, null, 2))
  console.log(`independent gold written: ${filePath}`)
  console.log(`counts: kr=${counts.kr} en=${counts.en} zh=${counts.zh} ja=${counts.ja} total=${total}`)
  if (total < 280) {
    console.error(`ERROR: total ${total} < 280 (target ~300) — query set or taxonomy drift`)
    process.exit(1)
  }
}

main()
