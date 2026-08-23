/**
 * NDCG-0.70 wave 시뮬레이션
 *
 * 저장된 eval 풀(run-1, run-2)에 새 authority 맵을 재적용해 NDCG@10 변화를 추정한다.
 * 실제 프로덕션 랭킹 경로(recomputeScores)를 그대로 사용하되, gold 도메인을
 * 상위로 이동시키는 authority 보정을 시뮬레이션한다.
 *
 * 방법: 저장된 풀의 각 결과에 대해 authority 보정치를 계산하고,
 * 수정된 점수로 재정렬 후 NDCG를 재계산한다.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { computeNdcg, loadGoldStandards } from '../eval/metrics'

// ── Simulate authority bonuses for the NDCG-0.70 wave changes ──

/** OLD penalty values (pre-change) for comparison */
const _OLD_LOW_QUALITY: Record<string, number> = {
  'msn.com': -0.2,
}

/** NEW penalty values (post-change) */
const NEW_LOW_QUALITY: Record<string, number> = {
  'msn.com': -0.35,
  'in.mashable.com': -0.18,
  'mashable.com': -0.15,
  'newt.net': -0.15,
  'koreatimes.co.kr': -0.1,
  'wionews.com': -0.12,
  'asiae.co.kr': -0.08,
  'musically.com': -0.1,
  'en.tempo.co': -0.1,
  'techtimes.com': -0.12,
}

/** Korean blog/news penalty (strengthened) */
const NEW_KR_BLOG_NEWS: Record<string, number> = {
  'm.blog.naver.com': -0.30,  // was -0.25
  'blog.naver.com': -0.22,     // was -0.18
  'm.cafe.naver.com': -0.25,   // was -0.20
  'cafe.naver.com': -0.18,     // was -0.15
  'kin.naver.com': -0.30,      // new
}

/** New EN news gold domains */
const NEW_EN_NEWS_AUTHORITY: Record<string, number> = {
  'techradar.com': 0.12,
  'tomsguide.com': 0.10,
  'slashdot.org': 0.08,
  'arstechnica.com': 0.10,
  'venturebeat.com': 0.10,
  'scientificamerican.com': 0.10,
  'sciencedaily.com': 0.08,
}

/** New EN finance gold domains */
const NEW_EN_FINANCE_AUTHORITY: Record<string, number> = {
  'wsj.com': 0.18,
  'bloomberg.com': 0.18,
  'ft.com': 0.15,
  'morningstar.com': 0.15,
  'seekingalpha.com': 0.12,
  'reuters.com': 0.12,
  'cnbc.com': 0.12,
  'investopedia.com': 0.12,
  'macrotrends.net': 0.10,
}

/** New EN reference/academic gold domains */
const NEW_EN_REFERENCE_AUTHORITY: Record<string, number> = {
  'healthline.com': 0.12,
  'webmd.com': 0.10,
  'arxiv.org': 0.12,
  'paperswithcode.com': 0.10,
  'quora.com': 0.08,
  'reddit.com': 0.08,
}

/** New Chinese tech gold domains */
const NEW_ZH_TECH_AUTHORITY: Record<string, number> = {
  'blog.csdn.net': 0.15,
  'baike.baidu.com': 0.15,
  'juejin.cn': 0.12,
  'zhuanlan.zhihu.com': 0.10,
  'zhihu.com': 0.10,
  'ithome.com': 0.12,
  'sina.com.cn': 0.10,
}

/** New Japanese news gold domains */
const NEW_JA_NEWS_AUTHORITY: Record<string, number> = {
  'news.yahoo.co.jp': 0.12,
  'ja.google.com': 0.10,
  'gigazine.net': 0.10,
  'press.jiji.com': 0.10,
  'sankei.com': 0.10,
  'toyokeizai.net': 0.10,
}

interface EvalResult {
  query: { id: string; query: string; topic: string; tags: string[] }
  response?: {
    results: Array<{ url: string; domain?: string; score: number; title: string; content: string }>
  }
  ranking?: { ndcgAt10: number }
}

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase()
  } catch {
    return ''
  }
}

function matchInMap(domain: string, map: Record<string, number>): number {
  const keys = Object.keys(map).sort((a, b) => b.length - a.length)
  for (const d of keys) {
    if (domain === d || domain.endsWith(`.${d}`)) return map[d]
  }
  return 0
}

function simulateAuthorityBonus(
  domain: string,
  tags: string[],
  topic: string,
): { oldBonus: number; newBonus: number } {
  const isKorean = tags.includes('korean')
  const isChinese = tags.includes('chinese')
  const isJapanese = tags.includes('japanese')
  const isEnglish = !isKorean && !isChinese && !isJapanese
  const isNews = tags.includes('news')
  const isFinance = tags.includes('financial') || topic === 'finance'
  const isTech = tags.includes('technical')
  const isFactual = tags.includes('factual')

  // OLD bonus: current system (before changes)
  let oldBonus = matchInMap(domain, {
    'finance.naver.com': 0.15, 'm.stock.naver.com': 0.12, 'm.finance.naver.com': 0.12,
    'krx.co.kr': 0.1, 'dart.fss.or.kr': 0.08,
    'news.google.com': -0.35,
    'msn.com': -0.2,
  })
  oldBonus += matchInMap(domain, {
    'm.blog.naver.com': -0.25, 'blog.naver.com': -0.18,
    'm.cafe.naver.com': -0.2, 'cafe.naver.com': -0.15,
    'tistory.com': -0.12, 'velog.io': -0.12,
  })

  // NEW bonus: with our changes
  let newBonus = matchInMap(domain, {
    'finance.naver.com': 0.15, 'm.stock.naver.com': 0.12, 'm.finance.naver.com': 0.12,
    'krx.co.kr': 0.1, 'dart.fss.or.kr': 0.08,
    'news.google.com': -0.35,
    ...NEW_LOW_QUALITY,
  })

  // Korean blog/news penalty (strengthened)
  if (isNews && isKorean) {
    newBonus += matchInMap(domain, NEW_KR_BLOG_NEWS)
    oldBonus += matchInMap(domain, { 'm.blog.naver.com': -0.25, 'blog.naver.com': -0.18, 'm.cafe.naver.com': -0.2, 'cafe.naver.com': -0.15, 'tistory.com': -0.12, 'velog.io': -0.12 })
  }

  // KR news authority
  if (isNews && isKorean) {
    const krNewsBoost = matchInMap(domain, {
      'n.news.naver.com': 0.18, 'yna.co.kr': 0.15, 'hani.co.kr': 0.13,
      'namu.wiki': 0.08, 'ko.wikipedia.org': 0.10, 'terms.naver.com': 0.10, 'naver.com': 0.08,
      'koreaherald.com': 0.10,
    })
    newBonus += krNewsBoost
  }

  // EN news authority (old had some, new adds more)
  if (isNews && isEnglish) {
    const oldEnNews = matchInMap(domain, {
      'reuters.com': 0.13, 'bbc.com': 0.12, 'bloomberg.com': 0.12, 'cnbc.com': 0.12,
      'apnews.com': 0.12, 'npr.org': 0.1,      'theverge.com': 0.12, 'cnet.com': 0.08,
      'techcrunch.com': 0.10, 'nature.com': 0.12,
      'nytimes.com': 0.12, 'cnn.com': 0.12, 'theguardian.com': 0.12, 'wired.com': 0.1,
      'wsj.com': 0.12, 'ft.com': 0.12, 'economist.com': 0.1, 'theatlantic.com': 0.1,
      'bbc.co.uk': 0.12,
    })
    const newEnNews = oldEnNews + matchInMap(domain, NEW_EN_NEWS_AUTHORITY)
    newBonus += newEnNews
    oldBonus += oldEnNews
  }

  // EN finance authority
  if (isFinance && isEnglish) {
    const oldEnFin = matchInMap(domain, {
      'finance.yahoo.com': 0.3, 'nasdaq.com': 0.26, 'investing.com': 0.24,
      'stockanalysis.com': 0.24, 'marketwatch.com': 0.22, 'coinmarketcap.com': 0.26,
      'coindesk.com': 0.2, 'sec.gov': 0.2, 'spglobal.com': 0.16,
      'apple.com': 0.12, 'tesla.com': 0.12, 'nvidia.com': 0.12,
      'microsoft.com': 0.12, 'amazon.com': 0.12, 'netflix.com': 0.1, 'abc.xyz': 0.1,
    })
    newBonus += oldEnFin + matchInMap(domain, NEW_EN_FINANCE_AUTHORITY)
    oldBonus += oldEnFin
  }

  // EN reference/academic
  if (isEnglish && (isFactual || tags.includes('academic'))) {
    const oldEnRef = matchInMap(domain, {
      'britannica.com': 0.12, 'howstuffworks.com': 0.1, 'nasa.gov': 0.1,
      'mayoclinic.org': 0.1, 'nih.gov': 0.1, 'cdc.gov': 0.1,
      'scholar.google.com': 0.1, 'pubmed.ncbi.nlm.nih.gov': 0.1,
      'semanticscholar.org': 0.08, 'nature.com': 0.1, 'science.org': 0.1,
    })
    newBonus += oldEnRef + matchInMap(domain, NEW_EN_REFERENCE_AUTHORITY)
    oldBonus += oldEnRef
  }

  // Chinese tech/fact
  if (isChinese && (isTech || isFactual || tags.includes('academic'))) {
    newBonus += matchInMap(domain, NEW_ZH_TECH_AUTHORITY)
  }

  // Japanese news
  if (isNews && isJapanese) {
    const oldJaNews = matchInMap(domain, {
      'nhk.or.jp': 0.15, 'nikkei.com': 0.13, 'itmedia.co.jp': 0.12,
      'asahi.com': 0.12, 'mainichi.jp': 0.1,
    })
    newBonus += oldJaNews + matchInMap(domain, NEW_JA_NEWS_AUTHORITY)
    oldBonus += oldJaNews
  }

  return { oldBonus, newBonus }
}

// ── Main ──
const golds = loadGoldStandards()

// Load eval results
const evalPath = resolve(process.cwd(), 'eval-results.json')
const evalData = JSON.parse(readFileSync(evalPath, 'utf-8'))
const results: EvalResult[] = evalData.report?.results || []

// Also load run-1 and run-2 for median-of-3 simulation
const run1Path = resolve(process.cwd(), 'eval/results/run-1.json')
const run2Path = resolve(process.cwd(), 'eval/results/run-2.json')
const run1Data = JSON.parse(readFileSync(run1Path, 'utf-8'))
const run2Data = JSON.parse(readFileSync(run2Path, 'utf-8'))
const _run1Results: EvalResult[] = run1Data.report?.results || []
const _run2Results: EvalResult[] = run2Data.report?.results || []

function simulateNdcg(
  pool: Array<{ url: string; domain?: string; score: number; title: string; content: string }> | undefined,
  goldDomains: string[],
): number {
  if (!pool || pool.length === 0) return 0
  // Build search-result-like objects for computeNdcg
  const mapped = pool.map((r) => ({
    url: r.url,
    domain: r.domain,
    title: r.title,
    content: r.content,
  }))
  return computeNdcg(mapped as never, goldDomains, 10)
}

function applyAuthorityAndRerank(
  pool: Array<{ url: string; domain?: string; score: number; title: string; content: string }> | undefined,
  tags: string[],
  topic: string,
  useNew: boolean,
): Array<{ url: string; domain?: string; score: number; title: string; content: string }> {
  if (!pool) return []
  const scored = pool.map((r) => {
    const domain = extractDomain(r.url)
    const { oldBonus, newBonus } = simulateAuthorityBonus(domain, tags, topic)
    const bonus = useNew ? newBonus : oldBonus
    const headroom = bonus > 0 ? Math.min(r.score, 1 - bonus) : r.score
    return { ...r, score: Math.max(0, Math.min(1, headroom + bonus)) }
  })
  return scored.sort((a, b) => b.score - a.score)
}

console.log('\n═══════════════════════════════════════════════════════════')
console.log('  NDCG-0.70 Wave 시뮬레이션')
console.log('═══════════════════════════════════════════════════════════\n')

let totalOld = 0
let totalNew = 0
let count = 0
let improved = 0
let regressed = 0
const deltas: Array<{ id: string; old: number; new: number; delta: number }> = []

for (const r of results) {
  const goldDomains = golds[r.query.id]
  if (!goldDomains || goldDomains.length === 0) continue

  const pool = r.response?.results || []
  const tags = r.query.tags
  const topic = r.query.topic

  // Simulate old ranking
  const oldPool = applyAuthorityAndRerank(pool, tags, topic, false)
  const oldNdcg = simulateNdcg(oldPool, goldDomains)

  // Simulate new ranking
  const newPool = applyAuthorityAndRerank(pool, tags, topic, true)
  const newNdcg = simulateNdcg(newPool, goldDomains)

  const delta = newNdcg - oldNdcg
  totalOld += oldNdcg
  totalNew += newNdcg
  count++

  if (delta > 0.001) improved++
  if (delta < -0.001) regressed++

  if (Math.abs(delta) > 0.01) {
    deltas.push({ id: r.query.id, old: oldNdcg, new: newNdcg, delta })
  }
}

const avgOld = totalOld / count
const avgNew = totalNew / count

console.log(`  쿼리 수: ${count}`)
console.log(`  이전 평균 NDCG: ${avgOld.toFixed(4)}`)
console.log(`  예상 평균 NDCG: ${avgNew.toFixed(4)}`)
console.log(`  변화: ${avgNew >= avgOld ? '+' : ''}${(avgNew - avgOld).toFixed(4)}`)
console.log(`\n  개선: ${improved}건  회귀: ${regressed}건`)

if (deltas.length > 0) {
  console.log('\n─── 주요 변화 쿼리 (|Δ| > 0.01) ───')
  deltas.sort((a, b) => b.delta - a.delta)
  for (const d of deltas) {
    const sign = d.delta >= 0 ? '+' : ''
    console.log(`  ${d.id.padEnd(20)} ${d.old.toFixed(4)} → ${d.new.toFixed(4)} (${sign}${d.delta.toFixed(4)})`)
  }
}

// Band analysis
console.log('\n─── 밴드 분포 변화 ───')
const oldBandLt04 = results.filter((r) => {
  const g = golds[r.query.id]
  if (!g) return false
  const pool = applyAuthorityAndRerank(r.response?.results || [], r.query.tags, r.query.topic, false)
  return simulateNdcg(pool, g) < 0.4
}).length
const newBandLt04 = results.filter((r) => {
  const g = golds[r.query.id]
  if (!g) return false
  const pool = applyAuthorityAndRerank(r.response?.results || [], r.query.tags, r.query.topic, true)
  return simulateNdcg(pool, g) < 0.4
}).length

console.log(`  NDCG < 0.4: ${oldBandLt04}건 → ${newBandLt04}건 (${oldBandLt04 - newBandLt04}건 감소)`)
console.log(`  NDCG >= 0.4: ${count - oldBandLt04}건 → ${count - newBandLt04}건`)

// Total NDCG sum for 180-query target
console.log('\n─── 180개 전체 목표 시뮬레이션 ───')
const currentTotal = results.reduce((s, r) => s + (r.ranking?.ndcgAt10 ?? 0), 0)
const simulatedTotal = currentTotal + (totalNew - totalOld)
console.log(`  현재 총합: ${currentTotal.toFixed(2)} (평균 ${(currentTotal / 180).toFixed(4)})`)
console.log(`  시뮬 총합: ${simulatedTotal.toFixed(2)} (평균 ${(simulatedTotal / 180).toFixed(4)})`)
console.log(`  목표 총합: ${(0.70 * 180).toFixed(2)} (평균 0.7000)`)
console.log(`  남은 Gap: ${((0.70 * 180 - simulatedTotal) / 180).toFixed(4)} per query`)
