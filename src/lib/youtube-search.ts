import { logger, toError } from './logger'
/**
 * YouTube Search + Transcript Extraction (Phase 3.1b)
 *
 * Searches YouTube for videos without an API key by scraping the search results page.
 * Fetches transcripts via the free youtubetranscript.com API.
 *
 * Functions:
 *   searchYouTube(query, maxResults)    → YouTubeVideo[]
 *   getTranscript(videoId)              → TranscriptSegment[]
 *   searchWithTranscripts(query, max)  → YouTubeVideoWithTranscript[]
 */

export interface YouTubeVideo {
  id: string
  title: string
  url: string
  channel: string
  channel_url?: string
  thumbnail: string
  duration?: string
  views?: string
  published?: string
}

export interface TranscriptSegment {
  text: string
  duration: number
  start: number
}

export interface YouTubeVideoWithTranscript extends YouTubeVideo {
  transcript: TranscriptSegment[]
  transcript_text: string
}

const YT_SEARCH = 'https://www.youtube.com/results?search_query='
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

// ============================================================
// YouTube Search
// ============================================================

/**
 * Search YouTube for videos matching a query.
 * Parses the initial YT initial data from the search page HTML.
 */
export async function searchYouTube(
  query: string,
  maxResults = 10,
  signal?: AbortSignal,
): Promise<YouTubeVideo[]> {
  const url = YT_SEARCH + encodeURIComponent(query)

  const resp = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en-US,en;q=0.9' },
    signal,
    cf: { cacheTtl: 300, cacheEverything: true },
  })

  if (!resp.ok) {
    logger.warn(`YouTube search failed: HTTP ${resp.status}`)
    return []
  }

  const html = await resp.text()

  // Extract ytInitialData JSON from the page
  const match = html.match(/var ytInitialData\s*=\s*({.+?});\s*<\/script>/)
  if (!match) {
    // Try alternate pattern
    const altMatch = html.match(/window\[['"]ytInitialData['"]\]\s*=\s*({.+?});/)
    if (!altMatch) return []
    return parseVideoData(altMatch[1], maxResults)
  }

  return parseVideoData(match[1], maxResults)
}

function parseVideoData(jsonStr: string, maxResults: number): YouTubeVideo[] {
  try {
    const data = JSON.parse(jsonStr)
    const contents =
      data?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents ?? []

    const videos: YouTubeVideo[] = []

    for (const section of contents) {
      const items = section?.itemSectionRenderer?.contents ?? []
      for (const item of items) {
        const renderer = item?.videoRenderer
        if (!renderer) continue

        const id = renderer.videoId
        if (!id) continue

        const title = renderer.title?.runs?.[0]?.text || renderer.title?.simpleText || ''
        const channel = renderer.ownerText?.runs?.[0]?.text || ''
        const channelId = renderer.ownerText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId || ''
        const thumbnail = renderer.thumbnail?.thumbnails?.[renderer.thumbnail.thumbnails.length - 1]?.url || ''
        const duration = renderer.lengthText?.simpleText || ''
        const views = renderer.viewCountText?.simpleText || renderer.viewCountText?.runs?.[0]?.text || ''
        const published = renderer.publishedTimeText?.simpleText || ''

        videos.push({
          id,
          title: title.trim(),
          url: `https://youtube.com/watch?v=${id}`,
          channel: channel.trim(),
          channel_url: channelId ? `https://youtube.com/channel/${channelId}` : undefined,
          thumbnail,
          duration,
          views,
          published,
        })

        if (videos.length >= maxResults) break
      }
      if (videos.length >= maxResults) break
    }

    return videos
  } catch (err) {
    logger.warn('YouTube search parsing failed:', { error: toError(err) })
    return []
  }
}

// ============================================================
// Transcript Extraction
// ============================================================

/**
 * Format seconds to HH:MM:SS timestamp string.
 */
export function formatTimestamp(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  }
  return `${m}:${String(s).padStart(2, '0')}`
}

/**
 * Format transcript segments as readable text with timestamps.
 */
export function formatTranscriptWithTimestamps(segments: TranscriptSegment[]): string {
  return segments
    .map((s) => `[${formatTimestamp(s.start)}] ${s.text}`)
    .join('\n')
}

/**
 * Format transcript segments as SRT (SubRip) format.
 */
export function formatTranscriptSrt(segments: TranscriptSegment[]): string {
  return segments
    .map((s, i) => {
      const startTime = formatTimestamp(s.start)
      const endTime = formatTimestamp(s.start + s.duration)
      return `${i + 1}\n${startTime},000 --> ${endTime},000\n${s.text}\n`
    })
    .join('\n')
}

/**
 * Fetch transcript for a YouTube video using the free youtubetranscript.com API.
 * Supports optional language parameter.
 */
export async function getTranscript(
  videoId: string,
  options?: { signal?: AbortSignal; lang?: string },
): Promise<TranscriptSegment[]> {
  try {
    let url = `https://youtubetranscript.com/api?vid=${encodeURIComponent(videoId)}`
    if (options?.lang) {
      url += `&lang=${encodeURIComponent(options.lang)}`
    }
    const resp = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: options?.signal,
      cf: { cacheTtl: 3600, cacheEverything: true },
    })

    if (!resp.ok) {
      logger.warn(`Transcript fetch failed for ${videoId}: HTTP ${resp.status}`)
      return []
    }

    const data: unknown = await resp.json()

    // Handle both array and { segments, langs, generated } response formats
    const raw = data as { segments?: Array<{ text: string; start: number; dur: number }>; langs?: string[] }
    const segments: Array<{ text: string; start: number; dur: number }> =
      Array.isArray(data) ? (data as Array<{ text: string; start: number; dur: number }>) : raw.segments ?? []

    return segments.map((s) => ({
      text: s.text || '',
      duration: s.dur || 0,
      start: s.start || 0,
    }))
  } catch (err) {
    logger.warn(`Transcript fetch failed for ${videoId}:`, { error: toError(err) })
    return []
  }
}

/**
 * Fetch available transcript languages for a video.
 */
export async function getTranscriptLanguages(videoId: string): Promise<string[]> {
  try {
    const resp = await fetch(
      `https://youtubetranscript.com/api?vid=${encodeURIComponent(videoId)}`,
      {
        headers: { 'User-Agent': USER_AGENT },
        cf: { cacheTtl: 3600, cacheEverything: true },
      },
    )
    if (!resp.ok) return []
    const data: unknown = await resp.json()
    const raw = data as { langs?: string[] }
    return raw.langs ?? []    } catch (err) {
      logger.warn('[YouTube] Search failed:', { error: toError(err) })
      return []
    }
}

/**
 * Search YouTube and fetch transcripts for each result.
 */
export async function searchWithTranscripts(
  query: string,
  maxResults = 5,
): Promise<YouTubeVideoWithTranscript[]> {
  const videos = await searchYouTube(query, maxResults)

  const withTranscripts: YouTubeVideoWithTranscript[] = []
  for (const video of videos) {
    const transcript = await getTranscript(video.id)
    const transcriptText = transcript.map((s) => s.text).join(' ').slice(0, 10000)
    withTranscripts.push({ ...video, transcript, transcript_text: transcriptText })
  }

  return withTranscripts
}

// ============================================================
// Search functionality for the orchestrator
// ============================================================

/**
 * Search YouTube and return results in a format compatible with the
 * main search pipeline (SearchResult-like structure).
 */
export async function youtubeSearch(
  query: string,
  maxResults = 10,
  includeTranscripts = false,
): Promise<YouTubeSearchResult[]> {
  const videos = await searchYouTube(query, maxResults)

  const results: YouTubeSearchResult[] = []
  for (const video of videos) {
    let content = `YouTube video by ${video.channel}. Duration: ${video.duration || 'unknown'}. Published: ${video.published || 'unknown'}. Views: ${video.views || 'unknown'}`

    if (includeTranscripts) {
      const transcript = await getTranscript(video.id)
      if (transcript.length > 0) {
        const transcriptText = transcript.map((s) => s.text).join(' ').slice(0, 2000)
        content += `\n\nTranscript excerpt:\n${transcriptText}`
      }
    }

    results.push({
      title: video.title,
      url: video.url,
      content,
      score: 0.8,
      source: 'youtube',
      published_date: video.published,
      thumbnail: video.thumbnail,
      channel: video.channel,
      duration: video.duration,
      views: video.views,
    })
  }

  return results
}

export interface YouTubeSearchResult {
  title: string
  url: string
  content: string
  score: number
  source: string
  published_date?: string
  thumbnail?: string
  channel?: string
  duration?: string
  views?: string
}
