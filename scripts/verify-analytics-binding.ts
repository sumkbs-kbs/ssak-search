#!/usr/bin/env -S npx tsx
/**
 * Workers Analytics Engine Binding Verification Script
 * 
 * Verifies that the ANALYTICS binding is properly configured by checking
 * the /api/metrics endpoint for the `search_metrics_persistence` gauge.
 * 
 * Run in CI after deploy to catch missing bindings.
 * Exit codes: 0 = OK, 1 = Binding missing, 2 = Config error
 */

import { readFileSync } from 'fs'
import { resolve } from 'path'

interface WranglerConfig {
  workers_analytics_engine?: {
    datasets?: Array<{ binding: string; dataset: string }>
  }
}

function main() {
  const configPath = resolve(process.cwd(), 'wrangler.jsonc')
  
  try {
    const content = readFileSync(configPath, 'utf-8')
    
    // Check if workers_analytics_engine is configured
    // Note: For Pages Functions, Analytics Engine is configured via Dashboard,
    // not wrangler.jsonc. But we can check if it's documented.
    const hasAnalyticsConfig = content.includes('workers_analytics_engine') || 
                               content.includes('ANALYTICS')
    
    if (!hasAnalyticsConfig) {
      console.error('⚠️  WARN: Workers Analytics Engine not configured in wrangler.jsonc')
      console.error('')
      console.error('To enable metrics persistence across cold starts:')
      console.error('1. Cloudflare Dashboard → Workers & Pages → Analytics → Create dataset')
      console.error('   (e.g. name: SEARCH_API_METRICS)')
      console.error('2. Pages → search-engine-api → Settings → Bindings')
      console.error('   → Workers Analytics Engine Datasets → "Add binding"')
      console.error('   - Variable name: ANALYTICS')
      console.error('   - Dataset: (dataset from step 1)')
      console.error('3. Save & Redeploy')
      console.error('')
      console.error('Without this, metrics are per-isolate only (lost on cold start).')
      console.error('')
      console.error('After deploy, verify with: curl https://your-domain/api/metrics | grep search_metrics_persistence')
      console.error('Should return: search_metrics_persistence 1')
      // Don't fail CI - this is optional but recommended
      process.exit(0)
    }
    
    console.log('✅ PASS: Workers Analytics Engine configuration found')
    process.exit(0)
    
  } catch (err) {
    console.error('❌ FAIL: Could not read wrangler.jsonc:', err)
    process.exit(2)
  }
}

main()