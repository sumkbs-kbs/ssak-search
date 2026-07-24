/**
 * API Route: /api/upload — File Upload & Analysis
 *
 * POST /api/upload              — Upload a file (TXT/MD/PDF) to R2 + analyze
 * GET  /api/upload/:file_id     — Get file metadata
 * POST /api/upload/:file_id/analyze — Analyze an uploaded file
 *
 * Requirements:
 * - UPLOAD_BUCKET R2 binding (configure via Cloudflare Dashboard)
 * - AI Workers AI binding (optional, for summarization)
 */

import { Hono } from 'hono'
import { logger, toError } from '../lib/logger'
import { cors } from 'hono/cors'
import type {
  AppBindings,
  ErrorResponse,
  UploadResponse,
  AnalyzeRequest,
  AnalyzeResponse,
} from '../types'

interface FileRecord {
  file_id: string
  filename: string
  content_type: string
  file_size: number
  text_content: string
  summary?: string
  key_points?: string[]
  uploaded_at: number
}

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10MB
const ALLOWED_TYPES = ['text/plain', 'text/markdown', 'application/pdf', 'text/csv']
const ALLOWED_EXTENSIONS = ['.txt', '.md', '.pdf', '.csv']
// Allow octet-stream so browsers that send file/octet-stream for unknown types still work
const OCTET_STREAM = 'application/octet-stream'

const uploadRoute = new Hono<{ Bindings: AppBindings }>()
uploadRoute.use('/*', cors({ origin: '*' }))

// ============================================================
// Helpers
// ============================================================

function checkBinding(c: any): boolean {
  return !!c.env.UPLOAD_BUCKET
}

function generateFileId(): string {
  const ts = Date.now().toString(36)
  const rand = Math.random().toString(36).slice(2, 8)
  return `file_${ts}${rand}`
}

function getExtension(filename: string): string {
  const dot = filename.lastIndexOf('.')
  return dot >= 0 ? filename.slice(dot).toLowerCase() : ''
}

function isAllowedType(filename: string, mime: string): boolean {
  // Check MIME first
  if (ALLOWED_TYPES.includes(mime) || mime === OCTET_STREAM) return true
  // Fallback to extension check for octet-stream or unknown MIME
  const ext = getExtension(filename)
  return ALLOWED_EXTENSIONS.includes(ext)
}

async function extractTextFromFile(file: File, contentType: string): Promise<string> {
  const ext = getExtension(file.name)

  // For PDF, try to extract text content
  if (contentType === 'application/pdf' || ext === '.pdf') {
    // Read as ArrayBuffer and attempt basic text extraction
    // For robust PDF parsing, use a dedicated service; here we parse raw text
    const buf = await file.arrayBuffer()
    const bytes = new Uint8Array(buf)
    // Simple PDF text extraction: find text between parentheses in content stream
    const decoder = new TextDecoder('utf-8')
    const raw = decoder.decode(bytes)
    // Extract text between parentheses (PDF text objects)
    const texts: string[] = []
    const re = /\(([^)]*)\)/g
    let match: RegExpExecArray | null
    while ((match = re.exec(raw)) !== null) {
      const t = match[1]
      // Filter out binary garbage — keep printable ASCII + CJK
      if (/^[\x20-\x7E\uAC00-\uD7AF\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF0-9\s.,!?;:'"()\-]+$/.test(t) && t.length > 3) {
        texts.push(t)
      }
    }
    return texts.join(' ').slice(0, 50000)
  }

  // TXT, MD, CSV — read as text
  return await file.text()
}

async function analyzeContent(
  c: any,
  text: string,
  question?: string,
): Promise<{ summary: string; key_points: string[] }> {
  if (!c.env.AI) {
    // Fallback: extract first 200 chars as summary
    const summary = text.slice(0, 200) + (text.length > 200 ? '...' : '')
    const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 20).slice(0, 5)
    return {
      summary,
      key_points: sentences.map(s => s.trim()),
    }
  }

  const prompt = question
    ? `Based on the following document content, answer this question: ${question}\n\nDocument:\n${text.slice(0, 8000)}`
    : `Summarize the following document and list 3-5 key points. Return JSON with "summary" (string) and "key_points" (string array).

Document:
${text.slice(0, 8000)}`

  try {
    const result = await c.env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 1000,
    })

    let responseText = ''
    if (typeof result === 'object' && result !== null) {
      responseText = ('response' in result ? (result as { response: string }).response : null) || JSON.stringify(result)
    } else {
      responseText = String(result)
    }

    // Try to parse as JSON
    try {
      const parsed = JSON.parse(responseText)
      return {
        summary: parsed.summary || responseText.slice(0, 300),
        key_points: Array.isArray(parsed.key_points) ? parsed.key_points.slice(0, 10) : [],
      }
    } catch (err) {
      // Not JSON — use raw response as summary
      return {
        summary: responseText.slice(0, 500),
        key_points: [],
      }
    }
  } catch (err) {
    logger.error('AI analysis error:', { error: toError(err) })
    const summary = text.slice(0, 200) + (text.length > 200 ? '...' : '')
    return { summary, key_points: [] }
  }
}

// ============================================================
// POST /api/upload — Upload a file
// ============================================================
uploadRoute.post('/', async (c) => {
  if (!checkBinding(c)) {
    return c.json<ErrorResponse>(
      { detail: 'File upload requires UPLOAD_BUCKET R2 binding. Configure via Cloudflare Dashboard → Pages → ssak-search → Settings → Bindings → R2 → Add binding (name: UPLOAD_BUCKET).', code: 'binding_missing' },
      501,
    )
  }
  const bucket: R2Bucket = c.env.UPLOAD_BUCKET!

  let file: File | undefined
  try {
    const formData = await c.req.parseBody()
    // Try common field names
    file = formData['file'] as File || formData['upload'] as File
    if (!file || typeof file === 'string') {
      return c.json<ErrorResponse>({ detail: 'No file found in upload. Use form field name "file" with multipart/form-data.', code: 'no_file' }, 400)
    }
  } catch (err) {
    return c.json<ErrorResponse>({ detail: 'Failed to parse multipart form data', code: 'parse_error' }, 400)
  }

  // Validate file size
  if (file.size > MAX_FILE_SIZE) {
    return c.json<ErrorResponse>(
      { detail: `File too large. Maximum size: ${MAX_FILE_SIZE / 1024 / 1024}MB`, code: 'file_too_large' },
      413,
    )
  }

  // Validate file type
  const contentType = file.type || OCTET_STREAM
  if (!isAllowedType(file.name, contentType)) {
    return c.json<ErrorResponse>(
      { detail: `Unsupported file type: ${contentType || getExtension(file.name)}. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}`, code: 'unsupported_type' },
      415,
    )
  }

  const fileId = generateFileId()

  try {
    // Extract text content
    const text = await extractTextFromFile(file, contentType)

    // Run AI analysis
    const { summary, key_points } = await analyzeContent(c, text)

    // Store file in R2
    const buf = await file.arrayBuffer()
    await bucket.put(fileId, buf, {
      httpMetadata: { contentType },
      customMetadata: {
        filename: file.name,
        uploaded_at: String(Date.now()),
      },
    })

    // Store metadata alongside (using a companion key)
    const record: FileRecord = {
      file_id: fileId,
      filename: file.name,
      content_type: contentType,
      file_size: file.size,
      text_content: text.slice(0, 50000), // Store up to 50KB for analysis
      summary,
      key_points,
      uploaded_at: Date.now(),
    }

    await bucket.put(`meta_${fileId}`, JSON.stringify(record), {
      customMetadata: { type: 'metadata' },
    })

    const response: UploadResponse = {
      file_id: fileId,
      filename: file.name,
      content_type: contentType,
      file_size: file.size,
      summary,
      key_points,
      uploaded_at: record.uploaded_at,
    }

    return c.json(response, 201)
  } catch (err) {
    logger.error('Upload processing error:', { error: toError(err) })
    return c.json<ErrorResponse>(
      { detail: err instanceof Error ? err.message : 'Failed to process upload', code: 'upload_error' },
      500,
    )
  }
})

// ============================================================
// GET /api/upload/:file_id — Get file metadata + analysis
// ============================================================
uploadRoute.get('/:file_id', async (c) => {
  if (!checkBinding(c)) {
    return c.json<ErrorResponse>(
      { detail: 'Requires UPLOAD_BUCKET R2 binding', code: 'binding_missing' },
      501,
    )
  }
  const bucket: R2Bucket = c.env.UPLOAD_BUCKET!

  const { file_id } = c.req.param()

  try {
    const metaObj = await bucket.get(`meta_${file_id}`)
    if (!metaObj) {
      return c.json<ErrorResponse>({ detail: 'File not found', code: 'not_found' }, 404)
    }

    const record: FileRecord = JSON.parse(await metaObj.text())

    const response: UploadResponse = {
      file_id: record.file_id,
      filename: record.filename,
      content_type: record.content_type,
      file_size: record.file_size,
      summary: record.summary,
      key_points: record.key_points,
      uploaded_at: record.uploaded_at,
    }

    return c.json(response)
  } catch (err) {
    logger.error('Get file metadata error:', { error: toError(err) })
    return c.json<ErrorResponse>(
      { detail: 'Failed to get file metadata', code: 'get_error' },
      500,
    )
  }
})

// ============================================================
// POST /api/upload/:file_id/analyze — Analyze file with specific question
// ============================================================
uploadRoute.post('/:file_id/analyze', async (c) => {
  if (!checkBinding(c)) {
    return c.json<ErrorResponse>(
      { detail: 'Requires UPLOAD_BUCKET R2 binding', code: 'binding_missing' },
      501,
    )
  }
  const bucket: R2Bucket = c.env.UPLOAD_BUCKET!

  const { file_id } = c.req.param()

  let body: Partial<AnalyzeRequest>
  try {
    body = await c.req.json()
  } catch (err) {
    return c.json<ErrorResponse>({ detail: 'Invalid JSON body', code: 'invalid_body' }, 400)
  }

  try {
    const metaObj = await bucket.get(`meta_${file_id}`)
    if (!metaObj) {
      return c.json<ErrorResponse>({ detail: 'File not found', code: 'not_found' }, 404)
    }

    const record: FileRecord = JSON.parse(await metaObj.text())

    // Re-analyze with specific question
    const { summary, key_points } = await analyzeContent(c, record.text_content, body.question)

    const response: AnalyzeResponse = {
      file_id: record.file_id,
      filename: record.filename,
      answer: summary,
      key_points,
      word_count: record.text_content.split(/\s+/).length,
    }

    return c.json(response)
  } catch (err) {
    logger.error('Analyze file error:', { error: toError(err) })
    return c.json<ErrorResponse>(
      { detail: 'Failed to analyze file', code: 'analyze_error' },
      500,
    )
  }
})

export { uploadRoute }
