import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  assertSafeFetchUrl, isPublicHostname, normalizeUrl, extractDomain,
  domainMatches, truncateToTokens, parseDate, timeRangeToDays, simplifyQuery,
  countryToBingMkt, countryToLanguageTag, computeScore, generateRelatedQueries,
  stripHtml, decodeEntities, getDomainAuthority,
} from '../../src/lib/util'

describe('normalizeUrl', () => {
  it('adds https:// to bare hostnames', () => {
    expect(normalizeUrl('example.com')).toBe('https://example.com')
    expect(normalizeUrl('example.com/path?q=1')).toBe('https://example.com/path?q=1')
  })

  it('preserves existing http/https', () => {
    expect(normalizeUrl('http://example.com')).toBe('http://example.com')
    expect(normalizeUrl('https://example.com')).toBe('https://example.com')
  })

  it('prefixes // with https:', () => {
    expect(normalizeUrl('//cdn.example.com/lib.js')).toBe('https://cdn.example.com/lib.js')
  })

  it('rejects non-http(s) schemes', () => {
    expect(() => normalizeUrl('file:///etc/passwd')).toThrow(/Unsupported URL scheme/)
    expect(() => normalizeUrl('javascript:alert(1)')).toThrow(/Unsupported URL scheme/)
    expect(() => normalizeUrl('data:text/html,<script>')).toThrow(/Unsupported URL scheme/)
    expect(() => normalizeUrl('ftp://example.com/')).toThrow(/Unsupported URL scheme/)
  })
})

describe('isPublicHostname', () => {
  // Public — should pass
  it('allows public domain hostnames', () => {
    expect(isPublicHostname('example.com')).toBe(true)
    expect(isPublicHostname('sub.example.co.uk')).toBe(true)
    expect(isPublicHostname('wikipedia.org')).toBe(true)
    expect(isPublicHostname('1.1.1.1')).toBe(true) // Cloudflare DNS, public
    expect(isPublicHostname('8.8.8.8')).toBe(true) // Google DNS, public
  })

  // Loopback
  it('blocks 127.0.0.0/8', () => {
    for (let i = 0; i < 256; i++) {
      expect(isPublicHostname(`127.0.${i}.1`)).toBe(false)
    }
    expect(isPublicHostname('localhost')).toBe(false)
    expect(isPublicHostname('myapp.localhost')).toBe(false)
  })

  // Private
  it('blocks 10.0.0.0/8', () => {
    expect(isPublicHostname('10.0.0.1')).toBe(false)
    expect(isPublicHostname('10.255.255.255')).toBe(false)
  })

  it('blocks 172.16.0.0/12', () => {
    expect(isPublicHostname('172.16.0.1')).toBe(false)
    expect(isPublicHostname('172.31.255.255')).toBe(false)
  })

  it('blocks 192.168.0.0/16', () => {
    expect(isPublicHostname('192.168.0.1')).toBe(false)
    expect(isPublicHostname('192.168.1.1')).toBe(false)
    expect(isPublicHostname('192.168.255.255')).toBe(false)
  })

  it('blocks 0.0.0.0/8', () => {
    expect(isPublicHostname('0.0.0.0')).toBe(false)
    expect(isPublicHostname('0.1.2.3')).toBe(false)
  })

  // Link-local / metadata
  it('blocks 169.254.0.0/16 (link-local + cloud metadata)', () => {
    expect(isPublicHostname('169.254.169.254')).toBe(false) // AWS/GCP metadata
    expect(isPublicHostname('169.254.1.1')).toBe(false)
  })

  it('blocks CGNAT 100.64.0.0/10', () => {
    expect(isPublicHostname('100.64.0.1')).toBe(false)
    expect(isPublicHostname('100.127.255.255')).toBe(false)
  })

  it('returns 0 for unknown domains', () => {
    expect(getDomainAuthority('https://example.com/test')).toBe(0)
    expect(getDomainAuthority('https://myblog.com/post')).toBe(0)
  })
})

describe('assertSafeFetchUrl — SSRF DNS-rebinding guards (P0-6 hardening)', () => {
  afterEach(() => vi.restoreAllMocks()) // eslint-disable-line no-undef

  const rcode3_body = Promise.resolve({ Status: 3, Answer: [] })
  const nxdomainStub = vi.fn().mockResolvedValue({ ok: true, json: () => rcode3_body })

  it('blocks a hostname whose DoH authoritatively returns NXDOMAIN (RFC1035 RCODE=3)', async () => {
    vi.stubGlobal('fetch', nxdomainStub)

    await expect(assertSafeFetchUrl('http://definitely-does-not-exist-98765.com')).rejects.toThrow(
      /NXDOMAIN/,
    )
  })

  it('allows transient NOERROR + empty-answer responses (fail-open by design)', async () => {
    const noerror_body = Promise.resolve({ Status: 0 /* RFC1035 NOERROR */ }) // NOT a definitive NXDOMAIN → permitted to fail-open. Only downstream private-IP matches would then block.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => noerror_body }))

    await assertSafeFetchUrl('http://transient.example.com') // resolves; only a resolved-to-private IP below would throw "Blocked hostname"
  })

  it('still validates every resolved IP — blocks DoH responses resolving to private addresses', async () => {
    const body_with_private_ip = Promise.resolve({ Status: 0, Answer: [{ type: 1 /* A */, data: '169.254.169.254' }] }) // AWS IMDSv1 metadata endpoint — must block

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => body_with_private_ip }))

    await expect(assertSafeFetchUrl('http://metadata.internal')).rejects.toThrow(/private|internal/)
  })

  it('blocks the classic DNS-rebinding pattern — attacker-controlled hostname resolves to loopback', async () => {
    const rebinding_body = Promise.resolve({
      Status: 0,
      Answer: [{ type: 1, data: '127.0.0.1' }],
    })

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => rebinding_body }))

    await expect(assertSafeFetchUrl('http://evil.attacker.com/admin')).rejects.toThrow(
      /private\/internal IP: 127\.0\.0\.1/,
    )
  })
})