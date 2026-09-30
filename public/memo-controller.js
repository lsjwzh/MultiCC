'use strict';

(function initMultiCCMemo(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MultiCCMemo = api;
})(typeof window !== 'undefined' ? window : null, function createMultiCCMemo(root) {
  const MAX_ID_LENGTH = 240;
  const MAX_PATH_LENGTH = 4096;

  // 这个控制器被 chat / memo / manage / memory 四边共用，自己不带词典：页面加载了
  // i18n.js 就借用它的 t（英文字典里有这些 key），没加载（Node 单测）就原样返回 key，
  // 免得测试还得在桩里造一套词典。
  function tr(key, params) {
    return root && typeof root.t === 'function' ? root.t(key, params) : key;
  }
  function locale() {
    return root && typeof root.getLocale === 'function' ? root.getLocale() : undefined;
  }

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
    const dirId = normalizeId(data.dirId || (data.persisted && data.persisted.dirId));
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

  function normalizeMemoDirectory(value) {
    const data = value && typeof value === 'object' ? value : {};
    const id = normalizeId(data.id);
    if (!id) return null;
    return Object.freeze({
      id,
      name: boundedText(data.name, 240),
    });
  }

  function normalizeMemoMutation(value) {
    const data = value && typeof value === 'object' ? value : {};
    return Object.freeze({
      ok: data.ok !== false,
      path: boundedText(data.path, MAX_PATH_LENGTH),
      mtime: Number.isFinite(Number(data.mtime)) ? Number(data.mtime) : 0,
      sentTo: normalizeId(data.sentTo || data.sessionId),
    });
  }

  function collection(value, key) {
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object' && Array.isArray(value[key])) return value[key];
    return [];
  }

  function normalizeDirectories(value) {
    return collection(value, 'directories').map(normalizeMemoDirectory).filter(Boolean);
  }
  function normalizeSessions(value) {
    return collection(value, 'sessions').map(normalizeMemoSession).filter(Boolean);
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

  function defaultLocalStorage(root) {
    try {
      return root && root.localStorage ? root.localStorage : null;
    } catch (_) {
      return null;
    }
  }

  function memoDraftKey(dirId) {
    return `multicc.memo.draft:${normalizeId(dirId)}`;
  }

  function memoEndpoint(dirId, suffix = '') {
    const id = normalizeId(dirId);
    if (!id) throw new TypeError('directory id is required');
    if (suffix !== '' && suffix !== '/send') throw new TypeError('unsupported memo endpoint');
    return `/api/directories/${encodeURIComponent(id)}/memo${suffix}`;
  }

  function createClient(options = {}) {
    const api = options.api || (root && root.MultiCCApi);
    if (!api || typeof api.json !== 'function') throw new TypeError('MultiCCApi.json is required');

    function errorMessage(error) {
      if (typeof api.errorDisplay === 'function') return api.errorDisplay(error).message;
      return 'Request failed';
    }

    async function loadMemo(dirId) {
      return normalizeMemoDocument(await api.json(memoEndpoint(dirId)));
    }

    async function saveMemo(dirId, text) {
      return normalizeMemoMutation(await api.json(memoEndpoint(dirId), {
        method: 'PUT',
        json: { text: typeof text === 'string' ? text : '' },
      }));
    }

    async function sendLine(dirId, text, sessionId) {
      const targetId = normalizeId(sessionId);
      if (!targetId) throw new TypeError('session id is required');
      return normalizeMemoMutation(await api.json(memoEndpoint(dirId, '/send'), {
        method: 'POST',
        json: { text: typeof text === 'string' ? text : '', sessionId: targetId },
      }));
    }

    async function listDirectories() {
      return normalizeDirectories(await api.json('/api/directories'));
    }

    async function listSessions() {
      return normalizeSessions(await api.json('/api/sessions'));
    }

    async function getSession(sessionId) {
      const id = normalizeId(sessionId);
      if (!id) return null;
      return normalizeMemoSession(await api.json(`/api/sessions/${encodeURIComponent(id)}`));
    }

    async function resolveDirectoryId(value = {}) {
      const explicit = normalizeId(value.dirId);
      if (explicit) return explicit;
      const sessionId = normalizeId(value.sessionId);
      if (!sessionId) return '';

      let directError = null;
      try {
        const session = await getSession(sessionId);
        if (session) return session.dirId;
      } catch (error) {
        directError = error;
      }

      try {
        const session = (await listSessions()).find(item => item.id === sessionId);
        if (session) return session.dirId;
      } catch (error) {
        if (directError) throw directError;
        throw error;
      }
      if (directError) throw directError;
      return '';
    }

    return Object.freeze({
      errorMessage,
      loadMemo,
      saveMemo,
      sendLine,
      listDirectories,
      listSessions,
      getSession,
      resolveDirectoryId,
    });
  }

  function createController(options = {}) {
    const document = options.document || (root && root.document);
    const client = options.client || createClient({ api: options.api || (root && root.MultiCCApi) });
    const getDirectories = typeof options.getDirectories === 'function' ? options.getDirectories : null;
    const getSessions = typeof options.getSessions === 'function' ? options.getSessions : null;
    const getSessionStatus = typeof options.getSessionStatus === 'function'
      ? options.getSessionStatus
      : () => null;
    const notify = typeof options.notify === 'function' ? options.notify : () => {};
    const now = typeof options.now === 'function' ? options.now : () => new Date();
    const requireDirectory = options.requireDirectory === undefined ? Boolean(getDirectories) : options.requireDirectory === true;
    const closeOnEscape = options.closeOnEscape === true;
    const ui = options.ui && typeof options.ui === 'object' ? options.ui : {};
    const storage = options.storage !== undefined
      ? options.storage
      : defaultLocalStorage(root);
    const autoSaveDelayMs = Number.isFinite(Number(options.autoSaveDelayMs)) && Number(options.autoSaveDelayMs) > 0
      ? Number(options.autoSaveDelayMs)
      : 1000;
    const scheduleTimer = typeof options.setTimeout === 'function'
      ? options.setTimeout
      : (fn, ms) => setTimeout(fn, ms);
    const cancelTimer = typeof options.clearTimeout === 'function'
      ? options.clearTimeout
      : id => clearTimeout(id);
    const ids = Object.assign({
      modal: 'memo-modal',
      text: 'memo-text',
      status: 'memo-status',
      title: 'memo-title',
      subtitle: 'memo-subtitle',
      picker: 'memo-picker',
      pickerPreview: 'memo-picker-preview',
      pickerList: 'memo-picker-list',
    }, options.ids || {});

    if (!document || typeof document.getElementById !== 'function') throw new TypeError('document is required');

    let currentDirId = null;
    let loadVersion = 0;
    let lastSavedText = '';
    let autoSaveTimer = null;
    let saveInFlight = false;
    let saveQueued = false;

    function element(name) {
      return ids[name] ? document.getElementById(ids[name]) : null;
    }

    function display(name, hook, value) {
      const target = element(name);
      if (typeof ui[hook] === 'function') ui[hook](target);
      else if (target) target.style.display = value;
    }
    function showModal() { display('modal', 'showModal', 'flex'); }
    function hideModal() { display('modal', 'hideModal', 'none'); }
    function showPicker() { display('picker', 'showPicker', 'flex'); }

    function currentLineText() {
      const textarea = element('text');
      return textarea ? extractCurrentLine(textarea.value, textarea.selectionStart) : '';
    }

    function readDraft(dirId) {
      if (!storage || typeof storage.getItem !== 'function') return null;
      try {
        const raw = storage.getItem(memoDraftKey(dirId));
        if (!raw) return null;
        const data = JSON.parse(raw);
        return data && typeof data.text === 'string' ? data.text : null;
      } catch (_) {
        return null;
      }
    }

    function writeDraft(dirId, text) {
      if (!storage || typeof storage.setItem !== 'function') return;
      try {
        storage.setItem(memoDraftKey(dirId), JSON.stringify({ text }));
      } catch (_) {}
    }

    function clearDraft(dirId) {
      if (!storage || typeof storage.removeItem !== 'function') return;
      try {
        storage.removeItem(memoDraftKey(dirId));
      } catch (_) {}
    }

    function isDirty() {
      const textarea = element('text');
      return Boolean(textarea && currentDirId && textarea.value !== lastSavedText);
    }

    function scheduleAutoSave() {
      if (!currentDirId || autoSaveTimer) return;
      autoSaveTimer = scheduleTimer(() => {
        autoSaveTimer = null;
        if (!isDirty()) return;
        if (saveInFlight) {
          saveQueued = true;
          return;
        }
        save();
      }, autoSaveDelayMs);
    }

    function pickerClose() {
      display('picker', 'hidePicker', 'none');
    }

    function close() {
      loadVersion += 1;
      if (autoSaveTimer) {
        cancelTimer(autoSaveTimer);
        autoSaveTimer = null;
      }
      const textarea = element('text');
      if (textarea) {
        textarea.onkeydown = null;
        textarea.oninput = null;
        textarea.oncompositionend = null;
        textarea.onblur = null;
      }
      if (isDirty() && !saveInFlight) save();
      hideModal();
      pickerClose();
      currentDirId = null;
      lastSavedText = '';
    }

    async function directoryFor(id) {
      try {
        const values = getDirectories ? await getDirectories() : await client.listDirectories();
        const directory = normalizeDirectories(values).find(item => item.id === id);
        if (directory) return directory;
      } catch (error) {
        if (requireDirectory) throw error;
      }
      return requireDirectory ? null : Object.freeze({ id, name: id });
    }

    async function sessionsForCurrentDirectory(dirId) {
      const values = getSessions ? await getSessions() : await client.listSessions();
      return sessionsForDirectory(values, dirId);
    }

    async function open(dirId) {
      const id = normalizeId(dirId);
      const requestVersion = ++loadVersion;
      let directory;
      try {
        directory = id ? await directoryFor(id) : null;
      } catch (error) {
        if (requestVersion !== loadVersion) return false;
        notify(tr('memoDirectoryLoadFailed', { message: client.errorMessage(error) }), true);
        return false;
      }
      if (requestVersion !== loadVersion) return false;
      if (!directory) {
        notify(tr('memoDirectoryNotFound'), true);
        return false;
      }

      currentDirId = id;
      lastSavedText = '';
      const textarea = element('text');
      const status = element('status');
      const title = element('title');
      const subtitle = element('subtitle');
      if (title) title.textContent = tr('memoTitleNamed', { name: boundedText(directory.name || id, 240) });
      if (subtitle) subtitle.textContent = tr('loading');
      if (textarea) {
        textarea.value = '';
        textarea.onkeydown = (event) => {
          if ((event.metaKey || event.ctrlKey) && String(event.key).toLowerCase() === 's') {
            event.preventDefault();
            save();
          } else if (closeOnEscape && event.key === 'Escape') {
            close();
          }
        };
        textarea.oninput = (event) => {
          if (currentDirId) writeDraft(currentDirId, textarea.value);
          if (event && event.isComposing) return;
          scheduleAutoSave();
        };
        textarea.oncompositionend = () => scheduleAutoSave();
        textarea.onblur = () => {
          if (isDirty() && !saveInFlight) save();
        };
      }
      if (status) status.textContent = '';
      showModal();
      if (typeof ui.onDirectory === 'function') ui.onDirectory(directory);

      try {
        const memo = await client.loadMemo(id);
        if (requestVersion !== loadVersion || currentDirId !== id) return false;
        lastSavedText = memo.text;
        if (textarea) {
          const draft = readDraft(id);
          const restored = draft !== null && draft !== memo.text;
          textarea.value = restored ? draft : memo.text;
          if (draft !== null && !restored) clearDraft(id);
          textarea.focus();
          if (restored) {
            if (status) status.textContent = tr('memoRestoredUnsaved');
            scheduleAutoSave();
          }
        }
        if (subtitle) subtitle.textContent = `${memo.path}${memo.exists ? '' : tr('memoNotCreated')}`;
        if (typeof ui.onLoaded === 'function') ui.onLoaded(directory, memo);
        return true;
      } catch (error) {
        if (requestVersion !== loadVersion || currentDirId !== id) return false;
        const draft = textarea ? readDraft(id) : null;
        if (textarea && draft !== null) {
          textarea.value = draft;
          if (status) status.textContent = tr('memoRestoredLocalDraft');
          scheduleAutoSave();
        }
        if (subtitle) subtitle.textContent = tr('memoLoadFailed', { message: client.errorMessage(error) });
        return false;
      }
    }

    async function save() {
      const dirId = currentDirId;
      if (!dirId) return null;
      const textarea = element('text');
      const status = element('status');
      if (!textarea) return null;
      if (saveInFlight) {
        saveQueued = true;
        return null;
      }
      const text = textarea.value;
      saveInFlight = true;
      if (status) status.textContent = tr('memoSaving');
      try {
        const result = await client.saveMemo(dirId, text);
        clearDraft(dirId);
        if (currentDirId === dirId) {
          lastSavedText = text;
          if (status) status.textContent = tr('memoSavedAt', { time: now().toLocaleTimeString(locale()) });
        }
        return result;
      } catch (error) {
        if (currentDirId === dirId && status) status.textContent = tr('memoSaveFailed', { message: client.errorMessage(error) });
        return null;
      } finally {
        saveInFlight = false;
        if (saveQueued) {
          saveQueued = false;
          if (isDirty()) save();
        }
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
      const status = boundedText(state && state.status, 40) || tr(session.active ? 'active' : 'idle');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = ui.buttonClass || 'btn';
      button.style.cssText = ui.buttonStyle || 'text-align:left;padding:8px 10px;display:flex;justify-content:space-between;gap:10px;';
      button.addEventListener('click', () => confirmSend(session.id));
      const label = session.label && session.label !== session.id ? session.label : session.id;
      appendText(button, label, 'overflow:hidden;text-overflow:ellipsis;');
      if (label !== session.id) appendText(button, ` ${session.id}`, 'color:#6e7681;overflow:hidden;text-overflow:ellipsis;');
      appendText(button, status, 'color:#6e7681;font-size:11px;flex-shrink:0;');
      list.appendChild(button);
    }

    async function sendCurrentLine() {
      const dirId = currentDirId;
      if (!dirId) return;
      const text = currentLineText();
      const status = element('status');
      if (!text) {
        if (status) status.textContent = tr('memoEmptyLine');
        return;
      }
      let sessions;
      try {
        sessions = await sessionsForCurrentDirectory(dirId);
      } catch (error) {
        if (currentDirId === dirId && status) status.textContent = tr('memoSessionListFailed', { message: client.errorMessage(error) });
        return;
      }
      if (currentDirId !== dirId) return;
      if (!sessions.length) {
        if (status) status.textContent = tr('memoNoSessions');
        return;
      }
      const previewLength = Math.max(40, Number(ui.previewLength) || 120);
      const preview = element('pickerPreview');
      if (preview) preview.textContent = text.length > previewLength ? text.slice(0, previewLength) + '…' : text;
      const list = element('pickerList');
      if (!list) return;
      list.replaceChildren();
      sessions.forEach(session => renderPickerSession(list, session));
      showPicker();
    }

    async function confirmSend(sessionId) {
      const dirId = currentDirId;
      const targetId = normalizeId(sessionId);
      if (!dirId || !targetId) return;
      const text = currentLineText();
      if (!text) return;
      pickerClose();
      const status = element('status');
      if (status) status.textContent = tr('memoSending', { target: targetId });
      try {
        const result = await client.sendLine(dirId, text, targetId);
        if (currentDirId === dirId && status) {
          status.textContent = tr('memoSentAt', { target: targetId, time: now().toLocaleTimeString(locale()) });
        }
        return result;
      } catch (error) {
        if (currentDirId === dirId && status) status.textContent = tr('memoSendFailed', { message: client.errorMessage(error) });
        return null;
      }
    }

    if (root && typeof root.addEventListener === 'function') {
      const flushIfDirty = () => {
        if (isDirty() && !saveInFlight) save();
      };
      root.addEventListener('pagehide', flushIfDirty);
      root.addEventListener('visibilitychange', () => {
        const hostDocument = root.document;
        if (hostDocument && hostDocument.visibilityState === 'hidden') flushIfDirty();
      });
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
      client,
    });
  }

  return Object.freeze({
    normalizeMemoDocument,
    normalizeMemoSession,
    normalizeMemoDirectory,
    normalizeMemoMutation,
    normalizeDirectories,
    normalizeSessions,
    sessionsForDirectory,
    extractCurrentLine,
    memoEndpoint,
    createClient,
    createController,
  });
});
