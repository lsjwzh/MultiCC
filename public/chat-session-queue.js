(function attachMultiCCChatSessionQueue(global) {
  'use strict';

  let configuredOnCancel = null;
  let configuredOnInsert = null;

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
        ? '已移到队首；classify 允许后立即执行'
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
    hint.textContent = metadata.state === 'frozen'
      ? `已暂停：${metadata.freezeReason || '等待当前任务继续'}`
      : metadata.state === 'assessing'
        ? '等待完成判定，队列已暂停'
        : '当前回复完成后自动发送';
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
          insert.textContent = item.priority ? '队首' : '立刻插入';
          insert.title = item.priority
            ? '这条消息已经位于队首'
            : '将这条消息移到队首；classify 允许时立即执行';
          insert.disabled = item.priority === true;
          insert.setAttribute?.('aria-label', `将第 ${Number(item.position) || index + 1} 条消息立刻插入队首`);
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
