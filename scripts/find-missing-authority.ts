/**
 * Find gold domains missing from authority maps — these are domains that
 * appear in eval gold standards but have no authority boost, causing them
 * to be outranked by keyword-saturated non-gold content.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

interface GoldStandard {
  relevantDomains: string[]
}

const goldPath = resolve(process.cwd(), 'eval', 'gold-standards.json')
const goldRaw = JSON.parse(readFileSync(goldPath, 'utf-8'))

// All gold domains with their query IDs
const goldByDomain: Record<string, string[]> = {}
for (const [key, val] of Object.entries(goldRaw as Record<string, GoldStandard>)) {
  if (key.startsWith('_')) continue
  const domains = (val as GoldStandard)?.relevantDomains
  if (!Array.isArray(domains)) continue
  for (const d of domains) {
    if (!goldByDomain[d]) goldByDomain[d] = []
    goldByDomain[d].push(key)
  }
}

// Domains already in authority maps (from ranking.ts)
const KNOWN_AUTHORITY = new Set([
  // Korean finance
  'finance.naver.com', 'm.stock.naver.com', 'm.finance.naver.com', 'krx.co.kr', 'dart.fss.or.kr',
  // English finance
  'finance.yahoo.com', 'nasdaq.com', 'investing.com', 'stockanalysis.com', 'marketwatch.com',
  'coinmarketcap.com', 'coindesk.com', 'sec.gov', 'spglobal.com', 'statista.com',
  'businesswire.com', 'prnewswire.com', 'apple.com', 'tesla.com', 'nvidia.com',
  'microsoft.com', 'amazon.com', 'netflix.com', 'abc.xyz',
  // English news
  'reuters.com', 'bbc.com', 'bloomberg.com', 'cnbc.com', 'apnews.com', 'npr.org',
  'theverge.com', 'cnet.com', 'techcrunch.com', 'nature.com', 'gov.uk', 'europa.eu',
  'energy.gov', 'cisa.gov', 'blog.google', '9to5mac.com', 'nytimes.com', 'cnn.com',
  'theguardian.com', 'wired.com', 'washingtonpost.com', 'politico.com', 'nbcnews.com',
  'thehill.com', 'wsj.com', 'ft.com', 'economist.com', 'time.com', 'newsweek.com',
  'theatlantic.com', 'newyorker.com', 'propublica.org', 'axios.com', 'bbc.co.uk',
  'dailymail.co.uk', 'mirror.co.uk', 'independent.co.uk',
  // Korean news
  'n.news.naver.com', 'yna.co.kr', 'hani.co.kr', 'donga.com', 'etnews.com',
  'sports.naver.com', 'samsung.com', 'koreabaseball.com', 'kcdc.go.kr', 'hankyung.com',
  'sedaily.com', 'chosun.com', 'biz.chosun.com', 'weekly.chosun.com', 'joongang.co.kr',
  'khan.co.kr', 'kmib.co.kr', 'segye.com', 'munhwa.com', 'hankookilbo.com', 'mk.co.kr',
  'mt.co.kr', 'edaily.co.kr', 'biz.heraldcorp.com', 'asiae.co.kr', 'fnnews.com',
  'newsis.com', 'news1.kr', 'jtbc.co.kr', 'sbs.co.kr', 'imbc.com', 'kbs.co.kr',
  'ichannela.com', 'tv.chosun.com', 'ytn.co.kr', 'thelec.kr', 'zdnet.co.kr',
  // Chinese news
  'people.com.cn', 'xinhuanet.com', '36kr.com', 'thepaper.cn', 'chinadaily.com.cn',
  'cctv.com', 'news.cn', 'autohome.com.cn', 'sohu.com', 'qq.com', '163.com',
  // Chinese travel
  'ctrip.com', 'mafengwo.cn', 'qunar.com', 'tuniu.com', 'ly.com', 'fliggy.com', 'elong.com',
  // Japanese news
  'nhk.or.jp', 'nikkei.com', 'itmedia.co.jp', 'asahi.com', 'mainichi.jp', 'yomiuri.co.jp',
  'japantimes.co.jp', 'famitsu.com', 'digital.go.jp', 'nintendo.co.jp',
  'k-tai.watch.impress.co.jp',
  // Japanese travel
  'japan-guide.com', 'tripadvisor.jp', 'tripadvisor.com', 'gotokyo.org', 'osaka-info.jp',
  'kyoto.travel', 'okinawatravelinfo.com', 'welcome2japan.jp', 'rakuten.co.jp', 'yahoo.co.jp',
  '4travel.jp', 'rurubu.jp',
  // Japanese tech/fact
  'qiita.com', 'zenn.dev', 'dev.to', 'ipa.go.jp',
  'kotobank.jp', 'weblio.jp', 'dictionary.goo.ne.jp', 'eow.alc.co.jp',
  // Tech docs
  'developers.cloudflare.com', 'cloudflare.com', 'postgresql.org', 'mysql.com',
  'use-the-index-luke.com', 'opentelemetry.io', 'bun.sh', 'nextjs.org', 'nuxt.com',
  'svelte.dev', 'docs.github.com', 'atlassian.com', 'mozilla.org', 'w3.org',
  'python.org', 'nodejs.org', 'redis.io', 'kubernetes.io', 'docker.com', 'react.dev', 'vuejs.org',
  // English reference
  'britannica.com', 'howstuffworks.com', 'scientificamerican.com', 'nationalgeographic.com',
  'nasa.gov', 'mayoclinic.org', 'nih.gov', 'cdc.gov', 'usgs.gov', 'noaa.gov',
  'scholar.google.com', 'pubmed.ncbi.nlm.nih.gov', 'semanticscholar.org', 'jstor.org',
  'science.org', 'pnas.org', 'quantamagazine.org', 'smithsonianmag.com', 'livescience.com',
  'space.com', 'universetoday.com',
  // Other known
  'github.com', 'stackoverflow.com', 'wikipedia.org', 'medium.com',
])

// Domain authority from util.ts
const UTIL_AUTHORITY = new Set([
  'wikipedia.org', 'github.com', 'stackoverflow.com', 'medium.com', 'developer.mozilla.org',
  'youtube.com', 'reddit.com',
])

console.log('\n═══════════════════════════════════════════════════════════')
console.log('  Authority 맵에 없는 Gold 도메인')
console.log('═══════════════════════════════════════════════════════════\n')

const missing: Array<{ domain: string; count: number; queries: string[] }> = []
for (const [domain, queries] of Object.entries(goldByDomain)) {
  if (!KNOWN_AUTHORITY.has(domain) && !UTIL_AUTHORITY.has(domain)) {
    missing.push({ domain, count: queries.length, queries })
  }
}

missing.sort((a, b) => b.count - a.count)

for (const { domain, count, queries } of missing.slice(0, 30)) {
  console.log(`  ${domain.padEnd(35)} ${count}건  (예: ${queries.slice(0, 3).join(', ')})`)
}

console.log(`\n  총 누락 도메인: ${missing.length}건`)
console.log(`  총 영향 쿼리: ${missing.reduce((s, m) => s + m.count, 0)}건`)

// Show by language/topic
console.log('\n─── 언어별 누락 도메인 영향 ───')
const byLang: Record<string, number> = {}
for (const { queries: qids } of missing) {
  for (const qid of qids) {
    if (qid.startsWith('kr-')) byLang['korean'] = (byLang['korean'] || 0) + 1
    else if (qid.startsWith('zh-')) byLang['chinese'] = (byLang['chinese'] || 0) + 1
    else if (qid.startsWith('ja-')) byLang['japanese'] = (byLang['japanese'] || 0) + 1
    else if (qid.startsWith('en-') || qid.startsWith('ts-') || qid.startsWith('gk-') || qid.startsWith('ca-') || qid.startsWith('cmp-') || qid.startsWith('adv-') || qid.startsWith('lt-')) byLang['english'] = (byLang['english'] || 0) + 1
    else byLang['other'] = (byLang['other'] || 0) + 1
  }
}
for (const [lang, count] of Object.entries(byLang).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${lang.padEnd(15)} ${count}건`)
}
