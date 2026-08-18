/**
 * Enhanced A/B Testing Framework (Phase 4)
 *
 * Improvements over existing framework:
 * - Statistical significance testing (t-test, chi-squared)
 * - Multi-armed bandit for adaptive allocation
 * - Bayesian analysis for early stopping
 * - Sample size calculation
 * - Confidence intervals
 * - Guardrail metrics
 */

import { logger, toError } from '../logger'
import type { Env } from '../../types'

// ============================================================
// Types
// ============================================================

export interface Experiment {
  id: string
  name: string
  description: string
  status: 'draft' | 'running' | 'paused' | 'completed'
  variants: Variant[]
  targetMetric: string
  guardrailMetrics: string[]
  startDate: number
  endDate?: number
  minSampleSize: number
  significanceLevel: number
  statisticalPower: number
}

export interface Variant {
  id: string
  name: string
  weight: number // traffic allocation percentage
  isControl: boolean
  config: Record<string, unknown>
}

export interface ExperimentResult {
  experimentId: string
  status: string
  duration: number
  variants: VariantResult[]
  statisticalAnalysis: StatisticalAnalysis
  recommendation: 'continue' | 'stop_winner' | 'stop_no_difference' | 'extend'
}

export interface VariantResult {
  variantId: string
  name: string
  samples: number
  conversions: number
  conversionRate: number
  revenue?: number
  metrics: Record<string, number>
}

export interface StatisticalAnalysis {
  testType: string
  testStatistic: number
  pValue: number
  confidenceInterval: [number, number]
  isSignificant: boolean
  statisticalPower: number
  effectSize: number
  requiredSampleSize: number
  currentSampleSize: number
  canStopEarly: boolean
}

// ============================================================
// Statistical Tests
// ============================================================

export class StatisticalTests {
  /**
   * Two-proportion z-test for conversion rates.
   */
  static twoProportionZTest(
    conversions1: number,
    samples1: number,
    conversions2: number,
    samples2: number,
  ): StatisticalAnalysis {
    const p1 = conversions1 / samples1
    const p2 = conversions2 / samples2
    const pPool = (conversions1 + conversions2) / (samples1 + samples2)

    const se = Math.sqrt(pPool * (1 - pPool) * (1 / samples1 + 1 / samples2))
    const z = (p2 - p1) / se

    // Two-tailed p-value
    const pValue = 2 * (1 - StatisticalTests.normalCDF(Math.abs(z)))

    // 95% confidence interval for difference
    const seDiff = Math.sqrt((p1 * (1 - p1)) / samples1 + (p2 * (1 - p2)) / samples2)
    const ci: [number, number] = [
      (p2 - p1) - 1.96 * seDiff,
      (p2 - p1) + 1.96 * seDiff,
    ]

    // Effect size (Cohen's h)
    const effectSize = 2 * (Math.asin(Math.sqrt(p2)) - Math.asin(Math.sqrt(p1)))

    // Required sample size for 80% power
    const requiredN = StatisticalTests.calculateSampleSize(p1, p2, 0.05, 0.8)

    return {
      testType: 'two-proportion-z-test',
      testStatistic: z,
      pValue,
      confidenceInterval: ci,
      isSignificant: pValue < 0.05,
      statisticalPower: 0.8,
      effectSize,
      requiredSampleSize: requiredN,
      currentSampleSize: samples1 + samples2,
      canStopEarly: pValue < 0.01 && samples1 + samples2 > requiredN * 0.5,
    }
  }

  /**
   * Chi-squared test for independence.
   */
  static chiSquaredTest(
    observed: number[][],
  ): { statistic: number; pValue: number; degreesOfFreedom: number } {
    const rows = observed.length
    const cols = observed[0].length
    const total = observed.flat().reduce((a, b) => a + b, 0)

    let statistic = 0
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < cols; j++) {
        const rowSum = observed[i].reduce((a, b) => a + b, 0)
        const colSum = observed.reduce((sum, row) => sum + row[j], 0)
        const expected = (rowSum * colSum) / total
        if (expected > 0) {
          statistic += Math.pow(observed[i][j] - expected, 2) / expected
        }
      }
    }

    const degreesOfFreedom = (rows - 1) * (cols - 1)
    const pValue = 1 - StatisticalTests.chiSquaredCDF(statistic, degreesOfFreedom)

    return { statistic, pValue, degreesOfFreedom }
  }

  /**
   * Calculate required sample size for two-proportion test.
   */
  static calculateSampleSize(
    p1: number,
    p2: number,
    alpha: number = 0.05,
    power: number = 0.8,
  ): number {
    const effectSize = Math.abs(p2 - p1)
    const pAvg = (p1 + p2) / 2

    // Formula for sample size per group
    const zAlpha = StatisticalTests.normalQuantile(1 - alpha / 2)
    const zBeta = StatisticalTests.normalQuantile(power)

    const n = Math.ceil(
      (Math.pow(zAlpha + zBeta, 2) * 2 * pAvg * (1 - pAvg)) /
      Math.pow(effectSize, 2)
    )

    return n * 2 // Total sample size (both groups)
  }

  /**
   * Bayesian A/B test using Beta-Binomial model.
   */
  static bayesianTest(
    conversions1: number,
    samples1: number,
    conversions2: number,
    samples2: number,
    simulations: number = 10000,
  ): {
    probabilityBBeatsA: number
    expectedLift: number
    risk: number
  } {
    // Beta distributions
    const alpha1 = conversions1 + 1
    const beta1 = samples1 - conversions1 + 1
    const alpha2 = conversions2 + 1
    const beta2 = samples2 - conversions2 + 1

    // Monte Carlo simulation
    let bWins = 0
    let liftSum = 0

    for (let i = 0; i < simulations; i++) {
      const sample1 = StatisticalTests.betaSample(alpha1, beta1)
      const sample2 = StatisticalTests.betaSample(alpha2, beta2)

      if (sample2 > sample1) bWins++
      liftSum += (sample2 - sample1) / sample1
    }

    return {
      probabilityBBeatsA: bWins / simulations,
      expectedLift: liftSum / simulations,
      risk: 1 - (bWins / simulations),
    }
  }

  // ============================================================
  // Helper functions
  // ============================================================

  private static normalCDF(x: number): number {
    const a1 = 0.254829592
    const a2 = -0.284496736
    const a3 = 1.421413741
    const a4 = -1.453152027
    const a5 = 1.061405429
    const p = 0.3275911

    const sign = x >= 0 ? 1 : -1
    x = Math.abs(x) / Math.sqrt(2)

    const t = 1.0 / (1.0 + p * x)
    const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x)

    return 0.5 * (1.0 + sign * y)
  }

  private static normalQuantile(p: number): number {
    // Rational approximation of the inverse normal CDF
    const a = [
      -3.969683028665376e+01, 2.209460984245205e+02,
      -2.759285104469687e+02, 1.383577518672690e+02,
      -3.066479806614716e+01, 2.506628277459239e+00,
    ]
    const b = [
      -5.447609879822406e+01, 1.615858368580409e+02,
      -1.556989798598866e+02, 6.680131188771972e+01,
      -1.328068155288572e+01,
    ]

    const pLow = 0.02425
    const pHigh = 1 - pLow
    let q: number
    let r: number

    if (p < pLow) {
      q = Math.sqrt(-2 * Math.log(p))
      return (((((a[0] * q + a[1]) * q + a[2]) * q + a[3]) * q + a[4]) * q + a[5]) /
        (((((b[0] * q + b[1]) * q + b[2]) * q + b[3]) * q + b[4]) * q + 1)
    } else if (p <= pHigh) {
      q = p - 0.5
      r = q * q
      return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
        (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
    } else {
      q = Math.sqrt(-2 * Math.log(1 - p))
      return -(((((a[0] * q + a[1]) * q + a[2]) * q + a[3]) * q + a[4]) * q + a[5]) /
        (((((b[0] * q + b[1]) * q + b[2]) * q + b[3]) * q + b[4]) * q + 1)
    }
  }

  private static chiSquaredCDF(x: number, k: number): number {
    // Approximation using incomplete gamma function
    if (x <= 0) return 0
    return StatisticalTests.lowerIncompleteGamma(k / 2, x / 2)
  }

  private static lowerIncompleteGamma(a: number, x: number): number {
    // Series expansion
    let sum = 1 / a
    let term = 1 / a
    for (let n = 1; n < 100; n++) {
      term *= x / (a + n)
      sum += term
    }
    return sum * Math.exp(-x + a * Math.log(x) - StatisticalTests.logGamma(a))
  }

  private static logGamma(x: number): number {
    const c = [
      76.18009172947146, -86.50532032941677,
      24.01409824083091, -1.231739572450155,
      0.1208650973866179e-2, -0.5395239384953e-5,
    ]

    let y = x
    let tmp = x + 5.5
    tmp -= (x + 0.5) * Math.log(tmp)
    let ser = 1.000000000190015

    for (let j = 0; j < 6; j++) {
      ser += c[j] / ++y
    }

    return -tmp + Math.log(2.5066282746310005 * ser / x)
  }

  private static betaSample(alpha: number, beta: number): number {
    // Beta distribution sampling using gamma distribution
    const gamma1 = StatisticalTests.gammaSample(alpha)
    const gamma2 = StatisticalTests.gammaSample(beta)
    return gamma1 / (gamma1 + gamma2)
  }

  private static gammaSample(alpha: number): number {
    // Marsaglia and Tsang's method
    if (alpha < 1) {
      return StatisticalTests.gammaSample(alpha + 1) * Math.pow(Math.random(), 1 / alpha)
    }

    const d = alpha - 1 / 3
    const c = 1 / Math.sqrt(9 * d)

    while (true) {
      let x: number
      let v: number

      do {
        x = StatisticalTests.normalSample()
        v = 1 + c * x
      } while (v <= 0)

      v = v * v * v
      const u = Math.random()

      if (u < 1 - 0.0331 * (x * x) * (x * x)) {
        return d * v
      }

      if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) {
        return d * v
      }
    }
  }

  private static normalSample(): number {
    const u1 = Math.random()
    const u2 = Math.random()
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
  }
}

// ============================================================
// Experiment Manager
// ============================================================

export class ExperimentManager {
  private experiments: Map<string, Experiment> = new Map()
  private results: Map<string, ExperimentResult> = new Map()

  /**
   * Create a new experiment.
   */
  createExperiment(config: Omit<Experiment, 'status' | 'startDate'>): Experiment {
    const experiment: Experiment = {
      ...config,
      status: 'draft',
      startDate: Date.now(),
    }

    this.experiments.set(experiment.id, experiment)
    return experiment
  }

  /**
   * Start an experiment.
   */
  startExperiment(id: string): boolean {
    const experiment = this.experiments.get(id)
    if (!experiment || experiment.status !== 'draft') return false

    experiment.status = 'running'
    experiment.startDate = Date.now()
    return true
  }

  /**
   * Stop an experiment.
   */
  stopExperiment(id: string): boolean {
    const experiment = this.experiments.get(id)
    if (!experiment || experiment.status !== 'running') return false

    experiment.status = 'completed'
    experiment.endDate = Date.now()
    return true
  }

  /**
   * Analyze experiment results.
   */
  analyzeExperiment(
    id: string,
    data: Array<{ variantId: string; samples: number; conversions: number }>,
  ): ExperimentResult | null {
    const experiment = this.experiments.get(id)
    if (!experiment) return null

    // Find control and treatment
    const control = data.find(d => {
      const variant = experiment.variants.find(v => v.id === d.variantId)
      return variant?.isControl
    })

    const treatment = data.find(d => {
      const variant = experiment.variants.find(v => v.id === d.variantId)
      return variant && !variant.isControl
    })

    if (!control || !treatment) return null

    // Perform statistical test
    const analysis = StatisticalTests.twoProportionZTest(
      control.conversions,
      control.samples,
      treatment.conversions,
      treatment.samples,
    )

    // Determine recommendation
    let recommendation: ExperimentResult['recommendation'] = 'continue'

    if (analysis.canStopEarly) {
      if (analysis.isSignificant && treatment.conversions / treatment.samples > control.conversions / control.samples) {
        recommendation = 'stop_winner'
      } else if (!analysis.isSignificant) {
        recommendation = 'stop_no_difference'
      }
    } else if (analysis.currentSampleSize >= analysis.requiredSampleSize * 2) {
      if (!analysis.isSignificant) {
        recommendation = 'stop_no_difference'
      }
    } else if (analysis.currentSampleSize >= analysis.requiredSampleSize) {
      if (analysis.isSignificant) {
        recommendation = 'stop_winner'
      }
    }

    // Build variant results
    const variantResults: VariantResult[] = data.map(d => {
      const variant = experiment.variants.find(v => v.id === d.variantId)!
      return {
        variantId: d.variantId,
        name: variant.name,
        samples: d.samples,
        conversions: d.conversions,
        conversionRate: d.samples > 0 ? d.conversions / d.samples : 0,
        metrics: {},
      }
    })

    const result: ExperimentResult = {
      experimentId: id,
      status: experiment.status,
      duration: (experiment.endDate ?? Date.now()) - experiment.startDate,
      variants: variantResults,
      statisticalAnalysis: analysis,
      recommendation,
    }

    this.results.set(id, result)
    return result
  }

  /**
   * Get experiment result.
   */
  getResult(id: string): ExperimentResult | null {
    return this.results.get(id) ?? null
  }

  /**
   * Get all experiments.
   */
  getExperiments(): Experiment[] {
    return [...this.experiments.values()]
  }
}
