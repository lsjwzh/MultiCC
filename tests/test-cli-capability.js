'use strict';

// The transport/lifecycle split is only real if it has one home. These tests lock
// the table itself and then lock the thing that actually rots: an inline
// `['claude', 'claude-exp']` array reappearing at a call site and quietly becoming
// a second, differently-maintained answer to "which lane is this CLI in".

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  CAPABILITIES,
  DEFAULT_CAPABILITY,
  DISPLAY,
  cancelStopsProcess,
  capabilityOf,
  deprecationOf,
  displayNameOf,
  isDeprecated,
  isResident,
  isResidentSession,
  protocolFamilyOf,
  protocolOf,
  transportOf,
} = require('../src/cli/cli-capability');

const ROOT = path.join(__dirname, '..');
// The historical shape of the bug. `turn-engine.js` alone spelled it out at four
// sites, and eight files carried their own copy.
const INLINE_LANE = /\[\s*'claude'\s*,\s*'claude-exp'\s*\]/;

function jsFiles(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'vendor') continue;
      found.push(...jsFiles(full));
    } else if (entry.name.endsWith('.js')) found.push(full);
  }
  return found;
}

test('the table places each CLI in exactly one lane', () => {
  // codex-exp's protocol (app-server) was always long-lived; the bridge now holds
  // that child across turns, so it moved from the per-turn to the resident lane.
  // Nothing about callers changed — only this table and the runtime that owns the
  // resident child.
  for (const cli of ['claude', 'claude-exp', 'codex-exp']) {
    assert.equal(isResident(cli), true, `${cli} keeps its child across turns`);
    assert.equal(capabilityOf(cli).lifecycle, 'resident');
  }
  for (const cli of ['codex', 'opencode', 'zcode', 'dsh', 'qoder', 'kimi', 'codebuddy', 'gemini', 'grok']) {
    assert.equal(isResident(cli), false, `${cli} is spawned per turn`);
    assert.equal(capabilityOf(cli).lifecycle, 'per-turn');
  }
});

test('a cancel that reaps the child is distinguished from one that interrupts in place', () => {
  // "The runner has stopped" is the child being gone on a lane whose cancel kills
  // it, and merely "no turn in flight" on a lane whose cancel interrupts and
  // keeps the child. Conflating the two either reports a stopped runner that is
  // still running, or waits for a process that is designed to survive.
  assert.equal(cancelStopsProcess('claude'), true);
  assert.equal(cancelStopsProcess('codex-exp'), true);
  assert.equal(cancelStopsProcess('claude-exp'), false, 'the SDK lane interrupts the turn, not the child');
  assert.equal(cancelStopsProcess('codex'), true);
  assert.equal(cancelStopsProcess('not-a-cli'), true, 'the default lane is a per-turn child');
  assert.equal(capabilityOf('claude-exp').cancel, 'turn');
});

test('a session keeps its CLI lane whatever provider it is routed through', () => {
  // This predicate used to narrow the lane: a codex session on a concrete
  // provider leased its CODEX_HOME per attempt, so it had to stay per-turn or a
  // warm child would outlive the credentials it held. Both provider paths now
  // hold a route that outlives the attempt (claude in the rebuilt ANTHROPIC_* env
  // plus a spawn-contract-scoped capability, codex in a session-scoped
  // CODEX_HOME — src/codex/resident-route.js), so routing no longer changes the
  // answer: a resident CLI's session is resident.
  for (const provider of [
    null, '_default_', 'deepseek',
  ]) {
    assert.equal(isResidentSession('codex-exp', { provider }), true,
      `codex-exp stays resident on provider ${provider === null ? '(none)' : provider}`);
  }
  assert.equal(isResidentSession('codex-exp', {}), true, 'no provider recorded yet = the default lane');
  assert.equal(isResidentSession('codex-exp', { provider: 'deepseek', subagent: { providerId: 'kimi' } }), true);
  assert.equal(isResidentSession('codex-exp', { subagent: { providerId: 'kimi' } }), true);
  assert.equal(isResidentSession('claude', { provider: 'zhipu' }), true);
  assert.equal(isResidentSession('claude-exp', { provider: 'zhipu' }), true);
  // Nothing promotes a per-turn CLI into a resident session — the session can no
  // longer widen a lane either, only report the one the CLI is already on.
  assert.equal(isResidentSession('codex', { provider: null }), false);
  assert.equal(isResidentSession('opencode', {}), false);
  assert.equal(isResidentSession(undefined, {}), false);
});

test('an unknown or malformed CLI falls back to the historical per-turn lane', () => {
  for (const cli of [undefined, null, '', '   ', 'not-a-cli', 42]) {
    assert.equal(capabilityOf(cli), DEFAULT_CAPABILITY);
    assert.equal(isResident(cli), false);
    assert.equal(transportOf(cli), 'cli-process');
    assert.equal(protocolOf(cli), 'cli-once');
  }
  assert.deepEqual(DEFAULT_CAPABILITY, { protocol: 'cli-once', lifecycle: 'per-turn', cancel: 'process' });
});

test('CLI names are matched case- and whitespace-insensitively', () => {
  assert.equal(isResident(' Claude-EXP '), true);
  assert.equal(isResident('CLAUDE'), true);
  assert.equal(protocolOf(' Codex-Exp'), 'codex-app-server');
  assert.equal(protocolFamilyOf('CODEX'), 'openai-responses');
});

test('the wire transport names stay the values a minted provider route expects', () => {
  // A route is only accepted for a turn whose transport matches (turn-request.js),
  // so these two strings are a contract with persisted turns, not cosmetics.
  assert.equal(transportOf('claude'), 'claude-stream');
  assert.equal(transportOf('claude-exp'), 'claude-stream');
  assert.equal(transportOf('codex'), 'cli-process');
  assert.equal(transportOf('codex-exp'), 'claude-stream', 'the resident lane is the streaming wire transport');
});

test('the protocol each lane speaks is described, not inferred from the lane', () => {
  assert.equal(protocolOf('claude'), 'claude-stream');
  assert.equal(protocolOf('claude-exp'), 'claude-stream-sdk');
  assert.equal(protocolOf('codex-exp'), 'codex-app-server');
  assert.equal(protocolOf('codex'), 'codex-exec-json');
  // ACP is a per-turn local agent protocol: the bridge spawns the agent for the
  // turn and exits with it, so opencode/gemini/grok share one lane.
  for (const cli of ['opencode', 'gemini', 'grok']) {
    assert.equal(protocolOf(cli), 'acp', `${cli} rides the ACP bridge`);
    assert.equal(capabilityOf(cli).cancel, 'process');
    assert.equal(cancelStopsProcess(cli), true);
  }
});

test('protocol family answers both spellings and leaves the fallback to the caller', () => {
  assert.equal(protocolFamilyOf('claude-exp'), 'anthropic-messages');
  assert.equal(protocolFamilyOf('claude-exp', 'api'), 'anthropic');
  assert.equal(protocolFamilyOf('codex'), 'openai-responses');
  assert.equal(protocolFamilyOf('codex-exp', 'api'), 'openai_responses');
  assert.equal(protocolFamilyOf('opencode'), null);
  assert.equal(protocolFamilyOf('gemini'), null);
  assert.equal(protocolFamilyOf('grok'), null);
  assert.equal(protocolFamilyOf(undefined), null);
});

test('the one-shot codex lane is marked as the fallback it now is', () => {
  // 2026-09-24：常驻 app-server 车道（id 仍叫 codex-exp）扶正为产品的「Codex」，
  // 一次性 `codex exec`（id 仍叫 codex）退成兜底，计划淘汰。**id 一个都没动** ——
  // 会话记录、Provider 池、路由都存着 id —— 所以「哪条线路在退役、该换成谁」必须是
  // 表里的一列事实，而不是各选择器各自的判断。
  assert.equal(isDeprecated('codex'), true);
  assert.deepEqual(deprecationOf('codex'), { replacedBy: 'codex-exp' });
  assert.equal(isDeprecated('codex-exp'), false, 'the promoted lane is the replacement, not deprecated');
  assert.equal(displayNameOf('codex'), 'Codex Exec');
  assert.equal(displayNameOf('codex-exp'), 'Codex');
  // 角标跟名字走，且不能撞车：两颗 X 落在同一张任务卡上就分不出是哪条车道。
  assert.equal(CAPABILITIES && DISPLAY.codex.shortMark, 'E');
  assert.equal(DISPLAY['codex-exp'].shortMark, 'X');
  for (const cli of Object.keys(CAPABILITIES)) {
    const plan = deprecationOf(cli);
    if (!plan) continue;
    // 指向不存在、指向自己、或指向另一条也在退役的线路，UI 的「该换成 X」就成了假话。
    assert.notEqual(plan.replacedBy, cli);
    assert.ok(DISPLAY[plan.replacedBy], `${cli} names a lane that exists`);
    assert.equal(isDeprecated(plan.replacedBy), false, `${cli} must not point at another dying lane`);
  }
  // 没听说过的 id 没有淘汰计划；判定不该抛错。
  for (const unknown of ['mystery-cli', '', undefined, null]) {
    assert.equal(deprecationOf(unknown), null, `deprecationOf(${String(unknown)})`);
    assert.equal(isDeprecated(unknown), false, `isDeprecated(${String(unknown)})`);
  }
});

test('an adapter error label follows the display table, and the parsers accept every spelling', () => {
  // label 不是自选文案：turn-engine 用 `${label} 出错：${message}` 拼错误文本，
  // 所以 label 走展示表（displayNameOf）意味着改名会改到这句用户可见的文本。
  // 一次性车道的 label 从 "Codex" 变成 "Codex Exec"（常驻车道从 "Codex Exp" 变成
  // "Codex"），三处按前缀解析的地方必须同时认旧拼法和新拼法 —— 只认一种，瞬时重连
  // 会被当成真错误画进对话，错误信封会被当成正文留在记录里。
  const source = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
  assert.match(source('src/cli-adapters/codex.js'), /label:\s*displayNameOf\('codex'\)/);
  assert.match(source('src/cli-adapters/codex-exp.js'), /label:\s*displayNameOf\('codex-exp'\)/);
  assert.doesNotMatch(source('src/cli-adapters/codex.js'), /label:\s*'Codex'/);
  // 正文里不能再自称一个界面上已经不存在的名字。
  assert.doesNotMatch(source('src/cli-adapters/codex-exp.js'), /Codex Exp v1 does not support/);
  assert.match(source('src/cli-adapters/codex-exp.js'), /message:\s*'Codex v1 does not support/);
  // 三个解析点：重连抑制在 web 与 App 各一份，错误信封词表在服务端。
  assert.match(source('public/chat-event-controller.js'), /\(\?:Codex\|Codex Exp\|Codex Exec\) 出错：Reconnecting/);
  assert.match(source('app/lib/providers/chat_provider.dart'), /\(\?:Codex\|Codex Exp\|Codex Exec\) 出错：Reconnecting/);
  assert.match(source('src/chat/api-error-policy.js'), /codex\\s\*\(\?:exec\\s\*\|exp\\s\*\)\?\(\?:error\|出错\)/);
  // 行为断言，比上面的字面量检查更硬：两种拼法都要被认成纯错误信封。
  const { isErrorOnlyText } = require('../src/chat/api-error-policy.js');
  for (const text of [
    'Codex 出错：Selected model is at capacity.',
    'Codex Exec 出错：Selected model is at capacity.',
    'Codex Exp 出错：Selected model is at capacity.',
  ]) {
    assert.equal(isErrorOnlyText(text), true, `${text} must read as an error-only envelope`);
  }
  assert.equal(isErrorOnlyText('我的正文：Codex Exec 出错：x'), false, 'a prefix match mid-sentence is not an envelope');
});

test('the table cannot be rewritten at runtime', () => {
  assert.equal(Object.isFrozen(CAPABILITIES), true);
  for (const cli of Object.keys(CAPABILITIES)) assert.equal(Object.isFrozen(CAPABILITIES[cli]), true);
});

test('no call site re-derives the lanes from an inline CLI-name array', () => {
  const files = [...jsFiles(path.join(ROOT, 'src')), path.join(ROOT, 'server.js'), ...jsFiles(path.join(ROOT, 'public'))];
  const offenders = [];
  for (const file of files) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }
    text.split('\n').forEach((line, index) => {
      if (INLINE_LANE.test(line)) offenders.push(`${path.relative(ROOT, file)}:${index + 1}`);
    });
  }
  assert.deepEqual(offenders, [], `lanes must come from src/cli/cli-capability.js, not from an inline array at: ${offenders.join(', ')}`);
});
