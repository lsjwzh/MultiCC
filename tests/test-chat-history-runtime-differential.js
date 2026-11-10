'use strict';

// 迁移差分：冻结在 tests/helpers 的旧 Node 宿主运行时（oracle）与
// `RustChatHistoryRuntime` 适配层各自驱动**同一套**假端口、真实临时数据根
// 和同一个原生仓库/历史服务，逐步比较返回值（含同步布尔、冻结状态、克隆
// 隔离）、抛出错误、完整调用轨迹（广播载荷、蒸馏、复盘调度、定时器
// create/clear/unref、日志、chatSessions 活对象写入）、以及每一步后的磁盘
// 字节。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const legacy = require('./helpers/legacy-chat-history-runtime');
const native = require('../src/routes/chat-history');
const { createChatHistoryFileRepository } = require('../src/session/adapters/chat-history-file-repository');

const tempDirs = [];
function tempDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `multicc-chdiff-${label}-`));
  tempDirs.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
});

// ── 规范化 ────────────────────────────────────────────────────────────────
// 保留类型、Date 值、数组/对象/Set 的冻结状态，以及对象键顺序。
function canon(value) {
  if (value === undefined) return { t: 'undefined' };
  if (value === null) return { t: 'null' };
  const type = typeof value;
  if (type === 'number') {
    if (Number.isNaN(value)) return { t: 'number', v: 'NaN' };
    if (value === Infinity) return { t: 'number', v: 'Infinity' };
    if (value === -Infinity) return { t: 'number', v: '-Infinity' };
    if (Object.is(value, -0)) return { t: 'number', v: '-0' };
    return { t: 'number', v: value };
  }
  if (type === 'string' || type === 'boolean') return { t: type, v: value };
  if (type === 'bigint') return { t: 'bigint', v: String(value) };
  if (type === 'symbol') return { t: 'symbol', v: String(value) };
  if (type === 'function') return { t: 'function', name: value.name };
  if (value instanceof Date) return { t: 'Date', v: value.getTime() };
  if (value instanceof Set) return { t: 'Set', frozen: Object.isFrozen(value), v: [...value].map(canon) };
  if (value instanceof Map) {
    return { t: 'Map', v: [...value.entries()].map(([key, entry]) => [canon(key), canon(entry)]) };
  }
  if (Array.isArray(value)) {
    return { t: 'array', frozen: Object.isFrozen(value), v: value.map(canon) };
  }
  if (type === 'object') {
    const keys = [];
    for (const key of Object.keys(value)) keys.push([key, canon(value[key])]);
    return { t: 'object', frozen: Object.isFrozen(value), keys };
  }
  return { t: type };
}

function errorCanon(error) {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) return { value: canon(error) };
  return {
    name: error.name,
    message: error.message,
    code: error.code === undefined ? null : error.code,
  };
}

function snapshotDir(dir) {
  const out = [];
  const walk = current => {
    for (const name of fs.readdirSync(current).sort()) {
      const full = path.join(current, name);
      if (fs.statSync(full).isDirectory()) { walk(full); continue; }
      out.push([path.relative(dir, full), fs.readFileSync(full).toString('base64')]);
    }
  };
  walk(dir);
  return out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function safeJson(value) {
  return JSON.stringify(value, (_key, entry) => {
    if (typeof entry === 'bigint') return `${entry}n`;
    return entry;
  }).slice(0, 40000);
}

// step() 返回两个 harness 的 captured 条目；从规范化返回值里取字段。
function outcomeField(entry, name) {
  const keys = entry.outcome.returned && entry.outcome.returned.keys;
  if (!Array.isArray(keys)) return undefined;
  const found = keys.find(([key]) => key === name);
  return found && found[1];
}

function outcomeNumber(entry, name) {
  const value = outcomeField(entry, name);
  return value && value.v;
}

// ── 假宿主 ────────────────────────────────────────────────────────────────
// 每个 harness 一套端口、一个真实临时数据根；两套端口的行为完全相同，只
// 记录各自轨迹。
const HISTORY_METHODS = [
  'deleteSession', 'fileFor', 'hasPersistedDelivery', 'listSessionIds', 'read',
  'readVisibility', 'renameSession', 'write', 'writeVisibility', 'visibilityFileFor',
  'readStrict',
];

function createHarness(kind, options = {}) {
  const implementation = kind === 'legacy' ? legacy : native;
  const dataDir = tempDir(kind);
  const raw = createChatHistoryFileRepository({ dataDir });
  const trace = [];
  const note = (...parts) => { trace.push(parts); };

  const controls = {
    clock: 1700000000000,
    project: 'identity',
    distill: 'ok',
    review: 'ok',
    failWrite: null,
    failVisibilityWrite: null,
    failRead: null,
    idFactory: 'ok',
    taskCode: 'ok',
    onBroadcast: null,
    onDistill: null,
    runState: 'idle',
    backgroundTasks: [],
    snapshotThrow: false,
    mutateThrow: false,
    clearedNativeSessions: 0,
    checkpoint: { createdAt: 'fixed' },
  };

  // — 定时器 / 立即回调 —
  const timers = new Map();
  let timerSeq = 0;
  function fakeSetTimeout(callback, delay) {
    const id = `timer-${++timerSeq}`;
    note('timer-create', id, canon(delay));
    const handle = { id, unref() { note('timer-unref', id); } };
    timers.set(id, { callback, handle });
    return handle;
  }
  function fakeClearTimeout(handle) {
    note('timer-clear', handle && handle.id);
    if (handle && handle.id) timers.delete(handle.id);
  }
  function fireTimers() {
    const pending = [...timers.values()];
    timers.clear();
    for (const entry of pending) {
      note('timer-fire', entry.handle.id);
      entry.callback();
    }
  }
  const immediates = [];
  function fakeSetImmediate(callback) {
    note('immediate-create');
    immediates.push(callback);
  }
  function flushImmediates() {
    while (immediates.length) {
      const callback = immediates.shift();
      note('immediate-run');
      callback();
    }
  }

  // — chatSessions 活对象（写入被记录） —
  const sessionTargets = new Map();
  const sessionOrder = [];
  function sessionProxy(id) {
    if (!sessionTargets.has(id)) {
      const target = {};
      const proxy = new Proxy(target, {
        set(object, key, value) {
          note('session-set', id, String(key), canon(value));
          object[key] = value;
          return true;
        },
        deleteProperty(object, key) {
          note('session-delete', id, String(key));
          delete object[key];
          return true;
        },
      });
      sessionTargets.set(id, { target, proxy });
      sessionOrder.push(id);
    }
    return sessionTargets.get(id);
  }
  function seedSession(id, fields) {
    const entry = sessionProxy(id);
    Object.assign(entry.target, fields);
    return entry.proxy;
  }
  const chatSessions = { get: id => { const entry = sessionTargets.get(String(id)); return entry ? entry.proxy : undefined; } };
  function snapshotSessions() {
    return sessionOrder.map(id => [id, canon(sessionTargets.get(id).target)]);
  }

  // — 确定性 id / 时钟 —
  let idSeq = 0;
  function idFactory() {
    if (controls.idFactory === 'throw') throw new Error('id boom');
    const id = `id-${++idSeq}`;
    note('id', id);
    return id;
  }
  function clock() {
    note('clock');
    return controls.clock;
  }

  // — 仓库包装：记录调用、可注入失败 —
  const history = {};
  for (const name of HISTORY_METHODS) {
    history[name] = (...args) => {
      note('history-args', name, canon(args));
      const failure = name === 'write' ? controls.failWrite
        : name === 'writeVisibility' ? controls.failVisibilityWrite
          : name === 'read' ? controls.failRead
            : null;
      if (failure) {
        note('history', name, 'throw', errorCanon(failure));
        throw failure;
      }
      try {
        const result = raw[name](...args);
        note('history', name, 'ok', canon(result));
        return result;
      } catch (error) {
        note('history', name, 'throw', errorCanon(error));
        throw error;
      }
    };
  }
  if (options.dropVisibilityWrite) delete history.writeVisibility;
  history.root = raw.root;

  // — 其余端口 —
  const CODES = { 'task-alpha': 'ab12', 'task-beta': 'cd34', 'task-gamma': 'toolong', 'task-delta': 'z9y8' };
  function taskShortCode(taskId) {
    note('short-code', canon(taskId));
    if (controls.taskCode === 'throw') throw new Error('short code boom');
    return CODES[String(taskId)];
  }
  function retentionPolicy(session) {
    note('retention', canon(session));
    if (session === 'aux') return { maxMessages: 3 };
    if (session === 'small') return 2;
    if (session === 'zero') return 0;
    return undefined;
  }
  function projectMessages(session, messages) {
    note('project', canon(session), canon(messages));
    if (controls.project === 'throw') throw new Error('projection boom');
    if (controls.project === 'undefined') return undefined;
    if (controls.project === 'tag') return messages.map(message => ({ ...message, projected: true }));
    return messages;
  }
  function chatBroadcast(session, payload) {
    note('broadcast', canon(session), canon(payload));
    if (controls.onBroadcast) controls.onBroadcast(h);
  }
  function distillHistoryIntoMemory(session, messages) {
    note('distill', canon(session), canon(messages));
    if (controls.distill === 'syncThrow') throw new Error('distill sync boom');
    if (controls.onDistill) controls.onDistill(h);
    if (controls.distill === 'reject') return Promise.reject(new Error('distill async boom'));
    return { ok: true };
  }
  function maybeSchedulePeriodicMemoryReview(session) {
    note('review', canon(session));
    if (controls.review === 'throw') throw new Error('review boom');
  }
  const logger = {
    warn(event, payload) { note('log', 'warn', event, canon(payload)); },
    error(event, payload) { note('log', 'error', event, canon(payload)); },
  };

  // — 会话持久记录（rotateNativeContext 的输入） —
  const persistedRecords = new Map();
  function seedPersisted(id, fields = {}) {
    const record = { id: String(id), kind: 'chat', cli: 'claude', ...fields };
    persistedRecords.set(String(id), record);
    return record;
  }
  function persistedSnapshot() {
    return [...persistedRecords.entries()].map(([id, record]) => [id, canon(record)]);
  }

  const deps = {
    history,
    persistedSessions: { get: id => persistedRecords.get(String(id)) },
    chatSessions,
    idFactory,
    chatBroadcast,
    distillHistoryIntoMemory,
    maybeSchedulePeriodicMemoryReview,
    cliSwitchGitSnapshot: persisted => {
      note('git-snapshot', canon(persisted));
      if (controls.snapshotThrow) throw new Error('snapshot boom');
      return { dirty: false };
    },
    clearAllNativeCliStates: persisted => {
      note('clear-native', canon(persisted));
      return controls.clearedNativeSessions;
    },
    buildHandoffCheckpoint: args => {
      note('checkpoint-args', canon(args));
      return { ...controls.checkpoint };
    },
    rememberActiveCliState: persisted => { note('remember-cli', canon(persisted)); },
    saveBestEffort: () => {},
    trackPendingMemoryDistill: () => {},
    chatStream: {
      close(session) { note('stream-close', canon(session)); },
      status: () => null,
    },
    logger,
    now: clock,
    setImmediate: fakeSetImmediate,
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
    randomBytes: size => Buffer.alloc(size, 7),
    auxSessionId: 'aux',
    taskShortCode,
    retentionPolicy,
    maxMessages: 7,
    historyPageSize: 2,
    memoryDistillBatch: 2,
    incrementalSaveDelayMs: 5000,
  };
  if (options.project !== 'absent') deps.projectMessages = projectMessages;
  // rotateNativeContext 只有在三个端口同时存在时才能通过 rotationReady 闸门。
  if (options.rotationDeps !== false) {
    deps.getSessionRunState = session => {
      note('run-state', canon(session));
      return controls.runState;
    };
    deps.getActiveBackgroundTasks = session => {
      note('background', canon(session));
      return controls.backgroundTasks;
    };
    deps.sessionPersistence = {
      mutate(name, callback) {
        note('persist-mutate', name);
        if (controls.mutateThrow) throw new Error('persist boom');
        const result = callback();
        note('persist-mutated', persistedSnapshot());
        return result;
      },
    };
  }

  const h = {
    kind,
    dataDir,
    raw,
    history,
    deps,
    controls,
    trace,
    note,
    chatSessions,
    idFactory,
    seedSession,
    seedPersisted,
    persistedSnapshot,
    sessionProxy,
    fireTimers,
    flushImmediates,
    snapshotSessions,
    snapshotFiles: () => snapshotDir(dataDir),
    api: implementation.createChatHistoryRuntime(deps),
  };
  return h;
}

function makePair(options = {}) {
  return [createHarness('legacy', options), createHarness('native', options)];
}

async function settle() {
  await Promise.resolve();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
}

async function step(pair, name, action) {
  const captured = [];
  for (const h of pair) {
    h.trace.length = 0;
    let outcome;
    try {
      outcome = { returned: canon(await action(h)) };
    } catch (error) {
      outcome = { threw: errorCanon(error) };
    }
    await settle();
    h.flushImmediates();
    await settle();
    captured.push({
      outcome,
      trace: h.trace.slice(),
      files: h.snapshotFiles(),
      sessions: h.snapshotSessions(),
      persisted: h.persistedSnapshot(),
    });
  }
  assert.deepEqual(
    captured[0], captured[1],
    `"${name}" diverged\nlegacy: ${safeJson(captured[0])}\nnative: ${safeJson(captured[1])}`,
  );
  return captured;
}

function messageOf(role, content, extra = {}) {
  return { role, content, ...extra };
}

// ── 模块表面 ──────────────────────────────────────────────────────────────
test('模块导出与运行时表面与旧实现一致', () => {
  assert.deepEqual(Object.keys(native).sort(), Object.keys(legacy).sort());
  const [legacyHarness, nativeHarness] = makePair();
  assert.equal(Object.isFrozen(legacyHarness.api), true);
  assert.equal(Object.isFrozen(nativeHarness.api), true);
  assert.deepEqual(Object.keys(nativeHarness.api).sort(), Object.keys(legacyHarness.api).sort());
  assert.equal(typeof nativeHarness.api.service.read, 'function');
});

test('死依赖：新运行时不再要求 saveBestEffort / trackPendingMemoryDistill', () => {
  const nativeHarness = createHarness('native');
  const deps = { ...nativeHarness.deps };
  delete deps.saveBestEffort;
  delete deps.trackPendingMemoryDistill;
  assert.equal(Object.isFrozen(native.createChatHistoryRuntime(deps)), true);

  const legacyHarness = createHarness('legacy');
  for (const name of ['saveBestEffort', 'trackPendingMemoryDistill']) {
    const missing = { ...legacyHarness.deps, [name]: undefined };
    assert.throws(
      () => legacy.createChatHistoryRuntime(missing),
      new RegExp(`chat history dependency missing: ${name}`),
    );
  }
});

// ── 纯规则 ────────────────────────────────────────────────────────────────
test('publicCommittedMessage / buildReplayMessages 与旧实现一致', () => {
  const now = () => 1700000001234;
  const cases = [
    null,
    undefined,
    'x',
    0,
    {},
    { role: 'assistant', id: 'a1', content: 'hi' },
    { role: 'user', id: 123, content: 'hello', ts: '42' },
    { role: 'user', id: 'u1', content: 0, ts: null },
    { role: 'user', id: 'u2', content: '', ts: 'not-a-number', clientMsgId: 'c1'.repeat(100) },
    {
      role: 'user',
      id: 'u3',
      content: 'full',
      ts: 1700000000000,
      clientMsgId: 'client-1',
      answeredQuestionId: 'q-9',
      bgToolUseIds: ['t1', '', 7, 't2'],
      turnId: 'turn-1',
      taskId: 'task-alpha',
      taskName: 'Alpha',
      taskShortCode: 'ZZZZ',
      auxRunId: 'aux-1',
    },
    { role: 'user', id: 'u4', bgToolUseIds: new Array(80).fill('x'.repeat(200)) },
  ];
  for (const input of cases) {
    assert.deepEqual(canon(native.publicCommittedMessage(input)), canon(legacy.publicCommittedMessage(input)));
  }

  const stateCases = [
    undefined,
    null,
    {},
    { currentAssistantText: '', currentToolCalls: [] },
    { currentAssistantText: 'streaming', isStreaming: true },
    { currentAssistantText: 'streaming', currentToolCalls: [{ name: 'x' }], _currentTaskId: 'task-alpha' },
    { currentAssistantText: '', currentToolCalls: [{ name: 'x' }] },
    { currentAssistantText: 'done', _resultSaved: true },
  ];
  const pageCases = [
    [],
    [{ role: 'user', id: 'u1', content: 'hi' }],
    [{ role: 'assistant', id: 'i1', content: 'part', _interim: true }],
    [{ role: 'user', id: 'u1' }, { role: 'assistant', id: 'i1', content: 'part', _interim: true }],
  ];
  for (const page of pageCases) {
    for (const state of stateCases) {
      assert.deepEqual(
        canon(native.buildReplayMessages(page, state, now)),
        canon(legacy.buildReplayMessages(page, state, now)),
      );
    }
  }
});

// ── 追加 / 去重 / 蒸馏 / 复盘 ─────────────────────────────────────────────
test('追加、任务码、时长、去重与蒸馏批次', async () => {
  const pair = makePair();
  const [legacyHarness, nativeHarness] = pair;
  for (const h of pair) {
    h.seedSession('main', {
      _currentTaskId: 'task-alpha',
      _activeTurn: { turnId: 'turn-7' },
      turnStartedAt: h.controls.clock - 5000,
    });
    h.seedSession('dedup', {});
    h.seedSession('aux', {});
  }

  await step(pair, 'append user without id', h => h.api.appendMessage('main', messageOf('user', 'hello world')));
  await step(pair, 'append user explicit ids', h => h.api.appendMessage('main', messageOf('user', 'explicit', {
    id: 'u-fixed', taskId: 'task-beta', turnId: 'turn-fixed', durationMs: 99,
  })));
  await step(pair, 'append assistant with ts', h => h.api.appendMessage('main', messageOf('assistant', 'answer', { ts: h.controls.clock + 2000 })));
  await step(pair, 'append assistant without ts', h => h.api.appendMessage('main', messageOf('assistant', 'no stamp')));
  await step(pair, 'append non-object', h => h.api.appendMessage('main', 'not a message'));
  await step(pair, 'append null', h => h.api.appendMessage('main', null));
  await step(pair, 'idFactory throws', h => {
    h.controls.idFactory = 'throw';
    try {
      return h.api.appendMessage('main', messageOf('user', 'boom'));
    } finally {
      h.controls.idFactory = 'ok';
    }
  });
  await step(pair, 'write failure', h => {
    h.controls.failWrite = new Error('history write failed');
    try {
      return h.api.appendMessage('main', messageOf('user', 'will fail'));
    } finally {
      h.controls.failWrite = null;
    }
  });

  // 去重：相同最终助手内容会丢弃上一条，进入蒸馏缓冲（batch=2）。
  await step(pair, 'dedup first', h => h.api.appendMessage('dedup', messageOf('assistant', 'duplicate content long enough')));
  await step(pair, 'dedup second', h => h.api.appendMessage('dedup', messageOf('assistant', 'duplicate content long enough')));
  await step(pair, 'dedup third (distill)', h => h.api.appendMessage('dedup', messageOf('assistant', 'duplicate content long enough')));
  await step(pair, 'dedup fourth', h => h.api.appendMessage('dedup', messageOf('assistant', 'duplicate content long enough')));
  await step(pair, 'dedup fifth (distill again)', h => h.api.appendMessage('dedup', messageOf('assistant', 'duplicate content long enough')));
  // aux 会话不进入蒸馏缓冲。
  await step(pair, 'aux dedup first', h => h.api.appendMessage('aux', messageOf('assistant', 'aux duplicate content long enough')));
  await step(pair, 'aux dedup second', h => h.api.appendMessage('aux', messageOf('assistant', 'aux duplicate content long enough')));
  await step(pair, 'aux dedup third', h => h.api.appendMessage('aux', messageOf('assistant', 'aux duplicate content long enough')));

  // 蒸馏同步抛错 / 异步拒绝都会记日志，并且缓冲仍然被清空。
  await step(pair, 'distill sync throw', h => {
    h.controls.distill = 'syncThrow';
    try {
      return [h.api.appendMessage('dedup', messageOf('assistant', 'sync throw content 123456')), h.api.appendMessage('dedup', messageOf('assistant', 'sync throw content 123456'))];
    } finally {
      h.controls.distill = 'ok';
    }
  });
  await step(pair, 'distill async reject', h => {
    h.controls.distill = 'reject';
    try {
      return [h.api.appendMessage('dedup', messageOf('assistant', 'async reject content 1234')), h.api.appendMessage('dedup', messageOf('assistant', 'async reject content 1234'))];
    } finally {
      h.controls.distill = 'ok';
    }
  });

  // 复盘调度：最终、非去重、非 interim 的助手消息触发 setImmediate。
  await step(pair, 'review scheduled and run', h => {
    const result = h.api.appendMessage('main', messageOf('assistant', 'final review trigger'));
    h.flushImmediates();
    return result;
  });
  await step(pair, 'review failure logged', h => {
    h.controls.review = 'throw';
    try {
      const result = h.api.appendMessage('main', messageOf('assistant', 'final review fails'));
      h.flushImmediates();
      return result;
    } finally {
      h.controls.review = 'ok';
    }
  });
  await step(pair, 'interim append does not review', h => {
    const result = h.api.appendMessage('main', messageOf('assistant', 'interim', { _interim: true }));
    h.flushImmediates();
    return result;
  });
  for (const flag of ['cancelled', 'partial', 'error', '_interim']) {
    await step(pair, `flag ${flag} does not review`, h => {
      const result = h.api.appendMessage('main', messageOf('assistant', `flagged ${flag}`, { [flag]: true }));
      h.flushImmediates();
      return result;
    });
  }
  await step(pair, 'review after stop is suppressed', h => {
    const result = h.api.appendMessage('main', messageOf('assistant', 'queued review'));
    h.api.stop();
    h.flushImmediates();
    return [result, h.api.stop()];
  });

  // 停止后仍可追加（历史写入不因 stop 关闭），只是不再调度复盘。
  await step(pair, 'append after stop', h => h.api.appendMessage('main', messageOf('assistant', 'after stop')));

  assert.equal(legacyHarness.api.hasIncrementalSave('x'), nativeHarness.api.hasIncrementalSave('x'));
});

test('服务事件：remove / delete 广播与可见性失效', async () => {
  const pair = makePair();
  const [legacyHarness, nativeHarness] = pair;
  for (const h of pair) h.seedSession('clean', {});

  await step(pair, 'append then service remove', h => {
    h.api.appendMessage('clean', { role: 'user', id: 'a1', content: 'to remove' });
    return h.api.service.remove('clean', 'a1');
  });
  await step(pair, 'hide then external visibility delete + session delete', h => {
    h.api.appendMessage('clean', { role: 'user', id: 'a2', content: 'hide me' });
    h.api.hideMessages('clean', ['a2']);
    const visibilityFile = h.raw.visibilityFileFor('clean');
    if (fs.existsSync(visibilityFile)) fs.rmSync(visibilityFile);
    const deleted = h.api.service.deleteSession('clean');
    h.api.appendMessage('clean', { role: 'user', id: 'a2', content: 'visible again' });
    return { deleted, projected: h.api.projectedMessages('clean') };
  });
  const visibilityFile = legacyHarness.raw.visibilityFileFor('clean');
  assert.equal(fs.existsSync(visibilityFile), false, 'legacy: session delete drops display state');
  assert.equal(fs.existsSync(nativeHarness.raw.visibilityFileFor('clean')), false, 'native: session delete drops display state');
  assert.deepEqual(
    legacyHarness.api.projectedMessages('clean').map(message => message.id),
    ['a2'],
    'legacy: the re-appended message is visible again',
  );
  assert.deepEqual(
    nativeHarness.api.projectedMessages('clean').map(message => message.id),
    ['a2'],
    'native: the re-appended message is visible again',
  );
});

// ── 可见性 / 过滤 ─────────────────────────────────────────────────────────
test('隐藏消息：quiet、非 quiet、失败与未知 id', async () => {
  const pair = makePair();
  for (const h of pair) {
    h.seedSession('main', {});
    for (let index = 0; index < 6; index += 1) {
      h.raw.write('main', [
        { role: 'user', id: `seed-${index}`, content: `seed ${index}`, ts: h.controls.clock + index },
      ]);
    }
    // 直接种入完整历史（覆盖上面的单条写入）。
    h.raw.write('main', Array.from({ length: 6 }, (_value, index) => ({
      role: 'user', id: `seed-${index}`, content: `seed ${index}`, ts: h.controls.clock + index,
    })));
    h.raw.write('aux', Array.from({ length: 5 }, (_value, index) => ({
      role: 'user', id: `aux-${index}`, content: `aux ${index}`, ts: h.controls.clock + index,
    })));
    h.api.service.invalidate('main');
    h.api.service.invalidate('aux');
  }

  await step(pair, 'projected bounded by maxMessages', h => h.api.projectedMessages('main'));
  await step(pair, 'projected aux bounded by retention policy', h => h.api.projectedMessages('aux'));
  await step(pair, 'hide quiet', h => h.api.hideMessages('main', ['seed-1', 'seed-1', 'seed-2', 'missing', 7], { quiet: true }));
  await step(pair, 'hide non-quiet', h => h.api.hideMessages('main', ['seed-0', 'seed-1', null, '', 'seed-9']));
  await step(pair, 'hide non-quiet already hidden', h => h.api.hideMessages('main', ['seed-0']));
  await step(pair, 'hide quiet on aux (bounded policy)', h => h.api.hideMessages('aux', ['aux-0', 'aux-4'], { quiet: true }));
  await step(pair, 'projected after hides', h => h.api.projectedMessages('main'));
  await step(pair, 'projected includeHidden', h => h.api.projectedMessages('main', true));
  await step(pair, 'visibility write failure (quiet throws)', h => {
    h.controls.failVisibilityWrite = new Error('visibility write failed');
    try {
      return h.api.hideMessages('main', ['seed-4'], { quiet: true });
    } finally {
      h.controls.failVisibilityWrite = null;
    }
  });
  await step(pair, 'visibility write failure (non-quiet logs)', h => {
    h.controls.failVisibilityWrite = new Error('visibility write failed');
    try {
      return h.api.hideMessages('main', ['seed-4', 'seed-5']);
    } finally {
      h.controls.failVisibilityWrite = null;
    }
  });
  await step(pair, 'broadcast failure while hiding', h => {
    h.controls.onBroadcast = () => { throw new Error('broadcast boom'); };
    try {
      return h.api.hideMessages('main', ['seed-3']);
    } finally {
      h.controls.onBroadcast = null;
    }
  });

  // 缺少 writeVisibility：旧实现抛 TypeError，原生同样抛出。
  const missingPair = makePair({ dropVisibilityWrite: true });
  for (const h of missingPair) h.seedSession('main', {});
  await step(missingPair, 'missing writeVisibility', h => {
    h.api.appendMessage('main', { role: 'user', id: 'x1', content: 'hi' });
    return h.api.hideMessages('main', ['x1'], { quiet: true });
  });
});

// ── 分页 ──────────────────────────────────────────────────────────────────
test('分页边界：before / around / limit / not-found / 克隆隔离', async () => {
  const pair = makePair();
  for (const h of pair) {
    h.seedSession('main', {});
    const messages = Array.from({ length: 7 }, (_value, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      id: `p-${index}`,
      content: `page ${index}`,
      ts: h.controls.clock + index * 10,
      ...(index % 2 === 0 ? { taskId: 'task-alpha' } : {}),
    }));
    h.raw.write('main', messages);
    h.api.service.invalidate('main');
  }

  await step(pair, 'paginate default', h => h.api.paginate('main'));
  await step(pair, 'paginate limit string', h => h.api.paginate('main', { limit: '3' }));
  await step(pair, 'paginate limit zero falls back', h => h.api.paginate('main', { limit: 0 }));
  await step(pair, 'paginate limit negative clamps to 1', h => h.api.paginate('main', { limit: -3 }));
  await step(pair, 'paginate limit huge clamps to 100', h => h.api.paginate('main', { limit: 500 }));
  await step(pair, 'paginate before middle', h => h.api.paginate('main', { before: 'p-4', limit: 2 }));
  await step(pair, 'paginate before first', h => h.api.paginate('main', { before: 'p-0' }));
  await step(pair, 'paginate before missing', h => h.api.paginate('main', { before: 'nope' }));
  await step(pair, 'paginate around middle', h => h.api.paginate('main', { around: 'p-3', limit: 3 }));
  await step(pair, 'paginate around first', h => h.api.paginate('main', { around: 'p-0', limit: 3 }));
  await step(pair, 'paginate around last', h => h.api.paginate('main', { around: 'p-6', limit: 3 }));
  await step(pair, 'paginate around missing', h => h.api.paginate('main', { around: 'nope', limit: 3 }));
  await step(pair, 'paginate around with includeHidden', h => h.api.paginate('main', { around: 'p-2', includeHidden: true }));
  await step(pair, 'paginate hidden filtered', h => {
    h.api.hideMessages('main', ['p-6']);
    return h.api.paginate('main', { limit: 100 });
  });
  await step(pair, 'paginate clone isolation', h => {
    const page = h.api.paginate('main', { limit: 2 });
    page.messages[0].content = 'MUTATED';
    page.messages[0].taskShortCode = 'HACK';
    return { page, view: h.api.viewHistory('main') };
  });
  await step(pair, 'paginate on unknown session', h => h.api.paginate('ghost'));

  await step(pair, 'projection identity', h => {
    h.controls.project = 'identity';
    return h.api.projectedMessages('main');
  });
  await step(pair, 'projection tag', h => {
    h.controls.project = 'tag';
    try { return h.api.projectedMessages('main'); } finally { h.controls.project = 'identity'; }
  });
  await step(pair, 'projection undefined falls back', h => {
    h.controls.project = 'undefined';
    try { return h.api.projectedMessages('main'); } finally { h.controls.project = 'identity'; }
  });
  await step(pair, 'projection throws falls back and logs', h => {
    h.controls.project = 'throw';
    try { return h.api.projectedMessages('main'); } finally { h.controls.project = 'identity'; }
  });
  const absentPair = makePair({ project: 'absent' });
  for (const h of absentPair) {
    h.seedSession('main', {});
    h.raw.write('main', [
      { role: 'user', id: 'a', content: 'a', taskId: 'task-alpha' },
      { role: 'user', id: 'b', content: 'b' },
    ]);
  }
  await step(absentPair, 'no projector port stamps task codes', h => h.api.projectedMessages('main'));
});

// ── 标注 ──────────────────────────────────────────────────────────────────
test('annotateTurn：按 turnId、锚点回退、补丁与失败', async () => {
  const pair = makePair();
  for (const h of pair) {
    h.seedSession('main', {});
    h.raw.write('main', [
      { role: 'user', id: 'u1', content: 'q1', turnId: 't1' },
      { role: 'assistant', id: 'a1', content: 'r1', turnId: 't1' },
      { role: 'user', id: 'u2', content: 'q2' },
      { role: 'assistant', id: 'a2', content: 'r2' },
      { role: 'user', id: 'u3', content: 'q3', turnId: 't3' },
    ]);
    h.api.service.invalidate('main');
  }

  await step(pair, 'annotate by turnId', h => h.api.annotateTurn('main', 't1', {
    taskId: 'task-alpha', taskName: 'Alpha task', auxRunId: 'aux-run-1', taskText: 'ignored on assistant',
  }));
  await step(pair, 'annotate anchor fallback', h => h.api.annotateTurn('main', null, {
    taskId: 'task-beta', taskText: 'user text', taskStart: 11, taskSource: 'manual',
  }, { anchorMessageId: 'a2' }));
  await step(pair, 'annotate no selection', h => h.api.annotateTurn('main', 'missing-turn', {}));
  await step(pair, 'annotate unknown anchor', h => h.api.annotateTurn('main', null, { taskId: 'task-alpha' }, { anchorMessageId: 'nope' }));
  await step(pair, 'annotate replace failure', h => {
    h.controls.failWrite = new Error('history write failed');
    try {
      return h.api.annotateTurn('main', 't1', { taskId: 'task-alpha' });
    } finally {
      h.controls.failWrite = null;
    }
  });
  await step(pair, 'annotate broadcast failure', h => {
    h.controls.onBroadcast = () => { throw new Error('broadcast boom'); };
    try {
      return h.api.annotateTurn('main', 't3', { taskId: 'task-delta' });
    } finally {
      h.controls.onBroadcast = null;
    }
  });
  await step(pair, 'load after annotations', h => h.api.load('main'));
});

// ── 增量保存定时器 ───────────────────────────────────────────────────────
test('增量保存：调度 / 触发 / 清除 / clearAll / stop', async () => {
  const pair = makePair();
  for (const h of pair) {
    h.seedSession('main', { _currentTaskId: 'task-alpha' });
    h.seedSession('other', { _currentTaskId: 'task-beta' });
  }

  await step(pair, 'schedule returns true', h => h.api.scheduleIncrementalSave('main', {
    currentAssistantText: 'short',
  }));
  await step(pair, 'schedule duplicate returns false', h => h.api.scheduleIncrementalSave('main', {
    currentAssistantText: 'short',
  }));
  await step(pair, 'has incremental save', h => h.api.hasIncrementalSave('main'));
  await step(pair, 'fire short text is skipped', h => h.fireTimers());
  await step(pair, 'clear after fire returns false', h => h.api.clearIncrementalSave('main'));
  await step(pair, 'schedule long text with tools', h => h.api.scheduleIncrementalSave('main', {
    currentAssistantText: 'this is a long enough assistant text',
    currentToolCalls: [{ name: 'tool-1' }],
  }));
  await step(pair, 'fire writes interim', h => {
    h.fireTimers();
    return h.api.viewHistory('main');
  });
  await step(pair, 'schedule + clear', h => {
    const scheduled = h.api.scheduleIncrementalSave('main', { currentAssistantText: 'another long enough text' });
    return [scheduled, h.api.clearIncrementalSave('main'), h.api.clearIncrementalSave('main')];
  });
  await step(pair, 'clearAll ordering', h => {
    const first = h.api.scheduleIncrementalSave('main', { currentAssistantText: 'main long enough text' });
    const second = h.api.scheduleIncrementalSave('other', { currentAssistantText: 'other long enough text' });
    return [first, second, h.api.clearAllIncrementalSaves(), h.api.hasIncrementalSave('main'), h.api.hasIncrementalSave('other')];
  });
  await step(pair, 'tick with falsy state', h => {
    h.api.scheduleIncrementalSave('main', null);
    h.fireTimers();
    return h.api.viewHistory('main');
  });
  await step(pair, 'tick with long text but no tools', h => {
    h.api.scheduleIncrementalSave('main', { currentAssistantText: 'no tools but long enough text' });
    h.fireTimers();
    return h.api.viewHistory('main');
  });
  await step(pair, 'tick write failure logs', h => {
    h.api.scheduleIncrementalSave('main', { currentAssistantText: 'will fail to persist long text' });
    h.controls.failWrite = new Error('history write failed');
    try { h.fireTimers(); } finally { h.controls.failWrite = null; }
    return h.api.viewHistory('main');
  });
  await step(pair, 'tick stamping failure logs (task code port throws)', h => {
    h.api.scheduleIncrementalSave('main', {
      currentAssistantText: 'stamping fails with long text',
      _currentTaskId: 'task-alpha',
    });
    const saved = h.controls.taskCode;
    h.controls.taskCode = 'throw';
    try { h.fireTimers(); } finally { h.controls.taskCode = saved; }
    return h.api.viewHistory('main');
  });
  await step(pair, 'schedule after stop', h => {
    h.api.stop();
    return [h.api.scheduleIncrementalSave('main', { currentAssistantText: 'after stop long text' }), h.api.clearAllIncrementalSaves()];
  });
});

// ── 最近活动 / 最新助手时间 ───────────────────────────────────────────────
test('lastActivity 与 latestAssistantAt / viewHistory', async () => {
  const pair = makePair();
  for (const h of pair) {
    h.seedSession('main', {});
    h.seedSession('empty', {});
    h.raw.write('main', [
      { role: 'user', id: 'u1', content: 'q', ts: h.controls.clock },
      { role: 'assistant', id: 'a1', content: 'r', ts: h.controls.clock + 5000 },
    ]);
    h.api.service.invalidate('main');
  }
  await step(pair, 'latest assistant at', h => h.api.latestAssistantAt('main'));
  await step(pair, 'latest assistant at empty', h => h.api.latestAssistantAt('empty'));
  await step(pair, 'lastActivity saved only', h => h.api.lastActivity('main'));
  await step(pair, 'lastActivity live later', h => h.api.lastActivity('main', { lastActivity: h.controls.clock + 9000 }));
  await step(pair, 'lastActivity live earlier', h => h.api.lastActivity('main', { lastActivity: h.controls.clock + 1000 }));
  await step(pair, 'lastActivity live equal', h => h.api.lastActivity('main', { lastActivity: new Date(h.controls.clock + 5000) }));
  await step(pair, 'lastActivity invalid live', h => h.api.lastActivity('main', { lastActivity: 'not a date' }));
  await step(pair, 'lastActivity empty with live', h => h.api.lastActivity('empty', { lastActivity: h.controls.clock }));
  await step(pair, 'lastActivity empty without live', h => h.api.lastActivity('empty'));
  await step(pair, 'viewHistory', h => h.api.viewHistory('main'));
  await step(pair, 'load clones', h => {
    const first = h.api.load('main');
    first[0].content = 'MUTATED';
    return { first, second: h.api.load('main') };
  });
  await step(pair, 'read failure propagates', h => {
    h.controls.failRead = new Error('read boom');
    try { return h.api.load('main'); } finally { h.controls.failRead = null; }
  });
});

// ── 重入 ──────────────────────────────────────────────────────────────────
test('端口同步重入：广播与蒸馏回调重入运行时', async () => {
  const pair = makePair();
  for (const h of pair) {
    h.seedSession('main', {});
    h.seedSession('dedup', {});
  }
  await step(pair, 'broadcast reenters runtime scheduling', h => {
    h.controls.onBroadcast = () => {
      h.api.scheduleIncrementalSave('main', { currentAssistantText: 'reentrant long enough text' });
    };
    try {
      return [h.api.appendMessage('main', messageOf('user', 'reentrant')),
        h.api.hasIncrementalSave('main')];
    } finally {
      h.controls.onBroadcast = null;
    }
  });
  await step(pair, 'broadcast reenters hideMessages', h => {
    h.api.appendMessage('main', messageOf('user', 'to hide later'));
    h.controls.onBroadcast = () => {
      h.api.hideMessages('main', ['id-1'], { quiet: true });
    };
    try {
      return h.api.appendMessage('main', messageOf('user', 'reentrant hide'));
    } finally {
      h.controls.onBroadcast = null;
    }
  });
  await step(pair, 'distill port reenters appendMessage', h => {
    h.controls.onDistill = () => {
      h.api.appendMessage('main', messageOf('user', 'from distill reentry'));
    };
    try {
      h.api.appendMessage('dedup', messageOf('assistant', 'reentrant dup content 1'));
      return h.api.appendMessage('dedup', messageOf('assistant', 'reentrant dup content 1'));
    } finally {
      h.controls.onDistill = null;
    }
  });
  await step(pair, 'view after reentrancy', h => h.api.viewHistory('main'));
});

// ── 追加：原地写入与克隆隔离 ─────────────────────────────────────────────
test('appendMessage 原地写入调用者对象，load 返回克隆', async () => {
  const pair = makePair();
  const captured = await step(pair, 'append mutates the caller message in place', h => {
    h.seedSession('inplace', {
      _currentTaskId: 'task-alpha',
      _activeTurn: { turnId: 'turn-inplace' },
      turnStartedAt: h.controls.clock - 4000,
    });
    const message = messageOf('assistant', 'in place mutation');
    const appended = h.api.appendMessage('inplace', message);
    const loaded = h.api.load('inplace');
    return {
      appended,
      message,
      loaded,
      sameObject: loaded[0] === message,
      loadedFrozen: Object.isFrozen(loaded[0]),
      messageFrozen: Object.isFrozen(message),
    };
  });
  const fieldOf = outcomeField;
  for (const [index, label] of [[0, 'legacy'], [1, 'native']]) {
    assert.deepEqual(fieldOf(captured[index], 'sameObject'), { t: 'boolean', v: false }, `${label}: load must clone`);
    assert.deepEqual(fieldOf(captured[index], 'loadedFrozen'), { t: 'boolean', v: false }, `${label}: loaded clone stays mutable`);
    assert.deepEqual(fieldOf(captured[index], 'messageFrozen'), { t: 'boolean', v: false }, `${label}: caller object stays mutable`);
    const message = fieldOf(captured[index], 'message');
    for (const name of ['id', 'taskId', 'turnId', 'taskShortCode', 'durationMs']) {
      assert.ok(message.keys.some(([key]) => key === name), `${label}: append must stamp ${name} on the caller object`);
    }
  }
});

// ── clearHistory：keep 边界 / interim 尾部 / 已隐藏 / 持久化失败 ─────────
function completedMessages(session, count) {
  return Array.from({ length: count }, (_value, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    id: `${session}-${index}`,
    content: `${session} message ${index}`,
    ts: 1700000000000 + index,
  }));
}

function traceIndexOf(trace, predicate) {
  return trace.findIndex(entry => predicate(entry));
}

test('clearHistory：keep 边界、interim 尾部、已隐藏、失败与返回形状', async () => {
  const pair = makePair();
  for (const h of pair) {
    h.seedSession('keep0', {});
    h.seedSession('keepn', {});
    h.seedSession('interim', {});
    h.seedSession('hidden', {});
    h.seedSession('fail', {});
    h.raw.write('keep0', completedMessages('keep0', 5));
    h.raw.write('keepn', completedMessages('keepn', 5));
    h.raw.write('interim', completedMessages('interim', 3));
    h.raw.write('hidden', completedMessages('hidden', 5));
    h.raw.write('fail', completedMessages('fail', 3));
    h.api.service.invalidate('keep0');
    h.api.service.invalidate('keepn');
    h.api.service.invalidate('interim');
    h.api.service.invalidate('hidden');
    h.api.service.invalidate('fail');
  }

  const cleared = await step(pair, 'clear keep 0', h => h.api.clearHistory('keep0', { keep: '0' }));
  for (const [index, label] of [[0, 'legacy'], [1, 'native']]) {
    const returned = cleared[index].outcome.returned;
    assert.deepEqual(
      returned.keys.map(([key]) => key),
      ['keep', 'removedCount', 'retainedCount', 'clearedNativeSessions'],
      `${label}: clear return shape`,
    );
    assert.equal(returned.frozen, true, `${label}: clear return must be frozen`);
    const write = traceIndexOf(cleared[index].trace, entry => entry[0] === 'history' && entry[1] === 'writeVisibility' && entry[2] === 'ok');
    const broadcast = traceIndexOf(cleared[index].trace, entry => entry[0] === 'broadcast');
    assert.ok(write !== -1 && broadcast !== -1 && write < broadcast,
      `${label}: durable display clear must precede the reset broadcast`);
  }

  await step(pair, 'clear keep default (missing message)', h => h.api.clearHistory('keepn'));
  await step(pair, 'clear keep 2 of 5', h => h.api.clearHistory('keepn', { keep: 2 }));
  await step(pair, 'clear keep larger than view', h => h.api.clearHistory('keepn', { keep: '99' }));
  await step(pair, 'clear keep negative clamps to 0', h => h.api.clearHistory('keepn', { keep: -4 }));
  await step(pair, 'clear keep non-numeric falls back to 0', h => h.api.clearHistory('keepn', { keep: 'abc' }));
  const interimCleared = await step(pair, 'clear with interim tail keeps the interim', h => {
    h.api.appendMessage('interim', messageOf('assistant', 'streaming tail', { id: 'interim-live', _interim: true }));
    return h.api.clearHistory('interim', { keep: 0 });
  });
  // 旧实现用整个可见视图（含 _interim 流式尾）计算 retainedCount。
  for (const [index, label] of [[0, 'legacy'], [1, 'native']]) {
    assert.equal(outcomeNumber(interimCleared[index], 'removedCount'), 3, `${label}: three completed messages removed`);
    assert.equal(outcomeNumber(interimCleared[index], 'retainedCount'), 1, `${label}: the interim tail is retained`);
  }
  await step(pair, 'clear after hiding one message', h => {
    h.api.hideMessages('hidden', ['hidden-1'], { quiet: true });
    return h.api.clearHistory('hidden', { keep: 0 });
  });
  await step(pair, 'clear broadcast with displayOnly payload', h => {
    h.api.appendMessage('keep0', messageOf('user', 'after clear'));
    return h.api.clearHistory('keep0', { keep: 0 });
  });
  await step(pair, 'clear durable failure throws and never broadcasts', h => {
    h.controls.failVisibilityWrite = new Error('visibility write failed');
    try {
      return h.api.clearHistory('fail', { keep: 0 });
    } finally {
      h.controls.failVisibilityWrite = null;
    }
  });
  await step(pair, 'clear still works after stop', h => {
    h.api.stop();
    return h.api.clearHistory('fail', { keep: 0 });
  });
});

// ── rotateNativeContext：闸门 / 复用 / 成功 / 失败 ───────────────────────
test('rotateNativeContext：闸门、复用、成功与失败路径', async () => {
  const pair = makePair();
  for (const h of pair) {
    h.seedSession('rot-ok', { chatTurnCount: 5 });
    h.seedPersisted('rot-ok', {});
    h.seedPersisted('task-kind', { kind: 'task' });
    h.seedPersisted('pending-other', {
      pendingCliHandoff: { id: 'cp-other', status: 'pending', reason: 'other' },
    });
    h.seedPersisted('pending-manual', {
      pendingCliHandoff: { id: 'cp-manual', status: 'pending', reason: 'manual_native_context_rotate' },
    });
    h.seedPersisted('busy', {});
    h.seedPersisted('background', {});
    h.seedPersisted('rot-fail', {});
  }

  await step(pair, 'rotate unknown session', h => h.api.rotateNativeContext('ghost'));
  await step(pair, 'rotate non-chat kind', h => h.api.rotateNativeContext('task-kind'));
  await step(pair, 'rotate pending handoff of another reason', h => h.api.rotateNativeContext('pending-other'));
  await step(pair, 'rotate pending manual handoff reused', h => h.api.rotateNativeContext('pending-manual'));
  for (const state of ['queued', 'running', 'assessing']) {
    await step(pair, `rotate blocked by runState ${state}`, h => {
      h.controls.runState = state;
      try { return h.api.rotateNativeContext('busy', { chatTurnCount: 2 }); } finally { h.controls.runState = 'idle'; }
    });
  }
  await step(pair, 'rotate blocked by background tasks', h => {
    h.controls.backgroundTasks = [{ id: 'bg-1' }];
    try { return h.api.rotateNativeContext('background', { chatTurnCount: 2 }); } finally { h.controls.backgroundTasks = []; }
  });
  await step(pair, 'rotate success clears native states and resets the turn counter', h => {
    h.controls.clearedNativeSessions = 3;
    const state = { chatTurnCount: 9 };
    try {
      return { result: h.api.rotateNativeContext('rot-ok', state), state };
    } finally {
      h.controls.clearedNativeSessions = 0;
    }
  });
  await step(pair, 'rotate snapshot failure is wrapped and logged', h => {
    h.controls.snapshotThrow = true;
    try { return h.api.rotateNativeContext('rot-fail', { chatTurnCount: 1 }); } finally { h.controls.snapshotThrow = false; }
  });
  await step(pair, 'rotate persistence failure is wrapped and never broadcasts', h => {
    h.controls.mutateThrow = true;
    try { return h.api.rotateNativeContext('rot-fail', { chatTurnCount: 1 }); } finally { h.controls.mutateThrow = false; }
  });
  await step(pair, 'clearHistory preserveHistory delegates to rotation', h => {
    h.seedPersisted('preserve', {});
    return h.api.clearHistory('preserve', { preserveHistory: true }, { chatTurnCount: 4 });
  });
  await step(pair, 'clearHistory preserveHistory surfaces the rotation failure', h => {
    h.seedPersisted('preserve-fail', {});
    h.controls.snapshotThrow = true;
    try {
      return h.api.clearHistory('preserve-fail', { preserveHistory: true }, { chatTurnCount: 4 });
    } finally {
      h.controls.snapshotThrow = false;
    }
  });

  // 缺少 rotation 三端口：rotationReady=false，直接 session_busy（不读 runState）。
  const blockedPair = makePair({ rotationDeps: false });
  for (const h of blockedPair) h.seedPersisted('no-ports', {});
  await step(blockedPair, 'rotate without rotation ports is session_busy', h => h.api.rotateNativeContext('no-ports'));
});

// ── 固定种子随机多会话序列 ────────────────────────────────────────────────
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function buildRandomOps(count) {
  const random = mulberry32(0xc0ffee);
  const sessions = ['main', 'alpha', 'beta', 'aux', 'small'];
  const pick = list => list[Math.floor(random() * list.length)];
  const ops = [];
  for (let index = 0; index < count; index += 1) {
    const session = pick(sessions);
    switch (Math.floor(random() * 12)) {
      case 0:
        ops.push({ kind: 'append-user', session, index, content: `user ${index} ${'x'.repeat(index % 30)}`, taskId: random() < 0.3 ? 'task-alpha' : undefined });
        break;
      case 1:
        ops.push({ kind: 'append-final', session, index, content: `final ${index} ${'y'.repeat(index % 30)}`, ts: 1700000000000 + index * 3 });
        break;
      case 2:
        ops.push({ kind: 'append-interim', session, index, content: `interim ${index} ${'z'.repeat(index % 30)}` });
        break;
      case 3:
        ops.push({ kind: 'append-dupe', session, index, content: `duplicate random content ${index % 3}` });
        break;
      case 4:
        ops.push({ kind: 'hide-quiet', session, ids: [`rand-${index - 1}`, `rand-${index - 2}`, 'missing'] });
        break;
      case 5:
        ops.push({ kind: 'hide', session, ids: [`rand-${index - 3}`, null, 5] });
        break;
      case 6:
        ops.push({ kind: 'paginate', session, limit: pick([1, 2, 3, '2', 0, -1, 1000]), before: random() < 0.5 ? `rand-${index - 4}` : undefined, around: random() < 0.5 ? `rand-${index - 5}` : undefined });
        break;
      case 7:
        ops.push({ kind: 'annotate', session, index, turnId: random() < 0.5 ? 't-random' : null, anchor: `rand-${index - 1}` });
        break;
      case 8:
        ops.push({ kind: 'schedule', session, text: `scheduled ${index} ${'s'.repeat(index % 40)}` });
        break;
      case 9:
        ops.push({ kind: 'clear-timer', session });
        break;
      case 10:
        ops.push({ kind: 'fire-timers' });
        break;
      default:
        ops.push({ kind: 'read', session, which: pick(['projected', 'last', 'latest', 'view']) });
        break;
    }
  }
  return ops;
}

function applyRandomOp(h, op) {
  switch (op.kind) {
    case 'append-user':
      return h.api.appendMessage(op.session, messageOf('user', op.content, {
        id: `rand-${op.index}`,
        ...(op.taskId ? { taskId: op.taskId } : {}),
      }));
    case 'append-final':
      return h.api.appendMessage(op.session, messageOf('assistant', op.content, {
        id: `rand-${op.index}`,
        ts: op.ts,
      }));
    case 'append-interim':
      return h.api.appendMessage(op.session, messageOf('assistant', op.content, {
        id: `rand-${op.index}`,
        _interim: true,
      }));
    case 'append-dupe':
      return h.api.appendMessage(op.session, messageOf('assistant', op.content, { ts: 1700000000000 + op.index }));
    case 'hide-quiet':
      return h.api.hideMessages(op.session, op.ids, { quiet: true });
    case 'hide':
      return h.api.hideMessages(op.session, op.ids);
    case 'paginate':
      return h.api.paginate(op.session, { limit: op.limit, ...(op.before ? { before: op.before } : {}), ...(op.around ? { around: op.around } : {}) });
    case 'annotate':
      return h.api.annotateTurn(op.session, op.turnId, {
        taskId: 'task-beta', taskName: `n${op.index}`, taskText: 'text',
      }, { anchorMessageId: op.anchor });
    case 'schedule':
      return h.api.scheduleIncrementalSave(op.session, {
        currentAssistantText: op.text,
        _currentTaskId: 'task-alpha',
        currentToolCalls: op.index % 3 === 0 ? [{ name: 'tool' }] : undefined,
      });
    case 'clear-timer':
      return h.api.clearIncrementalSave(op.session);
    case 'fire-timers':
      h.fireTimers();
      return h.api.clearAllIncrementalSaves();
    case 'read':
      if (op.which === 'projected') return h.api.projectedMessages(op.session);
      if (op.which === 'last') return h.api.lastActivity(op.session, { lastActivity: h.controls.clock + op.index });
      if (op.which === 'latest') return h.api.latestAssistantAt(op.session);
      return h.api.viewHistory(op.session);
    default:
      throw new Error(`unknown op ${op.kind}`);
  }
}

test('固定种子随机多会话序列（320 步）', async () => {
  const pair = makePair();
  for (const h of pair) {
    h.seedSession('main', { _currentTaskId: 'task-alpha', _activeTurn: { turnId: 'turn-random' }, turnStartedAt: h.controls.clock - 1000 });
    h.seedSession('alpha', { _currentTaskId: 'task-beta' });
    h.seedSession('beta', {});
    h.seedSession('aux', {});
    h.seedSession('small', {});
    h.raw.write('main', [{ role: 'user', id: 'seed-main', content: 'seed', ts: h.controls.clock }]);
    h.raw.write('small', [
      { role: 'user', id: 'small-1', content: 'one', ts: h.controls.clock },
      { role: 'assistant', id: 'small-2', content: 'two', ts: h.controls.clock + 1 },
      { role: 'user', id: 'small-3', content: 'three', ts: h.controls.clock + 2 },
    ]);
    h.api.service.invalidate('main');
    h.api.service.invalidate('small');
  }
  const ops = buildRandomOps(320);
  for (const op of ops) {
    await step(pair, `random ${op.kind}`, h => applyRandomOp(h, op));
  }
  await step(pair, 'random final stop', h => [h.api.stop(), h.api.stop()]);
});
