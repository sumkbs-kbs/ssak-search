/**
 * Unit tests: YouTube search pure functions (youtube-search.ts).
 *
 * Covers: extractYouTubeId (bare/watch/shorts/embed/live/v paths, host
 * validation, invalid inputs), parseVideoData (renderer extraction,
 * description snippets, malformed JSON), formatTimestamp, transcript
 * formatters (timestamps + SRT), isYouTubeUrl, buildYouTubeEvidenceText
 * (metadata/description/keywords/transcript + maxTokens truncation).
 */

import { describe, it, expect } from 'vitest'
import {
  extractYouTubeId,
  parseVideoData,
  formatTimestamp,
  formatTranscriptWithTimestamps,
  formatTranscriptSrt,
  isYouTubeUrl,
  buildYouTubeEvidenceText,
  type YouTubeVideo,
} from '../../src/lib/youtube-search'

describe('extractYouTubeId', () => {
  const ID = 'dQw4w9WgXcQ'

  it('accepts a bare 11-char ID', () => {
    expect(extractYouTubeId(ID)).toBe(ID)
  })

  it('parses watch URLs with host validation', () => {
    expect(extractYouTubeId(`https://www.youtube.com/watch?v=${ID}`)).toBe(ID)
    expect(extractYouTubeId(`https://youtube.com/watch?v=${ID}&t=30`)).toBe(ID)
    expect(extractYouTubeId(`https://m.youtube.com/watch?v=${ID}`)).toBe(ID)
  })

  it('rejects a v param on a non-YouTube host', () => {
    expect(extractYouTubeId(`https://evil.example/watch?v=${ID}`)).toBeNull()
  })

  it('parses youtu.be, shorts, embed, live paths', () => {
    expect(extractYouTubeId(`https://youtu.be/${ID}`)).toBe(ID)
    expect(extractYouTubeId(`https://www.youtube.com/shorts/${ID}`)).toBe(ID)
    expect(extractYouTubeId(`https://www.youtube.com/embed/${ID}`)).toBe(ID)
    expect(extractYouTubeId(`https://www.youtube.com/live/${ID}`)).toBe(ID)
  })

  it('parses legacy /v/ paths', () => {
    expect(extractYouTubeId(`https://www.youtube.com/v/${ID}`)).toBe(ID)
  })

  it('handles protocol-less and music subdomain inputs', () => {
    expect(extractYouTubeId(`youtu.be/${ID}`)).toBe(ID)
    expect(extractYouTubeId(`https://music.youtube.com/watch?v=${ID}`)).toBe(ID)
  })

  it('returns null for invalid inputs', () => {
    expect(extractYouTubeId('')).toBeNull()
    expect(extractYouTubeId('   ')).toBeNull()
    expect(extractYouTubeId('short')).toBeNull()
    expect(extractYouTubeId('https://example.com/page')).toBeNull()
    expect(extractYouTubeId(123 as unknown as string)).toBeNull()
  })
})

describe('parseVideoData', () => {
  function videoRenderer(overrides: Record<string, unknown> = {}) {
    return {
      videoId: 'vid12345678',
      title: { runs: [{ text: 'Example Video' }] },
      ownerText: { runs: [{ text: 'Example Channel', navigationEndpoint: { browseEndpoint: { browseId: 'UC123' } } }] },
      thumbnail: { thumbnails: [{ url: 'https://i.ytimg.com/1.jpg' }, { url: 'https://i.ytimg.com/hq.jpg' }] },
      lengthText: { simpleText: '12:34' },
      viewCountText: { simpleText: '1,234,567 views' },
      publishedTimeText: { simpleText: '3 years ago' },
      ...overrides,
    }
  }

  function page(renderers: unknown[]): string {
    return JSON.stringify({
      contents: {
        twoColumnSearchResultsRenderer: {
          primaryContents: {
            sectionListRenderer: {
              // parseVideoData reads item.videoRenderer — wrap each renderer
              contents: [{ itemSectionRenderer: { contents: renderers.map((r) => ({ videoRenderer: r })) } }],
            },
          },
        },
      },
    })
  }

  it('extracts video fields from ytInitialData', () => {
    const videos = parseVideoData(page([videoRenderer()]), 10)
    expect(videos).toHaveLength(1)
    const v = videos[0]
    expect(v.id).toBe('vid12345678')
    expect(v.title).toBe('Example Video')
    expect(v.channel).toBe('Example Channel')
    expect(v.channel_url).toBe('https://youtube.com/channel/UC123')
    expect(v.thumbnail).toBe('https://i.ytimg.com/hq.jpg') // last thumbnail
    expect(v.duration).toBe('12:34')
    expect(v.views).toBe('1,234,567 views')
    expect(v.published).toBe('3 years ago')
    expect(v.url).toBe('https://youtube.com/watch?v=vid12345678')
  })

  it('joins detailedMetadataSnippets into a description', () => {
    const renderer = videoRenderer({
      detailedMetadataSnippets: [{ snippetText: { runs: [{ text: 'First part' }, { text: ' second part' }] } }],
    })
    const videos = parseVideoData(page([renderer]), 10)
    // runs join as-is; the second run carries its leading space
    expect(videos[0].description).toContain('First part  second part')
  })

  it('falls back to descriptionSnippet when no detailed snippets', () => {
    const renderer = videoRenderer({
      descriptionSnippet: { runs: [{ text: 'Fallback desc' }] },
    })
    const videos = parseVideoData(page([renderer]), 10)
    expect(videos[0].description).toBe('Fallback desc')
  })

  it('skips items without a videoRenderer and honors maxResults', () => {
    const videos = parseVideoData(page([{ unrelated: {} }, videoRenderer(), videoRenderer(), videoRenderer()]), 2)
    expect(videos).toHaveLength(2)
  })

  it('returns [] on malformed JSON', () => {
    expect(parseVideoData('{not json', 10)).toEqual([])
    expect(parseVideoData('null', 10)).toEqual([])
  })

  it('tolerates missing renderer fields', () => {
    // page() wraps renderers in { videoRenderer }, so pass the raw renderer
    const videos = parseVideoData(page([{ videoId: 'abc123' }]), 10)
    expect(videos).toHaveLength(1)
    const v: YouTubeVideo = videos[0]
    expect(v.title).toBe('')
    expect(v.channel).toBe('')
  })
})

describe('formatTimestamp', () => {
  it('formats HH:MM:SS when hours present', () => {
    expect(formatTimestamp(3661)).toBe('1:01:01')
  })

  it('formats MM:SS otherwise', () => {
    expect(formatTimestamp(65)).toBe('1:05')
    expect(formatTimestamp(0)).toBe('0:00')
  })
})

describe('transcript formatters', () => {
  const segments = [
    { text: 'Hello world', start: 0, duration: 2.5 },
    { text: 'Second line', start: 3, duration: 2 },
  ]

  it('formats with timestamps', () => {
    const out = formatTranscriptWithTimestamps(segments)
    expect(out).toContain('[0:00] Hello world')
    expect(out).toContain('[0:03] Second line')
  })

  it('formats SRT blocks with sequence numbers and ranges', () => {
    const out = formatTranscriptSrt(segments)
    expect(out).toContain('1\n0:00,000 --> 0:02,000\nHello world')
    expect(out).toContain('2\n0:03,000 --> 0:05,000\nSecond line')
  })
})

describe('isYouTubeUrl', () => {
  it('detects YouTube URLs', () => {
    expect(isYouTubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(true)
    expect(isYouTubeUrl('dQw4w9WgXcQ')).toBe(true)
  })

  it('rejects non-YouTube inputs', () => {
    expect(isYouTubeUrl('https://example.com')).toBe(false)
    expect(isYouTubeUrl('')).toBe(false)
  })
})

describe('buildYouTubeEvidenceText', () => {
  const details = {
    id: 'abc',
    url: 'https://www.youtube.com/watch?v=abc',
    thumbnail: 'https://i.ytimg.com/vi/abc/hqdefault.jpg',
    title: 'Quantum Computing Explained',
    channel: 'Science Channel',
    published: '2024-01-01',
    views: '1M views',
    duration: '10:00',
    description: 'A deep dive into qubits.',
    keywords: ['quantum', 'computing'],
    transcript: [
      { text: 'Quantum bits can be in superposition.', start: 0, duration: 2 },
    ],
  }

  it('combines metadata, description, keywords and transcript', () => {
    const text = buildYouTubeEvidenceText(details)
    expect(text).toContain('Title: Quantum Computing Explained')
    expect(text).toContain('Channel: Science Channel')
    expect(text).toContain('Views: 1M views')
    expect(text).toContain('Description:')
    expect(text).toContain('Keywords: quantum, computing')
    expect(text).toContain('Transcript:')
    expect(text).toContain('Quantum bits can be in superposition.')
  })

  it('includes timestamps when requested', () => {
    const text = buildYouTubeEvidenceText(details, { includeTimestamps: true })
    expect(text).toContain('[0:00]')
  })

  it('uses transcript_text over segments when timestamps are not requested', () => {
    // With includeTimestamps:false and transcript_text present, the raw text wins
    const text = buildYouTubeEvidenceText({ ...details, transcript_text: 'Raw transcript text.' })
    expect(text).toContain('Raw transcript text.')
    expect(text).not.toContain('[0:00]')
  })

  it('omits the transcript section when absent', () => {
    const text = buildYouTubeEvidenceText({ ...details, transcript: [], transcript_text: undefined })
    expect(text).not.toContain('Transcript:')
  })

  it('truncates to maxTokens', () => {
    const long = { ...details, description: 'word '.repeat(2000) }
    const text = buildYouTubeEvidenceText(long, { maxTokens: 50 })
    expect(text.length).toBeLessThan(500)
  })
})
