(function (root) {
  'use strict';

  function text(value) { return typeof value === 'string' ? value.trim() : ''; }

  // Only a real four-character display code may be shown; the chip must never
  // turn an arbitrary taskId suffix into something that looks like a handle.
  function codeOf(value) {
    const code = text(value).toUpperCase();
    return /^[0-9A-Z]{4}$/.test(code) ? code : '';
  }

  // 「下一条发给 #ABCD」：壳的输入游标（currentTaskId）的常驻提示。它只展示
  // 服务端的游标，不划分轮次、不改归属；点击打开任务索引（索引里 ◎ 是同一个
  // 状态）。目标在别的页面被改掉时，WS 的 task_state 会带上 stateSource，这里
  // 就地回读一次壳作用域，避免本页继续显示一个已经过期的目标。
  function createComposerTarget(options = {}) {
    const doc = options.document || root.document;
    const element = options.element || doc?.getElementById?.('next-task-target');
    if (!element) return null;
    const translate = typeof options.translate === 'function' ? options.translate : key => key;
    const load = typeof options.load === 'function' ? options.load : null;
    const openIndex = typeof options.openIndex === 'function' ? options.openIndex : null;
    let current = { taskId: null, code: '' };
    let syncing = null;
    let flashTimer = null;

    function paint() {
      const code = current.code;
      element.hidden = !code;
      element.textContent = code ? translate('taskTargetChip').replace('{code}', `#${code}`) : '';
      element.dataset.code = code;
      if (!code) { if (element.removeAttribute) element.removeAttribute('aria-label'); return; }
      const title = translate('taskTargetChipTitle').replace('{code}', `#${code}`);
      element.title = title;
      element.setAttribute('aria-label', title);
    }

    function flash() {
      element.dataset.flash = 'true';
      if (flashTimer !== null) clearTimeout(flashTimer);
      flashTimer = setTimeout(() => { delete element.dataset.flash; flashTimer = null; }, 1500);
      if (flashTimer && typeof flashTimer.unref === 'function') flashTimer.unref();
    }

    // `flash` marks a change this page asked for (or heard about), so a cursor
    // that moved elsewhere is visible without a toast.
    function update(target, { flash: shouldFlash = false } = {}) {
      if (!target) return null;
      const code = codeOf(target.code ?? target.taskShortCode);
      const taskId = text(target.taskId) || null;
      const changed = code !== current.code || taskId !== current.taskId;
      current = { taskId, code };
      paint();
      if (changed && shouldFlash) flash();
      return current;
    }

    // The index reports the accepted choice directly, so the chip does not have
    // to wait for the next task_state broadcast to say where the next message goes.
    function applySelection(entry, result) {
      const code = codeOf(entry?.code);
      if (!code) return null;
      return update({ taskId: result?.taskId || entry?.taskId, code }, { flash: true });
    }

    function sync(stateSource) {
      if (!stateSource || typeof stateSource !== 'object' || !load) return null;
      if (syncing) return syncing;
      const taskId = text(stateSource.taskId);
      // Same target, or a shell this page is not showing: nothing to re-read.
      if (!taskId || taskId === current.taskId) return null;
      syncing = Promise.resolve().then(load).then(scope => {
        if (scope && scope.ok !== false) update(scope, { flash: true });
      }).catch(() => null).finally(() => { syncing = null; });
      return syncing;
    }

    element.onclick = () => { if (openIndex) openIndex(); };
    paint();
    return Object.freeze({
      element, update, applySelection, sync, paint,
      target: () => ({ ...current }),
      dispose() {
        if (flashTimer !== null) clearTimeout(flashTimer);
        flashTimer = null;
        element.onclick = null;
        element.remove?.();
      },
    });
  }

  const api = { createComposerTarget };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.MultiCCTaskTarget = api;
})(typeof window !== 'undefined' ? window : globalThis);
