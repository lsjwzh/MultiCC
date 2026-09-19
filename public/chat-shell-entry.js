(function (root) {
  'use strict';
  function chatUrl(sessionId, options = {}) {
    if (!sessionId) throw new Error('session_required');
    const params = new URLSearchParams({ session: sessionId });
    if (options.external) params.set('external', options.external);
    if (options.air) params.set('air', '1');
    return `/chat.html?${params.toString()}`;
  }

  async function resolve({ sessionId, taskId, fetch, air = false }) {
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
    if (bound.readOnly) {
      const params = new URLSearchParams({ task: taskId, readOnly: '1' });
      if (air) params.set('air', '1');
      return `/chat.html?${params.toString()}`;
    }
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
    return chatUrl(sessionId, { air });
  }

  function createTransportAdapter(options = {}) {
    const rawSend = options.send || (() => false);
    const makeClientMsgId = options.makeClientMsgId || (() => `shell-${Date.now()}`);
    let enabled = false;
    let controlTurnId = null;
    // 已经交给 socket、还没等到路由回执的那几条（浏览器 clientMsgId → 原文）。
    // 回执要回答两件事：这条是哪个浏览器身份，以及它所属的任务现在跑在哪个
    // 会话里 —— 所以在这之前它自己的回显只能压着（见下面 buffered）。但那是
    // 「压住回显」的理由，不是「压住下一条」的理由：服务端本来就有按会话的持久
    // FIFO，客户端再拦一道的结果只是把这条消息丢掉，还让 composer 把健康的
    // socket 报成断开、把刚清空的输入框又填回去。
    const awaiting = new Map();
    let buffered = [];
    const receiptClients = new Map();

    function text(value) { return value == null ? '' : String(value); }

    function remapClient(message) {
      const id = message?.clientMsgId == null ? '' : String(message.clientMsgId);
      return id && receiptClients.has(id) ? { ...message, clientMsgId: receiptClients.get(id) } : message;
    }

    function historyRecords(message) {
      if (message?.type === 'chat_msg_meta') return message.message ? [message.message] : [];
      if (message?.type === 'chat_history' && Array.isArray(message.messages)) return message.messages;
      return [];
    }

    function recordsOf(message) { return [message, ...historyRecords(message)]; }

    // 一条事件只要带着还没认领的回执 id（服务端把 task-shell 的投递写成
    // clientMsgId = receipt.id），就不能现在放出去：不然它会先按回执 id 渲染
    // 一个气泡，回执到了再按浏览器 id 渲染第二个。
    function unmappedReceipt(event) {
      return recordsOf(event).some(record => {
        const id = text(record?.clientMsgId);
        return id.startsWith('sr_') && !receiptClients.has(id);
      });
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
      if (awaiting.size && unmappedReceipt(message)) { buffered.push(message); return { events: [] }; }
      if (message?.type === 'task_shell_routed') {
        const receiptId = text(message.receiptId);
        const clientMsgId = text(message.clientMsgId);
        if (receiptId && clientMsgId) {
          receiptClients.set(receiptId, clientMsgId);
          awaiting.delete(clientMsgId);
        }
        // 只放行这一份回执认领过的：还在等自己回执的那些继续压着，否则它们会
        // 先用回执 id 露面。
        const events = [];
        buffered = buffered.filter(event => {
          if (unmappedReceipt(event)) return true;
          events.push(remap(event));
          return false;
        });
        return { events, routeSessionId: message.sessionId ? String(message.sessionId) : '' };
      }
      if (message?.type === 'error' && message.notDelivered === true
          && awaiting.has(text(message.clientMsgId))) {
        const receiptId = text(message.receiptId);
        awaiting.delete(text(message.clientMsgId));
        // A reconnect page may contain older, unmapped receipts. A failed new
        // send must not discard those already committed messages.
        const events = [];
        buffered = buffered.filter(event => {
          const ids = recordsOf(event).map(record => text(record?.clientMsgId));
          // 这条没能投出去：它自己的回显（按回执 id 认）直接丢掉。
          if (receiptId && ids.includes(`sr_${receiptId}`)) return false;
          // 落库的权威历史照放行 —— 重连页里可能夹着更早、再也不会有回执的条目。
          if (['chat_msg_meta', 'chat_history'].includes(event.type)) { events.push(remap(event)); return false; }
          return true;
        });
        return { events: [...events, remap(message)] };
      }
      return { events: [remap(message)] };
    }

    function send(payload) {
      if (!enabled || !['user_message', 'cancel'].includes(payload?.type)) return rawSend(payload);
      const message = { ...payload, taskShell: true };
      if (message.type === 'cancel') {
        if (!controlTurnId) return false;
        message.turnId = controlTurnId;
        message.clientMsgId = message.clientMsgId || makeClientMsgId();
      } else if (message.userInputRequestId) {
        if (!controlTurnId) return false;
        message.turnId = controlTurnId;
      }
      const clientMsgId = text(message.clientMsgId);
      awaiting.set(clientMsgId, message);
      try {
        if (rawSend(message)) return true;
      } catch (error) {
        awaiting.delete(clientMsgId);
        throw error;
      }
      // socket 没接（返回 false）：这条没出去，别留成在途。
      awaiting.delete(clientMsgId);
      return false;
    }

    // 重连后把还没回执的那几条按原顺序重放一遍：每条都带着自己的 clientMsgId，
    // 服务端按回执 id 去重，重放安全。
    function replayPending() {
      let resent = false;
      for (const message of awaiting.values()) {
        try { if (rawSend(message)) resent = true; } catch (_) { /* 留着下次重连再试 */ }
      }
      return resent;
    }
    function state() {
      const first = awaiting.values().next();
      return { enabled, controlTurnId, pending: first.done ? null : { ...first.value } };
    }
    return Object.freeze({ ingest, replayPending, send, state });
  }

  function createShellView({ sourceSessionId, taskId = null, disabled = false, request, onSession = () => {}, onTarget = () => {} }) {
    let shellId = null, activeSessionId = sourceSessionId, unsupported = disabled || !sourceSessionId;
    let opening = null;
    // The shell's input cursor as a display handle: which task the next message
    // goes to ("下一条发给 #ABCD"). A read of the scope response, never a
    // second request, and never a change to where a message is delivered.
    let target = null;
    async function prepare() {
      if (unsupported) return activeSessionId;
      if (!shellId) {
        opening ||= request('/api/task-shells', { method: 'POST', json: { sessionId: sourceSessionId } });
        try { shellId = (await opening).id; }
        catch (error) {
          opening = null;
          if (error.code === 'unsupported_source' || error.payload?.code === 'unsupported_source') {
            unsupported = true; return activeSessionId;
          }
          throw error;
        }
      }
      const scope = await request(`/api/task-shells/${encodeURIComponent(shellId)}/chat`);
      activeSessionId = scope.activeSessionId;
      target = { taskId: scope.taskId || null, code: scope.taskShortCode || '' };
      root.MultiCCTaskArtifacts?.setScope({ shellId });
      onSession(activeSessionId);
      onTarget(target);
      return activeSessionId;
    }
    function record(message, origin = activeSessionId) {
      if (!message || message.sourceSessionId || !message.id) return message;
      return { ...message, id: `${origin}:${message.id}`, sourceSessionId: origin, sourceMessageId: message.id };
    }
    function event(message) {
      if (!shellId) return message;
      const origin = message.sourceSessionId || activeSessionId;
      if (message.type === 'chat_msg_meta') return { ...record(message, origin), message: record(message.message, origin) };
      if (['chat_history', 'chat_history_reset', 'chat_history_annotation'].includes(message.type)) {
        return { ...message, messages: (message.messages || []).map(m => record(m, origin)) };
      }
      if (message.type === 'chat_msg_deleted') return { ...message, id: `${origin}:${message.id}` };
      return message;
    }
    return { prepare, event, get shellId() { return shellId; }, get activeSessionId() { return activeSessionId; },
      get target() { return target; },
      historyUrl: () => disabled && taskId ? `/api/task-shell-tasks/${encodeURIComponent(taskId)}/history`
        : shellId ? `/api/task-shells/${encodeURIComponent(shellId)}/history`
        : `/api/sessions/${encodeURIComponent(activeSessionId)}/history` };
  }

  const api = { chatUrl, createTransportAdapter, createShellView, resolve };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.MultiCCChatShellEntry = api;
})(typeof window !== 'undefined' ? window : globalThis);
