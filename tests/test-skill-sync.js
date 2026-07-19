'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { NEVER_SYNCED_STATUS, createSkillSyncRuntime } = require('../src/skill-sync');
const { mountSkillSyncRoutes } = require('../src/routes/skill-sync');

function createApp() {
  const routes = new Map();
  const register = method => (route, handler) => routes.set(`${method} ${route}`, handler);
  return { routes, get: register('GET'), post: register('POST') };
}

function invoke(app, method, route, request = {}) {
  const handler = app.routes.get(`${method} ${route}`);
  assert.equal(typeof handler, 'function', `missing ${method} ${route}`);
  const response = {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  handler({ body: {}, ...request }, response);
  return response;
}

function makeSkill(directory, name, version) {
  const skillDir = path.join(directory, name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\nname: ${name}\ndescription: test\n---\n`);
  if (version !== undefined) fs.writeFileSync(path.join(skillDir, '.skill-version'), version);
  return skillDir;
}

function createHarness(t, options = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-skill-sync-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const rootDir = path.join(tempDir, 'app');
  const agentsSkillsDir = path.join(tempDir, 'agents');
  const providerRoot = path.join(tempDir, 'providers');
  fs.mkdirSync(path.join(rootDir, 'skills'), { recursive: true });
  fs.mkdirSync(agentsSkillsDir, { recursive: true });

  const providers = ['claude', 'codex', 'hermes'].map(name => ({
    name,
    dir: path.join(providerRoot, name),
    protectedSubdirs: name === 'codex' ? ['.system'] : [],
  }));
  const state = {
    aiCallback: null,
    conversionCalls: [],
    converted: new Set(),
    reverseImports: options.reverseImports || [],
    converterStops: 0,
    detached: [],
    warnings: [],
    logs: [],
    timers: [],
    clearedTimers: [],
    watchers: [],
  };

  class FakeWatcher extends EventEmitter {
    constructor() {
      super();
      this.closeCalls = 0;
    }
    async close() { this.closeCalls++; }
  }

  const skillConverter = {
    AGENTS_ROOT: agentsSkillsDir,
    ensureSkillConverted(name) {
      state.conversionCalls.push(name);
      if (state.converted.has(name)) return { mechanical: [], queuedAi: [] };
      state.converted.add(name);
      return { mechanical: ['codex', 'hermes'], queuedAi: ['codex', 'hermes'] };
    },
    getLinkTarget(name) { return path.join(agentsSkillsDir, name); },
    importAllProviderSkills() { return state.reverseImports; },
    getAiQueueStatus() {
      return { queueLength: 1, items: [{ skillName: 'queued', provider: 'codex' }], timerActive: true };
    },
    onAiConvertNeeded(callback) { state.aiCallback = callback; },
    buildAiConvertPrompt(skillName, provider) {
      return {
        prompt: `rewrite '${skillName}' with $(unsafe) for ${provider}`,
        outputDir: path.join(tempDir, 'converted output', provider),
      };
    },
    stop() { state.converterStops++; },
    ...(options.skillConverter || {}),
  };
  const chokidar = {
    watch() {
      const watcher = new FakeWatcher();
      state.watchers.push(watcher);
      return watcher;
    },
  };
  const persistedSessions = options.persistedSessions || new Map([
    ['aux', { id: '__aux__', cli: 'claude' }],
    ['codex', { id: 'codex-host', cli: 'codex' }],
    ['claude', { id: 'claude-host', cli: 'claude', cwd: tempDir }],
  ]);
  const crypto = options.crypto || { randomBytes: () => Buffer.from('0102030405060708', 'hex') };

  const runtime = createSkillSyncRuntime({
    fs,
    path,
    os: { homedir: () => tempDir, tmpdir: () => tempDir },
    crypto,
    chokidar,
    skillConverter,
    persistedSessions,
    cwdForSession: session => session.cwd || tempDir,
    startDetached: options.startDetached || (async request => { state.detached.push(request); }),
    rootDir,
    claudeCommand: "/opt/Claude's/bin/claude",
    auxSessionId: '__aux__',
    agentsSkillsDir,
    providers,
    syncIntervalMs: 1234,
    setInterval(callback, delay) {
      const timer = { callback, delay, unrefCalled: false, unref() { this.unrefCalled = true; } };
      state.timers.push(timer);
      return timer;
    },
    clearInterval(timer) { state.clearedTimers.push(timer); },
    logger: {
      log(message) { state.logs.push(message); },
      warn(message) { state.warnings.push(message); },
    },
  });

  return {
    runtime,
    state,
    skillConverter,
    rootDir,
    agentsSkillsDir,
    providers,
    tempDir,
  };
}

test('status and route DTOs preserve the never-synced contract', t => {
  const { runtime } = createHarness(t);
  const app = createApp();
  mountSkillSyncRoutes(app, runtime);

  assert.deepEqual([...app.routes.keys()], [
    'GET /api/skill-sync/status',
    'POST /api/skill-sync/run',
  ]);
  const response = invoke(app, 'GET', '/api/skill-sync/status');
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, NEVER_SYNCED_STATUS);
  assert.deepEqual(response.body, {
    ts: 0,
    status: 'never-synced',
    providers: null,
    linkCount: 0,
    skipCount: 0,
    convCount: 0,
    reverseImportCount: 0,
    bundledInstallCount: 0,
    sharedSkillCount: 0,
    sharedSkillNames: [],
    aiQueue: { queueLength: 0, items: [], timerActive: false },
    error: null,
  });
});

test('manual sync preserves bundled import, provider links and per-provider counts', t => {
  const harness = createHarness(t, { reverseImports: [{ name: 'one' }, { name: 'two' }] });
  makeSkill(path.join(harness.rootDir, 'skills'), 'bundled-skill', 'v1');
  makeSkill(harness.agentsSkillsDir, 'user-skill');

  const codexUserDir = makeSkill(harness.providers[1].dir, 'user-skill');
  const app = createApp();
  mountSkillSyncRoutes(app, harness.runtime);
  const response = invoke(app, 'POST', '/api/skill-sync/run');

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.result.bundledInstallCount, 1);
  assert.equal(response.body.result.reverseImportCount, 2);
  assert.equal(response.body.result.linkCount, 5);
  assert.equal(response.body.result.skipCount, 0);
  assert.equal(response.body.result.convCount, 2);
  assert.deepEqual(response.body.result.sharedSkillNames, ['bundled-skill', 'user-skill']);
  assert.deepEqual(response.body.result.providers, {
    claude: { linked: 2, skipped: 0, converted: 0 },
    codex: { linked: 1, skipped: 0, converted: 2 },
    hermes: { linked: 2, skipped: 0, converted: 0 },
  });
  assert.equal(fs.lstatSync(path.join(harness.providers[0].dir, 'bundled-skill')).isSymbolicLink(), true);
  assert.equal(fs.realpathSync(path.join(harness.providers[2].dir, 'user-skill')),
    fs.realpathSync(path.join(harness.agentsSkillsDir, 'user-skill')));
  assert.equal(fs.lstatSync(codexUserDir).isSymbolicLink(), false,
    'an unversioned provider-owned directory is never replaced');

  const second = invoke(app, 'POST', '/api/skill-sync/run');
  assert.equal(second.body.result.bundledInstallCount, 0);
  assert.equal(second.body.result.linkCount, 0);
  assert.equal(second.body.result.error, null);
});

test('failed manual sync records the failure, returns 500 and releases the running guard', t => {
  let calls = 0;
  const harness = createHarness(t, {
    skillConverter: {
      importAllProviderSkills() {
        calls++;
        if (calls === 1) throw new Error('reverse import failed');
        return [];
      },
    },
  });
  const app = createApp();
  mountSkillSyncRoutes(app, harness.runtime);

  const failed = invoke(app, 'POST', '/api/skill-sync/run');
  assert.equal(failed.statusCode, 500);
  assert.deepEqual(failed.body, { ok: false, error: 'reverse import failed' });
  assert.equal(harness.runtime.getStatus().error, 'reverse import failed');
  assert.equal(harness.runtime.isRunning(), false);

  const recovered = invoke(app, 'POST', '/api/skill-sync/run');
  assert.equal(recovered.statusCode, 200);
  assert.equal(recovered.body.result.error, null);
  assert.equal(harness.runtime.isRunning(), false);
});

test('manual and background failures redact secrets and do not escape timer or watcher callbacks', t => {
  let calls = 0;
  const harness = createHarness(t, {
    skillConverter: {
      importAllProviderSkills() {
        calls++;
        throw new Error('/Users/alice/.agents/skills/private token=skill-secret');
      },
      ensureSkillConverted() {
        throw new Error('/Users/alice/provider-dir Authorization: Bearer skill-secret');
      },
    },
  });
  const app = createApp();
  mountSkillSyncRoutes(app, harness.runtime);

  const manual = invoke(app, 'POST', '/api/skill-sync/run');
  assert.equal(manual.statusCode, 500);
  assert.deepEqual(manual.body, { ok: false, error: 'skill sync failed' });
  assert.equal(harness.runtime.getStatus().error, 'skill sync failed');

  assert.doesNotThrow(() => harness.runtime.start());
  assert.equal(harness.state.timers.length, 1);
  assert.doesNotThrow(() => harness.state.timers[0].callback());
  assert.equal(harness.runtime.getStatus().error, 'skill sync failed');
  assert.doesNotThrow(() => harness.state.watchers[0].emit(
    'error',
    new Error('/Users/alice/watcher token=skill-secret'),
  ));

  makeSkill(harness.agentsSkillsDir, 'watch-me');
  assert.doesNotThrow(() => harness.state.watchers[0].emit('addDir'));
  assert.equal(harness.runtime.getStatus().error, 'skill sync failed');
  assert.doesNotMatch(JSON.stringify({
    status: harness.runtime.getStatus(),
    warnings: harness.state.warnings,
  }), /skill-secret|\/Users\/alice/);
});

test('stop blocks new AI batches and drains a conversion already being submitted', async t => {
  let releaseSubmission;
  let submissionStarted;
  const started = new Promise(resolve => { submissionStarted = resolve; });
  const release = new Promise(resolve => { releaseSubmission = resolve; });
  const harness = createHarness(t, {
    async startDetached(request) {
      harness.state.detached.push(request);
      submissionStarted();
      await release;
    },
  });
  harness.runtime.start();
  harness.state.aiCallback([{ skillName: 'queued', provider: 'codex' }]);
  await started;

  let stopped = false;
  const stopping = harness.runtime.stop().then(() => { stopped = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopped, false, 'stop waits for the in-flight detached submission');

  harness.state.aiCallback([{ skillName: 'ignored-after-stop', provider: 'codex' }]);
  releaseSubmission();
  await stopping;
  assert.equal(stopped, true);
  assert.equal(harness.state.detached.length, 1, 'no new conversion is accepted after stop begins');
});

test('a re-entrant manual request receives the legacy 409 without disturbing the active run', t => {
  const harness = createHarness(t);
  const app = createApp();
  mountSkillSyncRoutes(app, harness.runtime);
  let nestedResponse;
  harness.skillConverter.importAllProviderSkills = () => {
    nestedResponse = invoke(app, 'POST', '/api/skill-sync/run');
    return [];
  };

  const outerResponse = invoke(app, 'POST', '/api/skill-sync/run');
  assert.equal(nestedResponse.statusCode, 409);
  assert.deepEqual(nestedResponse.body, { ok: false, error: 'sync already running' });
  assert.equal(outerResponse.statusCode, 200);
  assert.equal(harness.runtime.isRunning(), false);
});

test('AI conversion materializes prompts and cleans them after detached submission failure', async t => {
  let promptSequence = 0;
  let submitted;
  const harness = createHarness(t, {
    crypto: {
      randomBytes() {
        promptSequence++;
        return Buffer.from(String(promptSequence).padStart(16, '0'), 'hex');
      },
    },
    async startDetached(request) {
      submitted = request;
      throw new Error('detached unavailable');
    },
  });

  harness.runtime.start();
  await harness.runtime.queueAiSkillConversions([{ skillName: "unsafe'$(touch nope)", provider: 'codex' }]);
  assert.equal(submitted.sessionId, 'claude-host');
  assert.equal(submitted.spec.cwd, harness.tempDir);
  assert.equal(submitted.spec.daemon, false);
  assert.equal(submitted.spec.intervalSec, 10);
  assert.equal(submitted.spec.maxChecks, 360);
  assert.match(submitted.spec.command, /^PROMPT_FILE='/);
  assert.match(submitted.spec.command, /trap 'rm -f -- "\$PROMPT_FILE"' EXIT/);
  assert.equal(submitted.spec.command.includes('$(touch nope)'), false,
    'prompt content never enters shell syntax');
  const promptFile = submitted.spec.command.match(/^PROMPT_FILE='([^']+)'/)[1];
  assert.equal(fs.existsSync(promptFile), false);
  assert.match(harness.state.warnings.at(-1), /AI conversion submit failed/);
  await harness.runtime.stop();
});

test('start and stop own one watcher and periodic timer and can restart cleanly', async t => {
  const harness = createHarness(t, { reverseImports: [{ name: 'startup' }] });
  makeSkill(harness.agentsSkillsDir, 'one');

  const first = harness.runtime.start();
  const duplicate = harness.runtime.start();
  assert.equal(duplicate, first);
  assert.equal(harness.state.watchers.length, 1);
  assert.equal(harness.state.timers.length, 1);
  assert.equal(harness.state.timers[0].delay, 1234);
  assert.equal(harness.state.timers[0].unrefCalled, true);

  harness.state.reverseImports = [{ name: 'periodic-a' }, { name: 'periodic-b' }];
  harness.state.timers[0].callback();
  assert.equal(harness.runtime.getStatus().reverseImportCount, 2);

  await harness.runtime.stop();
  await harness.runtime.stop();
  assert.deepEqual(harness.state.clearedTimers, [harness.state.timers[0]]);
  assert.equal(harness.state.watchers[0].closeCalls, 1);
  assert.ok(harness.state.converterStops >= 1);

  harness.runtime.start();
  assert.equal(harness.state.watchers.length, 2);
  assert.equal(harness.state.timers.length, 2);
  await harness.runtime.stop();
});
