/**
 * S104-③-② probe — Slack alert delivery verification against a real local
 * capture server.
 *
 * Real Slack receipt requires a workspace Incoming Webhook URL, which is NOT
 * configured anywhere in this environment (Pages project has no SLACK_WEBHOOK
 * secret; .env/.env.example have none). This probe verifies the DELIVERY
 * MECHANISM end-to-end at the transport layer instead: it starts a real HTTP
 * server on an ephemeral port, calls alertBackendDown (the exact function the
 * deep health probe invokes when a backend reports `down`), and asserts the
 * server actually RECEIVED the POST with the expected alert payload.
 *
 * Run: npm run probe:slack-delivery
 * Result: prints DELIVERED with the captured title/message/fields, or FAIL.
 *
 * Note: `npx wrangler pages secret list` shows no SLACK_WEBHOOK on the
 * production project — the worker currently no-ops alerts. After adding the
 * secret (SLACK_WEBHOOK or ALERT_SLACK_WEBHOOK) + redeploy, the 15-min cron
 * probe will deliver for real.
 */
import { createServer } from 'node:http'
import { alertBackendDown, resolveWebhookUrl } from '../src/lib/slack-alert'

interface Captured {
  path: string
  method: string
  contentType: string | undefined
  body: string
}

function startCaptureServer(): Promise<{ url: string; close(): Promise<void>; received(): Promise<Captured> }> {
  let resolveReceived: (c: Captured) => void = () => {}
  const received = new Promise<Captured>((r) => {
    resolveReceived = r
  })
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => (body += chunk.toString()))
    req.on('end', () => {
      resolveReceived({
        path: req.url ?? '',
        method: req.method ?? '',
        contentType: req.headers['content-type'],
        body,
      })
      res.writeHead(200)
      res.end('ok')
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve({
        url: `http://127.0.0.1:${port}/services/T/B/X`,
        close: () => new Promise((r) => server.close(() => r())),
        received: () => received,
      })
    })
  })
}

async function main(): Promise<void> {
  const { url, close, received } = await startCaptureServer()

  const delivered = await alertBackendDown(url, 'wikipedia', 842, 'down')
  const capture = await received()
  await close()

  const parsed = JSON.parse(capture.body) as {
    text: string
    attachments: Array<{ color: string; blocks: Array<Record<string, unknown>> }>
  }
  const header = parsed.attachments[0].blocks[0] as { text?: { text?: string } }
  const section = parsed.attachments[0].blocks[1] as { text?: { text?: string } }

  const ok =
    delivered === true &&
    capture.method === 'POST' &&
    capture.contentType?.includes('application/json') &&
    parsed.text.includes('Backend Down: wikipedia') &&
    header.text?.text === '🔴 Backend Down: wikipedia' &&
    section.text?.text?.includes('*wikipedia*') &&
    section.text?.text?.includes('842ms')

  console.log('=== S104-③-② Slack delivery probe ===')
  console.log(`webhook: ${url}`)
  console.log(`delivered (alertBackendDown): ${delivered}`)
  console.log(`HTTP: ${capture.method} ${capture.path} | content-type: ${capture.contentType}`)
  console.log(`title: ${header.text?.text}`)
  console.log(`message: ${section.text?.text}`)
  console.log(`payload text: ${parsed.text}`)

  // Naming-mismatch check (S104-③-② fix)
  const both = resolveWebhookUrl({ ALERT_SLACK_WEBHOOK: 'https://hooks.slack.example/b' })
  console.log(
    `\nresolveWebhookUrl(ALERT_SLACK_WEBHOOK only) → ${both} (documented-name fallback: ${both === 'https://hooks.slack.example/b' ? 'OK' : 'FAIL'})`,
  )

  if (!ok) {
    console.log('\n❌ FAIL: delivery verification failed')
    process.exit(1)
  }
  console.log('\n✅ DELIVERED: HTTP POST captured by a real server with the correct alert payload')
  console.log('⚠️  Real Slack receipt still requires a webhook secret:')
  console.log(
    '   npx wrangler pages secret put SLACK_WEBHOOK (or ALERT_SLACK_WEBHOOK) --project-name search-engine-api',
  )
  console.log('   then redeploy — the 15-min cron probe will deliver for real.')
}

void main()
