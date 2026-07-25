(function attachMultiCCChatSessionQueue(global) {
  'use strict';

  let configuredOnCancel = null;
  let configuredOnInsert = null;

  // Shared status registry (public/status-presentation.js), resolved lazily so
  // this module keeps working in Node tests and before the script tag is reached.
  function statusRegistry() {
    return global.MultiCCStatusPresentation
      || (typeof require === 'function' ? require('./status-presentation.js') : null);
  }

  function configure({ onCancel = null, onInsert = null } = {}) {
    configuredOnCancel = typeof onCancel === 'function' ? onCancel : null;
    configuredOnInsert = typeof onInsert === 'function' ? onInsert : null;
  }

  function createActionHandler(action, {
    fetch: fetchImpl,
    withToken,
    getSessionName,
    notify = () => {},
  } = {}) {
    return async entryId => {
      const sessionName = String(getSessionName?.() || '').trim();
      const cleanEntryId = String(entryId || '').trim();
      if (!sessionName || !cleanEntryId) throw new Error('缺少排队消息标识');
      const response = await fetchImpl(withToken(
        `/api/sessions/${encodeURIComponent(sessionName)}/queue/action`,
      ), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          entryId: cleanEntryId,
          confirm: true,
          ...(action === 'cancel_queued' ? { reason: 'removed from chat queue' } : {}),
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok !== true) {
        const message = data.code === 'queued_entry_already_claimed'
          ? '这条消息已经开始执行，无法再调整。'
          : `${action === 'insert_queued' ? '插入' : '移除'}失败：${data.error || data.code || response.status}`;
        notify(message, 'error');
        throw new Error(message);
      }
      notify(action === 'insert_queued'
        ? '已停止当前回复并直接执行所选消息'
        : '已移除暂存消息', 'completed');
      return true;
    };
  }

  function createCancelHandler(options) {
    return createActionHandler('cancel_queued', options);
  }

  function createInsertHandler(options) {
    return createActionHandler('insert_queued', options);
  }

  function render(rawItems, metadata = {}, documentRef = global.document) {
    const dock = documentRef?.getElementById('session-queue-dock');
    const count = documentRef?.getElementById('session-queue-count');
    const hint = documentRef?.getElementById('session-queue-hint');
    const list = documentRef?.getElementById('session-queue-list');
    if (!dock || !count || !hint || !list) return;
    const items = Array.isArray(rawItems) ? rawItems : [];
    count.textContent = String(items.length);
    dock.hidden = items.length === 0;
    // The dock used to be text-only, so a queue frozen on a configuration problem
    // looked exactly like one waiting for a reply. The glyph comes from the shared
    // registry — ⏸️ for a pause, 🔒 for something the user must go fix — and it is
    // written as text so this element keeps its textContent-only XSS property.
    const registry = statusRegistry();
    const dockStatus = metadata.state === 'frozen'
      ? registry.freezeReasonStatus(metadata.freezeReason)
      : (metadata.state === 'assessing' ? 'running' : 'queued');
    const dockIcon = registry.presentation('session', dockStatus).icon;
    hint.textContent = `${dockIcon} ` + (metadata.state === 'frozen'
      ? `已暂停：${registry.sanitizeReason(metadata.freezeReason) || '等待当前任务继续'}`
      : metadata.state === 'assessing'
        ? '等待完成判定，队列已暂停'
        : '当前回复完成后自动发送');
    const onCancel = typeof metadata.onCancel === 'function'
      ? metadata.onCancel : configuredOnCancel;
    const onInsert = typeof metadata.onInsert === 'function'
      ? metadata.onInsert : configuredOnInsert;
    list.replaceChildren();
    for (const [index, item] of items.entries()) {
      const row = documentRef.createElement('div');
      row.className = 'session-queue-item';
      const position = documentRef.createElement('span');
      position.className = 'session-queue-position';
      position.textContent = `${Number(item?.position) || index + 1}.`;
      const text = documentRef.createElement('div');
      text.className = 'session-queue-text';
      text.textContent = String(item?.text || '（暂存消息）');
      row.append(position, text);
      if (item?.entryId && item?.state === 'pending'
          && (typeof onCancel === 'function' || typeof onInsert === 'function')) {
        const actions = documentRef.createElement('div');
        actions.className = 'session-queue-actions';
        if (typeof onInsert === 'function') {
          const insert = documentRef.createElement('button');
          insert.type = 'button';
          insert.className = 'session-queue-insert';
          insert.textContent = item.priority ? '执行中' : '立刻插入';
          insert.title = item.priority
            ? '这条消息已被选中立即执行'
            : '停止当前回复并立即执行这条消息';
          insert.disabled = item.priority === true;
          insert.setAttribute?.('aria-label', `立即执行第 ${Number(item.position) || index + 1} 条消息`);
          insert.addEventListener('click', async event => {
            event.stopPropagation?.();
            if (insert.disabled) return;
            insert.disabled = true;
            insert.textContent = '插入中…';
            try {
              await onInsert(item.entryId);
            } catch (_) {
              insert.disabled = false;
              insert.textContent = '立刻插入';
            }
          });
          actions.appendChild(insert);
        }
        if (typeof onCancel === 'function') {
          const close = documentRef.createElement('button');
          close.type = 'button';
          close.className = 'session-queue-close';
          close.textContent = '×';
          close.title = '移除这条尚未开始执行的消息';
          close.setAttribute?.('aria-label', `移除第 ${Number(item.position) || index + 1} 条暂存消息`);
          close.addEventListener('click', async event => {
            event.stopPropagation?.();
            if (close.disabled) return;
            close.disabled = true;
            close.textContent = '…';
            try {
              await onCancel(item.entryId);
            } catch (_) {
              close.disabled = false;
              close.textContent = '×';
            }
          });
          actions.appendChild(close);
        }
        row.appendChild(actions);
      }
      list.appendChild(row);
    }
  }

  global.MultiCCChatSessionQueue = Object.freeze({
    configure,
    createCancelHandler,
    createInsertHandler,
    render,
  });
})(typeof window !== 'undefined' ? window : globalThis);
