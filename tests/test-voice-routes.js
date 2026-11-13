'use strict';

// `/api/voice/stt` is the only voice REST route Node still owns; the other 13
// (`/api/voice/{refine,confirm,progress-summary,feedback,vocab,readiness,
// hotwords,test-sse}` and `/api/settings/voice*`) moved to the Rust front door.
// The business rules that used to live in this Express router — the refine
// prompt text, the confirm JSON extraction, settings validation and credential
// masking, the SSE heartbeat, the GET /api/settings/voice projection — are now
// covered by the Rust kernel and by the frozen differential oracle in
// tests/helpers/legacy-voice-routes.js. Their Express-level assertions were
// deleted here on purpose; re-adding them would test code that no longer runs.
//
// What remains is:
//   * the Node host port `/api/__host/voice` (src/routes/voice-host.js): its
//     loopback gate, every op's input/output branches, the settingsApply
//     transaction and each compensation stage, the auxEnqueue failure shape,
//     and the settingsFacts key whitelist;
//   * the retained STT route and the readiness facts it still computes.

const test = require('node:test');
const assert = require('node:assert/strict');
const { mountVoiceRoutes } = require('../src/routes/voice');
const { mountVoiceHostRoute, HOST_PATH } = require('../src/routes/voice-host');

function createApp() {
  const routes = new Map();
  const add = method => (routePath, ...handlers) => routes.set(`${method} ${routePath}`, handlers);
  return { routes, get: add('GET'), post: add('POST'), delete: add('DELETE'), put: add('PUT') };
}

function createResponse() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function createDeps(overrides = {}) {
  const calls = {
    local: true,
    enqueued: [],
    examples: [],
    vocabWrites: [],
    merged: [],
    envWrites: [],
    asrUpdates: [],
    ttsUpdates: [],
    voiceUpdates: [],
    qwenRefreshes: [],
    modelDownloads: [],
    logs: [],
    errors: [],
    reports: [],
  };
  // Stand-in for src/voice/asr-model-installer.js: routes only ever ask it for
  // a status snapshot, a start and a cancel. The real one reaches the network;
  // a route test must never do that, so this one only records the call.
  const asrModelInstaller = {
    status: () => ({ state: 'missing', ready: false, percent: 0, totalBytes: 240193589, doneBytes: 0 }),
    // start() is a promise in the real installer (it resolves when the transfer
    // settles); the route attaches .catch to it and never awaits.
    start: reason => { calls.modelDownloads.push(['start', reason]); return Promise.resolve(); },
    cancel: () => { calls.modelDownloads.push(['cancel']); return true; },
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
    loadVoiceExamples: () => [{ raw: '旧原始', userFinal: '旧优化' }],
    appendVoiceExample: value => calls.examples.push(value),
    loadWhisperVocab: () => [{ term: 'React' }, { term: 'Node' }],
    saveWhisperVocab: value => calls.vocabWrites.push(value),
    extractCorrections: () => ['TypeScript'],
    mergeWhisperVocab: value => calls.merged.push(value),
    buildWhisperPrompt: () => 'React, TypeScript',
    applyEnvUpdates(updates) {
      calls.voiceUpdates.push(updates);
      for (const [key, value] of Object.entries(updates)) {
        if (value === null) delete voice.cfg[key];
        else voice.cfg[key] = value;
      }
    },
  };
  const voiceAsr = {
    cfg: { provider: 'fake-asr' },
    providerStatus: () => ({ provider: 'fake-asr' }),
    applyConfig: value => calls.asrUpdates.push(value),
  };
  const ttsService = {
    cfg: { provider: 'fake-tts' },
    providerStatus: () => ({ provider: 'fake-tts' }),
    applyConfig: value => calls.ttsUpdates.push(value),
  };
  const deps = {
    uploadVoice(req, res, next) { next(); },
    voice,
    asrLocal: { isAvailable: () => false, transcribeBuffer: async () => { throw new Error('not available'); } },
    asrModelInstaller,
    voiceAsr,
    ttsService,
    readEnvFile: () => ({}),
    writeEnvFile: value => calls.envWrites.push(value),
    getAuxQueue: () => ({
      enqueue: async task => {
        calls.enqueued.push(task);
        return { text: '整理后的需求' };
      },
    }),
    runtimeEnv,
    getQwenAudioRuntimeStatus: () => ({ state: 'not_installed', installed: false }),
    onQwenAudioConfigChanged: () => { calls.qwenRefreshes.push('restart'); },
    log: {
      log(...args) { calls.logs.push(args); },
      error(...args) { calls.errors.push(args); },
    },
    reportFailure: (stage, category) => calls.reports.push([stage, category]),
    // isLocalRequest is injectable so the loopback gate can be exercised
    // without fabricating real sockets.
    isLocal: () => calls.local,
    ...overrides,
  };
  return {
    calls,
    deps,
    asrModelInstaller: deps.asrModelInstaller,
    ttsService: deps.ttsService,
    runtimeEnv: deps.runtimeEnv,
    voice: deps.voice,
    voiceAsr: deps.voiceAsr,
  };
}

function mountRoutes(overrides = {}, prepare = () => {}) {
  const harness = createDeps(overrides);
  prepare(harness);
  const app = createApp();
  const controller = mountVoiceRoutes(app, harness.deps);
  return { ...harness, app, controller };
}

function mountHostOnly(overrides = {}, prepare = () => {}) {
  const harness = createDeps(overrides);
  prepare(harness);
  const app = createApp();
  const controller = mountVoiceHostRoute(app, harness.deps);
  return { ...harness, app, controller };
}

async function hostCall(harness, body, { local = true } = {}) {
  const handlers = harness.app.routes.get(`POST ${HOST_PATH}`);
  assert.ok(handlers, `route POST ${HOST_PATH} is mounted`);
  harness.calls.local = local;
  const res = createResponse();
  try {
    await handlers[handlers.length - 1]({ body, headers: {}, socket: {} }, res);
  } finally {
    harness.calls.local = true;
  }
  return res;
}

async function invokeStt(harness, req = {}) {
  const handlers = harness.app.routes.get('POST /api/voice/stt');
  assert.ok(handlers, 'route POST /api/voice/stt is mounted');
  const res = createResponse();
  const request = { body: {}, params: {}, ...req };
  await handlers[handlers.length - 1](request, res);
  return res;
}

const AUDIO_FILE = { buffer: Buffer.from('audio'), originalname: 'a.webm', size: 5, mimetype: 'audio/webm' };

test('mounts only the STT route plus the internal voice host port', () => {
  const { app, deps } = mountRoutes();
  assert.deepEqual([...app.routes.keys()].sort(), [
    'POST /api/__host/voice',
    'POST /api/voice/stt',
  ]);
  assert.equal(app.routes.get('POST /api/voice/stt').length, 2, 'upload middleware stays before the STT handler');
  assert.equal(app.routes.get('POST /api/voice/stt')[0], deps.uploadVoice, 'the configured voice upload middleware remains first');
});

test('host port rejects non-loopback callers and refuses unknown operations', async () => {
  const harness = mountRoutes();
  for (const body of [
    { op: 'examples' }, { op: 'feedbackApply', raw: 'r', refined: '', userFinal: 'R' },
    { op: 'settingsApply', updates: { OPENROUTER_MODEL: 'x' } }, {},
  ]) {
    const res = await hostCall(harness, body, { local: false });
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.body, { error: 'not found' });
  }
  // 非回环请求不产生任何副作用。
  assert.deepEqual(harness.calls.envWrites, []);
  assert.deepEqual(harness.calls.examples, []);
  assert.deepEqual(harness.calls.logs, []);

  for (const body of [{ op: 'nope' }, {}, null, []]) {
    const res = await hostCall(harness, body);
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.body, { error: 'unknown host operation' });
  }
});

test('host dependency assertions name the internal port', () => {
  assert.throws(() => mountVoiceHostRoute({ post() {} }, {}), /\[voice-host\] readEnvFile is required/);
  assert.throws(
    () => mountVoiceHostRoute({ post() {} }, { readEnvFile() {}, writeEnvFile() {}, getAuxQueue() {}, voice: { cfg: {} } }),
    /\[voice-host\] local ASR service is required/,
  );
  assert.throws(
    () => mountVoiceHostRoute({ get() {} }, createDeps().deps),
    /Express-compatible app/,
  );
});

test('examples and vocabulary ops return the legacy DTO shapes', async () => {
  const harness = mountRoutes();
  let res = await hostCall(harness, { op: 'examples' });
  assert.deepEqual(res.body, { ok: true, examples: [{ raw: '旧原始', userFinal: '旧优化' }] });

  res = await hostCall(harness, { op: 'vocabGet' });
  assert.deepEqual(res.body, { ok: true, vocab: [{ term: 'React' }, { term: 'Node' }] });

  // target 已由前门小写化。
  res = await hostCall(harness, { op: 'vocabDelete', target: 'react' });
  assert.deepEqual(res.body, { ok: true, remaining: 1 });
  assert.deepEqual(harness.calls.vocabWrites, [[{ term: 'Node' }]]);
});

test('auxEnqueue keeps the legacy result text and cancelled/message failure shape', async () => {
  const harness = mountRoutes();
  let res = await hostCall(harness, {
    op: 'auxEnqueue',
    type: 'voice_refine',
    prompt: '整理 React bug',
    meta: { reqId: 'vr_1' },
  });
  assert.deepEqual(res.body, { ok: true, text: '整理后的需求' });
  assert.deepEqual(harness.calls.enqueued, [{ type: 'voice_refine', prompt: '整理 React bug', meta: { reqId: 'vr_1' } }]);
  assert.ok(harness.calls.logs.some(args => String(args[0]).includes('[multicc/voice][vr_1]')));

  res = await hostCall(mountRoutes({ getAuxQueue: () => ({ enqueue: async () => ({ text: undefined }) }) }), { op: 'auxEnqueue', type: 'voice_refine', prompt: 'p', meta: {} });
  assert.deepEqual(res.body, { ok: true, text: '' });

  const cancelled = new Error('cancelled by user');
  cancelled.cancelled = true;
  res = await hostCall(mountRoutes({ getAuxQueue: () => ({ enqueue: async () => { throw cancelled; } }) }), { op: 'auxEnqueue', type: 'voice_refine', prompt: 'p', meta: { reqId: 'vr_c' } });
  assert.deepEqual(res.body, { ok: false, cancelled: true, message: 'cancelled by user' });

  // result 为 undefined 时读 .text 的 TypeError 也落进同一条失败分支。
  res = await hostCall(mountRoutes({ getAuxQueue: () => ({ enqueue: async () => undefined }) }), { op: 'auxEnqueue', type: 'voice_refine', prompt: 'p', meta: {} });
  assert.equal(res.body.ok, false);
  assert.equal(res.body.cancelled, false);
  assert.match(res.body.message, /text/);

  res = await hostCall(mountRoutes({ getAuxQueue: () => ({ enqueue: async () => { throw 'boom'; } }) }), { op: 'auxEnqueue', type: 'voice_refine', prompt: 'p', meta: {} });
  assert.deepEqual(res.body, { ok: false, cancelled: false, message: 'boom' });
});

test('feedbackApply persists changed examples, merges corrections and teaches the hotword learner', async () => {
  const learned = [];
  const harness = mountRoutes({}, h => {
    h.voice.autoHotwordsEnabled = true;
    h.voice.autoHotwords = {
      learnFromExample: entry => learned.push(entry),
      snapshot: () => ({ list: 'STT' }),
      reject: () => true,
    };
  });
  const res = await hostCall(harness, { op: 'feedbackApply', raw: 's t t', refined: '', userFinal: 'STT' });
  assert.deepEqual(res.body, { ok: true });
  assert.equal(harness.calls.examples.length, 1);
  assert.equal(harness.calls.examples[0].raw, 's t t');
  assert.equal(harness.calls.examples[0].userFinal, 'STT');
  assert.ok(!Number.isNaN(Date.parse(harness.calls.examples[0].ts)), 'ts is an ISO timestamp');
  assert.deepEqual(harness.calls.merged, [['TypeScript']]);
  assert.equal(learned.length, 1);
  assert.equal(learned[0].userFinal, 'STT');

  // 没有修正就不合并词表。
  const noCorrections = mountRoutes({ voice: { ...createDeps().voice, extractCorrections: () => [] } });
  await hostCall(noCorrections, { op: 'feedbackApply', raw: 'a', refined: 'a', userFinal: 'b' });
  assert.deepEqual(noCorrections.calls.merged, []);

  // 热词学习器缺失或关闭时不学习。
  const disabled = mountRoutes();
  await hostCall(disabled, { op: 'feedbackApply', raw: 'a', userFinal: 'A' });
  assert.equal(disabled.calls.examples.length, 1);
});

test('feedbackApply swallows a failing hotword learner and reports it', async () => {
  const harness = mountRoutes({}, h => {
    h.voice.autoHotwordsEnabled = true;
    h.voice.autoHotwords = { learnFromExample: () => { throw new Error('learner down'); } };
  });
  const res = await hostCall(harness, { op: 'feedbackApply', raw: 'a', refined: '', userFinal: 'A' });
  assert.deepEqual(res.body, { ok: true });
  assert.equal(harness.calls.examples.length, 1);
  assert.ok(harness.calls.errors.some(args => args[0] === '[multicc/hotwords] learn failed:' && args[1] === 'learner down'));
});

test('hotwords ops expose the snapshot and the veto result', async () => {
  let harness = mountRoutes();
  let res = await hostCall(harness, { op: 'hotwords' });
  assert.deepEqual(res.body, { ok: true, present: false, enabled: false, snapshot: null });
  res = await hostCall(harness, { op: 'hotwordsReject', term: 'STT' });
  assert.deepEqual(res.body, { ok: true, present: false, accepted: false });

  const rejected = [];
  harness = mountRoutes({}, h => {
    h.voice.autoHotwordsEnabled = true;
    h.voice.autoHotwords = {
      snapshot: () => ({ list: 'STT', active: [{ term: 'STT' }] }),
      reject: args => { rejected.push(args); return args.term === 'STT'; },
    };
  });
  res = await hostCall(harness, { op: 'hotwords' });
  assert.deepEqual(res.body, { ok: true, present: true, enabled: true, snapshot: { list: 'STT', active: [{ term: 'STT' }] } });
  res = await hostCall(harness, { op: 'hotwordsReject', term: 'STT', alias: 's t t' });
  assert.deepEqual(res.body, { ok: true, present: true, accepted: true });
  assert.deepEqual(rejected, [{ term: 'STT', alias: 's t t' }]);
  res = await hostCall(harness, { op: 'hotwordsReject', term: 'Node' });
  assert.deepEqual(res.body, { ok: true, present: true, accepted: false });
});

test('readinessFacts reports local availability, download state and cloud keys', async () => {
  let harness = mountRoutes();
  let res = await hostCall(harness, { op: 'readinessFacts' });
  assert.deepEqual(res.body, {
    ok: true,
    localAvailable: false,
    download: { state: 'missing', ready: false, percent: 0, totalBytes: 240193589, doneBytes: 0 },
    cloudKeys: { whisper: false, openrouter: false },
    streaming: { provider: 'fake-asr' },
  });

  const voice = createDeps().voice;
  voice.cfg.WHISPER_API_KEY = 'wk';
  voice.cfg.OPENROUTER_API_KEY = 'ok';
  harness = mountRoutes({
    voice,
    asrLocal: { isAvailable: () => true, transcribeBuffer: async () => ({}) },
    voiceAsr: { cfg: {}, providerStatus: () => { throw new Error('probe down'); }, applyConfig() {} },
  });
  res = await hostCall(harness, { op: 'readinessFacts' });
  assert.equal(res.body.localAvailable, true);
  assert.deepEqual(res.body.cloudKeys, { whisper: true, openrouter: true });
  assert.equal(res.body.streaming, null, 'a throwing status probe degrades to null');

  // 没有 installer 时下载状态缺省为 null。
  const noInstaller = mountHostOnly({ asrModelInstaller: null });
  res = await hostCall(noInstaller, { op: 'readinessFacts' });
  assert.equal(res.body.download, null);
});

test('settingsFacts returns only whitelisted string keys and the provider facts', async () => {
  const harness = mountRoutes({
    readEnvFile: () => ({
      OPENROUTER_MODEL: 'file-model',
      WHISPER_API_KEY: 'file-key',
      UNLISTED_SECRET: 'must-not-leak',
    }),
    runtimeEnv: {
      OPENROUTER_MODEL: 'runtime-model',
      WHISPER_API_KEY: 123,
      UNLISTED_SECRET: 'must-not-leak',
    },
  });
  let res = await hostCall(harness, { op: 'settingsFacts', keys: ['OPENROUTER_MODEL', 'WHISPER_API_KEY', 'MISSING'] });
  assert.deepEqual(res.body.env, { OPENROUTER_MODEL: 'file-model', WHISPER_API_KEY: 'file-key' });
  assert.deepEqual(res.body.runtime, { OPENROUTER_MODEL: 'runtime-model' }, 'non-string runtime values are omitted');
  assert.deepEqual(res.body.asrStatus, { provider: 'fake-asr' });
  assert.deepEqual(res.body.ttsStatus, { provider: 'fake-tts' });
  assert.deepEqual(res.body.qwenRuntime, { state: 'not_installed', installed: false });
  assert.doesNotMatch(JSON.stringify(res.body), /must-not-leak/, 'the whole environment is never returned');

  // asr.status.local.download 挂上安装进度；没有 local 块的 provider 不凭空长出。
  const local = mountRoutes({
    voiceAsr: {
      providerStatus: () => ({ provider: 'local', local: { available: false, files: false } }),
      applyConfig: () => {},
    },
  });
  res = await hostCall(local, { op: 'settingsFacts', keys: [] });
  assert.equal(res.body.asrStatus.local.download.state, 'missing');
  assert.equal(res.body.asrStatus.local.download.totalBytes, 240193589);

  const cloud = mountRoutes({ voiceAsr: { providerStatus: () => ({ provider: 'whisper' }), applyConfig() {} } });
  res = await hostCall(cloud, { op: 'settingsFacts', keys: [] });
  assert.equal(Object.hasOwn(res.body.asrStatus, 'local'), false);
});

test('settingsApply runs the persist/apply transaction and refreshes supervised runtimes', async () => {
  const order = [];
  const envWrites = [];
  const harness = mountRoutes({
    writeEnvFile: value => { order.push('persist'); envWrites.push(value); },
  });
  const res = await hostCall(harness, {
    op: 'settingsApply',
    updates: {
      OPENROUTER_MODEL: 'next-model',
      WHISPER_API_KEY: 'new-secret',
      QWEN_AUDIO_DASHSCOPE_API_KEY: 'dashscope-new-key',
    },
  });
  assert.deepEqual(res.body, { ok: true });
  assert.deepEqual(order, ['persist']);
  assert.equal(envWrites[0].WHISPER_API_KEY, 'new-secret');
  assert.equal(harness.runtimeEnv.OPENROUTER_MODEL, 'next-model');
  assert.equal(harness.runtimeEnv.QWEN_AUDIO_DASHSCOPE_API_KEY, 'dashscope-new-key');
  assert.equal(harness.voice.cfg.OPENROUTER_MODEL, 'next-model');
  assert.equal(harness.calls.voiceUpdates.length, 1, 'all hot applies remain one atomic batch');
  assert.deepEqual(harness.calls.qwenRefreshes, ['restart'], 'a QWEN_AUDIO_ key refreshes supervised children');
  assert.ok(harness.calls.logs.some(args => String(args[0]).startsWith('[multicc/voice] Settings updated:')));
  assert.ok(harness.calls.logs.some(args => String(args[0]).startsWith('[multicc/stt] Settings updated:')));
});

test('settingsApply honours the apply order, null clearing and non-Qwen updates', async () => {
  const order = [];
  const harness = mountRoutes({}, h => {
    h.deps.writeEnvFile = value => { order.push('persist'); h.calls.envWrites.push(value); };
    h.deps.voiceAsr.applyConfig = () => order.push('asr');
    h.deps.ttsService.applyConfig = () => order.push('tts');
    h.voice.applyEnvUpdates = updates => { order.push('voice'); h.calls.voiceUpdates.push(updates); };
    h.runtimeEnv.QWEN_AUDIO_REALTIME_MODEL = 'old-model';
  });
  let res = await hostCall(harness, { op: 'settingsApply', updates: { TTS_PROVIDER: 'edge', QWEN_AUDIO_REALTIME_MODEL: null } });
  assert.deepEqual(res.body, { ok: true });
  assert.deepEqual(order, ['persist', 'asr', 'tts', 'voice']);
  assert.equal(Object.hasOwn(harness.runtimeEnv, 'QWEN_AUDIO_REALTIME_MODEL'), false, 'null deletes the runtime key');
  assert.deepEqual(harness.calls.qwenRefreshes, ['restart']);

  const nonQwen = mountRoutes();
  res = await hostCall(nonQwen, { op: 'settingsApply', updates: { INTEGER_SETTING: 7 } });
  assert.deepEqual(res.body, { ok: true });
  assert.deepEqual(nonQwen.calls.qwenRefreshes, [], 'only QWEN_AUDIO_ changes restart children');
});

test('settingsApply compensates every transaction stage and stays out of degraded state', async t => {
  const cases = [
    ['persist', 'persist'],
    ['voice_asr_apply', 'asr'],
    ['tts_apply', 'tts'],
    ['runtime_env_apply', 'runtime'],
    ['voice_apply', 'voice'],
  ];

  for (const [expectedStage, failAt] of cases) {
    await t.test(expectedStage, async () => {
      const disk = { OPENROUTER_MODEL: 'old-file' };
      const runtimeEnv = { OPENROUTER_MODEL: 'old-runtime' };
      const writes = [];
      let writeCount = 0;
      const harness = mountRoutes({ runtimeEnv }, h => {
        h.deps.readEnvFile = () => ({ ...disk });
        h.deps.writeEnvFile = updates => {
          writeCount++;
          writes.push({ ...updates });
          if (writeCount === 1 && failAt === 'persist') throw new Error('sensitive persist failure');
          for (const [key, value] of Object.entries(updates)) {
            if (value === null) delete disk[key];
            else disk[key] = value;
          }
        };
        h.deps.applyRuntimeEnv = (env, updates) => {
          for (const [key, value] of Object.entries(updates)) env[key] = value;
          if (failAt === 'runtime') throw new Error('sensitive runtime failure');
        };
        h.deps.voiceAsr = {
          cfg: { marker: 'old-asr' },
          providerStatus: () => ({}),
          applyConfig() {
            this.cfg.marker = 'new-asr';
            if (failAt === 'asr') throw new Error('sensitive ASR failure token=secret');
          },
        };
        h.deps.ttsService = {
          cfg: { marker: 'old-tts' },
          providerStatus: () => ({}),
          applyConfig() {
            this.cfg.marker = 'new-tts';
            if (failAt === 'tts') throw new Error('sensitive TTS failure stderr');
          },
        };
        h.voice.cfg.OPENROUTER_MODEL = 'old-voice';
        h.voice.applyEnvUpdates = updates => {
          h.voice.cfg.OPENROUTER_MODEL = updates.OPENROUTER_MODEL;
          if (failAt === 'voice') throw new Error('sensitive voice failure /private/path');
        };
      });

      const res = await hostCall(harness, { op: 'settingsApply', updates: { OPENROUTER_MODEL: 'new-model' } });
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.ok, false);
      assert.match(res.body.error.message, /sensitive/);
      assert.equal(disk.OPENROUTER_MODEL, 'old-file');
      assert.equal(runtimeEnv.OPENROUTER_MODEL, 'old-runtime');
      assert.equal(harness.deps.voiceAsr.cfg.marker, 'old-asr');
      assert.equal(harness.deps.ttsService.cfg.marker, 'old-tts');
      assert.equal(harness.voice.cfg.OPENROUTER_MODEL, 'old-voice');
      assert.equal(writes.length, 2, 'persist and compensating env write both ran');
      assert.deepEqual(harness.calls.reports, [[expectedStage, 'apply_failed']]);
      assert.deepEqual(harness.controller.getConsistency(), {
        degraded: false,
        dirty: false,
        reason: null,
        lastFailureAt: null,
      });
    });
  }
});

test('settingsApply reports bounded degraded state when compensation also fails', async () => {
  const disk = { OPENROUTER_API_KEY: 'old-secret' };
  let writeCount = 0;
  const harness = mountRoutes({}, h => {
    h.deps.readEnvFile = () => ({ ...disk });
    h.deps.writeEnvFile = updates => {
      writeCount++;
      if (writeCount === 2) throw new Error('rollback leaked-secret /private/config');
      Object.assign(disk, updates);
    };
    h.voice.applyEnvUpdates = updates => {
      h.voice.cfg.OPENROUTER_API_KEY = updates.OPENROUTER_API_KEY;
      throw new Error('apply leaked-secret /private/config');
    };
  });

  const res = await hostCall(harness, { op: 'settingsApply', updates: { OPENROUTER_API_KEY: 'new-secret' } });
  assert.equal(res.body.ok, false);
  assert.deepEqual(harness.calls.reports, [
    ['voice_apply', 'apply_failed'],
    ['env_restore', 'compensation_failed'],
  ]);
  const state = harness.controller.getConsistency();
  assert.equal(state.degraded, true);
  assert.equal(state.dirty, true);
  assert.equal(state.reason, 'env_restore');
  assert.equal(typeof state.lastFailureAt, 'number');
  assert.doesNotMatch(JSON.stringify({ reports: harness.calls.reports, state }), /new-secret|old-secret|private|config|leaked/);
});

test('settingsApply surfaces a rejected Qwen runtime refresh without failing the write', async () => {
  const harness = mountRoutes({
    onQwenAudioConfigChanged: () => Promise.reject(new Error('supervisor down')),
  });
  const res = await hostCall(harness, { op: 'settingsApply', updates: { QWEN_AUDIO_REALTIME_VOICE: 'longanqian' } });
  assert.deepEqual(res.body, { ok: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(harness.calls.reports, [['qwen_audio_runtime_refresh', 'apply_failed']]);
});

test('settingsApply maps a validator-style statusCode into the generic failure shape', async () => {
  const error = new TypeError('invalid qwenAudio.baseUrl');
  error.statusCode = 400;
  const harness = mountRoutes({}, h => { h.deps.writeEnvFile = () => { throw error; }; });
  const res = await hostCall(harness, { op: 'settingsApply', updates: { OPENROUTER_MODEL: 'x' } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    ok: false,
    error: { message: 'invalid qwenAudio.baseUrl', statusCode: 400 },
  });
});

test('asrModel ops start, cancel and absorb a failed transfer', async () => {
  let harness = mountRoutes();
  let res = await hostCall(harness, { op: 'asrModelStart' });
  assert.deepEqual(res.body, {
    ok: true,
    status: { state: 'missing', ready: false, percent: 0, totalBytes: 240193589, doneBytes: 0 },
  });
  assert.deepEqual(harness.calls.modelDownloads, [['start', 'manual']], 'a bare start means a manual download');

  res = await hostCall(harness, { op: 'asrModelCancel' });
  assert.deepEqual(res.body.ok, true);
  assert.equal(res.body.cancelled, true);
  assert.deepEqual(harness.calls.modelDownloads.at(-1), ['cancel']);

  harness = mountRoutes({
    asrModelInstaller: {
      status: () => ({ state: 'failed', ready: false, error: 'HTTP 502' }),
      start: () => Promise.reject(new Error('HTTP 502')),
      cancel: () => false,
    },
  });
  res = await hostCall(harness, { op: 'asrModelStart' });
  assert.equal(res.body.ok, true);
  assert.equal(res.body.status.state, 'failed');
  await new Promise(resolve => setImmediate(resolve));
});

test('STT preserves the missing-file response and returns the local engine first', async () => {
  let harness = mountRoutes();
  let res = await invokeStt(harness, { body: {} });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: '未收到音频文件' });

  let transcribed = 0;
  harness = mountRoutes({
    asrLocal: {
      isAvailable: () => true,
      transcribeBuffer: async () => {
        transcribed++;
        return { text: '本地结果', ms: 12, decodeMs: 3, inferMs: 9, audioSec: 1.2 };
      },
    },
    fetchImpl: async () => { throw new Error('cloud must not be called'); },
  });
  res = await invokeStt(harness, { file: AUDIO_FILE });
  assert.equal(transcribed, 1);
  assert.deepEqual(res.body, { text: '本地结果', duration_ms: 12, engine: 'local' });
});

test('STT falls back to the cloud when local transcription fails', async () => {
  const voice = createDeps().voice;
  voice.cfg.WHISPER_API_KEY = 'secret';
  const harness = mountRoutes({
    voice,
    asrLocal: { isAvailable: () => true, transcribeBuffer: async () => { throw new Error('sherpa crashed'); } },
    FormDataCtor: class { append() {} },
    BlobCtor: class { constructor(parts, options) { this.parts = parts; this.options = options; } },
    fetchImpl: async () => ({ ok: true, json: async () => ({ text: '云端结果' }) }),
  });
  const res = await invokeStt(harness, { file: AUDIO_FILE });
  assert.equal(res.body.text, '云端结果');
  assert.equal(res.body.engine, 'cloud');
  assert.equal(typeof res.body.duration_ms, 'number');
  assert.ok(harness.calls.errors.some(args => String(args[0]).includes('Local ASR failed')));
});

test('with no local model and no cloud key, STT answers 503 voice_not_ready with what to offer', async () => {
  const harness = mountRoutes();
  const res = await invokeStt(harness, { file: AUDIO_FILE });
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, 'voice_not_ready');
  assert.equal(res.body.readiness.ready, false);
  assert.equal(res.body.readiness.reason, 'missing');
  assert.equal(res.body.readiness.download.totalBytes, 240193589);
});

test('cloud STT retains auth, form fields and response DTO', async () => {
  const appended = [];
  class FakeFormData { append(...args) { appended.push(args); } }
  class FakeBlob { constructor(parts, options) { this.parts = parts; this.options = options; } }
  let request;
  const voice = createDeps().voice;
  voice.cfg.WHISPER_API_KEY = 'secret';
  const harness = mountRoutes({
    voice,
    FormDataCtor: FakeFormData,
    BlobCtor: FakeBlob,
    fetchImpl: async (...args) => {
      request = args;
      return { ok: true, json: async () => ({ text: '云端结果' }) };
    },
  });
  const res = await invokeStt(harness, { file: AUDIO_FILE });
  assert.equal(request[0], 'https://whisper.test/v1/audio/transcriptions');
  assert.equal(request[1].headers.Authorization, 'Bearer secret');
  assert.deepEqual(appended.slice(1), [['model', 'whisper-model'], ['language', 'zh'], ['prompt', 'React, TypeScript']]);
  assert.equal(res.body.text, '云端结果');
  assert.equal(res.body.engine, 'cloud');
});
