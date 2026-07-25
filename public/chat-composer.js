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
    const addUserMessage = opts.addUserMessage || (() => {})
  const stageUserMessage = opts.stageUserMessage || (() => {});
    const goalWrap = opts.goalWrap || (task => task);
    const debug = opts.debug || (() => {});
    const webSocketOpen = opts.webSocketOpen == null ? 1 : opts.webSocketOpen;
    const hasNativeBridge = opts.hasNativeBridge === true;

    let mediaRecorder = null;
    let audioChunks = [];
    let isRecording = false;
    let recordingStream = null;
    let lastTypingSent = 0;
    let lastSendTapAt = 0;
    let lastCancelTapAt = 0;

    function clearInput() {
      if (!inputEl) return;
      inputEl.value = '';
      inputEl.style.height = 'auto';
    }

    function newClientMsgId() {
      return defaultClientMessageId();
    }

    function updateAttachArea() {
      if (!attachArea) return;
      attachArea.classList.toggle('has-items', attachArea.children.length > 0);
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
          addSystemMessage('Chat cleared；Claude / Codex / OpenCode / ZCode / Qoder CN 的原生上下文均已重置');
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

      const clientMsgId = newClientMsgId();
      const userInputRequestId = getUserInputRequestId();
      if (typeof stageUserMessage === 'function') stageUserMessage(text, clientMsgId);
      else addUserMessage(text, clientMsgId);
      clearInput();
      debug('state', `send() — WS ▶ user_message (${text.length} chars)${goalOptions ? ' [goal]' : ''}`);
      try {
        const payload = { type: 'user_message', text, clientMsgId };
        if (userInputRequestId) payload.userInputRequestId = userInputRequestId;
        if (goalOptions) {
          payload.goal = true;
          payload.goalLimits = goalOptions.goalLimits || {};
        }
        if (!transportSend(payload)) throw new Error('WebSocket is not open');
        if (userInputRequestId) consumeUserInputRequestId(userInputRequestId);
        setPendingCancel(false);
        return true;
      } catch (error) {
        addSystemMessage('发送失败，正在重连：' + error.message);
        inputEl.value = text;
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
      return send();
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
        const isMobile = /Mobi|Android|iPhone|iPad/i.test(nav.userAgent || '') || (win.innerWidth || 0) <= 768;
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

    function showMicToast(text) {
      if (!micToast) return;
      micToast.textContent = text;
      micToast.classList.add('show');
    }

    function hideMicToast() {
      micToast?.classList.remove('show');
    }

    function startRecording() {
      if (hasNativeBridge) {
        win.MultiCCBridge.startRecording();
        isRecording = true;
        micBtn?.classList.add('recording');
        showMicToast('Recording...');
        return;
      }
      audioChunks = [];
      const Recorder = win.MediaRecorder;
      const mimeType = Recorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : Recorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
      nav.mediaDevices.getUserMedia({ audio: true }).then(stream => {
        recordingStream = stream;
        mediaRecorder = new Recorder(stream, mimeType ? { mimeType } : {});
        mediaRecorder.ondataavailable = event => { if (event.data.size > 0) audioChunks.push(event.data); };
        mediaRecorder.onstop = () => {
          if (recordingStream) {
            recordingStream.getTracks().forEach(track => track.stop());
            recordingStream = null;
          }
          const blob = new win.Blob(audioChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
          audioChunks = [];
          if (blob.size > 0) uploadAudioForSTT(blob);
        };
        mediaRecorder.start();
        isRecording = true;
        micBtn?.classList.add('recording');
        showMicToast('Recording... tap mic to stop');
      }).catch(error => {
        showMicToast('Mic error: ' + error.message);
        win.setTimeout(hideMicToast, 3000);
      });
    }

    function stopRecording() {
      if (voiceStartPhase === 'starting' || voiceStartPhase === 'active') invalidateVoiceStart();
      if (hasNativeBridge && isRecording) {
        showMicToast('Processing...');
        try { win.MultiCCBridge.stopRecording(); } catch (_) {}
        isRecording = false;
        micBtn?.classList.remove('recording');
        return;
      }
      if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
      isRecording = false;
      micBtn?.classList.remove('recording');
      hideMicToast();
    }

    const voicePanel = doc && doc.getElementById('voice-panel');
    const voiceRaw = doc && doc.getElementById('vp-raw');
    const voiceRefined = doc && doc.getElementById('vp-refined');
    const voiceStatus = doc && doc.getElementById('vp-status');
    let voiceRefinedFinal = '';

    async function fetchRefined(raw) {
      if (!fetchFn || !voiceStatus || !voiceRefined) return;
      voiceStatus.textContent = 'processing (AuxQueue)...';
      const startedAt = Date.now();
      try {
        const response = await fetchFn(withToken('/api/voice/refine'), {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ raw }),
        });
        const data = await response.json();
        const clientMs = Date.now() - startedAt;
        if (data.ok && data.text) {
          voiceRefined.value = data.text;
          voiceRefinedFinal = data.text;
          voiceStatus.textContent = `done (${(data.ms / 1000).toFixed(1)}s server, ${(clientMs / 1000).toFixed(1)}s total)`;
        } else {
          voiceRefined.value = data.text || '';
          voiceRefinedFinal = voiceRefined.value;
          voiceStatus.textContent = data.ok ? 'done' : `error: ${data.text || 'unknown'}`;
        }
      } catch (error) {
        voiceStatus.textContent = 'error';
        console.error('[voice] refine error:', error);
      }
    }

    function showVoicePanel(rawText) {
      if (!voicePanel || !voiceRaw || !voiceRefined || !voiceStatus) return;
      voiceRaw.value = rawText;
      voiceRefined.value = '';
      voiceRefined.placeholder = 'Processing...';
      voiceStatus.textContent = '';
      voiceRefinedFinal = '';
      voicePanel.classList.add('open');
      fetchRefined(rawText);
    }

    function closeVoicePanel() { voicePanel?.classList.remove('open'); }

    function useVoiceText(text) {
      if (!inputEl) return;
      inputEl.value = text;
      inputEl.style.height = 'auto';
      inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
      inputEl.focus();
      closeVoicePanel();
    }

    async function uploadAudioForSTT(blob) {
      if (!fetchFn) return false;
      micBtn?.classList.add('processing');
      showMicToast('Transcribing...');
      try {
        const data = new win.FormData();
        data.append('file', blob, 'recording.webm');
        const response = await fetchFn(withToken('/api/voice/stt'), { method: 'POST', body: data });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
        hideMicToast();
        if (result.text?.trim()) showVoicePanel(result.text.trim());
        else {
          showMicToast('No speech detected');
          win.setTimeout(hideMicToast, 2000);
        }
        return true;
      } catch (error) {
        showMicToast('STT failed: ' + error.message);
        win.setTimeout(hideMicToast, 3000);
        return false;
      } finally {
        micBtn?.classList.remove('processing');
      }
    }

    let hudActive = false;
    let voiceStream = null;
    let voiceStartGeneration = 0;
    let voiceStartPhase = 'idle';
    let voiceStartPromise = null;
    let hudRawFinal = '';
    let hudRawPartial = '';
    let hudRefined = '';
    let hudRefineAbort = null;
    let hudRefineTimer = null;
    let hudRefineSeq = 0;
    let asrStreamingAvailable = false;
    const hud = doc && doc.getElementById('voice-hud');
    const hudRawText = doc && doc.getElementById('vh-raw-text');
    const hudRefinedText = doc && doc.getElementById('vh-refined-text');
    const hudStatus = doc && doc.getElementById('vh-status-text');
    const hudCancel = doc && doc.getElementById('vh-cancel');
    const hudSend = doc && doc.getElementById('vh-send');

    function renderHudRaw() {
      if (!hudRawText || doc.activeElement === hudRawText) return;
      hudRawText.innerHTML = '';
      if (hudRawFinal) hudRawText.appendChild(doc.createTextNode(hudRawFinal));
      if (hudRawPartial) {
        const span = doc.createElement('span');
        span.className = 'vh-partial';
        span.textContent = (hudRawFinal ? ' ' : '') + hudRawPartial;
        hudRawText.appendChild(span);
      }
    }

    function setHudStatus(text, className) {
      if (!hud || !hudStatus) return;
      hudStatus.textContent = text;
      hud.classList.remove('refining', 'done');
      if (className) hud.classList.add(className);
    }

    function resetHud() {
      hudRawFinal = '';
      hudRawPartial = '';
      hudRefined = '';
      hudRefineSeq++;
      if (hudRefineAbort) { try { hudRefineAbort.abort(); } catch (_) {} hudRefineAbort = null; }
      if (hudRefineTimer) { win.clearTimeout(hudRefineTimer); hudRefineTimer = null; }
      hud?.classList.remove('has-refined', 'refining', 'done');
      if (hudRefinedText) hudRefinedText.textContent = '';
      renderHudRaw();
    }

    async function runHudRefine(raw) {
      if (hudRefineAbort) { try { hudRefineAbort.abort(); } catch (_) {} }
      const seq = ++hudRefineSeq;
      const controller = new win.AbortController();
      hudRefineAbort = controller;
      hud?.classList.add('refining');
      try {
        const response = await fetchFn(withToken('/api/voice/refine'), {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ raw }), signal: controller.signal,
        });
        const data = await response.json();
        if (seq !== hudRefineSeq) return;
        if (data.ok && typeof data.text === 'string' && data.text.trim()) {
          hudRefined = data.text.trim();
          if (hudRefinedText && doc.activeElement !== hudRefinedText) hudRefinedText.textContent = hudRefined;
          hud?.classList.add('has-refined');
        }
      } catch (error) {
        if (error.name !== 'AbortError') console.warn('[voice-hud] refine failed:', error.message);
      } finally {
        if (hudRefineAbort === controller) hudRefineAbort = null;
        if (seq === hudRefineSeq) hud?.classList.remove('refining');
      }
    }

    function scheduleHudRefine() {
      if (hudRefineTimer) win.clearTimeout(hudRefineTimer);
      const raw = hudRawFinal.trim();
      if (!raw) return;
      hudRefineTimer = win.setTimeout(() => { hudRefineTimer = null; runHudRefine(raw); }, 250);
    }

    function closeVoiceStream(candidate) {
      if (!candidate) return;
      try { candidate.abort ? candidate.abort() : candidate.stop(); } catch (_) {}
    }

    function ownsVoiceStart(generation, candidate) {
      if (generation !== voiceStartGeneration) return false;
      if (voiceStartPhase !== 'starting' && voiceStartPhase !== 'active') return false;
      return candidate == null || voiceStream === candidate;
    }

    function invalidateVoiceStart() {
      voiceStartGeneration++;
      voiceStartPhase = 'idle';
      voiceStartPromise = null;
      hudActive = false;
      const candidate = voiceStream;
      voiceStream = null;
      closeVoiceStream(candidate);
    }

    function startStreamingVoice() {
      if (!hud) { startRecording(); return; }
      if (voiceStartPhase === 'starting') return voiceStartPromise;
      if (voiceStartPhase === 'active') return Promise.resolve(false);

      const generation = ++voiceStartGeneration;
      voiceStartPhase = 'starting';
      const protocol = loc.protocol === 'https:' ? 'wss:' : 'ws:';
      const pending = (async () => {
        let wsUrl;
        try { wsUrl = await win.multiccWsUrl(`${protocol}//${loc.host}/ws/voice`); }
        catch (_) {
          if (ownsVoiceStart(generation)) {
            voiceStartPhase = 'idle';
            setHudStatus('语音连接失败');
          }
          return false;
        }
        if (!ownsVoiceStart(generation)) return false;

        resetHud();
        hud.classList.add('open');
        setHudStatus('聆听中');
        micBtn?.classList.add('recording');
        let candidate = null;
        if (!ownsVoiceStart(generation)) return false;
        try {
          candidate = new win.VoiceStream({
            wsUrl, provider: 'auto', lang: 'zh',
            onText(full, isFinal) {
              if (!ownsVoiceStart(generation, candidate)) return;
              if (isFinal) { hudRawFinal = full; hudRawPartial = ''; renderHudRaw(); scheduleHudRefine(); }
              else { hudRawPartial = full.startsWith(hudRawFinal) ? full.slice(hudRawFinal.length) : full; renderHudRaw(); }
            },
            onDone(finalText) {
              if (!ownsVoiceStart(generation, candidate)) return;
              const text = (finalText || hudRawFinal || '').trim();
              voiceStartPhase = 'idle';
              voiceStream = null;
              hudActive = false;
              micBtn?.classList.remove('recording');
              setHudStatus(text ? '识别完成' : '未识别到语音', 'done');
            },
            onError(message) {
              if (!ownsVoiceStart(generation, candidate)) return;
              voiceStartPhase = 'idle';
              voiceStream = null;
              setHudStatus('⚠ ' + message, 'done');
              hudActive = false;
              micBtn?.classList.remove('recording');
            },
          });
        } catch (error) {
          if (ownsVoiceStart(generation)) {
            voiceStartPhase = 'idle';
            setHudStatus('⚠ ' + (error.message || '启动失败'), 'done');
            micBtn?.classList.remove('recording');
          }
          return false;
        }
        if (!ownsVoiceStart(generation)) {
          closeVoiceStream(candidate);
          return false;
        }
        voiceStream = candidate;
        try {
          await candidate.start();
        } catch (error) {
          if (ownsVoiceStart(generation, candidate)) {
            voiceStartPhase = 'idle';
            voiceStream = null;
            setHudStatus('⚠ ' + (error.message || '启动失败'), 'done');
            hudActive = false;
            micBtn?.classList.remove('recording');
          }
          closeVoiceStream(candidate);
          return false;
        }
        if (!ownsVoiceStart(generation, candidate)) {
          closeVoiceStream(candidate);
          return false;
        }
        voiceStartPhase = 'active';
        hudActive = true;
        return true;
      })();
      voiceStartPromise = pending;
      const settleStart = () => {
        if (voiceStartPromise === pending) voiceStartPromise = null;
        if (generation === voiceStartGeneration && voiceStartPhase === 'starting') {
          voiceStartPhase = 'idle';
          micBtn?.classList.remove('recording');
        }
      };
      pending.then(settleStart, settleStart);
      return pending;
    }

    async function commitStreamingVoice() {
      invalidateVoiceStart();
      micBtn?.classList.remove('recording');
      setHudStatus('识别中…');
      const rawBefore = hudRawFinal;
      const startedAt = Date.now();
      while (Date.now() - startedAt < 800) {
        await new Promise(resolve => win.setTimeout(resolve, 80));
        if (hudRawFinal !== rawBefore) break;
      }
      if (hudRefineTimer) {
        win.clearTimeout(hudRefineTimer);
        hudRefineTimer = null;
        if (hudRawFinal.trim()) await runHudRefine(hudRawFinal.trim());
      } else if (hudRefineAbort) {
        const waitStart = Date.now();
        while (hudRefineAbort && Date.now() - waitStart < 3000) {
          await new Promise(resolve => win.setTimeout(resolve, 80));
        }
      }
      const refined = (hudRefinedText?.textContent || '').trim() || hudRefined;
      const raw = (hudRawText?.textContent || '').trim() || hudRawFinal;
      const text = (refined || raw).trim();
      hud?.classList.remove('open');
      if (!text || !inputEl) return;
      inputEl.value = text;
      inputEl.style.height = 'auto';
      inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
      send();
      fetchFn(withToken('/api/voice/feedback'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw: raw.trim(), refined: hudRefined, userFinal: text }),
      }).catch(() => {});
    }

    function cancelStreamingVoice() {
      invalidateVoiceStart();
      micBtn?.classList.remove('recording');
      resetHud();
      hud?.classList.remove('open');
    }

    function bindVoice() {
      // The native host may install MultiCCBridge after the page script has
      // loaded, so retain the legacy callbacks even in an ordinary browser.
      win.__multiccRecStarted = () => {};
      win.__multiccRecReady = async () => {
        isRecording = false;
        micBtn?.classList.remove('recording');
        micBtn?.classList.add('processing');
        showMicToast('Transcribing...');
        try {
          const response = await fetchFn('/__recording');
          await uploadAudioForSTT(await response.blob());
        } catch (error) {
          showMicToast('Error: ' + error.message);
          win.setTimeout(hideMicToast, 3000);
          micBtn?.classList.remove('processing');
        }
      };
      win.__multiccRecError = message => {
        isRecording = false;
        micBtn?.classList.remove('recording', 'processing');
        showMicToast('Record error: ' + message);
        win.setTimeout(hideMicToast, 3000);
      };

      hudRefinedText?.addEventListener('input', () => { hudRefined = (hudRefinedText.textContent || '').trim(); });
      hudRawText?.addEventListener('input', () => { hudRawFinal = (hudRawText.textContent || '').trim(); });
      for (const editable of [hudRefinedText, hudRawText]) {
        editable?.addEventListener('keydown', event => {
          if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
            event.preventDefault();
            commitStreamingVoice();
          }
        });
      }
      hudCancel?.addEventListener('click', cancelStreamingVoice);
      hudSend?.addEventListener('click', commitStreamingVoice);
      doc?.getElementById('vp-cancel')?.addEventListener('click', closeVoicePanel);
      doc?.getElementById('vp-use-raw')?.addEventListener('click', () => useVoiceText(voiceRaw?.value || ''));
      doc?.getElementById('vp-use-refined')?.addEventListener('click', () => useVoiceText(voiceRefinedFinal || voiceRefined?.value || voiceRaw?.value || ''));

      const canLegacyRecord = hasNativeBridge || (!!win.MediaRecorder && !!nav.mediaDevices);
      const canStream = !!(nav.mediaDevices && win.AudioWorkletNode && win.VoiceStream && !hasNativeBridge);
      if (fetchFn) {
        fetchFn(withToken('/api/settings/voice')).then(response => response.json()).then(data => {
          const status = data && data.asr && data.asr.status;
          asrStreamingAvailable = !!(status && (status.local?.ready || status.openai?.ready || status.volcano?.ready || status.funasr?.ready));
        }).catch(() => { asrStreamingAvailable = false; });
      }
      if (!micBtn) return;
      if (!canLegacyRecord && !canStream) {
        micBtn.disabled = true;
        micBtn.title = 'Recording not supported (needs HTTPS / AudioWorklet)';
      } else {
        micBtn.onclick = () => {
          if (canStream && asrStreamingAvailable) {
            if (voiceStartPhase === 'starting') return;
            if (voiceStartPhase === 'active' || hudActive) commitStreamingVoice();
            else startStreamingVoice();
          } else if (isRecording) stopRecording();
          else startRecording();
        };
      }
    }

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
      newClientMsgId,
    });
  }

  global.MultiCCChatComposer = Object.freeze({
    createComposer,
    defaultClientMessageId,
    pastedFileName,
  });
})(window);
