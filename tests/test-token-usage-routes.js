'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  MAX_EVENT_TOKENS,
  PUBLIC_USAGE_ERROR,
  consumedInput,
  createTokenUsageRoutes,
  localDateKey,
  tokenCount,
} = require('../src/routes/token-usage');

function createApp() {
  const handlers = new Map();
  return {
    handlers,
    get(route, handler) {
      handlers.set(`GET ${route}`, handler);
    },
  };
}

function createResponse() {
  return {
    statusCode: 200,
    body: undefined,
    jsonCalls: 0,
    status(value) {
      this.statusCode = value;
      return this;
    },
    json(value) {
      this.body = value;
      this.jsonCalls += 1;
      return this;
    },
  };
}

async function invoke(app, route, request = {}) {
  const handler = app.handlers.get(`GET ${route}`);
  assert.equal(typeof handler, 'function', `missing GET ${route}`);
  const response = createResponse();
  await handler({ query: {}, ...request }, response);
  assert.equal(response.jsonCalls, 1);
  return response;
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-token-usage-routes-'));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function createRoleTracker(overrides = {}) {
  const snapshots = new Map();
  const calls = { accumulated: [], observed: [], reset: [] };
  return {
    calls,
    snapshots,
    accumulate(info) {
      calls.accumulated.push(info);
      return true;
    },
    accumulateObserved(event) {
      calls.observed.push(event);
      return true;
    },
    snapshot(sessionId) {
      return snapshots.get(sessionId) || null;
    },
    reset(sessionId) {
      calls.reset.push(sessionId);
      snapshots.delete(sessionId);
    },
    readLedger() {
      return { '2026-07-19': { main: {} } };
    },
    ...overrides,
  };
}

function createHarness(root, overrides = {}) {
  const tokenUsageFile = path.join(root, 'token_usage.json');
  const tokenDailyFile = path.join(root, 'token_daily.json');
  const writes = [];
  const broadcasts = [];
  const logs = [];
  const roleTokenTracker = overrides.roleTokenTracker || createRoleTracker();
  const persistedSessions = overrides.persistedSessions || new Map();
  const deps = {
    fs,
    tokenUsageFile,
    tokenDailyFile,
    atomicWriteJson(file, value) {
      writes.push({ file, value: JSON.parse(JSON.stringify(value)) });
      fs.writeFileSync(file, JSON.stringify(value));
    },
    getGlobalUsage: async ({ force }) => ({ force, windows: { all: {} } }),
    readProviderWindows: () => ({}),
    getProviderSummary: (_cli, providerId) => ({ id: providerId, name: `Name ${providerId}` }),
    getEffectiveSessionModel: (session) => session.model || null,
    persistedSessions,
    chatHistoryRepository: {
      listSessionIds: () => [],
      readStrict: () => [],
    },
    roleTokenTracker,
    broadcast(sessionId, payload) {
      broadcasts.push({ sessionId, payload });
    },
    now: () => new Date(2026, 6, 19, 12, 0, 0),
    logger: {
      info(event, detail) { logs.push({ level: 'info', event, detail }); },
      error(event, detail) { logs.push({ level: 'error', event, detail }); },
    },
    ...overrides,
    roleTokenTracker,
    persistedSessions,
  };
  const runtime = createTokenUsageRoutes(deps);
  return {
    runtime,
    deps,
    writes,
    broadcasts,
    logs,
    roleTokenTracker,
    tokenUsageFile,
    tokenDailyFile,
  };
}

test('mounts legacy routes, preserves DTOs, and fixes public error text', async () => {
  const root = tempDir();
  try {
    const tracker = createRoleTracker();
    tracker.snapshots.set('session-a', {
      main: { inputTokens: 3 }, sub: null, subByProvider: [],
    });
    const harness = createHarness(root, { roleTokenTracker: tracker });
    const app = createApp();
    harness.runtime.mountRoutes(app);

    let response = await invoke(app, '/api/token-usage/global');
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, { force: false, windows: { all: {} } });
    response = await invoke(app, '/api/token-usage/global', { query: { refresh: '1' } });
    assert.equal(response.body.force, true);
    response = await invoke(app, '/api/token-usage/global', { query: { refresh: 'true' } });
    assert.equal(response.body.force, false, 'only the established refresh=1 flag forces a scan');

    response = await invoke(app, '/api/token-usage/by-role', { query: { session: 'session-a' } });
    assert.deepEqual(response.body, {
      main: { inputTokens: 3 }, sub: null, subByProvider: [],
    });
    response = await invoke(app, '/api/token-usage/by-role', { query: { session: 'missing' } });
    assert.deepEqual(response.body, { main: null, sub: null, subByProvider: [] });
    response = await invoke(app, '/api/token-usage/by-role');
    assert.deepEqual(response.body, { '2026-07-19': { main: {} } });

    const failing = createHarness(root, {
      getGlobalUsage: async () => {
        throw new Error('secret-token at /Users/private/transcript.jsonl');
      },
    });
    const failingApp = createApp();
    failing.runtime.mountRoutes(failingApp);
    response = await invoke(failingApp, '/api/token-usage/global');
    assert.equal(response.statusCode, 500);
    assert.deepEqual(response.body, { error: PUBLIC_USAGE_ERROR });
    assert.equal(JSON.stringify(response.body).includes('secret-token'), false);
    assert.equal(JSON.stringify(failing.logs).includes('/Users/private'), false);

    const failingRole = createHarness(root, {
      roleTokenTracker: createRoleTracker({
        readLedger() { throw new Error('credential=top-secret /private/ledger.json'); },
      }),
    });
    const failingRoleApp = createApp();
    failingRole.runtime.mountRoutes(failingRoleApp);
    response = await invoke(failingRoleApp, '/api/token-usage/by-role');
    assert.equal(response.statusCode, 500);
    assert.deepEqual(response.body, { error: PUBLIC_USAGE_ERROR });
    assert.equal(JSON.stringify(failingRole.logs).includes('top-secret'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cumulative commit counts consumed input before best-effort local-day indexing', () => {
  const root = tempDir();
  try {
    const sessions = new Map([['session-a', { id: 'session-a', provider: 'provider-a' }]]);
    const harness = createHarness(root, { persistedSessions: sessions });
    const usage = {
      input_tokens: 11,
      output_tokens: 7,
      cache_read_input_tokens: 13,
      cache_creation_input_tokens: 17,
    };
    assert.equal(consumedInput(usage), 41);
    assert.equal(localDateKey(new Date(2026, 6, 19)), '2026-07-19');
    assert.equal(harness.runtime.accumulateTokenUsage('session-a', usage), true);
    assert.deepEqual(readJson(harness.tokenUsageFile), {
      'session-a': {
        inputTokens: 41,
        consumedInputTokens: 41,
        freshInputTokens: 11,
        cacheReadTokens: 13,
        cacheWriteTokens: 17,
        breakdownKnown: true,
        outputTokens: 7,
        turnCount: 1,
        byProvider: {
          'provider-a': {
            inputTokens: 41,
            consumedInputTokens: 41,
            freshInputTokens: 11,
            cacheReadTokens: 13,
            cacheWriteTokens: 17,
            breakdownKnown: true,
            outputTokens: 7,
            turnCount: 1,
          },
        },
      },
    });
    assert.deepEqual(readJson(harness.tokenDailyFile), {
      '2026-07-19': {
        'provider-a': {
          inputTokens: 41,
          consumedInputTokens: 41,
          freshInputTokens: 11,
          cacheReadTokens: 13,
          cacheWriteTokens: 17,
          breakdownKnown: true,
          outputTokens: 7,
          turnCount: 1,
        },
      },
    });
    assert.deepEqual(harness.writes.map((entry) => entry.file), [
      harness.tokenUsageFile,
      harness.tokenDailyFile,
    ]);

    assert.equal(harness.runtime.accumulateTokenUsage('session-a', {}), true);
    assert.equal(harness.writes.length, 2, 'zero usage is an idempotent no-op');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('numeric boundaries convert safe digit strings and reject corrupt or implausible counts', () => {
  const root = tempDir();
  try {
    const sessions = new Map([['session-a', { id: 'session-a', provider: 'provider-a' }]]);
    const harness = createHarness(root, { persistedSessions: sessions });
    fs.writeFileSync(harness.tokenUsageFile, JSON.stringify({
      'session-a': { inputTokens: '100', outputTokens: 'bad', turnCount: '2' },
      corrupt: { inputTokens: 'not-a-number', outputTokens: -9, turnCount: 1.5 },
    }));
    fs.writeFileSync(harness.tokenDailyFile, JSON.stringify({
      '2026-07-19': {
        'provider-a': { inputTokens: '90', outputTokens: 'bad', turnCount: '2' },
      },
    }));

    assert.equal(tokenCount('42'), 42);
    assert.equal(tokenCount('-1'), 0);
    assert.equal(tokenCount(1.5), 0);
    assert.equal(tokenCount(Number.POSITIVE_INFINITY), 0);
    assert.equal(consumedInput({
      input_tokens: '11',
      cache_read_input_tokens: '13',
      cache_creation_input_tokens: String(MAX_EVENT_TOKENS + 1),
    }), 24);

    assert.equal(harness.runtime.accumulateTokenUsage('session-a', {
      input_tokens: '11',
      cache_read_input_tokens: '13',
      cache_creation_input_tokens: String(MAX_EVENT_TOKENS + 1),
      output_tokens: '7',
    }), true);
    assert.deepEqual(readJson(harness.tokenUsageFile), {
      'session-a': {
        inputTokens: 124,
        outputTokens: 7,
        turnCount: 3,
        consumedInputTokens: 124,
        freshInputTokens: 11,
        cacheReadTokens: 13,
        cacheWriteTokens: 0,
        breakdownKnown: true,
        byProvider: {
          'provider-a': {
            inputTokens: 24,
            consumedInputTokens: 24,
            freshInputTokens: 11,
            cacheReadTokens: 13,
            cacheWriteTokens: 0,
            breakdownKnown: true,
            outputTokens: 7,
            turnCount: 1,
          },
        },
      },
      corrupt: {
        inputTokens: 0,
        outputTokens: 0,
        turnCount: 0,
        consumedInputTokens: 0,
        freshInputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        breakdownKnown: false,
      },
    });
    assert.deepEqual(readJson(harness.tokenDailyFile), {
      '2026-07-19': {
        'provider-a': {
          inputTokens: 114,
          outputTokens: 7,
          turnCount: 3,
          consumedInputTokens: 114,
          freshInputTokens: 11,
          cacheReadTokens: 13,
          cacheWriteTokens: 0,
          breakdownKnown: true,
        },
      },
    });
    assert.deepEqual(harness.runtime.getTokenUsage(), readJson(harness.tokenUsageFile));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cumulative write fails closed while daily derivation stays best-effort', () => {
  const root = tempDir();
  try {
    const secret = 'token-secret /private/history.json';
    let writes = 0;
    const cumulativeFailure = createHarness(root, {
      atomicWriteJson() {
        writes += 1;
        const error = new Error(secret);
        error.code = 'EACCES';
        throw error;
      },
    });
    assert.equal(cumulativeFailure.runtime.accumulateTokenUsage('s1', {
      input_tokens: 2, output_tokens: 1,
    }), false);
    assert.equal(writes, 1, 'daily write is not attempted without the durable cumulative commit');
    assert.equal(JSON.stringify(cumulativeFailure.logs).includes(secret), false);
    assert.deepEqual(cumulativeFailure.logs[0], {
      level: 'error', event: 'token_usage_write_failed', detail: { code: 'EACCES' },
    });

    const tokenUsageFile = path.join(root, 'daily-fallback-usage.json');
    const tokenDailyFile = path.join(root, 'daily-fallback-daily.json');
    const dailyFailure = createHarness(root, {
      tokenUsageFile,
      tokenDailyFile,
      atomicWriteJson(file, value) {
        if (file === tokenDailyFile) throw new Error(secret);
        fs.writeFileSync(file, JSON.stringify(value));
      },
    });
    assert.equal(dailyFailure.runtime.accumulateTokenUsage('s2', {
      input_tokens: 4, output_tokens: 2,
    }), true);
    assert.deepEqual(readJson(tokenUsageFile).s2, {
      inputTokens: 4,
      consumedInputTokens: 4,
      freshInputTokens: 4,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      breakdownKnown: true,
      outputTokens: 2,
      turnCount: 1,
      byProvider: {
        _default_: {
          inputTokens: 4,
          consumedInputTokens: 4,
          freshInputTokens: 4,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          breakdownKnown: true,
          outputTokens: 2,
          turnCount: 1,
        },
      },
    });
    assert.equal(fs.existsSync(tokenDailyFile), false);
    assert.equal(JSON.stringify(dailyFailure.logs).includes(secret), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('daily derivation replaces a malformed current-day bucket without losing the cumulative commit', () => {
  const root = tempDir();
  try {
    const harness = createHarness(root);
    fs.writeFileSync(harness.tokenDailyFile, JSON.stringify({ '2026-07-19': 'corrupt-day' }));
    assert.equal(harness.runtime.accumulateTokenUsage('s1', {
      input_tokens: 3,
      cache_read_input_tokens: 7,
      output_tokens: 2,
    }), true);
    assert.equal(readJson(harness.tokenUsageFile).s1.inputTokens, 10);
    assert.deepEqual(readJson(harness.tokenDailyFile)['2026-07-19']._default_, {
      inputTokens: 10,
      consumedInputTokens: 10,
      freshInputTokens: 3,
      cacheReadTokens: 7,
      cacheWriteTokens: 0,
      breakdownKnown: true,
      outputTokens: 2,
      turnCount: 1,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('history seed is one-time, skips internal sessions, and preserves old input/output semantics', () => {
  const root = tempDir();
  try {
    const usageFile = path.join(root, 'seed.json');
    fs.writeFileSync(usageFile, JSON.stringify({
      existing: { inputTokens: 5, outputTokens: 2, turnCount: 1 },
    }));
    const histories = new Map([
      ['existing', [{ usage: { input_tokens: 100, output_tokens: 100 } }]],
      ['new', [
        { usage: {
          input_tokens: 7, output_tokens: 3,
          cache_read_input_tokens: 500, cache_creation_input_tokens: 400,
        } },
        { usage: { input_tokens: 0, output_tokens: 2 } },
        { usage: { input_tokens: 'bad', output_tokens: 'bad' } },
      ]],
      ['codex-cumulative', [
        { role: 'assistant', usage: {
          input_tokens: 30, cached_input_tokens: 70, cache_read_input_tokens: 70,
          output_tokens: 20, reasoning_output_tokens: 5,
        } },
        { role: 'assistant', usage: {
          input_tokens: 45, cached_input_tokens: 100, cache_read_input_tokens: 100,
          output_tokens: 29, reasoning_output_tokens: 8,
        } },
      ]],
      ['broken', null],
      ['__aux__', [{ usage: { input_tokens: 9, output_tokens: 9 } }]],
      ['__gateway__', [{ usage: { input_tokens: 9, output_tokens: 9 } }]],
    ]);
    const harness = createHarness(root, {
      tokenUsageFile: usageFile,
      chatHistoryRepository: {
        listSessionIds: () => [...histories.keys()],
        readStrict: (id) => {
          if (id === 'broken') throw new Error('/secret/history');
          return histories.get(id);
        },
      },
    });
    assert.deepEqual(harness.runtime.seedTokenUsageFromHistory(), { seeded: 2, persisted: true });
    assert.deepEqual(readJson(usageFile), {
      existing: { inputTokens: 5, outputTokens: 2, turnCount: 1 },
      new: { inputTokens: 7, outputTokens: 5, turnCount: 2 },
      'codex-cumulative': { inputTokens: 45, outputTokens: 29, turnCount: 2 },
    });
    assert.deepEqual(harness.runtime.seedTokenUsageFromHistory(), { seeded: 0, persisted: true });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('provider windows preserve ordering and cumulative fallback attribution', () => {
  const root = tempDir();
  try {
    const sessions = new Map([
      ['current', { id: 'current', provider: 'p1' }],
      ['same-provider', { id: 'same-provider', provider: 'p1' }],
      ['other-provider', { id: 'other-provider', provider: 'p2' }],
      ['no-provider', { id: 'no-provider' }],
    ]);
    const usageFile = path.join(root, 'provider-usage.json');
    fs.writeFileSync(usageFile, JSON.stringify({
      current: {
        inputTokens: 10, outputTokens: 1, turnCount: 1,
        byProvider: { p1: { inputTokens: 10, outputTokens: 1, turnCount: 1 } },
      },
      'same-provider': {
        inputTokens: 20, outputTokens: 2, turnCount: 2,
        byProvider: { p1: { inputTokens: 20, outputTokens: 2, turnCount: 2 } },
      },
      'other-provider': { inputTokens: 100, outputTokens: 10, turnCount: 10 },
    }));
    const harness = createHarness(root, {
      tokenUsageFile: usageFile,
      persistedSessions: sessions,
      readProviderWindows: () => ({
        today: { p1: { inputTokens: 1 } },
        week: { p1: { inputTokens: 2 } },
        month: {},
        all: {},
      }),
    });
    assert.deepEqual(harness.runtime.providerTokenWindows('current'), {
      providerId: 'p1',
      windows: {
        today: { inputTokens: 1, consumedInputTokens: 1 },
        week: { inputTokens: 2, consumedInputTokens: 2 },
        month: null,
        all: {
          inputTokens: 30,
          consumedInputTokens: 30,
          freshInputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          unattributedInputTokens: 30,
          breakdownKnown: false,
          outputTokens: 3,
          turnCount: 3,
        },
      },
    });
    harness.runtime.broadcastProviderTokenStats('current');
    assert.deepEqual(harness.broadcasts[0], {
      sessionId: 'current',
      payload: {
        type: 'provider_token_stats',
        windows: {
          today: { inputTokens: 1, consumedInputTokens: 1 },
          week: { inputTokens: 2, consumedInputTokens: 2 },
          month: null,
          all: {
            inputTokens: 30,
            consumedInputTokens: 30,
            freshInputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            unattributedInputTokens: 30,
            breakdownKnown: false,
            outputTokens: 3,
            turnCount: 3,
          },
        },
      },
    });
    assert.deepEqual(harness.runtime.providerTokenWindows('no-provider'), {
      providerId: null, windows: null,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('role callbacks broadcast accepted events and reset through the tracker port', () => {
  const root = tempDir();
  try {
    const tracker = createRoleTracker();
    tracker.snapshots.set('s1', {
      main: { inputTokens: 2 }, sub: null, subByProvider: [],
    });
    const harness = createHarness(root, { roleTokenTracker: tracker });
    const legacy = { sessionId: 's1', usage: { inputTokens: 2 } };
    const observed = { sessionId: 's1', eventId: 'observed-1' };
    assert.equal(harness.runtime.recordRoleTokenUsage(legacy), true);
    assert.equal(harness.runtime.recordUsageObserved(observed), true);
    assert.deepEqual(harness.broadcasts, [
      { sessionId: 's1', payload: { type: 'role_token_stats', role: tracker.snapshots.get('s1') } },
      { sessionId: 's1', payload: { type: 'role_token_stats', role: tracker.snapshots.get('s1') } },
    ]);
    harness.runtime.resetRoleTokenUsage('s1');
    assert.deepEqual(tracker.calls.reset, ['s1']);

    tracker.accumulateObserved = () => false;
    assert.equal(harness.runtime.recordUsageObserved(observed), false);
    assert.equal(harness.broadcasts.length, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Codex reconciliation attributes only the positive unobserved remainder', () => {
  const root = tempDir();
  try {
    const tracker = createRoleTracker();
    tracker.snapshots.set('codex-session', {
      main: { inputTokens: 10, outputTokens: 3, cacheWrite: 0, cacheRead: 20 },
      sub: { inputTokens: 5, outputTokens: 2, cacheWrite: 0, cacheRead: 10 },
      subByProvider: [],
    });
    const sessions = new Map([['codex-session', {
      id: 'codex-session', cli: 'codex', provider: 'p1', model: 'gpt-test',
    }]]);
    const harness = createHarness(root, {
      roleTokenTracker: tracker,
      persistedSessions: sessions,
    });
    assert.equal(harness.runtime.reconcileCodexRoleUsage('codex-session', {
      input_tokens: 100,
      cached_input_tokens: 60,
      output_tokens: 10,
    }), true);
    assert.deepEqual(tracker.calls.accumulated[0], {
      sessionId: 'codex-session',
      role: 'main',
      providerId: 'p1',
      providerName: 'Name p1',
      model: 'gpt-test',
      usage: {
        inputTokens: 30,
        outputTokens: 7,
        cacheWrite: 0,
        cacheRead: 40,
      },
    });
    assert.equal(harness.broadcasts.length, 1);

    assert.equal(harness.runtime.reconcileCodexRoleUsage('codex-session', {
      input_tokens: 10,
      cache_read_input_tokens: 20,
      output_tokens: 3,
    }), false, 'fully observed main usage must not be charged twice');
    assert.equal(tracker.calls.accumulated.length, 1);
    assert.equal(harness.runtime.reconcileCodexRoleUsage('missing', {}), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('constructor rejects broad or incomplete ports before routes are mounted', () => {
  assert.throws(() => createTokenUsageRoutes(), /dependencies are required/);
  assert.throws(() => createTokenUsageRoutes({ fs }), /atomicWriteJson/);
});

test('web usage labels distinguish fresh input and cache from legacy consumed input', () => {
  const root = path.join(__dirname, '..');
  const chat = fs.readFileSync(path.join(root, 'public', 'chat.js'), 'utf8');
  const manage = fs.readFileSync(path.join(root, 'public', 'manage.js'), 'utf8');
  const manageHtml = fs.readFileSync(path.join(root, 'public', 'manage.html'), 'utf8');
  const catalog = fs.readFileSync(path.join(root, 'public', 'provider-catalog.js'), 'utf8');
  for (const label of [/新:/, /缓读:/, /缓写:/, /入\(含缓存\):/, /输入含缓存/]) {
    assert.match(catalog, label);
  }
  assert.match(chat, /const _providerCatalog = window\.MultiCCProviderCatalog/);
  assert.match(chat, /_providerCatalog\.formatUsageWindow/);
  assert.match(manage, /providerCatalog\.formatUsageWindow/);
  assert.match(manage, /providerCatalog\.formatUsageCumulative/);
  assert.match(manageHtml, /id="gu-metric-tabs"/);
  assert.match(manageHtml, /setGuMetric\('fresh'\)[\s\S]*setGuMetric\('inclusive'\)/);
  assert.match(manage, /let _guMetric = 'fresh'/);
  assert.match(manage, /fresh && hasFreshTrend[\s\S]*_globalUsage\.byDayFresh[\s\S]*_globalUsage\.byDay/);
  assert.match(manage, /_guMetric === 'inclusive'[\s\S]*b\.cacheWrite \+ b\.cacheRead/);
});
