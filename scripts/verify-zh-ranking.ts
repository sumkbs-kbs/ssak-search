// zh 쿼리 랭킹 상세 — DDG 희석 여부 확인
import { executeSearch } from '../src/lib/orchestrator'

const golds: Record<string, string[]> = {
  'zh-fact-01': ['zh.wikipedia.org', 'baike.baidu.com'],
  'zh-fact-06': ['zh.wikipedia.org', 'baike.baidu.com'],
  'zh-general-01': ['ctrip.com', 'mafengwo.cn', 'zh.wikipedia.org'],
  'zh-general-04': ['ctrip.com', 'mafengwo.cn', 'zh.wikipedia.org'],
  'zh-news-05': ['people.com.cn', 'xinhuanet.com', 'autohome.com.cn'],
}

const queries: Record<string, string> = {
  'zh-fact-01': '量子计算机原理',
  'zh-fact-06': '黑洞是什么',
  'zh-general-01': '北京旅游攻略',
  'zh-general-04': '西安旅游攻略',
  'zh-news-05': '新能源汽车最新消息',
}

for (const [id, q] of Object.entries(queries)) {
  const gold = golds[id]
  try {
    const res = await executeSearch({ query: q, topic: 'general', max_results: 10, include_answer: false }, {})
    console.log(`\n=== ${id} (${q}) — backends: ${res.backend}`)
    for (const [i, r] of (res.results || []).entries()) {
      let domain = r.domain
      if (!domain) {
        try {
          domain = new URL(r.url).hostname.replace(/^www\./, '')
        } catch {
          domain = r.url
        }
      }
      const isGold = gold.some((g) => domain.includes(g))
      console.log(
        `${i + 1}. [${isGold ? '★GOLD' : '     '}] ${domain}  score=${typeof r.score === 'number' ? r.score.toFixed(3) : r.score}`,
      )
    }
  } catch (e) {
    console.log(`\n=== ${id} ERROR: ${e}`)
  }
}
