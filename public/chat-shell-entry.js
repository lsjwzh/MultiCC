(function (root) {
  'use strict';
  function chatUrl(sessionId, options = {}) {
    if (!sessionId) throw new Error('session_required');
    const params = new URLSearchParams({ session: sessionId });
    if (options.external) params.set('external', options.external);
    return `/chat.html?${params.toString()}`;
  }

  async function resolve({ sessionId, taskId, fetch }) {
    async function post(url, body) {
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      let data;
      try { data = await response.json(); } catch (_) { data = { code: `HTTP ${response.status}` }; }
      if (!response.ok || data.ok === false) throw Object.assign(new Error(data.message || data.error || data.code || `HTTP ${response.status}`), {
        code: data.code, status: response.status,
      });
      return data;
    }
    // Ordinary session links already are the canonical full chat UI. Only a
    // task-board link needs resolving before the page can connect.
    if (!taskId) return null;
    const bound = await post(`/api/task-board/tasks/${encodeURIComponent(taskId)}/chat-session`);
    if (!bound.sessionId) throw new Error('chat_session_missing');
    sessionId = bound.sessionId;
    let shell;
    shell = await post('/api/task-shells', { sessionId });
    if (!shell.id) throw new Error('shell_missing');
    try {
      const task = await post(`/api/task-shells/${encodeURIComponent(shell.id)}/tasks/resolve`, { taskId });
      sessionId = task.sessionId || sessionId;
    } catch (error) {
      // During the brief merge-before-restart window the new static client can
      // meet the previous route table. The bound chat remains usable.
      if (!(error.status === 404 && error.code === 'HTTP 404')) throw error;
    }
    return chatUrl(sessionId);
  }

  function createTransportAdapter(options = {}) {
    const rawSend = options.send || (() => false);
    const makeClientMsgId = options.makeClientMsgId || (() => `shell-${Date.now()}`);
    let enabled = false;
    let controlTurnId = null;
    let pending = null;
    let buffered = [];
    const receiptClients = new Map();

    function remapClient(message) {
      const id = message?.clientMsgId == null ? '' : String(message.clientMsgId);
      return id && receiptClients.has(id) ? { ...message, clientMsgId: receiptClients.get(id) } : message;
    }

    function historyRecords(message) {
      if (message?.type === 'chat_msg_meta') return message.message ? [message.message] : [];
      if (message?.type === 'chat_history' && Array.isArray(message.messages)) return message.messages;
      return [];
    }

    function remap(message) {
      const mapped = remapClient(message);
      // The renderer matches the admission bubble against the committed record,
      // not its envelope. Reconnect history must use that same browser identity.
      if (message?.type === 'chat_msg_meta' && message.message) {
        return { ...mapped, message: remapClient(message.message) };
      }
      if (message?.type === 'chat_history' && Array.isArray(message.messages)) {
        return { ...mapped, messages: message.messages.map(remapClient) };
      }
      return mapped;
    }

    function ingest(message) {
      if (typeof message?.turnId === 'string' && message.turnId) controlTurnId = message.turnId;
      if (message?.type === 'system' && message.subtype === 'init' && 'is_streaming' in message) {
        enabled = message.taskShell === true;
      }
      const awaitingReceipt = pending && [message, ...historyRecords(message)].some(record => {
        const id = record?.clientMsgId == null ? '' : String(record.clientMsgId);
        return id.startsWith('sr_') && !receiptClients.has(id);
      });
      if (awaitingReceipt) {
        buffered.push(message);
        return { events: [] };
      }
      if (message?.type === 'task_shell_routed') {
        const receiptId = message.receiptId == null ? '' : String(message.receiptId);
        const clientMsgId = message.clientMsgId == null ? '' : String(message.clientMsgId);
        if (receiptId && clientMsgId) receiptClients.set(receiptId, clientMsgId);
        pending = null;
        const events = buffered.map(remap);
        buffered = [];
        return { events, routeSessionId: message.sessionId ? String(message.sessionId) : '' };
      }
      if (message?.type === 'error' && message.notDelivered === true
          && pending?.clientMsgId === message.clientMsgId) {
        pending = null;
        // A reconnect page may contain older, unmapped receipts. A failed new
        // send must not discard those already committed messages.
        const events = buffered.filter(event => ['chat_msg_meta', 'chat_history'].includes(event.type)).map(remap);
        buffered = [];
        return { events: [...events, remap(message)] };
      }
      return { events: [remap(message)] };
    }

    function send(payload) {
      if (!enabled || !['user_message', 'cancel'].includes(payload?.type)) return rawSend(payload);
      if (pending) return false;
      const message = { ...payload, taskShell: true };
      if (message.type === 'cancel') {
        if (!controlTurnId) return false;
        message.turnId = controlTurnId;
        message.clientMsgId = message.clientMsgId || makeClientMsgId();
      } else if (message.userInputRequestId) {
        if (!controlTurnId) return false;
        message.turnId = controlTurnId;
      }
      pending = message;
      try {
        if (rawSend(message)) return true;
      } catch (error) {
        pending = null;
        throw error;
      }
      pending = null;
      return false;
    }

    function replayPending() { return pending ? rawSend(pending) : false; }
    function state() { return { enabled, controlTurnId, pending: pending && { ...pending } }; }
    return Object.freeze({ ingest, replayPending, send, state });
  }

  const api = { chatUrl, createTransportAdapter, resolve };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.MultiCCChatShellEntry = api;
})(typeof window !== 'undefined' ? window : globalThis);
