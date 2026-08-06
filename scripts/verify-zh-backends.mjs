// zh-general-04 결과 풍족도 상세 검증
import { executeSearch } from '../src/lib/search/strategies/all.js'

// tsx로 실행
const q = '西安旅游攻略'
const ctx = {
  query: q,
  chinese: true,
  general: true,
  useWikipedia: true,
  config: {
    DDG_SEARCH_URL: 'https://html.duckduckgo.com/html/',
  },
}
