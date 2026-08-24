/**
 * 로컬 인덱싱 서비스
 *
 * ChromaDB + Ollama를 사용한 완전 로컬 인덱싱 파이프라인
 * Cloudflare 없이 로컬에서 인덱싱/검색 가능
 *
 * 장점:
 * - 인터넷 불필요 (오프라인 가능)
 * - 비용 $0
 * - 빠른 인덱싱 (API 호출 없음)
 * - 데이터 완전 로컬 보관
 *
 * 단점:
 * - 로컬 리소스 사용 (CPU/메모리)
 * - Cloudflare와 동기화 필요
 */

import { logger, toError } from './logger'

// ============================================================
// Types
// ============================================================

export interface LocalDocument {
  id: string
  url: string
  title: string
  content: string
  domain: string
  language?: string
  publishedDate?: string
}

export interface LocalSearchResult {
  id: string
  url: string
  title: string
  content: string
  domain: string
  score: number
  metadata: Record<string, unknown>
}

export interface LocalIndexingConfig {
  /** ChromaDB URL */
  chromaUrl: string
  /** Ollama URL */
  ollamaUrl: string
  /** 임베딩 모델 */
  embeddingModel: string
  /** 컬렉션 이름 */
  collectionName: string
  /** 배치 크기 */
  batchSize: number
  /** 청크 크기 (토큰) */
  chunkSize: number
  /** 청크 오버랩 (토큰) */
  chunkOverlap: number
}

// ============================================================
// Default Configuration
// ============================================================

export const DEFAULT_LOCAL_CONFIG: LocalIndexingConfig = {
  chromaUrl: process.env.CHROMA_URL || 'http://localhost:8000',
  ollamaUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
  embeddingModel: 'nomic-embed-text',
  collectionName: 'search-index',
  batchSize: 100,
  chunkSize: 300,
  chunkOverlap: 50,
}

// ============================================================
// Local Indexing Service
// ============================================================

export class LocalIndexingService {
  private config: LocalIndexingConfig
  private chromaReady = false
  private ollamaReady = false

  constructor(config: Partial<LocalIndexingConfig> = {}) {
    this.config = { ...DEFAULT_LOCAL_CONFIG, ...config }
  }

  /**
   * 서비스 초기화 확인
   */
  async initialize(): Promise<{ chroma: boolean; ollama: boolean }> {
    // ChromaDB 연결 확인
    try {
      const response = await fetch(`${this.config.chromaUrl}/api/v1/heartbeat`)
      this.chromaReady = response.ok
      logger.info(`[LocalIndex] ChromaDB ${this.chromaReady ? '연결됨' : '연결 실패'}`)
    } catch (err) {
      this.chromaReady = false
      logger.warn(`[LocalIndex] ChromaDB 연결 실패:`, { error: toError(err) })
    }

    // Ollama 연결 확인
    try {
      const response = await fetch(`${this.config.ollamaUrl}/api/tags`)
      this.ollamaReady = response.ok
      logger.info(`[LocalIndex] Ollama ${this.ollamaReady ? '연결됨' : '연결 실패'}`)
    } catch (err) {
      this.ollamaReady = false
      logger.warn(`[LocalIndex] Ollama 연결 실패:`, { error: toError(err) })
    }

    return { chroma: this.chromaReady, ollama: this.ollamaReady }
  }

  /**
   * 문서 인덱싱
   */
  async indexDocument(doc: LocalDocument): Promise<boolean> {
    if (!this.chromaReady || !this.ollamaReady) {
      logger.warn('[LocalIndex] 서비스 미준비')
      return false
    }

    try {
      // 1. 콘텐츠 청킹
      const chunks = this.chunkContent(doc.content)

      // 2. 임베딩 생성
      const embeddings = await this.generateEmbeddings(chunks)

      // 3. ChromaDB에 저장
      await this.saveToChroma(doc, chunks, embeddings)

      return true
    } catch (err) {
      logger.error(`[LocalIndex] 인덱싱 실패: ${doc.url}`, { error: toError(err) })
      return false
    }
  }

  /**
   * 배치 인덱싱
   */
  async indexBatch(documents: LocalDocument[]): Promise<{ success: number; failed: number }> {
    let success = 0
    let failed = 0

    for (const doc of documents) {
      const result = await this.indexDocument(doc)
      if (result) success++
      else failed++
    }

    return { success, failed }
  }

  /**
   * 검색
   */
  async search(query: string, topK: number = 10): Promise<LocalSearchResult[]> {
    if (!this.chromaReady || !this.ollamaReady) {
      logger.warn('[LocalIndex] 서비스 미준비')
      return []
    }

    try {
      // 1. 쿼리 임베딩 생성
      const queryEmbedding = await this.generateEmbedding(query)

      // 2. ChromaDB에서 검색
      const results = await this.searchChroma(queryEmbedding, topK)

      return results
    } catch (err) {
      logger.error('[LocalIndex] 검색 실패', { error: toError(err) })
      return []
    }
  }

  /**
   * 인덱스 상태 확인
   */
  async getStats(): Promise<{
    totalDocuments: number
    totalChunks: number
    chromaReady: boolean
    ollamaReady: boolean
  }> {
    const totalDocuments = 0
    let totalChunks = 0

    if (this.chromaReady) {
      try {
        const response = await fetch(`${this.config.chromaUrl}/api/v1/collections/${this.config.collectionName}`)
        if (response.ok) {
          const collection = (await response.json()) as { count?: number }
          totalChunks = collection.count ?? 0
        }
      } catch {
        // 무시
      }
    }

    return {
      totalDocuments,
      totalChunks,
      chromaReady: this.chromaReady,
      ollamaReady: this.ollamaReady,
    }
  }

  // ============================================================
  // Private Methods
  // ============================================================

  /**
   * 콘텐츠 청킹
   */
  private chunkContent(content: string): string[] {
    const chunks: string[] = []
    const words = content.split(/\s+/)
    const chunkSize = this.config.chunkSize
    const overlap = this.config.chunkOverlap

    for (let i = 0; i < words.length; i += chunkSize - overlap) {
      const chunk = words.slice(i, i + chunkSize).join(' ')
      if (chunk.trim().length > 0) {
        chunks.push(chunk)
      }
    }

    return chunks.length > 0 ? chunks : [content]
  }

  /**
   * 임베딩 생성 (배치)
   */
  private async generateEmbeddings(texts: string[]): Promise<number[][]> {
    const embeddings: number[][] = []

    for (let i = 0; i < texts.length; i += this.config.batchSize) {
      const batch = texts.slice(i, i + this.config.batchSize)
      const batchEmbeddings = await Promise.all(batch.map((text) => this.generateEmbedding(text)))
      embeddings.push(...batchEmbeddings)
    }

    return embeddings
  }

  /**
   * 단일 임베딩 생성
   */
  private async generateEmbedding(text: string): Promise<number[]> {
    const response = await fetch(`${this.config.ollamaUrl}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.config.embeddingModel,
        prompt: text,
      }),
    })

    if (!response.ok) {
      throw new Error(`Ollama embedding 실패: ${response.status}`)
    }

    const data = (await response.json()) as { embedding: number[] }
    return data.embedding
  }

  /**
   * ChromaDB에 저장
   */
  private async saveToChroma(doc: LocalDocument, chunks: string[], embeddings: number[][]): Promise<void> {
    const ids = chunks.map((_, i) => `${doc.id}_chunk_${i}`)
    const metadatas = chunks.map(() => ({
      url: doc.url,
      title: doc.title,
      domain: doc.domain,
      language: doc.language || 'en',
      publishedDate: doc.publishedDate || '',
    }))

    const response = await fetch(`${this.config.chromaUrl}/api/v1/collections/${this.config.collectionName}/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ids,
        documents: chunks,
        embeddings,
        metadatas,
      }),
    })

    if (!response.ok) {
      throw new Error(`ChromaDB 저장 실패: ${response.status}`)
    }
  }

  /**
   * ChromaDB 검색
   */
  private async searchChroma(queryEmbedding: number[], topK: number): Promise<LocalSearchResult[]> {
    const response = await fetch(`${this.config.chromaUrl}/api/v1/collections/${this.config.collectionName}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query_embeddings: [queryEmbedding],
        n_results: topK,
        include: ['documents', 'metadatas', 'distances'],
      }),
    })

    if (!response.ok) {
      throw new Error(`ChromaDB 검색 실패: ${response.status}`)
    }

    const data = (await response.json()) as {
      ids: string[][]
      documents: string[][]
      metadatas: Record<string, unknown>[][]
      distances: number[][]
    }

    const results: LocalSearchResult[] = []
    if (data.ids?.[0]) {
      for (let i = 0; i < data.ids[0].length; i++) {
        const metadata = (data.metadatas?.[0]?.[i] as Record<string, unknown>) || {}
        results.push({
          id: data.ids[0][i],
          url: (metadata.url as string) || '',
          title: (metadata.title as string) || '',
          content: data.documents?.[0]?.[i] || '',
          domain: (metadata.domain as string) || '',
          score: 1 - (data.distances?.[0]?.[i] || 0), // 거리를 유사도로 변환
          metadata,
        })
      }
    }

    return results
  }
}

// ============================================================
// Convenience Functions
// ============================================================

let localService: LocalIndexingService | null = null

export function getLocalIndexingService(config?: Partial<LocalIndexingConfig>): LocalIndexingService {
  if (!localService) {
    localService = new LocalIndexingService(config)
  }
  return localService
}

export async function indexDocumentLocally(doc: LocalDocument): Promise<boolean> {
  const service = getLocalIndexingService()
  return service.indexDocument(doc)
}

export async function searchLocally(query: string, topK?: number): Promise<LocalSearchResult[]> {
  const service = getLocalIndexingService()
  return service.search(query, topK)
}
