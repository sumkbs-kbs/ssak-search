# 🔌 Ssak-Search Model Context Protocol (MCP) 통합 가이드

본 문서는 **Hermes 3 (Nous Research), Claude Desktop, Cursor, Antigravity, OpenManus, CrewAI** 등의 AI 에이전트 환경에서 `ssak-search`를 표준 **MCP (Model Context Protocol)** 서버로 등록하고 연동하는 가이드입니다.

---

## 🌟 1. 제공되는 MCP 도구 목록

| 도구 이름 (Tool Name) | 주요 파라미터 | 설명 및 특징 |
|:---|:---|:---|
| `ssak_search` | `query` (필수), `max_results` (기본 5), `topic` (general/code/news/finance), `decompose_subqueries` (기본 false) | **평균 200~700ms 초저지연 실시간 웹 검색**<br>한국어(naver+bing) 및 글로벌(bing+DDG) 병렬 레이스 및 조기 반환, 전 프로바이더 공백 시 위키피디아 백본<br>피싱/SEO 포이즈닝 스크리닝 내장(차단 `phishing_filtered`, 경고 `security_warning`)<br>마이크로 캐시(60s, `cached`/`cache_age_ms` 노출) + 동시 중복 단일-플라이트 |
| `ssak_extract` | `url` (필수), `extract_depth`, `section_target`, `max_token_budget`, `strip_links` | **스텔스 봇 우회 고밀도 본문 추출 (3-티어 에스컬레이션)**<br>Tier 1 스태틱(스텔스 헤더) ➔ Tier 2 Jina 프록시 ➔ Tier 3 사이드카(`SIDECAR_URL` 설정 시)<br>링크 보존+절대 URL화, 언어 인식 토큰 예산(한국어 보정), 관측 기반 에러 택소노미(`agent_hint`/`suggested_action`), 리다이렉트 도메인 불일치 클로킹 경고 |
| `ssak_deep_research` | `query` (필수), `max_sources` (기본 3), `max_token_budget_per_source` | **자율 심층 리서치 도구**<br>검색 + 상위 소스 본문 추출을 동시도 3 병렬 배치로 수행(개별 실패 격리), 소스별 보안 경고 전달 |

---

## ⚙️ 2. 클라이언트별 설정 방법

### 🚀 [추천] 제로-컨피그 단일 바이너리 모드 (Zero-Config Standalone Binary)
Node.js나 Python 설치 없이 컴파일된 단일 바이너리(`bin/ssak-mcp`)를 직접 지정하여 100% 독립 실행:

```json
{
  "mcpServers": {
    "ssak-search": {
      "command": "/Users/mr.k/Downloads/webapp/bin/ssak-mcp"
    }
  }
}
```

---

### 1) Hermes 3 & Open Source Agent (`mcp_config.json`)
에이전트 설정 파일의 `mcpServers`에 등록합니다:
```json
{
  "mcpServers": {
    "ssak-search": {
      "command": "python3",
      "args": ["/Users/mr.k/Downloads/webapp/sdk/mcp_server.py"],
      "env": {
        "SSAK_API_BASE": "http://localhost:8788"
      }
    }
  }
}
```

### 2) Claude Desktop (`claude_desktop_config.json`)
- macOS 경로: `~/Library/Application Support/Claude/claude_desktop_config.json`
```json
{
  "mcpServers": {
    "ssak-search": {
      "command": "/Users/mr.k/Downloads/webapp/bin/ssak-mcp"
    }
  }
}
```

### 3) Cursor IDE (`.cursor/mcp.json` 또는 Features 설정)
Cursor 설정의 MCP 탭에서 `Command` 타입으로 추가:
- **Name:** `ssak-search`
- **Command:** `/Users/mr.k/Downloads/webapp/bin/ssak-mcp`


---

## 🚀 3. 로컬 서버 선행 기동

MCP 서버(`sdk/mcp_server.py`)는 로컬에서 구동 중인 `ssak-search` 백엔드(`http://localhost:8787`)와 통신합니다.  
에이전트 사용 전 터미널에서 로컬 서버를 기동해 두세요:

```bash
# Ssak-Search 로컬 엔진 기동
npm run start:local
```

---

## 🧪 4. MCP 서버 자체 동작 테스트

별도의 클라이언트 없이도 CLI에서 즉시 테스트할 수 있습니다:

```bash
python3 -c "
import subprocess, json
proc = subprocess.Popen(['python3', 'sdk/mcp_server.py'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
proc.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {}}) + '\n')
proc.stdin.flush()
print(proc.stdout.readline())
"
```
