(function attachMultiCCChatComposer(global) {
  'use strict';

  function defaultClientMessageId(now = Date.now(), random = Math.random()) {
    return 'c' + now.toString(36) + '-' + random.toString(36).slice(2, 10);
  }

  function pastedFileName(file) {
    const type = file && file.type || '';
    const ext = type === 'image/jpeg' ? 'jpg' : type.split('/')[1] || 'bin';
    return `pasted-file.${ext}`;
  }

  // Voice input is a shared module (public/voice-composer.js). If a host forgot
  // to load it (or a sandbox evaluates this file alone), every voice entry point
  // stays callable and inert instead of throwing at load.
  function noVoiceComposer() {
    return Object.freeze({
      bindVoice() {},
      startRecording() {}, stopRecording() {}, uploadAudioForSTT() { return false; },
      startStreamingVoice() { return Promise.resolve(false); },
      commitStreamingVoice() {}, cancelStreamingVoice() {},
      showVoicePanel() {}, closeVoicePanel() {}, useVoiceText() {}, fetchRefined() {},
    });
  }

  function createComposer(options) {
    const opts = options || {};
    const win = opts.window || global;
    const doc = opts.document || win.document;
    const nav = opts.navigator || win.navigator || {};
    const loc = opts.location || win.location || {};
    const elements = opts.elements || {};
    const inputEl = elements.input;
    const sendBtn = elements.sendButton;
    const cancelBtn = elements.cancelButton;
    const attachArea = elements.attachArea;
    const attachBtn = elements.attachButton;
    const fileInput = elements.fileInput;
    const micBtn = elements.micButton;
    const micToast = elements.micToast;
    const fetchFn = opts.fetch || (win.fetch && win.fetch.bind(win));
    const withToken = opts.withToken || (url => url);
    const isSocketOpen = opts.isSocketOpen || (() => false);
    const transportSend = opts.transportSend || (() => false);
    const retryTransport = opts.retryTransport || (() => {});
    const addSystemMessage = opts.addSystemMessage || (() => {});
    const updateUi = opts.updateUi || (() => {});
    const getIsStreaming = opts.getIsStreaming || (() => false);
    const hasOpenTurn = opts.hasOpenTurn || getIsStreaming;
    const finishOpenTurn = opts.finishOpenTurn || (() => {});
    const finishCancelledTurn = opts.finishCancelledTurn || (() => {});
    const setPendingCancel = opts.setPendingCancel || (() => {});
    const onTurnStarted = opts.onTurnStarted || (() => {});
    const getUserInputRequestId = opts.getUserInputRequestId || (() => null);
    const consumeUserInputRequestId = opts.consumeUserInputRequestId || (() => {});
    const resetHistory = opts.resetHistory || (() => {});
    const addUserMessage = opts.addUserMessage || (() => {});
    const stageUserMessage = typeof opts.stageUserMessage === 'function'
      ? opts.stageUserMessage
      : addUserMessage;
    const goalWrap = opts.goalWrap || (task => task);
    // Commander-only routing switch (chat-dispatch-hint.js). Identity elsewhere.
    const decorateText = opts.decorateText || (text => {
      const hint = win.MultiCCChatDispatchHint;
      return hint && typeof hint.decorate === 'function' ? hint.decorate(text) : text;
    });
    const debug = opts.debug || (() => {});
    const webSocketOpen = opts.webSocketOpen == null ? 1 : opts.webSocketOpen;
    const hasNativeBridge = opts.hasNativeBridge === true;
    const isMobile = /Mobi|Android|iPhone|iPad/i.test(nav.userAgent || '') || (win.innerWidth || 0) <= 768;
    const inputBar = elements.inputBar || inputEl?.closest?.('#input-bar') || null;

    let lastTypingSent = 0;
    let lastSendTapAt = 0;
    let lastCancelTapAt = 0;

    function clearInput() {
      if (!inputEl) return;
      inputEl.value = '';
      inputEl.style.height = 'auto';
      // The Air host restores per-task drafts from sessionStorage (one key
      // per task). Clearing the input programmatically fires no input event,
      // so drop the stored draft here or a later restore re-fills the sent
      // text — including right after a frame reload.
      try {
        const storage = win.sessionStorage;
        // Backwards: removeItem re-indexes, so a forward walk would skip keys.
        for (let i = (storage?.length || 0) - 1; i >= 0; i--) {
          const key = storage.key(i);
          if (key && key.indexOf('air:draft:') === 0) storage.removeItem(key);
        }
      } catch (err) { /* storage unavailable: drafts simply not persisted */ }
    }

    function newClientMsgId() {
      return defaultClientMessageId();
    }

    // iOS Safari has no system "hide keyboard" affordance and keeps a
    // textarea focused after tapping a non-focusable surface. Treat keyboard
    // visibility as part of the mobile composer lifecycle: successful sends
    // and taps outside the composer explicitly release focus. A draft is never
    // cleared by the outside-tap path.
    function dismissKeyboard() {
      if (!isMobile || !inputEl || doc.activeElement !== inputEl || typeof inputEl.blur !== 'function') return false;
      inputEl.blur();
      return true;
    }

    function dismissKeyboardFromOutside(event) {
      if (!isMobile || !inputEl || doc.activeElement !== inputEl) return false;
      const target = event && event.target;
      if (target && inputBar && typeof inputBar.contains === 'function' && inputBar.contains(target)) return false;
      return dismissKeyboard();
    }

    function updateAttachArea() {
      if (!attachArea) return;
      attachArea.classList.toggle('has-items', attachArea.children.length > 0);
    }

    // 最近一次真正发出去的 user_message（已装饰的文本 + goal 选项）。异常对话里的
    // 「重试」按钮重发的就是它：原样的那份数据，不是输入框里现在写着的东西。
    let lastSent = null;
    let manualRetrying = false;
    const sleep = ms => new Promise(resolve => (win.setTimeout || setTimeout)(resolve, ms));
    // Chat page's 中文/English toggle (public/i18n.js) at send time; server turns
    // this into an output-language instruction appended to the prompt suffix.
    const currentLang = () => {
      try { return typeof win.getLang === 'function' ? win.getLang() : null; }
      catch { return null; }
    };

    // 手动重试：先断掉还挂着的这一轮（与停止按钮同一个 cancel 控制），等几秒让
    // 服务端收干净、上游喘口气，再把原数据重新提交。页面刷新过就没有 lastSent，
    // 这时退回到调用方给的 fallbackText（最后一条用户气泡的原文）。
    async function manualRetry(options = {}) {
      const original = lastSent || (options.fallbackText ? { text: String(options.fallbackText) } : null);
      if (!original || !original.text) return { ok: false, reason: 'nothing_to_retry' };
      if (manualRetrying) return { ok: false, reason: 'busy' };
      manualRetrying = true;
      const onTick = typeof options.onTick === 'function' ? options.onTick : () => {};
      try {
        if (hasOpenTurn()) cancelStreaming();
        const delayMs = options.delayMs == null ? 3000 : Math.max(0, Number(options.delayMs) || 0);
        for (let left = delayMs; left > 0; left -= 1000) {
          onTick(Math.ceil(left / 1000));
          await sleep(Math.min(1000, left));
        }
        if (!isSocketOpen()) {
          retryTransport();
          for (let i = 0; i < 20 && !isSocketOpen(); i++) await sleep(250);
          if (!isSocketOpen()) return { ok: false, reason: 'disconnected' };
        }
        const clientMsgId = newClientMsgId();
        const payload = { type: 'user_message', text: original.text, clientMsgId };
        if (original.goal) {
          payload.goal = true;
          payload.goalLimits = original.goalLimits || {};
        }
        const retryLang = original.lang || currentLang();
        if (retryLang === 'zh' || retryLang === 'en') payload.lang = retryLang;
        stageUserMessage(original.text, clientMsgId);
        debug('state', `manualRetry() — WS ▶ user_message (${original.text.length} chars)`);
        if (!transportSend(payload)) return { ok: false, reason: 'send_failed' };
        lastSent = { ...original };
        setPendingCancel(false);
        updateUi();
        return { ok: true };
      } finally {
        manualRetrying = false;
      }
    }

    function send(sendOptions = {}) {
      if (!inputEl) return false;
      const goalOptions = sendOptions && sendOptions.goal === true ? sendOptions : null;
      let text = inputEl.value.trim();
      if (!text) return false;

      if (text.startsWith('/')) {
        const command = text.split(/\s+/)[0].toLowerCase();
        if (command === '/clear') {
          resetHistory();
          addSystemMessage('Chat cleared；Claude / Codex / OpenCode / ZCode / Qoder CN / WorkBuddy / DSH 的原生上下文均已重置');
          clearInput();
          if (isSocketOpen()) transportSend({ type: 'clear_history' });
          return true;
        }
        if (command === '/help') {
          addSystemMessage('Commands: /clear — clear chat history | /compact — ask Claude to compact context | /cost — show cost summary | /goal &lt;任务&gt; — 以 Goal 模式执行（受设置里的轮次/预算限制约束）');
          clearInput();
          return true;
        }
        if (command === '/goal') {
          const split = text.indexOf(' ');
          const task = split === -1 ? '' : text.slice(split + 1).trim();
          if (!task) {
            addSystemMessage('用法：/goal &lt;任务描述&gt; — 以 Goal 模式（目标驱动、自主执行到完成）发送，受设置里的轮次/预算限制约束。也可点输入框右侧 🎯 先做目标预检。');
            clearInput();
            return true;
          }
          inputEl.value = goalWrap(task);
          inputEl.style.height = 'auto';
          return send({ goal: true });
        }
      }

      // `cancel` is a transport control, not a prompt. It must never enter the
      // durable FIFO or reach the model: the host cancels the active slot and
      // records classify E directly.
      if (/^cancel$/i.test(text)) {
        clearInput();
        cancelStreaming();
        return true;
      }

      if (!isSocketOpen()) {
        addSystemMessage('连接已断开，正在重连。请稍后再发送。');
        retryTransport();
        updateUi();
        return false;
      }

      const paths = [];
      if (attachArea) {
        attachArea.querySelectorAll('.attach-chip[data-path]').forEach(chip => {
          if (chip.dataset.path) paths.push(chip.dataset.path);
          chip.remove();
        });
      }
      updateAttachArea();
      if (paths.length) text += ' ' + paths.join(' ');

      // What the user typed, kept for the retry path: restoring the decorated
      // text into the box would append the routing line twice.
      const typedText = text;
      const decorated = decorateText(text);
      if (typeof decorated === 'string' && decorated.trim()) text = decorated;

      const clientMsgId = newClientMsgId();
      const userInputRequestId = getUserInputRequestId();
      stageUserMessage(text, clientMsgId);
      clearInput();
      debug('state', `send() — WS ▶ user_message (${text.length} chars)${goalOptions ? ' [goal]' : ''}`);
      try {
        const payload = { type: 'user_message', text, clientMsgId };
        if (userInputRequestId) payload.userInputRequestId = userInputRequestId;
        if (goalOptions) {
          payload.goal = true;
          payload.goalLimits = goalOptions.goalLimits || {};
        }
        const lang = currentLang();
        if (lang === 'zh' || lang === 'en') payload.lang = lang;
        if (sendOptions.voice) {
          payload.inputSource = 'voice';
          payload.voiceRaw = String(sendOptions.voice.raw || '');
        }
        if (!transportSend(payload)) throw new Error('WebSocket is not open');
        lastSent = { text, goal: !!goalOptions, goalLimits: goalOptions ? goalOptions.goalLimits || {} : null, lang: lang === 'zh' || lang === 'en' ? lang : null };
        if (userInputRequestId) consumeUserInputRequestId(userInputRequestId);
        setPendingCancel(false);
        return true;
      } catch (error) {
        addSystemMessage('发送失败，正在重连：' + error.message);
        inputEl.value = typedText;
        retryTransport();
        updateUi();
        return false;
      }
    }

    function cancelStreaming() {
      debug('state', `cancelStreaming() — isStreaming=${getIsStreaming()}`);
      if (isSocketOpen()) {
        transportSend({ type: 'cancel' });
        setPendingCancel(false);
      } else {
        setPendingCancel(true);
      }
      if (!getIsStreaming()) return false;
      finishCancelledTurn();
      return true;
    }

    function sendFromButton(event) {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      const now = Date.now();
      if (now - lastSendTapAt < 600) return false;
      lastSendTapAt = now;
      const sent = send();
      if (sent) dismissKeyboard();
      return sent;
    }

    function cancelFromButton(event) {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      const now = Date.now();
      if (now - lastCancelTapAt < 600) return false;
      lastCancelTapAt = now;
      return cancelStreaming();
    }

    function bindComposerInput() {
      if (inputEl) {
        inputEl.addEventListener('input', () => {
          inputEl.style.height = 'auto';
          inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
          if (isSocketOpen() && Date.now() - lastTypingSent > 3000) {
            transportSend({ type: 'typing' });
            lastTypingSent = Date.now();
          }
        });
        inputEl.addEventListener('keydown', event => {
          if (!isMobile && event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
            event.preventDefault();
            send();
          }
        });
      }
      sendBtn?.addEventListener('click', sendFromButton);
      sendBtn?.addEventListener('touchend', sendFromButton, { passive: false });
      cancelBtn?.addEventListener('click', cancelFromButton);
      cancelBtn?.addEventListener('touchend', cancelFromButton, { passive: false });
      doc?.addEventListener?.('pointerdown', dismissKeyboardFromOutside, { passive: true });
      doc?.addEventListener?.('touchstart', dismissKeyboardFromOutside, { passive: true });
    }

    const lightbox = doc && doc.getElementById('img-lightbox');

    function openLightbox(src, name) {
      if (!lightbox) return;
      lightbox.querySelector('img').src = src;
      lightbox.querySelector('.lb-name').textContent = name || '';
      lightbox.classList.add('show');
    }

    function closeLightbox() {
      if (!lightbox) return;
      lightbox.classList.remove('show');
      lightbox.querySelector('img').src = '';
    }

    async function uploadFile(file) {
      if (!file || !attachArea || !fetchFn) return false;
      const fileName = file.name || pastedFileName(file);
      const isImage = (file.type || '').startsWith('image/');
      const chip = doc.createElement('div');
      chip.className = 'attach-chip' + (isImage ? ' is-image' : '');
      chip.style.opacity = '0.5';
      let thumbUrl = null;
      if (isImage) {
        thumbUrl = win.URL.createObjectURL(file);
        const img = doc.createElement('img');
        img.className = 'chip-thumb';
        img.src = thumbUrl;
        chip.appendChild(img);
      }
      const nameSpan = doc.createElement('span');
      nameSpan.className = 'chip-name';
      nameSpan.textContent = fileName;
      chip.appendChild(nameSpan);
      const remove = doc.createElement('span');
      remove.className = 'chip-remove';
      remove.innerHTML = '&times;';
      remove.onclick = event => {
        event.stopPropagation();
        chip.remove();
        updateAttachArea();
        if (thumbUrl) win.URL.revokeObjectURL(thumbUrl);
      };
      chip.appendChild(remove);
      if (isImage) {
        chip.onclick = event => {
          if (event.target !== remove) openLightbox(thumbUrl || chip.querySelector('.chip-thumb')?.src, fileName);
        };
        chip.title = 'Click to preview';
      }
      attachArea.appendChild(chip);
      updateAttachArea();
      try {
        const formData = new win.FormData();
        formData.append('file', file, fileName);
        const response = await fetchFn(withToken('/api/upload'), { method: 'POST', body: formData });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Upload failed');
        chip.dataset.path = data.path;
        chip.style.opacity = '1';
        return true;
      } catch (_) {
        nameSpan.textContent = `Failed: ${fileName}`;
        chip.style.borderColor = '#f85149';
        chip.style.opacity = '1';
        win.setTimeout(() => { chip.remove(); updateAttachArea(); }, 3000);
        return false;
      }
    }

    function bindAttachments() {
      attachBtn?.addEventListener('click', () => fileInput?.click());
      if (fileInput) {
        fileInput.onchange = () => {
          for (const file of Array.from(fileInput.files || [])) uploadFile(file);
          fileInput.value = '';
        };
      }
      inputEl?.addEventListener('paste', event => {
        for (const file of Array.from(event.clipboardData?.files || [])) uploadFile(file);
      });
      if (lightbox) {
        const close = lightbox.querySelector('.lb-close');
        if (close) close.onclick = closeLightbox;
        lightbox.onclick = event => { if (event.target === lightbox) closeLightbox(); };
      }
    }

    // Voice input lives in the shared module (public/voice-composer.js) so the
    // Chat page and the Air directory's quick-task composer run identical code.
    // The one host-specific piece is onCommit: after the HUD replaces the input
    // value, Chat sends it; Air submits its quick-task form. Degrade to a no-op
    // bundle if the module is missing so the page still loads.
    const voice = (win.MultiCCVoiceComposer && typeof win.MultiCCVoiceComposer.createVoiceComposer === 'function')
      ? win.MultiCCVoiceComposer.createVoiceComposer({
        window: win, document: doc, navigator: nav, location: loc,
        fetch: fetchFn, withToken,
        input: inputEl, micButton: micBtn, micToast,
        hasNativeBridge,
        installNativeBridgeCallbacks: opts.installNativeBridgeCallbacks !== false,
        autoBind: false,
        onCommit: (_text, meta) => send(meta && meta.inputSource === 'voice' ? { voice: { raw: meta.raw || '' } } : {}),
      })
      : noVoiceComposer();
    const bindVoice = () => voice.bindVoice();
    const {
      startRecording, stopRecording, uploadAudioForSTT,
      startStreamingVoice, commitStreamingVoice, cancelStreamingVoice,
      showVoicePanel, closeVoicePanel, useVoiceText, fetchRefined,
    } = voice;

    if (opts.autoBind !== false) {
      bindComposerInput();
      bindAttachments();
      bindVoice();
    }

    return Object.freeze({
      send, cancelStreaming, sendFromButton, cancelFromButton,
      updateAttachArea, uploadFile, openLightbox, closeLightbox,
      startRecording, stopRecording, uploadAudioForSTT,
      startStreamingVoice, commitStreamingVoice, cancelStreamingVoice,
      showVoicePanel, closeVoicePanel, useVoiceText, fetchRefined,
      newClientMsgId, manualRetry,
    });
  }

  global.MultiCCChatComposer = Object.freeze({
    createComposer,
    defaultClientMessageId,
    pastedFileName,
  });
})(window);
