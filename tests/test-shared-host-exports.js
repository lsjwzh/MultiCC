'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const binding = require('../src/native/binding');
const reference = require('./helpers/shared-hosts-d6430f13.json');
const { observe } = require('./helpers/shared-host-probe.cjs');

// Each observation was captured in a separate process loading d6430f13's
// CommonJS sources and its own compiled addon. Keep export order and arity.
for (const [name, { entry, bootstrap, ...expected }] of Object.entries(reference)) {
  test(`d6430f13 shared host contract: ${entry}`, () => {
    const legacyPath = require(path.resolve(__dirname, '..', entry));
    assert.equal(legacyPath, binding[name]);
    assert.deepEqual(observe(name, binding[name]), expected);
  });
}

test('loading and calling shared entry points before the addon is installed', () => {
  const { execFileSync } = require('node:child_process');
  const result = execFileSync(process.execPath, [
    require.resolve('./helpers/shared-host-probe.cjs'), require.resolve('./helpers/shared-hosts-d6430f13.json'),
  ], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', env: {
    ...process.env, MULTICC_RUST_ADDON: path.join(__dirname, 'fixtures', 'absent-shared-host-addon.node'),
  } });
  const observed = JSON.parse(result);
  for (const [name, row] of Object.entries(reference)) assert.deepEqual(observed[name], row.bootstrap, name);
});

test('常用 Rust 入口运行时直接调用内部实现', t => {
  const native = binding.getNative();
  const calls = [];
  for (const key of [
    'requestLocality', 'cliIsMainResult', 'cliResultCompletion', 'cliCompletion',
    'cliIsCompleted', 'createCliCompletionTracker', 'createStepCompletionTracker',
    'createProtocolCompletionTracker', 'createResultCompletionTracker', 'cliSupportsEffort',
    'cliKnownEffort', 'sessionWorkSchedulerApi', 'sessionWorkHostApi', 'responsesHistoryApi',
    'chatHistoryCleanThinkingBlocks', 'historyServiceWithOwner', 'isVoiceRouter',
    'apiErrorFacts', 'apiErrorSignaturesQuoted', 'apiPolicyDecision', 'apiPolicyNormalized',
    'apiSanitizeMessage', 'apiErrorMetricToken',
  ]) {
    t.mock.method(native, key, () => { calls.push(key); throw Error(key); });
  }
  for (const name of ['requestLocality', 'cliResultCompletion', 'cliCompletion', 'cliCapability',
    'sessionWork', 'modelHistoryConverter', 'codexHistoryHooks', 'chatHistoryService', 'voiceRouter']) {
    const { entry, bootstrap, ...expected } = reference[name];
    assert.deepEqual(observe(name, binding[name]), expected, entry);
  }
  const cli = binding.cliCompletion;
  assert.equal(typeof cli.createStepCompletionTracker().finish, 'function');
  assert.equal(typeof cli.createProtocolCompletionTracker('claude').observe, 'function');
  assert.equal(typeof binding.cliResultCompletion.createResultCompletionTracker().snapshot, 'function');
  assert.equal(typeof binding.cliCapability.knownEffort('high'), 'boolean');
  const policy = binding.apiErrorPolicy;
  assert.equal(policy.sanitizeMessage('ok'), 'ok');
  const outcome = policy.createApiErrorPolicyRuntime().evaluate({ httpStatus: 429 });
  assert.equal(typeof outcome.action, 'string');
  assert.ok(binding.classifyVocab.buildClassifySystemPrompt('').includes(policy.apiErrorSignaturesQuoted()));
  assert.deepEqual(calls, []);
});

test('已加载的策略在切换插件时重新解析，并保留加载异常', t => {
  const fs = require('node:fs');
  const os = require('node:os');
  const policy = binding.apiErrorPolicy;
  const previous = process.env.MULTICC_RUST_ADDON;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-policy-addon-'));
  t.after(() => {
    if (previous === undefined) delete process.env.MULTICC_RUST_ADDON;
    else process.env.MULTICC_RUST_ADDON = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const otherPath = path.join(dir, 'alternate.cjs');
  fs.writeFileSync(otherPath, `module.exports = {
    protocolVersion: () => 1, buildSearchIndex() {}, computeUsage() {}, cprClaudeQuota() {},
    apiSanitizeMessage: () => '来自另一个插件',
  };`);
  process.env.MULTICC_RUST_ADDON = otherPath;
  const other = binding.getNative();
  const forwarded = t.mock.method(other, 'apiSanitizeMessage');
  assert.equal(policy.sanitizeMessage('ok'), '来自另一个插件');
  assert.equal(forwarded.mock.callCount(), 1);
  process.env.MULTICC_RUST_ADDON = path.join(dir, 'missing.node');
  assert.throws(() => policy.sanitizeMessage('ok'), /rust_backend_unavailable/);
});

test('注入的回合所有者保留子类和实例方法覆写', () => {
  const native = binding.getNative();
  class Timeline extends native.RustTurnProgress {
    timelineStart() { return this; }
  }
  const owner = new Timeline(1000, 64);
  const timeline = native.turnProgressApi(native).createTurnTimelinePort(owner);
  assert.equal(timeline.startTurn('s', 't', 10), owner);

  const { createStateOwner, createTurnRuntimeStore } = require('../src/state/owner');
  const state = createStateOwner();
  const store = createTurnRuntimeStore({ owner: state });
  state.native.turnList = function () { return this; };
  assert.equal(store.list(), state.native);
});
