#!/usr/bin/env -S npx tsx
/**
 * 로컬 인덱싱 스크립트
 *
 * ChromaDB + Ollama를 사용한 완전 로컬 인덱싱
 * Cloudflare 없이 로컬에서 인덱싱/검색 가능
 *
 * 사용법:
 *   # 서비스 시작
 *   docker run -p 8000:8000 chromadb/chroma
 *   ollama serve
 *   ollama pull nomic-embed-text
 *
 *   # 인덱싱 실행
 *   npx tsx scripts/local-index.ts --urls urls.txt
 *   npx tsx scripts/local-index.ts --category=tech
 *   npx tsx scripts/local-index.ts --search "react hooks"
 */

import * as fs from 'fs'
import { LocalIndexingService, type LocalDocument } from '../src/lib/local-indexing'

// ============================================================
// Seed URLs by Category
// ============================================================

const TECH_DOCS = [
  'https://react.dev/learn',
  'https://react.dev/reference/react',
  'https://vuejs.org/guide/introduction.html',
  'https://nextjs.org/docs',
  'https://nuxt.com/docs',
  'https://www.typescriptlang.org/docs/',
  'https://docs.python.org/3/',
  'https://fastapi.tiangolo.com/',
  'https://nodejs.org/docs/latest/api/',
  'https://go.dev/doc/',
  'https://doc.rust-lang.org/book/',
  'https://docs.docker.com/',
  'https://kubernetes.io/docs/',
  'https://developers.cloudflare.com/workers/',
  'https://developers.cloudflare.com/d1/',
  'https://developers.cloudflare.com/vectorize/',
  'https://docs.aws.amazon.com/',
  'https://www.postgresql.org/docs/',
  'https://docs.mongodb.com/',
  'https://redis.io/docs/',
  'https://docs.pytorch.org/',
  'https://www.tensorflow.org/guide',
  'https://huggingface.co/docs/transformers/',
  'https://docs.github.com/',
  'https://git-scm.com/doc',
]

const NEWS_SITES = [
  'https://www.bbc.com/news',
  'https://www.nytimes.com/',
  'https://www.theguardian.com/',
  'https://www.cnn.com/',
  'https://www.reuters.com/',
  'https://techcrunch.com/',
  'https://www.theverge.com/',
  'https://arstechnica.com/',
  'https://www.wired.com/',
  'https://www.cnbc.com/',
]

const WIKI_DOCS = [
  'https://en.wikipedia.org/wiki/Machine_learning',
  'https://en.wikipedia.org/wiki/Artificial_intelligence',
  'https://en.wikipedia.org/wiki/Deep_learning',
  'https://en.wikipedia.org/wiki/Natural_language_processing',
  'https://en.wikipedia.org/wiki/Computer_vision',
  'https://en.wikipedia.org/wiki/Neural_network',
  'https://en.wikipedia.org/wiki/Transformer_(deep_learning)',
  'https://en.wikipedia.org/wiki/Large_language_model',
  'https://en.wikipedia.org/wiki/Cloud_computing',
  'https://en.wikipedia.org/wiki/Internet_of_things',
]

// ============================================================
// Main Script
// ============================================================

interface LocalIndexArgs {
  mode: 'index' | 'search' | 'stats'
  urls?: string[]
  category?: string
  query?: string
  topK?: number
  chromaUrl?: string
  ollamaUrl?: string
}

/**
 * Exit with a failure code. Unlike `process.exit` (typed `any` by
 * @cloudflare/workers-types, so it does not terminate control flow), the
 * explicit `never` return type lets tsc narrow variables after guard clauses.
 */
function fail(code: number): never {
  process.exit(code)
  throw new Error('unreachable')
}

function parseArgs(): LocalIndexArgs {
  const args = process.argv.slice(2)
  const options: LocalIndexArgs = {
    mode: 'index',
    topK: 10,
    chromaUrl: 'http://localhost:8000',
    ollamaUrl: 'http://localhost:11434',
  }

  for (const arg of args) {
    if (arg.startsWith('--urls=')) {
      const filePath = arg.split('=')[1]
      options.urls = fs
        .readFileSync(filePath, 'utf-8')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && l.startsWith('http'))
    } else if (arg.startsWith('--category=')) {
      options.category = arg.split('=')[1]
    } else if (arg.startsWith('--search=')) {
      options.mode = 'search'
      options.query = arg.split('=').slice(1).join('=')
    } else if (arg === '--stats') {
      options.mode = 'stats'
    } else if (arg.startsWith('--top-k=')) {
      options.topK = parseInt(arg.split('=')[1], 10)
    } else if (arg.startsWith('--chroma=')) {
      options.chromaUrl = arg.split('=')[1]
    } else if (arg.startsWith('--ollama=')) {
      options.ollamaUrl = arg.split('=')[1]
    }
  }

  return options
}

async function fetchDocument(url: string): Promise<LocalDocument | null> {
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'LocalIndexer/1.0' },
      signal: AbortSignal.timeout(10000),
    })

    if (!response.ok) return null

    const html = await response.text()

    // 간단한 HTML 파싱
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
    const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : url

    // 본문 추출 (간단한 휴리스틱)
    const content = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 10000) // 최대 10,000자

    const domain = new URL(url).hostname.replace(/^www\./, '')

    return {
      id: Buffer.from(url).toString('base64').slice(0, 32),
      url,
      title,
      content,
      domain,
    }
  } catch (err) {
    console.error(`문서 가져오기 실패: ${url}`, err)
    return null
  }
}

async function runIndexing(args: LocalIndexArgs) {
  console.log('═══════════════════════════════════════════════════════')
  console.log('  로컬 인덱싱 스크립트')
  console.log('═══════════════════════════════════════════════════════')

  // URL 목록 준비
  let urls: string[] = []
  if (args.urls) {
    urls = args.urls
  } else if (args.category) {
    switch (args.category) {
      case 'tech':
        urls = TECH_DOCS
        break
      case 'news':
        urls = NEWS_SITES
        break
      case 'wiki':
        urls = WIKI_DOCS
        break
      case 'all':
        urls = [...TECH_DOCS, ...NEWS_SITES, ...WIKI_DOCS]
        break
      default:
        console.error(`알 수 없는 카테고리: ${args.category}`)
        process.exit(1)
    }
  } else {
    urls = [...TECH_DOCS, ...NEWS_SITES, ...WIKI_DOCS]
  }

  console.log(`  URL 수: ${urls.length}`)
  console.log(`  ChromaDB: ${args.chromaUrl}`)
  console.log(`  Ollama: ${args.ollamaUrl}`)
  console.log('')

  // 서비스 초기화
  const service = new LocalIndexingService({
    chromaUrl: args.chromaUrl,
    ollamaUrl: args.ollamaUrl,
  })

  const status = await service.initialize()
  if (!status.chroma || !status.ollama) {
    console.error('❌ 서비스 미준비:')
    console.error(`  ChromaDB: ${status.chroma ? '✅' : '❌'}`)
    console.error(`  Ollama: ${status.ollama ? '✅' : '❌'}`)
    console.error('')
    console.error('시작 방법:')
    console.error('  docker run -p 8000:8000 chromadb/chroma')
    console.error('  ollama serve')
    console.error('  ollama pull nomic-embed-text')
    process.exit(1)
  }

  console.log('✅ 서비스 준비 완료')
  console.log('')

  // 인덱싱 실행
  let successCount = 0
  let failCount = 0

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i]
    const progress = `[${i + 1}/${urls.length}]`

    process.stdout.write(`${progress} ${url}... `)

    const doc = await fetchDocument(url)
    if (!doc) {
      console.log('❌ 실패')
      failCount++
      continue
    }

    const result = await service.indexDocument(doc)
    if (result) {
      console.log('✅ 성공')
      successCount++
    } else {
      console.log('❌ 실패')
      failCount++
    }
  }

  console.log('')
  console.log('═══════════════════════════════════════════════════════')
  console.log(`  ✅ 완료: ${successCount} 성공, ${failCount} 실패`)
  console.log('═══════════════════════════════════════════════════════')
}

async function runSearch(args: LocalIndexArgs) {
  if (!args.query) {
    console.error('검색어를 입력하세요: --search="react hooks"')
    fail(1)
  }
  const query = args.query

  console.log('═══════════════════════════════════════════════════════')
  console.log('  로컬 검색')
  console.log('═══════════════════════════════════════════════════════')
  console.log(`  쿼리: ${query}`)
  console.log(`  Top-K: ${args.topK}`)
  console.log('')

  const service = new LocalIndexingService({
    chromaUrl: args.chromaUrl,
    ollamaUrl: args.ollamaUrl,
  })

  await service.initialize()

  const results = await service.search(query, args.topK)

  if (results.length === 0) {
    console.log('검색 결과 없음')
    return
  }

  console.log(`검색 결과: ${results.length}건`)
  console.log('')

  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    console.log(`${i + 1}. ${r.title}`)
    console.log(`   URL: ${r.url}`)
    console.log(`   스코어: ${r.score.toFixed(4)}`)
    console.log('')
  }
}

async function runStats(args: LocalIndexArgs) {
  console.log('═══════════════════════════════════════════════════════')
  console.log('  로컬 인덱스 상태')
  console.log('═══════════════════════════════════════════════════════')

  const service = new LocalIndexingService({
    chromaUrl: args.chromaUrl,
    ollamaUrl: args.ollamaUrl,
  })

  const _status = await service.initialize()
  const stats = await service.getStats()

  console.log(`  ChromaDB: ${stats.chromaReady ? '✅ 연결됨' : '❌ 미연결'}`)
  console.log(`  Ollama: ${stats.ollamaReady ? '✅ 연결됨' : '❌ 미연결'}`)
  console.log(`  총 문서: ${stats.totalDocuments}`)
  console.log(`  총 청크: ${stats.totalChunks}`)
  console.log('')
}

// ============================================================
// Run
// ============================================================

async function main() {
  const args = parseArgs()

  switch (args.mode) {
    case 'index':
      await runIndexing(args)
      break
    case 'search':
      await runSearch(args)
      break
    case 'stats':
      await runStats(args)
      break
  }
}

main().catch(console.error)
