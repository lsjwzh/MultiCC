'use strict';
// Compare the 13 voice REST routes that moved from src/routes/voice.js to the
// Rust front door (native/gateway/src/app/voice_routes.rs +
// native/core/src/voice_routes.rs) with the frozen Node oracle
// (tests/helpers/legacy-voice-routes.js).
//
// Both sides walk the same request sequence. The oracle answers in this
// process through lib.js's pipeline. The Rust side is the release
// multicc-gateway, whose Node child mounts the REAL src/routes/voice.js (stt)
// and src/routes/voice-host.js (the /api/__host/voice callback), with fake
// dependencies built from the same literal the oracle uses, so the two sides
// cannot drift. One SETUP literal creates both fake worlds; every case
// re-applies the same starting state on both sides.
//
// Usage: node docs/rust-migration/differential/voice-routes.js <repo> <gateway> <addon>
//
// Documented differences (each pinned to an exact shape on both sides):
//   * Express 4.22.2 does not catch a rejection from an async handler, so a
//     truthy non-string `raw`/`text` or a null progress event leaves the old
//     handler's request unanswered (and triggers unhandledRejection); Rust
//     renders safeErrorHandler's 500.
//   * The retired settings POST threw validation errors with `statusCode`,
//     but safeErrorHandler reads `err.status`, so the old pipeline answered
//     500 internal_error where Rust answers the documented 400 request_error.
//   * The front door claims only the exact-case `/api/` prefix; a differently
//     cased prefix is forwarded to the child, which no longer has these
//     routes (Express answered case-insensitively before the migration).
//   * `POST /api/__host/voice` on the public port: the retired router had no
//     such route (404), while the front door forwards it and the still-local
//     PROXY peer passes voice-host's isLocalRequest gate.
//   * UTF-16 slices that cut a surrogate pair become U+FFFD on the Rust side
//     (a lone surrogate cannot cross the JSON host-port boundary).

const http = require('node:http');
const path = require('node:path');
const { run, send } = require('./lib');

// The old async handlers' rejections never reach Express; swallow them here
// instead of letting the oracle process die mid-run.
process.on('unhandledRejection', () => {});

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// One definition of the fake voice world. It is evaluated here for the oracle
// and embedded verbatim in the gateway's Node child, so both sides run the
// same closures. No template literals inside (the literal is itself embedded).
const WORLD = `(function buildWorld() {
  var clone = function (value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
  };
  function replaceMutable(target, snapshot) {
    Object.keys(target).forEach(function (key) {
      if (!Object.prototype.hasOwnProperty.call(snapshot, key)) delete target[key];
    });
    Object.keys(snapshot).forEach(function (key) {
      var value = snapshot[key];
      var current = target[key];
      if (value && typeof value === 'object' && !Array.isArray(value)
        && current && typeof current === 'object' && !Array.isArray(current)) {
        replaceMutable(current, value);
      } else {
        target[key] = clone(value);
      }
    });
  }
  var DEFAULT_VOICE = {
    WHISPER_MODEL: 'whisper-large-v3-turbo',
    WHISPER_BASE_URL: 'https://openrouter.ai/api/v1',
    WHISPER_LANGUAGE: 'zh',
    WHISPER_PROMPT: '',
  };
  var runtimeEnv = {};
  var state = {
    envFile: {}, vocab: [], examples: [], corrections: [],
    aux: { mode: 'text', text: 'aux text', message: 'aux failed', raw: null },
    flags: {}, installerStatus: { state: 'idle' },
    providerStatus: { local: { available: true } },
    ttsStatus: { provider: 'edge', available: true },
    qwenRuntime: null, hotwords: null, installerCancel: true,
    whisperPrompt: '', calls: [],
  };
  function record(name, args) {
    state.calls.push([name].concat(Array.prototype.map.call(args, clone)));
  }
  function readEnvFile() { return clone(state.envFile); }
  function writeEnvFile(updates) {
    record('writeEnvFile', [updates]);
    if (state.flags.writeEnvThrows) throw new Error('persist failed');
    Object.keys(updates).forEach(function (key) {
      if (updates[key] === null) delete state.envFile[key];
      else state.envFile[key] = clone(updates[key]);
    });
  }
  function applyRuntimeEnv(env, updates) {
    record('applyRuntimeEnv', [updates]);
    if (state.flags.runtimeApplyThrows) throw new Error('runtime apply failed');
    Object.keys(updates).forEach(function (key) {
      if (updates[key] === null) delete env[key];
      else env[key] = clone(updates[key]);
    });
  }
  function rollbackRuntimeEnv(env, snapshot) {
    record('rollbackRuntimeEnv', [snapshot]);
    if (state.flags.runtimeRestoreThrows) throw new Error('runtime rollback failed');
    Object.keys(snapshot).forEach(function (key) {
      var entry = snapshot[key];
      if (entry.present) env[key] = clone(entry.value);
      else delete env[key];
    });
  }
  var voice = {
    cfg: clone(DEFAULT_VOICE),
    loadVoiceExamples: function () { return clone(state.examples); },
    appendVoiceExample: function (example) {
      record('appendVoiceExample', [example]);
      state.examples.push(clone(example));
    },
    loadWhisperVocab: function () { return clone(state.vocab); },
    saveWhisperVocab: function (vocab) { record('saveWhisperVocab', [vocab]); state.vocab = clone(vocab); },
    extractCorrections: function (raw, final) {
      record('extractCorrections', [raw, final]);
      return clone(state.corrections);
    },
    mergeWhisperVocab: function (terms) { record('mergeWhisperVocab', [terms]); },
    buildWhisperPrompt: function () { return state.whisperPrompt; },
    autoHotwords: null,
    autoHotwordsEnabled: false,
    applyEnvUpdates: function (updates) {
      record('voice.applyEnvUpdates', [updates]);
      if (state.flags.voiceApplyThrows) throw new Error('voice apply failed');
      Object.keys(updates).forEach(function (key) { voice.cfg[key] = clone(updates[key]); });
    },
    restoreConfig: function (snapshot) {
      record('voice.restoreConfig', [snapshot]);
      if (state.flags.voiceRestoreThrows) throw new Error('voice restore failed');
      replaceMutable(voice.cfg, snapshot);
    },
  };
  function makeService(name) {
    var service = {
      cfg: {},
      providerStatus: function () {
        if (name === 'asr') {
          if (state.flags.providerStatusThrows) throw new Error('provider status failed');
          return clone(state.providerStatus);
        }
        return clone(state.ttsStatus);
      },
      applyConfig: function (updates) {
        record(name + '.applyConfig', [updates]);
        if (state.flags[name + 'ApplyThrows']) throw new Error(name + ' apply failed');
        Object.keys(updates).forEach(function (key) { service.cfg[key] = clone(updates[key]); });
      },
      restoreConfig: function (snapshot) {
        record(name + '.restoreConfig', [snapshot]);
        if (state.flags[name + 'RestoreThrows']) throw new Error(name + ' restore failed');
        replaceMutable(service.cfg, snapshot);
      },
    };
    return service;
  }
  var asr = makeService('asr');
  var tts = makeService('tts');
  var asrLocal = {
    isAvailable: function () { record('asrLocal.isAvailable', []); return state.flags.asrAvailable !== false; },
    transcribeBuffer: function () { throw new Error('transcribeBuffer is not part of this comparison'); },
  };
  var installer = {
    status: function () {
      if (state.flags.installerStatusThrows) throw new Error('installer status failed');
      return clone(state.installerStatus);
    },
    start: function (mode) {
      record('installer.start', [mode]);
      if (state.flags.startRejects) return Promise.reject(new Error('start failed'));
      return new Promise(function () {});
    },
    cancel: function () { record('installer.cancel', []); return state.installerCancel; },
  };
  function syncHotwords() {
    if (!state.hotwords) {
      voice.autoHotwords = null;
      voice.autoHotwordsEnabled = false;
      return;
    }
    voice.autoHotwordsEnabled = !!state.hotwords.enabled;
    voice.autoHotwords = {
      snapshot: function () { record('hotwords.snapshot', []); return clone(state.hotwords.snapshot || {}); },
      reject: function (args) {
        record('hotwords.reject', [args]);
        if (state.flags.hotwordsRejectThrows) throw new Error('hotwords reject failed');
        return state.hotwords.accept !== false;
      },
    };
  }
  function enqueue(payload) {
    record('aux.enqueue', [payload]);
    var aux = state.aux;
    if (aux.mode === 'text') return Promise.resolve({ text: aux.text });
    if (aux.mode === 'empty') return Promise.resolve({});
    if (aux.mode === 'undefined') return Promise.resolve(undefined);
    if (aux.mode === 'throw') return Promise.reject(new Error(aux.message));
    if (aux.mode === 'cancel') {
      var cancelled = new Error(aux.message || 'cancelled');
      cancelled.cancelled = true;
      return Promise.reject(cancelled);
    }
    return Promise.reject(aux.raw);
  }
  var deps = {
    uploadVoice: function (req, res, next) { req.file = undefined; next(); },
    voice: voice,
    asrLocal: asrLocal,
    asrModelInstaller: installer,
    voiceAsr: asr,
    ttsService: tts,
    readEnvFile: readEnvFile,
    writeEnvFile: writeEnvFile,
    getAuxQueue: function () { return { enqueue: enqueue }; },
    runtimeEnv: runtimeEnv,
    log: { log: function () {}, error: function () {}, warn: function () {}, info: function () {} },
    reportFailure: function (stage, category) { record('reportFailure', [stage, category]); },
    getQwenAudioRuntimeStatus: function () { return clone(state.qwenRuntime); },
    onQwenAudioConfigChanged: function () {
      record('onQwenAudioConfigChanged', []);
      if (state.flags.onQwenRejects) return Promise.reject(new Error('qwen refresh failed'));
      return undefined;
    },
    applyRuntimeEnv: applyRuntimeEnv,
    rollbackRuntimeEnv: rollbackRuntimeEnv,
  };
  function applySetup(config) {
    var cfg = config || {};
    state.calls = [];
    state.envFile = clone(cfg.envFile || {});
    replaceMutable(runtimeEnv, cfg.runtimeEnv || {});
    state.vocab = clone(cfg.vocab || []);
    state.examples = clone(cfg.examples || []);
    state.corrections = clone(cfg.corrections || []);
    state.aux = Object.assign({ mode: 'text', text: 'aux text', message: 'aux failed', raw: null }, cfg.aux || {});
    state.flags = Object.assign({
      providerStatusThrows: false, installerStatusThrows: false, writeEnvThrows: false,
      asrApplyThrows: false, ttsApplyThrows: false, runtimeApplyThrows: false, voiceApplyThrows: false,
      asrRestoreThrows: false, ttsRestoreThrows: false, runtimeRestoreThrows: false, voiceRestoreThrows: false,
      startRejects: false, onQwenRejects: false, hotwordsRejectThrows: false, asrAvailable: true,
    }, cfg.flags || {});
    state.installerStatus = cfg.installerStatus === undefined ? { state: 'idle' } : clone(cfg.installerStatus);
    state.providerStatus = cfg.providerStatus === undefined ? { local: { available: true } } : clone(cfg.providerStatus);
    state.ttsStatus = cfg.ttsStatus === undefined ? { provider: 'edge', available: true } : clone(cfg.ttsStatus);
    state.qwenRuntime = cfg.qwenRuntime === undefined ? null : clone(cfg.qwenRuntime);
    state.hotwords = cfg.hotwords === undefined ? null : clone(cfg.hotwords);
    state.whisperPrompt = cfg.whisperPrompt || '';
    state.installerCancel = cfg.installerCancel === undefined ? true : cfg.installerCancel;
    replaceMutable(voice.cfg, cfg.voiceCfg || DEFAULT_VOICE);
    replaceMutable(asr.cfg, {});
    replaceMutable(tts.cfg, {});
    syncHotwords();
  }
  function snapshot() {
    return {
      envFile: clone(state.envFile),
      runtimeEnv: clone(runtimeEnv),
      vocab: clone(state.vocab),
      examples: clone(state.examples),
      calls: clone(state.calls),
      voiceCfg: clone(voice.cfg),
      asrCfg: clone(asr.cfg),
      ttsCfg: clone(tts.cfg),
    };
  }
  return { deps: deps, applySetup: applySetup, snapshot: snapshot };
})()`;

// The gateway's Node child: the real voice routes over the same fake world.
function upstream(repo) {
  return `'use strict';
const net = require('node:net'); const http = require('node:http'); const path = require('node:path');
const repo = ${JSON.stringify(repo)};
const express = require(require.resolve('express', { paths: [repo] }));
const { requestIdMiddleware, safeErrorHandler } = require(path.join(repo, 'src/http-errors'));
const { jsonCompression } = require(path.join(repo, 'src/http/json-compression'));
const { createAuthSecurity } = require(path.join(repo, 'src/auth-security'));
const { connectAuthControl } = require(path.join(repo, 'src/gateway-child'));
globalThis.__gatewayAuthSecurity = createAuthSecurity({ secret: process.env.ACCESS_TOKEN });
connectAuthControl(globalThis.__gatewayAuthSecurity);
process.stdin.on('end', () => process.exit(0)); process.stdin.resume();
const world = ${WORLD};
const app = express();
app.use(requestIdMiddleware, jsonCompression, express.json({ limit: '50mb' }));
const mounted = require(path.join(repo, 'src/routes/voice')).mountVoiceRoutes(app, world.deps);
app.get('/__state', (_q, r) => r.json({ state: world.snapshot(), consistency: mounted.getConsistency() }));
app.get('/__calls', (_q, r) => r.json({ calls: world.snapshot().calls }));
app.post('/__setup', (q, r) => { world.applySetup(q.body || {}); r.json({ ok: true }); });
app.get('/__consistency', (_q, r) => r.json(mounted.getConsistency()));
const quiet = { log() {}, warn() {}, info() {}, error() {} };
app.use(safeErrorHandler(quiet));
const server = http.createServer(app);
const listener = net.createServer({ pauseOnConnect: true }, socket => {
  socket.on('error', () => {}); let buffered = Buffer.alloc(0);
  const onData = chunk => {
    buffered = Buffer.concat([buffered, chunk]);
    const end = buffered.indexOf('\\r\\n');
    if (end < 0) return;
    socket.removeListener('data', onData); socket.pause();
    const rest = buffered.subarray(end + 2);
    if (rest.length) socket.unshift(rest);
    server.emit('connection', socket); socket.resume();
  };
  socket.on('data', onData); socket.resume();
});
listener.listen(Number(process.env.MULTICC_GATEWAY_INTERNAL_PORT), '127.0.0.1');`;
}

// ── branch coverage ───────────────────────────────────────────────────────
// Every route's reachable behavior. Each case declares what it exercises;
// finalize fails unless every listed branch was walked on both sides.
const BRANCHES = {
  refine: ['empty', 'success', 'examples', 'aux-empty', 'aux-undefined', 'aux-error', 'aux-cancelled',
    'aux-throws-value', 'trim-throw', 'long', 'options'],
  feedback: ['noop', 'applied', 'corrections', 'hotwords-enabled', 'hotwords-disabled', 'learn-throws',
    'nonstring-raw', 'strict-equality', 'options'],
  confirm: ['missing', 'feedback-only', 'success', 'fenced', 'greedy-merge', 'fallback', 'ok-override',
    'aux-error', 'aux-undefined', 'context', 'trim-throw', 'options'],
  progress: ['empty', 'not-array', 'events', 'mixed', 'long', 'emoji', 'slice-throw', 'null-event',
    'aux-error', 'aux-nonstring-text', 'aux-undefined', 'options'],
  vocab: ['list-empty', 'list-items', 'delete-basic', 'delete-case', 'delete-unicode', 'delete-encoded',
    'delete-bad-escape', 'options'],
  readiness: ['local', 'cloud-keys', 'cloud-streaming', 'missing', 'download-states', 'download-absent',
    'provider-throws', 'options'],
  hotwords: ['absent', 'present', 'snapshot-overrides', 'reject-accepted', 'reject-denied',
    'reject-absent', 'options'],
  'settings-get': ['defaults', 'env', 'runtime', 'fallback', 'masks', 'qwen', 'status-injection',
    'provider-throws', 'query', 'options'],
  'asr-model': ['download', 'cancel', 'unknown', 'string-action', 'start-rejects', 'status-throws', 'options'],
  'settings-post': ['full', 'masks', 'empty', 'array-body', 'transaction-success', 'persist-fail',
    'asr-fail', 'tts-fail', 'runtime-fail', 'voice-fail', 'rollback-fail', 'qwen-refresh',
    'qwen-refresh-reject', 'nonstring-500', 'status-code-400', 'write-then-get'],
  'test-sse': ['stream', 'head', 'abort', 'options'],
  stt: ['no-file', 'json-body', 'get', 'options'],
  host: ['examples', 'unknown'],
  generic: ['options-all', 'trailing', 'case', 'upper', 'repeated', 'method-mismatch', 'malformed-json',
    'strict-violation'],
};
const KNOWN_BRANCHES = new Set(Object.entries(BRANCHES).flatMap(([group, list]) => list.map(b => `${group}:${b}`)));
const hitBranches = new Set();
function markMany(list) {
  for (const branch of list) {
    if (!KNOWN_BRANCHES.has(branch)) throw new Error(`unknown coverage branch: ${branch}`);
    hitBranches.add(branch);
  }
}

let oracleWorld = null;

// ── request helpers ───────────────────────────────────────────────────────
const jsonHeaders = { Host: 'localhost', 'X-Request-Id': 'diff-voice-1', 'Content-Type': 'application/json' };
const plainHeaders = { Host: 'localhost', 'X-Request-Id': 'diff-voice-1' };

function request(method, url, body, headers = jsonHeaders) {
  const spec = { method, url, headers };
  if (body !== undefined) spec.body = typeof body === 'string' ? body : JSON.stringify(body);
  return spec;
}
const post = (url, body, headers = jsonHeaders) => request('POST', url, body, headers);

// ── the gateway's Node child is reset through the front door ──────────────
async function setupRust(port, config) {
  const answer = await send(port, post('/__setup', config || {}), 10_000);
  if (answer.status !== 200) {
    throw new Error(`/__setup answered ${answer.status}: ${answer.body.toString('utf8').slice(0, 200)}`);
  }
}

// ── documented differences ────────────────────────────────────────────────
// Express 4.22.2 leaves a rejected async handler's request unanswered.
function noAnswer(timeoutMs = 1500) {
  return {
    send: async (side, spec) => {
      if (side.name === 'rust') return send(side.port, spec);
      try {
        return await send(side.port, spec, timeoutMs);
      } catch (error) {
        if (!/no answer within|socket hang up|aborted|ECONNRESET/i.test(error.message)) throw error;
        return { status: 0, headers: {}, body: Buffer.from('<no answer>') };
      }
    },
    expectedDifference: {
      node: view => view.status === 0 && view.body === '<no answer>',
      rust: view => view.status === 500 && view.body.includes('"error":"internal_error"'),
    },
  };
}

// The retired settings POST threw with `statusCode`; safeErrorHandler reads
// `status`, so the old pipeline rendered 500 while Rust renders the intended
// 400 request_error.
const statusCodeAsOld500 = {
  expectedDifference: {
    node: view => view.status === 500 && view.body.includes('"error":"internal_error"'),
    rust: view => view.status === 400 && view.body.includes('"error":"request_error"'),
  },
};

// The front door claims only the exact-case `/api/` prefix.
function upperPrefix(nodeCheck) {
  return {
    expectedDifference: {
      node: view => view.status === 200 && nodeCheck(view) === true,
      rust: view => view.status === 404 && view.body.includes('<pre>Cannot '),
    },
  };
}

// The public port does not own /api/__host/voice: the front door forwards it
// and the local PROXY peer passes the host route's isLocalRequest gate, while
// the retired router had no such route.
const publicHostPort = {
  expectedDifference: {
    node: view => view.status === 404 && view.body.includes('<pre>Cannot POST /api/__host/voice</pre>'),
    rust: view => view.status === 200 && view.body.startsWith('{"ok":true'),
  },
};
const publicHostPortUnknown = {
  expectedDifference: {
    node: view => view.status === 404 && view.body.includes('<pre>Cannot POST /api/__host/voice</pre>'),
    rust: view => view.status === 400 && view.body.includes('"error":"unknown host operation"'),
  },
};

// A slice through a surrogate pair: the old pipeline emits a lone surrogate
// (JSON-escaped \\ud83d), Rust emits U+FFFD because JSON transport cannot
// carry the lone unit.
const surrogatePair = {
  expectedDifference: {
    node: view => view.body.includes('\\ud83d') && !view.body.includes('�'),
    rust: view => view.body.includes('�') && !view.body.includes('\\ud83d'),
  },
};

// ── streaming transports ──────────────────────────────────────────────────
function sseSend(records) {
  return (side, spec) => new Promise((resolve) => {
    const started = Date.now();
    const arrivals = [];
    const chunks = [];
    const req = http.request({ host: '127.0.0.1', port: side.port, method: spec.method, path: spec.url,
      headers: spec.headers, agent: false }, (res) => {
      res.on('data', (chunk) => { chunks.push(chunk); arrivals.push(Date.now() - started); });
      res.on('end', () => {
        records[side.name] = { arrivals };
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
      });
      res.on('error', error => resolve({ status: 0, headers: {}, body: Buffer.from(`stream error: ${error.message}`) }));
    });
    req.setTimeout(12_000, () => req.destroy(new Error('stream timeout')));
    req.on('error', error => resolve({ status: 0, headers: {}, body: Buffer.from(`stream error: ${error.message}`) }));
    req.end();
  });
}

function abortSend(records) {
  return (side, spec) => new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve({ status: 200, headers: {}, body: Buffer.from('<aborted after first chunk>') });
    };
    const req = http.request({ host: '127.0.0.1', port: side.port, method: spec.method, path: spec.url,
      headers: spec.headers, agent: false }, (res) => {
      res.once('data', (chunk) => {
        records[side.name] = { first: chunk.toString('utf8') };
        res.destroy();
        req.destroy();
        setTimeout(finish, 100);
      });
      res.on('end', () => { records[side.name] = { first: '<ended without data>' }; finish(); });
      res.on('error', () => setTimeout(finish, 100));
    });
    req.on('error', () => setTimeout(finish, 100));
    req.end();
  });
}

// ── normalization ─────────────────────────────────────────────────────────
// `ms` and host-recorded timestamps/reqIds are produced independently on each
// side. Each is asserted to have its real shape, then blanked; the ETag over
// the raw bytes and the content length go with them.
function normalizeView(view) {
  let body = view.body;
  let blankHeaders = body.includes('"requestId":"<rand>"');

  body = body.replace(/"ms":(\d+)/g, () => { blankHeaders = true; return '"ms":"<ms>"'; });
  body = body.replace(/"(vr|s2s_c|s2s_p|stt|aux)_\d+_[a-z0-9]{0,4}"/g, (match, kind) => {
    blankHeaders = true;
    return `"${kind}_<id>"`;
  });
  body = body.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, () => {
    blankHeaders = true;
    return '<iso>';
  });
  body = body.replace(/"lastFailureAt":\d+/g, () => {
    blankHeaders = true;
    return '"lastFailureAt":"<ts>"';
  });
  view.body = body;
  if (blankHeaders) {
    delete view.headers.etag;
    delete view.headers['content-length'];
  }
  return view;
}

// ── corpus ────────────────────────────────────────────────────────────────
function corpus(ctx) {
  const cases = [];
  const add = (name, spec, config, options = {}) => {
    const { branches = [], ...hooks } = options;
    cases.push([name, spec, {
      ...hooks,
      before: async (side) => {
        markMany(branches);
        const cfg = typeof config === 'function' ? config(side) : config;
        if (side.name === 'node') oracleWorld.applySetup(cfg || {});
        else await setupRust(side.port, cfg || {});
        if (hooks.before) await hooks.before(side);
      },
    }]);
  };
  // A follow-up request on the state the previous case left behind.
  const follow = (name, spec, options = {}) => {
    const { branches = [], ...hooks } = options;
    cases.push([name, spec, {
      ...hooks,
      before: async () => {
        markMany(branches);
        if (hooks.before) await hooks.before();
      },
    }]);
  };
  const peek = (name, options = {}) => follow(name, { method: 'GET', url: '/__state', headers: plainHeaders }, options);

  // ── refine ──────────────────────────────────────────────────────────────
  add('refine empty body', post('/api/voice/refine'), {}, { branches: ['refine:empty'] });
  peek('refine empty body state');
  add('refine empty object', post('/api/voice/refine', {}), {}, { branches: ['refine:empty'] });
  add('refine whitespace raw', post('/api/voice/refine', { raw: '  　 \n\t' }), {}, { branches: ['refine:empty'] });
  add('refine null raw', post('/api/voice/refine', { raw: null }), {}, { branches: ['refine:empty'] });
  add('refine zero raw', post('/api/voice/refine', { raw: 0 }), {}, { branches: ['refine:empty'] });
  add('refine success', post('/api/voice/refine', { raw: '帮我写个 useState 组件' }),
    { aux: { mode: 'text', text: ' 写一个 useState 组件 ' } }, { branches: ['refine:success'] });
  peek('refine success state');
  add('refine with examples', post('/api/voice/refine', { raw: '打开那个文件' }), {
    aux: { mode: 'text', text: '打开文件' },
    examples: [{ raw: '关掉窗口', userFinal: '关闭窗口' }, { raw: '跑一下测试' }],
  }, { branches: ['refine:examples'] });
  peek('refine with examples state');
  add('refine aux empty text', post('/api/voice/refine', { raw: 'x' }),
    { aux: { mode: 'empty' } }, { branches: ['refine:aux-empty'] });
  add('refine aux resolves undefined', post('/api/voice/refine', { raw: 'x' }),
    { aux: { mode: 'undefined' } }, { branches: ['refine:aux-undefined'] });
  add('refine aux error', post('/api/voice/refine', { raw: 'x' }),
    { aux: { mode: 'throw', message: 'boom' } }, { branches: ['refine:aux-error'] });
  add('refine aux non-string text', post('/api/voice/refine', { raw: 'x' }),
    { aux: { mode: 'text', text: 5 } }, { branches: ['refine:success'] });
  add('refine aux cancelled', post('/api/voice/refine', { raw: 'x' }),
    { aux: { mode: 'cancel' } }, { branches: ['refine:aux-cancelled'] });
  add('refine aux throws string', post('/api/voice/refine', { raw: 'x' }),
    { aux: { mode: 'raw', raw: 'oops' } }, { branches: ['refine:aux-throws-value'] });
  add('refine aux throws null', post('/api/voice/refine', { raw: 'x' }),
    { aux: { mode: 'raw', raw: null } }, { branches: ['refine:aux-throws-value'] });
  add('refine aux throws object', post('/api/voice/refine', { raw: 'x' }),
    { aux: { mode: 'raw', raw: { code: 7 } } }, { branches: ['refine:aux-throws-value'] });
  const longRaw = '长'.repeat(1200);
  add('refine long raw', post('/api/voice/refine', { raw: longRaw }),
    { aux: { mode: 'text', text: 'ok' } }, { branches: ['refine:long'] });
  add('refine number raw', post('/api/voice/refine', { raw: 5 }), {}, { branches: ['refine:trim-throw'], ...noAnswer() });
  add('refine boolean raw', post('/api/voice/refine', { raw: true }), {}, { branches: ['refine:trim-throw'], ...noAnswer() });
  add('refine array raw', post('/api/voice/refine', { raw: [1] }), {}, { branches: ['refine:trim-throw'], ...noAnswer() });
  add('refine object raw', post('/api/voice/refine', { raw: { a: 1 } }), {}, { branches: ['refine:trim-throw'], ...noAnswer() });

  // ── feedback ────────────────────────────────────────────────────────────
  add('feedback empty body', post('/api/voice/feedback'), {}, { branches: ['feedback:noop'] });
  peek('feedback empty body state');
  add('feedback missing pieces', post('/api/voice/feedback', { refined: 'a', userFinal: 'b' }),
    {}, { branches: ['feedback:noop'] });
  add('feedback equal values', post('/api/voice/feedback', { raw: 'x', refined: 'a', userFinal: 'a' }),
    {}, { branches: ['feedback:strict-equality'] });
  add('feedback zero equals zero', post('/api/voice/feedback', { raw: 'x', refined: 0, userFinal: 0 }),
    {}, { branches: ['feedback:strict-equality'] });
  add('feedback zero versus false', post('/api/voice/feedback', { raw: 'x', refined: 0, userFinal: false }),
    {}, { branches: ['feedback:applied'] });
  add('feedback applied', post('/api/voice/feedback', { raw: '多西', refined: 'doc', userFinal: 'docs' }),
    {}, { branches: ['feedback:applied'] });
  peek('feedback applied state');
  add('feedback corrections', post('/api/voice/feedback', { raw: '多西', refined: 'doc', userFinal: 'docs' }),
    { corrections: ['多西', '文档'] }, { branches: ['feedback:corrections'] });
  peek('feedback corrections state');
  add('feedback hotwords disabled', post('/api/voice/feedback', { raw: 'a', refined: 'b', userFinal: 'c' }),
    { hotwords: { enabled: false, snapshot: {} } }, { branches: ['feedback:hotwords-disabled'] });
  peek('feedback hotwords disabled state');
  add('feedback hotwords enabled', post('/api/voice/feedback', { raw: 'a', refined: 'b', userFinal: 'c' }),
    { hotwords: { enabled: true, snapshot: {} } }, { branches: ['feedback:hotwords-enabled'] });
  peek('feedback hotwords enabled state');
  add('feedback hotwords learn throws', post('/api/voice/feedback', { raw: 'a', refined: 'b', userFinal: 'c' }),
    { hotwords: { enabled: true, snapshot: {}, learnThrows: true } }, { branches: ['feedback:learn-throws'] });
  add('feedback non-string raw', post('/api/voice/feedback', { raw: 5, refined: 'a', userFinal: 'b' }),
    {}, { branches: ['feedback:nonstring-raw'] });
  peek('feedback non-string raw state');
  add('feedback body array', post('/api/voice/feedback', [1, 2]), {}, { branches: ['feedback:noop'] });

  // ── confirm ─────────────────────────────────────────────────────────────
  add('confirm missing', post('/api/voice/confirm', {}), {}, { branches: ['confirm:missing'] });
  add('confirm empty feedback', post('/api/voice/confirm', { text: '', userFeedback: '' }),
    {}, { branches: ['confirm:missing'] });
  add('confirm text null', post('/api/voice/confirm', { text: null }), {}, { branches: ['confirm:missing'] });
  add('confirm feedback only', post('/api/voice/confirm', { userFeedback: '改一下第二项' }),
    { aux: { mode: 'text', text: '{"summary":"s"}' } }, { branches: ['confirm:feedback-only'] });
  peek('confirm feedback only state');
  add('confirm success', post('/api/voice/confirm', { text: '做一个登录页' }), {
    aux: { mode: 'text', text: '{"summary":"做登录页","items":["页面","登录"],"questions":[],"allConfirmed":false}' },
  }, { branches: ['confirm:success'] });
  peek('confirm success state');
  add('confirm fenced json', post('/api/voice/confirm', { text: 'x' }), {
    aux: { mode: 'text', text: '```json\n{"summary":"围栏","items":[]}\n```' },
  }, { branches: ['confirm:fenced'] });
  add('confirm greedy merge fails', post('/api/voice/confirm', { text: 'x' }), {
    aux: { mode: 'text', text: '{"summary":"a"} 中间 {"summary":"b"}' },
  }, { branches: ['confirm:greedy-merge'] });
  peek('confirm greedy merge state');
  add('confirm no braces fallback', post('/api/voice/confirm', { text: 'x' }), {
    aux: { mode: 'text', text: '  纯文本回答  ' },
  }, { branches: ['confirm:fallback'] });
  add('confirm ok and ms override', post('/api/voice/confirm', { text: 'x' }), {
    aux: { mode: 'text', text: '{"ok":false,"ms":999,"extra":[1,2]}' },
  }, { branches: ['confirm:ok-override'] });
  add('confirm context prompt', post('/api/voice/confirm', {
    text: '再改一下', previousBreakdown: { summary: '原需求', items: ['一', '二'] }, userFeedback: { say: '第三项' },
  }), { aux: { mode: 'text', text: '{"summary":"改"}' } }, { branches: ['confirm:context'] });
  peek('confirm context state');
  add('confirm aux error', post('/api/voice/confirm', { text: 'x' }),
    { aux: { mode: 'throw', message: 'boom' } }, { branches: ['confirm:aux-error'] });
  add('confirm aux cancelled', post('/api/voice/confirm', { text: 'x' }),
    { aux: { mode: 'cancel' } }, { branches: ['confirm:aux-error'] });
  add('confirm aux undefined', post('/api/voice/confirm', { text: 'x' }),
    { aux: { mode: 'undefined' } }, { branches: ['confirm:aux-undefined'] });
  add('confirm aux non-string text', post('/api/voice/confirm', { text: 'x' }),
    { aux: { mode: 'text', text: 5 } }, { branches: ['confirm:aux-error'] });
  add('confirm number text', post('/api/voice/confirm', { text: 5, userFeedback: 'y' }),
    {}, { branches: ['confirm:trim-throw'], ...noAnswer() });

  // ── progress-summary ────────────────────────────────────────────────────
  add('progress missing events', post('/api/voice/progress-summary'), {}, { branches: ['progress:empty'] });
  peek('progress missing events state');
  add('progress events not array', post('/api/voice/progress-summary', { events: { a: 1 } }),
    {}, { branches: ['progress:not-array'] });
  add('progress empty array', post('/api/voice/progress-summary', { events: [] }),
    {}, { branches: ['progress:empty'] });
  add('progress events', post('/api/voice/progress-summary', {
    events: [{ type: 'tool', summary: '读取文件' }], taskDescription: '做登录页',
  }), { aux: { mode: 'text', text: '  正在读取文件  ' } }, { branches: ['progress:events'] });
  peek('progress events state');
  add('progress mixed events', post('/api/voice/progress-summary', {
    events: [{ summary: 's' }, { text: 't' }, { type: 5, summary: 'x' }, {}, true, 'str', [1, 2], { type: 'tool', summary: '' , text: 'fallback' }],
  }), { aux: { mode: 'text', text: 'ok' } }, { branches: ['progress:mixed'] });
  peek('progress mixed state');
  add('progress long summary', post('/api/voice/progress-summary', {
    events: [{ type: 'tool', summary: 'y'.repeat(400) }],
  }), { aux: { mode: 'text', text: 'ok' } }, { branches: ['progress:long'] });
  peek('progress long state');
  add('progress emoji boundary', post('/api/voice/progress-summary', {
    events: [{ type: 'tool', summary: 'x' + '😀'.repeat(200) }],
  }), { aux: { mode: 'text', text: 'ok' } }, { branches: ['progress:emoji'] });
  peek('progress emoji boundary state', { ...surrogatePair });
  add('progress number summary', post('/api/voice/progress-summary', { events: [{ summary: 5 }] }),
    {}, { branches: ['progress:slice-throw'], ...noAnswer() });
  add('progress null event', post('/api/voice/progress-summary', { events: [null] }),
    {}, { branches: ['progress:null-event'], ...noAnswer() });
  add('progress aux error', post('/api/voice/progress-summary', { events: [{ summary: 's' }] }),
    { aux: { mode: 'throw', message: 'boom' } }, { branches: ['progress:aux-error'] });
  add('progress aux cancelled', post('/api/voice/progress-summary', { events: [{ summary: 's' }] }),
    { aux: { mode: 'cancel' } }, { branches: ['progress:aux-error'] });
  add('progress aux non-string text', post('/api/voice/progress-summary', { events: [{ summary: 's' }] }),
    { aux: { mode: 'text', text: 5 } }, { branches: ['progress:aux-nonstring-text'] });
  add('progress aux undefined', post('/api/voice/progress-summary', { events: [{ summary: 's' }] }),
    { aux: { mode: 'undefined' } }, { branches: ['progress:aux-undefined'] });
  add('progress object task', post('/api/voice/progress-summary', {
    events: [{ summary: 's' }], taskDescription: { a: 1 },
  }), { aux: { mode: 'text', text: 'ok' } }, { branches: ['progress:events'] });
  peek('progress object task state');

  // ── vocab ───────────────────────────────────────────────────────────────
  add('vocab empty', request('GET', '/api/voice/vocab'), {}, { branches: ['vocab:list-empty'] });
  add('vocab items', request('GET', '/api/voice/vocab'), {
    vocab: [{ term: 'Git' }, { term: '多西' }],
  }, { branches: ['vocab:list-items'] });
  add('vocab head', request('HEAD', '/api/voice/vocab'), {
    vocab: [{ term: 'Git' }],
  }, { branches: ['vocab:list-items'] });
  add('vocab delete exact', request('DELETE', '/api/voice/vocab/GIT'), {
    vocab: [{ term: 'Git' }, { term: 'other' }],
  }, { branches: ['vocab:delete-basic'] });
  peek('vocab delete exact state');
  add('vocab delete case', request('DELETE', '/api/voice/vocab/gIt'), {
    vocab: [{ term: 'Git' }],
  }, { branches: ['vocab:delete-case'] });
  add('vocab delete unicode', request('DELETE', '/api/voice/vocab/%C3%84BC'), {
    vocab: [{ term: 'äbc' }, { term: 'ÄBC' }],
  }, { branches: ['vocab:delete-unicode'] });
  add('vocab delete dotted i', request('DELETE', '/api/voice/vocab/%C4%B0STANBUL'), {
    vocab: [{ term: 'i̇stanbul' }, { term: 'istanbul' }],
  }, { branches: ['vocab:delete-unicode'] });
  add('vocab delete final sigma', request('DELETE', '/api/voice/vocab/%CE%91%CE%A3'), {
    vocab: [{ term: 'ας' }, { term: 'ασ' }],
  }, { branches: ['vocab:delete-unicode'] });
  add('vocab delete encoded space', request('DELETE', '/api/voice/vocab/A%20B'), {
    vocab: [{ term: 'a b' }],
  }, { branches: ['vocab:delete-encoded'] });
  add('vocab delete plus', request('DELETE', '/api/voice/vocab/a%2Bb'), {
    vocab: [{ term: 'a+b' }],
  }, { branches: ['vocab:delete-encoded'] });
  add('vocab delete bad escape', request('DELETE', '/api/voice/vocab/bad%ZZ'), {
    vocab: [{ term: 'bad%zz' }],
  }, { branches: ['vocab:delete-bad-escape'] });

  // ── readiness ───────────────────────────────────────────────────────────
  add('readiness local', request('GET', '/api/voice/readiness'), {
    providerStatus: { local: { available: true } }, installerStatus: null,
  }, { branches: ['readiness:local'] });
  add('readiness local head', request('HEAD', '/api/voice/readiness'), {
    providerStatus: { local: { available: true } }, installerStatus: null,
  }, { branches: ['readiness:local'] });
  add('readiness cloud keys', request('GET', '/api/voice/readiness'), {
    flags: { asrAvailable: false }, voiceCfg: { WHISPER_API_KEY: 'wk' }, installerStatus: { state: 'missing' },
  }, { branches: ['readiness:cloud-keys'] });
  add('readiness cloud streaming', request('GET', '/api/voice/readiness'), {
    flags: { asrAvailable: false }, installerStatus: null,
    providerStatus: { local: { available: false }, openai: { ready: true } },
  }, { branches: ['readiness:cloud-streaming'] });
  add('readiness streaming not ready', request('GET', '/api/voice/readiness'), {
    flags: { asrAvailable: false }, installerStatus: null,
    providerStatus: { openai: { ready: false }, volcano: 'yes', funasr: null },
  }, { branches: ['readiness:missing'] });
  for (const state of ['downloading', 'failed', 'unsupported', 'disabled', 'weird']) {
    add(`readiness download ${state}`, request('GET', '/api/voice/readiness'), {
      flags: { asrAvailable: false }, installerStatus: { state, progress: 3 },
    }, { branches: ['readiness:download-states'] });
  }
  add('readiness download absent', request('GET', '/api/voice/readiness'), {
    flags: { asrAvailable: false }, installerStatus: undefined,
  }, { branches: ['readiness:download-absent'] });
  add('readiness provider throws', request('GET', '/api/voice/readiness'), {
    flags: { asrAvailable: false, providerStatusThrows: true }, installerStatus: { state: 'failed' },
  }, { branches: ['readiness:provider-throws'] });

  // ── hotwords ────────────────────────────────────────────────────────────
  add('hotwords absent', request('GET', '/api/voice/hotwords'), {}, { branches: ['hotwords:absent'] });
  add('hotwords present', request('GET', '/api/voice/hotwords'), {
    hotwords: { enabled: true, snapshot: { terms: ['多西'], pending: ['文档'], rejected: [] } },
  }, { branches: ['hotwords:present'] });
  add('hotwords head', request('HEAD', '/api/voice/hotwords'), {
    hotwords: { enabled: true, snapshot: { terms: [] } },
  }, { branches: ['hotwords:present'] });
  add('hotwords snapshot overrides', request('GET', '/api/voice/hotwords'), {
    hotwords: { enabled: true, snapshot: { enabled: false, terms: ['x'] } },
  }, { branches: ['hotwords:snapshot-overrides'] });
  add('hotwords disabled with snapshot', request('GET', '/api/voice/hotwords'), {
    hotwords: { enabled: false, snapshot: { terms: ['x'] } },
  }, { branches: ['hotwords:present'] });
  add('hotwords reject accepted', post('/api/voice/hotwords/reject', { term: '多西', alias: 'doc' }), {
    hotwords: { enabled: true, snapshot: {}, accept: true },
  }, { branches: ['hotwords:reject-accepted'] });
  peek('hotwords reject accepted state');
  add('hotwords reject denied', post('/api/voice/hotwords/reject', { term: '多西' }), {
    hotwords: { enabled: true, snapshot: {}, accept: false },
  }, { branches: ['hotwords:reject-denied'] });
  add('hotwords reject absent', post('/api/voice/hotwords/reject', { term: '多西' }),
    {}, { branches: ['hotwords:reject-absent'] });
  add('hotwords reject empty body', post('/api/voice/hotwords/reject'), {
    hotwords: { enabled: true, snapshot: {}, accept: true },
  }, { branches: ['hotwords:reject-accepted'] });
  add('hotwords reject array body', post('/api/voice/hotwords/reject', [{ term: 'x' }]), {
    hotwords: { enabled: true, snapshot: {}, accept: true },
  }, { branches: ['hotwords:reject-accepted'] });

  // ── settings GET ────────────────────────────────────────────────────────
  add('settings defaults', request('GET', '/api/settings/voice'), {}, { branches: ['settings-get:defaults'] });
  add('settings head', request('HEAD', '/api/settings/voice'), {}, { branches: ['settings-get:defaults'] });
  add('settings query', request('GET', '/api/settings/voice?tab=asr'), {}, { branches: ['settings-get:query'] });
  const envAll = {
    OPENROUTER_API_KEY: 'sk-1234567890abcdef', OPENROUTER_BASE_URL: 'https://env.example/v1',
    OPENROUTER_MODEL: 'env-model', WHISPER_API_KEY: 'wk-abcdefghijklmn', WHISPER_BASE_URL: 'https://w/v1',
    WHISPER_MODEL: 'large-v3', WHISPER_LANGUAGE: 'en', WHISPER_PROMPT: '提示',
    QWEN_AUDIO_DASHSCOPE_API_KEY: 'qwen-1234567890', ASR_PROVIDER: '', TTS_PROVIDER: 'openai',
    OPENAI_REALTIME_API_KEY: 'oai-realtime', VOLC_ASR_APP_ID: 'app', VOLC_ASR_ACCESS_TOKEN: 'tok',
    OPENAI_TTS_API_KEY: 'tts-key', VOLC_TTS_APP_ID: 'vapp', VOLC_TTS_TOKEN: 'vtok',
  };
  const runtimeAll = {
    OPENROUTER_MODEL: 'runtime-model', WHISPER_MODEL: 'runtime-whisper', ASR_PROVIDER: 'openai',
    DASHSCOPE_API_KEY: 'runtime-qwen-1234567890', OPENAI_API_KEY: 'runtime-openai',
    TTS_PROVIDER: 'edge', EDGE_TTS_VOICE: 'zh-CN-YunxiNeural', OPENAI_TTS_VOICE: 'nova',
    VOLC_TTS_VOICE: 'vv', VOLC_TTS_ACCESS_TOKEN: 'rtok',
  };
  add('settings env and runtime', request('GET', '/api/settings/voice'), {
    envFile: envAll, runtimeEnv: runtimeAll,
    providerStatus: { local: { available: false, model: 'sensevoice' } },
    installerStatus: { state: 'downloading', progress: 0.42 }, ttsStatus: { provider: 'openai', ready: true },
    qwenRuntime: { state: 'reconnecting', attempts: 2 },
  }, { branches: ['settings-get:env', 'settings-get:runtime', 'settings-get:masks', 'settings-get:qwen', 'settings-get:status-injection'] });
  add('settings empty env falls through', request('GET', '/api/settings/voice'), {
    envFile: { OPENROUTER_API_KEY: '', OPENROUTER_MODEL: '', ASR_PROVIDER: '', TTS_PROVIDER: '', QWEN_AUDIO_DASHSCOPE_API_KEY: '' },
    runtimeEnv: { OPENROUTER_MODEL: 'runtime-model', ASR_PROVIDER: 'volcano' },
  }, { branches: ['settings-get:fallback'] });
  add('settings short masks', request('GET', '/api/settings/voice'), {
    envFile: { OPENROUTER_API_KEY: 'abc', WHISPER_API_KEY: 'abcdefgh', QWEN_AUDIO_DASHSCOPE_API_KEY: 'qwen' },
  }, { branches: ['settings-get:masks'] });
  add('settings mask overlap', request('GET', '/api/settings/voice'), {
    envFile: { OPENROUTER_API_KEY: '12345678', WHISPER_API_KEY: '123456789', QWEN_AUDIO_DASHSCOPE_API_KEY: '1234567890' },
  }, { branches: ['settings-get:masks'] });
  add('settings mask emoji', request('GET', '/api/settings/voice'), {
    envFile: { OPENROUTER_API_KEY: '😀😀😀😀😀', QWEN_AUDIO_DASHSCOPE_API_KEY: '😀😀😀😀' },
  }, { branches: ['settings-get:masks'] });
  add('settings mask surrogate cut', request('GET', '/api/settings/voice'), {
    envFile: { OPENROUTER_API_KEY: 'a😀😀😀😀' },
  }, { branches: ['settings-get:masks'], ...surrogatePair });
  add('settings qwen runtime key fallback', request('GET', '/api/settings/voice'), {
    runtimeEnv: { DASHSCOPE_API_KEY: 'runtime-qwen' }, qwenRuntime: null,
  }, { branches: ['settings-get:qwen'] });
  add('settings provider throws', request('GET', '/api/settings/voice'), {
    flags: { providerStatusThrows: true },
  }, { branches: ['settings-get:provider-throws'] });
  add('settings null statuses', request('GET', '/api/settings/voice'), {
    providerStatus: null, ttsStatus: null, qwenRuntime: undefined,
  }, { branches: ['settings-get:status-injection'] });

  // ── asr-model ───────────────────────────────────────────────────────────
  add('asr-model download', post('/api/settings/voice/asr-model'), {}, { branches: ['asr-model:download'] });
  peek('asr-model download state');
  add('asr-model cancel', post('/api/settings/voice/asr-model', { action: 'cancel' }),
    { installerCancel: false, installerStatus: { state: 'cancelling' } }, { branches: ['asr-model:cancel'] });
  peek('asr-model cancel state');
  add('asr-model unknown', post('/api/settings/voice/asr-model', { action: 'explode' }),
    {}, { branches: ['asr-model:unknown'] });
  add('asr-model number action', post('/api/settings/voice/asr-model', { action: 5 }),
    {}, { branches: ['asr-model:string-action'] });
  add('asr-model true action', post('/api/settings/voice/asr-model', { action: true }),
    {}, { branches: ['asr-model:string-action'] });
  add('asr-model empty action', post('/api/settings/voice/asr-model', { action: '' }),
    {}, { branches: ['asr-model:download'] });
  add('asr-model null action', post('/api/settings/voice/asr-model', { action: null }),
    {}, { branches: ['asr-model:download'] });
  add('asr-model array body', post('/api/settings/voice/asr-model', ['cancel']),
    {}, { branches: ['asr-model:download'] });
  add('asr-model start rejects', post('/api/settings/voice/asr-model'),
    { flags: { startRejects: true }, installerStatus: { state: 'preparing' } }, { branches: ['asr-model:start-rejects'] });
  add('asr-model status throws', post('/api/settings/voice/asr-model'),
    { flags: { installerStatusThrows: true } }, { branches: ['asr-model:status-throws'] });

  // ── settings POST ───────────────────────────────────────────────────────
  const baseEnv = { OPENROUTER_MODEL: 'before', WHISPER_MODEL: 'before-whisper' };
  const baseRuntime = { OPENROUTER_MODEL: 'runtime-before' };
  const fullBody = {
    baseUrl: 'https://new.example/v1', apiKey: 'sk-live-key', model: 'new-model',
    whisperBaseUrl: 'https://w2/v1', whisperApiKey: 'wk-live', whisperModel: 'wm2',
    whisperLanguage: 'en', whisperPrompt: 'p2',
    asr: {
      provider: 'openai', openaiApiKey: 'oai-live', openaiUrl: 'wss://o', openaiModel: 'om',
      volcAppId: 'app2', volcAccessToken: 'tok2', volcResourceId: 'res2', volcUrl: 'wss://v',
      funasrUrl: 'ws://f', funasrMode: 'online',
    },
    tts: {
      provider: 'openai', edgeVoice: 'ev2', openaiApiKey: 'otk2', openaiUrl: 'wss://t',
      openaiModel: 'tm2', openaiVoice: 'voice2', volcanoAppId: 'vapp2', volcanoToken: 'vtok2',
      volcanoUrl: 'wss://vt', volcanoVoice: 'vv2',
    },
    qwenAudio: {
      apiKey: '  qwen-live  ', model: ' qwen-model ', voice: ' qwen-voice ',
      baseUrl: 'wss://dashscope.example.com/realtime??',
    },
    ignored: { no: 1 },
  };
  add('settings post full', post('/api/settings/voice', fullBody),
    { envFile: baseEnv, runtimeEnv: baseRuntime, hotwords: null },
    { branches: ['settings-post:full', 'settings-post:transaction-success'] });
  peek('settings post full state');
  follow('settings post full get', request('GET', '/api/settings/voice'),
    { branches: ['settings-post:write-then-get'] });
  add('settings post masks', post('/api/settings/voice', {
    apiKey: 'sk****', whisperApiKey: ['****'], model: 'm2',
    asr: { openaiApiKey: 'key****', volcAppId: '****' },
    tts: { openaiApiKey: '****', volcanoToken: '****' },
    qwenAudio: { apiKey: 'abc****def', clearApiKey: false },
  }), { envFile: baseEnv }, { branches: ['settings-post:masks'] });
  peek('settings post masks state');
  add('settings post empty', post('/api/settings/voice', {}),
    { envFile: baseEnv }, { branches: ['settings-post:empty'] });
  peek('settings post empty state');
  add('settings post array body', post('/api/settings/voice', [1]),
    { envFile: baseEnv }, { branches: ['settings-post:array-body'] });
  add('settings post array marker', post('/api/settings/voice', { apiKey: ['a', '****'] }),
    { envFile: baseEnv }, { branches: ['settings-post:masks'] });
  add('settings post clear qwen key', post('/api/settings/voice', {
    qwenAudio: { clearApiKey: true, apiKey: 'new-key' },
  }), { envFile: { QWEN_AUDIO_DASHSCOPE_API_KEY: 'old-key' } }, { branches: ['settings-post:full'] });
  peek('settings post clear qwen key state');
  add('settings post qwen refresh', post('/api/settings/voice', {
    qwenAudio: { model: 'qwen-2' },
  }), { envFile: baseEnv }, { branches: ['settings-post:qwen-refresh'] });
  peek('settings post qwen refresh state');
  add('settings post qwen refresh rejects', post('/api/settings/voice', {
    qwenAudio: { voice: 'v2' },
  }), { flags: { onQwenRejects: true } }, { branches: ['settings-post:qwen-refresh-reject'] });
  peek('settings post qwen refresh rejects state');

  // qwenAudio validation: the retired pipeline answered 500 (statusCode was
  // never read), Rust answers the intended 400.
  for (const [name, qwenAudio] of [
    ['apiKey number', { apiKey: 5 }],
    ['apiKey newline', { apiKey: 'a\nb' }],
    ['apiKey too long', { apiKey: 'x'.repeat(513) }],
    ['model number', { model: 1 }],
    ['model too long', { model: 'x'.repeat(161) }],
    ['voice too long', { voice: 'x'.repeat(81) }],
    ['baseUrl http', { baseUrl: 'http://localhost/x' }],
    ['baseUrl remote ws', { baseUrl: 'ws://example.com/x' }],
    ['baseUrl ftp', { baseUrl: 'ftp://localhost/' }],
    ['baseUrl empty', { baseUrl: '' }],
    ['baseUrl garbage', { baseUrl: 'not a url' }],
    ['baseUrl port', { baseUrl: 'ws://127.0.0.1:99999/x' }],
    ['baseUrl control', { baseUrl: 'wss://h/\n' }],
  ]) {
    add(`settings post qwen ${name}`, post('/api/settings/voice', { qwenAudio }),
      { envFile: baseEnv }, { branches: ['settings-post:status-code-400'], ...statusCodeAsOld500 });
  }
  add('settings post qwen loopback ws', post('/api/settings/voice', {
    qwenAudio: { baseUrl: 'ws://127.0.0.1:8765/x' },
  }), { envFile: baseEnv }, { branches: ['settings-post:full'] });
  add('settings post qwen localhost wss', post('/api/settings/voice', {
    qwenAudio: { baseUrl: 'wss://localhost/x' },
  }), { envFile: baseEnv }, { branches: ['settings-post:full'] });
  add('settings post qwen object non-object', post('/api/settings/voice', {
    qwenAudio: 5, asr: null, tts: 7,
  }), { envFile: baseEnv }, { branches: ['settings-post:empty'] });
  add('settings post qwen query strip', post('/api/settings/voice', {
    qwenAudio: { baseUrl: 'wss://h/p?x=1???' },
  }), { envFile: baseEnv }, { branches: ['settings-post:full'] });
  peek('settings post qwen query strip state');
  add('settings post non-string apiKey', post('/api/settings/voice', { apiKey: 5 }),
    { envFile: baseEnv }, { branches: ['settings-post:nonstring-500'] });
  add('settings post null whisper key', post('/api/settings/voice', { whisperApiKey: null }),
    { envFile: baseEnv }, { branches: ['settings-post:nonstring-500'] });
  add('settings post non-string section values', post('/api/settings/voice', {
    asr: { provider: 5, volcAppId: ['x'] }, tts: { edgeVoice: 7 },
  }), { envFile: baseEnv }, { branches: ['settings-post:full'] });
  peek('settings post non-string section values state');

  const fail = (stage) => {
    const flags = {};
    if (stage === 'persist') flags.writeEnvThrows = true;
    else flags[`${stage}ApplyThrows`] = true;
    return flags;
  };
  for (const stage of ['persist', 'asr', 'tts', 'runtime', 'voice']) {
    add(`settings post ${stage} failure`, post('/api/settings/voice', { model: 'never' }),
      { envFile: baseEnv, runtimeEnv: baseRuntime, flags: fail(stage) },
      { branches: [`settings-post:${stage === 'persist' ? 'persist-fail' : `${stage}-fail`}`] });
    peek(`settings post ${stage} failure state`);
  }
  add('settings post rollback failure', post('/api/settings/voice', { model: 'never' }), {
    envFile: baseEnv, runtimeEnv: baseRuntime,
    flags: { voiceApplyThrows: true, voiceRestoreThrows: true },
  }, { branches: ['settings-post:rollback-fail'] });
  follow('settings post rollback failure consistency',
    { method: 'GET', url: '/__consistency', headers: plainHeaders },
    { branches: ['settings-post:rollback-fail'] });
  add('settings post rollback resets', post('/api/settings/voice', { model: 'after' }),
    { envFile: baseEnv }, { branches: ['settings-post:transaction-success'] });
  follow('settings post rollback reset consistency',
    { method: 'GET', url: '/__consistency', headers: plainHeaders },
    { branches: ['settings-post:transaction-success'] });

  // ── test-sse ────────────────────────────────────────────────────────────
  const sseRecords = {};
  add('test-sse stream', request('GET', '/api/voice/test-sse'),
    {}, { branches: ['test-sse:stream'], send: sseSend(sseRecords) });
  add('test-sse head', request('HEAD', '/api/voice/test-sse'), {}, { branches: ['test-sse:head'] });
  const abortRecords = {};
  add('test-sse abort', request('GET', '/api/voice/test-sse'),
    {}, { branches: ['test-sse:abort'], send: abortSend(abortRecords) });
  follow('test-sse abort liveness', request('GET', '/api/voice/vocab'), { branches: [] });

  // ── stt stays in Node and is forwarded ──────────────────────────────────
  add('stt no body', post('/api/voice/stt'), {}, { branches: ['stt:no-file'] });
  add('stt json body', post('/api/voice/stt', {}), {}, { branches: ['stt:json-body'] });
  add('stt get', request('GET', '/api/voice/stt'), {}, { branches: ['stt:get'] });
  add('stt options', request('OPTIONS', '/api/voice/stt'), {}, { branches: ['stt:options'] });

  // ── the host port on the public port ────────────────────────────────────
  add('host port examples public', post('/api/__host/voice', { op: 'examples' }),
    { examples: [{ raw: 'a', userFinal: 'b' }] }, { branches: ['host:examples'], ...publicHostPort });
  add('host port unknown public', post('/api/__host/voice', { op: 'nope' }),
    {}, { branches: ['host:unknown'], ...publicHostPortUnknown });

  // ── generic matching: OPTIONS, trailing slash, case, repeated slashes ───
  const ROUTES = [
    { key: 'refine', group: 'refine', path: '/api/voice/refine', methods: ['POST'], allow: 'POST' },
    { key: 'feedback', group: 'feedback', path: '/api/voice/feedback', methods: ['POST'], allow: 'POST' },
    { key: 'confirm', group: 'confirm', path: '/api/voice/confirm', methods: ['POST'], allow: 'POST' },
    { key: 'progress-summary', group: 'progress', path: '/api/voice/progress-summary', methods: ['POST'], allow: 'POST' },
    { key: 'vocab', group: 'vocab', path: '/api/voice/vocab', methods: ['GET', 'HEAD'], allow: 'GET,HEAD' },
    { key: 'readiness', group: 'readiness', path: '/api/voice/readiness', methods: ['GET', 'HEAD'], allow: 'GET,HEAD' },
    { key: 'hotwords', group: 'hotwords', path: '/api/voice/hotwords', methods: ['GET', 'HEAD'], allow: 'GET,HEAD' },
    { key: 'hotwords-reject', group: null, path: '/api/voice/hotwords/reject', methods: ['POST'], allow: 'POST' },
    { key: 'vocab-delete', group: null, path: '/api/voice/vocab/x', methods: ['DELETE'], allow: 'DELETE' },
    { key: 'settings', group: 'settings-get', path: '/api/settings/voice', methods: ['GET', 'HEAD', 'POST'], allow: 'GET,HEAD,POST' },
    { key: 'asr-model', group: 'asr-model', path: '/api/settings/voice/asr-model', methods: ['POST'], allow: 'POST' },
    { key: 'test-sse', group: 'test-sse', path: '/api/voice/test-sse', methods: ['GET', 'HEAD'], allow: 'GET,HEAD' },
  ];
  for (const route of ROUTES) {
    const options = { branches: ['generic:options-all', ...(route.group ? [`${route.group}:options`] : [])] };
    add(`${route.key} OPTIONS`, request('OPTIONS', route.path), {}, options);
    add(`${route.key} OPTIONS trailing`, request('OPTIONS', `${route.path}/`), {}, options);
    const slashMethod = route.methods.includes('POST') ? 'POST' : 'GET';
    add(`${route.key} trailing slash`, request(slashMethod, `${route.path}/`, slashMethod === 'POST' ? {} : undefined),
      {}, { branches: ['generic:trailing'] });
    if (route.key !== 'test-sse' && route.key !== 'stt') {
      add(`${route.key} mixed case`, request(route.methods[0] === 'DELETE' ? 'DELETE' : 'GET',
        route.path.replace('/api/', '/api/').split('/').map((part, index) => (
          index < 2 ? part : part.toUpperCase())).join('/')),
      {}, { branches: ['generic:case'] });
    }
    for (const method of ['PUT', 'PATCH'].filter(m => !route.methods.includes(m))) {
      add(`${route.key} ${method}`, request(method, route.path, {}), {}, { branches: ['generic:method-mismatch'] });
    }
  }
  add('refine GET unclaimed', request('GET', '/api/voice/refine'), {}, { branches: ['generic:method-mismatch'] });
  add('vocab DELETE collection', request('DELETE', '/api/voice/vocab'), {}, { branches: ['generic:method-mismatch'] });
  add('settings GET asr-model', request('GET', '/api/settings/voice/asr-model'), {}, { branches: ['generic:method-mismatch'] });
  add('repeated slash prefix', request('GET', '/api//voice/vocab'), {}, { branches: ['generic:repeated'] });
  add('repeated slash middle', request('GET', '/api/voice//vocab'), {}, { branches: ['generic:repeated'] });
  add('voice root', request('GET', '/api/voice'), {}, { branches: ['generic:repeated'] });
  add('voice root slash', request('GET', '/api/voice/'), {}, { branches: ['generic:repeated'] });
  add('upper prefix vocab', request('GET', '/API/voice/vocab'), {
    vocab: [{ term: 'x' }],
  }, { branches: ['generic:upper'], ...upperPrefix(view => view.body.startsWith('[{')) });
  add('upper prefix readiness', request('GET', '/API/voice/readiness'), {
    installerStatus: null,
  }, { branches: ['generic:upper'], ...upperPrefix(view => view.body.includes('"ready":true')) });
  add('upper prefix settings', request('GET', '/API/settings/voice'), {},
    { branches: ['generic:upper'], ...upperPrefix(view => view.body.includes('"qwenAudio":')) });
  add('malformed json refine', post('/api/voice/refine', '{'), {}, { branches: ['generic:malformed-json'] });
  add('malformed json settings', post('/api/settings/voice', '{'), {}, { branches: ['generic:malformed-json'] });
  add('malformed json feedback', post('/api/voice/feedback', '{"raw":'), {}, { branches: ['generic:malformed-json'] });
  add('strict violation refine', post('/api/voice/refine', '"text"'), {}, { branches: ['generic:strict-violation'] });
  add('strict violation settings', post('/api/settings/voice', '5'), {}, { branches: ['generic:strict-violation'] });

  // Exposed to finalize through the closure below.
  corpus.state = { sseRecords, abortRecords, expectedAllow: Object.fromEntries(ROUTES.map(r => [r.path, r.allow])) };
  return cases;
}

// ── run ───────────────────────────────────────────────────────────────────
function main() {
  let upstreamText = '';
  return run({
    name: 'voice-routes',
    mount(app, { repo }) {
      oracleWorld = eval(WORLD); // eslint-disable-line no-eval -- the same literal the child evaluates
      const legacy = require(path.join(repo, 'tests/helpers/legacy-voice-routes'));
      const mounted = legacy.mountVoiceRoutes(app, oracleWorld.deps);
      app.get('/__state', (_q, r) => r.json({ state: oracleWorld.snapshot(), consistency: mounted.getConsistency() }));
      app.get('/__calls', (_q, r) => r.json({ calls: oracleWorld.snapshot().calls }));
      app.get('/__consistency', (_q, r) => r.json(mounted.getConsistency()));
      upstreamText = upstream(repo);
    },
    get upstream() { return upstreamText; },
    gatewayEnv: () => ({ MULTICC_RUST_ADDON: process.env.MULTICC_RUST_ADDON }),
    normalizeView,
    corpus,
    finalize({ views }) {
      const missing = [...KNOWN_BRANCHES].filter(branch => !hitBranches.has(branch)).sort();
      const state = corpus.state || {};
      const problems = [];

      // The test stream must really have ticked: four frames (or three when
      // the last chunk and [DONE] coalesce), first at ~500ms, gaps ~500ms.
      for (const side of ['node', 'rust']) {
        const record = state.sseRecords && state.sseRecords[side];
        if (!record || record.arrivals.length < 3) {
          problems.push(`${side} test-sse arrivals: ${JSON.stringify(record && record.arrivals)}`);
          continue;
        }
        const arrivals = record.arrivals;
        if (arrivals[0] < 400 || arrivals[0] > 800) problems.push(`${side} first SSE frame at ${arrivals[0]}ms`);
        for (let i = 1; i < arrivals.length; i++) {
          const gap = arrivals[i] - arrivals[i - 1];
          if (gap > 90 && (gap < 400 || gap > 800)) problems.push(`${side} SSE gap ${gap}ms`);
        }
        if (arrivals[arrivals.length - 1] - arrivals[0] < 800) problems.push(`${side} SSE completed too fast`);
      }
      // The mid-stream disconnect must have delivered a real frame on both
      // sides, and the next request still has to answer.
      for (const side of ['node', 'rust']) {
        const record = state.abortRecords && state.abortRecords[side];
        if (!record || !/^data: /.test(record.first || '')) {
          problems.push(`${side} abort first frame: ${JSON.stringify(record)}`);
        }
      }
      // Every OPTIONS answer carries the Express-derived Allow list.
      for (const view of views) {
        if (!/ OPTIONS( trailing)?$/.test(view.name)) continue;
        for (const side of [view.node, view.rust]) {
          if (!side.headers.allow) problems.push(`${view.name} missing Allow`);
        }
      }
      // Bodies that are "same" only because both sides said "not found" prove
      // nothing: pin the important success shapes.
      const seen = {};
      const note = (key) => { seen[key] = (seen[key] || 0) + 1; };
      for (const view of views) {
        for (const side of [view.node, view.rust]) {
          if (view.name === 'refine success' && side.body.includes('"text":" 写一个 useState 组件 "')) note('refine success text');
          if (view.name === 'vocab items' && side.status === 200 && side.body.includes('"term":"Git"')) note('vocab list');
          if (view.name === 'settings defaults' && side.status === 200 && side.body.includes('"hasKey":false')) note('settings defaults');
          if (view.name === 'test-sse stream' && side.body.endsWith('data: [DONE]\n\n')) note('sse done frame');
          if (view.name === 'settings post full' && side.status === 200 && side.body === '{"ok":true}') note('settings applied');
          if (view.name === 'settings post rollback failure consistency' && side.body.includes('"reason":"voice_restore"')) note('consistency degraded');
          if (view.name === 'stt no body' && side.status === 400 && side.body.includes('未收到音频文件')) note('stt no file');
        }
      }
      for (const key of ['refine success text', 'vocab list', 'settings defaults', 'sse done frame',
        'settings applied', 'consistency degraded', 'stt no file']) {
        if (!seen[key]) problems.push(`missing evidence: ${key}`);
      }
      const ok = missing.length === 0 && problems.length === 0;
      // Cases per route, so the report can cite the real distribution.
      const group = (name) => {
        if (name.includes('${route.key}')) return 'generic matching';
        if (/^refine /.test(name)) return 'refine';
        if (/^feedback /.test(name)) return 'feedback';
        if (/^confirm /.test(name)) return 'confirm';
        if (/^progress /.test(name)) return 'progress-summary';
        if (/^vocab /.test(name)) return 'vocab';
        if (/^readiness /.test(name)) return 'readiness';
        if (/^hotwords /.test(name)) return 'hotwords';
        if (/^settings post /.test(name)) return 'settings POST';
        if (/^settings /.test(name)) return 'settings GET';
        if (/^asr-model /.test(name)) return 'asr-model';
        if (/^test-sse /.test(name)) return 'test-sse';
        if (/^stt /.test(name)) return 'stt (stays in Node)';
        if (/^host port /.test(name)) return 'public /api/__host/voice';
        return 'generic matching';
      };
      const groups = {};
      for (const view of views) groups[group(view.name)] = (groups[group(view.name)] || 0) + 1;
      return { ok, details: { cases: views.length, groups, branches: KNOWN_BRANCHES.size, walked: hitBranches.size, missing, problems, seen, sse: state.sseRecords, abort: state.abortRecords } };
    },
  });
}

main().then((ok) => { process.exitCode = ok ? 0 : 1; }, (error) => {
  console.error(error);
  process.exitCode = 1;
});
