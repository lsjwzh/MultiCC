(function attachMultiCCChatSessionQueue(global) {
  'use strict';

  let configuredOnCancel = null;
  let configuredOnInsert = null;
  let configuredOnReorder = null;

  // Per-action wording, in one place: the request/response handling is the same
  // for every queue action, only the words differ.
  const ACTION_LABELS = {
    cancel_queued: '移除',
    insert_queued: '插入',
    reorder_queued: '移动',
  };
  const ACTION_DONE = {
    cancel_queued: '已移除暂存消息',
    insert_queued: '已停止当前回复并直接执行所选消息',
    reorder_queued: '已调整暂存消息顺序',
  };

  // Shared status registry (public/status-presentation.js), resolved lazily so
  // this module keeps working in Node tests and before the script tag is reached.
  function statusRegistry() {
    return global.MultiCCStatusPresentation
      || (typeof require === 'function' ? require('./status-presentation.js') : null);
  }

  function configure({ onCancel = null, onInsert = null, onReorder = null } = {}) {
    configuredOnCancel = typeof onCancel === 'function' ? onCancel : null;
    configuredOnInsert = typeof onInsert === 'function' ? onInsert : null;
    configuredOnReorder = typeof onReorder === 'function' ? onReorder : null;
  }

  function createActionHandler(action, {
    fetch: fetchImpl,
    withToken,
    getSessionName,
    notify = () => {},
    payloadFor = () => ({}),
  } = {}) {
    return async (entryId, argument) => {
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
          ...payloadFor(argument),
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok !== true) {
        const message = data.code === 'queued_entry_already_claimed'
          ? '这条消息已经开始执行，无法再调整。'
          : `${ACTION_LABELS[action] || '操作'}失败：${data.error || data.code || response.status}`;
        notify(message, 'error');
        throw new Error(message);
      }
      notify(ACTION_DONE[action] || '已更新暂存消息', 'completed');
      return true;
    };
  }

  function createCancelHandler(options) {
    return createActionHandler('cancel_queued', options);
  }

  function createInsertHandler(options) {
    return createActionHandler('insert_queued', options);
  }

  // Moving a staged message takes the position the row should end up at, counted
  // from the top of the list the user is looking at — the same list the server
  // renders, so the two sides always mean the same index by "position 1".
  function createReorderHandler(options = {}) {
    return createActionHandler('reorder_queued', {
      ...options,
      payloadFor: argument => (
        argument && typeof argument === 'object'
          ? { toIndex: Number(argument.toIndex) }
          : { toIndex: Number(argument) }
      ),
    });
  }

  // A drag that survives a re-render: the dock rebuilds its rows on every queue
  // event, which detaches the nodes a live gesture is holding. Rendering again
  // mid-drag therefore cancels the gesture instead of committing a move that
  // was computed against rows the user can no longer see.
  let activeReorder = null;

  // Dragging uses pointer events, not HTML5 drag-and-drop: the dock is used on
  // touch screens, where HTML5 drag needs a long-press and never fires for a
  // finger slide. The handle is a real button, so the same move is available
  // from the keyboard (↑/↓) to anyone who cannot drag at all.
  function attachReorder(list, rows, onReorder) {
    let drag = null;

    function release() {
      if (!drag) return;
      const { row, pointerId } = drag;
      try { row.releasePointerCapture?.(pointerId); } catch (_) { /* already gone */ }
      row.classList.remove('session-queue-dragging');
      list.classList.remove('session-queue-reordering');
      for (const record of rows) record.row.style.transform = '';
      drag = null;
    }

    // Which row the pointer is over, measured against the layout as it stood
    // when the drag started: the rows move during the gesture, so re-measuring
    // would let the target chase its own animation.
    function indexFor(clientY) {
      const middle = index => {
        const rect = drag.rects[index];
        return rect.top + rect.height / 2;
      };
      if (clientY < middle(drag.from)) {
        for (let i = 0; i < drag.from; i += 1) if (clientY < middle(i)) return i;
        return drag.from;
      }
      let target = drag.from;
      for (let i = drag.from + 1; i < rows.length; i += 1) {
        if (clientY > middle(i)) target = i;
      }
      return target;
    }

    // Rows between the old and the new slot close the gap the dragged row
    // leaves behind, by its own height — rows are not all the same height.
    function applyOffsets(target) {
      const gap = drag.rects[drag.from].height;
      rows.forEach((record, index) => {
        if (index === drag.from) return;
        const shifted = drag.from < target
          ? index > drag.from && index <= target
          : index >= target && index < drag.from;
        record.row.style.transform = shifted ? `translateY(${drag.from < target ? -gap : gap}px)` : '';
      });
    }

    // Draw the result of a finished drag locally, so the dock answers the user
    // immediately; the queue event that follows carries the server's answer and
    // rebuilds the list from it, which is what corrects a refused move.
    function applyLocalOrder(from, target) {
      const order = rows.slice();
      const [moved] = order.splice(from, 1);
      order.splice(target, 0, moved);
      order.forEach((record, index) => {
        const label = record.row.querySelector?.('.session-queue-position');
        // Renumbered too: leaving "3." on the entry now sitting first would
        // make the dock contradict itself until the server answer lands.
        if (label) label.textContent = `${index + 1}.`;
        list.appendChild(record.row);
      });
      rows.length = 0;
      rows.push(...order);
    }

    function begin(event, record) {
      if (drag || event.button > 0 || !record.item?.entryId) return;
      drag = {
        pointerId: event.pointerId,
        from: record.index,
        target: record.index,
        startY: event.clientY,
        rects: rows.map(candidate => candidate.row.getBoundingClientRect()),
        row: record.row,
        moved: false,
      };
      record.row.classList.add('session-queue-dragging');
      list.classList.add('session-queue-reordering');
      try { record.handle.setPointerCapture?.(event.pointerId); } catch (_) { /* no capture */ }
      // Keep the gesture from selecting the message text or scrolling instead.
      event.preventDefault?.();
    }

    function move(event) {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const dy = event.clientY - drag.startY;
      // A few pixels of slop, so a tap on the handle stays a tap rather than
      // becoming a one-row move on its own.
      if (!drag.moved && Math.abs(dy) < 4) return;
      drag.moved = true;
      drag.row.style.transform = `translateY(${dy}px)`;
      const target = indexFor(event.clientY);
      if (target !== drag.target) {
        drag.target = target;
        applyOffsets(target);
      }
      event.preventDefault?.();
    }

    function end(event) {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const { from, target, moved } = drag;
      const entryId = rows[from]?.item?.entryId;
      release();
      if (!moved || target === from || !entryId) return;
      applyLocalOrder(from, target);
      onReorder(entryId, target);
    }

    for (const record of rows) {
      if (!record.handle) continue;
      record.handle.addEventListener('pointerdown', event => begin(event, record));
      record.handle.addEventListener('pointermove', move);
      record.handle.addEventListener('pointerup', end);
      record.handle.addEventListener('pointercancel', () => release());
      // Keyboard parity: the handle is a button, and ↑/↓ move the row one slot.
      record.handle.addEventListener('keydown', event => {
        const step = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
        if (!step || !record.item?.entryId) return;
        const target = record.index + step;
        if (target < 0 || target >= rows.length) return;
        event.preventDefault?.();
        onReorder(record.item.entryId, target);
      });
    }
    return release;
  }

  function render(rawItems, metadata = {}, documentRef = global.document) {
    const dock = documentRef?.getElementById('session-queue-dock');
    const count = documentRef?.getElementById('session-queue-count');
    const hint = documentRef?.getElementById('session-queue-hint');
    const list = documentRef?.getElementById('session-queue-list');
    if (!dock || !count || !hint || !list) return;
    // The rows a live drag is holding are about to be thrown away.
    if (activeReorder) {
      activeReorder();
      activeReorder = null;
    }
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
    const onReorder = typeof metadata.onReorder === 'function'
      ? metadata.onReorder : configuredOnReorder;
    list.replaceChildren();
    const rows = [];
    for (const [index, item] of items.entries()) {
      const row = documentRef.createElement('div');
      row.className = 'session-queue-item';
      const movability = item?.entryId && item?.state === 'pending'
        && typeof onReorder === 'function' ? item : null;
      const handle = movability && items.length > 1
        ? documentRef.createElement('button') : null;
      if (handle) {
        handle.type = 'button';
        handle.className = 'session-queue-handle';
        handle.textContent = '⠿';
        handle.title = '拖动调整顺序，或用 ↑/↓ 移动';
        handle.setAttribute?.('aria-label', `调整第 ${Number(item.position) || index + 1} 条暂存消息的顺序`);
      }
      const position = documentRef.createElement('span');
      position.className = 'session-queue-position';
      position.textContent = `${Number(item?.position) || index + 1}.`;
      const text = documentRef.createElement('div');
      text.className = 'session-queue-text';
      text.textContent = String(item?.text || '（暂存消息）');
      if (handle) row.appendChild(handle);
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
      rows.push({ row, item, index, handle });
      list.appendChild(row);
    }
    if (typeof onReorder === 'function' && items.length > 1) {
      activeReorder = attachReorder(list, rows, onReorder);
    }
  }

  global.MultiCCChatSessionQueue = Object.freeze({
    configure,
    createCancelHandler,
    createInsertHandler,
    createReorderHandler,
    render,
  });
})(typeof window !== 'undefined' ? window : globalThis);
