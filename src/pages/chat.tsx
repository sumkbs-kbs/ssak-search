/**
 * Chat Page — Multi-turn Conversational UI (Hono JSX + Alpine.js)
 *
 * Thread-based chat connected to /api/chat endpoint.
 * Features source cards, citation highlights, follow-up context.
 */

import { Layout } from '../components/Layout'

// ============================================================
// Chat-specific styles
// ============================================================
const CHAT_CSS = `
/* Message bubbles */
.message { display: flex; margin-bottom: 16px; gap: 10px; }
.message.user { justify-content: flex-end; }
.message.assistant { justify-content: flex-start; }

.message .avatar {
  width: 32px; height: 32px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-size: 0.8rem; flex-shrink: 0;
}
.message.user .avatar { background: var(--accent); color: white; order: 1; }
.message.assistant .avatar { background: var(--surface-hover); color: var(--text-secondary); border: 1px solid var(--border); }

.message .bubble {
  max-width: 85%; padding: 12px 16px;
  font-size: 0.88rem; line-height: 1.6;
}
.message.user .bubble {
  background: var(--accent); color: white;
  border-radius: 16px 16px 4px 16px;
}
.message.assistant .bubble {
  background: var(--surface); color: var(--text);
  border: 1px solid var(--border); border-radius: 16px 16px 16px 4px;
  box-shadow: var(--shadow);
}

.message .bubble .msg-text strong { font-weight: 600; }
.message .bubble .msg-text sup.citation {
  display: inline-block; font-size: 0.7rem; font-weight: 600;
  color: var(--accent); vertical-align: super; line-height: 1; cursor: pointer;
}

/* Source chips */
.source-chips {
  display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px;
}
.source-chip {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 3px 10px; border-radius: 999px; font-size: 0.7rem; font-weight: 500;
  background: var(--accent-light); color: var(--accent-dark);
  border: 1px solid #c7d2fe; text-decoration: none; transition: all 0.15s;
  max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.source-chip:hover { background: var(--accent); color: white; }
.source-chip .chip-num {
  font-weight: 700; font-family: var(--mono); min-width: 14px;
}

/* Source drawer */
.source-drawer { margin-top: 8px; border-top: 1px solid var(--border); padding-top: 8px; }
.source-drawer-toggle {
  font-size: 0.75rem; color: var(--accent); cursor: pointer;
  display: inline-flex; align-items: center; gap: 4px;
}
.source-drawer-toggle:hover { text-decoration: underline; }
.source-drawer-content { display: none; margin-top: 6px; }
.source-drawer-content.open { display: block; }
.source-drawer-item {
  padding: 6px 10px; font-size: 0.75rem; border-radius: var(--radius-sm);
  background: var(--surface-hover); margin-bottom: 4px;
}
.source-drawer-item a { font-weight: 500; color: var(--accent-dark); text-decoration: none; }
.source-drawer-item a:hover { text-decoration: underline; }
.source-drawer-item .src-url {
  display: block; font-size: 0.68rem; color: var(--text-tertiary);
  font-family: var(--mono); word-break: break-all;
}

/* Typing indicator */
.typing { display: none; align-items: center; gap: 10px; padding: 0 0 16px; }
.typing.active { display: flex; }
.typing .dots {
  display: flex; gap: 4px; padding: 12px 16px;
  background: var(--surface); border: 1px solid var(--border);
  border-radius: 16px 16px 16px 4px;
}
.typing .dots span {
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--text-tertiary); animation: bounce 1.4s infinite ease-in-out;
}
.typing .dots span:nth-child(2) { animation-delay: 0.2s; }
.typing .dots span:nth-child(3) { animation-delay: 0.4s; }
@keyframes bounce { 0%, 80%, 100% { transform: scale(0.6); } 40% { transform: scale(1); } }

/* Stream status */
.stream-status-msg {
  display: none; font-size: 0.75rem; color: var(--text-tertiary);
  padding: 0 0 8px 42px;
}
.stream-status-msg.active { display: block; }

/* Input area */
.input-area {
  background: var(--surface); border-top: 1px solid var(--border);
  padding: 12px 16px;
  position: sticky; bottom: 0; z-index: 40;
}
.input-inner {
  max-width: 768px; margin: 0 auto;
  display: flex; gap: 8px; align-items: flex-end;
}
.input-inner textarea {
  flex: 1; padding: 10px 14px; font-size: 0.88rem; font-family: var(--font);
  border: 2px solid var(--border); border-radius: var(--radius-sm);
  outline: none; resize: none; min-height: 44px; max-height: 120px;
  line-height: 1.4; transition: border-color 0.15s;
  background: var(--surface); color: var(--text);
}
.input-inner textarea:focus { border-color: var(--accent); }
.send-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 44px; height: 44px; border-radius: var(--radius-sm);
  background: var(--accent); color: white; border: none;
  cursor: pointer; transition: all 0.15s; flex-shrink: 0;
}
.send-btn:hover { background: var(--accent-dark); }
.send-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.send-btn i { font-size: 1rem; }

/* Empty chat */
.empty-chat {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  height: 100%; color: var(--text-tertiary); text-align: center; padding: 40px;
}
.empty-chat i { font-size: 2.5rem; margin-bottom: 16px; opacity: 0.3; }
.empty-chat h2 { font-size: 1.1rem; font-weight: 600; color: var(--text-secondary); margin-bottom: 6px; }
.empty-chat p { font-size: 0.82rem; }
.empty-examples {
  display: flex; flex-wrap: wrap; justify-content: center; gap: 6px; margin-top: 16px;
}
.empty-example {
  padding: 6px 14px; border-radius: 999px; font-size: 0.75rem;
  background: var(--surface-hover); color: var(--text-secondary);
  border: 1px solid var(--border); cursor: pointer; transition: all 0.15s;
}
.empty-example:hover { background: var(--accent-light); color: var(--accent); border-color: var(--accent); }
`

// ============================================================
// Client-side JavaScript
// ============================================================
const CHAT_SCRIPT = `
// ============================================================
// State
// ============================================================
let threadId = null;
let isProcessing = false;
let msgCounter = 0;

// ============================================================
// Auto-resize textarea
// ============================================================
const textarea = document.getElementById('chat-input');
if (textarea) {
  textarea.addEventListener('input', () => {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
  });
  textarea.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      window.sendMessage();
    }
  });
}

// ============================================================
// New thread
// ============================================================
window.newThread = function() {
  threadId = null;
  const container = document.getElementById('messages-container');
  const emptyState = document.getElementById('empty-state');
  const threadTitle = document.getElementById('thread-title');
  if (container) container.innerHTML = '';
  if (emptyState) emptyState.style.display = 'flex';
  if (threadTitle) threadTitle.textContent = 'New conversation';
  if (textarea) { textarea.value = ''; textarea.focus(); }
  scrollToBottom();
};

// ============================================================
// Send message
// ============================================================
window.sendMessage = function() {
  const query = textarea ? textarea.value.trim() : '';
  if (!query || isProcessing) return;
  sendQuery(query);
};

window.sendExample = function(q) {
  if (textarea) textarea.value = q;
  sendQuery(q);
};

async function sendQuery(query) {
  if (isProcessing) return;
  isProcessing = true;

  const sendBtn = document.getElementById('send-btn');
  const chatInput = document.getElementById('chat-input');
  const container = document.getElementById('messages-container');
  const emptyState = document.getElementById('empty-state');
  const typing = document.getElementById('typing-indicator');
  const threadTitle = document.getElementById('thread-title');

  // Hide empty state
  if (emptyState) emptyState.style.display = 'none';

  // Add user message
  addMessage('user', query);

  // Clear input
  if (chatInput) { chatInput.value = ''; chatInput.style.height = 'auto'; }

  // Show typing indicator
  if (typing) typing.classList.add('active');

  // Disable input
  if (sendBtn) sendBtn.disabled = true;
  if (chatInput) chatInput.disabled = true;

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: query,
        thread_id: threadId,
        depth: 'quick',
        max_sources: 10,
      })
    });

    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.detail || 'Chat request failed');
    }

    threadId = data.thread_id;
    if (threadTitle) threadTitle.textContent = query.slice(0, 40) + (query.length > 40 ? '...' : '');
    addAssistantMessage(data.answer, data.sources || []);

  } catch (err) {
    addMessage('assistant', 'Error: ' + err.message + '. The chat endpoint requires the THREAD_DO Durable Object binding to be configured in the Cloudflare Dashboard.');
  } finally {
    if (typing) typing.classList.remove('active');
    if (sendBtn) sendBtn.disabled = false;
    if (chatInput) { chatInput.disabled = false; chatInput.focus(); }
    isProcessing = false;
  }
}

// ============================================================
// Add message to UI
// ============================================================
function addMessage(role, content) {
  const container = document.getElementById('messages-container');
  if (!container) return;

  const div = document.createElement('div');
  div.className = 'message ' + role;

  const avatar = role === 'user'
    ? '<div class="avatar"><i class="fas fa-user"></i></div>'
    : '<div class="avatar"><i class="fas fa-robot"></i></div>';

  const text = role === 'user' ? escapeHtml(content) : renderMarkdown(content);

  div.innerHTML = avatar + '<div class="bubble"><div class="msg-text">' + text + '</div></div>';

  container.appendChild(div);
  scrollToBottom();
}

function addAssistantMessage(answer, sources) {
  const container = document.getElementById('messages-container');
  if (!container) return;

  const div = document.createElement('div');
  div.className = 'message assistant';

  const answerHtml = renderMarkdown(answer || 'No answer was generated from available sources.');

  // Source chips (top 5)
  let sourcesHtml = '';
  if (sources && sources.length > 0) {
    sourcesHtml += '<div class="source-chips">';
    for (let i = 0; i < Math.min(sources.length, 5); i++) {
      sourcesHtml += '<a href="' + escapeAttr(sources[i].url) + '" target="_blank" class="source-chip" title="' + escapeAttr(sources[i].title) + '">';
      sourcesHtml += '<span class="chip-num">' + (i + 1) + '</span>';
      sourcesHtml += escapeHtml(sources[i].title.slice(0, 30));
      sourcesHtml += '</a>';
    }
    if (sources.length > 5) {
      sourcesHtml += '<span class="source-chip" style="background:transparent;border-style:dashed">+' + (sources.length - 5) + ' more</span>';
    }
    sourcesHtml += '</div>';
  }

  // Source drawer (all sources)
  let drawerHtml = '';
  if (sources && sources.length > 0) {
    drawerHtml += '<div class="source-drawer">';
    drawerHtml += '<span class="source-drawer-toggle" onclick="toggleDrawer(this)"><i class="fas fa-chevron-down"></i> View all ' + sources.length + ' sources</span>';
    drawerHtml += '<div class="source-drawer-content">';
    for (let i = 0; i < sources.length; i++) {
      drawerHtml += '<div class="source-drawer-item">';
      drawerHtml += '<a href="' + escapeAttr(sources[i].url) + '" target="_blank" rel="noopener">[' + (i + 1) + '] ' + escapeHtml(sources[i].title) + '</a>';
      drawerHtml += '<span class="src-url">' + escapeHtml(sources[i].url) + '</span>';
      drawerHtml += '</div>';
    }
    drawerHtml += '</div></div>';
  }

  div.innerHTML = '<div class="avatar"><i class="fas fa-robot"></i></div>'
    + '<div style="flex:1">'
    + '<div class="bubble"><div class="msg-text">' + answerHtml + '</div></div>'
    + sourcesHtml
    + drawerHtml
    + '</div>';

  container.appendChild(div);
  scrollToBottom();
}

// ============================================================
// Source drawer toggle
// ============================================================
window.toggleDrawer = function(el) {
  if (!el) return;
  const content = el.nextElementSibling;
  if (content) {
    const isOpen = content.classList.toggle('open');
    el.innerHTML = isOpen
      ? '<i class="fas fa-chevron-up"></i> Hide sources'
      : '<i class="fas fa-chevron-down"></i> View all sources';
  }
};

// ============================================================
// Scroll to bottom
// ============================================================
function scrollToBottom() {
  const area = document.getElementById('messages-area');
  if (area) {
    setTimeout(() => { area.scrollTop = area.scrollHeight; }, 50);
  }
}

// ============================================================
// Utility
// ============================================================
function escapeHtml(s) {
  if (!s) return '';
  const d = document.createElement('div');
  d.textContent = String(s);
  return d.innerHTML;
}

function escapeAttr(s) {
  if (!s) return '';
  return String(s).replace(/'/g, "&apos;").replace(/\"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderMarkdown(text) {
  if (!text) return '';
  let html = escapeHtml(text);
  html = html.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
  html = html.replace(/\\[(\\d+)\\]/g, '<sup class="citation" style="font-size:0.7rem;font-weight:600;color:var(--accent);vertical-align:super;line-height:1;cursor:pointer;">[$1]</sup>');
  html = html.replace(/\\n/g, '<br>');
  return html;
}
`

// ============================================================
// Example queries
// ============================================================
const EXAMPLE_QUERIES = [
  { label: 'Compare React, Vue, Svelte', query: 'Compare React, Vue, and Svelte in 2026' },
  { label: 'What is quantum computing?', query: 'What is quantum computing and how does it work?' },
  { label: 'Transformer architecture', query: 'Explain the transformer architecture in AI' },
  { label: 'Rust error handling', query: 'What are the best practices for Rust error handling?' },
]

// ============================================================
// Chat Page Component
// ============================================================
export function chatPage() {
  return (
    <Layout
      title="Chat — Search Engine"
      currentPage="chat"
      headExtra={`<style>${CHAT_CSS}</style>`}
      bodyScripts={`<script>${CHAT_SCRIPT}</script>`}
    >
      {/* Messages area */}
      <div
        class="messages-area"
        id="messages-area"
        style="flex: 1; overflow-y: auto; padding: 16px 0; height: calc(100vh - 56px - 68px);"
      >
        <div class="messages-inner" style="max-width: 768px; margin: 0 auto; padding: 0 16px;">
          {/* Empty state */}
          <div class="empty-chat" id="empty-state">
            <i class="fas fa-comment-dots"></i>
            <h2>Start a conversation</h2>
            <p>Ask anything — I'll research and synthesize answers from the web</p>
            <div class="empty-examples">
              {EXAMPLE_QUERIES.map((ex) => (
                <span class="empty-example" onclick={`sendExample('${ex.query}')`}>
                  {ex.label}
                </span>
              ))}
            </div>
          </div>

          {/* Messages container */}
          <div id="messages-container"></div>

          {/* Typing indicator */}
          <div class="typing" id="typing-indicator">
            <div
              class="avatar"
              style="width: 32px; height: 32px; border-radius: 50%; background: var(--surface-hover); display: flex; align-items: center; justify-content: center; border: 1px solid var(--border); flex-shrink: 0;"
            >
              <i class="fas fa-robot" style="font-size: 0.8rem; color: var(--text-secondary);"></i>
            </div>
            <div class="dots">
              <span></span><span></span><span></span>
            </div>
          </div>
        </div>
      </div>

      {/* Input area */}
      <div class="input-area">
        <div class="input-inner">
          <textarea
            id="chat-input"
            rows={1}
            placeholder="Ask a follow-up..."
            autofocus
          />
          <button class="send-btn" id="send-btn" onclick="sendMessage()">
            <i class="fas fa-arrow-up"></i>
          </button>
        </div>
      </div>
    </Layout>
  )
}
