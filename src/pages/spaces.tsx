/**
 * Spaces Page — 워크스페이스 관리 UI (Phase 3.3)
 *
 * Alpine.js 기반. Spaces 생성, 조회, 수정, 삭제.
 */

import { Layout } from '../components/Layout'

const SPACES_CSS = `
.spaces-page { max-width: 800px; margin: 0 auto; padding: 0 16px; }

.space-card {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 16px; margin-bottom: 10px;
  transition: all var(--transition-fast); cursor: pointer;
}
.space-card:hover { border-color: #c7d2fe; box-shadow: var(--shadow-md); }
.space-card:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

.space-name { font-size: 0.95rem; font-weight: 600; }
.space-desc { font-size: 0.78rem; color: var(--text-secondary); margin-top: 4px; }
.space-meta { font-size: 0.7rem; color: var(--text-tertiary); margin-top: 6px; display: flex; gap: 12px; }

.dialog-overlay {
  position: fixed; inset: 0; background: rgba(0,0,0,0.4);
  display: flex; align-items: center; justify-content: center;
  z-index: 100; backdrop-filter: blur(2px);
}
.dialog {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 24px; width: 90%; max-width: 480px;
  box-shadow: var(--shadow-lg); max-height: 80vh; overflow-y: auto;
}
.dialog h2 { font-size: 1.1rem; font-weight: 600; margin-bottom: 16px; }
.dialog label { font-size: 0.78rem; font-weight: 500; color: var(--text-secondary); display: block; margin-bottom: 4px; }
.dialog input, .dialog textarea {
  width: 100%; padding: 8px 12px; font-size: 0.85rem;
  border: 1px solid var(--border); border-radius: var(--radius-xs);
  background: var(--surface); color: var(--text); font-family: var(--font);
  margin-bottom: 12px;
}
.dialog textarea { min-height: 80px; resize: vertical; }
.dialog-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }
`

const SPACES_SCRIPT = `
(function() {
  var STATE = { spaces: [], showDialog: false, editing: null, form: { name: '', description: '', instructions: '' } };

  function render() {
    var list = document.getElementById('spaces-list');
    if (!list) return;
    if (STATE.spaces.length === 0) {
      list.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-tertiary);"><svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="display:block;margin:0 auto 12px;opacity:0.4;"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></svg><p style="font-size:0.85rem;">No spaces yet. Create your first workspace!</p></div>';
      return;
    }
    list.innerHTML = '';
    STATE.spaces.forEach(function(s) {
      var card = document.createElement('div');
      card.className = 'space-card';
      card.setAttribute('role', 'button');
      card.setAttribute('tabindex', '0');
      card.innerHTML = ''
        + '<div class="space-name">' + escapeHtml(s.name) + '</div>'
        + (s.description ? '<div class="space-desc">' + escapeHtml(s.description) + '</div>' : '')
        + '<div class="space-meta">'
        + '<span>' + (s.files ? s.files.length : 0) + ' files</span>'
        + '<span>' + (s.focus_mode || 'all') + ' mode</span>'
        + '<span>' + new Date(s.updated_at).toLocaleDateString() + '</span>'
        + '</div>';
      card.addEventListener('click', function() { openEdit(s); });
      list.appendChild(card);
    });
  }

  function loadSpaces() {
    fetch('/api/spaces')
      .then(function(r) { return r.json(); })
      .then(function(d) {
        STATE.spaces = d.spaces || [];
        render();
      })
      .catch(function(err) { console.warn('Failed to load spaces:', err); });
  }

  window.openCreate = function() {
    STATE.editing = null;
    STATE.form = { name: '', description: '', instructions: '' };
    STATE.showDialog = true;
    renderDialog();
  };

  function openEdit(space) {
    STATE.editing = space;
    STATE.form = { name: space.name, description: space.description || '', instructions: space.instructions || '' };
    STATE.showDialog = true;
    renderDialog();
  }

  window.closeDialog = function() {
    STATE.showDialog = false;
    renderDialog();
  };

  window.saveSpace = function() {
    var f = STATE.form;
    if (!f.name.trim()) return;

    var method = STATE.editing ? 'PUT' : 'POST';
    var url = STATE.editing ? '/api/spaces/' + STATE.editing.id : '/api/spaces';

    fetch(url, {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(f),
    })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        STATE.showDialog = false;
        loadSpaces();
      })
      .catch(function(err) { console.warn('Save failed:', err); });
  };

  window.deleteSpace = function() {
    if (!STATE.editing) return;
    if (!confirm('Delete space "' + STATE.editing.name + '"?')) return;

    fetch('/api/spaces/' + STATE.editing.id, { method: 'DELETE' })
      .then(function(r) { return r.json(); })
      .then(function() {
        STATE.showDialog = false;
        STATE.editing = null;
        loadSpaces();
      })
      .catch(function(err) { console.warn('Delete failed:', err); });
  };

  function renderDialog() {
    var overlay = document.getElementById('dialog-overlay');
    if (!overlay) return;
    overlay.style.display = STATE.showDialog ? 'flex' : 'none';
    if (!STATE.showDialog) return;

    var title = document.getElementById('dialog-title');
    if (title) title.textContent = STATE.editing ? 'Edit Space' : 'Create Space';

    var nameInput = document.getElementById('space-name-input');
    if (nameInput) nameInput.value = STATE.form.name;

    var descInput = document.getElementById('space-desc-input');
    if (descInput) descInput.value = STATE.form.description;

    var instrInput = document.getElementById('space-instr-input');
    if (instrInput) instrInput.value = STATE.form.instructions;

    var deleteBtn = document.getElementById('delete-btn');
    if (deleteBtn) deleteBtn.style.display = STATE.editing ? 'inline-flex' : 'none';
  }

  // Live form binding
  document.addEventListener('input', function(e) {
    if (e.target.id === 'space-name-input') STATE.form.name = e.target.value;
    if (e.target.id === 'space-desc-input') STATE.form.description = e.target.value;
    if (e.target.id === 'space-instr-input') STATE.form.instructions = e.target.value;
  });

  loadSpaces();

  function escapeHtml(s) {
    if (!s) return '';
    var d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
  }
})();
`

export function spacesPage() {
  return (
    <Layout
      title="Spaces — Search Engine"
      currentPage="search"
      locale="en"
      headExtra={`<style>${SPACES_CSS}</style>`}
      bodyScripts={`<script>${SPACES_SCRIPT}</script>`}
    >
      <div class="spaces-page">
        <div style="display:flex;justify-content:space-between;align-items:center;padding:24px 0 16px;">
          <div>
            <h1 style="font-size:1.5rem;font-weight:700;">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
                style="vertical-align:middle;margin-right:8px;color:var(--accent);"
              >
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                <line x1="3" y1="9" x2="21" y2="9" />
                <line x1="9" y1="21" x2="9" y2="9" />
              </svg>
              Spaces
            </h1>
            <p style="color:var(--text-secondary);font-size:0.85rem;">Organize your research with workspaces</p>
          </div>
          <button class="btn btn-primary" onclick="openCreate()">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
              style="vertical-align:middle;"
            >
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            New Space
          </button>
        </div>

        <div id="spaces-list">
          <div style="text-align:center;padding:40px;color:var(--text-tertiary);">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="32"
              height="32"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
              style="display:block;margin:0 auto 12px;opacity:0.4;"
            >
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
              <line x1="3" y1="9" x2="21" y2="9" />
              <line x1="9" y1="21" x2="9" y2="9" />
            </svg>
            <p style="font-size:0.85rem;">Loading spaces...</p>
          </div>
        </div>

        {/* Dialog overlay */}
        <div
          id="dialog-overlay"
          class="dialog-overlay"
          style="display:none;"
          onclick="if(event.target===this)closeDialog()"
        >
          <div class="dialog" onclick="event.stopPropagation()">
            <h2 id="dialog-title">Create Space</h2>
            <label for="space-name-input">Name</label>
            <input id="space-name-input" type="text" placeholder="My Research Space" />
            <label for="space-desc-input">Description</label>
            <textarea id="space-desc-input" placeholder="What is this space about?" rows={2}></textarea>
            <label for="space-instr-input">System Instructions</label>
            <textarea
              id="space-instr-input"
              placeholder="AI context instructions for search in this space..."
              rows={3}
            ></textarea>
            <div class="dialog-actions">
              <button
                id="delete-btn"
                class="btn btn-ghost"
                style="color:var(--error);margin-right:auto;"
                onclick="deleteSpace()"
              >
                Delete
              </button>
              <button class="btn btn-ghost" onclick="closeDialog()">
                Cancel
              </button>
              <button class="btn btn-primary" onclick="saveSpace()">
                Save
              </button>
            </div>
          </div>
        </div>
      </div>
    </Layout>
  )
}
