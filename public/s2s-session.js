/* ════════════════════════════════════════════════════════════════════════════
 * S2SSession — 豆包式 Speech-to-Speech 语音交互编排器
 *
 * 状态机: IDLE → LISTENING → CONFIRMING → EXECUTING → REPORTING → IDLE
 *
 * 流程:
 *   1. LISTENING  — 连续语音输入 (VAD 静音检测 → 自动提交)
 *   2. CONFIRMING — LLM 拆解需求 → TTS 念出 → 用户逐项确认 (可多轮)
 *   3. EXECUTING  — 确认后发送到 chat WS → 用户进入等待
 *   4. REPORTING  — 监控 chat 事件 → aux AI 总结 → TTS 播报;
 *                   超过 60s 无响应 → "任务还在进行中"
 *   5. 任务完成 → TTS 播报结果 → 回到 IDLE
 *
 * 依赖: VoiceStream, VoiceOutput, VadMonitor (已加载), chat.js 的 ws 连接
 * ════════════════════════════════════════════════════════════════════════════ */

class S2SSession {
  constructor(opts) {
    this.opts = opts || {};
    // wsUrl is like ws://host:port  (no path)
    this.wsUrl = opts.wsUrl || location.origin.replace(/^http/, 'ws');
    this.httpUrl = this.wsUrl.replace(/^ws/, 'http').replace(/^wss/, 'https');

    // State machine
    this.state = 'IDLE'; // IDLE | LISTENING | CONFIRMING | EXECUTING | REPORTING

    // Components
    this.mediaStream = null;
    this.vadMonitor = null;
    this.voiceInput = null;   // VoiceStream (ASR)
    this.voiceOutput = null;  // VoiceOutput (TTS)

    // Accumulated text from current ASR round
    this.accumulatedText = '';

    // Confirmation flow
    this.currentBreakdown = null; // { summary, items, questions, allConfirmed }

    // Progress monitoring
    this.taskDescription = '';
    this.progressEvents = [];     // events since last summary
    this.lastActivityTime = 0;    // timestamp of last chat event
    this.progressTimer = null;    // setInterval for periodic check
    this.summaryTimer = null;     // setTimeout for next summary
    this.lastSummaryTime = 0;

    // Chat WS hook (we piggyback on chat.js's ws)
    this._originalOnMessage = null;
    this._originalSend = null;
    this._taskCompleted = false;

    // Callbacks
    this.onStateChange = opts.onStateChange || (() => {});
    this.onText = opts.onText || (() => {});         // ASR partial/final text
    this.onAiText = opts.onAiText || (() => {});     // AI text to display
    this.onBreakdown = opts.onBreakdown || (() => {}); // confirmation breakdown update
    this.onError = opts.onError || (() => {});
    this.onLog = opts.onLog || (() => {});

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
      // Get microphone
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });

      // Start VAD
      this.vadMonitor = new VadMonitor({
        stream: this.mediaStream,
        silenceThreshold: 0.015,
        silenceTimeout: 1200,   // 1.2s silence = user finished speaking
        speechThreshold: 0.025,
        speechTimeout: 200,
        onSpeechStart: () => this._onSpeechStart(),
        onSilence: (dur) => this._onSilence(dur),
        onVolume: (level) => { if (this.opts.onVolume) this.opts.onVolume(level); },
      });
      this.vadMonitor.start(this.mediaStream);

      // Start ASR
      await this._startASR();

      // Hook into chat WS to intercept events
      this._hookChatWs();

      this._log('S2S session started, listening...');
    } catch (err) {
      this._setState('IDLE');
      this.onError('无法启动语音会话: ' + err.message);
    }
  }

  stop() {
    this._log('Stopping S2S session');
    this._setState('IDLE');
    this._stopASR();
    this._stopTts();
    this._unhookChatWs();
    this._clearTimers();

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

  // Allow external code to inject a confirmed task (e.g. user typed instead)
  injectConfirmedTask(text) {
    this.accumulatedText = text;
    this._enterExecuting(text);
  }

  // ── ASR ──────────────────────────────────────────────────────────────────

  async _startASR() {
    const asrProvider = this.opts.asrProvider || 'auto';
    const asrWsUrl = `${this.wsUrl}/ws/voice`;
    this.voiceInput = new VoiceStream({
      wsUrl: asrWsUrl,
      provider: asrProvider,
      lang: 'zh',
      onReady: (provider) => this._log('ASR ready:', provider),
      onText: (text, isFinal) => {
        this.accumulatedText = text;
        this.onText(text, isFinal);
      },
      onDone: (text) => {
        this._log('ASR done:', text);
      },
      onError: (msg) => {
        this._log('ASR error:', msg);
        this.onError(msg);
      },
    });
    await this.voiceInput.start();
  }

  _stopASR() {
    if (this.voiceInput) {
      try { this.voiceInput.abort(); } catch (_) {}
      this.voiceInput = null;
    }
  }

  _restartASR() {
    this._stopASR();
    this.accumulatedText = '';
    return this._startASR().catch(() => {});
  }

  // ── VAD callbacks ───────────────────────────────────────────────────────

  _onSpeechStart() {
    // Barge-in: if TTS is playing, stop it and resume listening
    if (this.state === 'CONFIRMING') {
      this._log('Barge-in during confirming, stopping TTS');
      this._stopTts();
      this._setState('LISTENING');
      this.accumulatedText = '';
      this._restartASR();
    } else if (this.state === 'REPORTING') {
      // During progress reporting, just stop TTS and return to executing
      this._log('Barge-in during reporting, stopping TTS');
      this._stopTts();
      this._setState('EXECUTING');
    }
  }

  _onSilence(duration) {
    if (this.state !== 'LISTENING') return;
    const text = this.accumulatedText.trim();
    if (!text) return;

    this._log('Silence detected, text:', text.slice(0, 80));

    // If we have a pending breakdown, the user is responding to confirmation
    if (this.currentBreakdown && !this.currentBreakdown.allConfirmed) {
      this._handleConfirmationResponse(text);
    } else {
      // First utterance → enter confirmation phase
      this._enterConfirming(text);
    }
  }

  // ── Phase: CONFIRMING ──────────────────────────────────────────────────

  async _enterConfirming(rawText) {
    this._setState('CONFIRMING');
    this._stopASR();

    // Immediately TTS a "let me confirm" message
    this._speak('好的，我来确认一下你的需求。');

    try {
      const breakdown = await this._callConfirm(rawText, null, null);
      this.currentBreakdown = breakdown;
      this.onBreakdown(breakdown);

      if (breakdown.allConfirmed) {
        // Edge case: AI thinks it's already confirmed (shouldn't happen on first pass)
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
      await this._restartASR();
    } catch (err) {
      this.onError('需求确认失败: ' + err.message);
      this._setState('LISTENING');
      this._restartASR();
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
    // User responded during confirming phase — send to confirm endpoint with feedback
    this._setState('CONFIRMING');
    this._stopASR();

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
        // Build the final task text from confirmed items
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
      await this._restartASR();
    } catch (err) {
      this.onError('确认处理失败: ' + err.message);
      this._setState('LISTENING');
      this._restartASR();
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

    // Send the task to chat WebSocket (piggyback on chat.js's ws)
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

    // 60s inactivity check
    this.summaryTimer = setInterval(() => {
      const idle = Date.now() - this.lastActivityTime;
      if (idle > 60000) {
        this._speak('任务还在进行中，请稍候。');
        this.lastActivityTime = Date.now(); // reset so we don't repeat too fast
      }
    }, 30000); // check every 30s, triggers if idle > 60s
  }

  _clearTimers() {
    if (this.progressTimer) { clearInterval(this.progressTimer); this.progressTimer = null; }
    if (this.summaryTimer) { clearInterval(this.summaryTimer); this.summaryTimer = null; }
  }

  _checkProgress() {
    // Only summarize if there are new events and enough time has passed
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
    // We hook into chat.js's global `ws` variable
    if (typeof ws === 'undefined' || !ws) {
      this._log('Chat WS not available, will retry in 1s');
      setTimeout(() => this._hookChatWs(), 1000);
      return;
    }

    // Store original onmessage to chain our handler
    this._originalOnMessage = ws.onmessage;
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
        // Task turn finished
        this.progressEvents.push({ type: 'result', summary: `任务回合完成，耗时 ${msg.duration_ms || '?'}ms` });
        this.lastActivityTime = now;
        break;
      }
      case 'notify': {
        // Task completed or waiting
        if (msg.state === 'completed' || msg.state === 'waiting') {
          this._onTaskComplete(msg);
        }
        break;
      }
      case 'stream_end': {
        // Process exited
        if (this.state === 'EXECUTING' || this.state === 'REPORTING') {
          // Give a brief moment for any final events
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

    // Final progress summary
    const isWaiting = notifyMsg.state === 'waiting';
    const finalText = isWaiting ? '任务已完成，等待你的下一步指示。' : '任务已完成。';

    // Collect any remaining events for a final summary
    if (this.progressEvents.length > 0) {
      // Async: get final summary then speak
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
    // Return to listening for next command
    this._setState('LISTENING');
    this.accumulatedText = '';
    this.taskDescription = '';
    this.currentBreakdown = null; // clear so next utterance starts fresh
    this._restartASR();
  }

  // ── TTS ──────────────────────────────────────────────────────────────────

  _speak(text) {
    if (!text) return Promise.resolve();
    this._log('TTS:', text.slice(0, 80));

    // Stop any current TTS
    this._stopTts();

    const ttsProvider = this.opts.ttsProvider || 'edge';
    const ttsWsUrl = `${this.wsUrl}/ws/tts`;

    return new Promise((resolve) => {
      this.voiceOutput = new VoiceOutput({
        wsUrl: ttsWsUrl,
        provider: ttsProvider,
        onDone: () => { this.voiceOutput = null; resolve(); },
        onError: (msg) => { this._log('TTS error:', msg); this.voiceOutput = null; resolve(); },
      });
      this.voiceOutput.speak(text).catch(() => resolve());
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
    // Trigger UI state via chat.js globals
    if (typeof isStreaming !== 'undefined') {
      // chat.js will handle this via its own onmessage
    }
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
