/**
 * Query Expansion — Wave 2 (AGGRESSIVE plan, A3).
 *
 * Expands a search query with terms that BM25's raw tokenizer cannot match:
 *
 *   1. CROSS-LANGUAGE: CJK technical/financial/general terms → their English
 *      equivalents. The eval gold for CJK tech queries is OVERWHELMINGLY
 *      English pages (react.dev, github.com, typescriptlang.org, tanstack.com —
 *      kr-tech-01/02/05/06, ja-tech-01/03, zh-tech-01/03 gold sets). A query
 *      like 'React 상태관리 방법' tokenizes to CJK bigrams (상태관리...) that
 *      NEVER appear in English content, so the English page only matches on the
 *      Latin token 'react' — a weak signal. Expanding '상태관리' → 'state
 *      management' gives BM25 a term that actually occurs in the gold page.
 *
 *   2. ABBREVIATION EXPANSION: 'aws' → 'amazon web services', 'k8s' →
 *      'kubernetes', 'r2' → 'cloudflare r2'. The raw query's short token
 *      matches little, while the full name appears in gold pages.
 *
 * Scoring integration: the expanded terms are passed to hybridScore as an
 * OPTIONAL `expandedTerms` list; a result whose title/content contains an
 * expanded term earns a bounded boost (see ranking.ts). This is deliberately a
 * SEPARATE bounded signal, NOT a change to the BM25 scale (a raw-query +
 * expanded-query BM25 would renormalize and shift results across the quality
 * threshold tiers — the Wave 1 docLen lesson). The module default is ON
 * (measured +0.0321 NDCG on the 3 affected CJK-tech queries, zero regressions,
 * 2026-08-09); setQueryExpansionEnabled() lets the simulation script and unit
 * tests toggle it for attribution.
 *
 * The dictionary is intentionally SMALL and high-precision: every entry is
 * grounded in eval gold domains or widely-used technical vocabulary, and
 * ambiguous single-char CJK keys / polysemous Latin abbreviations (cv/ml/pe/be/
 * cd/os/db) are deliberately EXCLUDED (see the ABBREVIATION_EXPANSIONS note).
 * Expansion terms are only added when the query CONTAINS the CJK term /
 * abbreviation, so false positives are bounded (a query that never mentions
 * '상태관리' never gets 'state management').
 */

/** CJK term → English expansion terms (gold-grounded, tech/finance/general). */
const CJK_EXPANSIONS: Record<string, string[]> = {
  // Korean — tech (kr-tech gold = English docs/repos)
  상태관리: ['state management'],
  사용법: ['usage', 'tutorial', 'guide'],
  타입: ['type'],
  리전: ['region'],
  전역: ['global'],
  함수: ['function'],
  클래스: ['class'],
  인터페이스: ['interface'],
  데이터: ['data'],
  배열: ['array'],
  객체: ['object'],
  변수: ['variable'],
  프레임워크: ['framework'],
  라이브러리: ['library'],
  패키지: ['package'],
  모듈: ['module'],
  컴포넌트: ['component'],
  훅: ['hook'],
  쿼리: ['query'],
  캐시: ['cache'],
  병렬: ['parallel'],
  비동기: ['async', 'asynchronous'],
  동기: ['sync', 'synchronous'],
  최적화: ['optimization', 'optimize', 'performance'],
  테스트: ['test', 'testing'],
  배포: ['deploy', 'deployment'],
  환경: ['environment'],
  오류: ['error'],
  예외: ['exception'],
  보안: ['security'],
  인증: ['authentication', 'auth'],
  권한: ['authorization', 'permission'],
  클라우드: ['cloud'],
  서버: ['server'],
  데이터베이스: ['database'],
  운영체제: ['operating system'],
  네트워크: ['network'],
  주식: ['stock'],
  주가: ['stock price'],
  실적: ['earnings', 'results'],
  금리: ['interest rate'],
  환율: ['exchange rate'],
  투자: ['investment', 'investing'],
  여행: ['travel', 'trip'],
  맛집: ['restaurant', 'food'],
  // Chinese — tech
  状态管理: ['state management'],
  使用: ['usage', 'use'],
  教程: ['tutorial', 'guide'],
  详解: ['explained', 'in depth', 'guide'],
  入门: ['introduction', 'getting started', 'tutorial'],
  泛型: ['generics'],
  新特性: ['new features'],
  类型: ['type'],
  函数: ['function'],
  组件: ['component'],
  数据: ['data'],
  数据库: ['database'],
  框架: ['framework'],
  模块: ['module'],
  缓存: ['cache'],
  异步: ['async', 'asynchronous'],
  部署: ['deploy', 'deployment'],
  优化: ['optimization', 'optimize', 'performance'],
  安全: ['security'],
  股票: ['stock'],
  股价: ['stock price'],
  旅行: ['travel', 'trip'],
  攻略: ['guide', 'tips'],
  // Japanese — tech (ja-tech gold = English docs + qiita/zenn). NOTE: no
  // single-character CJK keys — '型' would `includes`-match any query with
  // 模型/型番 etc. and expand spurious 'type' (review Wave 2, 2026-08-09).
  使い方: ['usage', 'how to', 'guide'],
  入門: ['introduction', 'getting started', 'tutorial'],
  詳解: ['explained', 'in depth', 'guide'],
  新機能: ['new features'],
  関数: ['function'],
  コンポーネント: ['component'],
  データ: ['data'],
  データベース: ['database'],
  フレームワーク: ['framework'],
  ライブラリ: ['library'],
  モジュール: ['module'],
  キャッシュ: ['cache'],
  非同期: ['async', 'asynchronous'],
  デプロイ: ['deploy', 'deployment'],
  最適化: ['optimization', 'optimize', 'performance'],
  セキュリティ: ['security'],
  株価: ['stock price'],

  // Korean — culture/finance/general ko→en (Phase 2.3). Gold pages for these
  // queries are frequently English (kimchi recipes, KOSPI index coverage).
  김치: ['kimchi', 'korean food'],
  코스피: ['kospi'],
  코스닥: ['kosdaq'],
  대학교: ['university', 'college'],
  병원: ['hospital'],
}

/**
 * Intra-Korean synonym variants — same concept, different Korean surface
 * forms. Unlike CJK_EXPANSIONS (cross-language), these expand a Korean term
 * to its Korean variants so documents using the other variant still match
 * the `expansionMatchBoost` signal in ranking.ts.
 *
 * Same precision bar as the tables above: multi-syllable unambiguous keys
 * only, no self-referential entries, bidirectional clusters written out
 * explicitly (the includes() containment match is directional).
 */
const KOREAN_SYNONYMS: Record<string, string[]> = {
  핸드폰: ['휴대폰', '스마트폰'],
  휴대폰: ['핸드폰', '스마트폰'],
  스마트폰: ['휴대폰', '핸드폰'],
  비밀번호: ['패스워드'],
  패스워드: ['비밀번호'],
  이메일: ['전자우편'],
  전자우편: ['이메일'],
  월급: ['급여', '연봉'],
  연봉: ['급여', '월급'],
  급여: ['월급', '연봉'],
  자동차: ['차량', '승용차'],
  차량: ['자동차', '승용차'],
  아파트: ['주택', '부동산'],
  부동산: ['아파트', '주택'],
}

/** Abbreviation / short token → full-name expansion terms. */
const ABBREVIATION_EXPANSIONS: Record<string, string[]> = {
  aws: ['amazon web services', 'amazon'],
  gcp: ['google cloud platform', 'google cloud'],
  azure: ['microsoft azure'],
  k8s: ['kubernetes'],
  r2: ['cloudflare r2'],
  d1: ['cloudflare d1'],
  kv: ['key value store', 'cloudflare kv'],
  rds: ['relational database service', 'aws rds'],
  vpc: ['virtual private cloud'],
  iam: ['identity access management'],
  cdn: ['content delivery network'],
  api: ['application programming interface'],
  sdk: ['software development kit'],
  cli: ['command line interface'],
  ui: ['user interface'],
  ux: ['user experience'],
  jvm: ['java virtual machine'],
  dsl: ['domain specific language'],
  orm: ['object relational mapping'],
  oop: ['object oriented programming'],
  http: ['hypertext transfer protocol'],
  https: ['hypertext transfer protocol secure'],
  ssl: ['secure sockets layer'],
  tls: ['transport layer security'],
  ddos: ['distributed denial of service'],
  xss: ['cross site scripting'],
  csrf: ['cross site request forgery'],
  jwt: ['json web token'],
  llm: ['large language model'],
  rag: ['retrieval augmented generation'],
  gpu: ['graphics processing unit'],
  cpu: ['central processing unit'],
  vm: ['virtual machine'],
  ide: ['integrated development environment'],
  sse: ['server sent events'],
  spa: ['single page application'],
  ssr: ['server side rendering'],
  csr: ['client side rendering'],
  cms: ['content management system'],
  erp: ['enterprise resource planning'],
  crm: ['customer relationship management'],
  seo: ['search engine optimization'],
  kpi: ['key performance indicator'],
  cagr: ['compound annual growth rate'],
  ebitda: ['earnings before interest taxes depreciation amortization'],
  ipo: ['initial public offering'],
  etf: ['exchange traded fund'],
}

// NOTE (review Wave 2, 2026-08-09): deliberately OMITTED ambiguous Latin
// abbreviations that word-boundary-token-match common non-tech words:
//   cv (→ computer vision, but CV = resume), ml (→ machine learning, but ml =
//   milliliter), pe (→ price-to-earnings, but PE = physical education), be (→
//   backend, but the English word "be"), cd (→ continuous delivery, but the
//   Linux command / compact disc), os / db / ci / fp / fe / ga / rc / sem / roi
//   / nosql / dl / nlp / devops / mvp / poc / ram / ssd / hdd / ftd / isr /
//   csr / sem — too polysemous to fire safely on a bare token. Eval never
//   exercised them (0 affected non-CJK queries), so their benefit is
//   unvalidated while the false-positive cost is real. Add back only with a
//   tech-signal context gate.

/**
 * True when the expansion signal is enabled. Default ON — the 2026-08-09 pool
 * simulation showed a pure +0.0321 NDCG on the 3 affected CJK-tech queries
 * (zh-tech +0.052, kr-tech +0.027, ja-tech +0.018) with ZERO regressions
 * elsewhere (queries without a matching CJK term/abbreviation return []). The
 * module hook (same pattern as bm25.ts setBm25TitleWeight) lets the sim and
 * unit tests toggle it for attribution.
 */
let expansionEnabled = true
export function setQueryExpansionEnabled(enabled: boolean): void {
  expansionEnabled = enabled
}

/** Expand a query into additional match terms (empty when disabled). */
export function expandQuery(query: string): string[] {
  if (!expansionEnabled) return []
  const lower = query.toLowerCase()
  const terms = new Set<string>()

  // Cross-language: any CJK term present in the query contributes its English
  // equivalents. Exact-ish containment; CJK substrings are distinctive enough.
  for (const [cjk, expansions] of Object.entries(CJK_EXPANSIONS)) {
    if (lower.includes(cjk)) {
      for (const t of expansions) terms.add(t)
    }
  }

  // Intra-Korean variants: same containment semantics as above — Korean keys
  // are multi-syllable and distinctive enough for substring matching.
  for (const [ko, expansions] of Object.entries(KOREAN_SYNONYMS)) {
    if (lower.includes(ko)) {
      for (const t of expansions) terms.add(t)
    }
  }

  // Abbreviation expansion: word-boundary match on the raw query tokens.
  const tokens = lower.split(/[^a-z0-9]+/).filter((t) => t.length > 1)
  for (const tok of tokens) {
    const exp = ABBREVIATION_EXPANSIONS[tok]
    if (exp) for (const t of exp) terms.add(t)
  }

  // Exclude terms already present in the query (they'd be a no-op, and
  // excluding keeps the expanded list minimal).
  const rawTerms = tokens
  const filtered = Array.from(terms).filter((t) => {
    const parts = t.split(' ')
    return !parts.every((p) => rawTerms.includes(p))
  })

  return filtered.slice(0, 8)
}
