import type { EvalQuery } from './types'

/**
 * Canonical eval query set — 112 queries across all types, languages, and topics.
 *
 * Coverage:
 * - Korean (20): stock, news, tech, general, travel, food, entertainment, health, education, sports
 * - English (50): financial, technical, factual, news, academic, comparison, general
 * - Chinese (12): factual, tech, news, general
 * - Japanese (8): factual, tech, travel
 * - Multi-topic (22): finance, news, technical, factual, academic, general, comparison
 *
 * Each query has expected quality characteristics — a regression is
 * when the current run falls below any of these thresholds.
 */
export const EVAL_QUERIES: EvalQuery[] = [
  // ════════════════════════════════════════════════════════════════
  // KOREAN QUERIES (20)
  // ════════════════════════════════════════════════════════════════
  { id: 'kr-stock-01', query: '삼성전자 주가', topic: 'finance', minResults: 8, maxTimeMs: 10_000, requiredBackends: ['naver'], tags: ['korean', 'financial'] },
  { id: 'kr-stock-02', query: '카카오 실적 발표', topic: 'finance', minResults: 5, maxTimeMs: 10_000, tags: ['korean', 'financial'] },
  { id: 'kr-stock-03', query: '네이버 시가총액 순위', topic: 'finance', minResults: 5, maxTimeMs: 10_000, tags: ['korean', 'financial'] },
  { id: 'kr-stock-04', query: '현대차 배당금', topic: 'finance', minResults: 5, maxTimeMs: 10_000, tags: ['korean', 'financial'] },
  { id: 'kr-stock-05', query: 'KOSPI 지수 오늘', topic: 'finance', minResults: 5, maxTimeMs: 10_000, tags: ['korean', 'financial'] },
  { id: 'kr-news-01', query: 'AI 최신 뉴스 2025', topic: 'news', minResults: 5, maxTimeMs: 10_000, tags: ['korean', 'news'] },
  { id: 'kr-news-02', query: '삼성전자 뉴스 최신', topic: 'news', minResults: 5, maxTimeMs: 10_000, tags: ['korean', 'news'] },
  { id: 'kr-news-03', query: '한국 경제 전망', topic: 'news', minResults: 5, maxTimeMs: 10_000, tags: ['korean', 'news'] },
  { id: 'kr-news-04', query: '부동산 시장 동향', topic: 'news', minResults: 5, maxTimeMs: 10_000, tags: ['korean', 'news'] },
  { id: 'kr-tech-01', query: 'React 상태관리 방법', topic: 'general', minResults: 5, maxTimeMs: 12_000, tags: ['korean', 'technical'] },
  { id: 'kr-tech-02', query: 'TypeScript 타입 가드 사용법', topic: 'general', minResults: 5, maxTimeMs: 12_000, tags: ['korean', 'technical'] },
  { id: 'kr-tech-03', query: 'Docker 컨테이너 배포 가이드', topic: 'general', minResults: 5, maxTimeMs: 12_000, tags: ['korean', 'technical'] },
  { id: 'kr-tech-04', query: 'Next.js 서버사이드 렌더링', topic: 'general', minResults: 5, maxTimeMs: 12_000, tags: ['korean', 'technical'] },
  { id: 'kr-tech-05', query: 'AWS Lambda 한국 리전', topic: 'general', minResults: 5, maxTimeMs: 12_000, tags: ['korean', 'technical'] },
  { id: 'kr-general-01', query: '서울 맛집 추천', topic: 'general', minResults: 5, maxTimeMs: 12_000, tags: ['korean', 'general'] },
  { id: 'kr-general-02', query: '제주도 여행 코스', topic: 'general', minResults: 5, maxTimeMs: 12_000, tags: ['korean', 'general'] },
  { id: 'kr-general-03', query: '비타민 D 부작용', topic: 'general', minResults: 5, maxTimeMs: 12_000, tags: ['korean', 'general'] },
  { id: 'kr-general-04', query: '영화 추천 2025', topic: 'general', minResults: 5, maxTimeMs: 12_000, tags: ['korean', 'general'] },
  { id: 'kr-general-05', query: '운동 루틴 추천', topic: 'general', minResults: 5, maxTimeMs: 12_000, tags: ['korean', 'general'] },

  // ════════════════════════════════════════════════════════════════
  // ENGLISH QUERIES (50)
  // ════════════════════════════════════════════════════════════════
  // Financial (8)
  { id: 'en-stock-01', query: 'Apple stock price', topic: 'finance', minResults: 5, maxTimeMs: 12_000, tags: ['english', 'financial'] },
  { id: 'en-stock-02', query: 'Tesla earnings report Q4 2024', topic: 'finance', minResults: 5, maxTimeMs: 12_000, tags: ['english', 'financial'] },
  { id: 'en-stock-03', query: 'NVIDIA market cap 2025', topic: 'finance', minResults: 5, maxTimeMs: 12_000, tags: ['english', 'financial'] },
  { id: 'en-stock-04', query: 'Bitcoin price today', topic: 'finance', minResults: 5, maxTimeMs: 12_000, tags: ['english', 'financial'] },
  { id: 'en-stock-05', query: 'S&P 500 performance year to date', topic: 'finance', minResults: 5, maxTimeMs: 12_000, tags: ['english', 'financial'] },
  { id: 'en-stock-06', query: 'Microsoft Azure revenue growth', topic: 'finance', minResults: 5, maxTimeMs: 12_000, tags: ['english', 'financial'] },
  { id: 'en-stock-07', query: 'Amazon AWS market share cloud', topic: 'finance', minResults: 5, maxTimeMs: 12_000, tags: ['english', 'financial'] },
  { id: 'en-stock-08', query: 'Google Alphabet stock analysis', topic: 'finance', minResults: 5, maxTimeMs: 12_000, tags: ['english', 'financial'] },

  // Technical (12)
  { id: 'en-tech-01', query: 'Cloudflare Workers D1 tutorial 2025', topic: 'general', minResults: 5, maxTimeMs: 12_000, tags: ['english', 'technical'] },
  { id: 'en-tech-02', query: 'React state management best practices', topic: 'general', minResults: 5, maxTimeMs: 12_000, tags: ['english', 'technical'] },
  { id: 'en-tech-03', query: 'Rust vs Go performance benchmark', topic: 'general', minResults: 5, maxTimeMs: 12_000, tags: ['english', 'technical'] },
  { id: 'en-tech-04', query: 'PostgreSQL vs MySQL performance 2025', topic: 'general', minResults: 5, maxTimeMs: 12_000, tags: ['english', 'technical'] },
  { id: 'en-tech-05', query: 'Kubernetes deployment guide', topic: 'general', minResults: 5, maxTimeMs: 12_000, tags: ['english', 'technical'] },
  { id: 'en-tech-06', query: 'GraphQL vs REST API comparison', topic: 'general', minResults: 5, maxTimeMs: 12_000, tags: ['english', 'technical'] },
  { id: 'en-tech-07', query: 'Docker compose networking setup', topic: 'general', minResults: 5, maxTimeMs: 12_000, tags: ['english', 'technical'] },
  { id: 'en-tech-08', query: 'Python type hints best practices', topic: 'general', minResults: 5, maxTimeMs: 12_000, tags: ['english', 'technical'] },
  { id: 'en-tech-09', query: 'Git rebase vs merge strategy', topic: 'general', minResults: 5, maxTimeMs: 12_000, tags: ['english', 'technical'] },
  { id: 'en-tech-10', query: 'CI/CD pipeline GitHub Actions', topic: 'general', minResults: 5, maxTimeMs: 12_000, tags: ['english', 'technical'] },
  { id: 'en-tech-11', query: 'Redis caching strategies production', topic: 'general', minResults: 5, maxTimeMs: 12_000, tags: ['english', 'technical'] },
  { id: 'en-tech-12', query: 'WebAssembly browser performance', topic: 'general', minResults: 5, maxTimeMs: 12_000, tags: ['english', 'technical'] },

  // News (10)
  { id: 'en-news-01', query: 'OpenAI GPT-5 release date', topic: 'news', minResults: 3, maxTimeMs: 10_000, tags: ['english', 'news'] },
  { id: 'en-news-02', query: 'Apple Vision Pro sales 2025', topic: 'news', minResults: 5, maxTimeMs: 10_000, tags: ['english', 'news'] },
  { id: 'en-news-03', query: 'Google Gemini AI update', topic: 'news', minResults: 5, maxTimeMs: 10_000, tags: ['english', 'news'] },
  { id: 'en-news-04', query: 'EU AI regulation 2025', topic: 'news', minResults: 5, maxTimeMs: 10_000, tags: ['english', 'news'] },
  { id: 'en-news-05', query: 'SpaceX Starship launch latest', topic: 'news', minResults: 5, maxTimeMs: 10_000, tags: ['english', 'news'] },
  { id: 'en-news-06', query: 'climate change summit results', topic: 'news', minResults: 5, maxTimeMs: 10_000, tags: ['english', 'news'] },
  { id: 'en-news-07', query: 'US presidential election polls', topic: 'news', minResults: 5, maxTimeMs: 10_000, tags: ['english', 'news'] },
  { id: 'en-news-08', query: 'semiconductor shortage 2025', topic: 'news', minResults: 5, maxTimeMs: 10_000, tags: ['english', 'news'] },
  { id: 'en-news-09', query: 'cybersecurity breach major company', topic: 'news', minResults: 5, maxTimeMs: 10_000, tags: ['english', 'news'] },
  { id: 'en-news-10', query: 'electric vehicle market growth', topic: 'news', minResults: 5, maxTimeMs: 10_000, tags: ['english', 'news'] },

  // Factual (10)
  { id: 'en-fact-01', query: 'what is quantum computing', topic: 'general', minResults: 5, maxTimeMs: 12_000, requiredBackends: ['wikipedia'], tags: ['english', 'factual'] },
  { id: 'en-fact-02', query: 'how does machine learning work', topic: 'general', minResults: 5, maxTimeMs: 12_000, tags: ['english', 'factual'] },
  { id: 'en-fact-03', query: 'what is blockchain technology', topic: 'general', minResults: 5, maxTimeMs: 12_000, tags: ['english', 'factual'] },
  { id: 'en-fact-04', query: 'definition of artificial intelligence', topic: 'general', minResults: 5, maxTimeMs: 12_000, tags: ['english', 'factual'] },
  { id: 'en-fact-05', query: 'who invented the internet', topic: 'general', minResults: 5, maxTimeMs: 12_000, tags: ['english', 'factual'] },
  { id: 'en-fact-06', query: 'what causes earthquakes', topic: 'general', minResults: 5, maxTimeMs: 12_000, tags: ['english', 'factual'] },
  { id: 'en-fact-07', query: 'how does DNA replication work', topic: 'general', minResults: 5, maxTimeMs: 12_000, tags: ['english', 'factual'] },
  { id: 'en-fact-08', query: 'what is the theory of relativity', topic: 'general', minResults: 5, maxTimeMs: 12_000, tags: ['english', 'factual'] },
  { id: 'en-fact-09', query: 'how does photosynthesis work', topic: 'general', minResults: 5, maxTimeMs: 12_000, tags: ['english', 'factual'] },
  { id: 'en-fact-10', query: 'what is dark matter', topic: 'general', minResults: 5, maxTimeMs: 12_000, tags: ['english', 'factual'] },

  // Academic (5)
  { id: 'en-acad-01', query: 'transformer architecture paper', topic: 'general', minResults: 5, maxTimeMs: 12_000, tags: ['english', 'academic'] },
  { id: 'en-acad-02', query: 'attention is all you need research', topic: 'general', minResults: 5, maxTimeMs: 12_000, tags: ['english', 'academic'] },
  { id: 'en-acad-03', query: 'deep learning reinforcement learning survey', topic: 'general', minResults: 5, maxTimeMs: 12_000, tags: ['english', 'academic'] },
  { id: 'en-acad-04', query: 'GPT-4 architecture paper', topic: 'general', minResults: 5, maxTimeMs: 12_000, tags: ['english', 'academic'] },
  { id: 'en-acad-05', query: 'diffusion models generative AI research', topic: 'general', minResults: 5, maxTimeMs: 12_000, tags: ['english', 'academic'] },

  // ════════════════════════════════════════════════════════════════
  // CHINESE QUERIES (12)
  // ════════════════════════════════════════════════════════════════
  { id: 'zh-fact-01', query: '什么是量子计算', topic: 'general', minResults: 3, maxTimeMs: 14_000, tags: ['chinese', 'factual'] },
  { id: 'zh-fact-02', query: '什么是人工智能', topic: 'general', minResults: 3, maxTimeMs: 14_000, tags: ['chinese', 'factual'] },
  { id: 'zh-fact-03', query: '什么是区块链技术', topic: 'general', minResults: 3, maxTimeMs: 14_000, tags: ['chinese', 'factual'] },
  { id: 'zh-fact-04', query: '什么是机器学习', topic: 'general', minResults: 3, maxTimeMs: 14_000, tags: ['chinese', 'factual'] },
  { id: 'zh-news-01', query: '中国AI最新进展', topic: 'news', minResults: 5, maxTimeMs: 14_000, tags: ['chinese', 'news'] },
  { id: 'zh-news-02', query: '华为最新手机发布', topic: 'news', minResults: 5, maxTimeMs: 14_000, tags: ['chinese', 'news'] },
  { id: 'zh-news-03', query: '中国新能源汽车销量', topic: 'news', minResults: 5, maxTimeMs: 14_000, tags: ['chinese', 'news'] },
  { id: 'zh-tech-01', query: 'React 19新特性', topic: 'general', minResults: 5, maxTimeMs: 14_000, tags: ['chinese', 'technical'] },
  { id: 'zh-tech-02', query: 'Vue.js 4 最新版本', topic: 'general', minResults: 5, maxTimeMs: 14_000, tags: ['chinese', 'technical'] },
  { id: 'zh-general-01', query: '北京旅游攻略', topic: 'general', minResults: 5, maxTimeMs: 14_000, tags: ['chinese', 'general'] },
  { id: 'zh-general-02', query: '上海美食推荐', topic: 'general', minResults: 5, maxTimeMs: 14_000, tags: ['chinese', 'general'] },
  { id: 'zh-general-03', query: '2025年电影推荐', topic: 'general', minResults: 5, maxTimeMs: 14_000, tags: ['chinese', 'general'] },

  // ════════════════════════════════════════════════════════════════
  // JAPANESE QUERIES (8)
  // ════════════════════════════════════════════════════════════════
  { id: 'ja-fact-01', query: '量子コンピュータとは', topic: 'general', minResults: 3, maxTimeMs: 14_000, tags: ['japanese', 'factual'] },
  { id: 'ja-fact-02', query: '人工知能の仕組み', topic: 'general', minResults: 3, maxTimeMs: 14_000, tags: ['japanese', 'factual'] },
  { id: 'ja-news-01', query: '最新AIニュース 2025', topic: 'news', minResults: 5, maxTimeMs: 14_000, tags: ['japanese', 'news'] },
  { id: 'ja-news-02', query: '任天堂Switch 2 発売', topic: 'news', minResults: 5, maxTimeMs: 14_000, tags: ['japanese', 'news'] },
  { id: 'ja-tech-01', query: 'React.js 使い方', topic: 'general', minResults: 5, maxTimeMs: 14_000, tags: ['japanese', 'technical'] },
  { id: 'ja-tech-02', query: 'Python機械学習入門', topic: 'general', minResults: 5, maxTimeMs: 14_000, tags: ['japanese', 'technical'] },
  { id: 'ja-travel-01', query: '東京観光スポット', topic: 'general', minResults: 5, maxTimeMs: 14_000, tags: ['japanese', 'general'] },
  { id: 'ja-travel-02', query: '京都紅葉時期', topic: 'general', minResults: 5, maxTimeMs: 14_000, tags: ['japanese', 'general'] },

  // ════════════════════════════════════════════════════════════════
  // MULTI-TOPIC / CROSS-CUTTING (22)
  // ════════════════════════════════════════════════════════════════
  // Comparison queries
  { id: 'cmp-01', query: 'React vs Vue vs Angular 2025', topic: 'general', minResults: 5, maxTimeMs: 12_000, tags: ['english', 'technical', 'comparison'] },
  { id: 'cmp-02', query: 'AWS vs Azure vs Google Cloud pricing', topic: 'general', minResults: 5, maxTimeMs: 12_000, tags: ['english', 'technical', 'comparison'] },
  { id: 'cmp-03', query: 'ChatGPT vs Claude vs Gemini comparison', topic: 'general', minResults: 5, maxTimeMs: 12_000, tags: ['english', 'technical', 'comparison'] },
  { id: 'cmp-04', query: 'PostgreSQL vs MongoDB use cases', topic: 'general', minResults: 5, maxTimeMs: 12_000, tags: ['english', 'technical', 'comparison'] },
  { id: 'cmp-05', query: 'Next.js vs Nuxt.js vs SvelteKit', topic: 'general', minResults: 5, maxTimeMs: 12_000, tags: ['english', 'technical', 'comparison'] },

  // Long-tail / specific
  { id: 'lt-01', query: 'Cloudflare Workers KV vs D1 when to use', topic: 'general', minResults: 5, maxTimeMs: 12_000, tags: ['english', 'technical'] },
  { id: 'lt-02', query: 'Tailwind CSS v4 migration guide', topic: 'general', minResults: 5, maxTimeMs: 12_000, tags: ['english', 'technical'] },
  { id: 'lt-03', query: 'Bun runtime production ready 2025', topic: 'general', minResults: 5, maxTimeMs: 12_000, tags: ['english', 'technical'] },
  { id: 'lt-04', query: 'Zod schema validation performance', topic: 'general', minResults: 5, maxTimeMs: 12_000, tags: ['english', 'technical'] },
  { id: 'lt-05', query: 'Hono framework Cloudflare Workers', topic: 'general', minResults: 5, maxTimeMs: 12_000, tags: ['english', 'technical'] },

  // General knowledge
  { id: 'gk-01', query: 'how does HTTPS encryption work', topic: 'general', minResults: 5, maxTimeMs: 12_000, tags: ['english', 'factual'] },
  { id: 'gk-02', query: 'what is a CDN and how does it work', topic: 'general', minResults: 5, maxTimeMs: 12_000, tags: ['english', 'factual'] },
  { id: 'gk-03', query: 'explain TCP/IP protocol stack', topic: 'general', minResults: 5, maxTimeMs: 12_000, tags: ['english', 'factual'] },
  { id: 'gk-04', query: 'what is serverless architecture', topic: 'general', minResults: 5, maxTimeMs: 12_000, tags: ['english', 'factual'] },
  { id: 'gk-05', query: 'how does DNS resolution work', topic: 'general', minResults: 5, maxTimeMs: 12_000, tags: ['english', 'factual'] },

  // News / current affairs
  { id: 'ca-01', query: 'AI regulation worldwide 2025', topic: 'news', minResults: 5, maxTimeMs: 10_000, tags: ['english', 'news'] },
  { id: 'ca-02', query: 'quantum computing breakthrough 2025', topic: 'news', minResults: 5, maxTimeMs: 10_000, tags: ['english', 'news'] },
  { id: 'ca-03', query: 'cybersecurity trends enterprise 2025', topic: 'news', minResults: 5, maxTimeMs: 10_000, tags: ['english', 'news'] },
  { id: 'ca-04', query: 'green energy technology breakthrough', topic: 'news', minResults: 5, maxTimeMs: 10_000, tags: ['english', 'news'] },
  { id: 'ca-05', query: 'autonomous driving Level 4 progress', topic: 'news', minResults: 5, maxTimeMs: 10_000, tags: ['english', 'news'] },

  // Domain-specific
  { id: 'ds-01', query: 'LLM fine-tuning techniques LoRA', topic: 'general', minResults: 5, maxTimeMs: 12_000, tags: ['english', 'technical', 'academic'] },
  { id: 'ds-02', query: 'vector database similarity search', topic: 'general', minResults: 5, maxTimeMs: 12_000, tags: ['english', 'technical'] },
  { id: 'ds-03', query: 'RAG retrieval augmented generation architecture', topic: 'general', minResults: 5, maxTimeMs: 12_000, tags: ['english', 'technical', 'academic'] },
  { id: 'ds-04', query: 'edge computing latency optimization', topic: 'general', minResults: 5, maxTimeMs: 12_000, tags: ['english', 'technical'] },
  { id: 'ds-05', query: 'microservices observability distributed tracing', topic: 'general', minResults: 5, maxTimeMs: 12_000, tags: ['english', 'technical'] },

  // Additional cross-language
  { id: 'xl-01', query: 'GPT-5 vs GPT-4 성능 비교', topic: 'general', minResults: 5, maxTimeMs: 12_000, tags: ['korean', 'technical', 'comparison'] },
  { id: 'xl-02', query: 'Gemini AI 最新進展', topic: 'news', minResults: 5, maxTimeMs: 14_000, tags: ['chinese', 'news'] },
  { id: 'xl-03', query: 'クラウド技術トレンド 2025', topic: 'news', minResults: 5, maxTimeMs: 14_000, tags: ['japanese', 'news'] },

  // Tricky / adversarial
  { id: 'adv-01', query: 'best programming language for everything', topic: 'general', minResults: 5, maxTimeMs: 12_000, tags: ['english', 'technical', 'comparison'] },
  { id: 'adv-02', query: 'is AI going to replace all jobs', topic: 'general', minResults: 5, maxTimeMs: 12_000, tags: ['english', 'general'] },
  { id: 'adv-03', query: 'which country has the best healthcare system', topic: 'general', minResults: 5, maxTimeMs: 12_000, tags: ['english', 'general'] },
  { id: 'adv-04', query: 'most dangerous programming language', topic: 'general', minResults: 5, maxTimeMs: 12_000, tags: ['english', 'technical'] },

  // Temporal / time-sensitive
  { id: 'ts-01', query: 'latest iPhone release 2025', topic: 'news', minResults: 5, maxTimeMs: 10_000, tags: ['english', 'news'] },
  { id: 'ts-02', query: 'CES 2025 best products', topic: 'news', minResults: 5, maxTimeMs: 10_000, tags: ['english', 'news'] },
  { id: 'ts-03', query: '2025 tech industry predictions', topic: 'news', minResults: 5, maxTimeMs: 10_000, tags: ['english', 'news'] },
  { id: 'ts-04', query: 'Black Friday deals technology 2025', topic: 'news', minResults: 5, maxTimeMs: 10_000, tags: ['english', 'news'] },
]
