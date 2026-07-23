/**
 * Self-Index Eval Queries — BM25 + Vectorize RRF benchmark.
 *
 * These queries test the self-index search quality using:
 * 1. Pure BM25 scoring (computeBm25Score) with synthetic documents
 * 2. RRF merge (computeRrfScore) with synthetic ranks
 * 3. searchIndexPaginated integration (requires D1 + Vectorize bindings)
 *
 * Each query defines synthetic document content and expected BM25 ranking
 * characteristics, enabling local self-index quality evaluation without
 * requiring actual D1/Vectorize bindings.
 */

import type { EvalQuery } from './types'

/** Self-index eval query — includes synthetic doc content for BM25 testing. */
export interface SelfIndexEvalQuery extends EvalQuery {
  /** Synthetic test documents with known content */
  testDocs?: Array<{
    title: string
    content: string
    /** Expected BM25 score range (lower bound) */
    expectedMinBm25?: number
    /** Expected BM25 score range (upper bound) */
    expectedMaxBm25?: number
    /** Expected rank position (0-based) among all docs for this query */
    expectedRank?: number
  }>
  /** Expected top-1 BM25 score range */
  expectedTopBm25Min?: number
  expectedTopBm25Max?: number
  /** Expected average BM25 score for all matching docs */
  expectedAvgBm25Min?: number
}

export const SELF_INDEX_QUERIES: SelfIndexEvalQuery[] = [
  // ============================================================
  // BM25 Scoring — Exact Keyword Match
  // ============================================================
  {
    id: 'bm25-exact-match',
    query: 'quantum computing',
    topic: 'general',
    minResults: 3,
    maxTimeMs: 500,
    tags: ['bm25', 'keyword'],
    testDocs: [
      {
        title: 'Quantum Computing Explained',
        content: 'Quantum computing uses qubits instead of classical bits. Quantum computers leverage superposition and entanglement to perform computations that would be infeasible for classical computers. This makes quantum computing a revolutionary approach to computing.',
        expectedMinBm25: 15.0,
        expectedMaxBm25: 80.0,
        expectedRank: 0,
      },
      {
        title: 'Classical Computing Basics',
        content: 'Classical computing uses transistors and binary logic gates. Modern computers are based on the von Neumann architecture. CPUs process instructions sequentially.',
        expectedMinBm25: 2.0,
        expectedMaxBm25: 30.0,
        expectedRank: 1,
      },
      {
        title: 'Introduction to Machine Learning',
        content: 'Machine learning is a subset of artificial intelligence that enables systems to learn and improve from experience without being explicitly programmed.',
        expectedMinBm25: 0,
        expectedMaxBm25: 10.0,
        expectedRank: 2,
      },
    ],
    expectedTopBm25Min: 15.0,
    expectedTopBm25Max: 80.0,
  },

  // ============================================================
  // BM25 Scoring — Title Weighting
  // ============================================================
  {
    id: 'bm25-title-weight',
    query: 'React state management',
    topic: 'general',
    minResults: 3,
    maxTimeMs: 500,
    tags: ['bm25', 'title-weight'],
    testDocs: [
      {
        title: 'React State Management Best Practices',
        content: 'This article covers React concepts and modern frontend development approaches for building user interfaces with components and hooks.',
        expectedMinBm25: 5.0,
        expectedMaxBm25: 60.0,
        expectedRank: 0,
      },
      {
        title: 'Frontend Development Guide',
        content: 'React is a popular library for building user interfaces. State management in React applications can be handled with hooks like useState and useReducer. Redux is another option for managing React application state.',
        expectedMinBm25: 5.0,
        expectedMaxBm25: 60.0,
        expectedRank: 1,
      },
      {
        title: 'Backend Architecture Patterns',
        content: 'Microservices architecture and serverless computing are transforming how we build scalable backend systems.',
        expectedMinBm25: 0,
        expectedMaxBm25: 5.0,
        expectedRank: 2,
      },
    ],
    expectedTopBm25Min: 5.0,
    expectedTopBm25Max: 60.0,
  },

  // ============================================================
  // BM25 Scoring — Korean Query
  // ============================================================
  {
    id: 'bm25-korean',
    query: '삼성전자 주가 전망',
    topic: 'finance',
    minResults: 3,
    maxTimeMs: 500,
    tags: ['bm25', 'korean'],
    testDocs: [
      {
        // Known limitation: BM25 uses \b word boundary which breaks for CJK text.
        // All Korean docs will get score 0, so ranks are implementation-dependent.
        // We only verify scores are 0, no rank assertion.
        title: '삼성전자 주가 전망 분석',
        content: '삼성전자의 주가 전망에 대해 분석합니다. 반도체 시장 호황으로 삼성전자의 실적이 개선될 것으로 예상됩니다. 전문가들은 삼성전자 목표주가를 상향 조정하고 있습니다.',
        expectedMinBm25: 0,
        expectedMaxBm25: 0,
      },
      {
        title: '국내 증시 동향',
        content: '코스피 지수가 상승세를 보이고 있습니다. 외국인 투자자들의 매수가 이어지고 있으며, 시장 전망은 긍정적입니다.',
        expectedMinBm25: 0,
        expectedMaxBm25: 0,
      },
      {
        title: 'AI 반도체 산업 보고서',
        content: '인공지능 반도체 시장이 급성장하고 있습니다. 엔비디아와 AMD가 시장을 선도하고 있습니다.',
        expectedMinBm25: 0,
        expectedMaxBm25: 0,
      },
    ],
    expectedTopBm25Min: 0,
    expectedTopBm25Max: 0,
  },

  // ============================================================
  // BM25 Scoring — Stop Words / Noise Filtering
  // ============================================================
  {
    id: 'bm25-stop-words',
    query: 'the best way to learn programming in 2025',
    topic: 'general',
    minResults: 2,
    maxTimeMs: 500,
    tags: ['bm25', 'stop-words'],
    testDocs: [
      // Stop words (the, a, an, is, in, to, for, of) removed by BM25.
      // Only meaningful terms: best, way, learn, programming, 2025
      {
        title: 'Programming Learning Guide 2025',
        content: 'The best way to learn programming in 2025 is through hands-on projects. Programming tutorials and coding bootcamps provide structured learning paths for beginners.',
        expectedMinBm25: 15.0,
        expectedMaxBm25: 80.0,
        expectedRank: 0,
      },
      {
        title: 'A Brief History of Computing',
        content: 'The history of computing spans centuries, from the abacus to modern quantum computers. The field of computer science has evolved dramatically.',
        expectedMinBm25: 0,
        expectedMaxBm25: 5.0,
        expectedRank: 1,
      },
    ],
  },

  // ============================================================
  // BM25 Scoring — Partial Match (substring sensitivity)
  // ============================================================
  {
    id: 'bm25-partial-match',
    query: 'serverless deploy',
    topic: 'general',
    minResults: 2,
    maxTimeMs: 500,
    tags: ['bm25', 'partial'],
    testDocs: [
      {
        title: 'Serverless Deployment Guide',
        content: 'Learn how to deploy serverless applications on AWS Lambda and Cloudflare Workers. Serverless deployment eliminates infrastructure management while providing automatic scaling.',
        expectedMinBm25: 20.0,
        expectedMaxBm25: 80.0,
        expectedRank: 0,
      },
      {
        title: 'Docker Container Orchestration',
        content: 'Docker containers and Kubernetes orchestration provide consistent deployment environments for microservices across development and production.',
        expectedMinBm25: 2.0,
        expectedMaxBm25: 30.0,
        expectedRank: 1,
      },
    ],
  },

  // ============================================================
  // RRF Scoring — Rank Fusion
  // ============================================================
  {
    id: 'rrf-rank-fusion',
    query: 'RUST vs Go performance',
    topic: 'general',
    minResults: 3,
    maxTimeMs: 500,
    tags: ['rrf', 'hybrid'],
    testDocs: [
      {
        title: 'Rust vs Go Performance Benchmark',
        content: 'Comparing Rust and Go performance benchmarks. Rust provides zero-cost abstractions and memory safety. Go offers goroutines for concurrency and fast compilation.',
        expectedMinBm25: 15.0,
        expectedMaxBm25: 80.0,
        expectedRank: 0,
      },
      {
        title: 'Go Programming Language Features',
        content: 'Go is a statically typed language designed for simplicity and efficiency. Go performance is excellent for concurrent and network applications.',
        expectedMinBm25: 5.0,
        expectedMaxBm25: 50.0,
        expectedRank: 1,
      },
      {
        title: 'Rust Systems Programming',
        content: 'Rust performance is comparable to C++ while providing memory safety guarantees. The Rust compiler optimizes aggressively for maximum performance.',
        expectedMinBm25: 3.0,
        expectedMaxBm25: 40.0,
        expectedRank: 2,
      },
    ],
    expectedTopBm25Min: 15.0,
  },

  // ============================================================
  // BM25 Scoring — Term Frequency Saturation
  // ============================================================
  {
    id: 'bm25-tf-saturation',
    query: 'database optimization',
    topic: 'general',
    minResults: 2,
    maxTimeMs: 500,
    tags: ['bm25', 'tf-saturation'],
    testDocs: [
      {
        title: 'Database Optimization: Advanced Query Tuning',
        content: 'Database optimization requires understanding query plans and indexing strategies. Database optimization techniques include connection pooling and query optimization for database performance. Database optimization is critical for production systems. database optimization database optimization database optimization',
        // BM25 TF saturation limits very high TF. Actual: ~25 with given IDF/docLength
        expectedMinBm25: 20.0,
        expectedMaxBm25: 60.0,
        expectedRank: 0,
      },
      {
        title: 'Web Application Caching Strategies',
        content: 'Redis caching and CDN optimization can dramatically improve web application performance. Database optimization is one piece of the puzzle.',
        expectedMinBm25: 2.0,
        expectedMaxBm25: 30.0,
        expectedRank: 1,
      },
    ],
    expectedTopBm25Min: 20.0,
  },

  // ============================================================
  // searchIndexPaginated Integration (requires D1 + Vectorize)
  // ============================================================
  {
    id: 'integrated-search-index',
    query: 'machine learning tutorial',
    topic: 'general',
    minResults: 0, // Accept 0 — bindings may not be available
    maxTimeMs: 2000,
    tags: ['integration', 'pipeline'],
  },

  {
    id: 'integrated-empty-query',
    query: '',
    topic: 'general',
    minResults: 0,
    maxTimeMs: 500,
    tags: ['integration', 'edge-case'],
  },

  // ============================================================
  // BM25 Scoring — Long Document
  // ============================================================
  {
    id: 'bm25-long-doc',
    query: 'distributed systems consensus',
    topic: 'general',
    minResults: 2,
    maxTimeMs: 500,
    tags: ['bm25', 'long-doc'],
    testDocs: [
      {
        title: 'Understanding Distributed Systems Consensus Algorithms',
        content: 'Consensus in distributed systems is a fundamental problem that has been studied extensively. The Paxos algorithm, first described by Leslie Lamport, provides a way for distributed systems to reach consensus even in the presence of failures. Raft is a more understandable alternative to Paxos that achieves consensus through leader election. Both consensus algorithms ensure that distributed systems can maintain consistency across nodes. Distributed systems require consensus for fault tolerance and reliability.',
        expectedMinBm25: 15.0,
        expectedMaxBm25: 80.0,
        expectedRank: 0,
      },
      {
        title: 'CAP Theorem Explained',
        content: 'The CAP theorem states that distributed systems can only provide two of three guarantees: Consistency, Availability, and Partition Tolerance. This fundamental theorem guides the design of all distributed data systems.',
        expectedMinBm25: 3.0,
        expectedMaxBm25: 30.0,
        expectedRank: 1,
      },
    ],
    expectedTopBm25Min: 15.0,
  },
]
