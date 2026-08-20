#!/usr/bin/env npx tsx
/**
 * Self-Index Batch Seeder
 * 
 * 기술 문서, 뉴스, 학술 자료를 배치로 인덱싱하여 
 * 자체 인덱스를 403 → 10,000+ docs로 확대합니다.
 * 
 * 사용법:
 *   npx tsx scripts/seed-index-batch.ts --api-url=https://search-engine-api.pages.dev
 *   npx tsx scripts/seed-index-batch.ts --api-url=https://search-engine-api.pages.dev --category=tech
 *   npx tsx scripts/seed-index-batch.ts --api-url=https://search-engine-api.pages.dev --dry-run
 */

import * as fs from 'fs'
import * as path from 'path'

// ============================================================
// Seed URLs by Category
// ============================================================

const TECH_DOCS = [
  // Cloudflare
  'https://developers.cloudflare.com/workers/',
  'https://developers.cloudflare.com/pages/',
  'https://developers.cloudflare.com/d1/',
  'https://developers.cloudflare.com/vectorize/',
  'https://developers.cloudflare.com/queues/',
  'https://developers.cloudflare.com/r2/',
  'https://developers.cloudflare.com/kv/',
  'https://developers.cloudflare.com/durable-objects/',
  
  // React/Vue/Angular
  'https://react.dev/learn',
  'https://react.dev/reference/react',
  'https://vuejs.org/guide/introduction.html',
  'https://vuejs.org/api/',
  'https://angular.dev/overview',
  
  // Next.js/Nuxt
  'https://nextjs.org/docs',
  'https://nextjs.org/app',
  'https://nuxt.com/docs',
  
  // TypeScript/JavaScript
  'https://www.typescriptlang.org/docs/',
  'https://developer.mozilla.org/en-US/docs/Web/JavaScript',
  'https://developer.mozilla.org/en-US/docs/Web/API',
  
  // Python
  'https://docs.python.org/3/',
  'https://docs.python.org/3/tutorial/index.html',
  'https://fastapi.tiangolo.com/',
  'https://docs.sqlalchemy.org/',
  
  // Node.js
  'https://nodejs.org/docs/latest/api/',
  'https://expressjs.com/',
  'https://nestjs.com/',
  
  // Go
  'https://go.dev/doc/',
  'https://go.dev/tour/',
  'https://gin-gonic.com/docs/',
  
  // Rust
  'https://doc.rust-lang.org/book/',
  'https://docs.rs/',
  
  // Docker/Kubernetes
  'https://docs.docker.com/',
  'https://docs.docker.com/get-started/',
  'https://kubernetes.io/docs/',
  
  // AWS
  'https://docs.aws.amazon.com/',
  'https://docs.aws.amazon.com/lambda/',
  'https://docs.aws.amazon.com/s3/',
  
  // Database
  'https://www.postgresql.org/docs/',
  'https://dev.mysql.com/doc/',
  'https://docs.mongodb.com/',
  'https://redis.io/docs/',
  
  // AI/ML
  'https://docs.pytorch.org/',
  'https://www.tensorflow.org/guide',
  'https://huggingface.co/docs/transformers/',
  'https://platform.openai.com/docs/',
  
  // Git
  'https://git-scm.com/doc',
  'https://docs.github.com/',
  
  // Linux
  'https://man7.org/linux/man-pages/',
  'https://tldp.org/LDP/Bash-Beginners-Guide/html/',
]

const NEWS_SITES = [
  // 국제 뉴스
  'https://www.reuters.com/',
  'https://www.bbc.com/news',
  'https://www.nytimes.com/',
  'https://www.theguardian.com/',
  'https://www.aljazeera.com/',
  'https://apnews.com/',
  'https://www.washingtonpost.com/',
  'https://www.cnn.com/',
  'https://www.npr.org/',
  'https://www.time.com/',
  
  // 기술 뉴스
  'https://www.theverge.com/',
  'https://techcrunch.com/',
  'https://arstechnica.com/',
  'https://www.wired.com/',
  'https://www.engadget.com/',
  'https://www.zdnet.com/',
  'https://www.cnet.com/',
  'https://venturebeat.com/',
  
  // 비즈니스/금융
  'https://www.bloomberg.com/',
  'https://www.cnbc.com/',
  'https://www.ft.com/',
  'https://www.wsj.com/',
  'https://finance.yahoo.com/',
  'https://www.marketwatch.com/',
  
  // 한국 뉴스
  'https://www.yna.co.kr/',
  'https://www.donga.com/',
  'https://www.khan.co.kr/',
  'https://www.chosun.com/',
  'https://www.joongang.co.kr/',
  'https://www.hankyung.com/',
  
  // 일본 뉴스
  'https://www.japantimes.co.jp/',
  'https://www.asahi.com/',
  'https://www.nikkei.com/',
  
  // 중국 뉴스
  'https://www.people.com.cn/',
  'https://www.xinhuanet.com/',
  'https://www.ithome.com/',
]

const ACADEMIC_SOURCES = [
  // arXiv
  'https://arxiv.org/abs/2301.00001',
  'https://arxiv.org/abs/2302.00001',
  'https://arxiv.org/abs/2303.00001',
  'https://arxiv.org/abs/2304.00001',
  'https://arxiv.org/abs/2305.00001',
  
  // Wikipedia (가장 많이 인용되는 문서)
  'https://en.wikipedia.org/wiki/Machine_learning',
  'https://en.wikipedia.org/wiki/Artificial_intelligence',
  'https://en.wikipedia.org/wiki/Deep_learning',
  'https://en.wikipedia.org/wiki/Natural_language_processing',
  'https://en.wikipedia.org/wiki/Computer_vision',
  'https://en.wikipedia.org/wiki/Neural_network',
  'https://en.wikipedia.org/wiki/Transformer_(deep_learning)',
  'https://en.wikipedia.org/wiki/Large_language_model',
  'https://en.wikipedia.org/wiki/Generative_artificial_intelligence',
  'https://en.wikipedia.org/wiki/Quantum_computing',
  'https://en.wikipedia.org/wiki/Blockchain',
  'https://en.wikipedia.org/wiki/Cloud_computing',
  'https://en.wikipedia.org/wiki/Internet_of_things',
  'https://en.wikipedia.org/wiki/Cybersecurity',
  'https://en.wikipedia.org/wiki/Data_science',
  'https://en.wikipedia.org/wiki/Software_engineering',
  'https://en.wikipedia.org/wiki/Web_development',
  'https://en.wikipedia.org/wiki/Programming_language',
  'https://en.wikipedia.org/wiki/Algorithm',
  'https://en.wikipedia.org/wiki/Data_structure',
]

const GITHUB_REPOS = [
  // 인기 오픈소스 프로젝트
  'https://github.com/facebook/react',
  'https://github.com/vuejs/vue',
  'https://github.com/angular/angular',
  'https://github.com/vercel/next.js',
  'https://github.com/nuxt/nuxt',
  'https://github.com/microsoft/TypeScript',
  'https://github.com/nodejs/node',
  'https://github.com/denoland/deno',
  'https://github.com/rust-lang/rust',
  'https://github.com/golang/go',
  'https://github.com/python/cpython',
  'https://github.com/tensorflow/tensorflow',
  'https://github.com/pytorch/pytorch',
  'https://github.com/huggingface/transformers',
  'https://github.com/openai/openai-python',
  'https://github.com/langchain-ai/langchain',
  'https://github.com/pallets/flask',
  'https://github.com/fastapi/fastapi',
  'https://github.com/expressjs/express',
  'https://github.com/nestjs/nest',
  'https://github.com/prisma/prisma',
  'https://github.com/drizzle-team/drizzle-orm',
  'https://github.com/cloudflare/workers-sdk',
  'https://github.com/supabase/supabase',
  'https://github.com/appwrite/appwrite',
]

// ============================================================
// Main Script
// ============================================================

interface SeedOptions {
  apiUrl: string
  category?: string
  dryRun?: boolean
  batchSize?: number
  delayMs?: number
}

async function seedUrls(options: SeedOptions): Promise<void> {
  const { apiUrl, category, dryRun = false, batchSize = 5, delayMs = 1000 } = options
  
  // Select URLs based on category
  let urls: string[] = []
  switch (category) {
    case 'tech':
      urls = TECH_DOCS
      break
    case 'news':
      urls = NEWS_SITES
      break
    case 'academic':
      urls = ACADEMIC_SOURCES
      break
    case 'github':
      urls = GITHUB_REPOS
      break
    default:
      urls = [...TECH_DOCS, ...NEWS_SITES, ...ACADEMIC_SOURCES, ...GITHUB_REPOS]
  }
  
  console.log(`\n📊 Self-Index Batch Seeder`)
  console.log(`   API URL: ${apiUrl}`)
  console.log(`   Category: ${category || 'all'}`)
  console.log(`   Total URLs: ${urls.length}`)
  console.log(`   Batch size: ${batchSize}`)
  console.log(`   Dry run: ${dryRun}\n`)
  
  if (dryRun) {
    console.log('🔍 Dry run mode - URLs to be indexed:')
    urls.forEach((url, i) => console.log(`   ${i + 1}. ${url}`))
    return
  }
  
  // Process in batches
  let successCount = 0
  let failCount = 0
  
  for (let i = 0; i < urls.length; i += batchSize) {
    const batch = urls.slice(i, i + batchSize)
    console.log(`\n📥 Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(urls.length / batchSize)}...`)
    
    try {
      const response = await fetch(`${apiUrl}/api/index`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': process.env.SEARCH_API_KEY || '',
        },
        body: JSON.stringify({ urls: batch }),
      })
      
      const result = await response.json() as { stats?: { succeeded: number; failed: number }; results?: Array<{ success: boolean; url: string; error?: string }> }
      
      if (result.stats) {
        successCount += result.stats.succeeded
        failCount += result.stats.failed
        console.log(`   ✅ ${result.stats.succeeded} succeeded, ❌ ${result.stats.failed} failed`)
      }
      
      // Log failed URLs
      if (result.results) {
        for (const r of result.results) {
          if (!r.success && r.error) {
            console.log(`   ❌ ${r.url}: ${r.error}`)
          }
        }
      }
    } catch (error) {
      console.error(`   ❌ Batch failed:`, error)
      failCount += batch.length
    }
    
    // Delay between batches
    if (i + batchSize < urls.length) {
      await new Promise(resolve => setTimeout(resolve, delayMs))
    }
  }
  
  // Summary
  console.log('\n📊 Summary:')
  console.log(`   ✅ Success: ${successCount}`)
  console.log(`   ❌ Failed: ${failCount}`)
  console.log(`   📈 Total: ${urls.length}`)
}

// ============================================================
// CLI Arguments
// ============================================================

function parseArgs(): SeedOptions {
  const args = process.argv.slice(2)
  const options: SeedOptions = {
    apiUrl: 'https://search-engine-api.pages.dev',
  }
  
  for (const arg of args) {
    if (arg.startsWith('--api-url=')) {
      options.apiUrl = arg.split('=')[1]
    } else if (arg.startsWith('--category=')) {
      options.category = arg.split('=')[1]
    } else if (arg === '--dry-run') {
      options.dryRun = true
    } else if (arg.startsWith('--batch-size=')) {
      options.batchSize = parseInt(arg.split('=')[1], 10)
    } else if (arg.startsWith('--delay=')) {
      options.delayMs = parseInt(arg.split('=')[1], 10)
    }
  }
  
  return options
}

// Run
const options = parseArgs()
seedUrls(options).catch(console.error)
