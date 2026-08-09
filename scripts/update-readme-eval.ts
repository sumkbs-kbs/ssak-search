/**
 * Update README.md search-quality metrics section from eval/results/latest.json.
 *
 * Usage:
 *   npx tsx scripts/update-readme-eval.ts
 *
 * Replaces the "## 검색 품질 테스트 결과" section (up to the next "## " heading)
 * with a metrics table generated from the latest eval run. Exits 0 on success,
 * 1 when eval results are missing/invalid. Idempotent — safe to run repeatedly.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const README_PATH = join(process.cwd(), 'README.md')
const RESULTS_PATH = join(process.cwd(), 'eval', 'results', 'latest.json')

interface LatestReport {
  report?: {
    timestamp: string
    totalQueries: number
    passedQueries: number
    failedQueries: number
    passRate: number
    avgTimeMs: number
    avgResultCount: number
    latencyPercentiles: { p50: number; p95: number; p99: number }
    qps: { avgQps: number }
    // S80-①: `skipped` — warm re-runs skipped because their cold run failed
    // (no cache entry stored). Excluded from the hitRate denominator and
    // reported so hits+misses < totalQueries stays transparent.
    cache?: {
      hitRate: number
      hits: number
      misses: number
      skipped: number
      avgColdMs: number
      avgWarmMs: number
    }
    ranking?: { queriesWithGoldStandard: number; avgNdcgAt10: number; avgMrr: number; avgPrecisionAt10: number }
  }
}

export function buildMetricsSection(r: NonNullable<LatestReport['report']>): string {
  const rows: string[] = []
  rows.push('## 검색 품질 테스트 결과 (자동 측정)')
  rows.push('')
  rows.push(`> 주간 eval 하네스가 자동 생성한 정량 메트릭 (${r.timestamp}). 수동 수정 금지 — `)
  rows.push(`> ` + '`npm run eval -- --cache --json` 실행 시 `scripts/update-readme-eval.ts`가 이 섹션을 갱신합니다.')
  rows.push('')
  rows.push('| 메트릭 | 값 |')
  rows.push('|--------|-----|')
  rows.push(`| **Pass Rate** | ${(r.passRate * 100).toFixed(1)}% (${r.passedQueries}/${r.totalQueries}) |`)
  rows.push(`| **평균 결과 수** | ${r.avgResultCount}건 |`)
  rows.push(
    `| **p50 / p95 / p99 지연시간** | ${r.latencyPercentiles.p50}ms / ${r.latencyPercentiles.p95}ms / ${r.latencyPercentiles.p99}ms |`,
  )
  rows.push(`| **평균 응답 시간** | ${r.avgTimeMs}ms |`)
  rows.push(`| **Avg QPS** | ${r.qps.avgQps} |`)
  if (r.ranking && r.ranking.queriesWithGoldStandard > 0) {
    rows.push(`| **NDCG@10** | ${r.ranking.avgNdcgAt10.toFixed(4)} (gold ${r.ranking.queriesWithGoldStandard}개) |`)
    rows.push(`| **MRR@10** | ${r.ranking.avgMrr.toFixed(4)} |`)
    rows.push(`| **Precision@10** | ${r.ranking.avgPrecisionAt10.toFixed(4)} |`)
  }
  if (r.cache) {
    // S80-①: `skipped` (warm re-runs skipped because their cold run failed)
    // is ALWAYS shown next to hitRate when present — even 0 — so the
    // denominator stays transparent: hitRate = hits/(hits+misses) and
    // hits+misses < totalQueries exactly when skipped > 0. Pre-S80-①
    // artifacts have no `skipped` field → omit the suffix entirely (the
    // field's absence already means "0 skips, legacy denominator").
    // NOTE: eval/reporter.ts shows `Skipped: N` only when skipped > 0 — this
    // README row intentionally always shows it (denominator transparency for
    // a machine-regenerated table), a deliberate difference.
    const skippedNote = r.cache.skipped !== undefined ? ` (skipped ${r.cache.skipped})` : ''
    rows.push(
      `| **Cache Hit Rate** | ${(r.cache.hitRate * 100).toFixed(1)}% (${r.cache.hits}/${r.cache.hits + r.cache.misses})${skippedNote} |`,
    )
    rows.push(`| **Cache avg cold→warm** | ${r.cache.avgColdMs}ms → ${r.cache.avgWarmMs}ms |`)
  }
  rows.push('')
  return rows.join('\n')
}

function main(): void {
  if (!existsSync(RESULTS_PATH)) {
    console.error(`eval results not found: ${RESULTS_PATH}`)
    console.error('Run `npm run eval:cache -- --json` first.')
    process.exit(1)
  }

  const parsed = JSON.parse(readFileSync(RESULTS_PATH, 'utf-8')) as LatestReport
  if (!parsed.report) {
    console.error('eval results missing "report" — invalid latest.json')
    process.exit(1)
  }

  const readme = readFileSync(README_PATH, 'utf-8')
  const sectionStart = readme.indexOf('## 검색 품질 테스트 결과')
  if (sectionStart === -1) {
    console.error('README.md missing "## 검색 품질 테스트 결과" section — aborting')
    process.exit(1)
  }

  // Section ends at the next "## " heading (or EOF)
  const rest = readme.slice(sectionStart + '## 검색 품질 테스트 결과'.length)
  const sectionEnd = rest.indexOf('\n## ')
  const nextHeadingAt =
    sectionEnd === -1 ? readme.length : sectionStart + '## 검색 품질 테스트 결과'.length + sectionEnd

  const updated = readme.slice(0, sectionStart) + buildMetricsSection(parsed.report) + readme.slice(nextHeadingAt)
  writeFileSync(README_PATH, updated, 'utf-8')
  console.log('README.md metrics section updated.')
}

// Run only when executed directly (not when imported by tests).
const isDirectRun =
  process.argv[1] && resolve(process.argv[1]) === resolve(process.cwd(), 'scripts', 'update-readme-eval.ts')
if (isDirectRun) main()
