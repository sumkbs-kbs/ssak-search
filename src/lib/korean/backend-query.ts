/**
 * Backend query normalization — E.5 병목 ① + Phase F 영어 확장.
 *
 * 구어체 쿼리를 검색 백엔드에는 키워드형으로 전달한다. 스크래핑 백엔드
 * (Bing/Naver)는 격식 없는 문장형 쿼리에서 무관한 결과를 반환하는 실패
 * 모드가 측정됨(eval kr-conv-03: Bing이 영어 가비지 반환).
 *
 * 언어별 처리:
 *   - 한국어: 스테머(조사·요청어미 제거) + QUESTION_NOISE (E.5)
 *   - 영어: 의문사 골격(what is / tell me about...) + 계사·단순 조동사
 *     제거 (Phase F). 충돌 위험이 있는 단어(will/can/may/get/find 등)는
 *     의도적으로 제외 — "will smith", "can bus", "plan b" 보존.
 *     측정: en-conv 평균 NDCG@10 0.183 → 0.220 (+20% 상대).
 *   - 일본어: 변경 없음. 「とは」 접미 제거를 시도했으나 라이브 A/B에서
 *     ja-conv NDCG -0.24로 부정 측정 — とは는 구어 노이즈가 아니라 일본어의
 *     표준 검색 질의형이므로 철회함 (측정 주도 원칙).
 *
 * 경계 계약: 이 정규화는 백엔드 페칭에만 적용된다. 캐시 키, 스코어링,
 * 답변 생성, semantic cache 임베딩은 원문 쿼리를 사용한다 (orchestrator의
 * fetchCtx 클론 참조).
 */

import { normalizeKoreanQuery } from './stemmer'

/**
 * 의문사와 구어 잔여물 — 검색 엔진 키워드로서 가치가 없는 단독 토큰.
 * '이유'(하락한 이유)처럼 의미 있는 추상 명사는 제외한다.
 */
const QUESTION_NOISE: ReadonlySet<string> = new Set([
  '왜',
  '어떻게',
  '뭐',
  '무엇',
  '언제',
  '어디',
  '누구',
  '몇',
  '이래',
  '그래',
  '어때',
  '뭐야',
  '얼마야',
  '지금',
])

/**
 * English question scaffolding + copulas + conversational fillers —
 * whole-token matches only, applied to Latin tokens during backend fetch
 * normalization.
 *
 * DELIBERATELY EXCLUDED collision classes (a wrong entry mangles real noun /
 * tech-term queries):
 *   - will / may / can / must / should / would / could / shall
 *     ("will smith", "can bus", "may 2026", "should cost model" class)
 *   - do / does? NO — does IS included; bare "do" excluded ("do while",
 *     "do re mi")
 *   - get / find / search / give / know / want / need / help
 *     ("windows search not working", "get request vs post" class — these
 *     carry real query meaning as often as they carry intent scaffolding)
 *   - single-character tokens are never stripped regardless of set contents
 *     (protects "plan b", "vitamin a", "C is fast" → C survives)
 */
const ENGLISH_NOISE: ReadonlySet<string> = new Set([
  'what',
  "what's",
  'who',
  "who's",
  'whom',
  'whose',
  'when',
  "when's",
  'where',
  "where's",
  'why',
  "why's",
  'how',
  "how's",
  'which',
  'is',
  'are',
  'was',
  'were',
  'am',
  'does',
  'did',
  'the',
  'an',
  'tell',
  'show',
  'explain',
  'please',
  'about',
  'me',
  'my',
  'us',
  'wanna',
  'gonna',
  'lets',
  'hey',
  'hi',
])

/**
 * Normalize a user query into a keyword-style string for backend fetches.
 *
 * Never returns an empty string: when normalization strips everything
 * ("알려줘 주세요", "tell me please"), the trimmed original falls through so
 * a backend always receives something searchable.
 */
export function toBackendQuery(query: string): string {
  const trimmed = query.trim()
  if (!trimmed) return query

  const { stems } = normalizeKoreanQuery(trimmed)
  const keywords = stems
    .filter((s) => !QUESTION_NOISE.has(s))
    .filter((s) => !(isPureLatin(s) && s.length >= 2 && ENGLISH_NOISE.has(s.toLowerCase())))
  const normalized = keywords.join(' ').trim()

  return normalized.length > 0 ? normalized : trimmed
}

function isPureLatin(token: string): boolean {
  return /^[A-Za-z'’-]+$/.test(token)
}
