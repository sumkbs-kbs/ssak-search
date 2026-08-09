/**
 * Translation Strings — i18n 지원 (Phase 2.2)
 *
 * 구조: 카테고리.키 = 문자열
 * 지원 언어: 한국어(ko), 영어(en), 일본어(ja), 중국어 간체(zh-CN)
 *
 * 템플릿 변수: {{variable}} 형태로 사용
 */

export type TranslationKey =
  | 'common.search'
  | 'common.loading'
  | 'common.error'
  | 'common.no_results'
  | 'common.view_all'
  | 'common.close'
  | 'common.copy'
  | 'common.copied'
  | 'common.filter'
  | 'common.sort'
  | 'common.more'
  | 'common.less'
  | 'common.seconds'
  | 'common.results'
  | 'common.sources'
  | 'common.backend'
  | 'common.fallback'
  | 'common.page'
  | 'common.of'
  | 'common.related'
  | 'common.keyboard_hint'
  // Navigation
  | 'nav.search'
  | 'nav.chat'
  | 'nav.docs'
  | 'nav.health'
  // Search
  | 'search.placeholder'
  | 'search.button'
  | 'search.ai_answer'
  | 'search.full_content'
  | 'search.deep_research'
  | 'search.show_content'
  | 'search.hide_content'
  | 'search.empty_title'
  | 'search.empty_desc'
  | 'search.answer_title'
  | 'search.research_title'
  | 'search.synthesis_title'
  | 'search.no_answer'
  // Focus modes
  | 'focus.all'
  | 'focus.academic'
  | 'focus.news'
  | 'focus.writing'
  | 'focus.social'
  | 'focus.finance'
  | 'focus.video'
  | 'focus.math'
  // Chat
  | 'chat.new'
  | 'chat.sources'
  | 'chat.hidden'
  | 'chat.new_conversation'
  | 'chat.placeholder'
  | 'chat.searching'
  | 'chat.synthesizing'
  | 'chat.error_do'
  | 'chat.view_sources'
  | 'chat.hide_sources'
  // Results
  | 'results.empty_title'
  | 'results.empty_desc'
  | 'results.related_title'
  | 'results.stats_time'
  | 'results.stats_results'
  | 'results.stats_backend'
  | 'results.stats_tab'
  | 'results.news_title'
  | 'results.news_no_results'
  | 'results.research_no_results'
  // Research
  | 'research.sub_queries'
  | 'research.sources_count'
  | 'research.refinements'
  | 'research.quality'
  | 'research.full_report'
  | 'research.synthesis'
  | 'research.starting'
  | 'research.found_sources'
  // Accessibility
  | 'a11y.skip_to_main'
  | 'a11y.open_link'
  | 'a11y.search_results'
  | 'a11y.result_score'
  | 'a11y.source_link'
  | 'a11y.message_from'
  | 'a11y.tab_label'
  | 'a11y.focus_mode'
  | 'a11y.option_toggle'
  | 'a11y.stream_status'

export type Locale = 'ko' | 'en' | 'ja' | 'zh-CN'

/**
 * 번역 데이터
 * 한국어(ko)가 기본값 — 다른 언어의 누락된 키는 한국어로 폴백
 */
export const translations: Record<Locale, Partial<Record<TranslationKey, string>>> = {
  // ============================================================
  // 한국어 (기본)
  // ============================================================
  ko: {
    // Common
    'common.search': '검색',
    'common.loading': '로딩 중...',
    'common.error': '오류',
    'common.no_results': '결과 없음',
    'common.view_all': '모두 보기',
    'common.close': '닫기',
    'common.copy': '복사',
    'common.copied': '복사됨',
    'common.filter': '필터',
    'common.sort': '정렬',
    'common.more': '더 보기',
    'common.less': '접기',
    'common.seconds': '초',
    'common.results': '결과',
    'common.sources': '출처',
    'common.backend': '백엔드',
    'common.fallback': '(대체)',
    'common.page': '페이지',
    'common.of': '/',
    'common.related': '관련 검색어',
    'common.keyboard_hint': 'Ctrl+K',
    // Navigation
    'nav.search': '검색',
    'nav.chat': '채팅',
    'nav.docs': '문서',
    'nav.health': '상태',
    // Search
    'search.placeholder': '검색어를 입력하세요...',
    'search.button': '검색',
    'search.ai_answer': 'AI 답변',
    'search.full_content': '전체 내용',
    'search.deep_research': '딥 리서치',
    'search.show_content': '전체 내용 보기',
    'search.hide_content': '전체 내용 숨기기',
    'search.empty_title': '웹을 검색하세요',
    'search.empty_desc': '검색어를 입력하고 엔터를 누르거나 검색 버튼을 클릭하세요',
    'search.answer_title': 'AI 답변',
    'search.research_title': '리서치 결과',
    'search.synthesis_title': '리서치 종합',
    'search.no_answer': 'AI 답변을 생성할 수 없습니다 (Workers AI를 사용할 수 없음). 아래 출처를 참조하세요.',
    // Focus modes
    'focus.all': '전체',
    'focus.academic': '학술',
    'focus.news': '뉴스',
    'focus.writing': '글쓰기',
    'focus.social': '소셜',
    'focus.finance': '금융',
    'focus.video': '비디오',
    'focus.math': '수학',
    // Chat
    'chat.new': '새 대화',
    'chat.sources': '출처',
    'chat.hidden': '숨김',
    'chat.new_conversation': '새 대화',
    'chat.placeholder': '질문을 입력하세요...',
    'chat.searching': '검색 중...',
    'chat.synthesizing': '답변 생성 중...',
    'chat.error_do':
      '채팅 엔드포인트는 THREAD_DO Durable Object 바인딩이 필요합니다. Cloudflare 대시보드에서 설정하세요.',
    'chat.view_sources': '모든 출처 보기',
    'chat.hide_sources': '출처 숨기기',
    // Results
    'results.empty_title': '검색 결과 없음',
    'results.empty_desc': '다른 검색어로 시도해보세요',
    'results.related_title': '관련 검색어',
    'results.stats_time': '응답 시간',
    'results.stats_results': '개 결과',
    'results.stats_backend': '백엔드',
    'results.stats_tab': '탭',
    'results.news_title': '뉴스',
    'results.news_no_results': '뉴스를 찾을 수 없습니다',
    'results.research_no_results': '리서치가 완료되었으나 결과가 생성되지 않았습니다.',
    // Research
    'research.sub_queries': '하위 질의',
    'research.sources_count': '개 출처',
    'research.refinements': '회 개선',
    'research.quality': '품질',
    'research.full_report': '전체 보고서',
    'research.synthesis': '리서치 종합',
    'research.starting': '리서치 시작 중...',
    'research.found_sources': '개 출처 발견',
    // Accessibility
    'a11y.skip_to_main': '본문으로 바로가기',
    'a11y.open_link': '새 탭에서 열기',
    'a11y.search_results': '검색 결과 목록',
    'a11y.result_score': '관련도 점수: {{score}}%',
    'a11y.source_link': '출처 {{number}}: {{title}}',
    'a11y.message_from': '{{role}} 메시지',
    'a11y.tab_label': '{{tab}} 탭',
    'a11y.focus_mode': '포커스 모드: {{mode}}',
    'a11y.option_toggle': '{{option}} 설정',
    'a11y.stream_status': '스트리밍 상태: {{message}}',
  },

  // ============================================================
  // English
  // ============================================================
  en: {
    'common.search': 'Search',
    'common.loading': 'Loading...',
    'common.error': 'Error',
    'common.no_results': 'No results',
    'common.view_all': 'View all',
    'common.close': 'Close',
    'common.copy': 'Copy',
    'common.copied': 'Copied',
    'common.filter': 'Filter',
    'common.sort': 'Sort',
    'common.more': 'More',
    'common.less': 'Less',
    'common.seconds': 's',
    'common.results': 'results',
    'common.sources': 'sources',
    'common.backend': 'Backend',
    'common.fallback': '(fallback)',
    'common.page': 'Page',
    'common.of': 'of',
    'common.related': 'Related',
    'common.keyboard_hint': 'Ctrl+K',
    'nav.search': 'Search',
    'nav.chat': 'Chat',
    'nav.docs': 'Docs',
    'nav.health': 'Health',
    'search.placeholder': 'Search anything...',
    'search.button': 'Search',
    'search.ai_answer': 'AI Answer',
    'search.full_content': 'Full Content',
    'search.deep_research': 'Deep Research',
    'search.show_content': 'Show full content',
    'search.hide_content': 'Hide full content',
    'search.empty_title': 'Search the web',
    'search.empty_desc': 'Type a query and press Enter or click Search',
    'search.answer_title': 'AI Answer',
    'search.research_title': 'Research Results',
    'search.synthesis_title': 'Research Synthesis',
    'search.no_answer': 'No AI answer was generated (Workers AI not available). See sources below.',
    'focus.all': 'All',
    'focus.academic': 'Academic',
    'focus.news': 'News',
    'focus.writing': 'Writing',
    'focus.social': 'Social',
    'focus.finance': 'Finance',
    'focus.video': 'Video',
    'focus.math': 'Math',
    'chat.new': 'New Chat',
    'chat.sources': 'Sources',
    'chat.hidden': 'Hidden',
    'chat.new_conversation': 'New conversation',
    'chat.placeholder': 'Ask a follow-up...',
    'chat.searching': 'Searching...',
    'chat.synthesizing': 'Synthesizing answer...',
    'chat.error_do': 'Chat requires THREAD_DO Durable Object binding. Configure via Cloudflare Dashboard.',
    'chat.view_sources': 'View all sources',
    'chat.hide_sources': 'Hide sources',
    'results.empty_title': 'No results found',
    'results.empty_desc': 'Try a different search term',
    'results.related_title': 'Related',
    'results.stats_time': 'Response time',
    'results.stats_results': 'results',
    'results.stats_backend': 'Backend',
    'results.stats_tab': 'Tab',
    'results.news_title': 'News',
    'results.news_no_results': 'No news found',
    'results.research_no_results': 'Research completed but no results were generated.',
    'research.sub_queries': 'Sub-Queries',
    'research.sources_count': 'sources',
    'research.refinements': 'refinements',
    'research.quality': 'Quality',
    'research.full_report': 'Full Report',
    'research.synthesis': 'Research Synthesis',
    'research.starting': 'Starting research...',
    'research.found_sources': 'sources found',
    'a11y.skip_to_main': 'Skip to main content',
    'a11y.open_link': 'Opens in new tab',
    'a11y.search_results': 'Search results list',
    'a11y.result_score': 'Relevance score: {{score}}%',
    'a11y.source_link': 'Source {{number}}: {{title}}',
    'a11y.message_from': 'Message from {{role}}',
    'a11y.tab_label': '{{tab}} tab',
    'a11y.focus_mode': 'Focus mode: {{mode}}',
    'a11y.option_toggle': '{{option}} toggle',
    'a11y.stream_status': 'Stream status: {{message}}',
  },

  // ============================================================
  // 日本語 (Japanese)
  // ============================================================
  ja: {
    'common.search': '検索',
    'common.loading': '読み込み中...',
    'common.error': 'エラー',
    'common.no_results': '結果なし',
    'common.view_all': 'すべて表示',
    'common.close': '閉じる',
    'common.copy': 'コピー',
    'common.copied': 'コピーしました',
    'common.filter': 'フィルター',
    'common.sort': '並び替え',
    'common.more': 'もっと見る',
    'common.less': '折りたたむ',
    'common.seconds': '秒',
    'common.results': '件の結果',
    'common.sources': 'ソース',
    'common.backend': 'バックエンド',
    'common.fallback': '(代替)',
    'common.related': '関連検索',
    'common.keyboard_hint': 'Ctrl+K',
    'nav.search': '検索',
    'nav.chat': 'チャット',
    'nav.docs': 'ドキュメント',
    'nav.health': 'ステータス',
    'search.placeholder': '検索キーワードを入力...',
    'search.button': '検索',
    'search.ai_answer': 'AI回答',
    'search.full_content': '全文表示',
    'search.deep_research': 'ディープリサーチ',
    'search.show_content': '全文を表示',
    'search.hide_content': '全文を隠す',
    'search.empty_title': 'ウェブを検索',
    'search.empty_desc': 'キーワードを入力してEnterキーを押すか、検索ボタンをクリック',
    'search.answer_title': 'AI回答',
    'search.synthesis_title': 'リサーチ統合',
    'search.no_answer': 'AI回答を生成できませんでした（Workers AIが利用不可）。以下のソースを参照してください。',
    'focus.all': 'すべて',
    'focus.academic': '学術',
    'focus.news': 'ニュース',
    'focus.writing': 'ライティング',
    'focus.social': 'ソーシャル',
    'focus.finance': '金融',
    'focus.video': 'ビデオ',
    'focus.math': '数学',
    'chat.new': '新しいチャット',
    'chat.sources': 'ソース',
    'chat.hidden': '非表示',
    'chat.new_conversation': '新しい会話',
    'chat.placeholder': 'フォローアップの質問...',
    'chat.searching': '検索中...',
    'chat.synthesizing': '回答を生成中...',
    'chat.error_do':
      'チャットにはTHREAD_DO Durable Objectバインディングが必要です。Cloudflareダッシュボードで設定してください。',
    'chat.view_sources': 'すべてのソースを表示',
    'chat.hide_sources': 'ソースを隠す',
    'results.empty_title': '検索結果が見つかりません',
    'results.empty_desc': '別の検索語でお試しください',
    'results.related_title': '関連検索',
    'results.stats_time': '応答時間',
    'results.stats_results': '件の結果',
    'results.stats_backend': 'バックエンド',
    'results.news_title': 'ニュース',
    'results.news_no_results': 'ニュースが見つかりません',
    'results.research_no_results': 'リサーチが完了しましたが、結果が生成されませんでした。',
    'research.sub_queries': 'サブクエリ',
    'research.sources_count': '件のソース',
    'research.refinements': '回の改善',
    'research.quality': '品質',
    'research.full_report': '完全なレポート',
    'research.synthesis': 'リサーチ統合',
    'research.starting': 'リサーチを開始...',
    'research.found_sources': '件のソースを発見',
    'a11y.skip_to_main': 'メインコンテンツにスキップ',
    'a11y.open_link': '新しいタブで開く',
    'a11y.search_results': '検索結果一覧',
    'a11y.result_score': '関連度スコア: {{score}}%',
    'a11y.source_link': 'ソース{{number}}: {{title}}',
    'a11y.message_from': '{{role}}からのメッセージ',
    'a11y.tab_label': '{{tab}}タブ',
    'a11y.focus_mode': 'フォーカスモード: {{mode}}',
    'a11y.option_toggle': '{{option}}設定',
    'a11y.stream_status': 'ストリーム状態: {{message}}',
  },

  // ============================================================
  // 中文 (简体中文)
  // ============================================================
  'zh-CN': {
    'common.search': '搜索',
    'common.loading': '加载中...',
    'common.error': '错误',
    'common.no_results': '无结果',
    'common.view_all': '查看全部',
    'common.close': '关闭',
    'common.copy': '复制',
    'common.copied': '已复制',
    'common.filter': '筛选',
    'common.sort': '排序',
    'common.more': '查看更多',
    'common.less': '收起',
    'common.seconds': '秒',
    'common.results': '条结果',
    'common.sources': '来源',
    'common.backend': '后端',
    'common.fallback': '(备用)',
    'common.related': '相关搜索',
    'common.keyboard_hint': 'Ctrl+K',
    'nav.search': '搜索',
    'nav.chat': '聊天',
    'nav.docs': '文档',
    'nav.health': '状态',
    'search.placeholder': '搜索任何内容...',
    'search.button': '搜索',
    'search.ai_answer': 'AI回答',
    'search.full_content': '全文',
    'search.deep_research': '深度研究',
    'search.show_content': '显示全文',
    'search.hide_content': '隐藏全文',
    'search.empty_title': '搜索网络',
    'search.empty_desc': '输入查询并按回车或点击搜索按钮',
    'search.answer_title': 'AI回答',
    'search.synthesis_title': '研究综合',
    'search.no_answer': '无法生成AI回答（Workers AI不可用）。请参阅下面的来源。',
    'focus.all': '全部',
    'focus.academic': '学术',
    'focus.news': '新闻',
    'focus.writing': '写作',
    'focus.social': '社交',
    'focus.finance': '金融',
    'focus.video': '视频',
    'focus.math': '数学',
    'chat.new': '新对话',
    'chat.sources': '来源',
    'chat.hidden': '隐藏',
    'chat.new_conversation': '新对话',
    'chat.placeholder': '输入后续问题...',
    'chat.searching': '搜索中...',
    'chat.synthesizing': '生成回答中...',
    'chat.error_do': '聊天需要THREAD_DO Durable Object绑定。请通过Cloudflare仪表板配置。',
    'chat.view_sources': '查看所有来源',
    'chat.hide_sources': '隐藏来源',
    'results.empty_title': '未找到搜索结果',
    'results.empty_desc': '请尝试不同的搜索词',
    'results.related_title': '相关搜索',
    'results.stats_time': '响应时间',
    'results.stats_results': '条结果',
    'results.stats_backend': '后端',
    'results.news_title': '新闻',
    'results.news_no_results': '未找到新闻',
    'results.research_no_results': '研究已完成，但未生成结果。',
    'research.sub_queries': '子查询',
    'research.sources_count': '个来源',
    'research.refinements': '次优化',
    'research.quality': '质量',
    'research.full_report': '完整报告',
    'research.synthesis': '研究综合',
    'research.starting': '开始研究...',
    'research.found_sources': '个来源已找到',
    'a11y.skip_to_main': '跳转到主要内容',
    'a11y.open_link': '在新标签页中打开',
    'a11y.search_results': '搜索结果列表',
    'a11y.result_score': '相关度分数: {{score}}%',
    'a11y.source_link': '来源{{number}}: {{title}}',
    'a11y.message_from': '{{role}}的消息',
    'a11y.tab_label': '{{tab}}标签',
    'a11y.focus_mode': '焦点模式: {{mode}}',
    'a11y.option_toggle': '{{option}}设置',
    'a11y.stream_status': '流状态: {{message}}',
  },
}

/**
 * 번역 문자열 개수 확인 (품질 관리)
 */
export function getTranslationStats(): Record<Locale, number> {
  const koCount = Object.keys(translations.ko).length
  return {
    ko: koCount,
    en: Object.keys(translations.en).length,
    ja: Object.keys(translations.ja).length,
    'zh-CN': Object.keys(translations['zh-CN']).length,
  }
}
