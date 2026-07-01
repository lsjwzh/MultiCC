/* Voice Activity Detection (VAD) monitor.
 * Uses AudioWorklet to analyze audio levels and detect:
 *   - User speaking (voice activity)
 *   - Silence (user stopped speaking)
 * 
 * Triggers:
 *   - onSpeechStart(): when user starts speaking
 *   - onSilence(duration): when silence detected, reports duration in ms
 *   - onVolume(level): continuous volume level (0-1)
 *
 * Usage:
 *   const vad = new VadMonitor({
 *     stream: mediaStream,
 *     silenceThreshold: 0.02,   // volume below this = silence
 *     silenceTimeout: 1000,     // ms of silence to trigger onSilence
 *     onSpeechStart, onSilence, onVolume
 *   });
 *   vad.start();
 *   vad.stop();
 */

class VadMonitor {
  constructor(opts) {
    this.opts = opts || {};
    this.ac = null;
    this.source = null;
    this.analyser = null;
    this.worklet = null;
    this.running = false;

    // Detection state
    this.isSpeaking = false;
    this.silenceStart = null;
    this.lastVolume = 0;
    this.noiseFloor = 0;        // adaptive ambient-noise baseline (RMS)
    this._calibrated = false;
    this._calibrationSamples = 0;

    // Configurable thresholds. These are RMS amplitudes (0-1) on the
    // time-domain waveform, NOT averaged frequency-bin magnitudes. RMS tracks
    // perceived loudness far better, so speech reliably clears these without a
    // hot mic. Defaults are sensitive on purpose; the adaptive noise floor adds
    // a margin on top so a noisy room still works.
    this.silenceThreshold = opts.silenceThreshold || 0.010; // below this (+floor) = silence
    this.speechThreshold = opts.speechThreshold || 0.018;   // above this (+floor) = speech
    this.silenceTimeout = opts.silenceTimeout || 1000;      // Ms of silence to trigger
    this.speechTimeout = opts.speechTimeout || 300;         // Ms of speech to trigger speech start
    this.speechStart = null;
  }

  async start(stream) {
    if (this.running) return;

    this.running = true;
    this.isSpeaking = false;
    this.silenceStart = null;
    this.speechStart = null;
    this.noiseFloor = 0;
    this._calibrated = false;
    this._calibrationSamples = 0;
    this._calibSum = 0;

    // Create AudioContext
    this.ac = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ac.state === 'suspended') {
      await this.ac.resume();
    }

    // Create AnalyserNode for waveform (time-domain) measurement.
    this.analyser = this.ac.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0;

    // Connect stream to analyser
    this.source = this.ac.createMediaStreamSource(stream);
    this.source.connect(this.analyser);

    // Reusable time-domain buffer
    this._timeBuf = new Float32Array(this.analyser.fftSize);

    // Start monitoring loop
    this._monitorLoop();
  }

  // Root-mean-square amplitude of the current waveform window (0-1).
  _readRms() {
    const buf = this._timeBuf;
    this.analyser.getFloatTimeDomainData(buf);
    let sumSq = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = buf[i];
      sumSq += v * v;
    }
    return Math.sqrt(sumSq / buf.length);
  }

  _monitorLoop() {
    if (!this.running || !this.analyser) return;

    const rms = this._readRms();
    this.lastVolume = rms;

    // Calibrate ambient noise floor over the first ~0.5s (assumed non-speech)
    // so thresholds adapt to the room. We AVERAGE early samples rather than
    // take the max, so a single breath/click can't push the floor sky-high and
    // then make speech impossible to detect.
    if (!this._calibrated) {
      this._calibSum = (this._calibSum || 0) + rms;
      if (++this._calibrationSamples >= 30) { // ~0.5s at 60fps
        this.noiseFloor = this._calibSum / this._calibrationSamples;
        this._calibrated = true;
      }
    }

    // Effective thresholds = configured value + a capped fraction of the floor.
    // Cap keeps a noisy calibration from raising the bar beyond reach.
    const floorBoost = Math.min(this.noiseFloor * 0.5, 0.015);
    const speechLvl = this.speechThreshold + floorBoost;
    const silenceLvl = this.silenceThreshold + floorBoost;

    // Report volume (normalized so the UI bar is responsive: RMS speech is
    // typically 0.02-0.15, so scale into a visible range).
    if (this.opts.onVolume) {
      this.opts.onVolume(rms);
    }
    // Live diagnostics (rms / floor / thresholds / speaking) for the debug line.
    if (this.opts.onDebug) {
      this.opts.onDebug({
        rms, noiseFloor: this.noiseFloor,
        speechLvl, silenceLvl,
        isSpeaking: this.isSpeaking,
        calibrated: this._calibrated,
      });
    }

    const now = Date.now();

    // Speech detection logic
    if (rms > speechLvl) {
      // User is speaking
      if (!this.isSpeaking) {
        // Potential speech start
        if (!this.speechStart) {
          this.speechStart = now;
        } else if (now - this.speechStart >= this.speechTimeout) {
          // Confirmed speech start
          this.isSpeaking = true;
          this.speechStart = null;
          this.silenceStart = null;
          if (this.opts.onSpeechStart) {
            this.opts.onSpeechStart();
          }
        }
      } else {
        // Continue speaking, reset silence timer
        this.silenceStart = null;
      }
    } else if (rms < silenceLvl) {
      // Below silence level — reset any tentative speech-start, and if we were
      // speaking, start counting silence toward end-of-utterance.
      this.speechStart = null;
      if (this.isSpeaking) {
        if (!this.silenceStart) {
          this.silenceStart = now;
        } else if (now - this.silenceStart >= this.silenceTimeout) {
          // Silence timeout reached - user stopped speaking
          const duration = now - this.silenceStart;
          this.isSpeaking = false;
          this.silenceStart = null;
          this.speechStart = null;
          if (this.opts.onSilence) {
            this.opts.onSilence(duration);
          }
        }
      }
    }

    // Continue monitoring
    if (this.running) {
      requestAnimationFrame(() => this._monitorLoop());
    }
  }

  stop() {
    this.running = false;
    this.isSpeaking = false;
    
    try {
      if (this.source) {
        this.source.disconnect();
        this.source = null;
      }
    } catch (_) {}

    try {
      if (this.ac && this.ac.state !== 'closed') {
        this.ac.close();
        this.ac = null;
      }
    } catch (_) {}

    this.analyser = null;
  }

  getVolume() {
    return this.lastVolume;
  }

  isVoiceActive() {
    return this.isSpeaking;
  }
}

window.VadMonitor = VadMonitor;
