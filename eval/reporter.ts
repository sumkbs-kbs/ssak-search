import type { EvalReport, RegressionDiff } from './types'

/**
 * Format an eval report as a human-readable string.
 */
export function formatReport(report: EvalReport, regressions: RegressionDiff[]): string {
  const lines: string[] = []

  lines.push('='.repeat(60))
  lines.push('  SEARCH QUALITY EVAL REPORT')
  lines.push('='.repeat(60))
  lines.push('')
  lines.push(`  Timestamp:     ${report.timestamp}`)
  if (report.runs && report.runs.count > 1) {
    lines.push(`  Mode:          MEDIAN of ${report.runs.count} runs (robust to backend noise)`)
  }
  lines.push(`  Total queries: ${report.totalQueries}`)
  lines.push(`  Passed:        ${report.passedQueries}`)
  lines.push(`  Failed:        ${report.failedQueries}`)
  lines.push(`  Pass rate:     ${(report.passRate * 100).toFixed(1)}%`)
  lines.push(`  Avg time:      ${report.avgTimeMs}ms`)
  lines.push(`  Avg results:   ${report.avgResultCount}`)
  lines.push('')
  lines.push('  ─ Latency Distribution ─')
  lines.push(`  p50:     ${report.latencyPercentiles.p50}ms`)
  lines.push(`  p75:     ${report.latencyPercentiles.p75}ms`)
  lines.push(`  p90:     ${report.latencyPercentiles.p90}ms`)
  lines.push(`  p95:     ${report.latencyPercentiles.p95}ms`)
  lines.push(`  p99:     ${report.latencyPercentiles.p99}ms`)
  lines.push(`  min:     ${report.latencyPercentiles.min}ms`)
  lines.push(`  max:     ${report.latencyPercentiles.max}ms`)
  lines.push('')
  lines.push('  ─ Throughput ─')
  lines.push(`  Avg QPS:       ${report.qps.avgQps}`)
  lines.push(`  Peak QPS:      ${report.qps.peakQps}`)
  lines.push(`  Total time:    ${report.qps.totalDurationMs}ms`)
  const tagEntries = Object.entries(report.qps.byTag)
  if (tagEntries.length > 0) {
    lines.push(`  QPS by tag:`)
    for (const [tag, qps] of tagEntries.sort()) {
      lines.push(`    ${tag.padEnd(15)} ${qps.toFixed(2)}`)
    }
  }
  lines.push('')

  // Cache hit rate (measured via cold/warm double-run when --cache is set)
  if (report.cache) {
    const c = report.cache
    lines.push('  ─ Cache Hit Rate ─')
    lines.push(`  Hit rate:      ${(c.hitRate * 100).toFixed(1)}% (${c.hits}/${c.hits + c.misses})`)
    lines.push(`  Avg cold:      ${c.avgColdMs}ms  →  Avg warm: ${c.avgWarmMs}ms`)
    lines.push('')
  }
  lines.push('  Backend coverage:')
  for (const [backend, count] of Object.entries(report.backendCoverage).sort()) {
    const pct = ((count / report.totalQueries) * 100).toFixed(0)
    lines.push(`    ${backend.padEnd(20)} ${'█'.repeat(Math.round(Number(pct) / 10))} ${count}/${report.totalQueries} (${pct}%)`)
  }
  lines.push('')

  // Per-query results
  lines.push('  ─'.repeat(50))
  for (const r of report.results) {
    const status = r.passed ? '✅' : '❌'
    const tag = r.query.tags?.join(', ') ?? ''
    lines.push(`  ${status} ${r.query.id.padEnd(20)} ${r.resultCount} results  ${r.responseTimeMs}ms  [${tag}]`)
    if (r.backends.length > 0) {
      lines.push(`     backends: ${r.backends.join(', ')}`)
    }
    for (const f of r.failures) {
      lines.push(`     ⚠  ${f}`)
    }
  }
  lines.push('')

  // Regressions
  if (regressions.length > 0) {
    lines.push('  ⚠  REGRESSIONS DETECTED:')
    lines.push('  ' + '─'.repeat(50))
    for (const d of regressions) {
      lines.push(`     ❌ ${d.queryId}: ${d.metric} (was ${d.baseline}, now ${d.current})`)
    }
    lines.push('')
  } else {
    lines.push('  ✅ No regressions detected.')
    lines.push('')
  }

  return lines.join('\n')
}

/**
 * Format an eval report as JSON (useful for CI artifacts).
 */
export function formatReportJSON(report: EvalReport, regressions: RegressionDiff[]): string {
  return JSON.stringify({ report, regressions }, null, 2)
}

/**
 * Format an eval report as GitHub Actions Step Summary markdown.
 */
export function formatReportSummary(report: EvalReport, regressions: RegressionDiff[]): string {
  const lines: string[] = []

  lines.push('## 🔍 Search Quality Evaluation Report')
  lines.push('')
  lines.push('| Metric | Value |')
  lines.push('|--------|-------|')
  lines.push(`| **Timestamp** | ${report.timestamp} |`)
  if (report.runs && report.runs.count > 1) {
    lines.push(`| **Mode** | Median of ${report.runs.count} runs (${report.runs.timestamps.length} source reports) |`)
  }
  lines.push(`| **Total Queries** | ${report.totalQueries} |`)
  lines.push(`| **Passed** | ${report.passedQueries} |`)
  lines.push(`| **Failed** | ${report.failedQueries} |`)
  lines.push(`| **Pass Rate** | ${(report.passRate * 100).toFixed(1)}% |`)
  lines.push(`| **Avg Response Time** | ${report.avgTimeMs}ms |`)
  lines.push(`| **Avg Results/Query** | ${report.avgResultCount} |`)
  lines.push('')
  lines.push('### Latency Distribution')
  lines.push('')
  lines.push('| Metric | Value |')
  lines.push('|--------|-------|')
  lines.push(`| **p50** | ${report.latencyPercentiles.p50}ms |`)
  lines.push(`| **p75** | ${report.latencyPercentiles.p75}ms |`)
  lines.push(`| **p90** | ${report.latencyPercentiles.p90}ms |`)
  lines.push(`| **p95** | ${report.latencyPercentiles.p95}ms |`)
  lines.push(`| **p99** | ${report.latencyPercentiles.p99}ms |`)
  lines.push(`| **min** | ${report.latencyPercentiles.min}ms |`)
  lines.push(`| **max** | ${report.latencyPercentiles.max}ms |`)
  lines.push('')

  // Phase 4: Ranking-quality metrics (NDCG@10 / MRR / Precision@10)
  if (report.ranking && report.ranking.queriesWithGoldStandard > 0) {
    lines.push('### Ranking Quality (Gold Standard)')
    lines.push('')
    lines.push('| Metric | Value |')
    lines.push('|--------|-------|')
    lines.push(`| **Queries with Gold Standard** | ${report.ranking.queriesWithGoldStandard} |`)
    lines.push(`| **Avg NDCG@10** | ${report.ranking.avgNdcgAt10.toFixed(4)} |`)
    lines.push(`| **Avg MRR** | ${report.ranking.avgMrr.toFixed(4)} |`)
    lines.push(`| **Avg Precision@10** | ${report.ranking.avgPrecisionAt10.toFixed(4)} |`)
    lines.push('')
  }
  lines.push('### Throughput')
  lines.push('')
  lines.push('| Metric | Value |')
  lines.push('|--------|-------|')
  lines.push(`| **Avg QPS** | ${report.qps.avgQps} |`)
  lines.push(`| **Peak QPS** | ${report.qps.peakQps} |`)
  lines.push(`| **Total Duration** | ${report.qps.totalDurationMs}ms |`)
  const summaryTagEntries = Object.entries(report.qps.byTag)
  if (summaryTagEntries.length > 0) {
    lines.push('')
    lines.push('### QPS by Tag')
    lines.push('')
    lines.push('| Tag | QPS |')
    lines.push('|-----|-----|')
    for (const [tag, qps] of summaryTagEntries.sort()) {
      lines.push(`| ${tag} | ${qps.toFixed(2)} |`)
    }
  }
  lines.push('')

  // Cache hit rate section
  if (report.cache) {
    const c = report.cache
    lines.push('### Cache Hit Rate (cold/warm double-run)')
    lines.push('')
    lines.push('| Metric | Value |')
    lines.push('|--------|-------|')
    lines.push(`| **Hit Rate** | ${(c.hitRate * 100).toFixed(1)}% (${c.hits}/${c.hits + c.misses}) |`)
    lines.push(`| **Avg Cold Latency** | ${c.avgColdMs}ms |`)
    lines.push(`| **Avg Warm Latency** | ${c.avgWarmMs}ms |`)
    lines.push('')
  }

  // Per-query details
  lines.push('### Per-Query Results')
  lines.push('')
  lines.push('| Query | Status | Results | Time | Backends | Failures |')
  lines.push('|-------|--------|---------|------|----------|----------|')
  for (const r of report.results) {
    const status = r.passed ? '✅' : '❌'
    const backends = r.backends.join(', ') || '—'
    const failures = r.failures.length > 0 ? r.failures.join('; ') : '—'
    lines.push(`| ${r.query.id} | ${status} | ${r.resultCount} | ${r.responseTimeMs}ms | ${backends} | ${failures} |`)
  }
  lines.push('')

  // Backend coverage
  lines.push('### Backend Coverage')
  lines.push('')
  lines.push('| Backend | Queries | Coverage |')
  lines.push('|---------|---------|----------|')
  for (const [backend, count] of Object.entries(report.backendCoverage).sort()) {
    const pct = ((count / report.totalQueries) * 100).toFixed(0)
    lines.push(`| ${backend} | ${count}/${report.totalQueries} | ${pct}% |`)
  }
  lines.push('')

  // Regressions
  if (regressions.length > 0) {
    lines.push('### ⚠️ Regressions Detected')
    lines.push('')
    lines.push('| Query | Metric | Baseline | Current | Delta |')
    lines.push('|-------|--------|----------|---------|-------|')
    for (const d of regressions) {
      lines.push(`| ${d.queryId} | ${d.metric} | ${d.baseline} | ${d.current} | ${d.delta} |`)
    }
    lines.push('')
  } else {
    lines.push('### ✅ No Regressions')
    lines.push('')
  }

  return lines.join('\n')
}
