'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHostPrompts } = require('../src/native/binding').getHostPrompts();
const prompt = createHostPrompts({ PORT: '3000' }).multiccImgHint;

test('worktree prompt distinguishes same-session busy from real sync conflicts', () => {
  assert.match(prompt, /not the required path for an agent to sync itself \(a running session gets 409 busy by design\)/);
  assert.match(prompt, /Self-sync: align with the local base branch directly with Git/);
  assert.match(prompt, /git status --short/);
  assert.match(prompt, /git rev-list --left-right --count HEAD\.\.\.main/);
  assert.match(prompt, /only `0 0` means fully aligned/);
  assert.match(prompt, /stop and report when dirty, conflicted or of unclear ownership/);
  assert.match(prompt, /do not mistake the endpoint's `unmerged` wording for a Git index conflict/);
});

test('commit guidance respects Git configuration without imposing a language', () => {
  assert.doesNotMatch(prompt, /commit messages .*must be written in English/);
  assert.doesNotMatch(prompt, /release notes .*must be written in English/);
  assert.match(prompt, /Let Git use the user’s own configuration, command arguments and environment/);
});

test('host prompt enforces parallel batching, scoped reads, merged edits and stays slim', () => {
  assert.match(prompt, /\[Execution efficiency - batch calls & scope reads\]/);
  assert.match(prompt, /Parallelize independent reads and searches/);
  assert.match(prompt, /Scope reads before opening files/);
  assert.match(prompt, /Merge edits per file/);
  assert.match(prompt, /read-only\/Explore sub-agents/);
  assert.ok(prompt.length < 7600, `expected slimmed host hint (<7600 chars), got ${prompt.length}`);
  const { buildSubagentProviderHint, buildPlanProgressPrompt } = require('../src/native/binding').getHostPrompts();
  const sub = buildSubagentProviderHint({ providerId: 'p1', model: 'deepseek' });
  assert.match(sub, /fan out independent work in parallel/);
  assert.match(sub, /long serial Read\/Edit\/Bash chains/);
  assert.ok(buildPlanProgressPrompt().length < 1100);
  assert.ok(buildPlanProgressPrompt(null, 's', { isFirstTurn: false }).length < 300);
});

test('宿主提示词逐字匹配冻结版，并且只消费本会话的重置标记', () => {
  const before = require('./helpers/legacy-host-prompts'), current = require('../src/native/binding').getHostPrompts();
  for (const api of [before, current]) assert.ok(Object.isFrozen(api.USER_INPUT_SIGNAL_PROMPT));
  for (const toggle of [undefined, null, '0', 0, false, '1']) for (const port of [0, 7777, '端口', Symbol('port')]) {
    const env = { CODEX_NO_ASK_TOOL_HINT: toggle, CODEX_STAY_ALIVE_HINT: toggle, PORT: port };
    const opts = { assistRoot: { toJSON: () => '目录/' } };
    assert.deepEqual(current.createHostPrompts(env, opts), before.createHostPrompts(env, opts));
  }
  for (const value of [undefined, 0, ' 目录 ', { toJSON: () => '/协助/' }, Symbol('符号')]) {
    assert.deepEqual(current.buildHumanAssistPrompt(value), before.buildHumanAssistPrompt(value));
    assert.equal(current.buildCodexUserInputConstraint(value), before.buildCodexUserInputConstraint(value));
  }
  for (const value of [null, 'id', {}, { providerId: ' ' }, { providerId: Symbol('p'), model: 22 }, { providerId: '\uFEFFp\uFEFF', model: ' 模型 ' }]) {
    assert.equal(current.buildSubagentProviderHint(value), before.buildSubagentProviderHint(value));
  }
  const trace = api => {
    api.markPlanContextReset(' 甲 '); api.markPlanContextReset('乙'); api.markPlanContextReset('\ud800');
    return ['甲 ', '乙', '\ud801', '\ud800', '甲', '乙', '甲'].map(id =>
      api.buildPlanProgressPrompt(null, id, { isFirstTurn: false }));
  };
  assert.deepEqual(trace(current), trace(before));
});
