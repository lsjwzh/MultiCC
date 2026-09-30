/* Streaming TTS audio player.
 * Receives PCM16 audio chunks via WebSocket → plays through Web Audio API.
 * Supports interrupt (stop playback immediately) for user barge-in.
 *
 * Usage:
 *   const vo = new VoiceOutput({
 *     wsUrl, provider, voice,
 *     onReady, onPlaying, onDone, onError
 *   });
 *   await vo.speak("Hello");  // streams text to TTS, plays audio
 *   vo.stop();                // interrupt playback
 */

// 同 voice-session.js：借页面的 t，借不到就退回中文原文。
function voiceTr(key, fallback) {
  const translate = typeof window !== 'undefined' ? window.t : undefined;
  const text = typeof translate === 'function' ? translate(key) : key;
  return text === key ? fallback : text;
}

class VoiceOutput {
  constructor(opts) {
    this.opts = opts || {};
    this.ws = null;
    this.ac = null;
    this.source = null;
    this.audioQueue = [];
    this.isPlaying = false;
    this.isSpeaking = false;
    this.sampleRate = 24000;
    this.stopped = false;
  }

  async speak(text) {
    if (this.isSpeaking) {
      this.stop(); // Interrupt current speech
    }

    this.stopped = false;
    this.isSpeaking = true;
    this.audioQueue = [];

    const { wsUrl, provider = 'edge', voice } = this.opts;

    // Create AudioContext for playback
    if (!this.ac) {
      this.ac = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (this.ac.state === 'suspended') {
      await this.ac.resume();
    }

    // Connect to TTS WebSocket
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;

      let resolved = false;
      let readyReceived = false;
      let audioChunks = [];

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'start', text, provider, voice }));
      };

      ws.onmessage = async (ev) => {
        if (ev.data instanceof ArrayBuffer) {
          // Binary audio chunk
          if (!this.stopped) {
            audioChunks.push(ev.data);
            // Start playing once we have some chunks
            if (!this.isPlaying && audioChunks.length >= 3) {
              this.isPlaying = true;
              if (this.opts.onPlaying) this.opts.onPlaying();
              this._playChunks(audioChunks);
            }
          }
        } else {
          // JSON message
          let msg;
          try {
            msg = JSON.parse(ev.data);
          } catch {
            return;
          }

          if (msg.type === 'ready') {
            this.sampleRate = msg.sampleRate || 24000;
            readyReceived = true;
            if (this.opts.onReady) this.opts.onReady(msg.provider);
          } else if (msg.type === 'done') {
            // Play remaining chunks
            if (!this.stopped && audioChunks.length > 0 && !this.isPlaying) {
              this.isPlaying = true;
              if (this.opts.onPlaying) this.opts.onPlaying();
              this._playChunks(audioChunks);
            }
            this.isSpeaking = false;
            ws.close();
            if (!resolved) {
              resolved = true;
              resolve();
            }
            if (this.opts.onDone && !this.stopped) this.opts.onDone();
          } else if (msg.type === 'error') {
            this.isSpeaking = false;
            ws.close();
            if (!resolved) {
              resolved = true;
              reject(new Error(msg.message));
            }
            if (this.opts.onError) this.opts.onError(msg.message);
          }
        }
      };

      ws.onerror = () => {
        this.isSpeaking = false;
        if (!resolved) {
          resolved = true;
          reject(new Error('WebSocket error'));
        }
        if (this.opts.onError) this.opts.onError(voiceTr('voiceConnectFailed', '语音连接失败'));
      };

      ws.onclose = () => {
        this.isSpeaking = false;
        if (!resolved) {
          resolved = true;
          resolve();
        }
      };
    });
  }

  async _playChunks(chunks) {
    // Convert PCM16 chunks to AudioBuffers and schedule playback
    for (let i = 0; i < chunks.length && !this.stopped; i++) {
      const chunk = chunks[i];
      await this._playChunk(chunk, i);
    }
    
    // After all chunks played
    if (!this.stopped) {
      this.isPlaying = false;
    }
  }

  async _playChunk(chunk, index) {
    if (this.stopped) return;

    // Convert ArrayBuffer to Int16Array
    const int16 = new Int16Array(chunk);
    
    // Create AudioBuffer from Int16Array
    const buffer = this.ac.createBuffer(1, int16.length, this.sampleRate);
    const channelData = buffer.getChannelData(0);
    
    // Convert Int16 to Float32 [-1, 1]
    for (let i = 0; i < int16.length; i++) {
      channelData[i] = int16[i] / 32768;
    }

    // Create and connect AudioBufferSourceNode
    const source = this.ac.createBufferSource();
    source.buffer = buffer;
    source.connect(this.ac.destination);

    // Schedule playback with slight overlap to avoid gaps
    const startTime = this.ac.currentTime + (index * 0.02);
    source.start(startTime);

    // Wait for this chunk to finish (approximately)
    const duration = buffer.length / this.sampleRate;
    await new Promise((r) => setTimeout(r, duration * 1000 * 0.9));
  }

  stop() {
    this.stopped = true;
    this.isPlaying = false;
    this.isSpeaking = false;

    // Close WebSocket
    if (this.ws && this.ws.readyState <= 1) {
      this.ws.send(JSON.stringify({ type: 'stop' }));
      try {
        this.ws.close();
      } catch (_) {}
    }
    this.ws = null;

    // Stop any playing audio
    try {
      if (this.ac) {
        this.ac.close();
        this.ac = null;
      }
    } catch (_) {}
  }

  // Check if currently playing or speaking
  isActive() {
    return this.isPlaying || this.isSpeaking;
  }
}

window.VoiceOutput = VoiceOutput;
