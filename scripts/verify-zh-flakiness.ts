// zh-general-04 flakiness 측정 — 5회 반복
import { executeSearch } from '../src/lib/orchestrator'

const q = '西安旅游攻略'

for (let i = 1; i <= 5; i++) {
  try {
    const res = await executeSearch(
      { query: q, topic: 'general', max_results: 10, include_answer: false },
      {},
    )
    const gold = ['ctrip.com', 'mafengwo.cn', 'zh.wikipedia.org']
    const goldHits = (res.results || []).map((r, idx) => {
      const d = r.domain || new URL(r.url).hostname.replace(/^www\./, '')
      return { idx: idx + 1, d, gold: gold.some((g) => d.includes(g)) }
    })
    const topGold = goldHits.filter((h) => h.gold).slice(0, 3)
    console.log(
      `run ${i}: results=${res.results?.length ?? 0} backends=${res.backend} goldPos=${topGold.map((h) => `${h.idx}:${h.d}`).join(',') || 'NONE'}`,
    )
  } catch (e) {
    console.log(`run ${i}: ERROR ${String(e).slice(0, 120)}`)
  }
  await new Promise((r) => setTimeout(r, 500))
}
