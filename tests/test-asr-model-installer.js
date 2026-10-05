'use strict';

// Local ASR model installer. Everything here runs against an injected fetch and
// a temp model root: this suite must never touch the network, never write to
// ~/.multicc, and never depend on the sherpa-onnx addon being present. The real
// transfer is 229MB off HuggingFace — a test that actually ran it would be slow,
// flaky and, on CI, a bandwidth incident.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createAsrModelInstaller,
  ARTIFACTS,
  TOTAL_BYTES,
  SV_DIR,
} = require('../src/voice/asr-model-installer');

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asr-installer-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

// Mirrors src/voice/asr-local.js: the recognizer is usable only when both the
// weights and the vocabulary are in place. Keeping the same rule here means a
// passing "ready" test also proves the installer writes where the reader looks.
function fakeAsrLocal(root, overrides = {}) {
  const seen = { warmups: 0 };
  const asrLocal = {
    cfg: {},
    modelRoot: () => root,
    modelFilesExist: () => fs.existsSync(path.join(root, SV_DIR, 'model.int8.onnx'))
      && fs.existsSync(path.join(root, SV_DIR, 'tokens.txt')),
    warmup: () => { seen.warmups++; },
    ...overrides,
  };
  return { asrLocal, seen };
}

function webResponse(chunks, { status = 200, contentLength } = {}) {
  const list = (Array.isArray(chunks) ? chunks : [chunks]).map(c => new Uint8Array(c));
  const length = contentLength !== undefined ? contentLength : list.reduce((sum, c) => sum + c.length, 0);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => (String(name).toLowerCase() === 'content-length' ? String(length) : null) },
    body: new ReadableStream({
      start(controller) {
        for (const chunk of list) controller.enqueue(chunk);
        controller.close();
      },
    }),
  };
}

// Serves every artifact with a body whose length matches its content-length, so
// the happy path exercises the real truncation check rather than bypassing it.
function serveAll(bodyFor) {
  return async url => webResponse(bodyFor(url));
}

function byName(name) {
  return ARTIFACTS.find(artifact => artifact.id === name);
}

const SMALL = Buffer.alloc(1024, 7);

function withEnv(t, vars) {
  const saved = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

test('a missing model set downloads every artifact to the paths the reader uses', async t => {
  const root = tempRoot(t);
  const { asrLocal, seen } = fakeAsrLocal(root);
  const urls = [];
  const installer = createAsrModelInstaller({
    asrLocal,
    fetchImpl: async url => { urls.push(url); return webResponse(SMALL); },
    log: { log() {}, error() {} },
  });

  assert.equal(installer.status().state, 'missing');
  assert.equal(installer.status().percent, 0);
  assert.equal(installer.status().modelDir, root);

  await installer.start('manual');
  const status = installer.status();
  assert.equal(status.state, 'ready');
  assert.equal(status.ready, true);
  assert.equal(status.filesReady, true);
  assert.equal(status.percent, 100);
  assert.equal(status.doneBytes, status.totalBytes);
  assert.equal(status.error, null);
  assert.equal(status.finishedAt > 0, true);
  assert.equal(status.currentFile, null);

  assert.deepEqual(urls, ARTIFACTS.map(artifact => artifact.sources[0]));
  for (const artifact of ARTIFACTS) {
    const file = path.join(root, artifact.rel);
    assert.equal(fs.existsSync(file), true, `${artifact.rel} lands in place`);
    assert.equal(fs.existsSync(`${file}.part`), false, 'no .part file survives');
  }
  assert.equal(fs.existsSync(path.join(root, '.download.lock')), false, 'the lock is released');
  // The weights are only useful loaded, and the first utterance should not pay
  // for that: a successful install warms the recognizer in the background.
  await delay(0);
  assert.equal(seen.warmups, 1);
});

test('an already-installed model set is a no-op', async t => {
  const root = tempRoot(t);
  const { asrLocal } = fakeAsrLocal(root);
  fs.mkdirSync(path.join(root, SV_DIR), { recursive: true });
  fs.writeFileSync(path.join(root, SV_DIR, 'model.int8.onnx'), SMALL);
  fs.writeFileSync(path.join(root, SV_DIR, 'tokens.txt'), SMALL);
  let fetches = 0;
  const installer = createAsrModelInstaller({
    asrLocal,
    fetchImpl: async () => { fetches++; return webResponse(SMALL); },
    log: { log() {}, error() {} },
  });

  assert.equal(installer.status().state, 'ready');
  await installer.start('manual');
  assert.equal(fetches, 0);
  assert.equal(installer.status().state, 'ready');
});

test('concurrent callers share one transfer', async t => {
  const root = tempRoot(t);
  const { asrLocal } = fakeAsrLocal(root);
  const urls = [];
  let inFlight = 0;
  let peak = 0;
  const installer = createAsrModelInstaller({
    asrLocal,
    fetchImpl: async url => {
      urls.push(url);
      peak = Math.max(peak, ++inFlight);
      await delay(1);
      inFlight--;
      return webResponse(SMALL);
    },
    log: { log() {}, error() {} },
  });

  const first = installer.start('manual');
  const second = installer.start('boot');
  const third = installer.start('manual');
  assert.equal(first, second, 'start() hands back the same in-flight promise');
  assert.equal(second, third);
  await Promise.all([first, second, third]);

  assert.deepEqual(urls, ARTIFACTS.map(artifact => artifact.sources[0]), 'each artifact is fetched exactly once');
  assert.equal(peak, 1, 'never two transfers at once');
  assert.equal(installer.status().state, 'ready');
});

test('a dead network is reported as status, never thrown', async t => {
  const root = tempRoot(t);
  const { asrLocal } = fakeAsrLocal(root);
  const installer = createAsrModelInstaller({
    asrLocal,
    fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND'); },
    log: { log() {}, error() {} },
  });

  const status = await installer.start('manual');
  assert.equal(status.state, 'failed');
  assert.match(status.error, /ENOTFOUND/);
  assert.equal(status.ready, false);
  // The server must still boot and speak: start() resolves, it never rejects.
  assert.equal(fs.existsSync(path.join(root, '.download.lock')), false);
});

test('a mirror carries the artifact when the primary source fails', async t => {
  const root = tempRoot(t);
  const { asrLocal } = fakeAsrLocal(root);
  const urls = [];
  const installer = createAsrModelInstaller({
    asrLocal,
    fetchImpl: async url => {
      urls.push(url);
      const artifact = ARTIFACTS.find(item => url.startsWith(item.sources[0]));
      if (artifact) throw new Error('primary is unreachable');
      return webResponse(SMALL);
    },
    log: { log() {}, error() {} },
  });

  await installer.start('manual');
  assert.equal(installer.status().state, 'ready');
  for (const artifact of ARTIFACTS) {
    assert.equal(artifact.sources.length >= 2, true, `${artifact.id} has a fallback source`);
    assert.deepEqual(urls.filter(url => url === artifact.sources[0]).length, 1);
    assert.deepEqual(urls.filter(url => url === artifact.sources[1]).length, 1);
  }
});

test('a short response is a failure, not a silent corrupt model', async t => {
  const root = tempRoot(t);
  const { asrLocal } = fakeAsrLocal(root);
  const installer = createAsrModelInstaller({
    asrLocal,
    // Announces 4096 bytes and delivers 8, on both the primary and the mirror.
    fetchImpl: async () => webResponse([Buffer.alloc(8)], { contentLength: 4096 }),
    log: { log() {}, error() {} },
  });

  const status = await installer.start('manual');
  assert.equal(status.state, 'failed');
  assert.match(status.error, /传输不完整/);
  assert.equal(fs.existsSync(path.join(root, byName('tokens').rel)), false, 'a truncated file is never promoted');
});

test('an interrupted transfer resumes from the .part file', async t => {
  const root = tempRoot(t);
  const { asrLocal } = fakeAsrLocal(root);
  const tokens = byName('tokens');
  const dest = path.join(root, tokens.rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(`${dest}.part`, Buffer.alloc(512, 1));

  const ranges = [];
  const installer = createAsrModelInstaller({
    asrLocal,
    fetchImpl: async (url, options) => {
      ranges.push([url, options.headers.Range]);
      return webResponse([Buffer.alloc(512, 2)], { status: 206, contentLength: 512 });
    },
    log: { log() {}, error() {} },
  });

  await installer.start('manual');
  assert.equal(installer.status().state, 'ready');
  assert.deepEqual(ranges[0], [tokens.sources[0], 'bytes=512-']);
  assert.equal(fs.readFileSync(dest).length, 1024, 'the resumed bytes are appended, never counted twice');
});

test('a 416 response means the .part file was already whole', async t => {
  const root = tempRoot(t);
  const { asrLocal } = fakeAsrLocal(root);
  const tokens = byName('tokens');
  const dest = path.join(root, tokens.rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(`${dest}.part`, Buffer.alloc(32, 3));

  const installer = createAsrModelInstaller({
    asrLocal,
    fetchImpl: async url => {
      if (url === tokens.sources[0]) return { ok: false, status: 416 };
      return webResponse(SMALL);
    },
    log: { log() {}, error() {} },
  });

  await installer.start('manual');
  assert.equal(fs.existsSync(dest), true);
  assert.equal(fs.existsSync(`${dest}.part`), false);
});

test('a fresh lock from another process is respected, a stale one is reclaimed', async t => {
  const root = tempRoot(t);
  const lock = path.join(root, '.download.lock');
  fs.writeFileSync(lock, '4242\n');

  let fetches = 0;
  const { asrLocal } = fakeAsrLocal(root);
  const installer = createAsrModelInstaller({
    asrLocal,
    fetchImpl: async () => { fetches++; return webResponse(SMALL); },
    log: { log() {}, error() {} },
  });

  const status = await installer.start('manual');
  assert.equal(fetches, 0, 'the other process owns the transfer');
  assert.equal(status.state, 'downloading', 'progress is not ours to report, but the download is real');
  assert.equal(fs.existsSync(lock), true, 'a live lock is never stolen');

  const longAgo = new Date(Date.now() - 7 * 60 * 60 * 1000);
  fs.utimesSync(lock, longAgo, longAgo);
  await installer.start('manual');
  assert.equal(fetches, ARTIFACTS.length, 'a 7h-old lock is reclaimed');
  assert.equal(installer.status().state, 'ready');
});

test('cancel aborts the transfer and reports it as a cancellation', async t => {
  const root = tempRoot(t);
  const { asrLocal } = fakeAsrLocal(root);
  const installer = createAsrModelInstaller({
    asrLocal,
    fetchImpl: (url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('aborted')));
    }),
    log: { log() {}, error() {} },
  });

  assert.equal(installer.cancel(), false, 'nothing to cancel before the first download');
  const running = installer.start('manual');
  assert.equal(installer.status().state, 'downloading');
  assert.equal(installer.cancel(), true);
  const status = await running;
  assert.equal(status.state, 'failed');
  assert.equal(status.error, '下载已取消');
  assert.equal(fs.existsSync(path.join(root, '.download.lock')), false);
});

test('progress carries percent, speed and an ETA while the weights stream', async t => {
  const root = tempRoot(t);
  const { asrLocal } = fakeAsrLocal(root);
  // 600ms per clock read: three chunks are enough for one smoothed sample.
  let clock = 1000;
  const now = () => (clock += 600);
  const recognizer = byName('recognizer');
  const chunk = Buffer.alloc(2048, 9);
  const total = 12;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let reachedGate;
  const atGate = new Promise(resolve => { reachedGate = resolve; });

  const installer = createAsrModelInstaller({
    asrLocal,
    now,
    fetchImpl: async url => {
      if (url !== recognizer.sources[0]) return webResponse(SMALL);
      let pulled = 0;
      const body = new ReadableStream({
        async pull(controller) {
          if (pulled < 3) { controller.enqueue(new Uint8Array(chunk)); pulled++; return; }
          if (pulled === 3) { pulled++; reachedGate(); await gate; }
          if (pulled < total) { controller.enqueue(new Uint8Array(chunk)); pulled++; return; }
          controller.close();
        },
      });
      return {
        ok: true,
        status: 200,
        headers: { get: name => (String(name).toLowerCase() === 'content-length' ? String(chunk.length * total) : null) },
        body,
      };
    },
    log: { log() {}, error() {} },
  });

  const running = installer.start('manual');
  await atGate;
  await delay(10);
  const mid = installer.status();
  assert.equal(mid.state, 'downloading');
  assert.equal(mid.currentFile, 'recognizer');
  assert.equal(mid.bytesPerSec > 0, true, 'a speed is reported while bytes move');
  assert.equal(mid.etaSec > 0, true, 'an ETA is reported while bytes move');
  assert.equal(mid.percent > 0 && mid.percent < 100, true, `percent stays open mid-flight (${mid.percent})`);
  release();

  const done = await running;
  assert.equal(done.state, 'ready');
  assert.equal(done.percent, 100);
  assert.equal(done.etaSec, 0, 'a finished download has no remaining time');
});

test('auto-download stays inert unless the host arms it and nothing turns it off', async t => {
  const root = tempRoot(t);
  let fetches = 0;
  const fetchImpl = async () => { fetches++; return webResponse(SMALL); };
  const build = (autoDownload, cfg = {}) => {
    const { asrLocal } = fakeAsrLocal(root, { cfg });
    return createAsrModelInstaller({ asrLocal, fetchImpl, autoDownload, log: { log() {}, error() {} } });
  };

  withEnv(t, { ASR_LOCAL: undefined, ASR_LOCAL_AUTO_DOWNLOAD: undefined });

  const unarmed = build(false);
  assert.equal(unarmed.autoDownloadEnabled(), false);
  assert.equal(unarmed.maybeAutoDownload(), null);
  assert.equal(fetches, 0, 'a host that never opted in never reaches the network');

  const armed = build(true);
  assert.equal(armed.autoDownloadEnabled(), true);
  assert.equal(armed.status().autoDownload, true);

  // ASR_LOCAL=off is the switch the CI containers set: the gate must stay inert
  // there even though the host armed it. The config is the source of truth when
  // it exists — that is asr-local.js's own rule (isAvailable reads cfg only),
  // and cfg is seeded from the environment at load.
  const disabledByConfig = build(true, { ASR_LOCAL: 'off' });
  assert.equal(disabledByConfig.autoDownloadEnabled(), false);
  assert.equal(disabledByConfig.maybeAutoDownload(), null);
  assert.equal(disabledByConfig.status().state, 'disabled');

  // With no cfg exposed, the environment is the only signal there is.
  const { asrLocal: bare } = fakeAsrLocal(root, { cfg: undefined });
  const byEnv = createAsrModelInstaller({
    asrLocal: bare, fetchImpl, autoDownload: true, log: { log() {}, error() {} },
  });
  withEnv(t, { ASR_LOCAL: 'off' });
  assert.equal(byEnv.autoDownloadEnabled(), false, 'the env switch is read when there is no config');
  withEnv(t, { ASR_LOCAL: '1' });
  assert.equal(byEnv.autoDownloadEnabled(), true);
  // The env-only kill switch outranks everything, config included.
  withEnv(t, { ASR_LOCAL_AUTO_DOWNLOAD: 'false' });
  assert.equal(byEnv.autoDownloadEnabled(), false);
  withEnv(t, { ASR_LOCAL_AUTO_DOWNLOAD: '0' });
  assert.equal(byEnv.autoDownloadEnabled(), false);
  withEnv(t, { ASR_LOCAL_AUTO_DOWNLOAD: undefined });

  assert.equal(fetches, 0, 'none of the above started a transfer');
  await byEnv.start('boot');
  assert.equal(fetches, ARTIFACTS.length);
});

test('the boot hook never fetches weights this machine cannot load', async t => {
  const root = tempRoot(t);
  let fetches = 0;
  const fetchImpl = async () => { fetches++; return webResponse(SMALL); };
  // No sherpa-onnx prebuilt for this platform: the addon is missing, so the
  // weights would be 229MB of dead file. The panel already reports
  // "本机不支持" — the boot hook must agree and stay put.
  const { asrLocal } = fakeAsrLocal(root, { addonAvailable: () => false });
  const installer = createAsrModelInstaller({
    asrLocal, fetchImpl, autoDownload: true, log: { log() {}, error() {} },
  });

  assert.equal(installer.status().state, 'unsupported');
  assert.equal(installer.maybeAutoDownload(), null);
  assert.equal(fetches, 0);

  // The panel button is a deliberate act, so it still tries: the user may know
  // something the probe does not (a freshly installed addon, a fixed build).
  await installer.start('manual');
  assert.equal(fetches, ARTIFACTS.length);
});

test('the boot hook is silent when the models are already there', async t => {
  const root = tempRoot(t);
  const { asrLocal } = fakeAsrLocal(root);
  fs.mkdirSync(path.join(root, SV_DIR), { recursive: true });
  fs.writeFileSync(path.join(root, SV_DIR, 'model.int8.onnx'), SMALL);
  fs.writeFileSync(path.join(root, SV_DIR, 'tokens.txt'), SMALL);
  let fetches = 0;
  const installer = createAsrModelInstaller({
    asrLocal,
    fetchImpl: async () => { fetches++; return webResponse(SMALL); },
    autoDownload: true,
    log: { log() {}, error() {} },
  });

  assert.equal(installer.maybeAutoDownload(), null);
  assert.equal(fetches, 0);
  assert.equal(installer.status().state, 'ready');
});

test('the installer refuses to exist without the local ASR service', () => {
  assert.throws(() => createAsrModelInstaller({}), /requires the local ASR service/);
  assert.throws(() => createAsrModelInstaller({ asrLocal: {} }), /requires the local ASR service/);
});

test('the artifact table matches what asr-local reads', () => {
  const rels = ARTIFACTS.map(artifact => artifact.rel).sort();
  assert.deepEqual(rels, [
    'silero_vad.onnx',
    `${SV_DIR}/model.int8.onnx`,
    `${SV_DIR}/tokens.txt`,
  ].sort());
  assert.equal(TOTAL_BYTES, 240193589, 'the panel sizes its bar from this before the first byte arrives');
  for (const artifact of ARTIFACTS) {
    assert.equal(Number.isInteger(artifact.bytes) && artifact.bytes > 0, true);
    assert.equal(artifact.sources.every(source => source.startsWith('https://')), true);
  }
});
