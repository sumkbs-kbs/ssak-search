/**
 * ExperimentDO — self-hosted A/B Testing Framework (Phase C.2)
 *
 * Durable Object that owns experiment configuration and event collection:
 *   - register/pause/resume experiments (control/treatment variants with weights)
 *   - deterministic user_id hash → variant assignment (consistent UX)
 *   - impression / click / latency / error events, written to DO storage AND
 *     mirrored to Workers Analytics Engine (same mechanism as Phase B.3 metrics)
 *   - Bayesian analysis with automatic significance verdict (p < 0.05)
 *
 * Storage layout (each event = one key; keys sort lexicographically by ts):
 *   meta                      → ExperimentMeta (experiment definitions)
 *   imp:{name}:{paddedTs}:{id} → ImpressionEvent
 *   clk:{name}:{paddedTs}:{id} → ClickEvent
 *   lat:{name}:{paddedTs}:{id} → LatencyEvent
 *   err:{name}:{paddedTs}:{id} → ErrorEvent
 *
 * Experiment names are restricted to [a-z0-9-_] (no colons) so per-experiment
 * range scans never collide. Events older than RETENTION_MS are pruned lazily
 * on writes (same cadence as ClickLogDO).
 */

import { DurableObject } from 'cloudflare:workers'
import type { Env } from '../../types'
import { logger, toError } from '../logger'

// ============================================================
// Types
// ============================================================

export type ExperimentMetric = 'ctr' | 'ndcg' | 'latency' | 'error_rate'
export type ExperimentStatus = 'running' | 'paused' | 'stopped'

export interface ExperimentVariant {
  /** Variant key, e.g. 'control' | 'treatment' */
  key: string
  /** Traffic share percentage (0-100). Sum across variants must equal 100. */
  weight: number
}

export interface Experiment {
  name: string
  description?: string
  variants: ExperimentVariant[]
  /** Primary metric the significance verdict is based on */
  primary_metric: ExperimentMetric
  status: ExperimentStatus
  created_at: number
}

export interface ExperimentInput {
  name: string
  description?: string
  variants: { key: string; weight: number }[]
  primary_metric?: ExperimentMetric
}

export interface ImpressionEvent {
  experiment: string
  variant: string
  user_id: string | null
  impression_id: string
  query: string
  result_count: number
  ts: number
}

export interface ClickEvent {
  experiment: string
  variant: string
  user_id: string | null
  impression_id: string
  position: number
  ts: number
}

export interface LatencyEvent {
  experiment: string
  variant: string
  latency_ms: number
  ts: number
}

export interface ErrorEvent {
  experiment: string
  variant: string
  ts: number
}

export interface ExperimentSummary {
  name: string
  description?: string
  variants: ExperimentVariant[]
  primary_metric: ExperimentMetric
  status: ExperimentStatus
  created_at: number
  /** Event counts for the retention window (in-memory counters) */
  impressions: number
  clicks: number
  latencies: number
  errors: number
}

export interface VariantAnalysis {
  variant: string
  impressions: number
  clicks: number
  ctr: number
  ndcg: number
  latency_mean_ms: number
  latency_samples: number
  error_rate: number
}

export interface ExperimentAnalysis {
  experiment: string
  primary_metric: ExperimentMetric
  window_days: number
  /** Normal-approx posterior probability that variant B (index 1) beats control (index 0) */
  prob_b_beats_control: number
  /** Two-sided p-value from the normal approximation */
  p_value: number
  significant: boolean
  insufficient_data: boolean
  winner: string | null
  control: VariantAnalysis | null
  treatment: VariantAnalysis | null
  variants: VariantAnalysis[]
  analyzed_at: number
}

interface ExperimentMeta {
  experiments: Record<string, Experiment>
  /** Per-experiment event counters (reset never — used for summaries) */
  counts: Record<string, { impressions: number; clicks: number; latencies: number; errors: number }>
  opsSinceCleanup: number
}

// ============================================================
// Constants
// ============================================================

const RETENTION_MS = 30 * 86_400_000 // prune events older than 30 days
const CLEANUP_EVERY_OPS = 25
const MIN_SAMPLES = 30 // impressions per variant required for a significance verdict
const NAME_PATTERN = /^[a-z0-9][a-z0-9-_]{0,39}$/
const VARIANT_PATTERN = /^[a-z0-9][a-z0-9-_]{0,19}$/
const METRICS: ExperimentMetric[] = ['ctr', 'ndcg', 'latency', 'error_rate']

function padTs(ts: number): string {
  return String(ts).padStart(13, '0')
}

// ============================================================
// Deterministic assignment hash (FNV-1a 32-bit)
// ============================================================

export function fnv1a(str: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** Map a [0,1) float to a weighted variant key. */
export function pickVariant(variants: ExperimentVariant[], r: number): string {
  let cumulative = 0
  for (const v of variants) {
    cumulative += v.weight / 100
    if (r < cumulative) return v.key
  }
  return variants[variants.length - 1]?.key ?? ''
}

// ============================================================
// Normal CDF (Abramowitz & Stegun 7.1.26 erf approximation)
// ============================================================

function erf(x: number): number {
  const sign = x < 0 ? -1 : 1
  const ax = Math.abs(x)
  const t = 1 / (1 + 0.3275911 * ax)
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax)
  return sign * y
}

export function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2))
}

/** Two-sided p-value for a z-score. */
function twoSidedP(z: number): number {
  return 2 * (1 - normalCdf(Math.abs(z)))
}

/**
 * Bayesian CTR comparison via normal approximation to the Beta posterior.
 * Posterior per variant: Beta(1 + clicks, 1 + impressions - clicks).
 * P(treatment > control) = Φ((μT - μC) / sqrt(σT² + σC²)).
 */
function betaDiffStats(c: number, n: number): { mean: number; var: number } {
  const a = 1 + c
  const b = 1 + (n - c)
  const ab = a + b
  const mean = a / ab
  return { mean, var: (a * b) / (ab * ab * (ab + 1)) }
}

// ============================================================
// Durable Object
// ============================================================

export class ExperimentDO extends DurableObject<Env> {
  private meta: ExperimentMeta = {
    experiments: {},
    counts: {},
    opsSinceCleanup: 0,
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.ctx.blockConcurrencyWhile(async () => {
      const stored = await this.ctx.storage.get<ExperimentMeta>('meta')
      if (stored) this.meta = stored
    })
  }

  private async saveMeta(): Promise<void> {
    await this.ctx.storage.put('meta', this.meta)
  }

  private touchCount(name: string, kind: 'impressions' | 'clicks' | 'latencies' | 'errors'): void {
    const c = (this.meta.counts[name] ??= { impressions: 0, clicks: 0, latencies: 0, errors: 0 })
    c[kind]++
  }

  // ----------------------------------------------------------
  // Lifecycle: register / pause / resume / stop
  // ----------------------------------------------------------

  async register(input: ExperimentInput): Promise<{ ok: boolean; experiment?: Experiment; error?: string }> {
    const name = input.name
    if (!NAME_PATTERN.test(name)) {
      return { ok: false, error: 'name must match [a-z0-9][a-z0-9-_]{0,39}' }
    }
    if (this.meta.experiments[name]) {
      return { ok: false, error: `experiment '${name}' already exists` }
    }
    const variants = input.variants
    if (!Array.isArray(variants) || variants.length < 2 || variants.length > 10) {
      return { ok: false, error: 'variants must contain 2-10 items' }
    }
    const seen = new Set<string>()
    let weightSum = 0
    for (const v of variants) {
      if (!VARIANT_PATTERN.test(v.key) || seen.has(v.key)) {
        return { ok: false, error: `invalid or duplicate variant key '${v.key}'` }
      }
      if (!Number.isInteger(v.weight) || v.weight < 1 || v.weight > 99) {
        return { ok: false, error: `variant weight must be an integer 1-99 ('${v.key}')` }
      }
      seen.add(v.key)
      weightSum += v.weight
    }
    if (weightSum !== 100) {
      return { ok: false, error: `variant weights must sum to 100 (got ${weightSum})` }
    }
    const primaryMetric = input.primary_metric ?? 'ctr'
    if (!METRICS.includes(primaryMetric)) {
      return { ok: false, error: `primary_metric must be one of ${METRICS.join(', ')}` }
    }

    const exp: Experiment = {
      name,
      description: input.description,
      variants,
      primary_metric: primaryMetric,
      status: 'running',
      created_at: Date.now(),
    }
    this.meta.experiments[name] = exp
    await this.saveMeta()
    logger.info(
      `[ExperimentDO] Registered experiment '${name}' with variants ${variants.map((v) => `${v.key}:${v.weight}%`).join(', ')}`,
    )
    return { ok: true, experiment: exp }
  }

  async list(): Promise<ExperimentSummary[]> {
    return Object.values(this.meta.experiments).map((exp) => {
      const c = this.meta.counts[exp.name] ?? { impressions: 0, clicks: 0, latencies: 0, errors: 0 }
      return {
        name: exp.name,
        description: exp.description,
        variants: exp.variants,
        primary_metric: exp.primary_metric,
        status: exp.status,
        created_at: exp.created_at,
        impressions: c.impressions,
        clicks: c.clicks,
        latencies: c.latencies,
        errors: c.errors,
      }
    })
  }

  async setStatus(name: string, status: ExperimentStatus): Promise<{ ok: boolean; error?: string }> {
    const exp = this.meta.experiments[name]
    if (!exp) return { ok: false, error: `experiment '${name}' not found` }
    exp.status = status
    await this.saveMeta()
    return { ok: true }
  }

  // ----------------------------------------------------------
  // Assignment — deterministic user_id hash → variant
  // ----------------------------------------------------------

  async assign(name: string, userId: string | null): Promise<string | null> {
    const exp = this.meta.experiments[name]
    if (!exp || exp.status !== 'running' || !userId) return null
    const r = fnv1a(`${name}:${userId}`) / 4294967296 // [0,1)
    return pickVariant(exp.variants, r)
  }

  // ----------------------------------------------------------
  // Event recording (DO storage + Analytics Engine mirror)
  // ----------------------------------------------------------

  private writeAnalytics(blob1: string, blob2: string, blob3: string, doubles: number[]): void {
    // Fire-and-forget mirror to Analytics Engine (same mechanism as metrics.ts).
    if (!this.env.ANALYTICS) return
    try {
      this.env.ANALYTICS.writeDataPoint({
        blobs: [blob1, blob2, blob3],
        doubles,
        indexes: [blob1.slice(0, 32)],
      })
    } catch {
      // Analytics write failure must not affect the request
    }
  }

  async recordImpression(input: Omit<ImpressionEvent, 'ts'>): Promise<string> {
    const ts = Date.now()
    const evt: ImpressionEvent = { ...input, ts }
    await this.ctx.storage.put(`imp:${input.experiment}:${padTs(ts)}:${input.impression_id}`, evt)
    this.touchCount(input.experiment, 'impressions')
    this.writeAnalytics('experiment', input.experiment, `impression:${input.variant}`, [1])
    await this.maybeCleanup(ts)
    return input.impression_id
  }

  async recordClick(input: Omit<ClickEvent, 'ts'>): Promise<void> {
    const ts = Date.now()
    const evt: ClickEvent = { ...input, ts }
    await this.ctx.storage.put(`clk:${input.experiment}:${padTs(ts)}:${input.impression_id}:${input.position}`, evt)
    this.touchCount(input.experiment, 'clicks')
    this.writeAnalytics('experiment', input.experiment, `click:${input.variant}`, [1])
    await this.maybeCleanup(ts)
  }

  async recordLatency(input: Omit<LatencyEvent, 'ts'>): Promise<void> {
    const ts = Date.now()
    const evt: LatencyEvent = { ...input, ts }
    await this.ctx.storage.put(`lat:${input.experiment}:${padTs(ts)}:${Math.random().toString(36).slice(2, 10)}`, evt)
    this.touchCount(input.experiment, 'latencies')
    this.writeAnalytics('experiment', input.experiment, `latency:${input.variant}`, [input.latency_ms])
    await this.maybeCleanup(ts)
  }

  async recordError(input: Omit<ErrorEvent, 'ts'>): Promise<void> {
    const ts = Date.now()
    const evt: ErrorEvent = { ...input, ts }
    await this.ctx.storage.put(`err:${input.experiment}:${padTs(ts)}:${Math.random().toString(36).slice(2, 10)}`, evt)
    this.touchCount(input.experiment, 'errors')
    this.writeAnalytics('experiment', input.experiment, `error:${input.variant}`, [1])
    await this.maybeCleanup(ts)
  }

  /** Lazy retention pruning — same cadence as ClickLogDO. */
  private async maybeCleanup(ts: number): Promise<void> {
    this.meta.opsSinceCleanup++
    if (this.meta.opsSinceCleanup < CLEANUP_EVERY_OPS) return
    this.meta.opsSinceCleanup = 0
    const cutoff = ts - RETENTION_MS
    for (const kind of ['imp', 'clk', 'lat', 'err']) {
      await this.pruneBefore(kind, cutoff)
    }
    await this.saveMeta()
  }

  private async pruneBefore(kind: string, cutoffTs: number): Promise<void> {
    const endKey = `${kind}:\uffff`
    for (;;) {
      // prefix scan bounded by lexicographic key order — no end-key prefix
      // needed since every event key starts with `${kind}:`.
      const entries = await this.ctx.storage.list({ prefix: `${kind}:`, end: endKey, limit: 1000 })
      // Collect keys older than cutoff (key ts component < cutoff)
      const stale: string[] = []
      const pad = padTs(cutoffTs)
      for (const key of entries.keys()) {
        // key format: {kind}:{name}:{paddedTs}:{id} — compare the ts chunk
        const parts = key.split(':')
        const tsChunk = parts[2] ?? ''
        if (tsChunk !== '' && tsChunk <= pad) stale.push(key)
      }
      if (stale.length === 0) break
      for (const key of stale) await this.ctx.storage.delete(key)
      if (entries.size < 1000) break
    }
  }

  // ----------------------------------------------------------
  // Bayesian analysis
  // ----------------------------------------------------------

  async analyze(name: string, days = 30): Promise<ExperimentAnalysis | null> {
    const exp = this.meta.experiments[name]
    if (!exp) return null

    const since = Date.now() - days * 86_400_000
    const pad = padTs(since)

    // Load events for this experiment in the window.
    const imps = await this.scanEvents<ImpressionEvent>('imp', name, pad)
    const clks = await this.scanEvents<ClickEvent>('clk', name, pad)
    const lats = await this.scanEvents<LatencyEvent>('lat', name, pad)
    const errs = await this.scanEvents<ErrorEvent>('err', name, pad)

    // Join clicks to impressions by impression_id for NDCG.
    const clickByImp = new Map<string, number[]>()
    for (const c of clks) {
      const arr = clickByImp.get(c.impression_id) ?? []
      arr.push(c.position)
      clickByImp.set(c.impression_id, arr)
    }

    const variants: VariantAnalysis[] = exp.variants.map((v) => {
      const variantImps = imps.filter((i) => i.variant === v.key)
      const variantClks = clks.filter((c) => c.variant === v.key)
      const variantLats = lats.filter((l) => l.variant === v.key)
      const variantErrs = errs.filter((e) => e.variant === v.key)

      // NDCG@10 per impression (binary relevance: clicked = 1).
      let ndcgSum = 0
      let ndcgCount = 0
      for (const imp of variantImps) {
        const positions = clickByImp.get(imp.impression_id) ?? []
        if (positions.length === 0) continue
        const k = Math.min(10, imp.result_count)
        let idcg = 0
        for (let i = 1; i <= k; i++) idcg += 1 / Math.log2(i + 1)
        if (idcg === 0) continue
        let dcg = 0
        for (const pos of positions) {
          if (pos >= 1 && pos <= k) dcg += 1 / Math.log2(pos + 1)
        }
        ndcgSum += dcg / idcg
        ndcgCount++
      }

      return {
        variant: v.key,
        impressions: variantImps.length,
        clicks: variantClks.length,
        ctr: variantImps.length > 0 ? variantClks.length / variantImps.length : 0,
        ndcg: ndcgCount > 0 ? ndcgSum / ndcgCount : 0,
        latency_mean_ms:
          variantLats.length > 0 ? variantLats.reduce((a, l) => a + l.latency_ms, 0) / variantLats.length : 0,
        latency_samples: variantLats.length,
        error_rate: variantImps.length > 0 ? variantErrs.length / variantImps.length : 0,
      }
    })

    // Significance on the primary metric (control = variants[0], treatment = variants[1]).
    const control = variants[0] ?? null
    const treatment = variants[1] ?? null
    let prob = 0.5
    let pValue = 1
    let insufficient = false
    let winner: string | null = null

    if (control && treatment) {
      switch (exp.primary_metric) {
        case 'ctr':
        case 'error_rate': {
          // Beta-Binomial posterior, normal approximation.
          // Sample-size gate: impressions are the sample source for rate metrics.
          const nControl = control.impressions
          const nTreatment = treatment.impressions
          if (nControl < MIN_SAMPLES || nTreatment < MIN_SAMPLES) {
            insufficient = true
          } else {
            const metric = exp.primary_metric
            const cStat = betaDiffStats(metric === 'ctr' ? control.clicks : control.impressions, nControl)
            const tStat = betaDiffStats(metric === 'ctr' ? treatment.clicks : treatment.impressions, nTreatment)
            // treatment mean - control mean (lower error_rate is better → flip)
            const dir = metric === 'error_rate' ? -1 : 1
            const z = (dir * (tStat.mean - cStat.mean)) / Math.sqrt(cStat.var + tStat.var)
            prob = normalCdf(z)
            pValue = twoSidedP(z)
            winner = prob > 0.975 ? treatment.variant : prob < 0.025 ? control.variant : null
          }
          break
        }
        case 'ndcg': {
          const cStats = collectContinuous(imps, clickByImp, control)
          const tStats = collectContinuous(imps, clickByImp, treatment)
          if (cStats.n < MIN_SAMPLES || tStats.n < MIN_SAMPLES) {
            insufficient = true
          } else {
            const z = (tStats.mean - cStats.mean) / Math.sqrt(cStats.var / cStats.n + tStats.var / tStats.n)
            prob = normalCdf(z)
            pValue = twoSidedP(z)
            winner = prob > 0.975 ? treatment.variant : prob < 0.025 ? control.variant : null
          }
          break
        }
        case 'latency': {
          const lControl = lats.filter((l) => l.variant === control.variant).map((l) => l.latency_ms)
          const lTreatment = lats.filter((l) => l.variant === treatment.variant).map((l) => l.latency_ms)
          if (lControl.length < MIN_SAMPLES || lTreatment.length < MIN_SAMPLES) {
            insufficient = true
          } else {
            const m1 = meanOf(lControl)
            const m2 = meanOf(lTreatment)
            const v1 = varOf(lControl, m1)
            const v2 = varOf(lTreatment, m2)
            // lower latency is better → negative direction
            const z = (m1 - m2) / Math.sqrt(v1 / lControl.length + v2 / lTreatment.length)
            prob = normalCdf(z)
            pValue = twoSidedP(z)
            winner = prob > 0.975 ? treatment.variant : prob < 0.025 ? control.variant : null
          }
          break
        }
      }
    }

    const significant = !insufficient && pValue < 0.05

    return {
      experiment: name,
      primary_metric: exp.primary_metric,
      window_days: days,
      prob_b_beats_control: prob,
      p_value: pValue,
      significant,
      insufficient_data: insufficient,
      winner: significant ? winner : null,
      control,
      treatment,
      variants,
      analyzed_at: Date.now(),
    }
  }

  private async scanEvents<T>(kind: string, name: string, sincePad: string): Promise<T[]> {
    const prefix = `${kind}:${name}:`
    let start = `${kind}:${name}:${sincePad}`
    const out: T[] = []
    for (;;) {
      const entries = await this.ctx.storage.list({ prefix, start, limit: 1000 })
      if (entries.size === 0) break
      for (const v of entries.values()) out.push(v as T)
      if (entries.size < 1000) break
      // Advance start past the last returned key for the next page. The list
      // `start` is inclusive, so bump the final key's last char by one.
      const lastKey = [...entries.keys()].pop()
      if (lastKey === undefined) break // entries.size > 0 guaranteed above; defensive
      const nextStart = lastKey.slice(0, -1) + String.fromCharCode(lastKey.charCodeAt(lastKey.length - 1) + 1)
      if (nextStart <= start) break
      start = nextStart
    }
    return out
  }

  async getStats(
    name: string,
  ): Promise<{ impressions: number; clicks: number; latencies: number; errors: number } | null> {
    const exp = this.meta.experiments[name]
    if (!exp) return null
    return this.meta.counts[name] ?? { impressions: 0, clicks: 0, latencies: 0, errors: 0 }
  }

  async reset(): Promise<void> {
    this.meta = { experiments: {}, counts: {}, opsSinceCleanup: 0 }
    await this.ctx.storage.deleteAll()
  }
}

// ============================================================
// Continuous-metric helpers (NDCG z-test)
// ============================================================

function collectContinuous(
  imps: ImpressionEvent[],
  clickByImp: Map<string, number[]>,
  variant: VariantAnalysis,
): { mean: number; var: number; n: number } {
  const vals: number[] = []
  for (const imp of imps.filter((i) => i.variant === variant.variant)) {
    const positions = clickByImp.get(imp.impression_id) ?? []
    if (positions.length === 0) continue
    const k = Math.min(10, imp.result_count)
    let idcg = 0
    for (let i = 1; i <= k; i++) idcg += 1 / Math.log2(i + 1)
    if (idcg === 0) continue
    let dcg = 0
    for (const pos of positions) if (pos >= 1 && pos <= k) dcg += 1 / Math.log2(pos + 1)
    vals.push(dcg / idcg)
  }
  const n = vals.length
  const mean = n > 0 ? vals.reduce((a, b) => a + b, 0) / n : 0
  return { mean, var: varOf(vals, mean), n }
}

function meanOf(a: number[]): number {
  return a.length > 0 ? a.reduce((x, y) => x + y, 0) / a.length : 0
}

function varOf(a: number[], mean: number): number {
  if (a.length < 2) return 0
  return a.reduce((acc, x) => acc + (x - mean) ** 2, 0) / (a.length - 1)
}

// ============================================================
// Client-side RPC stub
// ============================================================

export interface ExperimentRPC {
  register(input: ExperimentInput): Promise<{ ok: boolean; experiment?: Experiment; error?: string }>
  list(): Promise<ExperimentSummary[]>
  setStatus(name: string, status: ExperimentStatus): Promise<{ ok: boolean; error?: string }>
  assign(name: string, userId: string | null): Promise<string | null>
  recordImpression(input: Omit<ImpressionEvent, 'ts'>): Promise<string>
  recordClick(input: Omit<ClickEvent, 'ts'>): Promise<void>
  recordLatency(input: Omit<LatencyEvent, 'ts'>): Promise<void>
  recordError(input: Omit<ErrorEvent, 'ts'>): Promise<void>
  analyze(name: string, days?: number): Promise<ExperimentAnalysis | null>
  getStats(name: string): Promise<{ impressions: number; clicks: number; latencies: number; errors: number } | null>
  reset(): Promise<void>
}

export function getExperimentStub(env: Env): ExperimentRPC {
  if (!env.EXPERIMENT_DO) throw new Error('EXPERIMENT_DO binding missing — configure the Durable Object binding first')
  const id = env.EXPERIMENT_DO.idFromName('hub')
  return env.EXPERIMENT_DO.get(id) as unknown as ExperimentRPC
}

// ============================================================
// Search-route helpers — assignment + fire-and-forget events
// ============================================================

export interface ExperimentAssignment {
  name: string
  variant: string
  impression_id: string
}

/**
 * Resolve the experiment assignment for a search request.
 * Returns null when the DO is not bound, the experiment is not running, or
 * there is no stable user id (assignment requires a consistent key).
 */
export async function resolveExperimentAssignment(
  env: Env | undefined,
  userId: string | null,
): Promise<ExperimentAssignment | null> {
  if (!env?.EXPERIMENT_DO || !userId) return null
  try {
    const stub = getExperimentStub(env)
    const variant = await stub.assign('ltr-ranking', userId)
    if (!variant) return null
    return { name: 'ltr-ranking', variant, impression_id: crypto.randomUUID() }
  } catch (err) {
    logger.warn('Experiment assignment failed (non-critical):', { error: toError(err) })
    return null
  }
}

/** Fire-and-forget impression event (called via c.executionCtx.waitUntil). */
export async function logExperimentImpression(
  env: Env,
  assignment: ExperimentAssignment,
  query: string,
  resultCount: number,
): Promise<void> {
  if (!env?.EXPERIMENT_DO) return
  try {
    const stub = getExperimentStub(env)
    await stub.recordImpression({
      experiment: assignment.name,
      variant: assignment.variant,
      user_id: null,
      impression_id: assignment.impression_id,
      query,
      result_count: resultCount,
    })
  } catch (err) {
    logger.warn('Experiment impression logging failed (non-critical):', { error: toError(err) })
  }
}

/** Fire-and-forget latency event. */
export async function logExperimentLatency(
  env: Env,
  assignment: ExperimentAssignment,
  latencyMs: number,
): Promise<void> {
  if (!env?.EXPERIMENT_DO) return
  try {
    const stub = getExperimentStub(env)
    await stub.recordLatency({ experiment: assignment.name, variant: assignment.variant, latency_ms: latencyMs })
  } catch (err) {
    logger.warn('Experiment latency logging failed (non-critical):', { error: toError(err) })
  }
}

/** Fire-and-forget error event. */
export async function logExperimentError(env: Env, assignment: ExperimentAssignment): Promise<void> {
  if (!env?.EXPERIMENT_DO) return
  try {
    const stub = getExperimentStub(env)
    await stub.recordError({ experiment: assignment.name, variant: assignment.variant })
  } catch (err) {
    logger.warn('Experiment error logging failed (non-critical):', { error: toError(err) })
  }
}
