(function attachMultiCCVoiceComposer(global) {
  'use strict';

  // Voice input for a composer, extracted from chat-composer.js so the Chat page
  // and the Air directory's quick-task composer share one implementation. It is
  // deliberately host-agnostic: the caller hands in the input box, the mic
  // button and the toast/panel/HUD host elements, and supplies `onCommit` — the
  // one thing that differs between hosts. On the Chat page that callback is
  // `send()`; on Air it submits the quick-task form.
  //
  // Two dictation paths, unchanged from the Chat page:
  //   • streaming (VoiceStream over /ws/voice) with the floating HUD, debounced
  //     AI refine, and commit-replaces-input, when the server reports a local
  //     streaming ASR; and
  //   • legacy one-shot recording (MediaRecorder or the native bridge) that
  //     uploads to /api/voice/stt and opens the refine panel.
  function createVoiceComposer(options) {
    const opts = options || {};
    const win = opts.window || global;
    const doc = opts.document || win.document;
    const nav = opts.navigator || win.navigator || {};
    const loc = opts.location || win.location || {};
    const inputEl = opts.input;
    const micBtn = opts.micButton;
    const micToast = opts.micToast;
    const fetchFn = opts.fetch || (win.fetch && win.fetch.bind(win));
    const withToken = opts.withToken || (url => url);
    const hasNativeBridge = opts.hasNativeBridge === true;
    const installNativeBridgeCallbacks = opts.installNativeBridgeCallbacks !== false;
    const onCommit = typeof opts.onCommit === 'function' ? opts.onCommit : (() => {});

    // Host elements. Chat passes only the input/mic/toast; the voice panel and
    // HUD are looked up by the ids chat.html has always used, and a host that
    // mounts a different tree can override any of them explicitly.
    const voicePanel = opts.voicePanel || (doc && doc.getElementById('voice-panel'));
    const voiceRaw = opts.voiceRaw || (doc && doc.getElementById('vp-raw'));
    const voiceRefined = opts.voiceRefined || (doc && doc.getElementById('vp-refined'));
    const voiceStatus = opts.voiceStatus || (doc && doc.getElementById('vp-status'));
    const hud = opts.hud || (doc && doc.getElementById('voice-hud'));
    const hudRawText = opts.hudRawText || (doc && doc.getElementById('vh-raw-text'));
    const hudRefinedText = opts.hudRefinedText || (doc && doc.getElementById('vh-refined-text'));
    const hudStatus = opts.hudStatus || (doc && doc.getElementById('vh-status-text'));
    const hudCancel = opts.hudCancel || (doc && doc.getElementById('vh-cancel'));
    const hudSend = opts.hudSend || (doc && doc.getElementById('vh-send'));

    let mediaRecorder = null;
    let audioChunks = [];
    let isRecording = false;
    let recordingStream = null;

    function showMicToast(text) {
      if (!micToast) return;
      micToast.textContent = text;
      micToast.classList.add('show');
    }

    function hideMicToast() {
      micToast?.classList.remove('show');
    }

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

    function setInputValue(text) {
      if (!inputEl) return;
      inputEl.value = text;
      inputEl.style.height = 'auto';
      inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
    }

    function useVoiceText(text) {
      if (!inputEl) return;
      setInputValue(text);
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
      setInputValue(text);
      onCommit(text);
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
      if (installNativeBridgeCallbacks) {
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
      }

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

    if (opts.autoBind !== false) bindVoice();

    return Object.freeze({
      bindVoice,
      startRecording, stopRecording, uploadAudioForSTT,
      startStreamingVoice, commitStreamingVoice, cancelStreamingVoice,
      showVoicePanel, closeVoicePanel, useVoiceText, fetchRefined,
    });
  }

  global.MultiCCVoiceComposer = Object.freeze({ createVoiceComposer });
})(window);
