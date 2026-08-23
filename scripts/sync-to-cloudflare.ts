#!/usr/bin/env -S npx tsx
/**
 * 로컬 → Cloudflare 동기화 스크립트
 * 
 * 로컬 ChromaDB의 인덱스를 Cloudflare Vectorize + D1로 동기화
 * 
 * 사용법:
 *   npx tsx scripts/sync-to-cloudflare.ts --api-url=https://search-engine-api.pages.dev
 *   npx tsx scripts/sync-to-cloudflare.ts --api-url=https://search-engine-api.pages.dev --dry-run
 */

import { LocalIndexingService } from '../src/lib/local-indexing'

// ============================================================
// Configuration
// ============================================================

interface SyncArgs {
  apiUrl: string
  apiKey?: string
  chromaUrl: string
  ollamaUrl: string
  batchSize: number
  dryRun: boolean
}

function parseArgs(): SyncArgs {
  const args = process.argv.slice(2)
  const options: SyncArgs = {
    apiUrl: 'https://search-engine-api.pages.dev',
    chromaUrl: 'http://localhost:8000',
    ollamaUrl: 'http://localhost:11434',
    batchSize: 20,
    dryRun: false,
  }

  for (const arg of args) {
    if (arg.startsWith('--api-url=')) {
      options.apiUrl = arg.split('=')[1]
    } else if (arg.startsWith('--api-key=')) {
      options.apiKey = arg.split('=')[1]
    } else if (arg.startsWith('--chroma=')) {
      options.chromaUrl = arg.split('=')[1]
    } else if (arg.startsWith('--ollama=')) {
      options.ollamaUrl = arg.split('=')[1]
    } else if (arg.startsWith('--batch-size=')) {
      options.batchSize = parseInt(arg.split('=')[1], 10)
    } else if (arg === '--dry-run') {
      options.dryRun = true
    }
  }

  return options
}

// ============================================================
// Main Sync Logic
// ============================================================

async function syncToCloudflare(args: SyncArgs) {
  console.log('═══════════════════════════════════════════════════════')
  console.log('  로컬 → Cloudflare 동기화')
  console.log('═══════════════════════════════════════════════════════')
  console.log(`  API URL: ${args.apiUrl}`)
  console.log(`  ChromaDB: ${args.chromaUrl}`)
  console.log(`  배치 크기: ${args.batchSize}`)
  console.log(`  Dry run: ${args.dryRun}`)
  console.log('')

  // 로컬 서비스 초기화
  const localService = new LocalIndexingService({
    chromaUrl: args.chromaUrl,
    ollamaUrl: args.ollamaUrl,
  })

  const status = await localService.initialize()
  if (!status.chroma) {
    console.error('❌ ChromaDB 미연결')
    process.exit(1)
  }

  // 로컬 인덱스 상태 확인
  const localStats = await localService.getStats()
  console.log(`  로컬 청크 수: ${localStats.totalChunks}`)
  console.log('')

  if (localStats.totalChunks === 0) {
    console.log('로컬 인덱스가 비어있습니다. 먼저 인덱싱을 실행하세요.')
    console.log('  npx tsx scripts/local-index.ts --category=tech')
    return
  }

  // Cloudflare에서 기존 인덱스 상태 확인
  console.log('Cloudflare 인덱스 상태 확인 중...')
  try {
    const response = await fetch(`${args.apiUrl}/api/index/stats`)
    const stats = await response.json() as { totalDocuments?: number }
    console.log(`  Cloudflare 문서 수: ${stats.totalDocuments ?? 0}`)
  } catch (err) {
    console.warn('⚠️ Cloudflare 상태 확인 실패:', err)
  }
  console.log('')

  // 동기화 실행
  if (args.dryRun) {
    console.log('[Dry Run] 동기화할 URL 목록:')
    console.log('  (실제 동기화를 위해 --dry-run 옵션을 제거하세요)')
    return
  }

  console.log('동기화 시작...')

  // ChromaDB에서 모든 문서 가져오기
  // 주의: ChromaDB API는 전체 문서 가져오기를 제한할 수 있음
  // 실제 구현에서는 페이지네이션이 필요할 수 있음

  // 임시: 샘플 URL 목록으로 테스트
  const sampleUrls = [
    'https://react.dev/learn',
    'https://react.dev/reference/react',
    'https://vuejs.org/guide/introduction.html',
    'https://nextjs.org/docs',
    'https://www.typescriptlang.org/docs/',
  ]

  console.log(`동기화할 URL: ${sampleUrls.length}개`)

  // 배치로 Cloudflare API 전송
  let successCount = 0
  let failCount = 0

  for (let i = 0; i < sampleUrls.length; i += args.batchSize) {
    const batch = sampleUrls.slice(i, i + args.batchSize)
    const progress = `[${Math.floor(i / args.batchSize) + 1}/${Math.ceil(sampleUrls.length / args.batchSize)}]`

    process.stdout.write(`${progress} 배치 동기화 중... `)

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      }
      if (args.apiKey) {
        headers['X-API-Key'] = args.apiKey
      }

      const response = await fetch(`${args.apiUrl}/api/index`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ urls: batch }),
      })

      if (response.ok) {
        const result = await response.json() as { stats?: { succeeded: number; failed: number } }
        successCount += result.stats?.succeeded ?? 0
        failCount += result.stats?.failed ?? 0
        console.log(`✅ ${result.stats?.succeeded ?? 0} 성공`)
      } else {
        console.log(`❌ HTTP ${response.status}`)
        failCount += batch.length
      }
    } catch (_err) {
      console.log(`❌ 에러`)
      failCount += batch.length
    }
  }

  console.log('')
  console.log('═══════════════════════════════════════════════════════')
  console.log(`  ✅ 완료: ${successCount} 성공, ${failCount} 실패`)
  console.log('═══════════════════════════════════════════════════════')
}

// ============================================================
// Run
// ============================================================

const args = parseArgs()
syncToCloudflare(args).catch(console.error)
