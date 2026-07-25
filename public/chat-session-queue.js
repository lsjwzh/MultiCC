(function attachMultiCCChatSessionQueue(global) {
  'use strict';

  let configuredOnCancel = null;

  function configure({ onCancel = null } = {}) {
    configuredOnCancel = typeof onCancel === 'function' ? onCancel : null;
  }

  function createCancelHandler({
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
          action: 'cancel_queued',
          entryId: cleanEntryId,
          confirm: true,
          reason: 'cancelled from chat queue',
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok !== true) {
        const message = data.code === 'queued_entry_already_claimed'
          ? '这条消息已经开始执行，无法从排队列表取消。'
          : `取消失败：${data.error || data.code || response.status}`;
        notify(message, 'error');
        throw new Error(message);
      }
      notify('已取消排队消息', 'completed');
      return true;
    };
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
          && typeof onCancel === 'function') {
        const cancel = documentRef.createElement('button');
        cancel.type = 'button';
        cancel.className = 'session-queue-cancel';
        cancel.textContent = '取消';
        cancel.title = '取消这条尚未开始执行的消息';
        cancel.setAttribute?.('aria-label', `取消第 ${Number(item.position) || index + 1} 条排队消息`);
        cancel.addEventListener('click', async event => {
          event.stopPropagation?.();
          if (cancel.disabled) return;
          cancel.disabled = true;
          cancel.textContent = '取消中…';
          try {
            await onCancel(item.entryId);
          } catch (_) {
            cancel.disabled = false;
            cancel.textContent = '取消';
          }
        });
        row.appendChild(cancel);
      }
      list.appendChild(row);
    }
  }

  global.MultiCCChatSessionQueue = Object.freeze({ configure, createCancelHandler, render });
})(typeof window !== 'undefined' ? window : globalThis);
