import { logger, toError } from './logger'
import { truncateToTokens } from './util'
import type { ExtractedContent } from '../types'
/**
 * YouTube Search + Transcript + Video Details Extraction (Phase 3.1b / v2)
 *
 * Searches YouTube for videos without an API key by scraping the search results page.
 * Fetches transcripts via the free youtubetranscript.com API.
 * Extracts rich video details (description, keywords, channel, stats) by parsing
 * the ytInitialPlayerResponse JSON embedded in the watch page.
 *
 * Functions:
 *   searchYouTube(query, maxResults)    → YouTubeVideo[]
 *   getTranscript(videoId)              → TranscriptSegment[]
 *   getVideoDetails(videoId)            → YouTubeVideoDetails (description/keywords/stats)
 *   extractYouTubeId(urlOrId)           → video ID from any YouTube URL form
 *   youtubeExtract(url, opts)           → ExtractedContent (description + transcript evidence)
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
  description?: string
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

/** Rich video metadata extracted from the watch page's ytInitialPlayerResponse. */
export interface YouTubeVideoDetails extends YouTubeVideo {
  description: string
  keywords: string[]
  length_seconds?: number
  view_count?: number
  like_count?: number
  publish_date?: string
  channel_id?: string
  transcript?: TranscriptSegment[]
  transcript_text?: string
  /** Caption tracks advertised in ytInitialPlayerResponse (fallback transcript source) */
  caption_tracks?: CaptionTrack[]
}

/** A caption track entry from ytInitialPlayerResponse.captions. */
export interface CaptionTrack {
  baseUrl: string
  languageCode: string
  name?: string
  kind?: string
}

const YT_SEARCH = 'https://www.youtube.com/results?search_query='
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

// ============================================================
// URL → video ID extraction
// ============================================================

/**
 * Extract a YouTube video ID from any common URL form (or a bare ID).
 *
 * Supported forms:
 *   - https://www.youtube.com/watch?v=VIDEO_ID&feature=...
 *   - https://youtu.be/VIDEO_ID
 *   - https://www.youtube.com/shorts/VIDEO_ID
 *   - https://www.youtube.com/embed/VIDEO_ID
 *   - https://m.youtube.com/watch?v=VIDEO_ID
 *   - https://www.youtube.com/live/VIDEO_ID
 *   - bare 11-char ID
 *
 * Returns null when the input doesn't resolve to a video ID.
 */
export function extractYouTubeId(input: string): string | null {
  if (!input || typeof input !== 'string') return null
  const raw = input.trim()
  if (!raw) return null

  // Bare ID — 11 chars of [A-Za-z0-9_-] (this is also the length of every
  // canonical video ID, so a bare 11-char token is almost certainly an ID).
  const bareId = raw.match(/^[A-Za-z0-9_-]{11}$/)
  if (bareId) return bareId[0]

  try {
    const url = new URL(raw.startsWith('http') ? raw : `https://${raw}`)
    const host = url.hostname.toLowerCase()
    const knownHost =
      host === 'youtu.be' ||
      host === 'www.youtube.com' ||
      host === 'm.youtube.com' ||
      host === 'youtube.com' ||
      host === 'music.youtube.com' ||
      host.endsWith('.youtube.com')

    // youtube.com/watch?v=ID (host-validated — a v param on a random site
    // is not a YouTube video)
    const v = url.searchParams.get('v')
    if (v && /^[A-Za-z0-9_-]{11}$/.test(v) && knownHost) return v

    // youtu.be/ID, youtube.com/shorts/ID, /embed/ID, /live/ID, /v/ID
    const pathSegments = url.pathname.split('/').filter(Boolean)
    const lastSegment = pathSegments[pathSegments.length - 1] ?? ''
    if (knownHost && /^[A-Za-z0-9_-]{11}$/.test(lastSegment)) return lastSegment

    // youtube.com/v/ID (legacy embed path)
    if (knownHost && pathSegments[0] === 'v' && /^[A-Za-z0-9_-]{11}$/.test(pathSegments[1] ?? '')) {
      return pathSegments[1]
    }
  } catch {
    // Not a valid URL — fall through
  }

  return null
}

// ============================================================
// YouTube Search
// ============================================================

/**
 * Search YouTube for videos matching a query.
 * Parses the initial YT initial data from the search page HTML.
 */
export async function searchYouTube(query: string, maxResults = 10, signal?: AbortSignal): Promise<YouTubeVideo[]> {
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

/**
 * Parse video search results from the ytInitialData JSON blob.
 * EXPORTED FOR TESTING — parser regression detection
 */
export function parseVideoData(jsonStr: string, maxResults: number): YouTubeVideo[] {
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

        // Description snippet — videoRenderer.detailedMetadataSnippets → runs[].text
        // (YouTube search result cards show a 1-2 line description under the title).
        let description = ''
        const snippets = renderer?.detailedMetadataSnippets
        if (Array.isArray(snippets)) {
          const parts: string[] = []
          for (const s of snippets) {
            const runs = s?.snippetText?.runs
            if (Array.isArray(runs)) {
              for (const run of runs) {
                if (run?.text) parts.push(run.text)
              }
            }
          }
          description = parts.join(' ').trim()
        }
        if (!description && renderer?.descriptionSnippet?.runs) {
          description = renderer.descriptionSnippet.runs
            .map((r: { text?: string }) => r.text ?? '')
            .join(' ')
            .trim()
        }

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
          ...(description ? { description } : {}),
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
  return segments.map((s) => `[${formatTimestamp(s.start)}] ${s.text}`).join('\n')
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
    const segments: Array<{ text: string; start: number; dur: number }> = Array.isArray(data)
      ? (data as Array<{ text: string; start: number; dur: number }>)
      : (raw.segments ?? [])

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
    const resp = await fetch(`https://youtubetranscript.com/api?vid=${encodeURIComponent(videoId)}`, {
      headers: { 'User-Agent': USER_AGENT },
      cf: { cacheTtl: 3600, cacheEverything: true },
    })
    if (!resp.ok) return []
    const data: unknown = await resp.json()
    const raw = data as { langs?: string[] }
    return raw.langs ?? []
  } catch (err) {
    logger.warn(`Transcript language fetch failed for ${videoId}:`, { error: toError(err) })
    return []
  }
}

/**
 * Fetch a video transcript directly from YouTube's timedtext caption endpoint
 * (baseUrl from ytInitialPlayerResponse.captions). Used as the primary-free
 * fallback when youtubetranscript.com is down or returns empty — which has
 * been the norm recently, so this is effectively the main transcript path.
 *
 * Parses both the JSON3 (fmt=json3) and legacy XML caption payloads.
 */
export async function getTranscriptFromTimedtext(
  baseUrl: string,
  opts: { signal?: AbortSignal } = {},
): Promise<TranscriptSegment[]> {
  try {
    const u = new URL(baseUrl)
    u.searchParams.set('fmt', 'json3')
    const resp = await fetch(u.toString(), {
      headers: { 'User-Agent': USER_AGENT },
      signal: opts.signal,
      cf: { cacheTtl: 3600, cacheEverything: true },
    })
    if (!resp.ok) {
      logger.warn(`Timedtext fetch failed: HTTP ${resp.status}`)
      return []
    }

    const raw = await resp.text()

    // Path A: JSON3 (fmt=json3). YouTube sometimes labels the response as
    // text/html even when the body is JSON, so don't trust content-type —
    // try JSON.parse first and only fall back to XML when that fails.
    try {
      const data: unknown = JSON.parse(raw)
      const events =
        (data as { events?: Array<{ tStartMs?: number; dDurationMs?: number; segs?: Array<{ utf8?: string }> }> })
          ?.events ?? []
      const segs: TranscriptSegment[] = []
      for (const ev of events) {
        if (!Array.isArray(ev?.segs)) continue
        const text = ev.segs
          .map((s) => s?.utf8 ?? '')
          .join('')
          .replace(/\s+/g, ' ')
          .trim()
        if (!text) continue
        segs.push({
          text,
          start: (ev.tStartMs ?? 0) / 1000,
          duration: (ev.dDurationMs ?? 0) / 1000,
        })
      }
      if (segs.length > 0) return segs
    } catch {
      // Not JSON — fall through to the legacy XML parser
    }

    // Path B: legacy XML: <text start="..." dur="...">...</text>
    const segs: TranscriptSegment[] = []
    const re = /<text start="([\d.]+)" dur="([\d.]+)">([\s\S]*?)<\/text>/g
    let m: RegExpExecArray | null
    while ((m = re.exec(raw))) {
      const text = m[3]
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/\s+/g, ' ')
        .trim()
      if (!text) continue
      segs.push({
        text,
        start: parseFloat(m[1]) || 0,
        duration: parseFloat(m[2]) || 0,
      })
    }
    return segs
  } catch (err) {
    logger.warn('Timedtext transcript fetch failed:', { error: toError(err) })
    return []
  }
}

/**
 * Search YouTube and fetch transcripts for each result.
 */
export async function searchWithTranscripts(query: string, maxResults = 5): Promise<YouTubeVideoWithTranscript[]> {
  const videos = await searchYouTube(query, maxResults)

  const withTranscripts: YouTubeVideoWithTranscript[] = []
  for (const video of videos) {
    const transcript = await getTranscript(video.id)
    const transcriptText = transcript
      .map((s) => s.text)
      .join(' ')
      .slice(0, 10000)
    withTranscripts.push({ ...video, transcript, transcript_text: transcriptText })
  }

  return withTranscripts
}

// ============================================================
// Rich Video Details Extraction (watch page ytInitialPlayerResponse)
// ============================================================

/**
 * Parse the ytInitialPlayerResponse JSON embedded in a YouTube watch page into
 * rich video details. Exported separately from getVideoDetails so the parser
 * can be unit-tested without network access.
 *
 * EXTRACTED FIELDS:
 *   - videoDetails.title / shortDescription / lengthSeconds / keywords /
 *     channelId / viewCount / author
 *   - microformat.playerMicroformatRenderer.publishDate / uploadDate / likeCount
 */
export function parsePlayerResponse(jsonStr: string): YouTubeVideoDetails | null {
  try {
    const data = JSON.parse(jsonStr)
    const vd = data?.videoDetails
    if (!vd?.videoId || !vd?.title) return null

    const mf = data?.microformat?.playerMicroformatRenderer
    const channelId = vd.channelId || mf?.channelId || ''
    const channel = vd.author || mf?.ownerChannelName || ''

    // Caption tracks — the reliable free transcript source. The third-party
    // youtubetranscript.com API is frequently down/empty, so we parse the same
    // ytInitialPlayerResponse JSON we already have and fetch the timedtext
    // caption stream directly when a transcript is requested.
    const captionTracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks
    const parsedTracks: CaptionTrack[] = Array.isArray(captionTracks)
      ? captionTracks
          .map((t: Record<string, unknown>): CaptionTrack | null => {
            const baseUrl = typeof t.baseUrl === 'string' ? t.baseUrl : ''
            if (!baseUrl) return null
            const name =
              t.name && typeof t.name === 'object' ? (t.name as { simpleText?: string }).simpleText : undefined
            return {
              baseUrl,
              languageCode: typeof t.languageCode === 'string' ? t.languageCode : '',
              name,
              kind: typeof t.kind === 'string' ? t.kind : undefined,
            }
          })
          .filter((t): t is CaptionTrack => t !== null)
      : []

    const details: YouTubeVideoDetails = {
      id: vd.videoId,
      title: (vd.title || '').trim(),
      url: `https://youtube.com/watch?v=${vd.videoId}`,
      channel: (channel || '').trim(),
      channel_url: channelId ? `https://youtube.com/channel/${channelId}` : undefined,
      thumbnail: mf?.thumbnail?.thumbnails?.[mf.thumbnail.thumbnails.length - 1]?.url || '',
      description: (vd.shortDescription || '').trim(),
      keywords: Array.isArray(vd.keywords) ? vd.keywords.slice(0, 50) : [],
      length_seconds: vd.lengthSeconds ? Number(vd.lengthSeconds) : undefined,
      view_count: vd.viewCount ? Number(vd.viewCount) : undefined,
      like_count: mf?.likeCount ? Number(mf.likeCount) : undefined,
      publish_date: mf?.publishDate || mf?.uploadDate || undefined,
      channel_id: channelId || undefined,
      caption_tracks: parsedTracks.length > 0 ? parsedTracks : undefined,
    }

    // Human-readable duration + views for API parity with search results.
    if (details.length_seconds) details.duration = formatDuration(details.length_seconds)
    if (details.view_count) details.views = details.view_count.toLocaleString()
    if (details.publish_date) {
      details.published = new Date(details.publish_date).toISOString().slice(0, 10)
    }

    return details
  } catch (err) {
    logger.warn('YouTube player response parsing failed:', { error: toError(err) })
    return null
  }
}

function formatDuration(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  const s = totalSeconds % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

/**
 * Fetch rich details for a video by fetching the watch page and parsing the
 * embedded ytInitialPlayerResponse JSON. Optionally attaches the transcript.
 *
 * @param videoId 11-char video ID (or a full URL — auto-extracted)
 * @param options.signal AbortSignal
 * @param options.lang Preferred transcript language
 * @param options.includeTranscript Whether to attach transcript segments
 */
/**
 * Resolve a video's transcript as best-effort evidence. Tries the caption
 * tracks from the watch page (first-party timedtext) first, then the
 * youtubetranscript.com API, then returns [] — a missing transcript must
 * never fail the extraction, because the description + metadata block is
 * still valuable evidence on its own.
 *
 * NOTE: YouTube increasingly gates transcripts behind a client-generated
 * `pot` token for anonymous datacenter IPs, so both paths can return empty
 * for some videos/networks. This is expected — the caller degrades to
 * description-only evidence rather than erroring.
 */
async function fetchTranscriptForVideo(
  details: YouTubeVideoDetails,
  options: { lang?: string; signal?: AbortSignal } = {},
): Promise<TranscriptSegment[]> {
  // Path 1: caption tracks parsed from the same ytInitialPlayerResponse JSON.
  const tracks = details.caption_tracks
  if (tracks && tracks.length > 0) {
    let track = tracks[0]
    if (options.lang) {
      const preferred = tracks.find((t) => t.languageCode === options.lang)
      if (preferred) track = preferred
    }
    try {
      const viaTimedtext = await getTranscriptFromTimedtext(track.baseUrl, { signal: options.signal })
      if (viaTimedtext.length > 0) return viaTimedtext
    } catch {
      // Fall through to the API path
    }
  }

  // Path 2: youtubetranscript.com API (third-party, occasionally restored).
  try {
    const viaApi = await getTranscript(details.id, { lang: options.lang, signal: options.signal })
    if (viaApi.length > 0) return viaApi
  } catch {
    // No transcript available
  }

  return []
}

// ============================================================
// Evidence extraction for the research/chat pipeline
// ============================================================

/**
 * True when the input resolves to a YouTube video ID (any common link form
 * or a bare 11-char ID). Used by the extractor to route YouTube URLs to the
 * video-specific extraction path instead of generic readers (Jina/HTMLRewriter
 * return shell HTML / consent walls for YouTube watch pages).
 */
export function isYouTubeUrl(input: string): boolean {
  return extractYouTubeId(input) !== null
}

/**
 * Format rich video details into a self-contained evidence block for LLM
 * consumption in the research/chat pipeline. Combines metadata (title,
 * channel, publish date, views, duration), keywords, the full description,
 * and the transcript (when available) into a single text blob, truncated to
 * maxTokens. Exported separately from youtubeExtract so it can be unit-tested
 * without network access.
 */
export function buildYouTubeEvidenceText(
  details: YouTubeVideoDetails,
  opts: { maxTokens?: number; includeTimestamps?: boolean } = {},
): string {
  const { maxTokens = 4000, includeTimestamps = false } = opts
  const parts: string[] = []

  parts.push(`Title: ${details.title}`)

  const meta: string[] = []
  if (details.channel) meta.push(`Channel: ${details.channel}`)
  if (details.published || details.publish_date) meta.push(`Published: ${details.published || details.publish_date}`)
  if (details.views) meta.push(`Views: ${details.views}`)
  if (details.duration) meta.push(`Duration: ${details.duration}`)
  if (meta.length > 0) parts.push(meta.join(' | '))

  if (details.description) {
    parts.push(`Description:\n${details.description}`)
  }
  if (details.keywords && details.keywords.length > 0) {
    parts.push(`Keywords: ${details.keywords.join(', ')}`)
  }

  const segments = details.transcript ?? []
  let transcriptText = ''
  if (includeTimestamps && segments.length > 0) {
    transcriptText = formatTranscriptWithTimestamps(segments)
  } else if (details.transcript_text) {
    transcriptText = details.transcript_text
  } else if (segments.length > 0) {
    transcriptText = segments.map((s) => s.text).join(' ')
  }
  if (transcriptText.trim()) {
    parts.push(`Transcript:\n${transcriptText.trim()}`)
  }

  return truncateToTokens(parts.join('\n\n'), maxTokens)
}

/**
 * Extract a YouTube video's description + transcript as evidence content,
 * shaped exactly like extractor.ts's ExtractedContent so YouTube URLs can be
 * handled as a first-class strategy in the content extraction pipeline.
 *
 * This is what makes research/chat evidence work for YouTube links: the
 * orchestrator's include_raw_content path extracts every result via
 * extractContent(), and generic readers (Jina / HTMLRewriter / sidecar)
 * cannot render YouTube watch pages — they return shell HTML or consent
 * walls. This path parses ytInitialPlayerResponse for the description and
 * pulls the transcript, so the LLM synthesis gets real video content.
 *
 * @param url A YouTube watch/shorts/youtu.be URL
 * @param opts.maxTokens Cap on the returned evidence text (default 4000)
 * @param opts.timeoutMs Combined timeout for watch-page + transcript fetches
 * @param opts.lang Preferred transcript language
 */
export async function youtubeExtract(
  url: string,
  opts: { maxTokens?: number; timeoutMs?: number; lang?: string } = {},
): Promise<ExtractedContent> {
  const { maxTokens = 4000, timeoutMs = 15000, lang } = opts
  const id = extractYouTubeId(url)
  if (!id) {
    return { url, raw_content: '', success: false, error: 'Not a YouTube URL' }
  }

  // Single AbortController spanning both fetches (watch page + transcript).
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const details = await getVideoDetails(url, {
      signal: controller.signal,
      lang,
      includeTranscript: true,
    })
    if (!details) {
      return {
        url,
        raw_content: '',
        success: false,
        error: 'YouTube details could not be extracted (blocked or layout changed)',
      }
    }
    const content = buildYouTubeEvidenceText(details, { maxTokens })
    if (!content.trim()) {
      return { url, raw_content: '', success: false, error: 'No content could be extracted' }
    }
    return { url, title: details.title, raw_content: content, success: true }
  } catch (err) {
    return { url, raw_content: '', success: false, error: toError(err) }
  } finally {
    clearTimeout(timer)
  }
}

export async function getVideoDetails(
  videoIdOrUrl: string,
  options: { signal?: AbortSignal; lang?: string; includeTranscript?: boolean } = {},
): Promise<YouTubeVideoDetails | null> {
  const id = extractYouTubeId(videoIdOrUrl)
  if (!id) {
    logger.warn(`getVideoDetails: could not extract video ID from "${videoIdOrUrl}"`)
    return null
  }

  const url = `https://www.youtube.com/watch?v=${id}`

  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en-US,en;q=0.9' },
      signal: options.signal,
      cf: { cacheTtl: 3600, cacheEverything: true },
    })

    if (!resp.ok) {
      logger.warn(`YouTube watch page fetch failed for ${id}: HTTP ${resp.status}`)
      return null
    }

    const html = await resp.text()

    // ytInitialPlayerResponse = {...};  — embedded JSON in the watch page.
    const match =
      html.match(/var ytInitialPlayerResponse\s*=\s*({.+?});\s*(?:<\/script>|var\s)/) ||
      html.match(/window\[['"]ytInitialPlayerResponse['"]\]\s*=\s*({.+?});/) ||
      html.match(/ytInitialPlayerResponse\s*=\s*({.+?});/)
    if (!match) {
      logger.warn(`ytInitialPlayerResponse not found for ${id} (page layout changed or consent wall)`)
      return null
    }

    const details = parsePlayerResponse(match[1])
    if (!details) return null

    if (options.includeTranscript) {
      details.transcript = await fetchTranscriptForVideo(details, { lang: options.lang, signal: options.signal })
      details.transcript_text = details.transcript
        .map((s) => s.text)
        .join(' ')
        .slice(0, 10000)
    }

    return details
  } catch (err) {
    logger.warn(`YouTube video details fetch failed for ${id}:`, { error: toError(err) })
    return null
  }
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

    if (video.description) {
      content += `\n\nDescription: ${video.description}`
    }

    if (includeTranscripts) {
      const transcript = await getTranscript(video.id)
      if (transcript.length > 0) {
        const transcriptText = transcript
          .map((s) => s.text)
          .join(' ')
          .slice(0, 2000)
        content += `\n\nTranscript excerpt:\n${transcriptText}`
      }
    }

    results.push({
      title: video.title,
      url: video.url,
      content,
      score: 0.8,
      source: 'youtube',
      domain: 'youtube.com',
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
  domain: string
  published_date?: string
  thumbnail?: string
  channel?: string
  duration?: string
  views?: string
}
