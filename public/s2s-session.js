/* ════════════════════════════════════════════════════════════════════════════
 * S2SSession — 豆包式 Speech-to-Speech 语音交互编排器
 *
 * 状态机: IDLE → LISTENING → CONFIRMING → EXECUTING → REPORTING → IDLE
 *
 * 流程:
 *   1. LISTENING  — 连续语音输入 (VAD 静音检测 → MediaRecorder 录音 → Whisper STT)
 *   2. CONFIRMING — LLM 拆解需求 → TTS 念出 → 用户逐项确认 (可多轮)
 *   3. EXECUTING  — 确认后发送到 chat WS → 用户进入等待
 *   4. REPORTING  — 监控 chat 事件 → aux AI 总结 → TTS 播报;
 *                   超过 60s 无响应 → "任务还在进行中"
 *   5. 任务完成 → TTS 播报结果 → 回到 IDLE
 *
 * 依赖: VoiceOutput (TTS), VadMonitor (静音检测), chat.js 的 ws 连接
 * 使用 /api/voice/stt (Whisper) 做语音识别 — 与现有 mic 按钮同一通道
 * ════════════════════════════════════════════════════════════════════════════ */

class S2SSession {
  constructor(opts) {
    this.opts = opts || {};
    this.wsUrl = opts.wsUrl || location.origin.replace(/^http/, 'ws');
    this.httpUrl = this.wsUrl.replace(/^ws/, 'http').replace(/^wss/, 'https');

    // State machine
    this.state = 'IDLE'; // IDLE | LISTENING | CONFIRMING | EXECUTING | REPORTING

    // Audio components
    this.mediaStream = null;
    this.vadMonitor = null;
    this.voiceOutput = null;  // VoiceOutput (TTS)
    this.mediaRecorder = null;
    this.audioChunks = [];
    this.isRecording = false;

    // Accumulated text from current ASR round
    this.accumulatedText = '';

    // Confirmation flow
    this.currentBreakdown = null; // { summary, items, questions, allConfirmed }

    // Progress monitoring
    this.taskDescription = '';
    this.progressEvents = [];     // events since last summary
    this.lastActivityTime = 0;    // timestamp of last chat event
    this.progressTimer = null;    // setInterval for periodic check
    this.summaryTimer = null;     // setInterval for timeout check
    this.lastSummaryTime = 0;

    // Chat WS hook
    this._taskCompleted = false;

    // Callbacks
    this.onStateChange = opts.onStateChange || (() => {});
    this.onText = opts.onText || (() => {});         // ASR text
    this.onAiText = opts.onAiText || (() => {});     // AI text to display
    this.onBreakdown = opts.onBreakdown || (() => {}); // confirmation breakdown update
    this.onError = opts.onError || (() => {});
    this.onLog = opts.onLog || (() => {});
    this.onVolume = opts.onVolume || (() => {});
    this.onVadDebug = opts.onVadDebug || (() => {}); // live VAD diagnostics
    this.onAsrStatus = opts.onAsrStatus || (() => {}); // "recording" | "transcribing" | "idle"

    // Binds
    this._handleChatEvent = this._handleChatEvent.bind(this);
  }

  // ── Public API ──────────────────────────────────────────────────────────

  async start() {
    if (this.state !== 'IDLE') return;
    this._log('Starting S2S session');
    this._setState('LISTENING');
    this.accumulatedText = '';

    try {
      // Get microphone — single getUserMedia shared by VAD and MediaRecorder
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });

      // Start VAD for silence detection (await to catch errors). Thresholds are
      // RMS amplitudes (see VadMonitor) with an adaptive noise floor on top, so
      // normal speaking volume triggers reliably without a hot mic.
      this.vadMonitor = new VadMonitor({
        stream: this.mediaStream,
        silenceThreshold: 0.010,
        silenceTimeout: 1500,   // 1.5s silence = user finished speaking
        speechThreshold: 0.018,
        speechTimeout: 250,
        onSpeechStart: () => this._onSpeechStart(),
        onSilence: (dur) => this._onSilence(dur),
        onVolume: (level) => this.onVolume(level),
        onDebug: (info) => this.onVadDebug(info),
      });
      await this.vadMonitor.start(this.mediaStream);

      // Hook into chat WS to intercept events
      this._hookChatWs();

      this._log('S2S session started, listening...');
    } catch (err) {
      this._setState('IDLE');
      this.onError('无法启动语音会话: ' + err.message);
      this._cleanup();
    }
  }

  stop() {
    this._log('Stopping S2S session');
    this._setState('IDLE');
    this._stopRecording();
    this._stopTts();
    this._unhookChatWs();
    this._clearTimers();
    this._cleanup();
  }

  _cleanup() {
    if (this.vadMonitor) { this.vadMonitor.stop(); this.vadMonitor = null; }
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(t => t.stop());
      this.mediaStream = null;
    }
    this.accumulatedText = '';
    this.currentBreakdown = null;
    this.progressEvents = [];
  }

  getState() { return this.state; }

  // ── Recording + STT ──────────────────────────────────────────────────────

  _startRecording() {
    if (this.isRecording || !this.mediaStream) return;
    this.audioChunks = [];
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';

    try {
      this.mediaRecorder = new MediaRecorder(this.mediaStream, mimeType ? { mimeType } : {});
    } catch (e) {
      this._log('MediaRecorder creation failed:', e.message);
      return;
    }

    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.audioChunks.push(e.data);
    };
    this.mediaRecorder.onstop = () => {
      const blob = new Blob(this.audioChunks, { type: this.mediaRecorder.mimeType || 'audio/webm' });
      this.audioChunks = [];
      if (blob.size > 0) this._transcribe(blob);
    };

    this.mediaRecorder.start();
    this.isRecording = true;
    this.onAsrStatus('recording');
    this._log('Recording started');
  }

  _stopRecording() {
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      try { this.mediaRecorder.stop(); } catch (_) {}
    }
    this.isRecording = false;
  }

  async _transcribe(blob) {
    this.onAsrStatus('transcribing');
    this._log('Transcribing audio, size:', blob.size);

    try {
      const fd = new FormData();
      fd.append('file', blob, 's2s-recording.webm');
      const res = await fetch(withToken(`${this.httpUrl}/api/voice/stt`), {
        method: 'POST',
        body: fd,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

      const text = (data.text || '').trim();
      this._log('STT result:', text.slice(0, 80));

      if (text) {
        this.accumulatedText = text;
        this.onText(text, true);
        // Process the text based on current state
        this._processRecognizedText(text);
      } else {
        this._log('Empty STT result, ignoring');
        // Surface it so the panel doesn't look frozen after the user spoke.
        this.onText('（没听清，请再说一次）', true);
        this.onAsrStatus('idle');
      }
    } catch (err) {
      this._log('STT failed:', err.message);
      this.onError('语音识别失败: ' + err.message);
      this.onAsrStatus('idle');
    }
  }

  _processRecognizedText(text) {
    if (this.state === 'LISTENING') {
      // If we have a pending breakdown, the user is responding to confirmation
      // Both branches are async; catch so a failure surfaces instead of
      // silently leaving the session stuck in LISTENING.
      const p = (this.currentBreakdown && !this.currentBreakdown.allConfirmed)
        ? this._handleConfirmationResponse(text)
        : this._enterConfirming(text);
      Promise.resolve(p).catch((err) => {
        this._log('processRecognizedText failed:', err && err.message);
        this.onError('需求处理失败: ' + (err && err.message || err));
        this._setState('LISTENING');
        this.accumulatedText = '';
      });
    }
  }

  // ── VAD callbacks ───────────────────────────────────────────────────────

  _onSpeechStart() {
    // Barge-in: if TTS is playing, stop it
    if (this.state === 'CONFIRMING') {
      this._log('Barge-in during confirming, stopping TTS');
      this._stopTts();
      this._setState('LISTENING');
      this.accumulatedText = '';
    } else if (this.state === 'REPORTING') {
      this._log('Barge-in during reporting, stopping TTS');
      this._stopTts();
      this._setState('EXECUTING');
    }

    // Start recording when user begins speaking (in LISTENING state)
    if (this.state === 'LISTENING') {
      this._startRecording();
    }
  }

  _onSilence(duration) {
    if (this.state !== 'LISTENING') return;
    // Stop recording and transcribe
    if (this.isRecording) {
      this._log('Silence detected, stopping recording');
      this._stopRecording();
      // _transcribe will be called by mediaRecorder.onstop
    }
  }

  // ── Phase: CONFIRMING ──────────────────────────────────────────────────

  async _enterConfirming(rawText) {
    this._setState('CONFIRMING');
    this.onAsrStatus('idle');

    // Immediately TTS a "let me confirm" message
    this._speak('好的，我来确认一下你的需求。');

    try {
      const breakdown = await this._callConfirm(rawText, null, null);
      this.currentBreakdown = breakdown;
      this.onBreakdown(breakdown);

      if (breakdown.allConfirmed) {
        this._speak(breakdown.summary);
        this._enterExecuting(rawText);
        return;
      }

      // TTS the summary + items
      const ttsText = this._buildConfirmTts(breakdown);
      await this._speak(ttsText);

      // After TTS, listen for user's confirmation response
      this._setState('LISTENING');
      this.accumulatedText = '';
    } catch (err) {
      this.onError('需求确认失败: ' + err.message);
      this._setState('LISTENING');
      this.accumulatedText = '';
    }
  }

  _buildConfirmTts(breakdown) {
    let text = breakdown.summary || '我理解你的需求如下：';
    if (breakdown.items && breakdown.items.length > 0) {
      text += ' ';
      breakdown.items.forEach((item, i) => {
        text += `第${i + 1}，${item}。`;
      });
    }
    if (breakdown.questions && breakdown.questions.length > 0) {
      text += ' 另外有个问题：' + breakdown.questions.join('；');
    }
    text += ' 请确认是否正确，或者告诉我哪里需要修改。';
    return text;
  }

  async _handleConfirmationResponse(userText) {
    this._setState('CONFIRMING');
    this.onAsrStatus('idle');

    try {
      const breakdown = await this._callConfirm(
        this.accumulatedText,
        this.currentBreakdown,
        userText
      );
      this.currentBreakdown = breakdown;
      this.onBreakdown(breakdown);

      if (breakdown.allConfirmed) {
        this._speak('好的，需求确认完毕，开始执行。');
        const taskText = this._buildTaskText(breakdown);
        this._enterExecuting(taskText);
        return;
      }

      // Not fully confirmed — speak updated understanding
      const ttsText = this._buildConfirmTts(breakdown);
      await this._speak(ttsText);

      // Listen again for further feedback
      this._setState('LISTENING');
      this.accumulatedText = '';
    } catch (err) {
      this.onError('确认处理失败: ' + err.message);
      this._setState('LISTENING');
      this.accumulatedText = '';
    }
  }

  _buildTaskText(breakdown) {
    const parts = [];
    if (breakdown.summary) parts.push(breakdown.summary);
    if (breakdown.items && breakdown.items.length) {
      parts.push('具体要求：\n' + breakdown.items.map((it, i) => `${i + 1}. ${it}`).join('\n'));
    }
    return parts.join('\n\n');
  }

  async _callConfirm(text, previousBreakdown, userFeedback) {
    const body = { text: text || '' };
    if (previousBreakdown) body.previousBreakdown = previousBreakdown;
    if (userFeedback) body.userFeedback = userFeedback;

    const res = await fetch(withToken(`${this.httpUrl}/api/voice/confirm`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  // ── Phase: EXECUTING ───────────────────────────────────────────────────

  _enterExecuting(taskText) {
    this._setState('EXECUTING');
    this.taskDescription = taskText;
    this.progressEvents = [];
    this.lastActivityTime = Date.now();
    this.lastSummaryTime = Date.now();
    this._taskCompleted = false;

    // Send the task to chat WebSocket
    this._sendChatMessage(taskText);

    // Start progress monitoring timers
    this._startProgressTimers();

    this._log('Task dispatched, entering waiting state');
  }

  _startProgressTimers() {
    this._clearTimers();

    // Check every 15s for progress to summarize
    this.progressTimer = setInterval(() => {
      this._checkProgress();
    }, 15000);

    // 60s inactivity check (check every 30s)
    this.summaryTimer = setInterval(() => {
      const idle = Date.now() - this.lastActivityTime;
      if (idle > 60000) {
        this._speak('任务还在进行中，请稍候。');
        this.lastActivityTime = Date.now(); // reset so we don't repeat too fast
      }
    }, 30000);
  }

  _clearTimers() {
    if (this.progressTimer) { clearInterval(this.progressTimer); this.progressTimer = null; }
    if (this.summaryTimer) { clearInterval(this.summaryTimer); this.summaryTimer = null; }
  }

  _checkProgress() {
    if (this.state !== 'EXECUTING' && this.state !== 'REPORTING') return;
    if (this.progressEvents.length === 0) return;

    const sinceLastSummary = Date.now() - this.lastSummaryTime;
    if (sinceLastSummary < 20000) return; // min 20s between summaries

    this._reportProgress();
  }

  async _reportProgress() {
    if (this.progressEvents.length === 0) return;
    this._setState('REPORTING');

    const events = this.progressEvents.slice(-10); // last 10 events
    this.progressEvents = [];
    this.lastSummaryTime = Date.now();

    try {
      const res = await fetch(withToken(`${this.httpUrl}/api/voice/progress-summary`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ events, taskDescription: this.taskDescription }),
      });
      const data = await res.json();
      if (data.ok && data.summary) {
        this._speak(data.summary);
      }
    } catch (err) {
      this._log('Progress summary failed:', err.message);
    }

    // Return to executing state (waiting)
    if (this.state === 'REPORTING') {
      this._setState('EXECUTING');
    }
  }

  // ── Chat WS hook ─────────────────────────────────────────────────────────

  _hookChatWs() {
    if (typeof ws === 'undefined' || !ws) {
      this._log('Chat WS not available, will retry in 1s');
      setTimeout(() => this._hookChatWs(), 1000);
      return;
    }
    ws.addEventListener('message', this._handleChatEvent);
    this._log('Hooked into chat WS');
  }

  _unhookChatWs() {
    if (typeof ws !== 'undefined' && ws && this._handleChatEvent) {
      ws.removeEventListener('message', this._handleChatEvent);
    }
  }

  _handleChatEvent(event) {
    // Only intercept during executing/reporting phases
    if (this.state !== 'EXECUTING' && this.state !== 'REPORTING') return;

    let msg;
    try { msg = JSON.parse(event.data); } catch (_) { return; }

    const now = Date.now();

    switch (msg.type) {
      case 'stream_event': {
        const evt = msg.event;
        if (!evt) break;
        if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta' && evt.delta.text) {
          this.progressEvents.push({ type: 'assistant_text', summary: evt.delta.text.slice(0, 200) });
          this.lastActivityTime = now;
        } else if (evt.type === 'content_block_start' && evt.content_block?.type === 'tool_use') {
          this.progressEvents.push({ type: 'tool_use', summary: `使用工具: ${evt.content_block.name}` });
          this.lastActivityTime = now;
        }
        break;
      }
      case 'assistant': {
        if (msg.message?.content) {
          for (const block of msg.message.content) {
            if (block.type === 'text' && block.text) {
              this.progressEvents.push({ type: 'assistant_message', summary: block.text.slice(0, 300) });
              this.lastActivityTime = now;
            }
          }
        }
        break;
      }
      case 'user': {
        if (msg.tool_use_result) {
          const text = typeof msg.message?.content === 'string'
            ? msg.message.content
            : Array.isArray(msg.message?.content)
              ? msg.message.content.map(c => c.text || '').join('')
              : '';
          this.progressEvents.push({ type: 'tool_result', summary: text.slice(0, 300) });
          this.lastActivityTime = now;
        }
        break;
      }
      case 'result': {
        this.progressEvents.push({ type: 'result', summary: `任务回合完成，耗时 ${msg.duration_ms || '?'}ms` });
        this.lastActivityTime = now;
        break;
      }
      case 'notify': {
        if (msg.state === 'completed' || msg.state === 'waiting') {
          this._onTaskComplete(msg);
        }
        break;
      }
      case 'stream_end': {
        if (this.state === 'EXECUTING' || this.state === 'REPORTING') {
          setTimeout(() => {
            if (this.state === 'EXECUTING' || this.state === 'REPORTING') {
              this._onTaskComplete({ state: 'completed' });
            }
          }, 2000);
        }
        break;
      }
    }
  }

  _onTaskComplete(notifyMsg) {
    if (this._taskCompleted) return;
    this._taskCompleted = true;
    this._clearTimers();

    const isWaiting = notifyMsg.state === 'waiting';
    const finalText = isWaiting ? '任务已完成，等待你的下一步指示。' : '任务已完成。';

    if (this.progressEvents.length > 0) {
      this._reportFinalProgress(finalText);
    } else {
      this._speak(finalText);
      this._finishTask();
    }
  }

  async _reportFinalProgress(fallbackText) {
    try {
      const events = this.progressEvents.slice(-15);
      this.progressEvents = [];
      const res = await fetch(withToken(`${this.httpUrl}/api/voice/progress-summary`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ events, taskDescription: this.taskDescription }),
      });
      const data = await res.json();
      const summary = (data.ok && data.summary) ? data.summary : fallbackText;
      this._speak(summary + ' ' + fallbackText);
    } catch (_) {
      this._speak(fallbackText);
    }
    this._finishTask();
  }

  _finishTask() {
    this._setState('LISTENING');
    this.accumulatedText = '';
    this.taskDescription = '';
    this.currentBreakdown = null;
  }

  // ── TTS ──────────────────────────────────────────────────────────────────

  _speak(text) {
    if (!text) return Promise.resolve();
    this._log('TTS:', text.slice(0, 80));
    this._stopTts();

    const ttsProvider = this.opts.ttsProvider || 'edge';
    const ttsWsUrl = `${this.wsUrl}/ws/tts`;

    // Never reject: TTS is best-effort narration. A failed playback must not
    // break the confirm/execute flow, so any error resolves quietly (logged).
    return new Promise((resolve) => {
      try {
        this.voiceOutput = new VoiceOutput({
          wsUrl: ttsWsUrl,
          provider: ttsProvider,
          onDone: () => { this.voiceOutput = null; resolve(); },
          onError: (msg) => { this._log('TTS error:', msg); this.voiceOutput = null; resolve(); },
        });
        this.voiceOutput.speak(text).catch((e) => {
          this._log('TTS speak failed:', e && e.message);
          this.voiceOutput = null;
          resolve();
        });
      } catch (e) {
        this._log('TTS init failed:', e && e.message);
        this.voiceOutput = null;
        resolve();
      }
    });
  }

  _stopTts() {
    if (this.voiceOutput) {
      try { this.voiceOutput.stop(); } catch (_) {}
      this.voiceOutput = null;
    }
  }

  // ── Chat message sending ─────────────────────────────────────────────────

  _sendChatMessage(text) {
    if (typeof ws === 'undefined' || !ws || ws.readyState !== WebSocket.OPEN) {
      this._log('Chat WS not open, cannot send task');
      this.onError('聊天连接未就绪');
      return;
    }
    ws.send(JSON.stringify({ type: 'user_message', text }));
  }

  // ── State management ─────────────────────────────────────────────────────

  _setState(state) {
    this.state = state;
    this._log('State →', state);
    this.onStateChange(state);
  }

  _log(...args) {
    this.onLog(args.map(String).join(' '));
  }
}

// Expose globally
window.S2SSession = S2SSession;
