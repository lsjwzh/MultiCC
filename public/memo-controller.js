'use strict';

(function initMultiCCMemo(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MultiCCMemo = api;
})(typeof window !== 'undefined' ? window : null, function createMultiCCMemo(root) {
  const MAX_ID_LENGTH = 240;
  const MAX_PATH_LENGTH = 4096;

  function boundedText(value, maxLength) {
    if (typeof value !== 'string') return '';
    return value.slice(0, maxLength);
  }

  function normalizeId(value) {
    return boundedText(value, MAX_ID_LENGTH).trim();
  }

  function normalizeMemoDocument(value) {
    const data = value && typeof value === 'object' ? value : {};
    return Object.freeze({
      text: typeof data.text === 'string' ? data.text : '',
      path: boundedText(data.path, MAX_PATH_LENGTH),
      exists: data.exists === true,
      mtime: Number.isFinite(Number(data.mtime)) ? Number(data.mtime) : 0,
    });
  }

  function normalizeMemoSession(value) {
    const data = value && typeof value === 'object' ? value : {};
    const id = normalizeId(data.id);
    const dirId = normalizeId(data.dirId);
    if (!id || !dirId) return null;
    return Object.freeze({
      id,
      dirId,
      label: boundedText(data.label, 240),
      kind: boundedText(data.kind, 40),
      type: boundedText(data.type, 40),
      active: data.active === true,
    });
  }

  function sessionsForDirectory(values, dirId) {
    const target = normalizeId(dirId);
    if (!target || !Array.isArray(values)) return [];
    return values
      .map(normalizeMemoSession)
      .filter(session => session && session.dirId === target && session.kind === 'chat' &&
        session.type !== 'aux' && session.type !== 'gateway');
  }

  function extractCurrentLine(value, cursor) {
    const text = typeof value === 'string' ? value : '';
    const rawCursor = Number(cursor);
    const position = Number.isFinite(rawCursor)
      ? Math.max(0, Math.min(text.length, rawCursor))
      : 0;
    const before = text.lastIndexOf('\n', Math.max(0, position - 1));
    const after = text.indexOf('\n', position);
    const start = before === -1 ? 0 : before + 1;
    const end = after === -1 ? text.length : after;
    return text.slice(start, end)
      .replace(/^\s*[-*+]\s+\[[ xX]\]\s*/, '')
      .replace(/^\s*[-*+]\s+/, '')
      .replace(/^\s*\d+\.\s+/, '')
      .replace(/^\s*#+\s+/, '')
      .trim();
  }

  function memoEndpoint(dirId, suffix = '') {
    const id = normalizeId(dirId);
    if (!id) throw new TypeError('directory id is required');
    if (suffix !== '' && suffix !== '/send') throw new TypeError('unsupported memo endpoint');
    return `/api/directories/${encodeURIComponent(id)}/memo${suffix}`;
  }

  function createController(options = {}) {
    const api = options.api || (root && root.MultiCCApi);
    const document = options.document || (root && root.document);
    const getDirectories = typeof options.getDirectories === 'function' ? options.getDirectories : () => [];
    const getSessions = typeof options.getSessions === 'function' ? options.getSessions : () => [];
    const getSessionStatus = typeof options.getSessionStatus === 'function'
      ? options.getSessionStatus
      : () => null;
    const notify = typeof options.notify === 'function' ? options.notify : () => {};
    const now = typeof options.now === 'function' ? options.now : () => new Date();

    if (!api || typeof api.json !== 'function') throw new TypeError('MultiCCApi.json is required');
    if (!document || typeof document.getElementById !== 'function') throw new TypeError('document is required');

    let currentDirId = null;
    let loadVersion = 0;

    function element(id) {
      return document.getElementById(id);
    }

    function errorMessage(error) {
      if (typeof api.errorDisplay === 'function') return api.errorDisplay(error).message;
      return 'Request failed';
    }

    function currentLineText() {
      const textarea = element('memo-text');
      return textarea ? extractCurrentLine(textarea.value, textarea.selectionStart) : '';
    }

    function pickerClose() {
      const picker = element('memo-picker');
      if (picker) picker.style.display = 'none';
    }

    function close() {
      loadVersion += 1;
      const textarea = element('memo-text');
      if (textarea) textarea.onkeydown = null;
      const modal = element('memo-modal');
      if (modal) modal.style.display = 'none';
      pickerClose();
      currentDirId = null;
    }

    async function open(dirId) {
      const id = normalizeId(dirId);
      const directory = (getDirectories() || []).find(item => normalizeId(item && item.id) === id);
      if (!directory) {
        notify('Directory not found', true);
        return;
      }

      currentDirId = id;
      const requestVersion = ++loadVersion;
      const modal = element('memo-modal');
      const textarea = element('memo-text');
      const status = element('memo-status');
      const title = element('memo-title');
      const subtitle = element('memo-subtitle');
      title.textContent = `📝 ${boundedText(directory.name, 240)} · 备忘`;
      subtitle.textContent = '加载中…';
      textarea.value = '';
      status.textContent = '';
      modal.style.display = 'flex';
      textarea.onkeydown = (event) => {
        if ((event.metaKey || event.ctrlKey) && String(event.key).toLowerCase() === 's') {
          event.preventDefault();
          save();
        }
      };

      try {
        const memo = normalizeMemoDocument(await api.json(memoEndpoint(id)));
        if (requestVersion !== loadVersion || currentDirId !== id) return;
        textarea.value = memo.text;
        subtitle.textContent = `${memo.path}${memo.exists ? '' : ' · 文件尚未创建（保存即创建）'}`;
        textarea.focus();
      } catch (error) {
        if (requestVersion !== loadVersion || currentDirId !== id) return;
        subtitle.textContent = `加载失败：${errorMessage(error)}`;
      }
    }

    async function save() {
      const dirId = currentDirId;
      if (!dirId) return;
      const textarea = element('memo-text');
      const status = element('memo-status');
      status.textContent = '保存中…';
      try {
        await api.json(memoEndpoint(dirId), { method: 'PUT', json: { text: textarea.value } });
        if (currentDirId === dirId) status.textContent = `已保存 · ${now().toLocaleTimeString()}`;
      } catch (error) {
        if (currentDirId === dirId) status.textContent = `保存失败：${errorMessage(error)}`;
      }
    }

    function appendText(parent, text, style) {
      const span = document.createElement('span');
      span.textContent = text;
      if (style) span.style.cssText = style;
      parent.appendChild(span);
      return span;
    }

    function renderPickerSession(list, session) {
      const state = getSessionStatus(session.id);
      const status = boundedText(state && state.status, 40) || (session.active ? 'active' : 'idle');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn';
      button.style.cssText = 'text-align:left;padding:8px 10px;display:flex;justify-content:space-between;gap:10px;';
      button.addEventListener('click', () => confirmSend(session.id));
      const label = session.label && session.label !== session.id ? session.label : session.id;
      appendText(button, label, 'overflow:hidden;text-overflow:ellipsis;');
      if (label !== session.id) appendText(button, ` ${session.id}`, 'color:#6e7681;overflow:hidden;text-overflow:ellipsis;');
      appendText(button, status, 'color:#6e7681;font-size:11px;flex-shrink:0;');
      list.appendChild(button);
    }

    function sendCurrentLine() {
      if (!currentDirId) return;
      const text = currentLineText();
      const status = element('memo-status');
      if (!text) {
        status.textContent = '当前行为空，无法发送';
        return;
      }
      const sessions = sessionsForDirectory(getSessions(), currentDirId);
      if (!sessions.length) {
        status.textContent = '该Fleet还没有 chat 会话，请先新建一个';
        return;
      }
      element('memo-picker-preview').textContent = text.length > 120 ? text.slice(0, 120) + '…' : text;
      const list = element('memo-picker-list');
      list.replaceChildren();
      sessions.forEach(session => renderPickerSession(list, session));
      element('memo-picker').style.display = 'flex';
    }

    async function confirmSend(sessionId) {
      const dirId = currentDirId;
      const targetId = normalizeId(sessionId);
      if (!dirId || !targetId) return;
      const text = currentLineText();
      if (!text) return;
      pickerClose();
      const status = element('memo-status');
      status.textContent = `发送到 ${targetId}…`;
      try {
        await api.json(memoEndpoint(dirId, '/send'), {
          method: 'POST',
          json: { text, sessionId: targetId },
        });
        if (currentDirId === dirId) {
          status.textContent = `已发送到 ${targetId} · ${now().toLocaleTimeString()}`;
        }
      } catch (error) {
        if (currentDirId === dirId) status.textContent = `发送失败：${errorMessage(error)}`;
      }
    }

    return Object.freeze({
      openMemo: open,
      closeMemoModal: close,
      memoSave: save,
      memoCurrentLineText: currentLineText,
      memoSendCurrentLine: sendCurrentLine,
      memoPickerClose: pickerClose,
      memoConfirmSend: confirmSend,
      currentDirectoryId: () => currentDirId,
    });
  }

  return Object.freeze({
    normalizeMemoDocument,
    normalizeMemoSession,
    sessionsForDirectory,
    extractCurrentLine,
    memoEndpoint,
    createController,
  });
});
