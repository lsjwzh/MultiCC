'use strict';

let autoRefreshTimer = null;

function formatTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatRelative(iso) {
  const diff = Math.floor((Date.now() - new Date(iso)) / 1000);
  if (diff < 5) return 'just now';
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

async function loadSessions() {
  try {
    const res = await fetch('/api/sessions');
    const sessions = await res.json();
    renderSessions(sessions);
  } catch (err) {
    console.error('Failed to load sessions:', err);
    document.getElementById('session-list').innerHTML =
      `<div class="empty-state"><p style="color:#f85149">Failed to load sessions: ${err.message}</p></div>`;
  }
}

function renderSessions(sessions) {
  const el = document.getElementById('session-list');

  if (sessions.length === 0) {
    el.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🖥️</div>
        <p>No active sessions</p>
        <button class="btn btn-green" onclick="newSession()">+ New Session</button>
      </div>`;
    return;
  }

  const rows = sessions.map(s => `
    <tr>
      <td><span class="session-id">${s.id}</span></td>
      <td class="time-cell" title="${s.createdAt}">${formatTime(s.createdAt)}</td>
      <td class="time-cell" title="${s.lastActivity}">${formatRelative(s.lastActivity)}</td>
      <td>
        <span class="client-badge ${s.clients === 0 ? 'zero' : ''}">
          ${s.clients} connected
        </span>
      </td>
      <td>
        <div class="actions">
          <button class="btn" onclick="openSession('${s.id}')">Open</button>
          <button class="btn btn-danger" onclick="deleteSession('${s.id}')">Delete</button>
        </div>
      </td>
    </tr>
  `).join('');

  el.innerHTML = `
    <table class="session-table">
      <thead>
        <tr>
          <th>Session ID</th>
          <th>Created</th>
          <th>Last Activity</th>
          <th>Clients</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function openSession(id) {
  window.open(`/?id=${id}`, '_blank');
}

async function deleteSession(id) {
  if (!confirm(`Delete session ${id}?\nThe PTY process will be terminated.`)) return;
  try {
    const res = await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      const err = await res.json();
      showToast(`Error: ${err.error}`, true);
      return;
    }
    showToast(`Session ${id} deleted`);
    loadSessions();
  } catch (err) {
    showToast(`Error: ${err.message}`, true);
  }
}

function newSession() {
  window.open('/', '_blank');
  // Refresh after a short delay so the new session appears
  setTimeout(loadSessions, 800);
}

function showToast(msg, isError = false) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.style.background = isError ? '#f85149' : '#238636';
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2500);
}

// ── Voice Settings ──
async function loadVoiceSettings() {
  try {
    const res = await fetch('/api/settings/voice');
    const data = await res.json();
    document.getElementById('vs-base-url').value = data.baseUrl || '';
    document.getElementById('vs-api-key').value = '';
    document.getElementById('vs-api-key').placeholder = data.hasKey ? data.apiKey : 'sk-or-v1-...';
    document.getElementById('vs-model').value = data.model || '';
    // Whisper fields
    document.getElementById('ws-base-url').value = data.whisperBaseUrl || '';
    document.getElementById('ws-api-key').value = '';
    document.getElementById('ws-api-key').placeholder = data.hasWhisperKey ? data.whisperApiKey : 'gsk_... (留空则复用 OpenRouter Key)';
    document.getElementById('ws-model').value = data.whisperModel || '';
    document.getElementById('ws-language').value = data.whisperLanguage || 'zh';
    document.getElementById('ws-prompt').value = data.whisperPrompt || '';
  } catch (_) {}
}

async function saveVoiceSettings() {
  const vsStatus = document.getElementById('vs-status');
  const wsStatus = document.getElementById('ws-status');
  const body = {};
  const baseUrl = document.getElementById('vs-base-url').value.trim();
  const apiKey = document.getElementById('vs-api-key').value.trim();
  const model = document.getElementById('vs-model').value.trim();
  if (baseUrl) body.baseUrl = baseUrl;
  if (apiKey) body.apiKey = apiKey;
  if (model) body.model = model;
  // Whisper fields
  const wsBaseUrl = document.getElementById('ws-base-url').value.trim();
  const wsApiKey = document.getElementById('ws-api-key').value.trim();
  const wsModel = document.getElementById('ws-model').value.trim();
  if (wsBaseUrl) body.whisperBaseUrl = wsBaseUrl;
  if (wsApiKey) body.whisperApiKey = wsApiKey;
  if (wsModel) body.whisperModel = wsModel;
  const wsLanguage = document.getElementById('ws-language').value.trim();
  const wsPrompt = document.getElementById('ws-prompt').value.trim();
  body.whisperLanguage = wsLanguage;  // always send (empty string = auto-detect)
  body.whisperPrompt = wsPrompt;      // always send (empty string = no static prompt)

  if (Object.keys(body).length === 0) {
    vsStatus.textContent = 'No changes';
    vsStatus.className = 'status-text';
    wsStatus.textContent = 'No changes';
    wsStatus.className = 'status-text';
    return;
  }

  try {
    const res = await fetch('/api/settings/voice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    vsStatus.textContent = 'Saved — changes take effect immediately';
    vsStatus.className = 'status-text ok';
    wsStatus.textContent = 'Saved — changes take effect immediately';
    wsStatus.className = 'status-text ok';
    showToast('Voice settings saved');
    loadVoiceSettings(); // refresh display (re-mask key)
  } catch (err) {
    vsStatus.textContent = `Save failed: ${err.message}`;
    vsStatus.className = 'status-text err';
    wsStatus.textContent = `Save failed: ${err.message}`;
    wsStatus.className = 'status-text err';
  }
}

// Initial load
loadSessions();
loadVoiceSettings();

// Auto-refresh every 5 seconds
autoRefreshTimer = setInterval(loadSessions, 5000);
