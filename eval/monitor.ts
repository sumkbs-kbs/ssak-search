#!/usr/bin/env tsx
/**
 * Eval Monitor - Track pass rate, latency percentiles, and backend coverage over time
 *
 * Usage:
 *   npx tsx eval/monitor.ts              # Record current results + show trends
 *   npx tsx eval/monitor.ts --report     # Show full trend report
 *   npx tsx eval/monitor.ts --record     # Record only (no report)
 *   npx tsx eval/monitor.ts --diff       # Compare last 2 runs
 *   npx tsx eval/monitor.ts --alert      # Check for regressions and alert
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { EvalReport, LatencyPercentiles, RegressionDiff } from './types'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const HISTORY_FILE = join(__dirname, 'metrics-history.json')
const RESULTS_FILE = join(__dirname, 'results', 'latest.json')

// ============================================================
// Types
// ============================================================

interface MetricsSnapshot {
  timestamp: string
  passRate: number
  totalQueries: number
  passedQueries: number
  failedQueries: number
  latency: LatencyPercentiles
  avgTimeMs: number
  avgResultCount: number
  backendCoverage: Record<string, number>
  regressionCount?: number
}

interface MetricsHistory {
  snapshots: MetricsSnapshot[]
  lastUpdated: string
}

// ============================================================
// Data Loading
// ============================================================

function loadHistory(): MetricsHistory {
  if (!existsSync(HISTORY_FILE)) {
    return { snapshots: [], lastUpdated: new Date().toISOString() }
  }
  try {
    return JSON.parse(readFileSync(HISTORY_FILE, 'utf-8'))
  } catch {
    return { snapshots: [], lastUpdated: new Date().toISOString() }
  }
}

function saveHistory(history: MetricsHistory): void {
  history.lastUpdated = new Date().toISOString()
  writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf-8')
}

function loadLatestResults(): { report: EvalReport; regressions: RegressionDiff[] } | null {
  if (!existsSync(RESULTS_FILE)) {
    console.error('❌ No results file found at', RESULTS_FILE)
    return null
  }
  try {
    return JSON.parse(readFileSync(RESULTS_FILE, 'utf-8'))
  } catch {
    console.error('❌ Failed to parse results file')
    return null
  }
}

// ============================================================
// Metrics Extraction
// ============================================================

function extractSnapshot(report: EvalReport, regressions?: RegressionDiff[]): MetricsSnapshot {
  return {
    timestamp: report.timestamp,
    passRate: report.passRate,
    totalQueries: report.totalQueries,
    passedQueries: report.passedQueries,
    failedQueries: report.failedQueries,
    latency: report.latencyPercentiles,
    avgTimeMs: report.avgTimeMs,
    avgResultCount: report.avgResultCount,
    backendCoverage: report.backendCoverage,
    regressionCount: regressions?.length ?? 0,
  }
}

// ============================================================
// Trend Analysis
// ============================================================

interface Trend {
  metric: string
  current: number
  previous: number | null
  change: number | null
  changePercent: number | null
  direction: 'up' | 'down' | 'stable'
}

function analyzeTrends(history: MetricsSnapshot[]): Trend[] {
  if (history.length === 0) return []
  
  const current = history[history.length - 1]
  const previous = history.length >= 2 ? history[history.length - 2] : null
  
  const trends: Trend[] = []
  
  // Pass rate trend
  trends.push({
    metric: 'Pass Rate',
    current: current.passRate * 100,
    previous: previous ? previous.passRate * 100 : null,
    change: previous ? (current.passRate - previous.passRate) * 100 : null,
    changePercent: previous && previous.passRate > 0
      ? ((current.passRate - previous.passRate) / previous.passRate) * 100
      : null,
    direction: previous
      ? current.passRate > previous.passRate ? 'up'
      : current.passRate < previous.passRate ? 'down'
      : 'stable'
      : 'stable',
  })
  
  // Latency trends
  const latencyMetrics: Array<{ key: keyof LatencyPercentiles; label: string }> = [
    { key: 'p50', label: 'P50 Latency' },
    { key: 'p75', label: 'P75 Latency' },
    { key: 'p90', label: 'P90 Latency' },
    { key: 'p95', label: 'P95 Latency' },
    { key: 'p99', label: 'P99 Latency' },
  ]
  
  for (const { key, label } of latencyMetrics) {
    const currentVal = current.latency[key]
    const previousVal = previous?.latency[key] ?? null
    trends.push({
      metric: label,
      current: currentVal,
      previous: previousVal,
      change: previousVal !== null ? currentVal - previousVal : null,
      changePercent: previousVal && previousVal > 0
        ? ((currentVal - previousVal) / previousVal) * 100
        : null,
      direction: previousVal !== null
        ? currentVal < previousVal ? 'up'  // Lower latency is better
        : currentVal > previousVal ? 'down'
        : 'stable'
        : 'stable',
    })
  }
  
  // Avg time trend
  trends.push({
    metric: 'Avg Time',
    current: current.avgTimeMs,
    previous: previous?.avgTimeMs ?? null,
    change: previous ? current.avgTimeMs - previous.avgTimeMs : null,
    changePercent: previous && previous.avgTimeMs > 0
      ? ((current.avgTimeMs - previous.avgTimeMs) / previous.avgTimeMs) * 100
      : null,
    direction: previous
      ? current.avgTimeMs < previous.avgTimeMs ? 'up'
      : current.avgTimeMs > previous.avgTimeMs ? 'down'
      : 'stable'
      : 'stable',
  })
  
  // Regression count trend
  if (current.regressionCount !== undefined) {
    trends.push({
      metric: 'Regressions',
      current: current.regressionCount,
      previous: previous?.regressionCount ?? null,
      change: previous?.regressionCount !== undefined
        ? current.regressionCount - previous.regressionCount
        : null,
      changePercent: previous?.regressionCount && previous.regressionCount > 0
        ? ((current.regressionCount - previous.regressionCount) / previous.regressionCount) * 100
        : null,
      direction: previous?.regressionCount !== undefined
        ? current.regressionCount < previous.regressionCount ? 'up'
        : current.regressionCount > previous.regressionCount ? 'down'
        : 'stable'
        : 'stable',
    })
  }
  
  return trends
}

// ============================================================
// Backend Coverage Analysis
// ============================================================

interface BackendTrend {
  backend: string
  current: number
  previous: number | null
  change: number | null
  percentOfTotal: number
}

function analyzeBackendTrends(history: MetricsSnapshot[]): BackendTrend[] {
  if (history.length === 0) return []
  
  const current = history[history.length - 1]
  const previous = history.length >= 2 ? history[history.length - 2] : null
  
  const allBackends = new Set([
    ...Object.keys(current.backendCoverage),
    ...Object.keys(previous?.backendCoverage ?? {}),
  ])
  
  const trends: BackendTrend[] = []
  
  for (const backend of allBackends) {
    const currentCount = current.backendCoverage[backend] ?? 0
    const previousCount = previous?.backendCoverage[backend] ?? null
    const totalQueries = current.totalQueries
    
    trends.push({
      backend,
      current: currentCount,
      previous: previousCount,
      change: previousCount !== null ? currentCount - previousCount : null,
      percentOfTotal: totalQueries > 0 ? (currentCount / totalQueries) * 100 : 0,
    })
  }
  
  // Sort by current count descending
  trends.sort((a, b) => b.current - a.current)
  
  return trends
}

// ============================================================
// Report Generation
// ============================================================

function formatTrendArrow(direction: 'up' | 'down' | 'stable'): string {
  switch (direction) {
    case 'up': return '📈'
    case 'down': return '📉'
    case 'stable': return '➡️'
  }
}

function formatChange(change: number | null, changePercent: number | null, unit: string = ''): string {
  if (change === null) return '-'
  const sign = change >= 0 ? '+' : ''
  const percentStr = changePercent !== null ? ` (${sign}${changePercent.toFixed(1)}%)` : ''
  return `${sign}${change.toFixed(0)}${unit}${percentStr}`
}

function printReport(history: MetricsSnapshot[]): void {
  if (history.length === 0) {
    console.log('📊 No eval history found. Run an eval first.')
    return
  }
  
  const latest = history[history.length - 1]
  const trends = analyzeTrends(history)
  const backendTrends = analyzeBackendTrends(history)
  
  console.log('')
  console.log('╔══════════════════════════════════════════════════════════════════╗')
  console.log('║                    📊 EVAL MONITOR REPORT                       ║')
  console.log('╚══════════════════════════════════════════════════════════════════╝')
  console.log('')
  console.log(`📅 Latest run: ${latest.timestamp}`)
  console.log(`📊 Total snapshots: ${history.length}`)
  console.log('')
  
  // Summary metrics
  console.log('┌─────────────────────────────────────────────────────────────────┐')
  console.log('│                    CURRENT METRICS                              │')
  console.log('├─────────────────────────────────────────────────────────────────┤')
  console.log(`│ Pass Rate:      ${(latest.passRate * 100).toFixed(1)}% (${latest.passedQueries}/${latest.totalQueries})`)
  console.log(`│ Failed:         ${latest.failedQueries} queries`)
  console.log(`│ Avg Time:       ${latest.avgTimeMs.toFixed(0)}ms`)
  console.log(`│ Avg Results:    ${latest.avgResultCount.toFixed(1)}`)
  console.log(`│ Regressions:    ${latest.regressionCount ?? 'N/A'}`)
  console.log('└─────────────────────────────────────────────────────────────────┘')
  console.log('')
  
  // Latency percentiles
  console.log('┌─────────────────────────────────────────────────────────────────┐')
  console.log('│                    LATENCY PERCENTILES                          │')
  console.log('├─────────────────────────────────────────────────────────────────┤')
  const latencyTrends = trends.filter(t => t.metric.includes('Latency'))
  for (const trend of latencyTrends) {
    const arrow = formatTrendArrow(trend.direction)
    const change = formatChange(trend.change, trend.changePercent, 'ms')
    console.log(`│ ${trend.metric}: ${trend.current.toFixed(0).padStart(6)}ms ${arrow} ${change}`)
  }
  console.log('└─────────────────────────────────────────────────────────────────┘')
  console.log('')
  
  // Backend coverage
  console.log('┌─────────────────────────────────────────────────────────────────┐')
  console.log('│                    BACKEND COVERAGE                             │')
  console.log('├─────────────────────────────────────────────────────────────────┤')
  for (const bt of backendTrends.slice(0, 10)) {
    const changeStr = bt.change !== null ? ` (${bt.change >= 0 ? '+' : ''}${bt.change})` : ''
    console.log(`│ ${bt.backend.padEnd(20)} ${bt.current.toString().padStart(5)} queries (${bt.percentOfTotal.toFixed(1)}%)${changeStr}`)
  }
  console.log('└─────────────────────────────────────────────────────────────────┘')
  console.log('')
  
  // Trends
  if (history.length >= 2) {
    console.log('┌─────────────────────────────────────────────────────────────────┐')
    console.log('│                    TRENDS (vs previous run)                     │')
    console.log('├─────────────────────────────────────────────────────────────────┤')
    
    const passRateTrend = trends.find(t => t.metric === 'Pass Rate')
    if (passRateTrend) {
      const arrow = formatTrendArrow(passRateTrend.direction)
      console.log(`│ Pass Rate: ${arrow} ${formatChange(passRateTrend.change, passRateTrend.changePercent, '%')}`)
    }
    
    const avgTimeTrend = trends.find(t => t.metric === 'Avg Time')
    if (avgTimeTrend) {
      const arrow = formatTrendArrow(avgTimeTrend.direction)
      console.log(`│ Avg Time:  ${arrow} ${formatChange(avgTimeTrend.change, avgTimeTrend.changePercent, 'ms')}`)
    }
    
    const regressionTrend = trends.find(t => t.metric === 'Regressions')
    if (regressionTrend) {
      const arrow = formatTrendArrow(regressionTrend.direction)
      console.log(`│ Regressions: ${arrow} ${formatChange(regressionTrend.change, regressionTrend.changePercent)}`)
    }
    
    console.log('└─────────────────────────────────────────────────────────────────┘')
    console.log('')
  }
  
  // History sparkline (last 10 runs)
  if (history.length >= 2) {
    console.log('┌─────────────────────────────────────────────────────────────────┐')
    console.log('│                    PASS RATE HISTORY (last 10)                  │')
    console.log('├─────────────────────────────────────────────────────────────────┤')
    
    const last10 = history.slice(-10)
    const _maxRate = Math.max(...last10.map(h => h.passRate * 100))
    const _minRate = Math.min(...last10.map(h => h.passRate * 100))
    
    for (const snapshot of last10) {
      const rate = snapshot.passRate * 100
      const barLength = Math.round((rate / 100) * 40)
      const bar = '█'.repeat(barLength)
      const date = snapshot.timestamp.slice(0, 10)
      console.log(`│ ${date} ${rate.toFixed(1).padStart(5)}% ${bar}`)
    }
    
    console.log('└─────────────────────────────────────────────────────────────────┘')
    console.log('')
  }
}

// ============================================================
// Regression Alert Check
// ============================================================

function checkAlerts(history: MetricsSnapshot[]): string[] {
  const alerts: string[] = []
  
  if (history.length < 2) return alerts
  
  const current = history[history.length - 1]
  const previous = history[history.length - 2]
  
  // Pass rate regression
  if (current.passRate < previous.passRate) {
    const drop = (previous.passRate - current.passRate) * 100
    alerts.push(`🚨 Pass rate dropped by ${drop.toFixed(1)}%: ${(previous.passRate * 100).toFixed(1)}% → ${(current.passRate * 100).toFixed(1)}%`)
  }
  
  // Latency regression (>20% increase)
  const latencyChecks: Array<{ key: keyof LatencyPercentiles; label: string }> = [
    { key: 'p50', label: 'P50' },
    { key: 'p95', label: 'P95' },
  ]
  
  for (const { key, label } of latencyChecks) {
    if (previous.latency[key] > 0) {
      const increase = (current.latency[key] - previous.latency[key]) / previous.latency[key]
      if (increase > 0.2) {
        alerts.push(`⚠️ ${label} latency increased by ${(increase * 100).toFixed(1)}%: ${previous.latency[key]}ms → ${current.latency[key]}ms`)
      }
    }
  }
  
  // New regression spike
  if (current.regressionCount !== undefined && previous.regressionCount !== undefined) {
    if (current.regressionCount > previous.regressionCount + 10) {
      alerts.push(`🔴 Regressions increased significantly: ${previous.regressionCount} → ${current.regressionCount}`)
    }
  }
  
  return alerts
}

// ============================================================
// Main
// ============================================================

async function main() {
  const args = process.argv.slice(2)
  const showReport = args.includes('--report') || args.length === 0
  const recordOnly = args.includes('--record')
  const showDiff = args.includes('--diff')
  const checkAlert = args.includes('--alert')
  
  // Load current results
  const data = loadLatestResults()
  if (!data) {
    process.exit(1)
    return
  }
  
  const { report, regressions } = data
  
  // Load history
  const history = loadHistory()
  
  // Check if this is a new run
  const lastTimestamp = history.snapshots.length > 0
    ? history.snapshots[history.snapshots.length - 1].timestamp
    : null
  
  if (lastTimestamp === report.timestamp) {
    console.log('ℹ️  Results already recorded for this timestamp.')
  } else {
    // Extract and record snapshot
    const snapshot = extractSnapshot(report, regressions)
    history.snapshots.push(snapshot)
    
    // Keep last 100 snapshots
    if (history.snapshots.length > 100) {
      history.snapshots = history.snapshots.slice(-100)
    }
    
    saveHistory(history)
    console.log(`✅ Recorded snapshot for ${report.timestamp}`)
  }
  
  // Show report
  if (showReport && !recordOnly) {
    printReport(history.snapshots)
  }
  
  // Show diff between last 2 runs
  if (showDiff && history.snapshots.length >= 2) {
    const current = history.snapshots[history.snapshots.length - 1]
    const previous = history.snapshots[history.snapshots.length - 2]
    
    console.log('')
    console.log('📊 DIFF: Previous → Current')
    console.log(`   Pass Rate: ${(previous.passRate * 100).toFixed(1)}% → ${(current.passRate * 100).toFixed(1)}%`)
    console.log(`   P50: ${previous.latency.p50}ms → ${current.latency.p50}ms`)
    console.log(`   P95: ${previous.latency.p95}ms → ${current.latency.p95}ms`)
    console.log(`   Avg: ${previous.avgTimeMs}ms → ${current.avgTimeMs}ms`)
  }
  
  // Check alerts
  if (checkAlert) {
    const alerts = checkAlerts(history.snapshots)
    if (alerts.length > 0) {
      console.log('')
      console.log('🚨 ALERTS:')
      for (const alert of alerts) {
        console.log(`   ${alert}`)
      }
    } else {
      console.log('✅ No alerts - all metrics within thresholds')
    }
  }
}

main().catch(err => {
  console.error('❌ Monitor failed:', err)
  process.exit(1)
})
