#!/usr/bin/env -S npx tsx
/**
 * DO Binding Verification Script
 * 
 * Verifies that the RATE_LIMITER Durable Object binding is properly configured
 * in wrangler.jsonc and will be available at deploy time.
 * 
 * Run in CI before deploy to catch missing bindings early.
 * Exit codes: 0 = OK, 1 = Missing binding, 2 = Config error
 */

import { parse } from 'comment-json'
import { readFileSync } from 'fs'
import { resolve } from 'path'

interface WranglerConfig {
  durable_objects?: {
    bindings?: Array<{ name: string; class_name: string }>
  }
}

function main() {
  const configPath = resolve(process.cwd(), 'wrangler.jsonc')
  
  try {
    const content = readFileSync(configPath, 'utf-8')
    const config: WranglerConfig = parse(content)
    
    const doBindings = config.durable_objects?.bindings || []
    const rateLimiterBinding = doBindings.find(b => b.name === 'RATE_LIMITER')
    
    if (!rateLimiterBinding) {
      console.error('❌ FAIL: RATE_LIMITER Durable Object binding NOT FOUND in wrangler.jsonc')
      console.error('')
      console.error('Required configuration:')
      console.error('  "durable_objects": {')
      console.error('    "bindings": [')
      console.error('      { "name": "RATE_LIMITER", "class_name": "RateLimiterDO" }')
      console.error('    ]')
      console.error('  }')
      console.error('')
      console.error('Add this to wrangler.jsonc and redeploy.')
      process.exit(1)
    }
    
    if (rateLimiterBinding.class_name !== 'RateLimiterDO') {
      console.error(`❌ FAIL: RATE_LIMITER binding has wrong class_name: "${rateLimiterBinding.class_name}"`)
      console.error('Expected: "RateLimiterDO"')
      process.exit(1)
    }
    
    console.log('✅ PASS: RATE_LIMITER Durable Object binding verified')
    console.log(`   Name: ${rateLimiterBinding.name}`)
    console.log(`   Class: ${rateLimiterBinding.class_name}`)
    process.exit(0)
    
  } catch (err) {
    if (err instanceof SyntaxError) {
      console.error('❌ FAIL: wrangler.jsonc contains invalid JSON:', err.message)
    } else {
      console.error('❌ FAIL: Could not read wrangler.jsonc:', err)
    }
    process.exit(2)
  }
}

main()