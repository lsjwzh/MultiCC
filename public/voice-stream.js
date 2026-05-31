/* Streaming voice dictation client.
 * Captures mic → downsamples to PCM16 (AudioWorklet) → streams over /ws/voice →
 * receives incremental (partial) + finalized transcript so text appears live.
 *
 * Usage:
 *   const vs = new VoiceStream({
 *     wsUrl, provider, lang,
 *     onReady, onText(fullText, isFinal), onDone(finalText), onError(msg)
 *   });
 *   await vs.start();   // opens mic + ws, begins streaming
 *   vs.stop();          // user released mic → flush + finalize
 *   vs.abort();         // cancel without finalizing
 */
class VoiceStream {
  constructor(opts) {
    this.opts = opts || {};
    this.ws = null;
    this.ac = null;
    this.node = null;
    this.source = null;
    this.stream = null;
    this.started = false;
    this.closed = false;
  }

  async start() {
    const { wsUrl, provider = 'auto', lang = 'zh' } = this.opts;
    // Kick off mic capture and the WS connection in parallel.
    const micP = navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });

    await new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      let settled = false;

      ws.onopen = () => ws.send(JSON.stringify({ type: 'start', provider, lang }));
      ws.onmessage = async (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.type === 'ready') {
          // Server resolved the provider + its required sample rate. Now wire mic.
          try {
            const stream = await micP;
            await this._beginCapture(stream, m.sampleRate || 16000);
            if (!settled) { settled = true; resolve(); }
            if (this.opts.onReady) this.opts.onReady(m.provider);
          } catch (e) {
            if (!settled) { settled = true; reject(e); }
          }
        } else if (m.type === 'partial') {
          if (this.opts.onText) this.opts.onText(m.text || '', false);
        } else if (m.type === 'final') {
          if (this.opts.onText) this.opts.onText(m.text || '', true);
        } else if (m.type === 'done') {
          if (this.opts.onDone) this.opts.onDone(m.text || '');
          this._teardown();
        } else if (m.type === 'error') {
          if (this.opts.onError) this.opts.onError(m.message || 'ASR 错误');
          if (!settled) { settled = true; reject(new Error(m.message || 'ASR 错误')); }
        }
      };
      ws.onerror = () => {
        if (this.opts.onError) this.opts.onError('语音连接失败');
        if (!settled) { settled = true; reject(new Error('ws error')); }
      };
      ws.onclose = () => { this._teardown(); };
    });
    this.started = true;
  }

  async _beginCapture(stream, targetRate) {
    this.stream = stream;
    this.ac = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ac.state === 'suspended') { try { await this.ac.resume(); } catch (_) {} }
    await this.ac.audioWorklet.addModule(withToken('/voice-worklet.js'));
    this.source = this.ac.createMediaStreamSource(stream);
    this.node = new AudioWorkletNode(this.ac, 'pcm16-downsampler', {
      processorOptions: { targetRate },
    });
    this.node.port.onmessage = (e) => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(e.data.buffer || e.data);
    };
    this.source.connect(this.node);
    // Worklet has no audible output; connect to a muted gain so the graph runs.
    const sink = this.ac.createGain(); sink.gain.value = 0;
    this.node.connect(sink).connect(this.ac.destination);
  }

  stop() {
    if (this.closed) return;
    // Stop the mic immediately; tell the server to flush + finalize.
    this._stopAudio();
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'stop' }));
    }
  }

  abort() { this._teardown(); }

  _stopAudio() {
    try { if (this.source) this.source.disconnect(); } catch (_) {}
    try { if (this.node) this.node.disconnect(); } catch (_) {}
    try { if (this.stream) this.stream.getTracks().forEach(t => t.stop()); } catch (_) {}
    try { if (this.ac && this.ac.state !== 'closed') this.ac.close(); } catch (_) {}
    this.source = this.node = this.stream = this.ac = null;
  }

  _teardown() {
    if (this.closed) return;
    this.closed = true;
    this._stopAudio();
    try { if (this.ws && this.ws.readyState <= 1) this.ws.close(); } catch (_) {}
    this.ws = null;
  }
}

window.VoiceStream = VoiceStream;
