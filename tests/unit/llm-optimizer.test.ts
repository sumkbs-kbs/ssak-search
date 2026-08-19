import { describe, it, expect, beforeEach } from 'vitest'
import { LLMCache, LLMOptimizer, StreamingResponseHandler, resetLLMOptimizer } from '../../src/lib/llm/llm-optimizer'

describe('LLMCache', () => {
  let cache: LLMCache

  beforeEach(() => {
    cache = new LLMCache({
      cacheTtlSeconds: 1, // 1 second for testing
      maxCacheSize: 3,
    })
  })

  it('should store and retrieve cached responses', () => {
    cache.set('test query', 'test response', 'gpt-4o-mini')
    const result = cache.get('test query')

    expect(result).not.toBeNull()
    expect(result?.response).toBe('test response')
    expect(result?.model).toBe('gpt-4o-mini')
  })

  it('should return null for cache miss', () => {
    const result = cache.get('nonexistent query')
    expect(result).toBeNull()
  })

  it('should evict least used entry when at capacity', () => {
    cache.set('query1', 'response1', 'model1')
    cache.set('query2', 'response2', 'model2')
    cache.set('query3', 'response3', 'model3')

    // Access query1 to make it more used
    cache.get('query1')
    cache.get('query1')

    // Add query4 - should evict query2 (least used)
    cache.set('query4', 'response4', 'model4')

    expect(cache.get('query1')).not.toBeNull()
    expect(cache.get('query2')).toBeNull()
    expect(cache.get('query3')).not.toBeNull()
    expect(cache.get('query4')).not.toBeNull()
  })

  it('should respect TTL expiration', async () => {
    cache.set('test query', 'test response', 'model')
    
    // Wait for TTL to expire
    await new Promise(resolve => setTimeout(resolve, 1100))
    
    const result = cache.get('test query')
    expect(result).toBeNull()
  })

  it('should normalize queries', () => {
    cache.set('  Test Query  ', 'response', 'model')
    
    expect(cache.get('test query')).not.toBeNull()
    expect(cache.get('TEST QUERY')).not.toBeNull()
  })

  it('should track hit count', () => {
    cache.set('test query', 'response', 'model')
    
    cache.get('test query')
    cache.get('test query')
    
    const stats = cache.getStats()
    expect(stats.avgHitCount).toBeGreaterThan(0)
  })

  it('should return stats', () => {
    cache.set('query1', 'response1', 'model')
    cache.set('query2', 'response2', 'model')
    
    const stats = cache.getStats()
    expect(stats.size).toBe(2)
  })
})

describe('LLMOptimizer', () => {
  let optimizer: LLMOptimizer

  beforeEach(() => {
    resetLLMOptimizer()
    optimizer = new LLMOptimizer({
      cacheTtlSeconds: 60,
      maxCacheSize: 100,
    })
  })

  it('should generate response', async () => {
    const response = await optimizer.generate('test query', ['context1'])

    expect(response.text).toBeDefined()
    expect(response.model).toBeDefined()
    expect(response.cached).toBe(false)
    expect(response.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('should return cached response on second call', async () => {
    const response1 = await optimizer.generate('test query', ['context1'])
    const response2 = await optimizer.generate('test query', ['context1'])

    expect(response2.cached).toBe(true)
    expect(response2.text).toBe(response1.text)
    expect(response2.latencyMs).toBeLessThan(response1.latencyMs)
  })

  it('should select fast model for simple queries', async () => {
    const response = await optimizer.generate('hello', [], { useFastModel: true })
    expect(response.model).toBe(optimizer['config'].fastModel)
  })

  it('should estimate tokens', async () => {
    const response = await optimizer.generate('test query', [])
    expect(response.tokensUsed).toBeGreaterThan(0)
  })

  it('should return stats', () => {
    const stats = optimizer.getStats()
    expect(stats.cache).toBeDefined()
    expect(stats.config).toBeDefined()
  })
})

describe('StreamingResponseHandler', () => {
  let handler: StreamingResponseHandler

  beforeEach(() => {
    handler = new StreamingResponseHandler()
  })

  it('should accumulate chunks', () => {
    handler.onChunk('Hello ')
    handler.onChunk('World')
    expect(handler.getCurrentText()).toBe('Hello World')
  })

  it('should complete and return full text', () => {
    handler.onChunk('Hello ')
    handler.onChunk('World')
    
    const text = handler.complete()
    expect(text).toBe('Hello World')
  })

  it('should reset after complete', () => {
    handler.onChunk('Hello')
    handler.complete()
    handler.onChunk('World')
    
    expect(handler.getCurrentText()).toBe('World')
  })

  it('should call onComplete callback', () => {
    let completedText = ''
    handler.setOnComplete((text) => { completedText = text })
    
    handler.onChunk('Hello')
    handler.complete()
    
    expect(completedText).toBe('Hello')
  })
})
