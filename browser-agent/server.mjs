#!/usr/bin/env node
/**
 * ssak-browser-agent — 로컬 브라우저 기반 검색 백엔드 데몬 (Phase I v1)
 *
 * 사용자의 실행 중인 Chrome에 CDP(DevToolsActivePort)로 붙어 Bing/Naver SERP와
 * 일반 페이지 본문을 읽어온다. 거주 IP + 실제 핑거프린트 + 로그인 세션이라
 * 클라우드 스크래핑이 막히는 지점을 통과한다.
 *
 * 보안 계약 (docs/BROWSER_AGENT.md §3.1):
 *   - 전 요청 Bearer 토큰 필수
 *   - /page는 http(s)만, localhost·사설 대역·.internal·명시적 포트 차단
 *   - /serp는 URL을 외부에서 받지 않음 (engine+query로 내부 생성)
 *   - 내비게이션 페이싱 4초 (계정 플래그 방지)
 *
 * Usage:
 *   BROWSER_AGENT_TOKEN=... npm start          # 토큰 미설정 시 생성해 출력
 *   BROWSER_CDP_WS=ws://... npm start          # 수동 CDP 엔드포인트 (폴백)
 */

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { chromium } from 'playwright'

const PORT = Number(process.env.PORT || 8765)
const MIN_NAV_GAP_MS = 4_000
const PAGE_TEXT_MAX = 20_000

// ── 인증 토큰 ────────────────────────────────────────────────────────────────
let TOKEN = process.env.BROWSER_AGENT_TOKEN || ''
if (!TOKEN) {
  TOKEN = 'ba_' + require('node:crypto').randomBytes(24).toString('hex')
  console.log('[auth] BROWSER_AGENT_TOKEN 미설정 — 임의 토큰 생성. 이 값으로 호출하세요:')
  console.log(`       Bearer ${TOKEN}`)
}

// ── CDP 연결 관리 ────────────────────────────────────────────────────────────
let browser = null
let connecting = null

function devToolsWsUrl() {
  if (process.env.BROWSER_CDP_WS) return process.env.BROWSER_CDP_WS
  const file = path.join(
    os.homedir(),
    'Library/Application Support/Google/Chrome/DevToolsActivePort',
  )
  try {
    const [port, browserPath] = fs.readFileSync(file, 'utf8').trim().split('\n')
    return `ws://127.0.0.1:${port}${browserPath}`
  } catch {
    return null
  }
}

async function getBrowser() {
  if (browser?.isConnected?.()) return browser ?? null
  if (connecting) return connecting
  connecting = (async () => {
    const wsUrl = devToolsWsUrl()
    if (!wsUrl) throw new Error('CDP endpoint not found (Chrome running with DevToolsActivePort?)')
    browser = await chromium.connectOverCDP(wsUrl, { timeout: 10_000 })
    console.log('[cdp] connected:', wsUrl.replace(/\/[0-9a-f-]{36}$/, '/…'))
    return browser
  })()
  try {
    return await connecting
  } finally {
    connecting = null
  }
}

// ── 내비게이션 페이싱 (계정 플래그 방지) ─────────────────────────────────────
let lastNavMs = 0
async function pacedGoto(page, url, timeoutMs) {
  const gap = Date.now() - lastNavMs
  if (gap < MIN_NAV_GAP_MS) await new Promise((r) => setTimeout(r, MIN_NAV_GAP_MS - gap))
  lastNavMs = Date.now()
  await page.goto(url, { timeout: timeoutMs, waitUntil: 'domcontentloaded' })
}

async function withPage(fn) {
  const b = await getBrowser()
  const ctx = b.contexts()[0]
  if (!ctx) throw new Error('no browser context')
  const page = await ctx.newPage()
  try {
    return await fn(page)
  } finally {
    await page.close().catch(() => {})
  }
}

// ── SSRF 방어 (/page) ────────────────────────────────────────────────────────
const PRIVATE_HOST =
  /^(localhost$|127\.|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|\[::1\]$|.*\.internal$|.*\.local$)/i

function assertPublicHttpUrl(raw) {
  let u
  try {
    u = new URL(raw)
  } catch {
    throw new Error('invalid url')
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('non-http url')
  if (PRIVATE_HOST.test(u.hostname)) throw new Error('private host blocked')
  if (u.port && u.port !== '80' && u.port !== '443') throw new Error('explicit port blocked')
  return u
}

// ── SERP 추출기 (engine별 셀렉터, 폴백 체인 포함) ────────────────────────────
const ENGINES = {
  async bing(query, count) {
    const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${Math.min(count * 2, 20)}`
    return withPage(async (page) => {
      await pacedGoto(page, url, 20_000)
      return page.evaluate((n) => {
        const out = []
        for (const li of document.querySelectorAll('#b_results .b_algo')) {
          const a = li.querySelector('h2 a')
          if (!a?.href) continue
          // Bing 클릭 추적 URL(bing.com/ck/a?u=a1<base64url>) → 실제 대상 복원
          let href = a.href
          if (href.includes('bing.com/ck/a')) {
            try {
              const u = new URL(href).searchParams.get('u') || ''
              if (u.startsWith('a1')) {
                const b64 = u.slice(2).replace(/-/g, '+').replace(/_/g, '/')
                const dec = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
                if (dec.startsWith('http')) href = dec
              }
            } catch {}
          }
          out.push({
            title: a.textContent?.trim() || '',
            url: href,
            snippet: (li.querySelector('.b_caption p, .b_lineclamp2, .b_paractl')?.textContent || '').trim(),
          })
          if (out.length >= n) break
        }
        return out
      }, count)
    })
  },
  async naver(query, count) {
    const url = `https://m.search.naver.com/search.naver?query=${encodeURIComponent(query)}`
    return withPage(async (page) => {
      await pacedGoto(page, url, 20_000)
      // 2026 리디자인: 유기적 결과가 fender-ui_<해시> 컴포넌트 안에 있어 클래스
      // 셀렉터가 무의미(실측). 대신 "네이버 외부 호스트" 링크 수집이 robust —
      // 광고(ader.naver.com)와 내부 탐색 링크는 자동 배제된다.
      return page.evaluate((n) => {
        const seen = new Set()
        const out = []
        const skipHost = /(^|\.)naver\.(com|net)$|^ad(er)?\.naver/i
        for (const a of document.querySelectorAll('a[href]')) {
          let h = a.href
          if (!h.startsWith('http') || skipHost.test(new URL(h).hostname)) continue
          if (/rd\.naver\.com|&u=/.test(h)) {
            try {
              const u = new URL(h).searchParams.get('u')
              if (u?.startsWith('http') && !skipHost.test(new URL(u).hostname)) h = u
            } catch {}
          }
          if (seen.has(h)) continue
          seen.add(h)
          let domain = ''
          try { domain = new URL(h).hostname.replace(/^www\./, '') } catch {}
          const txt = (a.innerText || a.textContent || '').replace(/\s+/g, ' ').trim()
          out.push({ title: txt.slice(0, 150), url: h, domain })
          if (out.length >= n) break
        }
        return out
      }, count)
    })
  }}

// ── HTTP 서버 ────────────────────────────────────────────────────────────────
function send(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) })
  res.end(body)
}

const server = http.createServer(async (req, res) => {
  const auth = req.headers.authorization === `Bearer ${TOKEN}`
  if (!auth) return send(res, 401, { error: 'unauthorized' })

  const chunks = []
  for await (const c of req) chunks.push(c)
  let body = {}
  try {
    body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
  } catch {}

  try {
    if (req.method === 'GET' && req.url === '/health') {
      let chrome = 'disconnected'
      try {
        const b = await getBrowser()
        chrome = b.isConnected() ? 'connected' : 'disconnected'
      } catch {}
      return send(res, 200, { ok: chrome === 'connected', chrome, lastNavMs })
    }

    if (req.method === 'POST' && req.url === '/serp') {
      const engine = ENGINES[body.engine]
      if (!engine) return send(res, 400, { error: 'engine must be bing|naver' })
      if (!body.query || typeof body.query !== 'string') return send(res, 400, { error: 'query required' })
      const raw = await engine(body.query, Math.min(Number(body.count) || 8, 10))
      const results = raw.map((r) => {
        let domain = ''
        try {
          domain = new URL(r.url).hostname.replace(/^www\./, '')
        } catch {}
        return { ...r, domain }
      })
      return send(res, 200, { results, engine: body.engine })
    }

    if (req.method === 'POST' && req.url === '/page') {
      if (!body.url) return send(res, 400, { error: 'url required' })
      const r = await extractPage(body.url)
      return send(res, 200, r)
    }

    send(res, 404, { error: 'not found' })
  } catch (err) {
    console.error('[agent]', err.message || err)
    send(res, 502, { error: String(err.message || err).slice(0, 200) })
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[agent] listening on http://127.0.0.1:${PORT}`)
  getBrowser().catch((e) => console.warn('[cdp] initial connect failed:', e.message))
})
