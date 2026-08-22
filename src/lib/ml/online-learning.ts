/**
 * Online Learning Pipeline (Phase 4)
 *
 * Enables real-time model updates based on user feedback:
 * - Incremental model training from click data
 * - Feature drift detection
 * - Model versioning and rollback
 * - A/B test integration for model evaluation
 *
 * Architecture:
 * - Feature store for real-time feature serving
 * - Online gradient descent for model updates
 * - Model registry for version management
 * - Drift detection for data quality monitoring
 */

import { logger } from '../logger'

// ============================================================
// Types
// ============================================================

export interface OnlineModel {
  modelId: string
  version: string
  weights: number[]
  bias: number
  learningRate: number
  createdAt: number
  updatedAt: number
  metrics: ModelMetrics
}

export interface ModelMetrics {
  accuracy: number
  precision: number
  recall: number
  f1Score: number
  auc: number
  samplesTrained: number
}

export interface TrainingExample {
  features: number[]
  label: number // 0 or 1
  weight: number // importance weight
  timestamp: number
  userId?: string
  query?: string
}

export interface FeatureDrift {
  feature: string
  driftScore: number
  threshold: number
  isDrifting: boolean
  samples: number
}

export interface ModelVersion {
  version: string
  modelId: string
  weights: number[]
  bias: number
  metrics: ModelMetrics
  createdAt: number
  promotedAt?: number
  status: 'active' | 'shadow' | 'archived'
}

// ============================================================
// Online Gradient Descent
// ============================================================

export class OnlineLearner {
  private model: OnlineModel
  private featureMeans: number[]
  private featureVars: number[]
  private sampleCount: number

  constructor(numFeatures: number, learningRate: number = 0.01) {
    this.model = {
      modelId: 'ltr-online',
      version: 'v1',
      weights: new Array(numFeatures).fill(0),
      bias: 0,
      learningRate,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      metrics: {
        accuracy: 0,
        precision: 0,
        recall: 0,
        f1Score: 0,
        auc: 0,
        samplesTrained: 0,
      },
    }

    this.featureMeans = new Array(numFeatures).fill(0)
    this.featureVars = new Array(numFeatures).fill(1)
    this.sampleCount = 0
  }

  /**
   * Update model with a single training example.
   */
  update(example: TrainingExample): void {
    const { features, label, weight } = example

    // Update running statistics for normalization
    this.updateFeatureStats(features)

    // Normalize features
    const normalizedFeatures = this.normalize(features)

    // Compute prediction
    const prediction = this.predictRaw(normalizedFeatures)

    // Compute gradient (logistic loss)
    const error = label - prediction

    // Update weights with gradient descent
    for (let i = 0; i < this.model.weights.length; i++) {
      const gradient = error * normalizedFeatures[i] * weight
      this.model.weights[i] += this.model.learningRate * gradient
    }

    // Update bias
    this.model.bias += this.model.learningRate * error * weight

    // Update metrics
    this.model.metrics.samplesTrained++
    this.model.updatedAt = Date.now()

    // Update online metrics
    this.updateMetrics(prediction, label)
  }

  /**
   * Predict score for a feature vector.
   */
  predict(features: number[]): number {
    const normalizedFeatures = this.normalize(features)
    return this.predictRaw(normalizedFeatures)
  }

  /**
   * Predict scores for multiple examples.
   */
  predictBatch(examples: number[][]): number[] {
    return examples.map(f => this.predict(f))
  }

  /**
   * Get model state for serialization.
   */
  getModel(): OnlineModel {
    return { ...this.model }
  }

  /**
   * Load model from serialized state.
   */
  loadModel(model: OnlineModel): void {
    this.model = model
  }

  /**
   * Get online metrics.
   */
  getMetrics(): ModelMetrics {
    return { ...this.model.metrics }
  }

  /**
   * Reset model to initial state.
   */
  reset(): void {
    this.model.weights.fill(0)
    this.model.bias = 0
    this.model.metrics = {
      accuracy: 0,
      precision: 0,
      recall: 0,
      f1Score: 0,
      auc: 0,
      samplesTrained: 0,
    }
    this.sampleCount = 0
  }

  // ============================================================
  // Private methods
  // ============================================================

  private predictRaw(features: number[]): number {
    let score = this.model.bias
    for (let i = 0; i < features.length; i++) {
      score += features[i] * (this.model.weights[i] ?? 0)
    }
    return this.sigmoid(score)
  }

  private sigmoid(x: number): number {
    return 1 / (1 + Math.exp(-Math.max(-500, Math.min(500, x))))
  }

  private normalize(features: number[]): number[] {
    return features.map((f, i) => {
      const mean = this.featureMeans[i] ?? 0
      const variance = this.featureVars[i] ?? 1
      const std = Math.sqrt(variance) || 1
      return (f - mean) / std
    })
  }

  private updateFeatureStats(features: number[]): void {
    this.sampleCount++

    for (let i = 0; i < features.length; i++) {
      const f = features[i] ?? 0
      const oldMean = this.featureMeans[i] ?? 0
      const oldVar = this.featureVars[i] ?? 1

      // Welford's online algorithm
      const delta = f - oldMean
      const newMean = oldMean + delta / this.sampleCount
      const delta2 = f - newMean

      this.featureMeans[i] = newMean
      this.featureVars[i] = oldVar + (delta * delta2 - oldVar) / this.sampleCount
    }
  }

  private updateMetrics(prediction: number, label: number): void {
    const predicted = prediction >= 0.5 ? 1 : 0
    const correct = predicted === label

    // Running averages
    const m = this.model.metrics
    const n = m.samplesTrained

    m.accuracy = ((n - 1) * m.accuracy + (correct ? 1 : 0)) / n

    if (predicted === 1) {
      m.precision = ((n - 1) * m.precision + (label === 1 ? 1 : 0)) / n
    }

    if (label === 1) {
      m.recall = ((n - 1) * m.recall + (predicted === 1 ? 1 : 0)) / n
    }

    // F1 score
    if (m.precision + m.recall > 0) {
      m.f1Score = (2 * m.precision * m.recall) / (m.precision + m.recall)
    }
  }
}

// ============================================================
// Feature Drift Detector
// ============================================================

export class FeatureDriftDetector {
  private baselines: Map<string, { mean: number; std: number }> = new Map()
  private currentStats: Map<string, { mean: number; variance: number; count: number }> = new Map()
  private windowSize: number
  private threshold: number

  constructor(windowSize: number = 1000, threshold: number = 0.1) {
    this.windowSize = windowSize
    this.threshold = threshold
  }

  /**
   * Set baseline statistics for a feature.
   */
  setBaseline(feature: string, mean: number, std: number): void {
    this.baselines.set(feature, { mean, std })
  }

  /**
   * Record feature values and detect drift.
   */
  recordAndDetect(features: Record<string, number>): FeatureDrift[] {
    const drifts: FeatureDrift[] = []

    for (const [feature, value] of Object.entries(features)) {
      // Update running stats
      const stats = this.currentStats.get(feature) ?? { mean: 0, variance: 0, count: 0 }
      stats.count++

      // Welford's online algorithm
      const delta = value - stats.mean
      stats.mean += delta / stats.count
      const delta2 = value - stats.mean
      stats.variance += (delta * delta2 - stats.variance) / stats.count

      this.currentStats.set(feature, stats)

      // Check drift if we have enough samples and a baseline
      if (stats.count >= this.windowSize) {
        const baseline = this.baselines.get(feature)
        if (baseline) {
          const _currentStd = Math.sqrt(stats.variance) || 1
          const driftScore = Math.abs(stats.mean - baseline.mean) / baseline.std

          drifts.push({
            feature,
            driftScore,
            threshold: this.threshold,
            isDrifting: driftScore > this.threshold,
            samples: stats.count,
          })
        }
      }
    }

    return drifts
  }

  /**
   * Get drift statistics.
   */
  getStats(): {
    featuresTracked: number
    driftingFeatures: string[]
    avgDriftScore: number
  } {
    const drifts = [...this.currentStats.entries()]
      .filter(([feature]) => this.baselines.has(feature))
      .map(([feature, stats]) => {
        const baseline = this.baselines.get(feature)
        if (!baseline) return null
        const driftScore = Math.abs(stats.mean - baseline.mean) / baseline.std
        return { feature, driftScore }
      })
      .filter((d): d is { feature: string; driftScore: number } => d !== null)

    const driftingFeatures = drifts
      .filter(d => d.driftScore > this.threshold)
      .map(d => d.feature)

    const avgDriftScore = drifts.length > 0
      ? drifts.reduce((sum, d) => sum + d.driftScore, 0) / drifts.length
      : 0

    return {
      featuresTracked: drifts.length,
      driftingFeatures,
      avgDriftScore,
    }
  }

  /**
   * Reset detector.
   */
  reset(): void {
    this.currentStats.clear()
  }
}

// ============================================================
// Model Registry
// ============================================================

export class ModelRegistry {
  private models: Map<string, ModelVersion[]> = new Map()

  /**
   * Register a new model version.
   */
  register(modelId: string, model: OnlineModel): string {
    const versions = this.models.get(modelId) ?? []
    const version = `v${versions.length + 1}`

    const modelVersion: ModelVersion = {
      version,
      modelId,
      weights: [...model.weights],
      bias: model.bias,
      metrics: { ...model.metrics },
      createdAt: Date.now(),
      status: 'shadow',
    }

    versions.push(modelVersion)
    this.models.set(modelId, versions)

    return version
  }

  /**
   * Promote a model version to active.
   */
  promote(modelId: string, version: string): boolean {
    const versions = this.models.get(modelId)
    if (!versions) return false

    // Archive current active
    for (const v of versions) {
      if (v.status === 'active') {
        v.status = 'archived'
      }
    }

    // Promote new version
    const target = versions.find(v => v.version === version)
    if (!target) return false

    target.status = 'active'
    target.promotedAt = Date.now()
    return true
  }

  /**
   * Get active model version.
   */
  getActive(modelId: string): ModelVersion | null {
    const versions = this.models.get(modelId)
    if (!versions) return null

    return versions.find(v => v.status === 'active') ?? null
  }

  /**
   * Get all versions for a model.
   */
  getVersions(modelId: string): ModelVersion[] {
    return this.models.get(modelId) ?? []
  }

  /**
   * Get model registry stats.
   */
  getStats(): {
    models: number
    totalVersions: number
    activeModels: string[]
  } {
    let totalVersions = 0
    const activeModels: string[] = []

    for (const [modelId, versions] of this.models) {
      totalVersions += versions.length
      if (versions.some(v => v.status === 'active')) {
        activeModels.push(modelId)
      }
    }

    return {
      models: this.models.size,
      totalVersions,
      activeModels,
    }
  }
}

// ============================================================
// Real-time Learning Pipeline
// ============================================================

export class OnlineLearningPipeline {
  private learner: OnlineLearner
  private driftDetector: FeatureDriftDetector
  private registry: ModelRegistry
  private trainingBuffer: TrainingExample[]
  private bufferSize: number

  constructor(numFeatures: number, config?: {
    learningRate?: number
    driftWindowSize?: number
    driftThreshold?: number
    bufferSize?: number
  }) {
    this.learner = new OnlineLearner(numFeatures, config?.learningRate)
    this.driftDetector = new FeatureDriftDetector(
      config?.driftWindowSize,
      config?.driftThreshold,
    )
    this.registry = new ModelRegistry()
    this.trainingBuffer = []
    this.bufferSize = config?.bufferSize ?? 100
  }

  /**
   * Process a new training example.
   */
  processExample(example: TrainingExample): void {
    // Add to buffer
    this.trainingBuffer.push(example)

    // Train if buffer is full
    if (this.trainingBuffer.length >= this.bufferSize) {
      this.flushBuffer()
    }
  }

  /**
   * Flush training buffer.
   */
  flushBuffer(): void {
    if (this.trainingBuffer.length === 0) return

    // Train on buffered examples
    for (const example of this.trainingBuffer) {
      this.learner.update(example)
    }

    logger.info('[OnlineLearning] Trained on batch', {
      examples: this.trainingBuffer.length,
      metrics: this.learner.getMetrics(),
    })

    this.trainingBuffer = []
  }

  /**
   * Predict using current model.
   */
  predict(features: number[]): number {
    return this.learner.predict(features)
  }

  /**
   * Record features for drift detection.
   */
  recordFeatures(features: Record<string, number>): FeatureDrift[] {
    return this.driftDetector.recordAndDetect(features)
  }

  /**
   * Get current model.
   */
  getModel(): OnlineModel {
    return this.learner.getModel()
  }

  /**
   * Save current model to registry.
   */
  saveModel(): string {
    const model = this.learner.getModel()
    return this.registry.register(model.modelId, model)
  }

  /**
   * Get pipeline stats.
   */
  getStats(): {
    model: ModelMetrics
    drift: ReturnType<FeatureDriftDetector['getStats']>
    registry: ReturnType<ModelRegistry['getStats']>
    bufferSize: number
  } {
    return {
      model: this.learner.getMetrics(),
      drift: this.driftDetector.getStats(),
      registry: this.registry.getStats(),
      bufferSize: this.trainingBuffer.length,
    }
  }

  /**
   * Reset pipeline.
   */
  reset(): void {
    this.learner.reset()
    this.driftDetector.reset()
    this.trainingBuffer = []
  }
}
