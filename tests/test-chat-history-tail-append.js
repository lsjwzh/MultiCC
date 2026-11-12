'use strict';

// 尾部增量写的端到端验证：真仓库 + 真 FIFO runtime，不是假端口。
// 差分套件（test-chat-history-runtime-differential.js）的假仓库不产字节
// 回执，账本永不建立、恒走整份——所以 tail 路径的正确性由这里独立证明：
// 首笔全量、后续只写尾巴、interim 原子替换、账本错位整份自愈、文件消失
// 重建、同步 replace 后回退全量。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createChatHistoryRuntime } = require('../src/routes/chat-history');
const { createChatHistoryFileRepository } = require('../src/session/adapters/chat-history-file-repository');

function fixture(t) {
  const dataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-tail-')));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const repository = createChatHistoryFileRepository({ dataDir });
  const counts = { writeAsync: 0, appendAsync: 0 };
  // 仓库实例是冻结对象，展开成可写副本再包计数层。
  const history = { ...repository };
  history.writeAsync = (id, json) => {
    counts.writeAsync += 1;
    return repository.writeAsync(id, json);
  };
  history.appendAsync = (id, payload) => {
    counts.appendAsync += 1;
    return repository.appendAsync(id, payload);
  };
  let sequence = 0;
  const timers = new Map();
  const runtime = createChatHistoryRuntime({
    history,
    persistedSessions: new Map([['s1', { id: 's1', kind: 'chat', cli: 'claude' }]]),
    chatSessions: new Map([['s1', {}]]),
    idFactory: () => `tail-${++sequence}`,
    now: () => 1700000000000,
    chatBroadcast() {},
    distillHistoryIntoMemory() { return Promise.resolve(); },
    maybeSchedulePeriodicMemoryReview() {},
    async cliSwitchGitSnapshot() { return {}; },
    chatStream: { close() {} },
    clearAllNativeCliStates() { return 0; },
    buildHandoffCheckpoint() { return {}; },
    rememberActiveCliState() {},
    saveBestEffort() {},
    trackPendingMemoryDistill(_sessionId, promise) { return promise; },
    setImmediate() { return { unref() {} }; },
    setTimeout(callback) {
      const id = `timer-${++sequence}`;
      timers.set(id, callback);
      return { unref() {} };
    },
    clearTimeout() {},
    logger: { warn() {} },
  });
  t.after(() => runtime.stop());
  const fileFor = sessionId => repository.fileFor(sessionId);
  const readLines = sessionId => {
    try {
      return fs.readFileSync(fileFor(sessionId), 'utf8')
        .split('\n').filter(Boolean).map(line => JSON.parse(line));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  };
  async function waitForFile(sessionId, predicate) {
    const deadline = Date.now() + 5000;
    for (;;) {
      const lines = readLines(sessionId);
      if (lines && predicate(lines)) return lines;
      if (Date.now() > deadline) throw new Error('timed out waiting for the transcript write');
      await new Promise(resolve => setImmediate(resolve));
    }
  }
  function fireTimers() {
    const pending = [...timers.values()];
    timers.clear();
    for (const callback of pending) callback();
  }
  return { runtime, counts, fileFor, readLines, waitForFile, fireTimers };
}

test('first write is a full snapshot, later appends write only the tail', async t => {
  const f = fixture(t);
  await f.runtime.appendMessage('s1', { id: 'a', role: 'user', content: 'one' });
  assert.equal(f.counts.writeAsync, 1);
  assert.equal(f.counts.appendAsync, 0);
  assert.deepEqual(f.readLines('s1').map(m => m.id), ['a']);

  await f.runtime.appendMessage('s1', { id: 'b', role: 'assistant', content: 'two' });
  assert.equal(f.counts.appendAsync, 1, 'second append must take the tail path');
  assert.equal(f.counts.writeAsync, 1);
  assert.deepEqual(f.readLines('s1').map(m => m.id), ['a', 'b']);

  // 第三笔仍是 tail；账本随每笔提交滚动。
  await f.runtime.appendMessage('s1', { id: 'c', role: 'user', content: 'three' });
  assert.equal(f.counts.appendAsync, 2);
  assert.deepEqual(f.readLines('s1').map(m => m.id), ['a', 'b', 'c']);
});

test('interim replacements are atomic and use clones when supported', async t => {
  const f = fixture(t);
  await f.runtime.appendMessage('s1', { id: 'a', role: 'assistant', content: 'final answer' });
  assert.equal(f.counts.writeAsync, 1);

  f.runtime.scheduleIncrementalSave('s1', { currentAssistantText: 'a long enough interim text' });
  f.fireTimers();
  await f.waitForFile('s1', lines => lines.length === 2);
  assert.equal(f.counts.appendAsync, 1, 'interim after a committed write must be a tail append');
  let lines = f.readLines('s1');
  assert.equal(lines[1]._interim, true);
  assert.equal(lines[1].content, 'a long enough interim text');

  // 流式推进：支持克隆时只更新副本尾部，否则回退原子全量重写。
  f.runtime.scheduleIncrementalSave('s1', { currentAssistantText: 'a long enough interim text, longer now' });
  f.fireTimers();
  await f.waitForFile('s1', current => current.length === 2 && current[1].content.endsWith('longer now'));
  assert.equal(f.counts.appendAsync, 2);
  const cloned = f.counts.writeAsync === 1;
  assert.equal(f.counts.writeAsync, cloned ? 1 : 2);
  lines = f.readLines('s1');
  assert.deepEqual(lines.map(m => m.id).slice(0, 1), ['a']);
  assert.ok(lines[1]._interim, 'second line stays the interim row');
  assert.equal(lines[0].content, 'final answer');

  // 正式消息替换 interim，仍使用相同的安全发布方式。
  await f.runtime.appendMessage('s1', { id: 'u', role: 'assistant', content: 'real final answer' });
  lines = f.readLines('s1');
  assert.deepEqual(lines.map(m => m.id), ['a', 'u']);
  assert.equal(f.counts.appendAsync, 3);
  assert.equal(f.counts.writeAsync, cloned ? 1 : 3);
});

test('tail replacement publishes the full new record or safely refuses', async t => {
  const dataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-tail-refuse-')));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const repository = createChatHistoryFileRepository({ dataDir });
  await repository.writeAsync('s1', JSON.stringify([{ id: 'a' }, { id: 'b' }]));
  const file = repository.fileFor('s1');
  const before = fs.readFileSync(file);
  const keepBytes = Buffer.byteLength('{"id":"a"}\n');
  const result = await repository.appendAsync('s1', {
    tail: JSON.stringify([{ id: 'replacement' }]), keepBytes, expectedBytes: before.length, keepLines: 1,
  });
  if (result.appended) {
    assert.deepEqual(fs.readFileSync(file, 'utf8'), '{"id":"a"}\n{"id":"replacement"}\n');
  } else {
    assert.deepEqual(fs.readFileSync(file), before);
  }
});

test('a ledger mismatch falls back to one full rewrite and self-heals', async t => {
  const f = fixture(t);
  await f.runtime.appendMessage('s1', { id: 'a', role: 'user', content: 'one' });
  assert.equal(f.counts.writeAsync, 1);

  // 外部改写：账本里的 expected_bytes 与文件现状对不上。
  fs.appendFileSync(f.fileFor('s1'), '{"id":"rogue","role":"user","content":"external"}\n');
  await f.runtime.appendMessage('s1', { id: 'b', role: 'assistant', content: 'two' });
  assert.equal(f.counts.appendAsync, 1, 'the tail write was attempted and refused');
  assert.equal(f.counts.writeAsync, 2, 'the driver resent the full snapshot once');

  const lines = f.readLines('s1');
  assert.deepEqual(lines.map(m => m.id), ['a', 'b'], 'the rogue line is gone after the atomic rewrite');

  // 自愈后账本由整份写的回执重建，下一笔恢复 tail。
  await f.runtime.appendMessage('s1', { id: 'c', role: 'user', content: 'three' });
  assert.equal(f.counts.appendAsync, 2);
  assert.equal(f.counts.writeAsync, 2);
  assert.deepEqual(f.readLines('s1').map(m => m.id), ['a', 'b', 'c']);
});

test('a vanished transcript rebuilds from the full snapshot', async t => {
  const f = fixture(t);
  await f.runtime.appendMessage('s1', { id: 'a', role: 'user', content: 'one' });
  fs.unlinkSync(f.fileFor('s1'));

  await f.runtime.appendMessage('s1', { id: 'b', role: 'assistant', content: 'two' });
  assert.equal(f.counts.appendAsync, 1, 'tail write against a missing file is refused');
  assert.equal(f.counts.writeAsync, 2);
  assert.deepEqual(f.readLines('s1').map(m => m.id), ['a', 'b']);
});

test('a sync replace invalidates the ledger so the next append is a full write', async t => {
  const f = fixture(t);
  await f.runtime.appendMessage('s1', { id: 'a', role: 'user', content: 'one' });
  await f.runtime.appendMessage('s1', { id: 'b', role: 'assistant', content: 'two' });
  assert.equal(f.counts.appendAsync, 1);

  // replaceHistory 走 FIFO 的同步整份写（persist），不产字节回执 → 账本失效。
  await f.runtime.replaceHistory('s1', [
    { id: 'a', role: 'user', content: 'one' },
    { id: 'b', role: 'assistant', content: 'two' },
  ]);
  await f.runtime.appendMessage('s1', { id: 'c', role: 'user', content: 'three' });
  assert.equal(f.counts.appendAsync, 1, 'no tail write right after a sync replace');
  assert.equal(f.counts.writeAsync, 2);
  assert.deepEqual(f.readLines('s1').map(m => m.id), ['a', 'b', 'c']);

  // 全量重建账本之后恢复 tail。
  await f.runtime.appendMessage('s1', { id: 'd', role: 'assistant', content: 'four' });
  assert.equal(f.counts.appendAsync, 2);
  assert.deepEqual(f.readLines('s1').map(m => m.id), ['a', 'b', 'c', 'd']);
});

test('dropMessages rewrites in place and the following append self-heals', async t => {
  const f = fixture(t);
  await f.runtime.appendMessage('s1', { id: 'a', role: 'user', content: 'one' });
  await f.runtime.appendMessage('s1', { id: 'b', role: 'assistant', content: 'two' });
  await f.runtime.appendMessage('s1', { id: 'c', role: 'user', content: 'three' });
  const tailWrites = f.counts.appendAsync;
  assert.ok(tailWrites >= 1);

  // dropMessages 走同步整份写（persist），账本失效。
  await f.runtime.dropMessages('s1', ['b']);
  assert.deepEqual(f.readLines('s1').map(m => m.id), ['a', 'c']);
  await f.runtime.appendMessage('s1', { id: 'd', role: 'assistant', content: 'four' });
  assert.equal(f.counts.appendAsync, tailWrites, 'first append after the drop is a full rewrite');
  assert.deepEqual(f.readLines('s1').map(m => m.id), ['a', 'c', 'd']);
});
