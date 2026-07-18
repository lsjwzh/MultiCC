#!/usr/bin/env node
// Local ASR (src/asr-local.js) smoke + benchmark.
//
//   node tests/test-local-asr.js                  # module smoke: wav/webm/streaming
//   node tests/test-local-asr.js --typeless 8     # + local-vs-cloud on real Typeless recordings
//
// When run from a worktree without node_modules, point NODE_PATH at the main
// repo install:  NODE_PATH=/path/to/multicc/node_modules node tests/test-local-asr.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const asrLocal = require('../src/asr-local');

const MODEL_DIR = process.env.ASR_LOCAL_MODEL_DIR || path.join(os.homedir(), '.multicc', 'asr-models');
const TEST_WAVS = path.join(MODEL_DIR, 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17', 'test_wavs');

function fail(msg) { console.error('✗ ' + msg); process.exitCode = 1; }
function ok(msg) { console.log('✓ ' + msg); }

async function smokeWav() {
  const buf = fs.readFileSync(path.join(TEST_WAVS, 'zh.wav'));
  const r = await asrLocal.transcribeBuffer(buf, 'audio/wav');
  if (!r.text || !/开放时间/.test(r.text)) return fail(`WAV path: unexpected text "${r.text}"`);
  ok(`WAV fast path: ${r.ms}ms total (decode ${r.decodeMs}ms + infer ${r.inferMs}ms), text="${r.text}"`);
}

async function smokeWebm() {
  const webmPath = path.join(os.tmpdir(), 'multicc-asr-test.webm');
  try {
    execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error',
      '-i', path.join(TEST_WAVS, 'zh.wav'), '-c:a', 'libopus', webmPath]);
  } catch (e) {
    return fail('cannot create test webm (ffmpeg missing?): ' + e.message);
  }
  const r = await asrLocal.transcribeBuffer(fs.readFileSync(webmPath), 'audio/webm');
  if (!r.text || !/开放时间/.test(r.text)) return fail(`webm path: unexpected text "${r.text}"`);
  ok(`webm (ffmpeg) path: ${r.ms}ms total (decode ${r.decodeMs}ms + infer ${r.inferMs}ms), text="${r.text}"`);
}

function smokeStreaming() {
  return new Promise((resolve) => {
    const buf = fs.readFileSync(path.join(TEST_WAVS, 'zh.wav'));
    // strip 44-byte canonical header → PCM16 @16k (test wavs are 16k mono pcm16)
    const pcm = buf.subarray(44);
    const finals = [];
    let readyAt = 0;
    const t0 = Date.now();
    const session = asrLocal.createStreamingSession({ lang: 'zh' }, {
      onReady: () => { readyAt = Date.now() - t0; },
      onPartial: () => {},
      onFinal: (t) => finals.push(t),
      onDone: () => {
        const text = finals.join('');
        if (!/开放时间/.test(text)) fail(`streaming: unexpected text "${text}" (${finals.length} segments)`);
        else ok(`streaming session: ready +${readyAt}ms, ${finals.length} segment(s) in ${Date.now() - t0}ms, text="${text}"`);
        resolve();
      },
      onError: (m) => { fail('streaming error: ' + m); resolve(); },
    });
    if (!session) { fail('createStreamingSession returned null'); return resolve(); }
    // feed 100ms chunks like the worklet does
    const chunkBytes = 16000 * 0.1 * 2;
    for (let off = 0; off < pcm.length; off += chunkBytes) {
      session.pushAudio(new Int16Array(pcm.buffer, pcm.byteOffset + off,
        Math.floor(Math.min(chunkBytes, pcm.length - off) / 2)));
    }
    session.finish();
  });
}

// ── Optional: local vs cloud on real recordings (Typeless app data) ──
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}
const similarity = (a, b) => {
  a = (a || '').replace(/[\s，。,.!？?！]/g, ''); b = (b || '').replace(/[\s，。,.!？?！]/g, '');
  const d = levenshtein(a, b);
  return Math.max(a.length, b.length) ? 1 - d / Math.max(a.length, b.length) : 1;
};

function loadEnv(file) {
  const env = {};
  try {
    fs.readFileSync(file, 'utf8').split('\n').forEach(l => {
      const m = l.match(/^\s*([^#=]+?)\s*=\s*(.*?)\s*$/);
      if (m) env[m[1]] = m[2];
    });
  } catch (_) {}
  return env;
}

async function cloudTranscribe(buf, name, env) {
  const baseUrl = env.WHISPER_BASE_URL || 'https://openrouter.ai/api/v1';
  const apiKey = env.WHISPER_API_KEY || env.OPENROUTER_API_KEY;
  if (!apiKey) return null;
  const form = new FormData();
  form.append('file', new Blob([buf]), name);
  form.append('model', env.WHISPER_MODEL || 'whisper-large-v3-turbo');
  form.append('language', env.WHISPER_LANGUAGE || 'zh');
  const t0 = Date.now();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 30000);
  try {
    const resp = await fetch(`${baseUrl}/audio/transcriptions`, {
      method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form, signal: abort.signal,
    });
    if (!resp.ok) return { error: `${resp.status}`, ms: Date.now() - t0 };
    const j = await resp.json();
    return { text: j.text || '', ms: Date.now() - t0 };
  } catch (e) {
    return { error: e.name === 'AbortError' ? 'timeout' : e.message, ms: Date.now() - t0 };
  } finally { clearTimeout(timer); }
}

async function typelessBenchmark(limit) {
  const dbPath = path.join(os.homedir(), 'Library/Application Support/Typeless/typeless.db');
  if (!fs.existsSync(dbPath)) return fail('Typeless DB not found: ' + dbPath);
  const Database = require('better-sqlite3');
  const db = new Database(dbPath, { readonly: true });
  const rows = db.prepare(
    `SELECT audio_local_path, refined_text FROM history
     WHERE audio_local_path IS NOT NULL AND refined_text IS NOT NULL AND refined_text != ''
     ORDER BY rowid DESC LIMIT ?`).all(limit * 2);
  db.close();
  let env = loadEnv(path.join(__dirname, '..', '.env'));
  if (!env.WHISPER_API_KEY && !env.OPENROUTER_API_KEY && process.env.MULTICC_MAIN_ENV) {
    env = loadEnv(process.env.MULTICC_MAIN_ENV);   // worktrees have no .env; point at the main repo copy
  }

  const stats = { local: [], cloud: [] };
  let n = 0;
  for (const row of rows) {
    if (n >= limit) break;
    if (!row.audio_local_path || !fs.existsSync(row.audio_local_path)) continue;
    const buf = fs.readFileSync(row.audio_local_path);
    n++;
    let localR;
    try {
      localR = await asrLocal.transcribeBuffer(buf, 'audio/ogg');
    } catch (e) { fail(`local transcribe ${path.basename(row.audio_local_path)}: ${e.message}`); continue; }
    const localSim = similarity(localR.text, row.refined_text);
    stats.local.push({ ms: localR.ms, sim: localSim });

    const cloudR = await cloudTranscribe(buf, path.basename(row.audio_local_path), env);
    let cloudDesc = 'skipped (no key)';
    if (cloudR) {
      if (cloudR.error) cloudDesc = `error ${cloudR.error} after ${cloudR.ms}ms`;
      else {
        const cloudSim = similarity(cloudR.text, row.refined_text);
        stats.cloud.push({ ms: cloudR.ms, sim: cloudSim });
        cloudDesc = `${cloudR.ms}ms sim=${(cloudSim * 100).toFixed(0)}%`;
      }
    }
    console.log(`  #${n} ${path.basename(row.audio_local_path).slice(0, 12)}… audio=${localR.audioSec.toFixed(1)}s | local ${localR.ms}ms sim=${(localSim * 100).toFixed(0)}% | cloud ${cloudDesc}`);
    console.log(`      ref:   ${row.refined_text.slice(0, 60)}`);
    console.log(`      local: ${localR.text.slice(0, 60)}`);
  }
  const avg = (arr, k) => arr.length ? arr.reduce((s, x) => s + x[k], 0) / arr.length : 0;
  console.log(`\n== ${n} recordings ==`);
  console.log(`local: avg ${avg(stats.local, 'ms').toFixed(0)}ms, avg similarity ${(avg(stats.local, 'sim') * 100).toFixed(1)}%`);
  if (stats.cloud.length) {
    console.log(`cloud: avg ${avg(stats.cloud, 'ms').toFixed(0)}ms, avg similarity ${(avg(stats.cloud, 'sim') * 100).toFixed(1)}% (${stats.cloud.length} ok)`);
  }
}

(async () => {
  if (!asrLocal.isAvailable()) {
    fail('local ASR unavailable — run scripts/setup-local-asr.sh and npm install sherpa-onnx-node');
    process.exit(1);
  }
  await asrLocal.warmup();
  console.log('status:', JSON.stringify(asrLocal.status()));
  await smokeWav();
  await smokeWebm();
  await smokeStreaming();

  const idx = process.argv.indexOf('--typeless');
  if (idx !== -1) {
    const limit = parseInt(process.argv[idx + 1], 10) || 8;
    console.log(`\n── local vs cloud on ${limit} Typeless recordings ──`);
    await typelessBenchmark(limit);
  }
  console.log(process.exitCode ? '\nFAILED' : '\nALL PASS');
})();
