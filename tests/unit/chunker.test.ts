/**
 * Unit tests: Document Chunker (src/lib/index/chunker.ts).
 *
 * Covers: stripHtml, parseHtmlSections (headings, hierarchy, no-heading
 * fallback, script/style stripping), buildHeadingPath, estimateTokens (CJK
 * vs Latin), detectLanguage (ko/zh/ja/en), hashString determinism,
 * extractDomain, chunkDocument (single small doc, section-per-chunk,
 * sliding-window split, heading paths stats), chunkHtmlDocument alias.
 */

import { describe, it, expect } from 'vitest'
import {
  stripHtml,
  parseHtmlSections,
  buildHeadingPath,
  estimateTokens,
  detectLanguage,
  hashString,
  extractDomain,
  chunkDocument,
  chunkHtmlDocument,
  MAX_CHUNK_TOKENS,
  MIN_CHUNK_TOKENS,
} from '../../src/lib/index/chunker'

describe('stripHtml', () => {
  it('removes tags and decodes numeric entities', () => {
    expect(stripHtml('<p>Hello <b>world</b></p>')).toBe('Hello world')
    expect(stripHtml('&nbsp;A&amp;B')).toBe('A&amp;B') // &amp; itself is not decoded
    expect(stripHtml('&#x41;&#66;')).toBe('AB')
    expect(stripHtml('<script>var x=1;</script>Keep <style>.a{}</style>on')).toBe('Keep on')
  })

  it('collapses whitespace and trims', () => {
    expect(stripHtml('  a\n   b\t c  ')).toBe('a b c')
  })
})

describe('parseHtmlSections', () => {
  it('parses heading hierarchy with parent-child nesting', () => {
    const html = `
      <h1>Intro</h1>
      <p>intro text</p>
      <h2>Details</h2>
      <p>details text</p>
      <h2>More</h2>
      <p>more text</p>
    `
    const sections = parseHtmlSections(html)
    expect(sections).toHaveLength(1)
    expect(sections[0].heading).toBe('Intro')
    expect(sections[0].level).toBe(1)
    expect(sections[0].children).toHaveLength(2)
    expect(sections[0].children[0].heading).toBe('Details')
    expect(sections[0].children[0].content).toContain('details text')
  })

  it('returns a single unheaded section when no headings exist', () => {
    const sections = parseHtmlSections('<p>Plain content only</p>')
    expect(sections).toHaveLength(1)
    expect(sections[0].heading).toBe('')
    expect(sections[0].content).toContain('Plain content')
    expect(sections[0].level).toBe(0)
  })

  it('strips scripts, styles and comments before parsing', () => {
    const html = '<script>alert(1)</script><h1>Real</h1><style>h1{}</style><!-- c --><h2>Sub</h2>'
    const sections = parseHtmlSections(html)
    expect(sections[0].heading).toBe('Real')
  })

  it('ignores empty headings', () => {
    const html = '<h1></h1><h2>  </h2><h1>Actual</h1>'
    const sections = parseHtmlSections(html)
    expect(sections).toHaveLength(1)
    expect(sections[0].heading).toBe('Actual')
  })
})

describe('buildHeadingPath', () => {
  it('returns the heading path joined by >', () => {
    const section = { heading: 'Details', level: 2, content: '', children: [], startOffset: 0, endOffset: 0 }
    expect(buildHeadingPath(section, 3)).toBe('Details')
  })

  it('returns empty for a root-level section', () => {
    const section = { heading: '', level: 0, content: '', children: [], startOffset: 0, endOffset: 0 }
    expect(buildHeadingPath(section)).toBe('')
  })
})

describe('estimateTokens', () => {
  it('approximates ~4 chars per token for Latin text', () => {
    expect(estimateTokens('abcdefgh', 'en')).toBe(2)
    expect(estimateTokens('abc', 'en')).toBe(1)
  })

  it('counts more tokens for CJK (1.8 chars/token vs 4 for Latin)', () => {
    const text = '한글열두글자입니다'
    expect(estimateTokens(text, 'ko')).toBeGreaterThan(estimateTokens(text, 'en'))
    expect(estimateTokens('日本語テキスト', 'ja')).toBeGreaterThan(0)
    expect(estimateTokens('中文文本', 'zh-CN')).toBeGreaterThan(0)
  })
})

describe('detectLanguage', () => {
  it('detects Korean, Chinese, Japanese and defaults to English', () => {
    expect(detectLanguage('안녕하세요')).toBe('ko')
    expect(detectLanguage('你好世界')).toBe('zh-CN')
    expect(detectLanguage('繁體字')).toBe('zh-TW')
    expect(detectLanguage('こんにちは')).toBe('ja')
    expect(detectLanguage('hello world')).toBe('en')
  })
})

describe('hashString', () => {
  it('is deterministic and stable', () => {
    expect(hashString('hello')).toBe(hashString('hello'))
    expect(hashString('hello')).not.toBe(hashString('world'))
    expect(hashString('')).toBe('0')
  })
})

describe('extractDomain', () => {
  it('extracts hostnames and strips www', () => {
    expect(extractDomain('https://www.example.com/page')).toBe('example.com')
    expect(extractDomain('https://sub.example.org/a/b')).toBe('sub.example.org')
  })

  it('returns unknown for invalid URLs', () => {
    expect(extractDomain('not a url')).toBe('unknown')
  })
})

describe('chunkDocument', () => {
  const SMALL_HTML = '<h1>Title</h1><p>Short body text here.</p>'

  it('creates a single chunk for a small document', () => {
    const result = chunkDocument('https://a.com/page', 'A Page', SMALL_HTML)
    expect(result.chunks).toHaveLength(1)
    expect(result.stats.totalChunks).toBe(1)
    expect(result.chunks[0].url).toBe('https://a.com/page')
    expect(result.chunks[0].title).toBe('A Page')
    expect(result.chunks[0].domain).toBe('a.com')
    expect(result.chunks[0].id).toMatch(/^[a-z0-9]+_chunk_0$/)
    expect(result.chunks[0].contentHash).toBe(hashString(result.chunks[0].content))
  })

  it('produces one chunk per section with heading paths', () => {
    const html = '<h1>Intro</h1><p>intro words</p><h1>Second</h1><p>second words</p>'
    const result = chunkDocument('https://a.com', 'T', html)
    expect(result.chunks.length).toBeGreaterThanOrEqual(2)
    expect(result.stats.headingPaths).toContain('Intro')
    expect(result.stats.headingPaths).toContain('Second')
  })

  it('splits oversized sections via sliding window', () => {
    const longText = 'word '.repeat(600)
    const html = `<h1>Big</h1><p>${longText}</p>`
    const result = chunkDocument('https://a.com', 'T', html, { maxTokens: 100, minTokens: 10, overlapTokens: 10 })
    expect(result.chunks.length).toBeGreaterThan(1)
    // Every chunk respects the budget (maxChars = maxTokens * 4)
    for (const c of result.chunks) {
      expect(c.content.length).toBeLessThanOrEqual(100 * 4 + 1)
    }
  })

  it('accumulates totalTokens across chunks', () => {
    const html = '<h1>A</h1><p>alpha beta</p><h1>B</h1><p>gamma delta</p>'
    const result = chunkDocument('https://a.com', 'T', html)
    expect(result.totalTokens).toBeGreaterThan(0)
    expect(result.stats.avgTokensPerChunk).toBeGreaterThan(0)
  })

  it('chunkHtmlDocument is an alias', () => {
    const a = chunkDocument('https://a.com', 'T', SMALL_HTML)
    const b = chunkHtmlDocument('https://a.com', 'T', SMALL_HTML)
    expect(b.chunks).toEqual(a.chunks)
  })

  it('honors the language option for token estimation', () => {
    const html = '<h1>한국어</h1><p>테스트 문서입니다</p>'
    const ko = chunkDocument('https://a.com', 'T', html, { language: 'ko' })
    const en = chunkDocument('https://a.com', 'T', html, { language: 'en' })
    // CJK text needs more tokens under the ko estimate than the en estimate
    expect(ko.totalTokens).toBeGreaterThan(en.totalTokens)
  })

  it('exports the chunk size constants', () => {
    expect(MAX_CHUNK_TOKENS).toBe(300)
    expect(MIN_CHUNK_TOKENS).toBe(50)
  })
})
