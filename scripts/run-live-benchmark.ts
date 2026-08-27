/**
 * Real-world E2E Benchmark Runner (Direct Module Execution)
 * Tests executeFastAgentSearch & extractWithStealthEscalation with live web traffic.
 */

import { executeFastAgentSearch } from '../src/lib/agent-search-orchestrator'
import { extractWithStealthEscalation } from '../src/lib/agent-extractor'

interface BenchmarkRow {
  Task: string
  QueryOrUrl: string
  LatencyMs: number
  ResultOrTokens: string
  Status: string
}

async function runLiveBenchmark() {
  console.log('\n======================================================================')
  console.log('🚀 LIVE AGENT PIPELINE REAL-WORLD E2E BENCHMARK')
  console.log('======================================================================\n')

  const results: BenchmarkRow[] = []

  // -------------------------------------------------------------
  // Test 1: Real-time Korean Stock & News Query
  // -------------------------------------------------------------
  console.log('1️⃣ Running Fast Search: "삼성전자 오늘 주가" ...')
  const t1 = performance.now()
  const search1 = await executeFastAgentSearch('삼성전자 오늘 주가', 3, 0.8, 3000)
  const l1 = Math.round(performance.now() - t1)
  console.log(`   └─ Done in ${l1}ms | Hits: ${search1.hits.length} | Confidence: ${search1.signal_confidence}`)
  if (search1.hits[0]) {
    console.log(`   └─ Top Hit: [${search1.hits[0].title}] -> ${search1.hits[0].url}`)
  }
  results.push({
    Task: 'Fast Search (KR)',
    QueryOrUrl: '삼성전자 오늘 주가',
    LatencyMs: l1,
    ResultOrTokens: `${search1.hits.length} hits (${search1.hits[0]?.title.slice(0, 30)}...)`,
    Status: search1.hits.length > 0 ? 'PASS ✅' : 'FAIL ❌',
  })

  // -------------------------------------------------------------
  // Test 2: Global Tech Query (Early Abort Benchmark)
  // -------------------------------------------------------------
  console.log('\n2️⃣ Running Fast Search: "Anthropic Claude 3.7 reasoning" ...')
  const t2 = performance.now()
  const search2 = await executeFastAgentSearch('Anthropic Claude 3.7 reasoning', 3, 0.8, 3000)
  const l2 = Math.round(performance.now() - t2)
  console.log(`   └─ Done in ${l2}ms | Hits: ${search2.hits.length} | Confidence: ${search2.signal_confidence}`)
  if (search2.hits[0]) {
    console.log(`   └─ Top Hit: [${search2.hits[0].title}] -> ${search2.hits[0].url}`)
  }
  results.push({
    Task: 'Fast Search (Global)',
    QueryOrUrl: 'Anthropic Claude 3.7 reasoning',
    LatencyMs: l2,
    ResultOrTokens: `${search2.hits.length} hits (${search2.hits[0]?.title.slice(0, 30)}...)`,
    Status: search2.hits.length > 0 ? 'PASS ✅' : 'FAIL ❌',
  })

  // -------------------------------------------------------------
  // Test 3: Stealth Extraction (Wikipedia - Full Markdown & TOC)
  // -------------------------------------------------------------
  const wikiUrl = 'https://en.wikipedia.org/wiki/Artificial_intelligence'
  console.log(`\n3️⃣ Running Stealth Extract on: ${wikiUrl} ...`)
  const t3 = performance.now()
  const ext1 = await extractWithStealthEscalation(wikiUrl, {
    maxTokens: 2000,
    extractDepth: 'full_markdown',
  })
  const l3 = Math.round(performance.now() - t3)
  console.log(`   └─ Done in ${l3}ms | Escalation Tier: ${ext1.escalation_tier} | Tokens: ~${ext1.token_count}`)
  console.log(`   └─ TOC Headings count: ${ext1.table_of_contents?.length || 0}`)
  console.log(`   └─ Content Preview:\n${ext1.markdown_content?.slice(0, 200)}...\n`)
  results.push({
    Task: 'Stealth Extract (Wiki)',
    QueryOrUrl: wikiUrl,
    LatencyMs: l3,
    ResultOrTokens: `~${ext1.token_count} tokens, TOC: ${ext1.table_of_contents?.length || 0} items`,
    Status: ext1.success && (ext1.markdown_content?.length || 0) > 200 ? 'PASS ✅' : 'FAIL ❌',
  })

  // -------------------------------------------------------------
  // Test 4: On-Demand Section Extraction (Targeted Heading)
  // -------------------------------------------------------------
  console.log(`\n4️⃣ Running Section Targeted Extract (Section: "Ethics") on: ${wikiUrl} ...`)
  const t4 = performance.now()
  const ext2 = await extractWithStealthEscalation(wikiUrl, {
    maxTokens: 1000,
    sectionTarget: 'Ethics',
  })
  const l4 = Math.round(performance.now() - t4)
  console.log(`   └─ Done in ${l4}ms | Tokens: ~${ext2.token_count}`)
  console.log(`   └─ Targeted Content Preview:\n${ext2.markdown_content?.slice(0, 200)}...\n`)
  results.push({
    Task: 'Section Target Extract',
    QueryOrUrl: 'Section: Ethics',
    LatencyMs: l4,
    ResultOrTokens: `~${ext2.token_count} tokens (Filtered)`,
    Status:
      ext2.success && (ext2.markdown_content?.includes('Ethics') || (ext2.markdown_content?.length || 0) > 50)
        ? 'PASS ✅'
        : 'FAIL ❌',
  })

  // -------------------------------------------------------------
  // Test 5: Self-Healing 404 Recovery Contract
  // -------------------------------------------------------------
  const deadUrl = 'https://httpbin.org/status/404'
  console.log(`\n5️⃣ Running Self-Healing Error Recovery on Dead URL: ${deadUrl} ...`)
  const t5 = performance.now()
  const ext3 = await extractWithStealthEscalation(deadUrl, { maxTokens: 1000 })
  const l5 = Math.round(performance.now() - t5)
  console.log(`   └─ Done in ${l5}ms | Success: ${ext3.success}`)
  console.log(`   └─ Error Code: ${ext3.error?.code}`)
  console.log(`   └─ Agent Actionable Hint: "${ext3.error?.agent_hint}"`)
  console.log(`   └─ Suggested Action: ${ext3.error?.suggested_action}`)
  results.push({
    Task: 'Self-Healing 404 Test',
    QueryOrUrl: deadUrl,
    LatencyMs: l5,
    ResultOrTokens: `Error Code: ${ext3.error?.code}, Hint provided: ${Boolean(ext3.error?.agent_hint)}`,
    Status: !ext3.success && ext3.error?.agent_hint ? 'PASS ✅' : 'FAIL ❌',
  })

  // -------------------------------------------------------------
  // Benchmark Summary Table
  // -------------------------------------------------------------
  console.log('\n======================================================================')
  console.log('📊 REAL-WORLD BENCHMARK RESULTS TABLE')
  console.log('======================================================================')
  // eslint-disable-next-line no-console
  console.table(results)

  const avgLatency = Math.round(results.reduce((acc, r) => acc + r.LatencyMs, 0) / results.length)
  const passCount = results.filter((r) => r.Status.includes('PASS')).length
  const passRate = ((passCount / results.length) * 100).toFixed(1)

  console.log(`\n🎯 Final Statistics:`)
  console.log(`- Total Tests Run : ${results.length}`)
  console.log(`- Pass Rate       : ${passRate}% (${passCount}/${results.length})`)
  console.log(`- Average Latency : ${avgLatency} ms`)
  console.log('======================================================================\n')
}

runLiveBenchmark().catch((err) => {
  console.error('Benchmark execution error:', err)
  process.exit(1)
})
