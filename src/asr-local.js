// Local ASR — in-process SenseVoiceSmall (FunASR/FunAudioLLM family) via
// sherpa-onnx. Replaces the cloud Whisper round-trip (2-5s from CN networks)
// with on-device inference (~RTF 0.02 on Apple Silicon, i.e. ~100-300ms for a
// typical utterance).
//
// Model files live OUTSIDE the repo (they are ~240MB) in ~/.multicc/asr-models
// by default, shared across worktrees. Run scripts/setup-local-asr.sh to
// download them. When the model dir or the sherpa-onnx-node addon is missing,
// isAvailable() returns false and callers fall back to the cloud path — this
// module must never take the voice feature down with it.
//
// Config mirrors src/voice.js: a mutable `cfg` keyed by env var name so the
// settings route can hot-apply updates via applyEnvUpdates(). Never destructure
// `cfg` (stale-binding trap, see src/voice.js header).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SENSE_VOICE_DIR_NAME = 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17';

const cfg = {
  // 'auto' = use local ASR when model files exist; 'on' = required (no cloud
  // fallback preference change, but warmup eagerly); 'off' = never use local.
  ASR_LOCAL: process.env.ASR_LOCAL || 'auto',
  ASR_LOCAL_MODEL_DIR: process.env.ASR_LOCAL_MODEL_DIR || path.join(os.homedir(), '.multicc', 'asr-models'),
  ASR_LOCAL_THREADS: process.env.ASR_LOCAL_THREADS || '2',
  // SenseVoice language: auto|zh|en|ja|ko|yue. 'auto' handles中英夹杂 best.
  ASR_LOCAL_LANGUAGE: process.env.ASR_LOCAL_LANGUAGE || 'auto',
};

function applyEnvUpdates(updates) {
  for (const k of Object.keys(cfg)) {
    if (updates[k] !== undefined) cfg[k] = updates[k];
  }
}

function modelDir() { return path.join(cfg.ASR_LOCAL_MODEL_DIR, SENSE_VOICE_DIR_NAME); }
function vadModelPath() { return path.join(cfg.ASR_LOCAL_MODEL_DIR, 'silero_vad.onnx'); }

function modelFilesExist() {
  try {
    return fs.existsSync(path.join(modelDir(), 'model.int8.onnx')) &&
           fs.existsSync(path.join(modelDir(), 'tokens.txt'));
  } catch (_) { return false; }
}

// sherpa-onnx-node is an optional dependency in practice: resolve lazily so a
// missing/broken native addon degrades to cloud ASR instead of crashing boot.
let _sherpa;
let _sherpaError = null;
function sherpa() {
  if (_sherpa !== undefined) return _sherpa;
  try {
    _sherpa = require('sherpa-onnx-node');
  } catch (e) {
    _sherpa = null;
    _sherpaError = e.message;
    console.error('[multicc/asr-local] sherpa-onnx-node not loadable, local ASR disabled:', e.message);
  }
  return _sherpa;
}

function isAvailable() {
  if (cfg.ASR_LOCAL === 'off' || cfg.ASR_LOCAL === '0' || cfg.ASR_LOCAL === 'false') return false;
  return modelFilesExist() && !!sherpa();
}

// ── Recognizer singleton ──
// One OfflineRecognizer shared by all requests/sessions (onnxruntime arena
// makes per-request instances prohibitively expensive: ~450MB each).
let _recognizer = null;
let _loadMs = 0;

function getRecognizer() {
  if (_recognizer) return _recognizer;
  const s = sherpa();
  if (!s) throw new Error(`sherpa-onnx-node 不可用: ${_sherpaError || 'unknown'}`);
  if (!modelFilesExist()) throw new Error(`本地 ASR 模型缺失: ${modelDir()}（运行 scripts/setup-local-asr.sh 下载）`);
  const t0 = Date.now();
  _recognizer = new s.OfflineRecognizer({
    modelConfig: {
      senseVoice: {
        model: path.join(modelDir(), 'model.int8.onnx'),
        language: cfg.ASR_LOCAL_LANGUAGE,
        useInverseTextNormalization: 1,   // 标点 + 数字归一化
      },
      tokens: path.join(modelDir(), 'tokens.txt'),
      numThreads: parseInt(cfg.ASR_LOCAL_THREADS, 10) || 2,
      provider: 'cpu',
      debug: 0,
    },
  });
  _loadMs = Date.now() - t0;
  console.log(`[multicc/asr-local] SenseVoice loaded in ${_loadMs}ms (threads=${cfg.ASR_LOCAL_THREADS})`);
  return _recognizer;
}

let _warmupDone = false;
async function warmup() {
  if (_warmupDone || !isAvailable()) return;
  try {
    const rec = getRecognizer();
    // Decode 0.5s of silence so onnxruntime finishes graph optimization now,
    // not on the first user utterance.
    const stream = rec.createStream();
    stream.acceptWaveform({ sampleRate: 16000, samples: new Float32Array(8000) });
    rec.decode(stream);
    rec.getResult(stream);
    _warmupDone = true;
    console.log('[multicc/asr-local] warmup complete');
  } catch (e) {
    console.error('[multicc/asr-local] warmup failed:', e.message);
  }
}

function status() {
  return {
    ready: isAvailable(),
    loaded: !!_recognizer,
    loadMs: _loadMs,
    model: 'sense-voice-small-int8',
    modelDir: modelDir(),
    sampleRate: 16000,
  };
}

// ── Vocabulary post-correction ──
// SenseVoice has no decode-time hotword boost, so the user-corrected terms in
// whisper_vocab.json (multicc, ccfw, worktree, …) are applied afterwards: an
// ASCII term matches itself case-insensitively with optional internal spaces
// ("multi cc" → "multicc"). Chinese homophone correction is out of scope here.
let _vocabCache = { at: 0, regexes: [] };
function vocabRegexes() {
  const now = Date.now();
  if (now - _vocabCache.at < 30000) return _vocabCache.regexes;
  const regexes = [];
  try {
    const { loadWhisperVocab } = require('./voice');
    const terms = loadWhisperVocab().slice(0, 40).map(v => v.term)
      .filter(t => /^[A-Za-z][A-Za-z0-9_./-]{2,}$/.test(t));
    for (const term of terms) {
      const pattern = term.split('').map(c => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[ ]?');
      regexes.push({ re: new RegExp(`(?<![A-Za-z0-9])${pattern}(?![A-Za-z0-9])`, 'gi'), term });
    }
  } catch (_) {}
  _vocabCache = { at: now, regexes };
  return regexes;
}

function applyVocabCorrections(text) {
  if (!text) return text;
  let out = text;
  for (const { re, term } of vocabRegexes()) out = out.replace(re, term);
  return out;
}

// ── Core transcription ──
function transcribeFloat32(samples, sampleRate) {
  const rec = getRecognizer();
  const t0 = Date.now();
  const stream = rec.createStream();
  stream.acceptWaveform({ sampleRate, samples });
  rec.decode(stream);
  const r = rec.getResult(stream);
  return { text: applyVocabCorrections((r.text || '').trim()), decodeMs: Date.now() - t0 };
}

function int16ToFloat32(buf) {
  // buf: Buffer or Int16Array of PCM16LE
  const int16 = Buffer.isBuffer(buf)
    ? new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2))
    : buf;
  const out = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) out[i] = int16[i] / 32768;
  return out;
}

// Minimal RIFF/WAVE parser for the PCM16 fast path (Flutter uploads 16kHz
// mono PCM16 WAV). Returns null when the container is anything fancier —
// caller then goes through ffmpeg.
function parseWavPcm16(buf) {
  try {
    if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
    let off = 12, fmt = null, data = null;
    while (off + 8 <= buf.length) {
      const id = buf.toString('ascii', off, off + 4);
      const size = buf.readUInt32LE(off + 4);
      const body = off + 8;
      if (id === 'fmt ') {
        fmt = {
          audioFormat: buf.readUInt16LE(body),
          channels: buf.readUInt16LE(body + 2),
          sampleRate: buf.readUInt32LE(body + 4),
          bitsPerSample: buf.readUInt16LE(body + 14),
        };
      } else if (id === 'data') {
        data = buf.subarray(body, Math.min(body + size, buf.length));
      }
      off = body + size + (size % 2);
    }
    if (!fmt || !data || fmt.audioFormat !== 1 || fmt.bitsPerSample !== 16 || fmt.channels < 1 || fmt.channels > 2) return null;
    const int16 = new Int16Array(data.buffer, data.byteOffset, Math.floor(data.byteLength / 2));
    let samples;
    if (fmt.channels === 1) {
      samples = int16ToFloat32(int16);
    } else {
      samples = new Float32Array(Math.floor(int16.length / 2));
      for (let i = 0; i < samples.length; i++) samples[i] = (int16[2 * i] + int16[2 * i + 1]) / 2 / 32768;
    }
    return { samples, sampleRate: fmt.sampleRate };
  } catch (_) { return null; }
}

// Decode arbitrary audio (webm/opus from Chrome, mp4/aac from Safari, ogg…)
// to 16kHz mono float32 via ffmpeg. Rejects when ffmpeg is missing so the
// endpoint can fall back to cloud ASR.
function ffmpegDecode(buf) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-f', 'f32le', '-ac', '1', '-ar', '16000', 'pipe:1']);
    const chunks = [];
    let stderr = '';
    const timer = setTimeout(() => { try { ff.kill('SIGKILL'); } catch (_) {} reject(new Error('ffmpeg 解码超时')); }, 15000);
    ff.stdout.on('data', c => chunks.push(c));
    ff.stderr.on('data', c => { stderr += c; });
    ff.on('error', (e) => { clearTimeout(timer); reject(new Error(`ffmpeg 不可用: ${e.message}`)); });
    ff.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`ffmpeg 解码失败 (${code}): ${stderr.slice(0, 200)}`));
      const all = Buffer.concat(chunks);
      resolve(new Float32Array(all.buffer, all.byteOffset, Math.floor(all.byteLength / 4)));
    });
    ff.stdin.on('error', () => {});  // EPIPE when ffmpeg dies early
    ff.stdin.end(buf);
  });
}

/**
 * Transcribe an uploaded audio file buffer of any common container.
 * Returns { text, ms, decodeMs, inferMs, audioSec }.
 */
async function transcribeBuffer(buf, mimetype) {
  const t0 = Date.now();
  let samples, sampleRate;
  const wav = parseWavPcm16(buf);
  if (wav) {
    samples = wav.samples; sampleRate = wav.sampleRate;
  } else {
    samples = await ffmpegDecode(buf);
    sampleRate = 16000;
  }
  const decodeMs = Date.now() - t0;
  if (!samples.length) throw new Error('音频解码后为空');
  const { text, decodeMs: inferMs } = transcribeFloat32(samples, sampleRate);
  return { text, ms: Date.now() - t0, decodeMs, inferMs, audioSec: samples.length / sampleRate };
}

// ── Streaming session (for /ws/voice) ──
// SenseVoice is non-streaming, so the session runs silero-VAD over incoming
// PCM16 frames and decodes each speech segment as it closes (250ms tail).
// Callbacks mirror the provider interface in plugins/voice/voice-asr.js.
const MAX_SESSION_SAMPLES = 16000 * 120;   // cap fallback buffer at 2 min

function createStreamingSession(opts, cb) {
  const s = sherpa();
  if (!s || !isAvailable()) { cb.onError('本地 ASR 未就绪（模型缺失或 addon 不可用）'); return null; }
  let rec;
  try { rec = getRecognizer(); } catch (e) { cb.onError(e.message); return null; }

  let vad = null;
  try {
    vad = new s.Vad({
      sileroVad: {
        model: vadModelPath(),
        threshold: 0.5,
        minSilenceDuration: 0.25,
        minSpeechDuration: 0.15,
        maxSpeechDuration: 15,
        windowSize: 512,
      },
      sampleRate: 16000,
      numThreads: 1,
      provider: 'cpu',
      debug: false,
    }, 60 /* bufferSizeSeconds */);
  } catch (e) {
    cb.onError(`VAD 初始化失败: ${e.message}`);
    return null;
  }

  let closed = false;
  let emittedAny = false;
  let pending = new Float32Array(0);        // < windowSize remainder
  let sessionChunks = [];                    // full-session copy (padding + fallback)
  let sessionLen = 0;

  // Copy [begin, end) out of the session chunk list. Used to re-extract VAD
  // segments with pre/post padding: silero clips the first phoneme at speech
  // onset ("开放时间" → "派饭时间"), so decoding the raw segment loses accuracy.
  const sliceSession = (begin, end) => {
    begin = Math.max(0, begin); end = Math.min(end, sessionLen);
    if (end <= begin) return null;
    const out = new Float32Array(end - begin);
    let base = 0, w = 0;
    for (const c of sessionChunks) {
      if (base >= end) break;
      if (base + c.length > begin) {
        const from = Math.max(begin - base, 0);
        const to = Math.min(end - base, c.length);
        out.set(c.subarray(from, to), w); w += to - from;
      }
      base += c.length;
    }
    return out;
  };

  // 0.24s each side: covers onset clipping while staying inside the ≥0.25s
  // silence gap VAD guarantees between segments (no cross-segment bleed).
  const PAD = Math.floor(16000 * 0.24);

  const feedWindows = (f32) => {
    // silero requires exact windowSize chunks
    let merged;
    if (pending.length) {
      merged = new Float32Array(pending.length + f32.length);
      merged.set(pending); merged.set(f32, pending.length);
    } else merged = f32;
    const win = 512;
    let off = 0;
    while (off + win <= merged.length) {
      vad.acceptWaveform(merged.subarray(off, off + win));
      off += win;
    }
    pending = merged.subarray(off);
  };

  const drainSegments = () => {
    while (!vad.isEmpty()) {
      const seg = vad.front();
      vad.pop();
      if (!seg || !seg.samples || !seg.samples.length) continue;
      let samples = seg.samples;
      if (typeof seg.start === 'number' && seg.start + samples.length <= sessionLen) {
        const padded = sliceSession(seg.start - PAD, seg.start + samples.length + PAD);
        if (padded) samples = padded;
      }
      try {
        const { text } = transcribeFloat32(samples, 16000);
        if (text) { emittedAny = true; cb.onFinal(text); }
      } catch (e) { cb.onError(`本地转写失败: ${e.message}`); }
    }
  };

  queueMicrotask(() => { if (!closed) cb.onReady(); });

  return {
    pushAudio(int16) {
      if (closed) return;
      const f32 = int16ToFloat32(int16);
      if (sessionLen < MAX_SESSION_SAMPLES) { sessionChunks.push(f32); sessionLen += f32.length; }
      try { feedWindows(f32); drainSegments(); } catch (e) { cb.onError(e.message); }
    },
    finish() {
      if (closed) return;
      closed = true;
      try {
        if (typeof vad.flush === 'function') vad.flush();
        drainSegments();
        if (!emittedAny && sessionLen > 16000 * 0.3) {
          // VAD never closed a segment (very short utterance / low energy) —
          // decode the whole session buffer as a last resort.
          const all = sliceSession(0, sessionLen);
          const { text } = transcribeFloat32(all, 16000);
          if (text) cb.onFinal(text);
        }
      } catch (e) { cb.onError(e.message); }
      sessionChunks = []; sessionLen = 0;
      cb.onDone();
    },
    close() {
      closed = true;
      sessionChunks = []; sessionLen = 0;
    },
  };
}

// Self-warming: preload the model shortly after boot so the first utterance
// doesn't eat the ~600ms cold start. Skipped when disabled or files missing.
if (isAvailable()) {
  const t = setTimeout(() => { warmup(); }, 2000);
  if (t.unref) t.unref();
}

module.exports = {
  cfg,
  applyEnvUpdates,
  isAvailable,
  status,
  warmup,
  transcribeBuffer,
  transcribeFloat32,
  createStreamingSession,
  applyVocabCorrections,
};
