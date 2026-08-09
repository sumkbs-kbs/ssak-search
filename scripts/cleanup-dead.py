#!/usr/bin/env python3
"""Remove P18-audited dead code. Exact-string replacements, each verified.

Every entry is (path, [ (old, new), ... ]). After applying, we report any
entry that did NOT match so nothing is silently skipped.
"""
EDITS: dict[str, list[tuple[str, str]]] = {
    'src/lib/agentic/planner.ts': [
        ('    const lower = query.toLowerCase()\n', ''),
        ('    const isKorean = /[\\uAC00-\\uD7A3]/.test(query)\n', ''),
    ],
    'src/lib/canary/canary-orchestrator.ts': [
        ('    const regressions: string[] = []\n    const now = Date.now()\n', '    const regressions: string[] = []\n'),
    ],
    'src/lib/html-rewriter.ts': [
        ('  const { targetSelector, targetName, savedSignature, config, sourceUrl } = opts', '  const { targetSelector, savedSignature, config, sourceUrl } = opts'),
    ],
    'src/lib/index/pipeline.ts': [
        ('    const urlId = hashString(metadata.url)\n    await this.env.SEARCH_INDEX_DB.prepare(`', '    await this.env.SEARCH_INDEX_DB.prepare(`'),
        ('  const startTime = Date.now()\n\n  // ============================================================\n  // Step 1: Generate query embedding', '  // ============================================================\n  // Step 1: Generate query embedding'),
    ],
    'src/lib/index/scheduler.ts': [
        ('  async findCandidates(): Promise<RefreshCandidate[]> {\n    const now = Date.now()\n', '  async findCandidates(): Promise<RefreshCandidate[]> {\n'),
        ('      const frequencyDays = this.calculateFrequency(doc.importance)\n      const minIntervalMs = frequencyDays * 24 * 60 * 60 * 1000\n', '      const frequencyDays = this.calculateFrequency(doc.importance)\n'),
        ('    const id = `refresh_${documentId}_${Date.now()}`\n    const now = Date.now()\n', '    const id = `refresh_${documentId}_${Date.now()}`\n'),
        ('        const url = (doc as { url: string }).url\n\n        // This would trigger actual re-indexing\n        // In practice, you\'d push to the indexing queue\n', '        // This would trigger actual re-indexing\n        // In practice, you\'d push to the indexing queue\n'),
    ],
    'src/lib/jina-search.ts': [
        ('  // Each block starts with a URL line and has a Title: line\n  const blocks = text.split(/(?:^|\\n)(?:Title:|URL:)/i)\n\n  // Alternative: split by double newlines with URL markers\n', '  // Each block starts with a URL line and has a Title: line; we split by\n  // double-newline URL markers below.\n'),
    ],
    'src/lib/knowledge-panel.ts': [
        ('''/** Common entity indicators in titles (patterns that suggest a named entity) */
const ENTITY_PATTERNS = [
  // Company/organization indicators
  /\\b(?:Corp|Inc|Ltd|LLC|GmbH|Co\\.|Group|Holdings|Technologies|Systems|Enterprises|Ventures|Solutions|Industries|Labs)\\b/i,
  // Person indicators
  /\\b(?:Dr\\.|Prof\\.|CEO|Founder|President|Chairman|Author|Creator)\\b/i,
  // Product indicators
  /\\b(?:v\\d+\\.\\d+|Version|Edition|Platform|Framework|Library|Kit|SDK|API|Engine|Toolkit)\\b/i,
  // Technology indicators
  /\\b(?:Language|Protocol|Standard|Specification|Runtime|Compiler|Interpreter)\\b/i,
]

''', ''),
    ],
    'src/lib/rich-snippets.ts': [
        ('  const ogType = extractMetaContent(html, \'og:type\')\n  const ogTitle = extractMetaContent(html, \'og:title\')\n  const articleAuthor = extractMetaContent(html, \'article:author\')', '  const ogType = extractMetaContent(html, \'og:type\')\n  const articleAuthor = extractMetaContent(html, \'article:author\')'),
    ],
    'src/lib/specialized.ts': [
        ("import { fetchWithTimeout, extractDomain, stripHtml, decodeEntities, computeScore, truncateToTokens, simplifyQuery, timeRangeToDays } from './util'", "import { fetchWithTimeout, extractDomain, stripHtml, computeScore, truncateToTokens, simplifyQuery } from './util'"),
    ],
    'src/routes/chat.ts': [
        ('    // New thread\n    const { stub, id } = createThreadStub(c.env)\n    threadId = id', '    // New thread\n    const { id } = createThreadStub(c.env)\n    threadId = id'),
    ],
    'src/routes/monitor.ts': [
        ('  // Parse Prometheus metrics for additional data points\n  const promMetrics = getPrometheusMetrics()\n\n  // Get usage stats', '  // Get usage stats'),
    ],
    'src/routes/images.ts': [
        ('''// Bing image filter parameter mapping
const SIZE_MAP: Record<ImageSize, string> = {
  small: 'Small',
  medium: 'Medium',
  large: 'Large',
  wallpaper: 'Wallpaper',
  any: '',
}

const COLOR_MAP: Record<ImageColor, string> = {
  color: 'Color',
  monochrome: 'Monochrome',
  any: '',
}

const TYPE_MAP: Record<ImageType, string> = {
  photo: 'Photo',
  clipart: 'Clipart',
  animated: 'AnimatedGif',
  transparent: 'Transparent',
  any: '',
}

''', ''),
    ],
    'src/lib/retrieval/hybrid-search.ts': [
        ('import type { BM25Result } from \'../retrieval/bm25\'\n', ''),
        ('import type { DiversityResult } from \'../retrieval/diversity\'\n', ''),
    ],
    'src/pages/status.tsx': [
        ("import { logger } from '../lib/logger'\n", ''),
    ],
}


def main() -> None:
    for path, pairs in EDITS.items():
        try:
            src = open(path).read()
        except FileNotFoundError:
            print(f'!! {path}: MISSING')
            continue
        changed = 0
        for old, new in pairs:
            if old in src:
                src = src.replace(old, new, 1)
                changed += 1
            else:
                print(f'?? {path}: pattern NOT FOUND:\n    {old[:90]!r}')
        if changed:
            open(path, 'w').write(src)
        print(f'{path}: {changed}/{len(pairs)} edits applied')


if __name__ == '__main__':
    main()
