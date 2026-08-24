/**
 * Korean lightweight stemmer — query-side 조사(particle) & 요청어미(request
 * ending) stripping for search matching.
 *
 * WHY query-side only:
 *   Every match signal in this codebase is substring-based — bm25's
 *   `termFrequency` uses indexOf and computeScore uses titleLower/contentLower
 *   includes(). Stemming the QUERY therefore lets a bare stem ("주가") match
 *   inside longer document forms ("주가를", "주가가") with ZERO document-side
 *   churn: no re-indexing, no docLen scale shift in BM25 (the Wave 1 lesson),
 *   no change to how documents are tokenized or stored.
 *
 * Design constraints:
 *   - MIN_STEM_LEN = 2: never strip down to a single syllable. "나는" → "나"
 *     would destroy specificity and match noise ("나" appears everywhere).
 *   - Longest-suffix-first matching: "에서는" must strip as one compound
 *     particle, not leave "서는".
 *   - High precision over recall: particles are matched only as word-FINAL
 *     suffixes on tokens containing Hangul; Latin/symbol tokens pass through
 *     untouched (S&P500, C++, typescript).
 *   - Conversational fillers ("알려줘", "찾아줘") normalize to '' so callers
 *     can drop them from the token stream entirely.
 *
 * This deliberately does NOT attempt full morphological analysis (KoNLPy/
 * MeCab): those need a Python sidecar (ops burden) or a heavy JS port, while
 * particle stripping + substring matching captures the dominant failure mode
 * ("삼성전자의 주가를" failing to match "삼성전자 ... 주가" documents) at
 * negligible cost.
 */

/** NFC-normalize input (Hangul jamo can arrive decomposed). */
function toNFC(text: string): string {
  return text.normalize('NFC')
}

const HANGUL_SYLLABLE = /\uAC00-\uD7A3/
export function hasHangul(text: string): boolean {
  return new RegExp(`[${HANGUL_SYLLABLE.source}]`).test(text)
}

/**
 * Compound + simple 조사, LONGEST first so compound forms win over their
 * prefixes ("에서는" strips whole before "는" is considered).
 *
 * Deliberately EXCLUDED ambiguous finals that collide with common Sino-Korean
 * words: 음/염/원/인/일/분/중/간/후/전/하 etc. Only true grammatical particles
 * are listed — a wrong entry here mangles real nouns.
 */
/**
 * Compound + simple 조사, LONGEST first so compound forms win over their
 * prefixes ("에서는" strips whole before "는" is considered).
 *
 * DELIBERATELY EXCLUDED collision classes — syllables that end thousands of
 * legitimate words, where stripping mangles real nouns (measured against the
 * eval pool: 국제유가→국제유, 한옥마을→한옥마, 라즈베리파이→라즈베리파,
 * 포도/지도/속도/사이/두바이 class):
 *   이 / 가 / 도 / 로 / 만  (Sino-Korean 度·道·路 suffixes, native nouns)
 *   이란                    (Iran)
 * Only unambiguous grammatical particles remain; the residual ambiguity
 * (마을, 금은) is handled by FALSE_POSITIVE_STEMS below.
 */
const PARTICLES: readonly string[] = [
  '으로부터',
  '에서는',
  '에게서',
  '에게는',
  '으로는',
  '으로서',
  '으로써',
  '이라는',
  '까지도',
  '까지는',
  '보다는',
  '이라도',
  '조차도',
  '에서도',
  '에서만',
  '에게도',
  '으로도',
  '로부터',
  '라는',
  '이나마',
  '까지',
  '에서',
  '에게',
  '한테',
  '으로',
  '부터',
  '처럼',
  '보다',
  '마다',
  '조차',
  '밖에',
  '이나',
  '이라',
  '라고',
  '께서',
  '같이',
  '마저',
  '을',
  '를',
  '의',
  '에',
  '와',
  '과',
  '은',
  '는',
]

/**
 * Common words that END in a kept particle's shape but are single morphemes.
 * Checked BEFORE any stripping. Small curated list — extend only with
 * dictionary-verified entries.
 */
const FALSE_POSITIVE_STEMS: ReadonlySet<string> = new Set(['마을', '금은'])

/** Minimum surviving stem length — guards against single-syllable collapse. */
const MIN_STEM_LEN = 2

/**
 * Request/politeness endings that attach to verb stems in conversational
 * queries ("비교해줘" → "비교"). Matched longest-first after particle
 * stripping candidates.
 */
const REQUEST_ENDINGS: readonly string[] = [
  '해주시겠어요',
  '해주실래요',
  '해주겠어요',
  '해주세요',
  '해줄래요',
  '해줄래',
  '해주고',
  '해줘요',
  '해봐요',
  '해줘',
  '해봐',
  '시오',
]

/**
 * Whole-token conversational fillers — pure intent carriers with zero lexical
 * content. normalizeKoreanToken maps these to '' so they drop out of the
 * match stream instead of polluting BM25 with noise terms.
 */
const CONVERSATIONAL_NOISE: ReadonlySet<string> = new Set([
  '알려줘',
  '알려줘요',
  '알려주세요',
  '알려줄래',
  '알려줄래요',
  '찾아줘',
  '찾아주세요',
  '찾아줄래',
  '보여줘',
  '보여주세요',
  '검색해줘',
  '검색해줘요',
  '검색해주세요',
  '설명해줘',
  '설명해주세요',
  '조사해줘',
  '정리해줘',
  '궁금해요',
  '주세요',
  '줘요',
])

/**
 * Strip ONE request ending, then particles (longest first), returning the
 * shortest safe stem. Returns the input unchanged when nothing safely strips.
 */
/**
 * True when the token ends in a denylisted morpheme — stripping further would
 * eat into a protected word (마을 → 마, 한옥마을 → 한옥마).
 */
function isDeniedForm(token: string): boolean {
  for (const fp of FALSE_POSITIVE_STEMS) {
    if (token.endsWith(fp)) return true
  }
  return false
}

function protectedMorphemeEndsWith(particle: string): boolean {
  for (const fp of FALSE_POSITIVE_STEMS) {
    if (fp.endsWith(particle)) return true
  }
  return false
}

/**
 * Strip ONE request ending, then ONE particle (longest first). Compound
 * particles are enumerated explicitly, so stacking (으로부터는) is covered by
 * list entries rather than repeated passes — each candidate strip result must
 * clear the denylist before it is accepted.
 */
export function stripKoreanSuffix(token: string): string {
  const raw = toNFC(token)
  if (!raw || !hasHangul(raw)) return raw
  if (isDeniedForm(raw)) return raw

  let candidate = raw

  for (const ending of REQUEST_ENDINGS) {
    if (candidate.length - ending.length >= MIN_STEM_LEN && candidate.endsWith(ending)) {
      candidate = candidate.slice(0, -ending.length)
      break
    }
  }

  // If candidate currently ends in a protected morpheme, a further strip whose
  // particle overlaps that morpheme's tail must be blocked ("한옥마을" − 을),
  // while non-overlapping strips stay allowed ("한옥마을에서" − 에서).
  const endsInProtectedMorpheme = isDeniedForm(candidate)

  for (const p of PARTICLES) {
    if (p.length < candidate.length && candidate.length - p.length >= MIN_STEM_LEN && candidate.endsWith(p)) {
      if (endsInProtectedMorpheme && protectedMorphemeEndsWith(p)) continue
      return candidate.slice(0, candidate.length - p.length)
    }
  }

  return candidate
}

/**
 * Normalize a single search token:
 *   1. NFC normalization
 *   2. conversational filler → ''
 *   3. particle/request-ending stripping
 *
 * Returns '' when the token carries no lexical value (fillers) — callers drop
 * empty results from their token streams.
 */
export function normalizeKoreanToken(token: string): string {
  const nfc = toNFC(token)
  if (!nfc) return ''
  if (!hasHangul(nfc)) return nfc
  if (CONVERSATIONAL_NOISE.has(nfc)) return ''
  return stripKoreanSuffix(nfc)
}

export interface KoreanQueryNormalization {
  /** Original query preserved for phrase-bonus paths. */
  original: string
  /** NFC-normalized, stemmed, de-noised tokens (order-preserving, deduped). */
  stems: string[]
}

/**
 * Normalize a full Korean (or mixed) query into match-ready stems.
 *
 * Splits on whitespace/punctuation, normalizes each token, drops empties and
 * single-char remnants, dedupes while preserving order.
 */
export function normalizeKoreanQuery(query: string): KoreanQueryNormalization {
  const original = query
  const stems: string[] = []
  const seen = new Set<string>()

  // Whitespace-only split — punctuation (notably '.') must stay attached to
  // Latin tokens so "Next.js" survives as one term.
  const parts = query.split(/\s+/u).filter(Boolean)
  for (const part of parts) {
    const stem = normalizeKoreanToken(part.replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, ''))
    if (!stem || stem.length < MIN_STEM_LEN) continue
    if (seen.has(stem)) continue
    seen.add(stem)
    stems.push(stem)
  }

  return { original, stems }
}
