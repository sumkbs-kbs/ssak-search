/**
 * Gold-standard relevantDomains generator for the eval query-set expansion
 * (180 → 500 queries, 2026-08-05).
 *
 * The 180 original queries already have curated gold standards in
 * eval/gold-standards.json — they are preserved untouched. This script
 * curates relevantDomains for the 320 NEW queries (language/topic domain
 * pools + entity-specific authoritative domains) and merges them in.
 *
 * Usage:
 *   npx tsx scripts/generate-gold-standards.ts
 *
 * The generated file is committed — it is the source of truth consumed by
 * eval/runner.ts for NDCG@10 / MRR / Precision@10 computation.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const GOLD_PATH = join(process.cwd(), 'eval', 'gold-standards.json')

// ── Language × topic authoritative-domain pools (substring-matched) ────────
const KR_STOCK = ['finance.naver.com', 'm.stock.naver.com', 'investing.com']
const KR_NEWS = [
  'n.news.naver.com',
  'yna.co.kr',
  'hankyung.com',
  'sedaily.com',
  'khan.co.kr',
  'chosun.com',
  'donga.com',
]
const KR_TECH = [
  'github.com',
  'stackoverflow.com',
  'velog.io',
  'inflearn.com',
  'tistory.com',
  'medium.com',
  'developer.mozilla.org',
]
const KR_GENERAL = ['namu.wiki', 'blog.naver.com', 'terms.naver.com', 'youtube.com']

const EN_STOCK = ['finance.yahoo.com', 'nasdaq.com', 'investing.com', 'marketwatch.com', 'cnbc.com', 'reuters.com']
const EN_TECH = [
  'github.com',
  'stackoverflow.com',
  'developer.mozilla.org',
  'dev.to',
  'medium.com',
  'freecodecamp.org',
  'digitalocean.com',
]
const EN_NEWS = [
  'reuters.com',
  'apnews.com',
  'bbc.com',
  'cnn.com',
  'theverge.com',
  'techcrunch.com',
  'theguardian.com',
  'nytimes.com',
  'wired.com',
]
const EN_FACT = [
  'en.wikipedia.org',
  'britannica.com',
  'howstuffworks.com',
  'scientificamerican.com',
  'nationalgeographic.com',
]
// S72 (2026-08-13): nasa.gov is NOT a generic science template domain — it is
// topic-specific (astronomy/space/aeronautics/climate/cryosphere). The old
// EN_FACT base included it for ALL 25 en-fact-16..40 entries; 14 of those
// (vaccines, immune system, entropy, diamonds, memory, black swan, anesthesia,
// periodic table, WiFi, artificial photosynthesis, CRISPR, metaverse,
// echolocation, nervous system) never surface a nasa.gov result in any of the
// 3 stored run pools AND NASA is not an authority for the topic → removed
// (S63/S69 precedent: zero pool presence + intent mismatch). NASA remains
// explicit only on the 11 space/physics-relevant queries below.
const EN_ACAD = ['arxiv.org', 'semanticscholar.org', 'paperswithcode.com', 'openreview.net', 'acm.org']
const EN_GENERAL = ['reddit.com', 'quora.com', 'healthline.com', 'webmd.com', 'nytimes.com', 'wikihow.com']

const ZH_FACT = ['zh.wikipedia.org', 'baike.baidu.com', 'zhihu.com']
const ZH_NEWS = [
  '36kr.com',
  'ithome.com',
  'people.com.cn',
  'xinhuanet.com',
  'sina.com.cn',
  'chinanews.com',
  'cnbeta.com',
]
const ZH_TECH = ['juejin.cn', 'csdn.net', 'segmentfault.com', 'zhihu.com', 'github.com', 'cnblogs.com']
const ZH_GENERAL = ['ctrip.com', 'mafengwo.cn', 'dianping.com', 'xiaohongshu.com', 'zhihu.com', 'trip.com']
const ZH_TRAVEL = ['ctrip.com', 'mafengwo.cn', 'xiaohongshu.com', 'trip.com', 'qunar.com']

const JA_FACT = ['ja.wikipedia.org', 'kotobank.jp', 'weblio.jp']
const JA_NEWS = ['nikkei.com', 'japantimes.co.jp', 'asahi.com', 'yomiuri.co.jp', 'itmedia.co.jp', 'mainichi.jp']
const JA_TECH = ['qiita.com', 'zenn.dev', 'github.com', 'dev.to', 'itmedia.co.jp']
const JA_GENERAL = ['yahoo.co.jp', 'tripadvisor.jp', 'japan-guide.com', 'rakuten.co.jp']

// ── New-query gold standards (id → relevantDomains) ────────────────────────
const NEW_GOLD: Record<string, string[]> = {
  // KOREAN — finance (15)
  'kr-stock-06': [...KR_STOCK, 'kia.com'],
  'kr-stock-07': [...KR_STOCK, 'celltrion.com'],
  'kr-stock-08': [...KR_STOCK, 'posco.com'],
  'kr-stock-09': [...KR_STOCK, 'doosanenerbility.com'],
  'kr-stock-10': [...KR_STOCK, 'kakaobank.com'],
  'kr-stock-11': [...KR_STOCK, 'hanwha.com'],
  'kr-stock-12': KR_STOCK,
  'kr-stock-13': [...KR_STOCK, 'thebell.co.kr'],
  'kr-stock-14': KR_STOCK,
  'kr-stock-15': [...KR_STOCK, 'kofia.or.kr'],
  'kr-special-03': [...KR_STOCK, 'wikitree.co.kr'],
  'kr-special-04': [...KR_STOCK, 'goldprice.org'],

  // KOREAN — news (11)
  'kr-news-07': KR_NEWS,
  'kr-news-08': KR_NEWS,
  'kr-news-09': KR_NEWS,
  'kr-news-10': [...KR_NEWS, 'bankofkorea.or.kr'],
  'kr-news-11': KR_NEWS,
  'kr-news-12': [...KR_NEWS, 'koreabaseball.com'],
  'kr-news-13': [...KR_NEWS, 'kma.go.kr'],
  'kr-news-14': [...KR_NEWS, 'jobkorea.co.kr', 'saramin.co.kr'],
  'kr-news-15': [...KR_NEWS, 'bloter.net', 'platum.kr'],
  'kr-news-16': [...KR_NEWS, 'kostat.go.kr'],
  'xl-06': ['n.news.naver.com', 'etnews.com', 'autoview.co.kr'],

  // KOREAN — tech (15)
  'kr-tech-09': [...KR_TECH, 'spring.io'],
  'kr-tech-10': KR_TECH,
  'kr-tech-11': [...KR_TECH, 'nodejs.org'],
  'kr-tech-12': [...KR_TECH, 'w3schools.com'],
  'kr-tech-13': [...KR_TECH, 'react.dev'],
  'kr-tech-14': [...KR_TECH, 'kubernetes.io'],
  'kr-tech-15': [...KR_TECH, 'docs.python.org'],
  'kr-tech-16': [...KR_TECH, 'tensorflow.org'],
  'kr-tech-17': [...KR_TECH, 'web.dev'],
  'kr-tech-18': [...KR_TECH, 'owasp.org'],
  'kr-tech-19': [...KR_TECH, 'postgresql.org'],
  'kr-tech-20': [...KR_TECH, 'mongodb.com', 'mysql.com'],
  'kr-tech-21': [...KR_TECH, 'redis.io'],
  'kr-tech-22': [...KR_TECH, 'aws.amazon.com'],
  'kr-tech-23': [...KR_TECH, 'jestjs.io'],

  // KOREAN — general / special (15)
  'kr-general-08': [...KR_GENERAL, 'diningcode.com'],
  'kr-general-09': [...KR_GENERAL, 'tripadvisor.com'],
  'kr-general-10': KR_GENERAL,
  'kr-general-11': [...KR_GENERAL, 'health.chosun.com'],
  'kr-general-12': [...KR_GENERAL, 'zigbang.com', 'dabangapp.com'],
  'kr-general-13': KR_GENERAL,
  'kr-general-14': [...KR_GENERAL, 'tripadvisor.com'],
  'kr-general-15': [...KR_GENERAL, 'yes24.com', 'kyobobook.co.kr'],
  'kr-general-16': KR_GENERAL,
  'kr-general-17': KR_GENERAL,
  'kr-special-01': KR_GENERAL,
  'kr-special-02': KR_GENERAL,
  'kr-special-05': [...KR_GENERAL, 'vivino.com'],

  // ENGLISH — stock (15)
  'en-stock-11': [...EN_STOCK, 'tesla.com'],
  'en-stock-12': [...EN_STOCK, 'amd.com'],
  'en-stock-13': [...EN_STOCK, 'meta.com'],
  'en-stock-14': [...EN_STOCK, 'jpmorganchase.com'],
  'en-stock-15': [...EN_STOCK, 'palantir.com'],
  'en-stock-16': [...EN_STOCK, 'intel.com'],
  'en-stock-17': [...EN_STOCK, 'tsmc.com'],
  'en-stock-18': [...EN_STOCK, 'coinmarketcap.com', 'coingecko.com'],
  'en-stock-19': [...EN_STOCK, 'spdr.com', 'vanguard.com'],
  'en-stock-20': [...EN_STOCK, 'apple.com', 'macrumors.com'],
  'en-stock-21': [...EN_STOCK, 'microsoft.com'],
  'en-stock-22': [...EN_STOCK, 'goldprice.org', 'kitco.com'],
  'en-stock-23': [...EN_STOCK, 'treasurydirect.gov', 'federalreserve.gov'],
  'en-stock-24': [...EN_STOCK, 'reit.com', 'investopedia.com'],
  'en-stock-25': [...EN_STOCK, 'nvidia.com', 'fool.com'],

  // ENGLISH — tech (30)
  'en-tech-19': [...EN_TECH, 'react.dev', 'nextjs.org'],
  'en-tech-20': [...EN_TECH, 'nextjs.org'],
  'en-tech-21': [...EN_TECH, 'tailwindcss.com'],
  'en-tech-22': [...EN_TECH, 'typescriptlang.org'],
  'en-tech-23': [...EN_TECH, 'nodejs.org'],
  'en-tech-24': [...EN_TECH, 'postgresql.org'],
  'en-tech-25': [...EN_TECH, 'kubernetes.io'],
  'en-tech-26': [...EN_TECH, 'grpc.io'],
  'en-tech-27': [...EN_TECH, 'docker.com'],
  'en-tech-28': [...EN_TECH, 'redis.io'],
  'en-tech-29': [...EN_TECH, 'rust-lang.org', 'tokio.rs'],
  'en-tech-30': [...EN_TECH, 'go.dev'],
  'en-tech-31': [...EN_TECH, 'testing-library.com'],
  'en-tech-32': [...EN_TECH, 'css-tricks.com'],
  'en-tech-33': EN_TECH,
  'en-tech-34': [...EN_TECH, 'web.dev'],
  'en-tech-35': [...EN_TECH, 'hashicorp.com', 'aws.amazon.com'],
  'en-tech-36': [...EN_TECH, 'aws.amazon.com', 'serverless.com'],
  'en-tech-37': [...EN_TECH, 'cloudflare.com'],
  'en-tech-38': [...EN_TECH, 'oauth.net', 'auth0.com'],
  'en-tech-39': [...EN_TECH, 'mongodb.com'],
  'en-tech-40': [...EN_TECH, 'mlflow.org', 'tensorflow.org'],
  'en-tech-41': [...EN_TECH, 'openai.com', 'anthropic.com', 'promptingguide.ai'],
  'en-tech-42': [...EN_TECH, 'cloudflare.com', 'web.dev'],
  'en-tech-43': [...EN_TECH, 'webassembly.org'],
  'en-tech-44': [...EN_TECH, 'typescriptlang.org'],
  'en-tech-45': [...EN_TECH, 'gitlab.com'],
  'en-tech-46': [...EN_TECH, 'neo4j.com'],
  'en-tech-47': [...EN_TECH, 'martinfowler.com', 'microservices.io'],
  'en-tech-48': [...EN_TECH, 'grafana.com', 'opentelemetry.io'],

  // ENGLISH — news (25)
  'en-news-16': [...EN_NEWS, 'macrumors.com', '9to5mac.com'],
  // S32 (2026-08-08): en-news-17/18 are DELIBERATELY deviated from EN_NEWS.
  // The template (big-5 + tech) mismatched the earnings/ruling intent — live
  // pool evidence (run-1..3, 3×): 'Meta earnings latest' surfaces finance
  // outlets (finance.yahoo/cnbc/bloomberg/wsj at ranks 1-7), 'Google antitrust
  // ruling' surfaces Apple-deal tech media (9to5mac/macrumors/geekwire/npr).
  // Template domains that never surface (apnews/bbc/cnn/guardian/wired) cap
  // NDCG through the IDCG denominator (min(goldLen, k)) and were removed.
  // NOTE: gold-standards.json is authoritative — this generator SKIPS ids
  // that already exist, so this entry only matters for a fresh regenerate.
  // Independent cross-check (Google News RSS live, 2026-08-08): 'Meta
  // earnings' surfaces finance.yahoo/cnbc/reuters/seekingalpha; 'Google
  // antitrust ruling' surfaces reuters/cnbc/npr/wsj — seekingalpha@17 and
  // wsj@18 were added on that evidence.
  'en-news-17': [
    'finance.yahoo.com',
    'cnbc.com',
    'bloomberg.com',
    'reuters.com',
    'wsj.com',
    'nytimes.com',
    'seekingalpha.com',
    'theverge.com',
    'techcrunch.com',
  ],
  'en-news-18': [
    'theverge.com',
    'nytimes.com',
    '9to5mac.com',
    'macrumors.com',
    'geekwire.com',
    'reuters.com',
    'cnbc.com',
    'npr.org',
    'wsj.com',
    'arstechnica.com',
    'markets.businessinsider.com',
    'seekingalpha.com',
  ],
  'en-news-19': [...EN_NEWS, 'huggingface.co'],
  'en-news-20': EN_NEWS,
  'en-news-21': [...EN_NEWS, 'quantamagazine.org'],
  'en-news-22': EN_NEWS,
  'en-news-23': [...EN_NEWS, 'datacenterdynamics.com'],
  'en-news-24': [...EN_NEWS, 'nasa.gov'],
  'en-news-25': [...EN_NEWS, 'who.int'],
  'en-news-26': [...EN_NEWS, 'fao.org'],
  'en-news-27': [...EN_NEWS, 'ec.europa.eu'],
  'en-news-28': [...EN_NEWS, 'electrek.co'],
  'en-news-29': [...EN_NEWS, 'semiengineering.com'],
  'en-news-30': [...EN_NEWS, 'arstechnica.com'],
  'en-news-31': [...EN_NEWS, 'gartner.com'],
  'en-news-32': [...EN_NEWS, 'statnews.com'],
  'en-news-33': [...EN_NEWS, 'lightreading.com'],
  'en-news-34': [...EN_NEWS, 'electrek.co'],
  'en-news-35': [...EN_NEWS, 'krebsonsecurity.com'],
  'en-news-36': [...EN_NEWS, 'crunchbase.com', 'pitchbook.com'],
  'en-news-37': [...EN_NEWS, 'canarymedia.com'],
  'en-news-38': [...EN_NEWS, 'spacenews.com'],
  'en-news-39': [...EN_NEWS, 'uploadvr.com', 'roadtovr.com'],
  'en-news-40': [...EN_NEWS, 'roboticsbusinessreview.com'],

  // ENGLISH — factual (25)
  'en-fact-16': [...EN_FACT, 'nasa.gov'],
  'en-fact-17': [...EN_FACT, 'cdc.gov', 'nih.gov'],
  'en-fact-18': [...EN_FACT, 'nasa.gov', 'iaea.org', 'energy.gov'],
  'en-fact-19': [...EN_FACT, 'nih.gov'],
  'en-fact-20': EN_FACT,
  'en-fact-21': [...EN_FACT, 'gemsociety.org'],
  'en-fact-22': [...EN_FACT, 'noaa.gov', 'nasa.gov'],
  'en-fact-23': [...EN_FACT, 'nasa.gov'],
  'en-fact-24': [...EN_FACT, 'nasa.gov', 'nist.gov'],
  'en-fact-25': [...EN_FACT, 'nih.gov'],
  'en-fact-26': [...EN_FACT, 'nasa.gov', 'climate.gov', 'epa.gov'],
  'en-fact-27': [...EN_FACT, 'nasa.gov', 'noaa.gov'],
  'en-fact-28': [...EN_FACT, 'investopedia.com'],
  'en-fact-29': [...EN_FACT, 'mayoclinic.org'],
  'en-fact-30': [...EN_FACT, 'rsc.org'],
  'en-fact-31': [...EN_FACT, 'ieee.org'],
  'en-fact-32': [...EN_FACT, 'energy.gov'],
  'en-fact-33': [...EN_FACT, 'nasa.gov', 'seti.org'],
  'en-fact-34': [...EN_FACT, 'nih.gov', 'nature.com'],
  'en-fact-35': [...EN_FACT, 'nasa.gov'],
  'en-fact-36': [...EN_FACT, 'nasa.gov', 'usgs.gov'],
  'en-fact-37': [...EN_FACT, 'wired.com'],
  'en-fact-38': [...EN_FACT, 'nih.gov'],
  'en-fact-39': [...EN_FACT, 'fnal.gov', 'nasa.gov'],
  'en-fact-40': [...EN_FACT, 'nih.gov'],

  // ENGLISH — academic (10)
  'en-acad-08': EN_ACAD,
  'en-acad-09': EN_ACAD,
  'en-acad-10': EN_ACAD,
  'en-acad-11': EN_ACAD,
  'en-acad-12': EN_ACAD,
  'en-acad-13': EN_ACAD,
  'en-acad-14': EN_ACAD,
  'en-acad-15': EN_ACAD,
  'en-acad-16': EN_ACAD,
  'en-acad-17': EN_ACAD,

  // ENGLISH — general (15)
  'en-general-05': [...EN_GENERAL, 'runrepeat.com', 'runnersworld.com'],
  'en-general-06': [...EN_GENERAL, 'nerdfitness.com'],
  'en-general-07': [...EN_GENERAL, 'budgetbytes.com', 'eatingwell.com'],
  'en-general-08': [...EN_GENERAL, 'sleepfoundation.org', 'nih.gov'],
  'en-general-09': [...EN_GENERAL, 'lonelyplanet.com', 'ricksteves.com'],
  'en-general-10': [...EN_GENERAL, 'spotify.com', 'dev.to'],
  'en-general-11': [...EN_GENERAL, 'headspace.com'],
  'en-general-12': [...EN_GENERAL, 'investopedia.com', 'fool.com'],
  'en-general-13': [...EN_GENERAL, 'lifehacker.com'],
  'en-general-14': [...EN_GENERAL, 'goodreads.com'],
  'en-general-15': [...EN_GENERAL, 'hbr.org', 'indeed.com'],
  'en-general-16': [...EN_GENERAL, 'almanac.com'],
  'en-general-17': [...EN_GENERAL, 'apartmenttherapy.com'],
  'en-general-18': [...EN_GENERAL, 'coursera.org', 'edx.org'],
  'en-general-19': [...EN_GENERAL, 'mayoclinic.org'],

  // ENGLISH — health / travel / shopping (10)
  'en-health-01': ['healthline.com', 'webmd.com', 'nih.gov', 'hopkinsmedicine.org'],
  'en-health-02': ['healthline.com', 'webmd.com', 'nih.gov', 'mayoclinic.org'],
  'en-health-03': ['healthline.com', 'webmd.com', 'eatingwell.com'],
  'en-health-04': ['mayoclinic.org', 'apa.org', 'healthline.com'],
  'en-health-05': ['health.harvard.edu', 'cdc.gov', 'mayoclinic.org'],
  'en-travel-01': ['japan-guide.com', 'lonelyplanet.com', 'tripadvisor.com'],
  'en-travel-02': ['lonelyplanet.com', 'nomadicmatt.com', 'tripadvisor.com'],
  'en-travel-03': ['visiticeland.com', 'lonelyplanet.com', 'guidetoiceland.is'],
  'en-shopping-01': ['rtings.com', 'whathifi.com', 'techradar.com'],
  'en-shopping-02': ['rtings.com', 'pcmag.com', 'tomshardware.com'],

  // CHINESE — factual (10)
  'zh-fact-07': ZH_FACT,
  'zh-fact-08': ZH_FACT,
  'zh-fact-09': ZH_FACT,
  'zh-fact-10': ZH_FACT,
  'zh-fact-11': ZH_FACT,
  'zh-fact-12': ZH_FACT,
  'zh-fact-13': ZH_FACT,
  'zh-fact-14': ZH_FACT,
  'zh-fact-15': ZH_FACT,
  'zh-fact-16': ZH_FACT,

  // CHINESE — tech (10)
  'zh-tech-05': [...ZH_TECH, 'docker.com'],
  'zh-tech-06': [...ZH_TECH, 'kubernetes.io'],
  'zh-tech-07': [...ZH_TECH, 'nodejs.org'],
  'zh-tech-08': [...ZH_TECH, 'mysql.com'],
  'zh-tech-09': [...ZH_TECH, 'microservices.io'],
  'zh-tech-10': [...ZH_TECH, 'web.dev'],
  'zh-tech-11': [...ZH_TECH, 'docs.python.org'],
  'zh-tech-12': [...ZH_TECH, 'tensorflow.org'],
  'zh-tech-13': [...ZH_TECH, 'cncf.io'],
  'zh-tech-14': [...ZH_TECH, 'git-scm.com'],

  // CHINESE — news (10)
  'zh-news-06': ZH_NEWS,
  'zh-news-07': ZH_NEWS,
  'zh-news-08': ZH_NEWS,
  'zh-news-09': ZH_NEWS,
  'zh-news-10': ZH_NEWS,
  'zh-news-11': ZH_NEWS,
  'zh-news-12': ZH_NEWS,
  'zh-news-13': ZH_NEWS,
  'zh-news-14': ZH_NEWS,
  'zh-news-15': ZH_NEWS,

  // CHINESE — general (10)
  'zh-general-06': ZH_GENERAL,
  'zh-general-07': ZH_GENERAL,
  'zh-general-08': ZH_GENERAL,
  'zh-general-09': ZH_GENERAL,
  'zh-general-10': ZH_GENERAL,
  'zh-general-11': ZH_GENERAL,
  'zh-general-12': ZH_GENERAL,
  'zh-general-13': ZH_GENERAL,
  'zh-general-14': ZH_GENERAL,
  'zh-general-15': ZH_GENERAL,

  // CHINESE — travel (5)
  'zh-travel-01': ZH_TRAVEL,
  'zh-travel-02': ZH_TRAVEL,
  'zh-travel-03': ZH_TRAVEL,
  'zh-travel-04': ZH_TRAVEL,
  'zh-travel-05': ZH_TRAVEL,

  // JAPANESE — factual (8)
  'ja-fact-05': JA_FACT,
  'ja-fact-06': JA_FACT,
  'ja-fact-07': JA_FACT,
  'ja-fact-08': JA_FACT,
  'ja-fact-09': JA_FACT,
  'ja-fact-10': JA_FACT,
  'ja-fact-11': JA_FACT,
  'ja-fact-12': JA_FACT,

  // JAPANESE — tech (8)
  'ja-tech-05': [...JA_TECH, 'docker.com'],
  'ja-tech-06': [...JA_TECH, 'kubernetes.io'],
  'ja-tech-07': [...JA_TECH, 'developer.mozilla.org'],
  'ja-tech-08': JA_TECH,
  'ja-tech-09': [...JA_TECH, 'aws.amazon.com'],
  'ja-tech-10': [...JA_TECH, 'tensorflow.org'],
  'ja-tech-11': [...JA_TECH, 'ipa.go.jp'],
  'ja-tech-12': [...JA_TECH, 'swagger.io'],

  // JAPANESE — news (8)
  'ja-news-05': [...JA_NEWS, 'digital.go.jp'],
  'ja-news-06': JA_NEWS,
  'ja-news-07': [...JA_NEWS, 'k-tai.watch.impress.co.jp'],
  'ja-news-08': [...JA_NEWS, 'famitsu.com'],
  'ja-news-09': [...JA_NEWS, 'jaxa.jp'],
  'ja-news-10': [...JA_NEWS, 'meti.go.jp'],
  'ja-news-11': JA_NEWS,
  'ja-news-12': [...JA_NEWS, 'digital.go.jp'],

  // JAPANESE — general / travel (15)
  'ja-general-05': [...JA_GENERAL, 'welcome2japan.jp'],
  'ja-general-06': JA_GENERAL,
  'ja-general-07': JA_GENERAL,
  'ja-general-08': JA_GENERAL,
  'ja-general-09': [...JA_GENERAL, 'bookmeter.com', 'honto.jp'],
  'ja-general-10': JA_GENERAL,
  'ja-general-11': [...JA_GENERAL, 'kurashiru.com', 'cookpad.com'],
  'ja-travel-05': [...JA_GENERAL, 'japan-guide.com'],
  'ja-travel-06': [...JA_GENERAL, 'japan-guide.com'],
  'ja-travel-07': [...JA_GENERAL, 'japan-guide.com'],
  'ja-travel-08': [...JA_GENERAL, 'japan-guide.com'],

  // CROSS-CUTTING — comparison (12)
  'cmp-10': ['kubernetes.io', 'docker.com', 'github.com'],
  'cmp-11': ['redis.io', 'memcached.org', 'stackoverflow.com'],
  'cmp-12': ['sqlite.org', 'duckdb.org', 'github.com'],
  'cmp-13': ['fastapi.tiangolo.com', 'expressjs.com', 'github.com'],
  'cmp-14': ['prisma.io', 'typeorm.io', 'github.com'],
  'cmp-15': ['vitest.dev', 'jestjs.io', 'github.com'],
  'cmp-16': ['turborepo.com', 'nx.dev', 'github.com'],
  'cmp-17': ['playwright.dev', 'cypress.io', 'github.com'],
  'cmp-18': ['pytorch.org', 'tensorflow.org', 'github.com'],
  'cmp-19': ['snowflake.com', 'cloud.google.com', 'stackoverflow.com'],
  'cmp-20': ['apple.com', 'linux.org', 'reddit.com'],
  'cmp-21': ['aws.amazon.com', 'docker.com', 'serverless.com'],

  // CROSS-CUTTING — long-tail (10)
  'lt-09': ['developers.cloudflare.com', 'turso.tech', 'github.com'],
  'lt-10': ['hono.dev', 'github.com'],
  'lt-11': ['developers.cloudflare.com', 'github.com'],
  'lt-12': ['qwik.dev', 'react.dev', 'github.com'],
  'lt-13': ['bun.sh', 'github.com'],
  'lt-14': ['biomejs.dev', 'eslint.org', 'github.com'],
  'lt-15': ['zod.dev', 'valibot.dev', 'github.com'],
  'lt-16': ['developers.cloudflare.com', 'github.com'],
  'lt-17': ['developers.cloudflare.com', 'github.com'],
  'lt-18': ['developers.cloudflare.com', 'github.com'],

  // CROSS-CUTTING — general knowledge (10)
  'gk-08': ['en.wikipedia.org', 'investopedia.com'],
  'gk-09': ['en.wikipedia.org', 'britannica.com'],
  'gk-10': ['en.wikipedia.org', 'submarinecablemap.com'],
  'gk-11': ['nasa.gov', 'en.wikipedia.org'],
  'gk-12': ['investopedia.com', 'sec.gov', 'en.wikipedia.org'],
  'gk-13': ['noaa.gov', 'britannica.com'],
  'gk-14': ['en.wikipedia.org', 'aclanthology.org'],
  'gk-15': ['starlink.com', 'en.wikipedia.org'],
  'gk-16': ['en.wikipedia.org', 'towardsdatascience.com'],
  'gk-17': ['en.wikipedia.org', 'nvidia.com', 'towardsdatascience.com'],

  // CROSS-CUTTING — adversarial (8)
  'adv-06': ['nasa.gov', 'en.wikipedia.org'],
  'adv-07': ['en.wikipedia.org', 'stanford.edu', 'mit.edu'],
  'adv-08': ['stackoverflow.com', 'en.wikipedia.org'],
  'adv-09': ['stackoverflow.com', 'db-engines.com'],
  'adv-10': ['openai.com', 'deepmind.google', 'arxiv.org'],
  'adv-11': ['reddit.com', 'stackoverflow.com'],
  'adv-12': ['opensource.org', 'redhat.com'],
  'adv-13': ['en.wikipedia.org', 'stackoverflow.com'],

  // CROSS-CUTTING — temporal (5)
  'ts-05': [...EN_NEWS, 'macrumors.com', '9to5mac.com'],
  'ts-06': [...EN_NEWS, 'nobelprize.org'],
  'ts-07': [...EN_NEWS, 'android.com'],
  'ts-08': [...EN_NEWS, 'ces.tech'],
  'ts-09': [...EN_NEWS, 'fifa.com'],

  // CROSS-CUTTING — domain-specific (10)
  'ds-06': ['arxiv.org', 'github.com', 'pinecone.io'],
  'ds-07': ['arxiv.org', 'weaviate.io', 'opensearch.org'],
  'ds-08': ['arxiv.org', 'huggingface.co', 'sbert.net'],
  'ds-09': ['arxiv.org', 'docs.scrapy.org', 'github.com'],
  'ds-10': ['arxiv.org', 'cs.cornell.edu'],
  'ds-11': ['arxiv.org', 'anthropic.com'],
  'ds-12': ['github.com', 'langchain.com', 'microsoft.com'],
  'ds-13': ['arxiv.org', 'neo4j.com'],
  'ds-14': ['arxiv.org', 'aclweb.org'],
  'ds-15': ['arxiv.org', 'dl.acm.org'],

  // CROSS-CUTTING — cross-language (5)
  'xl-04': ['zhihu.com', '36kr.com', 'openai.com'],
  'xl-05': ['qiita.com', 'itmedia.co.jp', 'aws.amazon.com'],
  'xl-07': ['itmedia.co.jp', 'nikkei.com', 'zenn.dev'],
  'xl-08': ['ja.wikipedia.org', 'nikkei.com', 'itmedia.co.jp'],
}

// ── Merge & write ──────────────────────────────────────────────────────────
const gold = JSON.parse(readFileSync(GOLD_PATH, 'utf-8')) as Record<string, unknown>

let added = 0
let skipped = 0
for (const [id, domains] of Object.entries(NEW_GOLD)) {
  if (gold[id]) {
    console.warn(`⚠️  ${id} already has a gold standard — skipped (existing kept)`)
    skipped++
    continue
  }
  const unique = [...new Set(domains.map((d) => d.trim()).filter(Boolean))]
  gold[id] = { relevantDomains: unique }
  added++
}

writeFileSync(GOLD_PATH, `${JSON.stringify(gold, null, 2)}\n`, 'utf-8')

// ── Validation: subsumption-pair guard (S52) ───────────────────────────────
// S50's GOLD-AUTHORING WARNING forbids label-suffix subsumption pairs within a
// single query's gold (docker.com + docs.docker.com both match docs.docker.com
// results → the S50 DCG cap under-counts when only the subdomain variant
// surfaces). S52 deduped the 7 existing pairs in the JSON; this guard keeps
// NEW_GOLD from reintroducing them. kr-tech-05 was the former exemption —
// S56 proved aws.amazon.com + amazon.com IS a forbidden subsumption pair
// (amazon.com retail never appears in pools; it only absorbed the second
// aws.amazon.com slot via label-suffix), so the gold was narrowed to
// [aws.amazon.com] alone (S63) and the exemption removed — the guard now
// covers every NEW_GOLD entry unconditionally.
for (const [id, domains] of Object.entries(NEW_GOLD)) {
  for (const a of domains) {
    for (const b of domains) {
      if (a !== b && a.endsWith(`.${b}`)) {
        console.warn(
          `⚠️  S52 guard: ${id} has subsumption pair ${b} ⊃ ${a} — the broader ${b} already matches ${a} via label-suffix. Keep only ONE (prefer the broad registrable domain; see S52).`,
        )
      }
    }
  }
}

// ── Validation: every query in EVAL_QUERIES must have gold ─────────────────
const queriesSrc = readFileSync(join(process.cwd(), 'eval', 'queries.ts'), 'utf-8')
const expansionSrc = readFileSync(join(process.cwd(), 'eval', 'queries-expansion.ts'), 'utf-8')
const queryIds = [
  ...queriesSrc.matchAll(/id: '([^']+)'/g),
  ...expansionSrc.matchAll(/id: '([^']+)'/g),
].map((m) => m[1])
const goldKeys = new Set(Object.keys(gold).filter((k) => !k.startsWith('_')))
const missing = queryIds.filter((id) => !goldKeys.has(id))
const orphan = [...goldKeys].filter((id) => !queryIds.includes(id))

console.log(`\n✅ Added ${added} new gold standards (${skipped} skipped as existing)`)
console.log(`📊 Total gold entries: ${goldKeys.size} | Total queries: ${queryIds.length}`)
if (missing.length > 0) console.warn(`⚠️  Queries WITHOUT gold: ${missing.join(', ')}`)
if (orphan.length > 0) console.warn(`⚠️  Gold entries NOT in queries: ${orphan.join(', ')}`)
if (missing.length === 0 && orphan.length === 0) console.log('✅ Coverage: every query has a gold standard (1:1)')
