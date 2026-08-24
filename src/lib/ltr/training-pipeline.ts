/**
 * LTR Training Pipeline (Phase 1)
 *
 * Handles:
 * - Feature extraction from click logs
 * - Training data preparation
 * - Model export for sidecar serving
 * - Online learning support
 *
 * The pipeline runs weekly (or on-demand) to retrain the LTR model
 * from click data collected by ClickLogDO.
 */

import type { Env } from '../../types'
import { FEATURE_NAMES_V2, NUM_FEATURES } from './feature-store-v2'

// ============================================================
// Training data format
// ============================================================

export interface TrainingExample {
  query: string
  url: string
  label: number // 1 = clicked, 0 = not clicked
  features: number[]
  position: number
  group: string // query group for LambdaRank
}

export interface TrainingDataset {
  examples: TrainingExample[]
  featureNames: string[]
  numFeatures: number
  stats: {
    totalExamples: number
    positiveExamples: number
    negativeExamples: number
    uniqueQueries: number
    uniqueDomains: number
  }
}

export interface ModelMetadata {
  version: string
  trainedAt: string
  numFeatures: number
  featureNames: string[]
  trainingStats: TrainingDataset['stats']
}

// ============================================================
// Feature extraction
// ============================================================

/**
 * Extract features from raw training data.
 * Uses the same feature computation as serving to ensure train/serve consistency.
 */
export async function extractFeatures(
  env: Env,
  query: string,
  url: string,
  position: number,
  score: number,
): Promise<number[]> {
  // Import feature computation dynamically to avoid circular deps
  const { computeQueryFeaturesV2, computeResultFeaturesV2 } = await import('./feature-store-v2')

  const qFeats = computeQueryFeaturesV2(query)

  // Create a mock SearchResult for feature computation
  const result = {
    title: '', // Would need to fetch from cache or recompute
    url,
    content: '',
    score,
    domain: new URL(url).hostname,
  }

  return computeResultFeaturesV2(
    query,
    result,
    qFeats,
    'unknown', // source backend unknown at training time
    position,
  )
}

// ============================================================
// Dataset preparation
// ============================================================

/**
 * Prepare training dataset from click log data.
 */
export function prepareDataset(examples: TrainingExample[]): TrainingDataset {
  const uniqueQueries = new Set(examples.map((e) => e.query))
  const uniqueDomains = new Set(
    examples.map((e) => {
      try {
        return new URL(e.url).hostname
      } catch {
        return ''
      }
    }),
  )

  const positiveExamples = examples.filter((e) => e.label === 1).length
  const negativeExamples = examples.filter((e) => e.label === 0).length

  return {
    examples,
    featureNames: [...FEATURE_NAMES_V2],
    numFeatures: NUM_FEATURES,
    stats: {
      totalExamples: examples.length,
      positiveExamples,
      negativeExamples,
      uniqueQueries: uniqueQueries.size,
      uniqueDomains: uniqueDomains.size,
    },
  }
}

/**
 * Split dataset into train/validation sets.
 */
export function splitDataset(
  dataset: TrainingDataset,
  trainRatio: number = 0.8,
): { train: TrainingDataset; val: TrainingDataset } {
  const shuffled = [...dataset.examples].sort(() => Math.random() - 0.5)
  const splitIdx = Math.floor(shuffled.length * trainRatio)

  return {
    train: prepareDataset(shuffled.slice(0, splitIdx)),
    val: prepareDataset(shuffled.slice(splitIdx)),
  }
}

// ============================================================
// LightGBM export
// ============================================================

/**
 * Export dataset in LightGBM format.
 * Format: label group_id feature1:val1 feature2:val2 ...
 */
export function exportToLightGBM(dataset: TrainingDataset): string {
  const lines: string[] = []

  // Header comment
  lines.push(`# LightGBM training data`)
  lines.push(`# Features: ${dataset.featureNames.join(', ')}`)
  lines.push(`# Examples: ${dataset.stats.totalExamples}`)
  lines.push(`# Positive: ${dataset.stats.positiveExamples}, Negative: ${dataset.stats.negativeExamples}`)
  lines.push('')

  // Group by query for LambdaRank
  const grouped = new Map<string, TrainingExample[]>()
  for (const ex of dataset.examples) {
    const group = grouped.get(ex.query) ?? []
    group.push(ex)
    grouped.set(ex.query, group)
  }

  // Write examples
  let groupIdx = 0
  for (const [query, examples] of grouped) {
    lines.push(`# query: ${query}`)
    for (const ex of examples) {
      const featureStr = ex.features.map((f, i) => `${i}:${f.toFixed(6)}`).join(' ')
      lines.push(`${ex.label} ${groupIdx} ${featureStr}`)
    }
    groupIdx++
  }

  return lines.join('\n')
}

// ============================================================
// Model metadata
// ============================================================

/**
 * Generate model metadata for versioning.
 */
export function generateModelMetadata(dataset: TrainingDataset, version?: string): ModelMetadata {
  return {
    version: version ?? `v${Date.now()}`,
    trainedAt: new Date().toISOString(),
    numFeatures: dataset.numFeatures,
    featureNames: dataset.featureNames,
    trainingStats: dataset.stats,
  }
}

// ============================================================
// Feature importance analysis
// ============================================================

/**
 * Compute feature importance based on correlation with labels.
 * Simple but effective for initial feature selection.
 */
export function computeFeatureImportance(
  dataset: TrainingDataset,
): Array<{ feature: string; importance: number; rank: number }> {
  const { examples, featureNames, numFeatures } = dataset
  if (examples.length === 0) return []

  const importances: number[] = new Array(numFeatures).fill(0)

  // Compute correlation of each feature with label
  for (let f = 0; f < numFeatures; f++) {
    const posVals: number[] = []
    const negVals: number[] = []

    for (const ex of examples) {
      if (ex.label === 1) posVals.push(ex.features[f])
      else negVals.push(ex.features[f])
    }

    if (posVals.length === 0 || negVals.length === 0) continue

    const posMean = posVals.reduce((a, b) => a + b, 0) / posVals.length
    const negMean = negVals.reduce((a, b) => a + b, 0) / negVals.length

    // Simple importance: difference in means
    importances[f] = Math.abs(posMean - negMean)
  }

  // Normalize and sort
  const maxImp = Math.max(...importances, 0.001)
  const normalized = importances.map((imp, i) => ({
    feature: featureNames[i] ?? `feature_${i}`,
    importance: imp / maxImp,
    rank: 0,
  }))

  normalized.sort((a, b) => b.importance - a.importance)
  normalized.forEach((item, i) => {
    item.rank = i + 1
  })

  return normalized
}
