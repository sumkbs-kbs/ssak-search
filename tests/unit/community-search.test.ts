/**
 * Unit tests for the Chinese/Japanese tech community backends (S16 — lever 3
 * remainder, zh/ja technical gold routing; S26 — CSDN).
 *
 * qiitaSearch (Qiita v2 API), juejinSearch (Juejin search API) and
 * csdnSearch (CSDN search API) surface the qiita.com / juejin.cn / csdn.net
 * gold domains that bing zh/ja tech queries never return (zh-tech-08/09/13
 * were all-wikipedia pools, NDCG 0.000). These tests cover the parsers and
 * the fetch path with a mocked fetchWithTimeout.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockFetchWithTimeout = vi.fn()
vi.mock('../../src/lib/util', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/util')>()
  return { ...actual, fetchWithTimeout: (...args: unknown[]) => mockFetchWithTimeout(...args) }
})

import {
  parseQiitaItems,
  qiitaSearch,
  parseJuejinSearch,
  juejinSearch,
  parseCsdnSearch,
  csdnSearch,
  resetQiitaQuota,
  resetCsdnQuota,
} from '../../src/lib/community-search'

const QIITA_ITEMS = [
  {
    title: 'React の useState を完全に理解する',
    url: 'https://qiita.com/example-user/items/abc123',
    user: { id: 'example-user' },
    tags: [{ name: 'React' }, { name: 'JavaScript' }],
    likes_count: 42,
    created_at: '2026-07-01T12:00:00Z',
  },
  {
    title: 'TypeScript の型パズル入門',
    url: 'https://qiita.com/ts-master/items/def456',
    user: { id: 'ts-master' },
    tags: [{ name: 'TypeScript' }],
    likes_count: 0,
    created_at: '2026-06-15T03:30:00Z',
  },
  {
    title: 'bad',
    url: 'https://qiita.com/x/items/y',
    user: { id: 'x' },
    tags: [],
    likes_count: 0,
  },
]

const JUEJIN_RESPONSE = {
  err_no: 0,
  data: [
    {
      result_model: {
        article_info: {
          title: 'React Hooks 完全指南',
          article_id: '7123456789012345678',
          brief_content: '从 useState 到 useReducer 的完整实践',
          link_url: '',
        },
        tags: [{ tag_name: 'React' }],
      },
    },
    {
      result_model: {
        article_info: {
          title: 'JavaScript 异步编程',
          article_id: '7000000000000000001',
          brief_content: '',
          link_url: 'https://juejin.cn/post/7000000000000000001',
        },
      },
    },
    {
      result_model: {
        article_info: {
          title: 'bad',
          article_id: '6999999999999999999',
          brief_content: '',
        },
      },
    },
  ],
}

/** CSDN /api/v3/search response — matches the live 2026-08-07 probe shape. */
const CSDN_RESPONSE = {
  result_vos: [
    {
      title: '25计算机<em>考研</em>408专业课<em>复习计划</em>',
      url: 'https://blog.csdn.net/weixin_55922953/article/details/135721100?ops_request_misc=elastic_search_misc&utm_term=%E8%80%83%E7%A0%94',
      articleid: 135721100,
      username: 'weixin_55922953',
      nickname: '考研小助手',
      digest: '本文整理25计算机<em>考研</em>408的<em>复习计划</em>安排',
      create_time_str: '2025-03-01',
    },
    {
      title: 'LangFlow<em>考研</em>专业课<em>复习计划</em>制定助手',
      url: 'https://blog.csdn.net/weixin_36019375/article/details/156171705?ops_request_misc=x',
      articleid: 156171705,
      username: 'weixin_36019375',
      digest: '',
    },
    {
      title: 'bad',
      url: 'https://blog.csdn.net/weixin_x/article/details/1',
      articleid: 1,
      username: 'weixin_x',
      digest: '',
    },
    {
      title: 'download 资源文件不应进入池子',
      url: 'https://download.csdn.net/download/abc/123456',
      articleid: 0,
      username: 'abc',
      digest: '',
    },
  ],
}

/** An external article Juejin aggregated — link_url points OFF-site. */
const JUEJIN_OFF_DOMAIN = {
  err_no: 0,
  data: [
    {
      result_model: {
        article_info: {
          title: '外部转载文章 深入理解闭包',
          article_id: '6888888888888888888',
          brief_content: '',
          link_url: 'https://segmentfault.com/a/123456',
        },
      },
    },
    {
      result_model: {
        article_info: {
          title: '带官方链接的文章 Vue3 源码解析',
          article_id: '6777777777777777777',
          brief_content: '',
          link_url: 'https://juejin.cn/post/6777777777777777777',
        },
      },
    },
  ],
}

describe('parseQiitaItems', () => {
  it('extracts qiita.com articles with gold domain and metadata', () => {
    const results = parseQiitaItems(QIITA_ITEMS, 'React useState', 5)
    expect(results.length).toBe(2)

    const first = results[0]
    expect(first.domain).toBe('qiita.com')
    expect(first.url).toBe('https://qiita.com/example-user/items/abc123')
    expect(first.title).toContain('useState')
    expect(first.content).toContain('example-user')
    expect(first.content).toContain('♥42')
    expect(first.content).toContain('React')
    expect(first.author).toBe('example-user')
    expect(first.published_date).toBe('2026-07-01T12:00:00Z')
  })

  it('skips items without a valid http(s) url or a too-short title', () => {
    const bad = [
      { url: 'javascript:void(0)', title: 'xss' },
      { url: 'https://qiita.com/a/items/b', title: ' ' },
    ]
    expect(parseQiitaItems(bad, 'q', 5)).toEqual([])
  })

  it('respects maxResults', () => {
    expect(parseQiitaItems(QIITA_ITEMS, 'q', 1).length).toBe(1)
  })

  it('returns empty for non-array data', () => {
    expect(parseQiitaItems(null, 'q', 5)).toEqual([])
    expect(parseQiitaItems({}, 'q', 5)).toEqual([])
  })
})

describe('parseJuejinSearch', () => {
  it('builds juejin.cn/post URLs when link_url is absent', () => {
    const results = parseJuejinSearch(JUEJIN_RESPONSE, 'React Hooks', 5)
    expect(results.length).toBe(2)

    const first = results[0]
    expect(first.domain).toBe('juejin.cn')
    expect(first.url).toBe('https://juejin.cn/post/7123456789012345678')
    expect(first.title).toContain('React Hooks')
    expect(first.content).toContain('useReducer')
  })

  it('prefers article_id → juejin.cn/post/<id> even when a canonical juejin link_url exists', () => {
    // Gold-domain rule: article_id always wins so the domain is guaranteed
    // juejin.cn (link_url is only a fallback when it is already juejin.cn).
    const results = parseJuejinSearch(JUEJIN_RESPONSE, 'q', 5)
    expect(results[1].url).toBe('https://juejin.cn/post/7000000000000000001')
    expect(results[1].domain).toBe('juejin.cn')
  })

  it('drops OFF-domain link_url entries (gold-domain rule — no foreign domains in the zh-tech pool)', () => {
    // Juejin aggregates external articles (segmentfault etc.). Those must NOT
    // pollute the pool — only the juejin.cn gold domain is kept.
    const results = parseJuejinSearch(JUEJIN_OFF_DOMAIN, 'q', 5)
    expect(results.length).toBe(2)
    expect(results[0].url).toBe('https://juejin.cn/post/6888888888888888888')
    expect(results[0].domain).toBe('juejin.cn')
    expect(results[1].domain).toBe('juejin.cn')
    // No result may carry the off-domain segmentfault.com URL
    expect(results.every((r) => r.domain === 'juejin.cn')).toBe(true)
  })

  it('skips entries with neither article_id nor a juejin.cn link_url', () => {
    const bare = {
      err_no: 0,
      data: [{ result_model: { article_info: { title: '无ID文章 内容足够长', link_url: 'https://example.com/x' } } }],
    }
    expect(parseJuejinSearch(bare, 'q', 5)).toEqual([])
  })

  it('skips items without a resolvable url or a too-short title', () => {
    expect(parseJuejinSearch(JUEJIN_RESPONSE, 'q', 5).length).toBe(2)
  })

  it('returns empty when data is missing/malformed', () => {
    expect(parseJuejinSearch({ err_no: 2, data: [] }, 'q', 5)).toEqual([])
    expect(parseJuejinSearch({}, 'q', 5)).toEqual([])
    expect(parseJuejinSearch(null, 'q', 5)).toEqual([])
  })
})

describe('parseCsdnSearch', () => {
  it('builds canonical blog.csdn.net URLs from articleid + username (tracking query stripped)', () => {
    const results = parseCsdnSearch(CSDN_RESPONSE, '考研复习计划', 5)
    expect(results.length).toBe(2)

    const first = results[0]
    expect(first.domain).toBe('blog.csdn.net')
    expect(first.url).toBe('https://blog.csdn.net/weixin_55922953/article/details/135721100')
    // <em> highlight tags stripped from title + digest
    expect(first.title).toBe('25计算机考研408专业课复习计划')
    expect(first.title).not.toContain('<em>')
    expect(first.content).not.toContain('<em>')
    expect(first.content).toContain('考研小助手')
    expect(first.author).toBe('考研小助手')
    expect(first.published_date).toBe('2025-03-01')
  })

  it('skips too-short titles and drops download.csdn.net hits (gold-domain rule)', () => {
    const results = parseCsdnSearch(CSDN_RESPONSE, 'q', 5)
    expect(results.length).toBe(2)
    expect(results.every((r) => r.domain === 'blog.csdn.net')).toBe(true)
  })

  it('falls back to the query-stripped transport URL when articleid is missing', () => {
    const bare = {
      result_vos: [
        {
          title: '没有 articleid 的文章标题内容足够长',
          url: 'https://blog.csdn.net/u1/article/details/99?utm_term=abc',
          username: 'u1',
          digest: '',
        },
      ],
    }
    const results = parseCsdnSearch(bare, 'q', 5)
    expect(results.length).toBe(1)
    expect(results[0].url).toBe('https://blog.csdn.net/u1/article/details/99')
  })

  it('accepts numeric-string articleids (robustness — API may serialize either way)', () => {
    const str = {
      result_vos: [
        {
          title: '字符串 articleid 的文章标题内容足够长',
          url: 'https://blog.csdn.net/u2/article/details/77?utm_term=x',
          articleid: '77',
          username: 'u2',
          digest: '',
        },
      ],
    }
    const results = parseCsdnSearch(str, 'q', 5)
    expect(results.length).toBe(1)
    expect(results[0].url).toBe('https://blog.csdn.net/u2/article/details/77')
  })

  it('returns empty when result_vos is missing/malformed', () => {
    expect(parseCsdnSearch({}, 'q', 5)).toEqual([])
    expect(parseCsdnSearch(null, 'q', 5)).toEqual([])
    expect(parseCsdnSearch({ result_vos: 'nope' }, 'q', 5)).toEqual([])
  })
})

describe('qiitaSearch / juejinSearch / csdnSearch — fetch path', () => {
  beforeEach(() => {
    mockFetchWithTimeout.mockReset()
  })

  it('fetches the Qiita v2 items endpoint with the query and parses results', async () => {
    mockFetchWithTimeout.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => QIITA_ITEMS,
    } as unknown as Response)

    const results = await qiitaSearch('React useState', { maxResults: 5, timeoutMs: 4000 })
    expect(results.length).toBe(2)
    const url = String(mockFetchWithTimeout.mock.calls[0][1])
    expect(url).toContain('qiita.com/api/v2/items')
    expect(url).toContain('query=')
    expect(url).toContain('per_page=5')
  })

  it('fetches the Juejin search endpoint with the query and parses results', async () => {
    mockFetchWithTimeout.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => JUEJIN_RESPONSE,
    } as unknown as Response)

    const results = await juejinSearch('React Hooks', { maxResults: 5, timeoutMs: 4000 })
    expect(results.length).toBe(2)
    const url = String(mockFetchWithTimeout.mock.calls[0][1])
    expect(url).toContain('api.juejin.cn/search_api/v1/search')
    expect(url).toContain('query=React')
  })

  it('returns empty on err_no !== 0 (routing/anti-bot error, live probe saw err_no:2)', async () => {
    mockFetchWithTimeout.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ err_no: 2, data: [] }),
    } as unknown as Response)
    expect(await juejinSearch('q', { maxResults: 5, timeoutMs: 4000 })).toEqual([])
  })

  it('fetches the CSDN search endpoint with the query and parses result_vos (S26)', async () => {
    mockFetchWithTimeout.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => CSDN_RESPONSE,
    } as unknown as Response)

    const results = await csdnSearch('考研复习计划', { maxResults: 5, timeoutMs: 4000 })
    expect(results.length).toBe(2)
    const url = String(mockFetchWithTimeout.mock.calls[0][1])
    expect(url).toContain('so.csdn.net/api/v3/search')
    expect(url).toContain('q=')
    expect(results[0].domain).toBe('blog.csdn.net')
  })

  it('csdnSearch returns empty on non-OK response and on fetch throw', async () => {
    mockFetchWithTimeout.mockResolvedValueOnce({ ok: false, status: 403 } as unknown as Response)
    expect(await csdnSearch('q', { maxResults: 5, timeoutMs: 4000 })).toEqual([])
    mockFetchWithTimeout.mockRejectedValueOnce(new Error('network down'))
    expect(await csdnSearch('q', { maxResults: 5, timeoutMs: 4000 })).toEqual([])
  })

  it('enforces the CSDN hourly soft-floor quota guard (review 2026-08-07)', async () => {
    resetCsdnQuota()
    mockFetchWithTimeout.mockReset()
    mockFetchWithTimeout.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => CSDN_RESPONSE,
    } as unknown as Response)

    // 250 = soft floor. All 250 calls fetch; the 251st short-circuits.
    for (let i = 0; i < 250; i += 1) {
      await csdnSearch('q', { maxResults: 2, timeoutMs: 1000 })
    }
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(250)
    await csdnSearch('q', { maxResults: 2, timeoutMs: 1000 })
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(250)

    // Window reset restores availability.
    resetCsdnQuota()
    await csdnSearch('q', { maxResults: 2, timeoutMs: 1000 })
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(251)
  })

  it('enforces the Qiita hourly soft-floor quota guard (skip once exhausted, window resets via hook)', async () => {
    resetQiitaQuota()
    mockFetchWithTimeout.mockReset()
    mockFetchWithTimeout.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => QIITA_ITEMS,
    } as unknown as Response)

    // 55 = soft floor. Call 55 times: all should fetch.
    for (let i = 0; i < 55; i += 1) {
      await qiitaSearch('q', { maxResults: 2, timeoutMs: 1000 })
    }
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(55)

    // The 56th call must short-circuit without fetching.
    await qiitaSearch('q', { maxResults: 2, timeoutMs: 1000 })
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(55)

    // Window reset restores availability.
    resetQiitaQuota()
    await qiitaSearch('q', { maxResults: 2, timeoutMs: 1000 })
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(56)
  })

  it('returns empty on non-OK response', async () => {
    mockFetchWithTimeout.mockResolvedValueOnce({ ok: false, status: 403 } as unknown as Response)
    expect(await qiitaSearch('q', { maxResults: 5, timeoutMs: 4000 })).toEqual([])
    mockFetchWithTimeout.mockResolvedValueOnce({ ok: false, status: 500 } as unknown as Response)
    expect(await juejinSearch('q', { maxResults: 5, timeoutMs: 4000 })).toEqual([])
  })

  it('returns empty when the fetch throws', async () => {
    mockFetchWithTimeout.mockRejectedValueOnce(new Error('network down'))
    expect(await qiitaSearch('q', { maxResults: 5, timeoutMs: 4000 })).toEqual([])
    mockFetchWithTimeout.mockRejectedValueOnce(new Error('network down'))
    expect(await juejinSearch('q', { maxResults: 5, timeoutMs: 4000 })).toEqual([])
  })
})
