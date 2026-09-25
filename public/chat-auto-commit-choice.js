(function (root) {
  'use strict';
  function create({ document, storage, sessionId, lastBubble, defaultChecked, translate }) {
    function autoCommitChoiceKeys(bubble) {
      if (!bubble) return [];
      return ['msgId', 'clientMsgId'].filter(key => bubble.dataset[key]).map(key =>
        `multicc:auto-commit:${sessionId()}:${key}:${bubble.dataset[key]}`);
    }
    function rememberAutoCommitChoice(bubble) {
      const row = bubble?.querySelector('.msg-auto-commit');
      const cb = row?.querySelector('input[type="checkbox"]');
      if (!cb) return;
      try {
        for (const key of autoCommitChoiceKeys(bubble)) storage().setItem(key, JSON.stringify({
          checked: cb.checked, touched: !!row.dataset.userTouched, done: row.classList.contains('done'),
        }));
      } catch (_) {}
    }
    function syncAutoCommitChoice(force = false) {
      const row = lastBubble()?.querySelector('.msg-auto-commit');
      const cb = row?.querySelector('input[type="checkbox"]');
      if (!cb || row.classList.contains('done')) return;
      if (force) delete row.dataset.userTouched;
      if (!row.dataset.userTouched) cb.checked = defaultChecked();
      rememberAutoCommitChoice(lastBubble());
    }

    function attachAutoCommitCheck(bubbleEl, checked) {
      if (!bubbleEl) return null;
      // A 🔇 system-inject card is not a user turn: it owns no per-turn commit
      // choice, whether the bubble came from a live send or a history reload.
      if (bubbleEl.classList && bubbleEl.classList.contains('system-inject')) return null;
      // User bubbles hold their text directly (no .msg-content wrapper); attach to
      // the bubble itself in that case so the checkbox sits under "我" message.
      const ce = bubbleEl.querySelector('.msg-content') || bubbleEl;
      // Remove any existing auto-commit line
      const old = ce.querySelector('.msg-auto-commit');
      if (old) old.remove();
      const row = document.createElement('div');
      row.className = 'msg-auto-commit';
      row.title = translate('autoCommitTitle');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!checked;
      try {
        const choice = autoCommitChoiceKeys(bubbleEl).map(key => JSON.parse(storage().getItem(key))).find(Boolean);
        if (choice?.touched) { cb.checked = choice.checked === true; row.dataset.userTouched = '1'; }
        if (choice?.done) { cb.checked = choice.checked === true; row.classList.add('done'); }
      } catch (_) {}
      row.appendChild(cb);
      row.appendChild(document.createTextNode(' ' + translate('autoCommitPerMsg')));
      // Toggle when clicking the label area
      row.addEventListener('click', (e) => {
        if (e.target === cb) return; // native checkbox handles itself
        cb.checked = !cb.checked;
        row.dataset.userTouched = '1';
        rememberAutoCommitChoice(bubbleEl);
      });
      cb.addEventListener('change', () => { row.dataset.userTouched = '1'; rememberAutoCommitChoice(bubbleEl); });
      // Attribution is the physical bottom tail. A history-rendered user bubble
      // may already have it when this per-turn control is restored, so keep the
      // checkbox immediately above the tail instead of pushing ownership upward.
      const taskTail = ce === bubbleEl ? bubbleEl.querySelector('.msg-task-tail') : null;
      if (taskTail) ce.insertBefore(row, taskTail);
      else ce.appendChild(row);
      return cb;
    }

    return { remember: rememberAutoCommitChoice, sync: syncAutoCommitChoice, attach: attachAutoCommitCheck };
  }
  root.MultiCCAutoCommitChoice = { create };
})(typeof window !== 'undefined' ? window : globalThis);
