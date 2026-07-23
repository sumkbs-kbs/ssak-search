/**
 * Video Search API — YouTube + Subtitles (Phase 3.1b / Phase 6)
 *
 * Endpoints:
 *   GET  /api/video         — List available video sources
 *   GET  /api/video/search  — Search YouTube with optional transcript (GET)
 *   POST /api/video/search  — Search YouTube with optional transcript (POST)
 *   GET  /api/video/transcript — Get transcript for a specific video by id
 */
import { Hono } from 'hono'
import { logger, toError } from '../lib/logger'
import { z } from 'zod'
import type { AppBindings, ErrorResponse } from '../types'
import { searchYouTube, getTranscript, formatTranscriptWithTimestamps } from '../lib/youtube-search'

// ============================================================
// Schema
// ============================================================

const VideoSearchQuery = z.object({
  query: z.string().min(1).max(500),
  max_results: z.coerce.number().int().min(1).max(20).default(10),
  include_transcripts: z.coerce.boolean().default(false),
  lang: z.string().optional(),
})

const TranscriptQuery = z.object({
  video_id: z.string().min(1),
  format: z.enum(['json', 'text', 'srt']).default('json'),
  lang: z.string().optional(),
})

// ============================================================
// Route
// ============================================================

const video = new Hono<{ Bindings: AppBindings }>()

/**
 * GET / — List available video sources
 */
video.get('/', (c) => {
  return c.json({
    success: true,
    sources: [
      {
        id: 'youtube',
        name: 'YouTube',
        description: 'Search YouTube videos and fetch subtitles with timestamps',
        endpoints: {
          search: 'GET/POST /api/video/search',
          transcript: 'GET /api/video/transcript?video_id=...&format=json|text|srt',
        },
      },
    ],
  })
})

/**
 * GET /search — Search YouTube with query params
 */
video.get('/search', async (c) => {
  try {
    const params = VideoSearchQuery.parse({
      query: c.req.query('query') || c.req.query('q'),
      max_results: c.req.query('max_results'),
      include_transcripts: c.req.query('include_transcripts') || c.req.query('transcript'),
      lang: c.req.query('lang'),
    })
    const { query, max_results, include_transcripts, lang } = params

    const results = await searchYouTube(query, max_results)

    let videoResults = results
    if (include_transcripts) {
      videoResults = await Promise.all(
        results.map(async (video) => {
          const transcript = await getTranscript(video.id, { lang })
          return { ...video, transcript }
        }),
      )
    }

    return c.json({ success: true, source: 'youtube', query, results: videoResults })
  } catch (err) {
    if (err instanceof z.ZodError) {
      return c.json<ErrorResponse>({ detail: 'Validation error', code: 'validation_error' }, 400)
    }
    logger.error('Video search error:', { error: toError(err) })
    return c.json<ErrorResponse>({ detail: 'Video search failed', code: 'internal_error' }, 500)
  }
})

/**
 * POST /search — Search YouTube with optional transcript extraction
 */
video.post('/search', async (c) => {
  try {
    const body = VideoSearchQuery.parse(await c.req.json())
    const { query, max_results, include_transcripts, lang } = body

    const results = await searchYouTube(query, max_results)

    let videoResults = results
    if (include_transcripts) {
      videoResults = await Promise.all(
        results.map(async (video) => {
          const transcript = await getTranscript(video.id, { lang })
          return { ...video, transcript }
        }),
      )
    }

    return c.json({ success: true, source: 'youtube', query, results: videoResults })
  } catch (err) {
    if (err instanceof z.ZodError) {
      return c.json<ErrorResponse>({ detail: 'Validation error', code: 'validation_error' }, 400)
    }
    logger.error('Video search error:', { error: toError(err) })
    return c.json<ErrorResponse>({ detail: 'Video search failed', code: 'internal_error' }, 500)
  }
})

/**
 * GET /transcript — Fetch transcript for a specific video
 * Supports format=json (default), format=text (with timestamps), format=srt
 */
video.get('/transcript', async (c) => {
  try {
    const { video_id, format, lang } = TranscriptQuery.parse({
      video_id: c.req.query('video_id'),
      format: c.req.query('format'),
      lang: c.req.query('lang'),
    })

    const transcript = await getTranscript(video_id, { lang })

    if (format === 'text') {
      const fullText = formatTranscriptWithTimestamps(transcript)
      return c.json({ success: true, video_id, transcript_text: fullText, segment_count: transcript.length })
    }

    if (format === 'srt') {
      const { formatTranscriptSrt } = await import('../lib/youtube-search')
      const srt = formatTranscriptSrt(transcript)
      return c.newResponse(srt, {
        status: 200,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="${video_id}.srt"` },
      })
    }

    const fullText = transcript.map((s) => s.text).join(' ')
    return c.json({ success: true, video_id, transcript, transcript_text: fullText, segment_count: transcript.length })
  } catch (err) {
    if (err instanceof z.ZodError) {
      return c.json<ErrorResponse>({ detail: 'Invalid video_id parameter', code: 'validation_error' }, 400)
    }
    logger.error('Transcript fetch error:', { error: toError(err) })
    return c.json<ErrorResponse>({ detail: 'Transcript fetch failed', code: 'internal_error' }, 500)
  }
})

export { video as videoRoute }
