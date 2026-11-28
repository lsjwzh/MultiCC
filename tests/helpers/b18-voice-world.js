'use strict';
// Test-only IO worlds. Each side has separate state; the old side is pinned bytes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const zlib = require('node:zlib');
const manifest = require('./frozen-b18-voice/manifest.json');
const tick = () => new Promise(resolve => setImmediate(resolve));
function normalize(value) {
  if (Buffer.isBuffer(value)) {
    if (value[0] === 0x11 && value.length >= 8) {
      const hasSeq = (value[1] & 1) !== 0;
      const offset = hasSeq ? 8 : 4;
      return { header: Array.from(value.subarray(0, offset)), payload: Array.from(zlib.gunzipSync(value.subarray(offset + 4))) };
    }
    return { binary: Array.from(value) };
  }
  if (ArrayBuffer.isView(value)) return Array.from(value);
  if (Array.isArray(value)) return Array.from(value, normalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).map(k => [k, normalize(value[k])]));
  return value;
}
function world(options = {}) {
  const calls = [], sockets = [], children = [], requests = [], timers = [], microtasks = [];
  let now = 100000;
  const env = { ...options.env };
  const console = { log: (...args) => calls.push(['log', ...args]), error: (...args) => calls.push(['error', ...args]) };
  class Socket extends EventEmitter {
    static OPEN = 1;
    constructor(url, opts) { super(); this.readyState = 1; this.url = url; this.options = opts; this.sent = []; sockets.push(this); calls.push(['ws', url, normalize(opts)]); }
    send(value) { this.sent.push(normalize(value)); }
    close() { this.readyState = 3; calls.push(['ws.close', this.url]); this.emit('close'); }
  }
  function spawn(command, args, opts) {
    calls.push(['spawn', command, normalize(args), normalize(opts)]);
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
    child.stdin.end = value => calls.push(['stdin', normalize(value)]);
    child.kill = signal => calls.push(['kill', signal]); children.push(child); return child;
  }
  const ports = {
    env, console, WebSocket: Socket, outboundAgent: { name: 'test-agent' }, spawn,
    now: () => now,
    setTimeout(fn, ms) { const timer = { fn, ms, cancelled: false, unref() { calls.push(['unref', ms]); } }; timers.push(timer); calls.push(['timer', ms]); return timer; },
    clearTimeout(timer) { timer.cancelled = true; calls.push(['clear', timer.ms]); },
    queueMicrotask(fn) { microtasks.push(fn); },
    getChildProxyEnv: options.getChildProxyEnv || (async () => ({ https_proxy: 'http://proxy.test:8080' })),
    policy: { proxyForUrl: options.proxyForUrl || (async () => 'http://proxy.test:8080') },
    https: { request(opts, callback) {
      calls.push(['https', normalize(opts)]); const req = new EventEmitter();
      req.write = value => calls.push(['request.write', value]); req.end = () => calls.push(['request.end']);
      requests.push({ req, callback }); return req;
    } },
    fs: { existsSync: filename => { calls.push(['exists', filename]); return !options.noModels; } },
    path, homedir: () => '/test-home',
    voiceConfig: () => ({
      loadWhisperVocab() { calls.push(['vocab']); return [{ term: 'multicc' }, { term: 'worktree' }]; },
      hotwordList() { calls.push(['hotwords']); return 'test-hotwords'; },
    }),
    correctWithHotwords(text, list) { calls.push(['correct', text, list]); return text; },
  };
  class OfflineRecognizer {
    constructor(config) { calls.push(['recognizer', normalize(config)]); }
    createStream() { return { acceptWaveform({ sampleRate, samples }) { calls.push(['wave', sampleRate, samples.length, ...Array.from(samples).slice(0, 6)]); } }; }
    decode() { calls.push(['decode']); }
    getResult() { return { text: '  multi cc  ' }; }
  }
  class Vad {
    constructor(config, seconds) { calls.push(['vad', normalize(config), seconds]); if (options.noVad) throw Error('VAD unavailable'); this.segments = []; }
    acceptWaveform(samples) { calls.push(['vad.wave', samples.length, samples[0], samples.at(-1)]); }
    isEmpty() { return !this.segments.length; }
    front() { return this.segments[0]; }
    pop() { this.segments.shift(); }
    flush() { calls.push(['vad.flush']); if (options.vadSegment) this.segments.push({ start: 0, samples: new Float32Array(512) }); }
  }
  ports.loadSherpa = () => { calls.push(['sherpa']); if (options.noAddon) throw Error('addon unavailable'); return { OfflineRecognizer, Vad }; };
  ports.asrLocal = {
    isAvailable: () => false,
    status: () => ({ ready: false, model: 'fake', loaded: false, sampleRate: 16000 }),
    createStreamingSession(opts, cb) {
      calls.push(['local', normalize(opts)]);
      microtasks.push(cb.onReady);
      return { pushAudio(audio) { calls.push(['local.audio', Array.from(audio)]); if (options.audioError) throw Error('bad audio'); }, finish() { cb.onFinal('local'); cb.onDone(); }, close() { calls.push(['local.close']); } };
    },
  };
  const peer = () => { const ws = new EventEmitter(); ws.readyState = 1; ws.messages = []; ws.send = value => ws.messages.push(Buffer.isBuffer(value) ? normalize(value) : JSON.parse(value)); return ws; };
  return { ports, calls, sockets, children, requests, timers, peer,
    advance(ms) { now += ms; },
    flushMicrotasks() { for (const fn of microtasks.splice(0)) fn(); },
    fireTimers(ms) { for (const t of timers.splice(0)) if (!t.cancelled && t.ms === ms) t.fn(); },
    transcript() { return normalize({ calls, sends: sockets.map(s => s.sent) }); },
  };
}
function legacy(name, w) {
  const filename = path.join(__dirname, 'frozen-b18-voice', name + '.cjs');
  const bytes = fs.readFileSync(filename);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), manifest[name + '.cjs'].sha256);
  const ports = w.ports;
  class Clock extends Date { static now() { return ports.now(); } }
  const module = { exports: {} };
  const native = { outbound: { outboundAgent: ports.outboundAgent, getChildProxyEnv: ports.getChildProxyEnv, policy: ports.policy },
    voiceCorrector: { correctWithHotwords: ports.correctWithHotwords }, get voiceConfig() { return ports.voiceConfig(); } };
  const sandbox = {
    module, exports: module.exports, Buffer, Date: Clock, URL, Float32Array, Int16Array, Uint8Array,
    process: { env: ports.env }, console: ports.console,
    setTimeout: ports.setTimeout, clearTimeout: ports.clearTimeout, queueMicrotask: ports.queueMicrotask,
    require(id) {
      if (id === 'ws') return ports.WebSocket;
      if (id === 'zlib') return zlib;
      if (id === 'fs') return ports.fs;
      if (id === 'os') return { homedir: ports.homedir };
      if (id === 'path') return ports.path;
      if (id === 'child_process') return { spawn: ports.spawn };
      if (id === 'https') return ports.https;
      if (id === 'sherpa-onnx-node') return ports.loadSherpa();
      if (id.endsWith('/asr-local')) return ports.asrLocal;
      if (id.endsWith('/native/binding')) return native;
      throw Error('unmapped frozen dependency: ' + id);
    },
  };
  vm.runInNewContext(bytes.toString(), sandbox, { filename });
  return module.exports;
}
function current(name, w) {
  const native = require('../../src/native/binding').getNative();
  return native[{ 'voice-asr': 'voiceAsrApi', 'asr-local': 'asrLocalApi', 'tts-service': 'ttsServiceApi' }[name]](w.ports);
}
async function differential(name, scenario, options = {}) {
  const oldWorld = world(options), rustWorld = world(options);
  const oldApi = legacy(name, oldWorld), rustApi = current(name, rustWorld);
  assert.deepEqual(Object.keys(rustApi), Object.keys(oldApi), name + ' export order');
  assert.deepEqual(normalize(rustApi.cfg), normalize(oldApi.cfg), name + ' initial config');
  const expected = await scenario(oldApi, oldWorld);
  const actual = await scenario(rustApi, rustWorld);
  assert.deepEqual(normalize(actual), normalize(expected), name + ' returned data');
  assert.deepEqual(rustWorld.transcript(), oldWorld.transcript(), name + ' IO/callback ordering');
}
function response(text, seq = -1) {
  const payload = zlib.gzipSync(Buffer.from(JSON.stringify({ result: { text } })));
  const header = Buffer.alloc(12); header.set([0x11, 0x91, 0x11, 0]); header.writeInt32BE(seq, 4); header.writeUInt32BE(payload.length, 8);
  return Buffer.concat([header, payload]);
}
module.exports = { world, legacy, current, differential, normalize, response, tick };
