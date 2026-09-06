'use strict';

// M2 · task-mode host boot (docs/chat-view-unification-design.md §3-M2).
//
// chat.js is a capped host (3000-line budget, tests/test-chat-event-controller
// pins it); these three adapters are the DOM/host side of
// chat-task-mode.js and live here instead. This file must contain function
// declarations ONLY — no top-level execution: it loads before chat.js, and
// every binding it references (messagesEl, ws, chatEventController,
// TASK_MODE, …) is a chat.js top-level lexical declaration
// that only exists once chat.js has run. Calling any of these functions
// earlier than the chat.js tail `bootTaskMode()` would be a TDZ
// ReferenceError; the declarations themselves are hoisted and harmless.

// A slim divider above a run's first message. Anchored by the run's first
// message id when known (initial page / reconcile); appended at the bottom
// when a new run starts live.
function renderRunSeparator(info) {
  const el = document.createElement('div');
  el.className = 'run-separator';
  if (info.runId) el.dataset.runId = info.runId;
  const suffix = info.status && info.status !== 'running' ? ` · ${info.status}` : '';
  el.textContent = `— Run ${info.n}${suffix} —`;
  const anchor = info.beforeMessageId
    ? messagesEl.querySelector(`[data-msg-id="${CSS.escape(String(info.beforeMessageId))}"]`)
    : null;
  if (anchor) messagesEl.insertBefore(el, anchor);
  else messagesEl.appendChild(el);
}

// The task DTO drives the tab identity and the visible header title.
function updateTaskIdentity(dto) {
  const title = (dto && dto.title) || _taskId;
  updateTabIdentity(title, _taskId);
  const titleEl = document.getElementById('session-title');
  if (titleEl) { titleEl.textContent = title; titleEl.title = title; }
  // M3: once the task owns a worktree, surface the diff dock's floating
  // button — the task's per-task worktree diff is one tap away.
  if (dto && dto.worktreePath && window.chatDiffViewer
      && typeof window.chatDiffViewer.setTaskContext === 'function') {
    window.chatDiffViewer.setTaskContext(_taskId);
  }
}

// P2 · task chat = ordinary chat. Get-or-create the task's 1:1 bound hidden
// session first; when the server provides one, hand off to the plain session
// chat (tool cards, usage, memory injection, resume continuity — the full
// session feature set) instead of projecting the ledger. location.replace
// keeps the ?task= URL out of history, so Back returns to the board. Any
// failure (old server 501, gone task 404, failed create 502, offline) falls
// back to the legacy projection — the handoff can never strand the view.
function bootTaskMode() {
  window.MultiCCChatTaskMode.resolveBoundSession({
    taskId: _taskId,
    fetch: window.fetch.bind(window),
    withToken,
  }).then(boundId => {
    if (boundId) {
      location.replace('chat.html?session=' + encodeURIComponent(boundId) + '&historyScope=archive');
      return;
    }
    bootTaskProjection();
  });
}

// Wires the task adapter to this host's existing pipelines: the shared
// history store → view plan, the event controller (fed unwrapped slot
// events), the composer transport and the staged-bubble commit loop.
function bootTaskProjection() {
  taskMode = window.MultiCCChatTaskMode.createTaskMode({
    taskId: _taskId,
    window,
    fetch: window.fetch.bind(window),
    withToken,
    multiccWsUrl: typeof window.multiccWsUrl === 'function' ? url => window.multiccWsUrl(url) : null,
    WebSocket: window.WebSocket,
    setTimeoutFn: (fn, ms) => setTimeout(fn, ms),
    clearTimeoutFn: id => clearTimeout(id),
    translate: tt,
    addSystemMsg,
    renderRunSeparator,
    updateTaskIdentity,
    statusUpdate: (text, kind) => {
      statusEl.textContent = text;
      statusEl.className = kind === 'connected' ? 'connected' : (kind === 'error' ? 'error' : '');
      // The recovery service wires status clicks to a chat-WS force
      // reconnect; in task mode the status pill is display-only.
      statusEl.onclick = null;
    },
    setWs: socket => { ws = socket; },
    applyHistoryPlan,
    historyStore: chatHistoryStore,
    resetHistoryView: () => { resetHistoryPagination(); chatHistoryView.clearMessages(); },
    handleEvent: (event, generation) => chatEventController.handleEvent(event, generation),
    setCli: value => { chatEventState.currentCli = value; },
    getGeneration: () => _eventGeneration,
    debug: (...args) => dbg('task-mode', args.map(a => String(a && a.message ? a.message : a)).join(' ')),
  });
  taskMode.boot();
}
