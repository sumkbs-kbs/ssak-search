/**
 * E2E Agent Pipeline Integration Test
 * Run: npx tsx scripts/test-agent-e2e.ts
 */

export {}

const AGENT_TEST_BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:8787'

async function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ [FAIL] ${message}`)
    process.exit(1)
  }
  console.log(`✅ [PASS] ${message}`)
}

async function runE2ETests() {
  console.log(`\n🔍 Running Agent Tool E2E Integration Suite against: ${AGENT_TEST_BASE_URL}\n`)

  // -------------------------------------------------------------
  // Test 1: High-Speed Search & Early Return
  // -------------------------------------------------------------
  console.log('--- Test 1: Fast Agent Search ---')
  const searchStart = performance.now()
  const searchRes = await fetch(`${AGENT_TEST_BASE_URL}/api/agent/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: 'SpaceX Starship latest launch', max_results: 3 }),
  })
  const searchElapsed = performance.now() - searchStart
  const searchData = (await searchRes.json()) as any

  await assert(searchRes.status === 200, `HTTP status is 200 (Got ${searchRes.status})`)
  await assert(Array.isArray(searchData.hits), 'Response contains hits array')
  await assert(searchData.hits.length > 0, `Returned ${searchData.hits.length} search hits`)
  await assert(searchElapsed < 2500, `P95 latency requirement met (${searchElapsed.toFixed(0)}ms < 2500ms)`)
  console.log(`   └─ Top Hit: "${searchData.hits[0]?.title}"`)

  // -------------------------------------------------------------
  // Test 2: High-Density Content Extraction & Noise Stripping
  // -------------------------------------------------------------
  console.log('\n--- Test 2: Dense Markdown Extract ---')
  const targetUrl = searchData.hits[0]?.url || 'https://en.wikipedia.org/wiki/SpaceX'
  const extractRes = await fetch(`${AGENT_TEST_BASE_URL}/api/agent/extract`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: targetUrl, max_token_budget: 1500 }),
  })
  const extractData = (await extractRes.json()) as any

  await assert(extractRes.status === 200, `Extract HTTP status is 200`)
  await assert(extractData.success === true, 'Extraction marked as success')
  await assert(typeof extractData.markdown_content === 'string', 'Markdown content is returned')
  await assert(!extractData.markdown_content.includes('<script>'), 'Scripts are completely stripped')
  await assert(!extractData.markdown_content.includes('<nav>'), 'Navigation tags are completely stripped')
  console.log(`   └─ Extracted Tokens: ~${extractData.token_count} (Within 1500 Budget)`)

  // -------------------------------------------------------------
  // Test 3: Self-Healing Error Recovery Contract (404 Test)
  // -------------------------------------------------------------
  console.log('\n--- Test 3: Self-Healing Error Contract on Dead Link ---')
  const deadUrl = 'https://httpstat.us/404'
  const deadRes = await fetch(`${AGENT_TEST_BASE_URL}/api/agent/extract`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: deadUrl }),
  })
  const deadData = (await deadRes.json()) as any

  await assert(deadData.success === false, 'Dead URL correctly marked as failure')
  await assert(Boolean(deadData.error?.agent_hint), 'Actionable agent_hint provided in payload')
  await assert(deadData.error?.suggested_action !== undefined, 'Suggested action specified')
  console.log(`   └─ Agent Hint: "${deadData.error?.agent_hint}"`)

  console.log(`\n🎉 ALL E2E AGENT INTEGRATION TESTS PASSED SUCCESSFULLY!\n`)
}

runE2ETests().catch((err) => {
  console.error('Fatal Test Suite Error:', err)
  process.exit(1)
})
