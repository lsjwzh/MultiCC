/* Real-time voice conversation session.
 * Orchestrates the full "like a phone call" experience:
 *   1. User speaks → ASR recognizes text in real-time
 *   2. Silence detected → auto-send to AI
 *   3. AI responds → TTS streams audio
 *   4. User interrupts (speaks during TTS) → stop TTS, go back to step 1
 *
 * State machine: IDLE → LISTENING → THINKING → SPEAKING → LISTENING...
 *
 * Usage:
 *   const session = new VoiceSession({
 *     wsUrl: 'ws://...',
 *     asrProvider: 'auto',
 *     ttsProvider: 'edge',
 *     onText: (text, isFinal) => {},
 *     onStateChange: (state) => {},
 *     onAiText: (text) => {},
 *     onError: (msg) => {},
 *   });
 *   session.start(); // Begin listening
 *   session.stop();  // End session
 */

class VoiceSession {
  constructor(opts) {
    this.opts = opts || {};
    
    // State machine
    this.state = 'IDLE'; // IDLE, LISTENING, THINKING, SPEAKING
    
    // Components
    this.voiceInput = null;  // VoiceStream (ASR)
    this.voiceOutput = null; // VoiceOutput (TTS)
    this.vadMonitor = null;  // VadMonitor
    
    // Accumulated text
    this.accumulatedText = '';
    this.aiResponseText = '';
    
    // Stream for VAD
    this.mediaStream = null;
    
    // Chat WebSocket for AI
    this.chatWs = null;
    
    // Timers
    this.silenceTimer = null;
  }

  async start() {
    if (this.state !== 'IDLE') return;
    
    this._setState('LISTENING');
    this.accumulatedText = '';
    
    const { wsUrl, asrProvider = 'auto' } = this.opts;
    let asrWsUrl;
    
    try {
      asrWsUrl = await window.multiccWsUrl(`${wsUrl}/ws/voice`);
      // Get microphone stream
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });

      // Start VAD monitoring (for silence detection and barge-in)
      this.vadMonitor = new VadMonitor({
        stream: this.mediaStream,
        silenceThreshold: 0.015,
        silenceTimeout: 800, // 800ms silence = auto-send
        speechThreshold: 0.025,
        speechTimeout: 200,
        onSpeechStart: () => this._onSpeechStart(),
        onSilence: (duration) => this._onSilence(duration),
        onVolume: (level) => this._onVolume(level),
      });
      this.vadMonitor.start(this.mediaStream);

      // Start ASR streaming
      this.voiceInput = new VoiceStream({
        wsUrl: asrWsUrl,
        provider: asrProvider,
        lang: 'zh',
        onReady: (provider) => {
          console.log('[VoiceSession] ASR ready:', provider);
        },
        onText: (text, isFinal) => {
          this.accumulatedText = text;
          if (this.opts.onText) this.opts.onText(text, isFinal);
        },
        onDone: (text) => {
          console.log('[VoiceSession] ASR done:', text);
        },
        onError: (msg) => {
          if (this.opts.onError) this.opts.onError(msg);
        },
      });
      await this.voiceInput.start();

    } catch (err) {
      this._setState('IDLE');
      if (this.opts.onError) this.opts.onError('无法访问麦克风: ' + err.message);
    }
  }

  _onSpeechStart() {
    // User started speaking
    if (this.state === 'SPEAKING') {
      // Barge-in: user interrupts AI speech
      console.log('[VoiceSession] Barge-in detected, stopping TTS');
      this._stopTts();
      this._setState('LISTENING');
      
      // Restart ASR (it was stopped during SPEAKING)
      if (this.voiceInput && !this.voiceInput.started) {
        this.voiceInput.start().catch(() => {});
      }
    }
  }

  _onSilence(duration) {
    // Silence detected - user stopped speaking
    if (this.state === 'LISTENING' && this.accumulatedText.trim().length > 0) {
      console.log('[VoiceSession] Silence detected, auto-sending:', this.accumulatedText);
      this._sendToAi();
    }
  }

  _onVolume(level) {
    // Could be used for visual feedback
    if (this.opts.onVolume) this.opts.onVolume(level);
  }

  async _sendToAi() {
    if (this.state !== 'LISTENING') return;
    
    const text = this.accumulatedText.trim();
    if (!text) return;

    this._setState('THINKING');
    
    // Stop ASR input
    if (this.voiceInput) {
      this.voiceInput.stop();
    }

    // Send to AI via existing chat WebSocket or HTTP
    // For now, we'll use HTTP POST and wait for streaming response
    try {
      const { wsUrl } = this.opts;
      const chatUrl = `${wsUrl.replace('ws://', 'http://').replace('wss://', 'https://')}/api/chat`;
      
      // Use existing chat infrastructure
      // This should integrate with the existing chat WebSocket
      if (this.opts.onAiRequest) {
        // Callback mode: let parent handle AI request
        this.opts.onAiRequest(text);
      } else {
        // Direct mode: handle ourselves
        await this._handleAiResponse(text);
      }
    } catch (err) {
      if (this.opts.onError) this.opts.onError('AI 请求失败: ' + err.message);
      this._setState('LISTENING');
    }
  }

  async _handleAiResponse(text) {
    // This would connect to the chat WebSocket
    // For simplicity, we'll use a callback approach
    // The actual implementation should integrate with existing chat.js
    
    // Placeholder: simulate AI response
    console.log('[VoiceSession] Would send to AI:', text);
    
    // When AI responds, call _startTts(text)
  }

  startAiResponse(text) {
    // Called when AI starts responding (from external chat handler)
    this.aiResponseText = text;
    this._setState('SPEAKING');
    this._startTts(text);
  }

  async _startTts(text) {
    const { wsUrl, ttsProvider = 'edge' } = this.opts;
    let ttsWsUrl;
    try { ttsWsUrl = await window.multiccWsUrl(`${wsUrl}/ws/tts`); }
    catch (e) { if (this.opts.onError) this.opts.onError(e.message); return; }

    this.voiceOutput = new VoiceOutput({
      wsUrl: ttsWsUrl,
      provider: ttsProvider,
      onReady: () => {
        console.log('[VoiceSession] TTS ready');
      },
      onPlaying: () => {
        console.log('[VoiceSession] TTS playing');
      },
      onDone: () => {
        console.log('[VoiceSession] TTS done');
        // Continue listening after TTS finishes
        this._continueListening();
      },
      onError: (msg) => {
        if (this.opts.onError) this.opts.onError(msg);
        this._continueListening();
      },
    });

    try {
      await this.voiceOutput.speak(text);
    } catch (err) {
      if (this.opts.onError) this.opts.onError('TTS 失败: ' + err.message);
      this._continueListening();
    }
  }

  _stopTts() {
    if (this.voiceOutput) {
      this.voiceOutput.stop();
      this.voiceOutput = null;
    }
  }

  async _continueListening() {
    // After TTS finishes or is interrupted, go back to listening
    this._setState('LISTENING');
    this.accumulatedText = '';
    this.aiResponseText = '';

    // Restart ASR
    if (this.voiceInput) {
      this.voiceInput.abort();
      let asrWsUrl;
      try { asrWsUrl = await window.multiccWsUrl(`${this.opts.wsUrl}/ws/voice`); }
      catch (e) { if (this.opts.onError) this.opts.onError(e.message); return; }
      this.voiceInput = new VoiceStream({
        wsUrl: asrWsUrl,
        provider: this.opts.asrProvider || 'auto',
        lang: 'zh',
        onText: (text, isFinal) => {
          this.accumulatedText = text;
          if (this.opts.onText) this.opts.onText(text, isFinal);
        },
        onError: (msg) => {
          if (this.opts.onError) this.opts.onError(msg);
        },
      });
      this.voiceInput.start().catch(() => {});
    }
  }

  _setState(state) {
    this.state = state;
    if (this.opts.onStateChange) {
      this.opts.onStateChange(state);
    }
    console.log('[VoiceSession] State:', state);
  }

  stop() {
    this._setState('IDLE');
    
    // Stop all components
    if (this.voiceInput) {
      this.voiceInput.abort();
      this.voiceInput = null;
    }
    
    this._stopTts();
    
    if (this.vadMonitor) {
      this.vadMonitor.stop();
      this.vadMonitor = null;
    }
    
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(t => t.stop());
      this.mediaStream = null;
    }
    
    this.accumulatedText = '';
    this.aiResponseText = '';
  }

  getState() {
    return this.state;
  }
}

window.VoiceSession = VoiceSession;
