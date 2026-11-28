'use strict';
// "Can voice input work, and if not what should the user do" (Rust voice readiness)
// plus the streaming path's matching voice_not_ready frame (native/addon/src/voice_asr.rs).
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { voiceReadiness } = require('../src/routes/voice');
const { voiceReadiness: baselineReadiness } = require('./helpers/legacy-voice-readiness');

const installer = state => ({ status: () => ({ state, percent: 12, totalBytes: 100 }) });
const noLocal = { isAvailable: () => false };

test('reason mirrors the local model install state when nothing can recognise speech', () => {
  for (const state of ['missing', 'downloading', 'failed', 'unsupported', 'disabled']) {
    const r = voiceReadiness({ asrLocal: noLocal, installer: installer(state), voiceCfg: {} });
    assert.equal(r.ready, false);
    assert.equal(r.reason, state);
    assert.equal(r.download.state, state);
  }
  // An unknown installer state still offers the download, never a dead end.
  assert.equal(voiceReadiness({ asrLocal: noLocal, installer: installer('weird'), voiceCfg: {} }).reason, 'missing');
  assert.equal(voiceReadiness({ asrLocal: noLocal, voiceCfg: {} }).reason, 'missing');
});

test('local beats cloud; any cloud credential is enough; a throwing status probe is ignored', () => {
  assert.equal(voiceReadiness({ asrLocal: { isAvailable: () => true }, installer: installer('ready'), voiceCfg: { WHISPER_API_KEY: 'k' } }).engine, 'local');
  assert.equal(voiceReadiness({ asrLocal: noLocal, installer: installer('missing'), voiceCfg: { WHISPER_API_KEY: 'k' } }).engine, 'cloud');
  assert.equal(voiceReadiness({ asrLocal: noLocal, installer: installer('missing'), voiceCfg: {}, streamingStatus: () => ({ funasr: { ready: true } }) }).engine, 'cloud');
  const r = voiceReadiness({ asrLocal: noLocal, installer: installer('downloading'), voiceCfg: {}, streamingStatus: () => { throw new Error('x'); } });
  assert.equal(r.ready, false);
  assert.equal(r.reason, 'downloading');
});

test('streaming: with nothing configured the socket says voice_not_ready, not "OpenAI key missing"', () => {
  const asr = require('../src/native/binding').voiceAsr;
  const asrLocal = require('../src/native/binding').asrLocal;
  const saved = JSON.parse(JSON.stringify(asr.cfg));
  const savedAvailable = asrLocal.isAvailable;
  asrLocal.isAvailable = () => false; // this machine may well have the model
  try {
    asr.applyConfig({ defaultProvider: 'auto', openaiApiKey: '', volcAppId: '', volcAccessToken: '', funasrUrl: '' });
    for (const k of ['openai', 'volcano', 'funasr']) {
      for (const f of ['apiKey', 'appId', 'accessToken', 'url']) if (f in asr.cfg[k]) asr.cfg[k][f] = '';
    }
    const ws = new EventEmitter();
    const sent = [];
    ws.send = data => sent.push(JSON.parse(data));
    asr.handleVoiceWs(ws, {}, new URL('http://x/ws/voice'));
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'start', provider: 'auto', lang: 'zh' })), false);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'error');
    assert.equal(sent[0].code, 'voice_not_ready');
    assert.equal(asr.providerStatus().default, 'none');
  } finally {
    asrLocal.isAvailable = savedAvailable;
    Object.assign(asr.cfg, saved);
  }
});

test('the STT readiness result and probe order match the frozen host for the same inputs', () => {
  const states = [undefined, null, {}, ...['missing', 'downloading', 'failed', 'unsupported', 'disabled', 'ready', 'unknown'].map(state => ({ state, percent: 37 }))];
  const clouds = [
    {}, { voiceCfg: { WHISPER_API_KEY: true } }, { voiceCfg: { OPENROUTER_API_KEY: true } },
    { streaming: { openai: { ready: 1 } } }, { streaming: { volcano: { ready: 'yes' } } },
    { streaming: { funasr: { ready: [] } } }, { streaming: { default: { ready: true } } },
    { streaming: { openai: { ready: 0 }, volcano: null } }, { throws: true },
  ];
  let compared = 0;
  for (const download of states) {
    for (const available of [0, true]) {
      for (const cloud of clouds) {
        const calls = [];
        const args = {
          installer: { status() { calls.push('installer'); return download; } },
          asrLocal: { isAvailable() { calls.push('local'); return available; } },
          voiceCfg: cloud.voiceCfg,
          streamingStatus() {
            calls.push('stream');
            if (cloud.throws) throw new Error('stream unavailable');
            return cloud.streaming;
          },
        };
        const expected = baselineReadiness(args);
        const expectedCalls = calls.splice(0);
        const actual = voiceReadiness(args);
        assert.deepStrictEqual(actual, expected);
        assert.deepStrictEqual(Object.keys(actual), Object.keys(expected));
        assert.strictEqual(actual.download, download);
        assert.deepStrictEqual(calls, expectedCalls);
        compared++;
      }
    }
  }
  assert.equal(compared, 180);
});

test('provider credentials, streaming flags and download state are read lazily', () => {
  for (const ready of [true, false]) {
    const calls = [];
    const download = { get state() { calls.push('state'); return 'disabled'; } };
    const options = {
      installer: { status: () => download },
      voiceCfg: {
        get WHISPER_API_KEY() { calls.push('whisper'); return ready; },
        get OPENROUTER_API_KEY() { calls.push('router'); return ''; },
      },
      streamingStatus: {
        get openai() { calls.push('openai'); return { ready: false }; },
        get volcano() { calls.push('volcano'); return {}; },
        get funasr() { calls.push('funasr'); return null; },
      },
    };
    const expected = baselineReadiness(options);
    const expectedCalls = calls.splice(0);
    const actual = voiceReadiness(options);
    assert.deepStrictEqual(calls, expectedCalls);
    assert.deepStrictEqual(actual, expected);
  }
  const error = new Error('probe property unavailable');
  function throwing() { throw error; }
  for (const options of [
    { installer: { status: throwing } },
    { asrLocal: { isAvailable: throwing } },
    { installer: { status: () => ({ get state() { throw error; } }) } },
    { streamingStatus: { openai: { get ready() { throw error; } } } },
  ]) {
    for (const lookup of [baselineReadiness, voiceReadiness]) {
      assert.throws(() => lookup(options), e => e === error);
    }
  }
});
