#!/usr/bin/env python3
"""Remove P18-audited dead code from test files (exact-string, verified)."""
EDITS: dict[str, list[tuple[str, str]]] = {
    'tests/integration/executeSearch.test.ts': [
        ('''const NAVER_HTML = `
<!DOCTYPE html>
<html><body>
  <ul class="lst_total">
    <li>
      <div class="total_tit"><a href="https://naver-result.com/1">네이버 결과 1</a></div>
      <div class="api_txt_lines dsc">네이버 검색 결과 요약입니다.</div>
    </li>
  </ul>
</body></html>
`

''', ''),
        ('''const GITHUB_HTML = `
<!DOCTYPE html>
<html><body>
  <div class="repo-list">
    <div class="repo-list-item">
      <h3><a href="/user/repo1">user/repo1</a></h3>
      <p>Description of repo 1</p>
    </div>
  </div>
</body></html>
`

''', ''),
        ('''const HN_HTML = `
<!DOCTYPE html>
<html><body>
  <table class="itemlist">
    <tr class="athing">
      <td class="title"><span class="rank">1.</span><a href="https://news.ycombinator.com/item?id=1">HN Story 1</a></td>
    </tr>
  </table>
</body></html>
`

''', ''),
        ('''const REDDIT_HTML = `
<!DOCTYPE html>
<html><body>
  <div class="Post">
    <h3><a href="https://reddit.com/r/test/comments/1">Reddit Post 1</a></h3>
    <div class="post-content">Content of post 1</div>
  </div>
</body></html>
`

''', ''),
        ('''const ARXIV_XML = `
<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>arXiv Paper 1: Quantum Computing Advances</title>
    <summary>Abstract of paper 1 about quantum computing...</summary>
    <link href="https://arxiv.org/abs/1234.5678" />
    <published>2024-01-15T00:00:00Z</published>
  </entry>
</feed>
`

''', ''),
        ('  it(\'handles Chinese query with Bing mkt=zh-CN\', async () => {\n    const bingCalledWithZhCN = false\n    \n', '  it(\'handles Chinese query with Bing mkt=zh-CN\', async () => {\n'),
        ('  it(\'handles backend failures gracefully\', async () => {\n    const bingCalls = 0\n    ', '  it(\'handles backend failures gracefully\', async () => {\n    '),
        ('  fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {', '  fetchMock = vi.fn(async (url: string | URL, _init?: RequestInit) => {'),
    ],
    'tests/integration/orchestrator.test.ts': [
        ('(url: string | URL, init?: RequestInit) =>', '(url: string | URL, _init?: RequestInit) =>'),
    ],
    'tests/unit/routes.test.ts': [
        ('    const body1 = await res1.json()\n\n        // Second call should use the cache (cached: true)', '    // Second call should use the cache (cached: true)'),
    ],
    'tests/unit/snapshots.test.ts': [
        ('// Mock env for fetchWithTimeout\nconst mockEnv: Env = {}\n\n', ''),
        ('''      const response = await readSnapshot('wikipedia-search.json')
      const mockFetch = async (url: string) => {
        return {
          ok: true,
          json: async () => JSON.parse(response),
        } as Response
      }
      ''', '''      const response = await readSnapshot('wikipedia-search.json')
      ''',),
    ],
    'tests/unit/llm-router.test.ts': [
        ("import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'", "import { describe, it, expect, vi, afterEach } from 'vitest'"),
    ],
    'tests/unit/naver-search.test.ts': [
        ("import { describe, it, expect, vi, beforeEach } from 'vitest'", "import { describe, it, expect, vi } from 'vitest'"),
    ],
    'tests/unit/util.test.ts': [
        ('import {\n  assertSafeFetchUrl, isPublicHostname, normalizeUrl, extractDomain,\n  domainMatches, truncateToTokens, parseDate, timeRangeToDays, simplifyQuery,\n  countryToBingMkt, countryToLanguageTag, computeScore, generateRelatedQueries,\n  stripHtml, decodeEntities, getDomainAuthority,\n} from \'../../src/lib/util\'', 'import {\n  assertSafeFetchUrl, isPublicHostname, normalizeUrl,\n  simplifyQuery, computeScore, generateRelatedQueries,\n  getDomainAuthority,\n} from \'../../src/lib/util\''),
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
                print(f'?? {path}: pattern NOT FOUND:\n    {old[:100]!r}')
        if changed:
            open(path, 'w').write(src)
        print(f'{path}: {changed}/{len(pairs)} edits applied')


if __name__ == '__main__':
    main()
