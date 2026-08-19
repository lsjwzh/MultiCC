'use strict';

// M2 · session-only host features (docs/chat-view-unification-design.md §3-M2,
// the first tranche of the chat.js split). Session identity resolution and the
// header double-click rename belong to session mode only — a task view has no
// rename (the board owns the task title) and no session identity.
//
// Same discipline as chat-task-boot.js: declarations only, no top-level
// execution. This file loads before chat.js; everything it references
// (_sessionName, withToken, updateTabIdentity, renameSessionFromChat, …) is a
// chat.js top-level lexical binding that exists only after chat.js has run.
// chat.js tail calls installSessionIdentityFeatures() in session mode.

// Resolve the friendly "directory / alias" identity from the API and upgrade
// the tab title (the URL only carries the session id). Best-effort: on any
// failure the id-based title stays.
async function loadSessionIdentity() {
  if (!_sessionName) return;
  try {
    const [sessions, dirs] = await Promise.all([
      fetch(withToken('/api/sessions')).then(r => r.json()).catch(() => null),
      fetch(withToken('/api/directories')).then(r => r.json()).catch(() => null),
    ]);
    const sArr = Array.isArray(sessions) ? sessions : (sessions && sessions.sessions) || [];
    const s = sArr.find(x => x.id === _sessionName);
    if (!s) return;
    const alias = (s.label && s.label.trim()) ? s.label.trim() : s.id;
    let dir = '';
    if (s.dirId) {
      const dArr = Array.isArray(dirs) ? dirs : (dirs && dirs.directories) || [];
      const d = dArr.find(x => x.id === s.dirId);
      if (d && d.name) dir = d.name;
    }
    const identity = dir ? `${dir} / ${alias}` : alias;
    updateTabIdentity(identity, alias);
    // Also surface it in the header bar (the visible session title).
    const titleEl = document.getElementById('session-title');
    if (titleEl) { titleEl.textContent = identity; titleEl.title = identity; }
  } catch (e) { /* keep the id-based title */ }
}

// Double-click the visible session title in the header to rename it.
// Uses event delegation so it works even if the span is repopulated later.
function installSessionRename() {
  const titleEl = document.getElementById('session-title');
  if (titleEl) titleEl.style.cursor = 'pointer';
  document.addEventListener('dblclick', (ev) => {
    const el = ev.target.closest('#session-title');
    if (!el) return;
    ev.preventDefault();
    ev.stopPropagation();
    renameSessionFromChat();
  });
}

function installSessionIdentityFeatures() {
  loadSessionIdentity();
  installSessionRename();
}
