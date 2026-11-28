'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const binding = require('../src/native/binding');
const { loadFrozen } = require('./helpers/load-frozen-cron-git');
const native = binding.getNative();
const instant = 1700000000000;
const copy = v => JSON.parse(JSON.stringify(v));
function temp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-recurring-diff-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
async function clock(run) {
  const OriginalDate = global.Date;
  const originalSet = global.setInterval;
  const originalClear = global.clearInterval;
  const random = Math.random;
  let at = instant;
  const intervals = new Set();
  global.Date = class extends OriginalDate {
    constructor(...args) { super(...(args.length ? args : [at])); }
    static now() { return at; }
  };
  global.setInterval = (callback, ms) => {
    const handle = { callback, ms, unref() { this.unrefed = true; } };
    intervals.add(handle);
    return handle;
  };
  global.clearInterval = handle => intervals.delete(handle);
  Math.random = () => 0.123456789;
  try { return await run({ advance: ms => { at += ms; }, intervals }); }
  finally { global.Date = OriginalDate; global.setInterval = originalSet; global.clearInterval = originalClear; Math.random = random; }
}
function paths(root) {
  return { root, pkgRoot: root, scheduledTasksFile: path.join(root, 'scheduled_tasks.json'),
    cronFanoutMigrationFile: path.join(root, 'cron_fanout_migration.json') };
}
function response() {
  return { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return body; } };
}
async function cronSample(root, reference) {
  fs.mkdirSync(root);
  const p = paths(root);
  const writes = [];
  const effects = [];
  const notices = [];
  const atomicWriteJson = (file, value) => {
    writes.push(copy(value));
    fs.writeFileSync(file, JSON.stringify(value, null, 2));
  };
  const out = 'prefix😀' + '文'.repeat(2200);
  let exitCode = 0;
  const script = async (command, cwd, timeout) => {
    effects.push(['script', command, path.dirname(cwd), timeout]);
    return JSON.stringify({ code: exitCode, output: out, timedOut: exitCode !== 0 });
  };
  const deps = { appPaths: { PKG_ROOT: root, createPaths: () => p }, runtimeSecurity: { atomicWriteJson } };
  const cron = reference ? loadFrozen('cron-tasks', { binding: deps, modules: {
    crypto: { ...crypto, randomUUID: () => 'fixed-uuid' },
    child_process: { exec(command, options, callback) {
      effects.push(['script', command, path.dirname(options.cwd), options.timeout]);
      queueMicrotask(() => callback(exitCode ? { code: exitCode, killed: true } : null, out, ''));
    } },
  } }) : binding.createCronTasks({ paths: p, legacyStore: path.join(root, 'absent.json'),
    atomicWriteJson, executeScript: script, randomUUID: () => 'fixed-uuid' });
  fs.writeFileSync(p.scheduledTasksFile, JSON.stringify([{
    id: 'legacy', name: '历史巡检', dirId: 'd', cli: 'claude', prompt: 'p', cron: '0 9 * * *', enabled: false,
    lastSessionId: 'old-chat', taskId: 'empty-race', extra: { retained: true },
  }]));
  let archived = false;
  let creates = 0;
  const entry = id => ({ task: { id }, sessionId: `session-${id}`, readOnly: archived && id === 'preserved' });
  cron.init({
    directories: new Map([['d', { id: 'd', name: 'Directory', path: root }]]), clis: ['claude', 'codex'],
    resolveTaskId: sid => sid === 'old-chat' ? 'preserved' : null,
    getTask: async id => { effects.push(['entry', id]); return entry(id); },
    createTask: async input => { effects.push(['create', copy(input)]); return { ok: true, taskId: `new-${++creates}`, sessionId: `session-new-${creates}` }; },
    sendTaskMessage: async (id, text, options) => { effects.push(['deliver', id, text, copy(options)]); return { ok: true, sessionId: `session-${id}`, receiptId: 'receipt', decision: 'queued' }; },
    taskSummary: id => ({ ...entry(id), title: '历史巡检', status: archived && id === 'preserved' ? 'archived' : 'active', runtime: { cli: 'codex', provider: 'fixture' } }),
    notifyBroken: notice => notices.push(copy(notice)),
  });
  const routes = new Map();
  const app = {};
  for (const method of ['get', 'post', 'patch', 'delete']) app[method] = (route, fn) => routes.set(`${method} ${route}`, fn);
  cron.mount(app);
  const answers = [];
  async function call(key, req = {}) {
    const res = response();
    await routes.get(key)(req, res, error => { throw error; });
    answers.push([key, res.statusCode, copy(res.body)]);
    return res.body;
  }
  try {
    await call('get /api/cron');
    const initialWrites = writes.length;
    const initialEntries = effects.filter(v => v[0] === 'entry').length;
    await call('get /api/cron');
    assert.equal(writes.length, initialWrites, 'a migrated read does not write the store');
    assert.equal(effects.filter(v => v[0] === 'entry').length, initialEntries);
    await call('post /api/cron/:id/run', { params: { id: 'legacy' } });
    archived = true;
    for (let i = 0; i < 2; i++) await call('post /api/cron/:id/run', { params: { id: 'legacy' } });
    assert.equal(notices.length, 1, 'broken binding notification is fingerprinted');
    assert.equal(creates, 0, 'failed firing cannot rotate the task identity');
    await call('post /api/cron/:id/rebind', { params: { id: 'legacy' }, body: {} });
    await call('post /api/cron/:id/rebind', { params: { id: 'legacy' }, body: {} });
    await call('patch /api/cron/:id', { params: { id: 'legacy' }, body: { cli: 'codex' } });
    await call('get /api/cron/:id/runs', { params: { id: 'legacy' } });
    const scriptRule = await call('post /api/cron', { body: { name: '脚本', dirId: 'd', kind: 'script', command: ' echo fixture ', cron: '1 * * * *', enabled: false } });
    await call('post /api/cron/:id/run', { params: { id: scriptRule.id } });
    exitCode = 7;
    await call('post /api/cron/:id/run', { params: { id: scriptRule.id } });
    await call('get /api/cron/:id/runs', { params: { id: scriptRule.id } });
    await call('post /api/cron/:id/rebind', { params: { id: scriptRule.id } });
    await call('get /api/cron/calendar', { query: { month: '2024-02' } });
    await call('get /api/cron/calendar', { query: { month: '2024-13' } });
    await call('delete /api/cron/:id', { params: { id: scriptRule.id } });
    await call('post /api/cron/:id/run', { params: { id: scriptRule.id } });
    return { answers, effects, notices, writes, stored: JSON.parse(fs.readFileSync(p.scheduledTasksFile)) };
  } finally { cron.stop(); }
}

test('native recurring identity, errors, history, scripts and HTTP match the independent frozen owner', async t => {
  const root = temp(t);
  const expected = await clock(() => cronSample(path.join(root, 'reference'), true));
  const actual = await clock(() => cronSample(path.join(root, 'native'), false));
  const normalize = v => JSON.stringify(v).replaceAll(path.join(root, 'reference'), '<root>').replaceAll(path.join(root, 'native'), '<root>');
  assert.deepEqual(JSON.parse(normalize(actual)), JSON.parse(normalize(expected)));
});

test('the shared Rust cron parser and local next occurrence preserve the accepted legacy dialect', () => {
  const expected = loadFrozen('cron-tasks');
  const actual = binding.createCronTasks();
  const from = new Date('2026-11-01T06:59:59.000Z');
  for (const expr of ['* * * * *', '0 9 2 * 1', '0 0 31 2 *', '1junk * * * *', '1/2/3 * * * *', '1-3-8 * * * *', '*/5 * * * *', '* * * * 7', '*/0 * * * *', '1,,2 * * * *', '60 * * * *', '* * * *']) {
    assert.equal(actual.cronValidate(expr), expected.cronValidate(expr), expr);
    assert.equal(actual.cronNext(expr, from), expected.cronNext(expr, from), expr);
  }
  assert.equal(actual._recentRuns({ runs: [{ output: 'a😀b' }] }, 1, 2)[0].output,
    expected._recentRuns({ runs: [{ output: 'a😀b' }] }, 1, 2)[0].output);
});

test('cronNext and calendar match local Date across clock changes and skipped days', t => {
  const cases = {
    'America/Los_Angeles': ['2026-03-08T09:55:59Z', '2026-03-08T09:59:59Z', '2026-03-08T10:00Z',
      '2026-11-01T08:15Z', '2026-11-01T08:59:59Z', '2026-11-01T09:15Z'],
    'Europe/Berlin': ['2026-03-29T00:55:59Z', '2026-03-29T00:59:59Z', '2026-03-29T01:00Z',
      '2026-10-25T00:15Z', '2026-10-25T00:59:59Z', '2026-10-25T01:15Z'],
    'Australia/Lord_Howe': ['2026-10-03T15:25:59Z', '2026-10-03T15:29:59Z', '2026-10-03T15:30Z',
      '2026-04-04T14:45Z', '2026-04-04T14:59:59Z', '2026-04-04T15:15Z'],
    'America/Havana': ['2026-03-08T04:59:59Z', '2026-03-08T05:00Z',
      '2026-11-01T04:30Z', '2026-11-01T05:30Z'],
    'Pacific/Apia': ['2011-12-30T09:59:59Z', '2011-12-30T10:00Z'],
    'Europe/Paris': ['1900-01-01T00:00Z', '1911-03-10T23:50:39Z',
      '1911-03-10T23:59:59Z', '1911-03-11T00:00Z'],
    UTC: ['2026-03-08T09:55:59Z', '2026-11-01T09:15Z'],
  };
  // A fresh process selects the same zone for V8 and the native system clock.
  const compare = `
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const path = require('node:path');
    const binding = require('./src/native/binding');
    const { loadFrozen } = require('./tests/helpers/load-frozen-cron-git');
    const legacy = loadFrozen('cron-tasks');
    const cron = binding.createCronTasks();
    const starts = JSON.parse(process.argv[1]).map(iso => new Date(iso));
    assert.equal(new Set(starts.map(d => d.getTimezoneOffset())).size, process.env.TZ === 'UTC' ? 1 : 2);
    for (const from of starts) {
      for (const expr of ['* * * * *', '*/5 * * * *', '30 1 * * *', '0 2 * * *',
        '15 2 * * *', '30 2 * * *', '0 3 * * *', '45 1 * * *']) {
        assert.equal(cron.cronNext(expr, from), legacy.cronNext(expr, from),
          [process.env.TZ, from.toISOString(), expr].join(' '));
      }
    }
    const DateClass = global.Date;
    global.Date = class extends DateClass {
      constructor(...args) { super(...(args.length ? args : [starts[0].getTime()])); }
      static now() { return starts[0].getTime(); }
    };
    async function calendar(api) {
      const paths = binding.appPaths.createPaths({ dataDir: process.env.MULTICC_DATA_DIR });
      fs.mkdirSync(path.dirname(paths.scheduledTasksFile), { recursive: true });
      fs.writeFileSync(paths.scheduledTasksFile, JSON.stringify([
        { id: 'morning', name: 'morning', kind: 'script', cron: '0 2 * * *', enabled: true },
        { id: 'midnight', name: 'midnight', kind: 'script', cron: '0 0 * * *',
          enabled: false, createdBy: 'subscriptions' },
      ]));
      const routes = new Map();
      const app = Object.fromEntries(['get', 'post', 'patch', 'delete'].map(method => [
        method, (url, callback) => routes.set(method + ' ' + url, callback),
      ]));
      api.mount(app);
      api.init({ directories: new Map() });
      try {
        const results = [];
        const months = new Set(starts.map(d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')));
        for (const month of months) {
          const response = { statusCode: 200, status(code) { this.statusCode = code; return this; },
            json(body) { this.body = body; } };
          await routes.get('get /api/cron/calendar')({ query: { month } }, response, error => { throw error; });
          results.push([response.statusCode, response.body]);
        }
        return results;
      } finally { api.stop(); }
    }
    (async () => {
      assert.deepEqual(await calendar(cron), await calendar(legacy), process.env.TZ);
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const data = temp(t);
  for (const [zone, starts] of Object.entries(cases)) {
    execFileSync(process.execPath, ['-e', compare, JSON.stringify(starts)], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, MULTICC_DATA_DIR: data, TZ: zone },
      timeout: 60000,
    });
  }
});

function gitPort(mode = {}) {
  const calls = [];
  const runGit = async (_cwd, args) => {
    calls.push(args);
    if (mode.wait && args.includes('--is-inside-work-tree')) await mode.wait;
    if (args[0] === 'push') { if (mode.rejectPush) throw { stderr: ' rejected fixture \n' }; return ''; }
    if (args.includes('--is-inside-work-tree')) return mode.notRepo ? 'false' : 'true';
    if (args[0] === 'status') return ' M tracked\n?? untracked\n';
    if (args[0] === 'symbolic-ref') return 'topic';
    if (args[0] === 'remote') return mode.noRemote ? '' : 'origin\nsecond\n';
    if (args[0] === 'for-each-ref') return mode.noUpstream ? '' : 'origin/base';
    if (args[0] === 'rev-list') return args[2].startsWith('origin/') ? String(mode.ahead ?? 2) : '3';
    return 'sha';
  };
  return { runGit, calls };
}
function pushApi(reference, runGit) {
  return reference ? loadFrozen('git-push', { binding: { gitQueue: { runGit } } }) : native.directoryPushApi(runGit);
}
async function cacheSample(reference) {
  return clock(async c => {
    const port = gitPort();
    const api = pushApi(reference, port.runGit);
    const pair = await Promise.all([api.directoryPushState('/fixture'), api.directoryPushState('/fixture')]);
    assert.equal(pair[0], pair[1], 'cold readers receive the same published object');
    const probes = port.calls.length;
    assert.equal(await api.directoryPushState('/fixture'), pair[0]);
    assert.equal(port.calls.length, probes);
    c.advance(10001);
    const stale = await api.directoryPushState('/fixture');
    assert.equal(stale, pair[0], 'stale reads do not wait for refresh');
    const fresh = await api.directoryPushState('/fixture', undefined, { force: true });
    api.invalidate('/fixture');
    await api.directoryPushState('/fixture');
    return { fresh, calls: port.calls };
  });
}
test('native git cache preserves cold coalescing, hot hits, stale reads, force joins and invalidate', async () => {
  assert.deepEqual(await cacheSample(false), await cacheSample(true));
});

test('an invalidation cannot cancel an existing git probe or prevent its eventual cache publication', async () => {
  async function sample(reference) {
    let release;
    const wait = new Promise(resolve => { release = resolve; });
    const port = gitPort({ wait });
    const api = pushApi(reference, port.runGit);
    const first = api.directoryPushState('/fixture', 'topic');
    api.invalidate('/fixture', 'topic');
    const second = api.directoryPushState('/fixture', 'topic', { force: true });
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a, b);
    const count = port.calls.length;
    assert.equal(await api.directoryPushState('/fixture', 'topic'), a);
    assert.equal(port.calls.length, count);
    return { a, calls: port.calls };
  }
  assert.deepEqual(await sample(false), await sample(true));
});

test('native push argv, no-op state and rejected stderr match the frozen implementation', async () => {
  for (const mode of [{}, { noUpstream: true }, { ahead: 0 }, { notRepo: true }, { noRemote: true }, { rejectPush: true }]) {
    async function sample(reference) {
      const port = gitPort(mode);
      const api = pushApi(reference, port.runGit);
      try { return { result: await api.pushDirectory('/fixture', 'topic'), calls: port.calls }; }
      catch (error) { return { error: error.message, calls: port.calls }; }
    }
    assert.deepEqual(await sample(false), await sample(true), JSON.stringify(mode));
  }
});

test('native fan-out version, candidate guards, marker decisions and partial archival match frozen source', async t => {
  const root = temp(t);
  for (const mode of ['unknown', 'new', 'partial', 'missing-port', 'null-outcome', 'overflow', 'applied']) {
    async function sample(reference) {
      const dir = path.join(root, `${mode}-${reference ? 'reference' : 'native'}`);
      fs.mkdirSync(dir);
      const p = paths(dir);
      if (mode === 'applied') fs.writeFileSync(p.cronFanoutMigrationFile, JSON.stringify({ applied: true, appliedAt: instant }));
      const api = reference ? loadFrozen('fanout-migration') : native.fanoutMigrationApi({ pkgRoot: dir, logger: console });
      const count = mode === 'overflow' ? 5001 : 2;
      const tasks = Array.from({ length: count }, (_, i) => ({ id: `stale-${i}`, title: 'abcdefghijkl', origin: 'session', recordType: 'observed' }));
      tasks.push({ id: 'bound', title: 'abcdefghijkl', origin: 'session', recordType: 'observed' });
      tasks.push({ id: 'real', title: 'abcdefghijkl', origin: 'session', recordType: 'observed', chatSessionId: 'conversation' });
      const calls = [];
      const options = { dataDir: dir, pkgRoot: dir, now: () => instant, logger: { log() {}, error() {} },
        fromVersion: mode === 'unknown' ? null : mode === 'new' ? '2.0.3' : '2.0.2',
        tasks, rules: [{ id: 'rule', name: 'abcdefghijkl', taskId: 'bound' }],
      };
      if (mode !== 'missing-port') options.archiveTasks = async ids => {
        calls.push(ids);
        if (mode === 'null-outcome') return null;
        return { archived: [ids[0]], skipped: ids.slice(1).map(taskId => ({ taskId, error: 'busy' })) };
      };
      const result = await api.run(options);
      const files = {};
      for (const file of ['cron_fanout_migration.json', 'logs/cron-fanout-cleanup.log']) {
        const absolute = path.join(dir, file);
        if (fs.existsSync(absolute)) files[file] = fs.readFileSync(absolute, 'utf8');
      }
      return { result, files, calls };
    }
    assert.deepEqual(await sample(false), await sample(true), mode);
  }
});

test('native schedule storage copies legacy data once, preserves corrupt-file fallback and logs failed saves without rollback', async t => {
  const root = temp(t);
  for (const mode of ['legacy', 'corrupt', 'failed-save']) {
    async function sample(reference) {
      const dir = path.join(root, `${mode}-${reference ? 'reference' : 'native'}`);
      fs.mkdirSync(dir);
      const p = paths(dir);
      const legacy = path.join(dir, 'plugins/cron/scheduled_tasks.json');
      const rules = [{ id: 'script', name: '旧脚本', dirId: 'd', kind: 'script', command: 'unused', cron: '* * * * *', enabled: false }];
      if (mode === 'legacy') { fs.mkdirSync(path.dirname(legacy), { recursive: true }); fs.writeFileSync(legacy, JSON.stringify(rules)); }
      else fs.writeFileSync(p.scheduledTasksFile, mode === 'corrupt' ? '{broken' : '[]');
      const atomicWriteJson = (file, value) => {
        if (mode === 'failed-save') throw new Error('injected-save-failure');
        fs.writeFileSync(file, JSON.stringify(value, null, 2));
      };
      const cron = reference ? loadFrozen('cron-tasks', { packageRoot: dir, binding: {
        appPaths: { createPaths: () => p }, runtimeSecurity: { atomicWriteJson },
      } }) : binding.createCronTasks({ paths: p, legacyStore: legacy, atomicWriteJson });
      const routes = new Map(); const app = {};
      for (const method of ['get', 'post', 'patch', 'delete']) app[method] = (path, fn) => routes.set(`${method} ${path}`, fn);
      cron.init({ directories: new Map([['d', { id: 'd', name: 'Directory', path: dir }]]) });
      cron.mount(app);
      try {
        if (mode === 'failed-save') {
          const res = response();
          await routes.get('post /api/cron')({ body: { name: '脚本', dirId: 'd', kind: 'script', command: 'unused', cron: '* * * * *', enabled: false } }, res, error => { throw error; });
          assert.equal(res.statusCode, 200, 'failed save does not retroactively reject the accepted in-memory rule');
        }
        const res = response();
        await routes.get('get /api/cron')({}, res, error => { throw error; });
        assert.equal(res.body.length, mode === 'corrupt' ? 0 : 1);
        if (mode === 'legacy') assert.deepEqual(JSON.parse(fs.readFileSync(legacy)), rules);
        if (mode === 'failed-save') assert.deepEqual(JSON.parse(fs.readFileSync(p.scheduledTasksFile)), []);
        return { rows: copy(res.body), stored: fs.readFileSync(p.scheduledTasksFile, 'utf8') };
      } finally { cron.stop(); }
    }
    const expected = await clock(() => sample(true));
    const actual = await clock(() => sample(false));
    assert.deepEqual(actual, expected, mode);
  }
});

test('production entrypoints reach native owners and retired modules remain test-only', () => {
  for (const relative of ['plugins/cron/cron-tasks.js', 'plugins/cron/fanout-migration.js', 'plugins/utils/git-push.js']) {
    assert.equal(fs.existsSync(path.join(__dirname, '..', relative)), false, relative);
  }
  const entry = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  assert.match(entry, /const cronTasks = require\('\.\/src\/native\/binding'\)\.cronTasks;/);
  assert.match(entry, /const gitPush = require\('\.\/src\/native\/binding'\)\.gitPush;/);
  const adapter = fs.readFileSync(path.join(__dirname, '../src/native/binding.js'), 'utf8');
  assert.match(adapter, /native\.cronTasksApi/);
  assert.match(adapter, /getNative\(\)\.directoryPushApi\(module\.exports\.gitQueue\.runGit\)/);
  assert.doesNotMatch(entry + adapter, /load-frozen-cron-git|frozen-cron-git/);
  assert.equal(typeof native.cronTasksApi, 'function');
  assert.equal(typeof native.fanoutMigrationApi, 'function');
  assert.equal(typeof native.directoryPushApi, 'function');
});
