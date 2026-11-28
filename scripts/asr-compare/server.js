#!/usr/bin/env node
'use strict';
// Local ASR comparison bench.
//
// Runs SenseVoiceSmall and the streaming Zipformer transducers side by side on
// whatever you say into the page, so the choice of default can be made from
// your own voice instead of a TTS benchmark. Nothing here touches the running
// MultiCC server: it is a standalone process, own port, own recognizers.
//
// Requires sherpa-onnx-node >= 1.13.8 — 1.13.4 returns an empty transcript for
// every streaming transducer. Point SHERPA_ONNX_NODE at a node_modules copy
// (or install 1.13.8 in the repo) when the local one is older.
//
//   node scripts/asr-compare/server.js            # http://127.0.0.1:8899
//   PORT=9000 SHERPA_ONNX_NODE=/path/to/sherpa-onnx-node node ...

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawn } = require('child_process');

const PORT = Number(process.env.PORT || process.env.ASR_COMPARE_PORT || 8899);
const HOST = process.env.ASR_COMPARE_HOST || '127.0.0.1';
const MODEL_ROOT = process.env.ASR_LOCAL_MODEL_DIR || path.join(os.homedir(), '.multicc', 'asr-models');

// ── 在线 ASR：服务清单 × 协议适配器 ──
// Every online service here is described once as data (base URL, model, key,
// which protocol it speaks) and the transports live below. Credentials come
// from .env first, then the page may override them for one recording.
// ASR_COMPARE_ENV points the bench at a different .env outside a full checkout.
//
// Naming: ASR_<ID>_API_KEY / _BASE_URL / _MODEL / _LANGUAGE. groq also honours
// the app's existing WHISPER_* keys so the bench works with zero new config.
const ENV_FILE = process.env.ASR_COMPARE_ENV || path.join(__dirname, '..', '..', '.env');
function loadEnvFile(file) {
  const out = {};
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      let v = m[2].trim();
      if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
      out[m[1]] = v;
    }
  } catch (_) {}
  return out;
}
const ENV_VARS = loadEnvFile(ENV_FILE);
const CFG = key => process.env[key] !== undefined && process.env[key] !== ''
  ? process.env[key] : (ENV_VARS[key] || '');
const envFirst = (...names) => {
  for (const n of names) { const v = CFG(n); if (v) return v; }
  return '';
};

const PROVIDERS = {
  groq: {
    label: 'Groq Whisper Turbo',
    protocol: 'openai-transcriptions',
    hotwordMode: 'prompt',
    baseUrl: envFirst('ASR_GROQ_BASE_URL', 'WHISPER_BASE_URL') || 'https://api.groq.com/openai/v1',
    key: envFirst('ASR_GROQ_API_KEY', 'WHISPER_API_KEY', 'OPENROUTER_API_KEY'),
    model: envFirst('ASR_GROQ_MODEL', 'WHISPER_MODEL') || 'whisper-large-v3-turbo',
    language: envFirst('ASR_GROQ_LANGUAGE', 'WHISPER_LANGUAGE') || 'zh',
  },
  openai: {
    label: 'OpenAI gpt-4o-transcribe',
    protocol: 'openai-transcriptions',
    hotwordMode: 'prompt',
    baseUrl: envFirst('ASR_OPENAI_BASE_URL') || 'https://api.openai.com/v1',
    key: envFirst('ASR_OPENAI_API_KEY'),
    model: envFirst('ASR_OPENAI_MODEL') || 'gpt-4o-transcribe',
    language: envFirst('ASR_OPENAI_LANGUAGE') || 'zh',
  },
  siliconflow: {
    label: '硅基流动 SenseVoiceSmall（与本地同模型）',
    protocol: 'openai-transcriptions',
    hotwordMode: 'none',
    baseUrl: envFirst('ASR_SILICONFLOW_BASE_URL') || 'https://api.siliconflow.cn/v1',
    key: envFirst('ASR_SILICONFLOW_API_KEY', 'SILICONFLOW_API_KEY'),
    model: envFirst('ASR_SILICONFLOW_MODEL') || 'FunAudioLLM/SenseVoiceSmall',
    language: envFirst('ASR_SILICONFLOW_LANGUAGE') || '',
  },
  zhipu: {
    label: '智谱 GLM-ASR（原生热词表）',
    protocol: 'openai-transcriptions',
    hotwordMode: 'native',
    baseUrl: envFirst('ASR_ZHIPU_BASE_URL') || 'https://open.bigmodel.cn/api/paas/v4',
    key: envFirst('ASR_ZHIPU_API_KEY', 'ZHIPU_API_KEY'),
    model: envFirst('ASR_ZHIPU_MODEL') || 'glm-asr-2512',
    language: envFirst('ASR_ZHIPU_LANGUAGE') || 'zh',
    maxSeconds: 30,
    note: '单段上限 30 秒 / 25MB',
  },
  mistral: {
    label: 'Mistral Voxtral',
    protocol: 'openai-transcriptions',
    hotwordMode: 'prompt',
    baseUrl: envFirst('ASR_MISTRAL_BASE_URL') || 'https://api.mistral.ai/v1',
    key: envFirst('ASR_MISTRAL_API_KEY', 'MISTRAL_API_KEY'),
    model: envFirst('ASR_MISTRAL_MODEL') || 'voxtral-mini-latest',
    language: envFirst('ASR_MISTRAL_LANGUAGE') || 'zh',
  },
  deepgram: {
    label: 'Deepgram Nova-3（keywords 加权）',
    protocol: 'deepgram',
    hotwordMode: 'keywords',
    baseUrl: envFirst('ASR_DEEPGRAM_BASE_URL') || 'https://api.deepgram.com',
    key: envFirst('ASR_DEEPGRAM_API_KEY', 'DEEPGRAM_API_KEY'),
    model: envFirst('ASR_DEEPGRAM_MODEL') || 'nova-3',
    language: envFirst('ASR_DEEPGRAM_LANGUAGE') || 'zh',
  },
  elevenlabs: {
    label: 'ElevenLabs Scribe',
    protocol: 'elevenlabs',
    hotwordMode: 'none',
    baseUrl: envFirst('ASR_ELEVENLABS_BASE_URL') || 'https://api.elevenlabs.io',
    key: envFirst('ASR_ELEVENLABS_API_KEY', 'ELEVENLABS_API_KEY'),
    model: envFirst('ASR_ELEVENLABS_MODEL') || 'scribe_v1',
    language: envFirst('ASR_ELEVENLABS_LANGUAGE') || 'zh',
  },
  assemblyai: {
    label: 'AssemblyAI Universal（word_boost）',
    protocol: 'assemblyai',
    hotwordMode: 'keywords',
    baseUrl: envFirst('ASR_ASSEMBLYAI_BASE_URL') || 'https://api.assemblyai.com',
    key: envFirst('ASR_ASSEMBLYAI_API_KEY', 'ASSEMBLYAI_API_KEY'),
    language: envFirst('ASR_ASSEMBLYAI_LANGUAGE') || 'zh',
  },
  qwen: {
    label: '阿里 Qwen3-ASR-Flash（chat/completions）',
    protocol: 'openai-chat-audio',
    hotwordMode: 'context',
    baseUrl: envFirst('ASR_QWEN_BASE_URL') || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    key: envFirst('ASR_QWEN_API_KEY', 'DASHSCOPE_API_KEY'),
    model: envFirst('ASR_QWEN_MODEL') || 'qwen3-asr-flash',
    language: envFirst('ASR_QWEN_LANGUAGE') || 'zh',
  },
  volc: {
    label: '火山豆包流式 2.0（WebSocket）',
    protocol: 'volc-sauc',
    hotwordMode: 'native',
    baseUrl: envFirst('ASR_VOLC_BASE_URL') || 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async',
    key: envFirst('ASR_VOLC_API_KEY', 'VOLC_API_KEY'),
    appId: envFirst('ASR_VOLC_APP_ID', 'VOLC_APP_ID'),
    resourceId: envFirst('ASR_VOLC_RESOURCE_ID') || 'volc.bigasr.sauc.duration',
    model: '',
    language: envFirst('ASR_VOLC_LANGUAGE') || 'zh',
  },
  custom: {
    label: '自定义 OpenAI 兼容接口',
    protocol: 'openai-transcriptions',
    hotwordMode: 'prompt',
    baseUrl: envFirst('ASR_CUSTOM_BASE_URL'),
    key: envFirst('ASR_CUSTOM_API_KEY'),
    model: envFirst('ASR_CUSTOM_MODEL'),
    language: envFirst('ASR_CUSTOM_LANGUAGE') || 'zh',
  },
};

const DIRS = {
  sense: 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17',
  bi: 'sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20',
  zh25: 'sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30',
  mul: 'sherpa-onnx-streaming-zipformer-ar_en_id_ja_ru_th_vi_zh-2025-02-10',
};
const dirOf = k => path.join(MODEL_ROOT, DIRS[k]);

let sherpa = null;
let sherpaVersion = '';
let sherpaError = null;
function loadSherpa() {
  if (sherpa !== null) return sherpa;
  const candidates = [
    process.env.SHERPA_ONNX_NODE,
    'sherpa-onnx-node',
    path.join(__dirname, '..', '..', 'node_modules', 'sherpa-onnx-node'),
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      sherpa = require(c);
      try { sherpaVersion = require(path.join(c, 'package.json')).version; } catch (_) { sherpaVersion = '?'; }
      console.log(`[asr-compare] sherpa-onnx-node ${sherpaVersion} from ${c}`);
      return sherpa;
    } catch (e) { sherpaError = e.message; }
  }
  throw new Error(`sherpa-onnx-node 不可用: ${sherpaError}`);
}
function hasModel(k) {
  const d = dirOf(k);
  try {
    if (k === 'sense') return fs.existsSync(path.join(d, 'model.int8.onnx')) && fs.existsSync(path.join(d, 'tokens.txt'));
    if (k === 'bi') return fs.existsSync(path.join(d, 'encoder-epoch-99-avg-1.int8.onnx'));
    if (k === 'zh25') return fs.existsSync(path.join(d, 'encoder.int8.onnx'));
    if (k === 'mul') return fs.existsSync(path.join(d, 'encoder-epoch-75-avg-11-chunk-16-left-128.int8.onnx'));
  } catch (_) {}
  return false;
}

// ── recognizers (lazy, one per engine) ──
const recognizers = new Map();
function engineConfig(k, opts = {}) {
  const d = dirOf(k);
  if (k === 'sense') {
    return {
      kind: 'offline',
      cfg: {
        modelConfig: {
          senseVoice: {
            model: path.join(d, 'model.int8.onnx'),
            language: process.env.ASR_LOCAL_LANGUAGE || 'auto',
            useInverseTextNormalization: 1,
          },
          tokens: path.join(d, 'tokens.txt'),
          numThreads: 2,
          provider: 'cpu',
          debug: 0,
        },
      },
    };
  }
  if (k === 'bi') {
    const modelConfig = {
      transducer: {
        encoder: path.join(d, 'encoder-epoch-99-avg-1.int8.onnx'),
        decoder: path.join(d, 'decoder-epoch-99-avg-1.int8.onnx'),
        joiner: path.join(d, 'joiner-epoch-99-avg-1.int8.onnx'),
      },
      tokens: path.join(d, 'tokens.txt'),
      // English tokens in this vocabulary are upper case, so hotwords have to
      // be upper case too or the encoder cannot find IDs for them.
      bpeVocab: path.join(d, 'bpe.vocab'),
      modelingUnit: 'cjkchar+bpe',
      numThreads: 2,
      provider: 'cpu',
      debug: 0,
    };
    return { kind: 'online', cfg: onlineCfg(modelConfig, opts) };
  }
  if (k === 'zh25') {
    const modelConfig = {
      transducer: {
        encoder: path.join(d, 'encoder.int8.onnx'),
        decoder: path.join(d, 'decoder.onnx'),
        joiner: path.join(d, 'joiner.int8.onnx'),
      },
      tokens: path.join(d, 'tokens.txt'),
      // No bpe.vocab in this release and no ASCII tokens at all: Chinese only.
      modelingUnit: 'cjkchar',
      numThreads: 2,
      provider: 'cpu',
      debug: 0,
    };
    return { kind: 'online', cfg: onlineCfg(modelConfig, opts) };
  }
  const modelConfig = {
    transducer: {
      encoder: path.join(d, 'encoder-epoch-75-avg-11-chunk-16-left-128.int8.onnx'),
      decoder: path.join(d, 'decoder-epoch-75-avg-11-chunk-16-left-128.onnx'),
      joiner: path.join(d, 'joiner-epoch-75-avg-11-chunk-16-left-128.int8.onnx'),
    },
    tokens: path.join(d, 'tokens.txt'),
    numThreads: 2,
    provider: 'cpu',
    debug: 0,
  };
  return { kind: 'online', cfg: onlineCfg(modelConfig, opts) };
}
function onlineCfg(modelConfig, opts) {
  const cfg = {
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig,
    decodingMethod: 'greedy_search',
    maxActivePaths: 1,
  };
  if (opts.hotwordsFile) {
    cfg.decodingMethod = 'modified_beam_search';
    cfg.maxActivePaths = Math.max(2, Number(opts.maxActivePaths) || 4);
    cfg.hotwordsFile = opts.hotwordsFile;
    cfg.hotwordsScore = Number(opts.hotwordsScore) || 3;
  }
  return cfg;
}
// Recognizers hold the whole acoustic model in native memory (~500MB each), so
// they are cached — but a hotword-boosted recognizer is built from a *file*, so
// the cache key has to be the hotword signature, not the file name (a fresh
// temp file every request would build a new model every request). Keep the
// window small: the user edits the box a handful of times per session.
const MAX_CACHED = 6;
function getRecognizer(k, opts) {
  const key = `${k}|${opts.hotwordSig || ''}`;
  if (recognizers.has(key)) {
    const hit = recognizers.get(key);
    recognizers.delete(key); recognizers.set(key, hit);   // LRU touch
    return hit;
  }
  const s = loadSherpa();
  const { kind, cfg } = engineConfig(k, opts);
  const rec = kind === 'offline' ? new s.OfflineRecognizer(cfg) : new s.OnlineRecognizer(cfg);
  recognizers.set(key, rec);
  while (recognizers.size > MAX_CACHED) recognizers.delete(recognizers.keys().next().value);
  return rec;
}

// ── decode helpers ──
function int16ToFloat32(int16) {
  const out = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) out[i] = int16[i] / 32768;
  return out;
}
function parseWavPcm16(buf) {
  try {
    if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') return null;
    let off = 12, fmt = null, data = null;
    while (off + 8 <= buf.length) {
      const id = buf.toString('ascii', off, off + 4);
      const size = buf.readUInt32LE(off + 4);
      const body = off + 8;
      if (id === 'fmt ') fmt = { audioFormat: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2), sampleRate: buf.readUInt32LE(body + 4), bitsPerSample: buf.readUInt16LE(body + 14) };
      else if (id === 'data') data = buf.subarray(body, Math.min(body + size, buf.length));
      off = body + size + (size % 2);
    }
    if (!fmt || !data || fmt.audioFormat !== 1 || fmt.bitsPerSample !== 16) return null;
    const int16 = new Int16Array(data.buffer, data.byteOffset, Math.floor(data.byteLength / 2));
    let samples;
    if (fmt.channels === 1) samples = int16ToFloat32(int16);
    else {
      samples = new Float32Array(Math.floor(int16.length / 2));
      for (let i = 0; i < samples.length; i++) samples[i] = (int16[2 * i] + int16[2 * i + 1]) / 2 / 32768;
    }
    return { samples, sampleRate: fmt.sampleRate };
  } catch (_) { return null; }
}
function ffmpegDecode(buf) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-f', 'f32le', '-ac', '1', '-ar', '16000', 'pipe:1']);
    const chunks = []; let err = '';
    const timer = setTimeout(() => { try { ff.kill('SIGKILL'); } catch (_) {} reject(new Error('ffmpeg 解码超时')); }, 20000);
    ff.stdout.on('data', c => chunks.push(c));
    ff.stderr.on('data', c => { err += c; });
    ff.on('error', e => { clearTimeout(timer); reject(new Error('ffmpeg 不可用: ' + e.message)); });
    ff.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`ffmpeg 失败(${code}): ${err.slice(0, 200)}`));
      const all = Buffer.concat(chunks);
      resolve(new Float32Array(all.buffer, all.byteOffset, Math.floor(all.byteLength / 4)));
    });
    ff.stdin.on('error', () => {});
    ff.stdin.end(buf);
  });
}
async function decodeAudio(buf) {
  const wav = parseWavPcm16(buf);
  if (wav && wav.sampleRate === 16000) return wav.samples;
  if (wav && wav.sampleRate !== 16000) return ffmpegDecode(buf);
  return ffmpegDecode(buf);
}

function transcribeOffline(rec, samples) {
  const t0 = Date.now();
  const st = rec.createStream();
  st.acceptWaveform({ sampleRate: 16000, samples });
  rec.decode(st);
  const r = rec.getResult(st);
  return { text: (r.text || '').trim(), ms: Date.now() - t0 };
}
function transcribeOnline(rec, samples) {
  const t0 = Date.now();
  const st = rec.createStream();
  st.acceptWaveform({ sampleRate: 16000, samples });
  // 0.4s of trailing silence flushes the last chunk of the encoder.
  st.acceptWaveform({ sampleRate: 16000, samples: new Float32Array(6400) });
  while (rec.isReady(st)) rec.decode(st);
  const r = rec.getResult(st);
  const ctx = Math.max(0, ...(r.context_scores || [0]));
  return { text: (r.text || '').trim(), ms: Date.now() - t0, ctx };
}

// ── hotword files ──
function hotwordFileFor(engine, text, score) {
  const words = String(text || '').split(/\r?\n/).map(w => w.trim()).filter(Boolean);
  if (!words.length) return null;
  let lines;
  if (engine === 'bi') {
    // Upper-case ASCII to match this model's vocabulary; CJK is untouched.
    lines = words.map(w => w.replace(/[A-Za-z]+/g, s => s.toUpperCase()));
  } else if (engine === 'zh25') {
    lines = words.filter(w => !/[A-Za-z]/.test(w));
  } else return null;
  if (!lines.length) return null;
  const body = lines.map(l => `${l}${score ? ` :${score}` : ''}`).join('\n') + '\n';
  const sig = crypto.createHash('sha1').update(body).digest('hex').slice(0, 16);
  const file = path.join(os.tmpdir(), `mcc-hw-${engine}-${sig}.txt`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, body);
  return { file, sig };
}

function versionAtLeast(v, major, minor, patch) {
  const p = String(v || '').split('.').map(n => parseInt(n, 10) || 0);
  const [a, b, c] = [p[0] || 0, p[1] || 0, p[2] || 0];
  if (a !== major) return a > major;
  if (b !== minor) return b > minor;
  return c >= patch;
}
// 1.13.4 accepts the config and silently returns an empty transcript for every
// streaming transducer — the page must say so rather than look "broken".
const transducerOk = () => versionAtLeast(sherpaVersion, 1, 13, 8);

// Local engines only — online services live in PROVIDERS above.
const ENGINES = {
  sense: { label: 'SenseVoiceSmall（当前默认）', kind: 'offline', hotwords: false },
  bi: { label: 'Zipformer 双语 2023（greedy，无热词）', kind: 'online', hotwords: false },
  'bi-hw': { label: 'Zipformer 双语 + 解码期热词', kind: 'online', hotwords: true, base: 'bi' },
  'zh25-hw': { label: 'Zipformer 中文 2025 + 热词（无英文词表）', kind: 'online', hotwords: true, base: 'zh25' },
  mul: { label: 'Zipformer 多语种 2025（无热词）', kind: 'online', hotwords: false },
};

let sensePost = null;
function applySensePost(text) {
  if (sensePost === null) {
    try {
      const asr = require(path.join(__dirname, '..', '..', 'src', 'native', 'binding')).asrLocal;
      sensePost = asr && typeof asr.applyVocabCorrections === 'function' ? asr.applyVocabCorrections : false;
    } catch (_) { sensePost = false; }
  }
  return sensePost ? sensePost(text) : text;
}

// ── 在线 ASR（OpenAI 兼容 /audio/transcriptions）──
function encodeWav(samples, sampleRate) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }
  return buf;
}

const wordsOf = text => String(text || '').split(/\r?\n/).map(w => w.trim()).filter(Boolean);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const isProvider = id => Object.prototype.hasOwnProperty.call(PROVIDERS, id);

function providerPublic(id) {
  const p = PROVIDERS[id];
  return {
    id, label: p.label, protocol: p.protocol, hotwordMode: p.hotwordMode,
    baseUrl: p.baseUrl, model: p.model, language: p.language,
    hasKey: !!p.key, note: p.note,
  };
}
// Per-recording overrides from the page. Keys that look masked never replace a
// real one — the page has no way to read the configured key back.
function providerWith(id, ov) {
  const p = PROVIDERS[id];
  if (!ov) return p;
  const out = { ...p };
  for (const f of ['baseUrl', 'model', 'key', 'language']) {
    if (typeof ov[f] === 'string' && ov[f] && !(f === 'key' && ov[f].includes('****'))) out[f] = ov[f];
  }
  return out;
}

async function httpJson(url, opts, label, timeoutMs = 60000) {
  const resp = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
  const body = await resp.text();
  if (!resp.ok) throw new Error(`${label} ${resp.status}: ${body.slice(0, 180)}`);
  try { return JSON.parse(body); }
  catch (_) { throw new Error(`${label} 返回非 JSON: ${body.slice(0, 120)}`); }
}
function wavBlob(samples) {
  const wav = encodeWav(samples, 16000);
  return { wav, form: () => {
    const form = new FormData();
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
    return form;
  } };
}

// OpenAI-compatible POST /audio/transcriptions. Whisper has no decode-time
// biasing: the hotword list can only ride as `prompt` (a soft hint). 智谱 takes
// a real `hotwords` array instead.
async function callOpenAITranscriptions(samples, p, hotwords) {
  const { form } = wavBlob(samples);
  const f = form();
  if (p.model) f.append('model', p.model);
  if (p.language) f.append('language', p.language);
  const words = wordsOf(hotwords);
  if (words.length && p.hotwordMode === 'native') f.append('hotwords', JSON.stringify(words.slice(0, 100)));
  else if (words.length && p.hotwordMode === 'prompt') f.append('prompt', words.join(', ').slice(0, 800));
  const t0 = Date.now();
  const j = await httpJson(String(p.baseUrl).replace(/\/+$/, '') + '/audio/transcriptions', {
    method: 'POST', headers: { Authorization: `Bearer ${p.key}` }, body: f,
  }, p.label);
  return { text: String(j.text || '').trim(), ms: Date.now() - t0 };
}

// 阿里 Qwen3-ASR 的「兼容模式」其实走 chat/completions + input_audio。
async function callOpenAIChatAudio(samples, p, hotwords) {
  const dataUri = 'data:audio/wav;base64,' + encodeWav(samples, 16000).toString('base64');
  const body = {
    model: p.model,
    messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: dataUri } }] }],
    stream: false,
  };
  const asr = {};
  if (p.language) asr.language = p.language;
  const words = wordsOf(hotwords);
  if (words.length && p.hotwordMode === 'context') asr.context = words.join(' ');
  if (Object.keys(asr).length) body.asr_options = asr;
  const t0 = Date.now();
  const j = await httpJson(String(p.baseUrl).replace(/\/+$/, '') + '/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${p.key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }, p.label);
  const msg = j.choices && j.choices[0] && j.choices[0].message;
  const c = msg && msg.content;
  const text = Array.isArray(c) ? c.map(x => (x && x.text) || '').join('') : String(c || '');
  return { text: text.trim(), ms: Date.now() - t0 };
}

// Deepgram: raw audio in the body, keywords as query params.
async function callDeepgram(samples, p, hotwords) {
  const q = new URLSearchParams({ model: p.model || 'nova-3', smart_format: 'true', punctuate: 'true' });
  if (p.language) q.set('language', p.language);
  const words = wordsOf(hotwords);
  if (words.length && p.hotwordMode === 'keywords') q.set('keywords', words.map(w => `${w}:2`).join(','));
  const t0 = Date.now();
  const j = await httpJson(`${String(p.baseUrl).replace(/\/+$/, '')}/v1/listen?${q}`, {
    method: 'POST',
    headers: { Authorization: `Token ${p.key}`, 'content-type': 'audio/wav' },
    body: encodeWav(samples, 16000),
  }, p.label);
  const alt = j.results && j.results.channels && j.results.channels[0]
    && j.results.channels[0].alternatives && j.results.channels[0].alternatives[0];
  return { text: String((alt && alt.transcript) || '').trim(), ms: Date.now() - t0 };
}

async function callElevenLabs(samples, p) {
  const f = wavBlob(samples).form();
  f.append('model_id', p.model || 'scribe_v1');
  if (p.language) f.append('language_code', p.language);
  const t0 = Date.now();
  const j = await httpJson(`${String(p.baseUrl).replace(/\/+$/, '')}/v1/speech-to-text`, {
    method: 'POST', headers: { 'xi-api-key': p.key }, body: f,
  }, p.label);
  return { text: String(j.text || '').trim(), ms: Date.now() - t0 };
}

// AssemblyAI: upload → submit → poll.
async function callAssemblyAI(samples, p, hotwords) {
  const base = String(p.baseUrl).replace(/\/+$/, '');
  const t0 = Date.now();
  const up = await httpJson(`${base}/v2/upload`, {
    method: 'POST',
    headers: { authorization: p.key, 'content-type': 'application/octet-stream' },
    body: encodeWav(samples, 16000),
  }, p.label + ' upload');
  const req = { audio_url: up.upload_url };
  if (p.language) req.language_code = p.language;
  const words = wordsOf(hotwords);
  if (words.length && p.hotwordMode === 'keywords') { req.word_boost = words; req.boost_param = 'high'; }
  const job = await httpJson(`${base}/v2/transcript`, {
    method: 'POST',
    headers: { authorization: p.key, 'content-type': 'application/json' },
    body: JSON.stringify(req),
  }, p.label);
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    await sleep(700);
    const st = await httpJson(`${base}/v2/transcript/${job.id}`, { headers: { authorization: p.key } }, p.label);
    if (st.status === 'completed') return { text: String(st.text || '').trim(), ms: Date.now() - t0 };
    if (st.status === 'error') throw new Error(`${p.label}: ${st.error || '识别失败'}`);
  }
  throw new Error(`${p.label} 轮询超时`);
}

// ── 火山豆包流式：私有二进制帧 + gzip over WebSocket ──
// Header: [0]=0x11 (v1, 4 bytes), [1]=type<<4|flags, [2]=serialization<<4|compression,
// [3]=0; then uint32 BE payload size, then payload. Server frames carry an
// int32 sequence after the header when flags say so. Final response = flags 0b0011.
const VOLC = { FULL_CLIENT: 0x1, AUDIO_ONLY: 0x2, FULL_SERVER: 0x9, ERROR: 0xf };
let wsModule;
function loadWs() {
  if (wsModule !== undefined) return wsModule;
  for (const c of [process.env.WS_MODULE, 'ws', path.join(__dirname, '..', '..', 'node_modules', 'ws')].filter(Boolean)) {
    try { wsModule = require(c); return wsModule; } catch (_) {}
  }
  wsModule = null;
  return null;
}
function volcFrame(type, flags, payload, gzip = true) {
  const head = Buffer.from([0x11, (type << 4) | flags, (0x1 << 4) | (gzip ? 1 : 0), 0x00]);
  const body = gzip ? zlib.gzipSync(payload) : payload;
  const size = Buffer.alloc(4);
  size.writeUInt32BE(body.length, 0);
  return Buffer.concat([head, size, body]);
}
function volcParse(buf) {
  if (!buf || buf.length < 4) return null;
  const type = buf[1] >> 4;
  const flags = buf[1] & 0x0f;
  const ser = buf[2] >> 4;
  const comp = buf[2] & 0x0f;
  let off = 4;
  if (type === VOLC.ERROR) {
    const code = buf.readUInt32BE(off);
    const n = buf.readUInt32BE(off + 4);
    return { type, flags, error: `${code} ${buf.toString('utf8', off + 8, off + 8 + n)}` };
  }
  if (flags === 0x1 || flags === 0x3) off += 4;   // int32 sequence
  if (buf.length < off + 4) return null;
  const size = buf.readUInt32BE(off);
  off += 4;
  let p = buf.subarray(off, off + size);
  if (comp === 1) { try { p = zlib.gunzipSync(p); } catch (_) {} }
  let json = null;
  if (ser === 1) { try { json = JSON.parse(p.toString('utf8')); } catch (_) {} }
  return { type, flags, json };
}
function callVolc(samples, p, hotwords) {
  const WebSocket = loadWs();
  if (!WebSocket) throw new Error('火山需要 ws 模块：npm i ws，或设 WS_MODULE=/path/to/ws');
  const pcm = encodeWav(samples, 16000).subarray(44);
  const words = wordsOf(hotwords);
  const cfg = {
    user: { uid: 'multicc-asr-compare' },
    audio: { format: 'pcm', codec: 'raw', rate: 16000, bits: 16, channel: 1 },
    request: {
      model_name: 'bigmodel', enable_itn: true, enable_punc: true,
      show_utterances: true, result_type: 'full', enable_nonstream: false,
    },
  };
  if (p.appId) cfg.user.appid = p.appId;
  if (words.length && p.hotwordMode === 'native') {
    cfg.request.corpus = { context: JSON.stringify({ hotwords: words.map(w => ({ word: w })) }) };
  }
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    let settled = false;
    let lastText = '';
    let timer = null;
    let ws = null;
    function finish(err, text) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { if (ws) ws.close(); } catch (_) {}
      if (err) reject(err); else resolve({ text, ms: Date.now() - t0 });
    }
    ws = new WebSocket(p.baseUrl, {
      headers: {
        'X-Api-Key': p.key,
        'X-Api-Resource-Id': p.resourceId,
        'X-Api-Request-Id': crypto.randomUUID(),
        'X-Api-Sequence': '-1',
        'X-Api-Connect-Id': crypto.randomUUID(),
      },
    });
    timer = setTimeout(() => finish(new Error('火山 ASR 超时')), 90000);
    ws.on('open', () => {
      ws.send(volcFrame(VOLC.FULL_CLIENT, 0, Buffer.from(JSON.stringify(cfg))));
      const CHUNK = 32000;   // 1s of 16k mono s16le
      let off = 0;
      const pump = () => {
        if (settled || off >= pcm.length) return;
        const end = Math.min(off + CHUNK, pcm.length);
        const last = end >= pcm.length;
        ws.send(volcFrame(VOLC.AUDIO_ONLY, last ? 0x2 : 0x0, Buffer.from(pcm.subarray(off, end))));
        off = end;
        if (!last) setTimeout(pump, 15);
      };
      pump();
    });
    ws.on('message', data => {
      const r = volcParse(Buffer.isBuffer(data) ? data : Buffer.from(data));
      if (!r) return;
      if (r.type === VOLC.ERROR || (r.json && r.json.error)) {
        const msg = r.error || (r.json && r.json.error) || '未知错误';
        return finish(new Error(`火山 ASR: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`));
      }
      if (r.type !== VOLC.FULL_SERVER || !r.json) return;
      const t = r.json.result && r.json.result.text;
      if (typeof t === 'string' && t.trim()) lastText = t.trim();
      if (r.flags === 0x3) finish(null, lastText);
    });
    ws.on('error', e => finish(new Error('火山 ASR 连接失败: ' + e.message)));
    ws.on('close', () => { if (!settled) finish(lastText ? null : new Error('火山 ASR 连接提前关闭'), lastText); });
  });
}

const HOTWORD_NOTE = {
  prompt: '热词只作为 prompt 提示，不是解码期偏置',
  native: '该服务支持原生热词表',
  keywords: '热词走关键词加权（keywords / word_boost）',
  context: '热词作为上下文提示（context），非解码期偏置',
  none: '该服务不支持热词',
};

async function transcribeProvider(id, samples, { hotwords, override }) {
  const p = providerWith(id, override);
  if (!p.baseUrl) throw new Error(`${p.label} 未配置 Base URL`);
  if (!p.key) throw new Error(`${p.label} 未配置 API Key（页面里填，或在 .env 设 ASR_${id.toUpperCase()}_API_KEY）`);
  const secs = samples.length / 16000;
  if (p.maxSeconds && secs > p.maxSeconds) throw new Error(`${p.label} 单段上限 ${p.maxSeconds}s（本次 ${secs.toFixed(1)}s）`);
  switch (p.protocol) {
    case 'openai-transcriptions': return callOpenAITranscriptions(samples, p, hotwords);
    case 'openai-chat-audio': return callOpenAIChatAudio(samples, p, hotwords);
    case 'deepgram': return callDeepgram(samples, p, hotwords);
    case 'elevenlabs': return callElevenLabs(samples, p);
    case 'assemblyai': return callAssemblyAI(samples, p, hotwords);
    case 'volc-sauc': return callVolc(samples, p, hotwords);
    default: throw new Error(`未实现的协议 ${p.protocol}`);
  }
}

async function runEngines(buf, { engines, hotwords, score, postProcess, cloud }) {
  const samples = await decodeAudio(buf);
  const audioSec = samples.length / 16000;
  const jobs = engines.map(async id => {
    try {
      if (isProvider(id)) {
        const spec = PROVIDERS[id];
        const r = await transcribeProvider(id, samples, { hotwords, override: cloud && cloud[id] });
        const hasHw = wordsOf(hotwords).length > 0 && spec.hotwordMode !== 'none';
        const notes = [];
        if (spec.note) notes.push(spec.note);
        if (wordsOf(hotwords).length) notes.push(HOTWORD_NOTE[spec.hotwordMode] || '');
        return {
          id, label: spec.label, text: r.text, ms: r.ms,
          hotwordsUsed: hasHw,
          note: notes.filter(Boolean).join(' · ') || undefined,
        };
      }
      const spec = ENGINES[id];
      if (!spec) return { id, error: '未知引擎' };
      const base = spec.base || id;
      if (!hasModel(base)) return { id, label: spec.label, error: '模型未下载' };
      const hw = spec.hotwords ? hotwordFileFor(base, hotwords, score) : null;
      const rec = getRecognizer(base, hw ? { hotwordsFile: hw.file, hotwordSig: `${hw.sig}|${score}`, hotwordsScore: score, maxActivePaths: 4 } : {});
      const r = spec.kind === 'offline' ? transcribeOffline(rec, samples) : transcribeOnline(rec, samples);
      let text = r.text;
      if (id === 'sense' && postProcess) text = applySensePost(text);
      return { id, label: spec.label, text, ms: r.ms, ctx: r.ctx, hotwordsUsed: !!hw, note: spec.hotwords && !hw ? '热词为空或该模型不支持' : undefined };
    } catch (e) {
      const spec = PROVIDERS[id] || ENGINES[id] || {};
      return { id, label: spec.label, error: e.message };
    }
  });
  return { audioSec, results: await Promise.all(jobs) };
}

// ── app hotwords (best effort) ──
function appHotwords() {
  try {
    const { hotwordList } = require(path.join(__dirname, '..', '..', 'src', 'voice', 'config'));
    return hotwordList() || '';
  } catch (_) { return ''; }
}

// ── http ──
function send(res, code, body, type = 'application/json; charset=utf-8') {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(data);
}
function readBody(req, limit = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > limit) { reject(new Error('音频过大')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
const PAGE = path.join(__dirname, 'index.html');

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return send(res, 200, fs.readFileSync(PAGE), 'text/html; charset=utf-8');
    }
    if (url.pathname === '/api/status') {
      try { loadSherpa(); } catch (_) {}
      return send(res, 200, {
        sherpaVersion,
        sherpaError,
        transducerOk: transducerOk(),
        modelRoot: MODEL_ROOT,
        models: Object.fromEntries(Object.keys(DIRS).map(k => [k, hasModel(k)])),
        engines: ENGINES,
        hotwords: appHotwords(),
        envFile: ENV_FILE,
        // Never send keys to the page — only whether one exists.
        providers: Object.keys(PROVIDERS).map(providerPublic),
      });
    }
    // Preload the models the page has checked, so the first recording is not a
    // 10s model-load stall. Safe to call repeatedly.
    if (url.pathname === '/api/warm' && req.method === 'POST') {
      const ids = String(req.headers['x-engines'] || '').split(',').map(s => s.trim()).filter(Boolean);
      const loaded = [];
      for (const id of ids) {
        const spec = ENGINES[id];
        if (!spec) continue;   // online providers have nothing to preload
        // A hotword recognizer is built for one specific hotword signature, so
        // preloading the plain variant would only waste ~500MB.
        if (spec.hotwords) continue;
        const base = spec.base || id;
        if (!hasModel(base)) continue;
        try {
          getRecognizer(base, {});
          loaded.push(id);
        } catch (e) { /* reported through /api/transcribe */ }
      }
      return send(res, 200, { loaded });
    }
    if (url.pathname === '/api/transcribe' && req.method === 'POST') {
      const buf = await readBody(req);
      if (!buf.length) return send(res, 400, { error: '空音频' });
      const engines = String(req.headers['x-engines'] || 'sense,bi,bi-hw').split(',').map(s => s.trim()).filter(Boolean);
      const score = Number(req.headers['x-hotword-score'] || 3) || 3;
      const postProcess = String(req.headers['x-post-process'] || '1') !== '0';
      let hotwords = '';
      if (req.headers['x-hotwords']) {
        try { hotwords = Buffer.from(String(req.headers['x-hotwords']), 'base64').toString('utf8'); } catch (_) {}
      }
      // Per-recording online overrides, keyed by provider id:
      // {groq: {baseUrl, model, key, language}, ...}
      let cloud = null;
      if (req.headers['x-cloud-config']) {
        try {
          const cfg = JSON.parse(Buffer.from(String(req.headers['x-cloud-config']), 'base64').toString('utf8'));
          if (cfg && typeof cfg === 'object') {
            cloud = {};
            for (const [id, ov] of Object.entries(cfg)) {
              if (!isProvider(id) || !ov || typeof ov !== 'object') continue;
              cloud[id] = ov;
            }
          }
        } catch (_) {}
      }
      const t0 = Date.now();
      const out = await runEngines(buf, { engines, hotwords, score, postProcess, cloud });
      return send(res, 200, { ...out, totalMs: Date.now() - t0 });
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[asr-compare] http://${HOST}:${PORT}  (models: ${MODEL_ROOT})`);
  for (const k of Object.keys(DIRS)) console.log(`  ${hasModel(k) ? '✓' : '✗'} ${k}  ${dirOf(k)}`);
  console.log(`  在线服务 (env=${ENV_FILE}):`);
  for (const id of Object.keys(PROVIDERS)) {
    const p = PROVIDERS[id];
    console.log(`  ${p.key ? '✓' : '✗'} ${id.padEnd(12)} ${p.protocol.padEnd(22)} ${p.baseUrl || '(未配置)'} ${p.model ? `(${p.model})` : ''}`);
  }
});
