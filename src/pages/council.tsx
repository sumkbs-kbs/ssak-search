/**
 * Council Page — Multi-Model AI Comparison (/council)
 *
 * Phase 6: Send one query to multiple LLMs and compare responses side-by-side.
 * Uses SSE streaming for real-time response display.
 */

export function councilPage(): string {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Model Council — AI 비교</title>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet" />
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: #f8fafc; --surface: #ffffff; --border: #e2e8f0;
      --text: #0f172a; --text-secondary: #64748b; --text-tertiary: #94a3b8;
      --accent: #6366f1; --accent-light: #eef2ff; --accent-dark: #4f46e5;
      --success: #10b981; --warning: #f59e0b; --error: #ef4444;
      --radius: 12px; --radius-sm: 8px;
      --font: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      --mono: 'SF Mono', 'JetBrains Mono', ui-monospace, monospace;
    }
    body { font-family: var(--font); background: var(--bg); color: var(--text); line-height: 1.5; }
    .container { max-width: 1200px; margin: 0 auto; padding: 0 16px; }
    .header { background: var(--surface); border-bottom: 1px solid var(--border); padding: 12px 0; position: sticky; top: 0; z-index: 50; }
    .header-inner { display: flex; align-items: center; justify-content: space-between; }
    .logo { font-size: 1.15rem; font-weight: 700; color: var(--accent); text-decoration: none; display: flex; align-items: center; gap: 8px; }
    main { padding: 24px 0 80px; }

    .input-section { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 24px; margin-bottom: 24px; }
    .input-section h2 { font-size: 1.1rem; margin-bottom: 16px; display: flex; align-items: center; gap: 8px; }
    textarea {
      width: 100%; min-height: 80px; padding: 12px 16px;
      border: 1px solid var(--border); border-radius: var(--radius-sm);
      font-family: var(--font); font-size: 0.95rem; resize: vertical;
      transition: border-color 0.15s;
    }
    textarea:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-light); }

    .controls { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin-top: 16px; }
    .model-checkboxes { display: flex; gap: 8px; flex-wrap: wrap; }
    .model-checkbox { display: flex; align-items: center; gap: 4px; font-size: 0.82rem; color: var(--text-secondary); cursor: pointer; }
    .model-checkbox input { accent-color: var(--accent); }
    .model-checkbox.unavailable { opacity: 0.5; cursor: not-allowed; }

    .btn {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 10px 20px; border-radius: var(--radius-sm);
      font-size: 0.85rem; font-weight: 600; cursor: pointer;
      border: none; transition: all 0.15s;
    }
    .btn-primary { background: var(--accent); color: white; }
    .btn-primary:hover { background: var(--accent-dark); }
    .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-secondary { background: var(--surface); color: var(--text-secondary); border: 1px solid var(--border); }
    .btn-secondary:hover { background: var(--accent-light); color: var(--accent); border-color: var(--accent); }

    .status { font-size: 0.82rem; color: var(--text-tertiary); margin-left: auto; }

    /* Response Grid */
    .response-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 16px; }
    .model-card {
      background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
      overflow: hidden; transition: box-shadow 0.2s;
    }
    .model-card:hover { box-shadow: 0 4px 12px rgba(0,0,0,0.06); }
    .model-card.pending { opacity: 0.6; }
    .model-card.done { opacity: 1; }
    .model-card.error { border-color: var(--error); }

    .model-card-header {
      padding: 14px 16px; border-bottom: 1px solid var(--border);
      display: flex; align-items: center; justify-content: space-between;
    }
    .model-name { font-weight: 600; font-size: 0.85rem; display: flex; align-items: center; gap: 6px; }
    .model-provider { font-size: 0.72rem; color: var(--text-tertiary); }
    .model-status { font-size: 0.72rem; padding: 2px 8px; border-radius: 999px; }
    .model-status.pending { background: #fef3c7; color: #92400e; }
    .model-status.done { background: #d1fae5; color: #065f46; }
    .model-status.error { background: #fee2e2; color: #991b1b; }

    .model-card-body { padding: 16px; font-size: 0.85rem; line-height: 1.6; }
    .model-card-body.loading { color: var(--text-tertiary); }
    .model-card-body .empty-state { color: var(--text-tertiary); font-style: italic; }
    .model-error { color: var(--error); font-size: 0.78rem; padding: 8px 12px; background: #fef2f2; border-radius: 6px; margin-top: 8px; }

    .latency-badge {
      display: inline-flex; align-items: center; gap: 4px;
      padding: 3px 8px; border-radius: 999px; font-size: 0.7rem;
      background: var(--accent-light); color: var(--accent-dark);
    }

    /* Loading shimmer */
    @keyframes shimmer { 0% { opacity: 0.4; } 50% { opacity: 1; } 100% { opacity: 0.4; } }
    .shimmer { animation: shimmer 1.5s infinite; }

    /* Summary bar */
    .summary-bar {
      background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
      padding: 16px 20px; margin-bottom: 16px;
      display: flex; align-items: center; gap: 20px; flex-wrap: wrap;
    }
    .summary-stat { text-align: center; }
    .summary-stat .value { font-size: 1.3rem; font-weight: 700; color: var(--accent); }
    .summary-stat .label { font-size: 0.72rem; color: var(--text-tertiary); }

    /* Empty state */
    .empty-state-card {
      background: var(--surface); border: 1px dashed var(--border); border-radius: var(--radius);
      padding: 60px 20px; text-align: center; color: var(--text-tertiary);
    }
    .empty-state-card i { font-size: 2.5rem; margin-bottom: 12px; }
    .empty-state-card h3 { font-size: 1rem; margin-bottom: 8px; color: var(--text-secondary); }

    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0f172a; --surface: #1e293b; --border: #334155;
        --text: #f1f5f9; --text-secondary: #94a3b8; --text-tertiary: #64748b;
        --accent: #818cf8; --accent-light: #1e1b4b; --accent-dark: #a5b4fc;
      }
    }
  </style>
</head>
<body>
  <header class="header">
    <div class="container header-inner">
      <a href="/" class="logo"><i class="fas fa-robot"></i> Model Council</a>
      <div style="display:flex;gap:8px;">
        <a href="/docs" class="btn btn-secondary" style="padding:6px 12px;font-size:0.78rem;"><i class="fas fa-book"></i> Docs</a>
        <a href="/" class="btn btn-secondary" style="padding:6px 12px;font-size:0.78rem;"><i class="fas fa-arrow-left"></i> Dashboard</a>
      </div>
    </div>
  </header>

  <main class="container">
    <!-- Input Section -->
    <div class="input-section">
      <h2><i class="fas fa-pen-fancy" style="color:var(--accent);"></i> 질문 입력</h2>
      <textarea id="queryInput" placeholder="여러 AI 모델에게 동시에 질문하고 답변을 비교해보세요..." rows="3"></textarea>
      <div class="controls">
        <div class="model-checkboxes" id="modelCheckboxes"></div>
        <button class="btn btn-primary" id="submitBtn" onclick="compare()">
          <i class="fas fa-play"></i> 비교하기
        </button>
        <button class="btn btn-secondary" id="resetBtn" onclick="resetAll()" style="display:none;">
          <i class="fas fa-undo"></i> 초기화
        </button>
        <span class="status" id="statusText"></span>
      </div>
    </div>

    <!-- Results Area -->
    <div id="resultsArea">
      <div class="empty-state-card">
        <i class="fas fa-microchip"></i>
        <h3>AI 모델 비교 대기 중</h3>
        <p>질문을 입력하고 "비교하기"를 클릭하면 여러 AI 모델의 답변을 실시간으로 확인할 수 있습니다.</p>
      </div>
    </div>
  </main>

  <script>
    // ============================================================
    // State
    // ============================================================
    let models = []
    let queryTimeout = null

    // ============================================================
    // Load available models on page load
    // ============================================================
    async function loadModels() {
      try {
        const res = await fetch('/api/council/models')
        const data = await res.json()
        models = data.models || []
        renderModelCheckboxes()
      } catch (err) {
        document.getElementById('modelCheckboxes').innerHTML = '<span style="color:var(--error);font-size:0.82rem;">모델 목록을 불러올 수 없습니다</span>'
      }
    }

    function renderModelCheckboxes() {
      const container = document.getElementById('modelCheckboxes')
      container.innerHTML = models.map(m => {
        const isAvailable = m.available
        const checked = isAvailable ? 'checked' : ''
        const cls = isAvailable ? 'model-checkbox' : 'model-checkbox unavailable'
        return '<label class="' + cls + '" title="' + (m.description || '') + '">' +
          '<input type="checkbox" value="' + m.id + '" ' + checked + ' ' + (isAvailable ? '' : 'disabled') + ' />' +
          m.label +
          (isAvailable ? '' : ' <i class="fas fa-lock" style="font-size:0.65rem;" title="API 키 필요"></i>') +
          '</label>'
      }).join('')
    }

    // ============================================================
    // Compare
    // ============================================================
    async function compare() {
      const query = document.getElementById('queryInput').value.trim()
      if (!query) {
        document.getElementById('queryInput').focus()
        return
      }

      const selectedModels = Array.from(
        document.querySelectorAll('#modelCheckboxes input:checked')
      ).map(cb => cb.value)

      if (selectedModels.length === 0) {
        alert('비교할 모델을 하나 이상 선택해주세요.')
        return
      }

      // Show reset button, hide empty state
      document.getElementById('resetBtn').style.display = 'inline-flex'
      document.getElementById('submitBtn').disabled = true
      document.getElementById('statusText').textContent = '모델 응답 대기 중...'

      // Build response grid
      const area = document.getElementById('resultsArea')
      area.innerHTML = '<div class="summary-bar" id="summaryBar">' +
        '<div class="summary-stat"><div class="value" id="modelCount">0/' + selectedModels.length + '</div><div class="label">완료</div></div>' +
        '<div class="summary-stat"><div class="value" id="totalTime">-</div><div class="label">총 시간</div></div>' +
        '<div class="summary-stat"><div class="value" id="avgLatency">-</div><div class="label">평균 지연</div></div>' +
        '</div>' +
        '<div class="response-grid" id="responseGrid"></div>'

      const grid = document.getElementById('responseGrid')

      // Create cards for each model
      selectedModels.forEach(modelId => {
        const m = models.find(mm => mm.id === modelId)
        const card = document.createElement('div')
        card.className = 'model-card pending'
        card.id = 'card-' + modelId
        card.innerHTML = '<div class="model-card-header">' +
          '<div><div class="model-name"><i class="fas fa-brain"></i> ' + (m ? m.label : modelId) + '</div>' +
          '<div class="model-provider">' + (m ? m.provider : '') + '</div></div>' +
          '<span class="model-status pending" id="status-' + modelId + '">대기 중</span>' +
          '</div>' +
          '<div class="model-card-body loading" id="body-' + modelId + '">' +
          '<div class="shimmer">응답을 기다리는 중...</div>' +
          '</div>'
        grid.appendChild(card)
      })

      // Connect to SSE
      const eventSource = new EventSource('/api/council/stream')
      let modelsDone = 0
      let latencies = []

      // Wait for models info, then send the query
      eventSource.addEventListener('models', function (e) {
        // Received model info, now close and send POST
        eventSource.close()
        sendStreamRequest(query, selectedModels)
      })

      eventSource.addEventListener('error', function () {
        // models event might not fire (old SSE behavior), fallback to POST
        eventSource.close()
        sendStreamRequest(query, selectedModels)
      })
    }

    async function sendStreamRequest(query, selectedModels) {
      try {
        const res = await fetch('/api/council/stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query, models: selectedModels }),
        })

        if (!res.ok) {
          throw new Error('HTTP ' + res.status)
        }

        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let modelsDone = 0
        let latencies = []
        let totalTimeMs = 0
        const modelCount = selectedModels.length

        function updateSummary() {
          document.getElementById('modelCount').textContent = modelsDone + '/' + modelCount
          if (latencies.length > 0) {
            const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length
            document.getElementById('avgLatency').textContent = Math.round(avg) + 'ms'
          }
          if (totalTimeMs > 0) {
            document.getElementById('totalTime').textContent = totalTimeMs + 'ms'
          }
        }

        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\\n')
          buffer = lines.pop() || ''

          let currentEvent = ''
          for (const line of lines) {
            if (line.startsWith('event: ')) {
              currentEvent = line.slice(7).trim()
            } else if (line.startsWith('data: ')) {
              const data = JSON.parse(line.slice(6))

              switch (currentEvent) {
                case 'start': {
                  const card = document.getElementById('card-' + data.model)
                  if (card) {
                    card.className = 'model-card pending'
                    document.getElementById('status-' + data.model).textContent = '응답 중...'
                    document.getElementById('body-' + data.model).innerHTML = '<div class="shimmer">응답 생성 중...</div>'
                  }
                  break
                }
                case 'done': {
                  const card = document.getElementById('card-' + data.model)
                  if (card) {
                    card.className = 'model-card done'
                    document.getElementById('status-' + data.model).textContent = '완료 (' + data.latency_ms + 'ms)'
                    document.getElementById('body-' + data.model).innerHTML = '<div style="white-space:pre-wrap;">' + escapeHtml(data.response) + '</div>' +
                      '<div style="margin-top:12px;"><span class="latency-badge"><i class="fas fa-clock"></i> ' + data.latency_ms + 'ms</span></div>'
                  }
                  modelsDone++
                  latencies.push(data.latency_ms)
                  updateSummary()
                  break
                }
                case 'error': {
                  const card = document.getElementById('card-' + data.model)
                  if (card) {
                    card.className = 'model-card error'
                    document.getElementById('status-' + data.model).textContent = '오류'
                    document.getElementById('body-' + data.model).innerHTML =
                      '<div class="model-error"><i class="fas fa-exclamation-circle"></i> ' + escapeHtml(data.error || 'Unknown error') + '</div>'
                  }
                  modelsDone++
                  updateSummary()
                  break
                }
                case 'complete': {
                  totalTimeMs = data.total_time_ms
                  updateSummary()
                  document.getElementById('statusText').textContent = '비교 완료 (' + totalTimeMs + 'ms)'
                  document.getElementById('submitBtn').disabled = false
                  break
                }
              }
            }
          }
        }
      } catch (err) {
        document.getElementById('statusText').textContent = '오류 발생'
        document.getElementById('submitBtn').disabled = false
      }
    }

    // ============================================================
    // Reset
    // ============================================================
    function resetAll() {
      document.getElementById('queryInput').value = ''
      document.getElementById('resultsArea').innerHTML = '<div class="empty-state-card">' +
        '<i class="fas fa-microchip"></i>' +
        '<h3>AI 모델 비교 대기 중</h3>' +
        '<p>질문을 입력하고 "비교하기"를 클릭하면 여러 AI 모델의 답변을 실시간으로 확인할 수 있습니다.</p>' +
        '</div>'
      document.getElementById('resetBtn').style.display = 'none'
      document.getElementById('submitBtn').disabled = false
      document.getElementById('statusText').textContent = ''
    }

    // ============================================================
    // Utility
    // ============================================================
    function escapeHtml(str) {
      const div = document.createElement('div')
      div.textContent = str
      return div.innerHTML
    }

    // ============================================================
    // Init
    // ============================================================
    loadModels()
  </script>
</body>
</html>`
}
