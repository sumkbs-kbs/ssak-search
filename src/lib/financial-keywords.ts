/**
 * 금융/주식 키워드 어휘 — 단일 소스 (Single Source of Truth)
 *
 * 세 소비처가 독립된 키워드 목록을 유지해 드리프트가 발생했다:
 *   1. QueryPlanner.heuristicPlan isFinancial (src/lib/agentic/planner.ts) — whole-token 의도 분류
 *   2. extractCompanyName 키워드 제거         (src/lib/stock-finance.ts)    — 정규식 회사명 추출
 *   3. specialized isFinancialPattern         (src/lib/specialized.ts)      — 정규식 금융 라우팅
 * planner에 금융 키워드를 추가(시총/배당금/연금저축펀드 등)해도 나머지 두 곳은
 * 갱신되지 않았다. 이 모듈이 어휘를 한 번 정의하고, 소비처는 여기서 파생한다.
 *
 * 매칭 의미론:
 *  - 영문 키워드: planner는 whole-token, 정규식 소비처는 `\b` 전체 단어
 *  - 한글 키워드: planner는 whole-token(hasIntentKeywords, CJK-safe), 정규식
 *    소비처는 bare substring — JS `\b`는 ASCII 전용이라 Hangul(비-word) 앞뒤로
 *    경계가 성립하지 않으며, 한국어 쿼리는 공백 없이 복합어화("현대차주가")된다.
 *  - 구문(phrase, '리서치 리포트'): planner는 연속 토큰, 정규식 소비처는
 *    `\s*` 결합 (붙여쓰기 '리서치리포트' 포함).
 *
 * 계층 (의도적 의미 차이를 여기서 문서화):
 *  - FINANCIAL_KEYWORDS       — 세 소비처 모두 매칭하는 공통 어휘
 *  - FINANCIAL_PLANNER_ONLY   — planner 의도 + extractCompanyName 제거용.
 *    specialized.isFinancialPattern에는 미포함 (S48): 금리/환율은 kr-news-09/10
 *    ('환율 동향'/'금리 인하 시점') 뉴스 라우팅을 가로채고, 투자/ETF/공모/상장은
 *    learning-gate(방법/초보/추천)와 결합해야만 금융 — bare 매칭 시
 *    '부동산 투자 방법'/'공모전' 오탐.
 *  - FINANCIAL_REGEX_ONLY     — 정규식 소비처 전용. 영문 \b 단어는 planner
 *    whole-token 의도로 안전하지 않음 (chart.js/UX 리서치/'how to share'/'per request'
 *    오탐 — planner는 구문 '리서치 리포트'만 사용), 한글 '리서치' bare도 동일.
 *  - FINANCIAL_STRIP_ONLY     — extractCompanyName 제거 전용 (specialized 감지에는
 *    불필요한 quote/symbol).
 */

// ── 공통 어휘 (세 소비처 모두 매칭) ────────────────────────────────────────────
export const FINANCIAL_KEYWORDS: readonly string[] = [
  // English — whole-token (planner) / \b (regex consumers)
  'stock',
  'price',
  'earnings',
  'revenue',
  'kospi',
  'kosdaq',
  // Korean single tokens — whole-token (planner) / bare substring (regex consumers)
  '실적',
  '주가',
  '매출',
  '매출액',
  '영업이익',
  '순이익',
  '시총',
  '시가총액',
  '배당',
  '배당금',
  '배당수익률',
  '배당주',
  '공시',
  '증권',
  '증권사',
  '목표주가',
  '투자의견',
  '재무제표',
  '주식',
  '주주',
  '자사주',
  '증시',
  '코스피',
  '코스닥',
  '시세',
  '연금저축펀드',
  '기업분석',
  '거래량',
  '변동률',
  '등락률',
  '상한가',
  '하한가',
  '시장가',
  '주봉',
  '일봉',
  '월봉',
  '공모가',
  // Phrases — consecutive tokens (planner) / \s*-joined (regex consumers)
  '증권사 리포트',
  '리서치 리포트',
]

// ── planner 의도 + 회사명 추출 제거용 (specialized 금융 감지 제외 — S48) ────────
export const FINANCIAL_PLANNER_ONLY: readonly string[] = [
  '환율',
  '금리',
  '투자',
  'etf',
  '공모',
  '상장',
]

// ── 정규식 소비처 전용 (planner whole-token 의도에는 안전하지 않음) ──────────────
export const FINANCIAL_REGEX_ONLY: readonly string[] = [
  'share',
  'shares',
  'finance',
  'financial',
  'chart',
  'trading',
  'per',
  'pbr',
  'roe',
  'eps',
  'dividend',
  'ipo',
  'market cap',
  '리서치',
]

// ── extractCompanyName 제거 전용 ────────────────────────────────────────────────
export const FINANCIAL_STRIP_ONLY: readonly string[] = ['quote', 'symbol']

// ──────────────────────────────────────────────────────────────────────────────
// 정규식 빌더
// ──────────────────────────────────────────────────────────────────────────────

const HANGUL = /[\uac00-\ud7af]/

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 키워드 그룹들을 단일 alternation 정규식으로 컴파일.
 * - ASCII 키워드 → `\bword\b` (전체 단어)
 * - Hangul 키워드 → bare substring
 * - 구문(공백 포함) → `\s*` 결합 (리서치 리포트 / 리서치리포트 모두 매칭)
 * - 긴 키워드 우선 정렬 — 추출(제거) 소비처에서 '목표주가'가 '주가'를,
 *   'shares'가 'share'(\b 매치 시 's' 잔존)를 가리지 않도록 한다.
 */
export function buildFinancialKeywordRegex(...groups: ReadonlyArray<readonly string[]>): RegExp {
  const keywords = [...new Set(groups.flat().filter((k) => k.length > 0))]
  const sorted = [...keywords].sort((a, b) => b.length - a.length)
  const pattern = sorted
    .map((k) => {
      if (k.includes(' ')) {
        return k.split(' ').map(escapeRegex).join('\\s*')
      }
      if (HANGUL.test(k)) return escapeRegex(k)
      return `\\b${escapeRegex(k)}\\b`
    })
    .join('|')
  return new RegExp(pattern, 'i')
}
