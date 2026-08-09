/**
 * Unit tests for YouTube video details extraction (Phase 1).
 *
 * Covers:
 *   - extractYouTubeId: URL → 11-char video ID for all common link forms
 *   - parsePlayerResponse: ytInitialPlayerResponse JSON → rich details
 *     (title, description, keywords, channel, view/like counts, publish date)
 *   - searchYouTube parseVideoData: description snippet extraction
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  extractYouTubeId,
  parsePlayerResponse,
  parseVideoData,
  formatTimestamp,
  isYouTubeUrl,
  buildYouTubeEvidenceText,
  youtubeExtract,
  getTranscriptFromTimedtext,
  type YouTubeVideoDetails,
} from '../../src/lib/youtube-search'

describe('extractYouTubeId', () => {
  const ID = 'dQw4w9WgXcQ'

  it('extracts from canonical watch URLs', () => {
    expect(extractYouTubeId(`https://www.youtube.com/watch?v=${ID}`)).toBe(ID)
    expect(extractYouTubeId(`https://www.youtube.com/watch?v=${ID}&feature=share`)).toBe(ID)
    expect(extractYouTubeId(`https://m.youtube.com/watch?v=${ID}`)).toBe(ID)
    expect(extractYouTubeId(`https://youtube.com/watch?v=${ID}`)).toBe(ID)
  })

  it('extracts from youtu.be short links', () => {
    expect(extractYouTubeId(`https://youtu.be/${ID}`)).toBe(ID)
    expect(extractYouTubeId(`https://youtu.be/${ID}?t=42`)).toBe(ID)
  })

  it('extracts from shorts / embed / live paths', () => {
    expect(extractYouTubeId(`https://www.youtube.com/shorts/${ID}`)).toBe(ID)
    expect(extractYouTubeId(`https://www.youtube.com/embed/${ID}`)).toBe(ID)
    expect(extractYouTubeId(`https://www.youtube.com/live/${ID}`)).toBe(ID)
    expect(extractYouTubeId(`https://www.youtube.com/v/${ID}`)).toBe(ID)
  })

  it('accepts a bare 11-char ID', () => {
    expect(extractYouTubeId(ID)).toBe(ID)
  })

  it('returns null for invalid input', () => {
    expect(extractYouTubeId('')).toBeNull()
    expect(extractYouTubeId('https://example.com/not-youtube')).toBeNull()
    expect(extractYouTubeId('https://www.youtube.com/watch?v=short')).toBeNull()
    expect(extractYouTubeId('https://www.youtube.com/channel/UC123')).toBeNull()
    expect(extractYouTubeId('not a url or id')).toBeNull()
  })
})

describe('parsePlayerResponse', () => {
  it('extracts rich details from ytInitialPlayerResponse JSON', () => {
    const json = JSON.stringify({
      videoDetails: {
        videoId: 'abcDEFghijk',
        title: 'How S&P 500 Index Funds Work',
        lengthSeconds: '742',
        keywords: ['investing', 'S&P 500', 'index fund'],
        channelId: 'UCFKDEADBEEF',
        shortDescription: 'A complete guide to S&P 500 index funds for beginners.',
        viewCount: '1234567',
        author: 'Finance Academy',
      },
      microformat: {
        playerMicroformatRenderer: {
          publishDate: '2026-07-15',
          uploadDate: '2026-07-15',
          likeCount: '45210',
          channelId: 'UCFKDEADBEEF',
          ownerChannelName: 'Finance Academy',
        },
      },
    })

    const details = parsePlayerResponse(json)
    expect(details).not.toBeNull()
    expect(details!.id).toBe('abcDEFghijk')
    expect(details!.title).toBe('How S&P 500 Index Funds Work')
    expect(details!.description).toContain('S&P 500 index funds')
    expect(details!.keywords).toEqual(['investing', 'S&P 500', 'index fund'])
    expect(details!.channel).toBe('Finance Academy')
    expect(details!.channel_id).toBe('UCFKDEADBEEF')
    expect(details!.length_seconds).toBe(742)
    expect(details!.view_count).toBe(1234567)
    expect(details!.like_count).toBe(45210)
    expect(details!.publish_date).toBe('2026-07-15')
    expect(details!.duration).toBe('12:22')
    expect(details!.url).toBe('https://youtube.com/watch?v=abcDEFghijk')
  })

  it('tolerates missing optional fields', () => {
    const json = JSON.stringify({
      videoDetails: { videoId: 'xyzXYZxyz12', title: 'Minimal' },
    })
    const details = parsePlayerResponse(json)
    expect(details).not.toBeNull()
    expect(details!.keywords).toEqual([])
    expect(details!.length_seconds).toBeUndefined()
    expect(details!.publish_date).toBeUndefined()
  })

  it('returns null for non-player-response JSON', () => {
    expect(parsePlayerResponse(JSON.stringify({ contents: [] }))).toBeNull()
    expect(parsePlayerResponse('not json')).toBeNull()
  })
})

describe('parseVideoData — description extraction (B3 fix)', () => {
  const json = JSON.stringify({
    contents: {
      twoColumnSearchResultsRenderer: {
        primaryContents: {
          sectionListRenderer: {
            contents: [
              {
                itemSectionRenderer: {
                  contents: [
                    {
                      videoRenderer: {
                        videoId: 'videoOne1111',
                        title: { runs: [{ text: 'S&P 500 Explained' }] },
                        ownerText: { runs: [{ text: 'Finance Channel' }] },
                        lengthText: { simpleText: '10:30' },
                        detailedMetadataSnippets: [
                          {
                            snippetText: { runs: [{ text: 'How the S&P 500 index works, explained in ten minutes.' }] },
                          },
                        ],
                      },
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    },
  })

  it('captures the description snippet into search results', () => {
    const videos = parseVideoData(json, 5)
    expect(videos.length).toBe(1)
    expect(videos[0].description).toContain('S&P 500 index works')
  })
})

describe('formatTimestamp', () => {
  it('formats minutes and seconds', () => {
    expect(formatTimestamp(0)).toBe('0:00')
    expect(formatTimestamp(65)).toBe('1:05')
    expect(formatTimestamp(742)).toBe('12:22')
    expect(formatTimestamp(3725)).toBe('1:02:05')
  })
})

describe('isYouTubeUrl', () => {
  it('recognizes all common YouTube link forms', () => {
    expect(isYouTubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(true)
    expect(isYouTubeUrl('https://youtu.be/dQw4w9WgXcQ')).toBe(true)
    expect(isYouTubeUrl('https://www.youtube.com/shorts/dQw4w9WgXcQ')).toBe(true)
    expect(isYouTubeUrl('https://m.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(true)
  })

  it('rejects non-video YouTube pages and other sites', () => {
    expect(isYouTubeUrl('https://www.youtube.com/results?search_query=test')).toBe(false)
    expect(isYouTubeUrl('https://www.youtube.com/@somechannel')).toBe(false)
    expect(isYouTubeUrl('https://example.com/watch?v=dQw4w9WgXcQ')).toBe(false)
    expect(isYouTubeUrl('https://news.naver.com/')).toBe(false)
  })
})

describe('buildYouTubeEvidenceText', () => {
  const details: YouTubeVideoDetails = {
    id: 'abcDEFghijk',
    title: 'How S&P 500 Index Funds Work',
    url: 'https://youtube.com/watch?v=abcDEFghijk',
    channel: 'Finance Academy',
    thumbnail: '',
    description: 'A complete guide to S&P 500 index funds for beginners.',
    keywords: ['investing', 'S&P 500'],
    duration: '12:22',
    views: '1,234,567',
    publish_date: '2026-07-15',
    transcript: [
      { text: 'An index fund tracks a market index.', duration: 4, start: 0 },
      { text: 'The S&P 500 covers 500 large US companies.', duration: 5, start: 4 },
    ],
    transcript_text: 'An index fund tracks a market index. The S&P 500 covers 500 large US companies.',
  }

  it('combines metadata, description, keywords, and transcript', () => {
    const text = buildYouTubeEvidenceText(details)
    expect(text).toContain('Title: How S&P 500 Index Funds Work')
    expect(text).toContain('Channel: Finance Academy')
    expect(text).toContain('Published: 2026-07-15')
    expect(text).toContain('Views: 1,234,567')
    expect(text).toContain('Duration: 12:22')
    expect(text).toContain('Description:')
    expect(text).toContain('S&P 500 index funds for beginners')
    expect(text).toContain('Keywords: investing, S&P 500')
    expect(text).toContain('Transcript:')
    expect(text).toContain('An index fund tracks a market index')
    // Plain-text transcript (no timestamps) by default — evidence-friendly
    expect(text).not.toContain('[0:00]')
  })

  it('can render transcript with timestamps when requested', () => {
    const text = buildYouTubeEvidenceText(details, { includeTimestamps: true })
    expect(text).toContain('[0:00] An index fund tracks a market index.')
  })

  it('truncates to maxTokens', () => {
    const text = buildYouTubeEvidenceText(details, { maxTokens: 12 })
    expect(text.length).toBeLessThanOrEqual((details.transcript_text ?? '').length + details.description.length)
    // Truncation still lands on whole words (truncateToTokens semantics)
    expect(text.length).toBeLessThan(200)
  })

  it('works with minimal details (no transcript)', () => {
    const minimal: YouTubeVideoDetails = {
      id: 'minimal0000',
      title: 'Minimal video',
      url: 'https://youtube.com/watch?v=minimal0000',
      channel: '',
      thumbnail: '',
      description: '',
      keywords: [],
    }
    const text = buildYouTubeEvidenceText(minimal)
    expect(text).toContain('Title: Minimal video')
    expect(text).not.toContain('Transcript:')
  })
})

describe('youtubeExtract', () => {
  it('returns an explicit failure for non-YouTube URLs without network calls', async () => {
    const result = await youtubeExtract('https://news.naver.com/movie/123')
    expect(result.success).toBe(false)
    expect(result.raw_content).toBe('')
    expect(result.error).toContain('Not a YouTube URL')
  })
})

describe('getTranscriptFromTimedtext', () => {
  const originalFetch = globalThis.fetch
  const baseUrl = 'https://www.youtube.com/api/timedtext?v=abcDEFghijk&lang=en&signature=ABC&key=yt8'

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('parses JSON3 events (even when served with a text/html content-type)', async () => {
    const json3 = JSON.stringify({
      events: [
        { tStartMs: 0, dDurationMs: 4000, segs: [{ utf8: 'Hello there.' }] },
        { tStartMs: 4000, dDurationMs: 5000, segs: [{ utf8: 'General Kenobi.' }] },
      ],
    })
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/html; charset=UTF-8' }), // YouTube quirk
      text: async () => json3,
    }) as unknown as typeof fetch

    const segs = await getTranscriptFromTimedtext(baseUrl)
    expect(segs).toHaveLength(2)
    expect(segs[0].text).toBe('Hello there.')
    expect(segs[0].start).toBe(0)
    expect(segs[1].text).toBe('General Kenobi.')
    expect(segs[1].start).toBe(4)
  })

  it('parses legacy XML payloads', async () => {
    const xml =
      '<transcript><text start="0" dur="4">Hello &amp; welcome</text>' +
      '<text start="4" dur="5">Second line &#39;quote&#39;</text></transcript>'
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/xml' }),
      text: async () => xml,
    }) as unknown as typeof fetch

    const segs = await getTranscriptFromTimedtext(baseUrl)
    expect(segs).toHaveLength(2)
    expect(segs[0].text).toBe('Hello & welcome')
    expect(segs[0].start).toBe(0)
    expect(segs[1].text).toBe("Second line 'quote'")
    expect(segs[1].start).toBe(4)
  })

  it('returns empty array on non-OK responses', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 403 }) as unknown as typeof fetch
    const segs = await getTranscriptFromTimedtext(baseUrl)
    expect(segs).toEqual([])
  })
})
