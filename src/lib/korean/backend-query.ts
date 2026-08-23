/**
 * Backend query normalization — E.5 병목 ①.
 *
 * 구어체 한국어 쿼리("삼성전자의 주가를 알려줘")를 검색 백엔드에는 키워드형
 * ("삼성전자 주가")으로 전달한다. 스크래핑 백엔드(Bing/Naver)는 격식 없는
 * 문장형 쿼리에서 무관한 결과를 반환하는 실패 모드가 측정됨(eval kr-conv-03:
 * Bing이 영어 가비지 반환).
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
 * Normalize a user query into a keyword-style string for backend fetches.
 *
 * Never returns an empty string: when normalization strips everything
 * ("알려줘 주세요"), the trimmed original falls through so a backend always
 * receives something searchable.
 */
export function toBackendQuery(query: string): string {
  const trimmed = query.trim()
  if (!trimmed) return query

  const { stems } = normalizeKoreanQuery(trimmed)
  const keywords = stems.filter((s) => !QUESTION_NOISE.has(s))
  const normalized = keywords.join(' ').trim()

  return normalized.length > 0 ? normalized : trimmed
}
