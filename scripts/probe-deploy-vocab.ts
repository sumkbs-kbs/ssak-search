/**
 * deployment/usage 어휘 충돌 스캔 (S99, 2026-08-11).
 *
 * S98 권고 ②(ML 어휘 + deployment/usage 의도 → technical 라우팅)의 어휘 스코프를
 * 정하기 위해, 후보 usage 어휘 각각이 어떤 쿼리를 academic에서 technical로
 * 뒤집을지 500쿼리 전체에서 확인한다. 목표: en-tech-40만 뒤집히고
 * ds-* / en-acad-* 논문 쿼리는 유지.
 * Usage: npx tsx scripts/probe-deploy-vocab.ts
 */
import { detectQueryType } from '../src/lib/specialized'
import { EVAL_QUERIES } from '../eval/queries'

const TERMS: Array<[string, RegExp]> = [
  ['deploy/deployment', /\bdeploy|deployment\b/i],
  ['setup', /\bsetup\b/i],
  ['install', /\binstall\b/i],
  ['configure/config', /\bconfigure|configuration|configuring\b/i],
  ['build', /\bbuild\b/i],
  ['use (bare)', /\buse\b/i],
  ['use cases', /\buse\s+cases?\b/i],
  ['how to', /\bhow\s+to\b/i],
  ['tutorial', /\btutorial\b/i],
  ['guide', /\bguide\b/i],
  ['best practices', /\bbest\s+practices?\b/i],
  ['production', /\bproduction\b/i],
  ['monitoring', /\bmonitoring\b/i],
  ['operational/ops', /\boperational|ops\b/i],
  [
    'deployment-ish (all above)',
    /\b(deploy|deployment|setup|install|configure|configuration|configuring|use\s+cases?|how\s+to|tutorial|guide|best\s+practices?|production|monitoring|operational)\b/i,
  ],
]

function main(): void {
  for (const [label, re] of TERMS) {
    const flipped = EVAL_QUERIES.filter((q) => detectQueryType(q.query) === 'academic' && re.test(q.query))
    if (flipped.length === 0) continue
    console.log(`\n== ${label} → academic 쿼리 ${flipped.length}건 뒤집힘 ==`)
    for (const q of flipped) console.log(`  ${q.id.padEnd(12)} | ${q.query}`)
  }
  const all =
    /\b(deploy|deployment|setup|install|configure|configuration|configuring|use\s+cases?|how\s+to|tutorial|guide|best\s+practices?|production|monitoring|operational)\b/i
  const flippedAll = EVAL_QUERIES.filter((q) => detectQueryType(q.query) === 'academic' && all.test(q.query))
  console.log(`\n=== 통합 어휘로 뒤집히는 academic 쿼리: ${flippedAll.length}건 ===`)
  for (const q of flippedAll) console.log(`  ${q.id.padEnd(12)} | ${q.query}`)
}

main()
