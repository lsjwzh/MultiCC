'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mountVoiceRoutes } = require('../src/routes/voice');

function createApp() {
  const routes = new Map();
  const add = method => (routePath, ...handlers) => routes.set(`${method} ${routePath}`, handlers);
  return { routes, get: add('GET'), post: add('POST'), delete: add('DELETE') };
}

function createResponse() {
  return {
    statusCode: 200,
    body: undefined,
    headers: {},
    writes: [],
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    setHeader(name, value) { this.headers[name] = value; },
    flushHeaders() {},
    write(value) { this.writes.push(value); },
    end() { this.ended = true; },
    socket: { setNoDelay() {} },
  };
}

async function invoke(app, method, routePath, req = {}) {
  const handlers = app.routes.get(`${method} ${routePath}`);
  assert.ok(handlers, `route ${method} ${routePath} is mounted`);
  const res = createResponse();
  const request = { body: {}, params: {}, ...req };
  await handlers[handlers.length - 1](request, res);
  return res;
}

function createHarness(overrides = {}) {
  const calls = {
    enqueued: [], examples: [], vocabWrites: [], merged: [], envWrites: [], asrUpdates: [], ttsUpdates: [], voiceUpdates: [], qwenRefreshes: [],
  };
  const runtimeEnv = {};
  const voice = {
    cfg: {
      OPENROUTER_API_KEY: '',
      OPENROUTER_BASE_URL: 'https://openrouter.test/v1',
      OPENROUTER_MODEL: 'voice-model',
      WHISPER_API_KEY: '',
      WHISPER_BASE_URL: 'https://whisper.test/v1',
      WHISPER_MODEL: 'whisper-model',
      WHISPER_LANGUAGE: 'zh',
    },
    loadVoiceExamples: () => [],
    appendVoiceExample: value => calls.examples.push(value),
    loadWhisperVocab: () => [{ term: 'React' }, { term: 'Node' }],
    saveWhisperVocab: value => calls.vocabWrites.push(value),
    extractCorrections: () => ['TypeScript'],
    mergeWhisperVocab: value => calls.merged.push(value),
    buildWhisperPrompt: () => 'React, TypeScript',
    applyEnvUpdates: value => {
      calls.voiceUpdates.push(value);
      if (value.OPENROUTER_MODEL !== undefined) voice.cfg.OPENROUTER_MODEL = value.OPENROUTER_MODEL;
      if (value.OPENROUTER_BASE_URL !== undefined) voice.cfg.OPENROUTER_BASE_URL = value.OPENROUTER_BASE_URL;
      if (value.OPENROUTER_API_KEY !== undefined) voice.cfg.OPENROUTER_API_KEY = value.OPENROUTER_API_KEY;
      if (value.WHISPER_MODEL !== undefined) voice.cfg.WHISPER_MODEL = value.WHISPER_MODEL;
      if (value.WHISPER_BASE_URL !== undefined) voice.cfg.WHISPER_BASE_URL = value.WHISPER_BASE_URL;
      if (value.WHISPER_API_KEY !== undefined) voice.cfg.WHISPER_API_KEY = value.WHISPER_API_KEY;
    },
  };
  const deps = {
    uploadVoice(req, res, next) { next(); },
    voice,
    asrLocal: { isAvailable: () => false, transcribeBuffer: async () => { throw new Error('not available'); } },
    voiceAsr: { cfg: { provider: 'fake-asr' }, providerStatus: () => ({ provider: 'fake-asr' }), applyConfig: value => calls.asrUpdates.push(value) },
    ttsService: { cfg: { provider: 'fake-tts' }, providerStatus: () => ({ provider: 'fake-tts' }), applyConfig: value => calls.ttsUpdates.push(value) },
    readEnvFile: () => ({}),
    writeEnvFile: value => calls.envWrites.push(value),
    getAuxQueue: () => ({
      enqueue: async task => {
        calls.enqueued.push(task);
        if (task.type === 'voice_confirm') return { text: '```json\n{"summary":"确认","items":["一"],"questions":[],"allConfirmed":false}\n```' };
        if (task.type === 'progress_summary') return { text: '  已完成第一步。  ' };
        return { text: '整理后的需求' };
      },
    }),
    runtimeEnv,
    getQwenAudioRuntimeStatus: () => ({ state: 'not_installed', installed: false }),
    onQwenAudioConfigChanged: () => { calls.qwenRefreshes.push('restart'); },
    log: { log() {}, error() {} },
    ...overrides,
  };
  const app = createApp();
  const controller = mountVoiceRoutes(app, deps);
  return { app, deps, calls, runtimeEnv: deps.runtimeEnv, voice: deps.voice, controller };
}

test('mounts the complete legacy voice REST surface', () => {
  const { app, deps } = createHarness();
  assert.deepEqual([...app.routes.keys()].sort(), [
    'DELETE /api/voice/vocab/:term',
    'GET /api/settings/voice',
    'GET /api/voice/test-sse',
    'GET /api/voice/vocab',
    'POST /api/settings/voice',
    'POST /api/voice/confirm',
    'POST /api/voice/feedback',
    'POST /api/voice/progress-summary',
    'POST /api/voice/refine',
    'POST /api/voice/stt',
  ]);
  assert.equal(app.routes.get('POST /api/voice/stt').length, 2, 'upload middleware stays before the STT handler');
  assert.equal(app.routes.get('POST /api/voice/stt')[0], deps.uploadVoice, 'the configured voice upload middleware remains first');
});

test('refine preserves empty fast-path and AuxQueue prompt contract', async () => {
  const { app, calls } = createHarness();
  let res = await invoke(app, 'POST', '/api/voice/refine', { body: { raw: '   ' } });
  assert.deepEqual(res.body, { ok: true, text: '', ms: 0 });
  assert.equal(calls.enqueued.length, 0);

  res = await invoke(app, 'POST', '/api/voice/refine', { body: { raw: '帮我修一下 React bug' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.text, '整理后的需求');
  assert.equal(calls.enqueued[0].type, 'voice_refine');
  assert.match(calls.enqueued[0].prompt, /React bug/);
});

test('feedback persists changed examples and vocabulary corrections only', async () => {
  const { app, calls } = createHarness();
  await invoke(app, 'POST', '/api/voice/feedback', { body: { raw: 'type script', refined: 'Type script', userFinal: 'TypeScript' } });
  assert.equal(calls.examples.length, 1);
  assert.deepEqual(calls.merged, [['TypeScript']]);

  await invoke(app, 'POST', '/api/voice/feedback', { body: { raw: 'same', refined: 'same', userFinal: 'same' } });
  assert.equal(calls.examples.length, 1);
});

test('confirmation and progress routes preserve validation and parsed DTOs', async () => {
  const { app, calls } = createHarness();
  let res = await invoke(app, 'POST', '/api/voice/confirm', { body: {} });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: '缺少 text 或 userFeedback' });

  res = await invoke(app, 'POST', '/api/voice/confirm', { body: { text: '做一个任务' } });
  assert.equal(res.body.ok, true);
  assert.equal(res.body.summary, '确认');
  assert.deepEqual(res.body.items, ['一']);
  assert.equal(calls.enqueued.at(-1).type, 'voice_confirm');

  res = await invoke(app, 'POST', '/api/voice/progress-summary', { body: { events: [] } });
  assert.deepEqual(res.body, { ok: true, summary: '' });
  res = await invoke(app, 'POST', '/api/voice/progress-summary', { body: { events: [{ type: 'task', summary: '完成' }] } });
  assert.equal(res.body.summary, '已完成第一步。');
  assert.equal(calls.enqueued.at(-1).type, 'progress_summary');
});

test('vocabulary list and delete retain response shapes', async () => {
  const { app, calls } = createHarness();
  let res = await invoke(app, 'GET', '/api/voice/vocab');
  assert.deepEqual(res.body, [{ term: 'React' }, { term: 'Node' }]);
  res = await invoke(app, 'DELETE', '/api/voice/vocab/:term', { params: { term: 'REACT' } });
  assert.deepEqual(res.body, { ok: true, remaining: 1 });
  assert.deepEqual(calls.vocabWrites, [[{ term: 'Node' }]]);
});

test('STT preserves missing-file response and local-ASR first behavior', async () => {
  let harness = createHarness();
  let res = await invoke(harness.app, 'POST', '/api/voice/stt', { body: {} });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: '未收到音频文件' });

  let transcribed = 0;
  harness = createHarness({
    asrLocal: {
      isAvailable: () => true,
      transcribeBuffer: async () => {
        transcribed++;
        return { text: '本地结果', ms: 12, decodeMs: 3, inferMs: 9, audioSec: 1.2 };
      },
    },
    fetchImpl: async () => { throw new Error('cloud must not be called'); },
  });
  res = await invoke(harness.app, 'POST', '/api/voice/stt', {
    file: { buffer: Buffer.from('audio'), originalname: 'a.webm', size: 5, mimetype: 'audio/webm' },
  });
  assert.equal(transcribed, 1);
  assert.deepEqual(res.body, { text: '本地结果', duration_ms: 12, engine: 'local' });
});

test('cloud STT retains auth, form fields and response DTO', async () => {
  const appended = [];
  class FakeFormData { append(...args) { appended.push(args); } }
  class FakeBlob { constructor(parts, options) { this.parts = parts; this.options = options; } }
  let request;
  const voiceOverride = createHarness().voice;
  voiceOverride.cfg.WHISPER_API_KEY = 'secret';
  const { app } = createHarness({
    voice: voiceOverride,
    FormDataCtor: FakeFormData,
    BlobCtor: FakeBlob,
    fetchImpl: async (...args) => {
      request = args;
      return { ok: true, json: async () => ({ text: '云端结果' }) };
    },
  });
  const res = await invoke(app, 'POST', '/api/voice/stt', {
    file: { buffer: Buffer.from('audio'), originalname: 'a.webm', size: 5, mimetype: 'audio/webm' },
  });
  assert.equal(request[0], 'https://whisper.test/v1/audio/transcriptions');
  assert.equal(request[1].headers.Authorization, 'Bearer secret');
  assert.deepEqual(appended.slice(1), [['model', 'whisper-model'], ['language', 'zh'], ['prompt', 'React, TypeScript']]);
  assert.equal(res.body.text, '云端结果');
  assert.equal(res.body.engine, 'cloud');
});

test('voice settings mask credentials and expose provider status', async () => {
  const { app } = createHarness({
    readEnvFile: () => ({
      OPENROUTER_API_KEY: '12345678abcdefgh9999',
      WHISPER_API_KEY: 'abcdefgh12345678zzzz',
      ASR_PROVIDER: 'openai',
      TTS_PROVIDER: 'edge',
      QWEN_AUDIO_DASHSCOPE_API_KEY: 'dashscope-secret-1234',
      QWEN_AUDIO_REALTIME_MODEL: 'qwen-audio-3.0-realtime-plus',
    }),
  });
  const res = await invoke(app, 'GET', '/api/settings/voice');
  assert.equal(res.body.apiKey, '12345678****9999');
  assert.equal(res.body.whisperApiKey, 'abcdefgh****zzzz');
  assert.deepEqual(res.body.asr.status, { provider: 'fake-asr' });
  assert.deepEqual(res.body.tts.status, { provider: 'fake-tts' });
  assert.equal(res.body.qwenAudio.hasApiKey, true);
  assert.equal(res.body.qwenAudio.apiKey, 'dashsc****1234');
  assert.equal(res.body.qwenAudio.runtime.state, 'not_installed');
});

test('Qwen Audio settings persist a scoped key and refresh supervised Fleet processes', async () => {
  const { app, calls, runtimeEnv } = createHarness();
  const res = await invoke(app, 'POST', '/api/settings/voice', {
    body: {
      qwenAudio: {
        apiKey: 'dashscope-new-key',
        model: 'qwen-audio-3.0-realtime-flash',
        voice: 'longanqian',
        baseUrl: 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime',
      },
    },
  });
  assert.deepEqual(res.body, { ok: true });
  assert.equal(calls.envWrites[0].QWEN_AUDIO_DASHSCOPE_API_KEY, 'dashscope-new-key');
  assert.equal(runtimeEnv.QWEN_AUDIO_DASHSCOPE_API_KEY, 'dashscope-new-key');
  assert.deepEqual(calls.qwenRefreshes, ['restart']);
  assert.equal(calls.voiceUpdates.length, 1, 'existing hot-config transaction remains one atomic batch');
});

test('clearing the Qwen Audio key deletes it from the live environment', async () => {
  const { app, calls, runtimeEnv } = createHarness({
    runtimeEnv: { QWEN_AUDIO_DASHSCOPE_API_KEY: 'old-secret' },
  });
  const res = await invoke(app, 'POST', '/api/settings/voice', {
    body: { qwenAudio: { clearApiKey: true } },
  });
  assert.deepEqual(res.body, { ok: true });
  assert.deepEqual(calls.envWrites, [{ QWEN_AUDIO_DASHSCOPE_API_KEY: null }]);
  assert.equal(Object.hasOwn(runtimeEnv, 'QWEN_AUDIO_DASHSCOPE_API_KEY'), false);
  assert.deepEqual(calls.qwenRefreshes, ['restart']);
});

test('Qwen Audio settings reject insecure remote realtime endpoints', async () => {
  const { app, calls } = createHarness();
  await assert.rejects(
    () => invoke(app, 'POST', '/api/settings/voice', {
      body: { qwenAudio: { baseUrl: 'ws://remote.example/realtime' } },
    }),
    /requires wss/,
  );
  assert.equal(calls.envWrites.length, 0);
});

test('voice settings persist before applying hot runtime config and ignore masked secrets', async () => {
  const order = [];
  const { app, calls, runtimeEnv } = createHarness({
    writeEnvFile: value => { order.push('persist'); calls.envWrites.push(value); },
    voiceAsr: { providerStatus: () => ({}), applyConfig: () => order.push('asr') },
    ttsService: { providerStatus: () => ({}), applyConfig: () => order.push('tts') },
  });
  const res = await invoke(app, 'POST', '/api/settings/voice', {
    body: {
      model: 'next-model',
      apiKey: 'old****mask',
      whisperApiKey: 'new-secret',
      asr: { provider: 'volc', openaiApiKey: '****' },
      tts: { provider: 'edge', openaiApiKey: 'tts-secret' },
    },
  });
  assert.deepEqual(res.body, { ok: true });
  assert.deepEqual(order, ['persist', 'asr', 'tts']);
  assert.equal(calls.envWrites[0].OPENROUTER_API_KEY, undefined);
  assert.equal(calls.envWrites[0].WHISPER_API_KEY, 'new-secret');
  assert.equal(calls.envWrites[0].OPENAI_REALTIME_API_KEY, undefined);
  assert.equal(runtimeEnv.OPENROUTER_MODEL, 'next-model');
  assert.equal(runtimeEnv.OPENAI_TTS_API_KEY, 'tts-secret');
  assert.equal(calls.voiceUpdates.length, 1);
});

test('voice settings persistence failure prevents every live-state mutation', async () => {
  let asrApplied = 0;
  let ttsApplied = 0;
  let voiceApplied = 0;
  const voice = createHarness().voice;
  voice.applyEnvUpdates = () => { voiceApplied++; };
  const { app, runtimeEnv } = createHarness({
    voice,
    writeEnvFile: () => { throw new Error('disk full'); },
    voiceAsr: { providerStatus: () => ({}), applyConfig: () => { asrApplied++; } },
    ttsService: { providerStatus: () => ({}), applyConfig: () => { ttsApplied++; } },
  });
  await assert.rejects(
    () => invoke(app, 'POST', '/api/settings/voice', { body: { model: 'must-not-apply' } }),
    /disk full/,
  );
  assert.equal(asrApplied, 0);
  assert.equal(ttsApplied, 0);
  assert.equal(voiceApplied, 0);
  assert.equal(runtimeEnv.OPENROUTER_MODEL, undefined);
});

test('voice settings compensates every hot-apply failure stage', async t => {
  const cases = [
    ['voice_asr_apply', 'asr'],
    ['tts_apply', 'tts'],
    ['runtime_env_apply', 'runtime'],
    ['voice_apply', 'voice'],
  ];

  for (const [expectedStage, failAt] of cases) {
    await t.test(expectedStage, async () => {
      const seed = createHarness();
      const voice = seed.voice;
      voice.cfg.OPENROUTER_MODEL = 'old-voice';
      voice.applyEnvUpdates = updates => {
        voice.cfg.OPENROUTER_MODEL = updates.OPENROUTER_MODEL;
        if (failAt === 'voice') throw new Error('sensitive voice failure /private/path');
      };
      const asr = {
        cfg: { marker: 'old-asr' },
        providerStatus: () => ({}),
        applyConfig() {
          this.cfg.marker = 'new-asr';
          if (failAt === 'asr') throw new Error('sensitive ASR failure token=secret');
        },
      };
      const tts = {
        cfg: { marker: 'old-tts' },
        providerStatus: () => ({}),
        applyConfig() {
          this.cfg.marker = 'new-tts';
          if (failAt === 'tts') throw new Error('sensitive TTS failure stderr');
        },
      };
      const runtimeEnv = { OPENROUTER_MODEL: 'old-runtime' };
      const disk = { OPENROUTER_MODEL: 'old-file' };
      const writes = [];
      const reports = [];
      const harness = createHarness({
        voice,
        voiceAsr: asr,
        ttsService: tts,
        runtimeEnv,
        readEnvFile: () => ({ ...disk }),
        writeEnvFile: updates => {
          writes.push({ ...updates });
          for (const [key, value] of Object.entries(updates)) {
            if (value === null) delete disk[key];
            else disk[key] = value;
          }
        },
        applyRuntimeEnv: (env, updates) => {
          for (const [key, value] of Object.entries(updates)) env[key] = value;
          if (failAt === 'runtime') throw new Error('sensitive runtime failure');
        },
        reportFailure: (stage, category) => reports.push([stage, category]),
      });

      await assert.rejects(
        () => invoke(harness.app, 'POST', '/api/settings/voice', { body: { model: 'new-model' } }),
        /sensitive/,
      );
      assert.equal(disk.OPENROUTER_MODEL, 'old-file');
      assert.equal(runtimeEnv.OPENROUTER_MODEL, 'old-runtime');
      assert.equal(asr.cfg.marker, 'old-asr');
      assert.equal(tts.cfg.marker, 'old-tts');
      assert.equal(voice.cfg.OPENROUTER_MODEL, 'old-voice');
      assert.equal(writes.length, 2, 'persist and compensating env write both ran');
      assert.deepEqual(reports, [[expectedStage, 'apply_failed']]);
      assert.deepEqual(harness.controller.getConsistency(), {
        degraded: false,
        dirty: false,
        reason: null,
        lastFailureAt: null,
      });
    });
  }
});

test('voice settings reports bounded degraded state when compensation also fails', async () => {
  const seed = createHarness();
  const voice = seed.voice;
  voice.applyEnvUpdates = updates => {
    voice.cfg.OPENROUTER_API_KEY = updates.OPENROUTER_API_KEY;
    throw new Error('apply leaked-secret /private/config');
  };
  const disk = { OPENROUTER_API_KEY: 'old-secret' };
  let writeCount = 0;
  const reports = [];
  const harness = createHarness({
    voice,
    readEnvFile: () => ({ ...disk }),
    writeEnvFile: updates => {
      writeCount++;
      if (writeCount === 2) throw new Error('rollback leaked-secret /private/config');
      Object.assign(disk, updates);
    },
    reportFailure: (stage, category) => reports.push([stage, category]),
  });

  await assert.rejects(
    () => invoke(harness.app, 'POST', '/api/settings/voice', { body: { apiKey: 'new-secret' } }),
    /apply leaked-secret/,
  );
  assert.deepEqual(reports, [
    ['voice_apply', 'apply_failed'],
    ['env_restore', 'compensation_failed'],
  ]);
  const state = harness.controller.getConsistency();
  assert.equal(state.degraded, true);
  assert.equal(state.dirty, true);
  assert.equal(state.reason, 'env_restore');
  assert.equal(typeof state.lastFailureAt, 'number');
  assert.doesNotMatch(JSON.stringify({ reports, state }), /new-secret|old-secret|private|config|leaked/);
});

test('voice SSE closes and clears its interval on client disconnect', async () => {
  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;
  const intervalHandle = { fake: true };
  let scheduled;
  const cleared = [];
  global.setInterval = (callback, delay) => {
    scheduled = { callback, delay };
    return intervalHandle;
  };
  global.clearInterval = handle => cleared.push(handle);
  try {
    const { app } = createHarness();
    let closeHandler;
    const res = await invoke(app, 'GET', '/api/voice/test-sse', {
      on(event, handler) { if (event === 'close') closeHandler = handler; },
    });
    assert.equal(scheduled.delay, 500);
    assert.equal(res.headers['Content-Type'], 'text/event-stream');
    closeHandler();
    assert.deepEqual(cleared, [intervalHandle]);
  } finally {
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
  }
});
