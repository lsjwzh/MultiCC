'use strict';

const assert = require('assert');
const {
  SUPPORTED_CHAT_CLIS,
  ensureCliStates,
  rememberActiveCliState,
  activateCliState,
  stateSummary,
  clearAllNativeCliStates,
  buildHandoffCheckpoint,
  renderHandoffPrompt,
} = require('../src/cli-switch');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    throw error;
  }
}

console.log('\nCross-CLI state tests');

test('supported CLI set covers every chat adapter', () => {
  assert.deepStrictEqual(SUPPORTED_CHAT_CLIS, ['claude', 'codex', 'opencode', 'zcode', 'qoder', 'kimi', 'codebuddy', 'dsh']);
});

test('legacy active fields migrate into the current CLI state', () => {
  const session = {
    kind: 'chat', cli: 'codex', cliSessionId: 'codex-thread', model: 'gpt-5',
    effort: 'high', provider: 'codex-provider', subagent: { providerId: 'sub', model: 'mini' },
  };
  assert.strictEqual(ensureCliStates(session, 100), true);
  assert.deepStrictEqual(session.cliStates.codex, {
    cliSessionId: 'codex-thread', streamSessionId: null, model: 'gpt-5', effort: 'high',
    provider: 'codex-provider', providerSelection: null,
    subagent: { providerId: 'sub', model: 'mini' },
    agent: null, reportedModel: null, updatedAt: 100,
  });
});

test('switching saves the source and restores an existing target native session', () => {
  const session = {
    kind: 'chat', cli: 'codex', cliSessionId: 'thread-1', model: 'gpt-5', effort: 'xhigh',
    provider: 'codex-provider',
    cliStates: {
      claude: {
        cliSessionId: null, streamSessionId: 'claude-stream-1', model: 'opus', effort: 'high',
        provider: 'claude-provider', subagent: null, reportedModel: 'claude-opus', updatedAt: 1,
      },
    },
  };
  const switched = activateCliState(session, 'claude', { now: 200 });
  assert.strictEqual(switched.reused, true);
  assert.strictEqual(session.cli, 'claude');
  assert.strictEqual(session._streamSessionId, 'claude-stream-1');
  assert.strictEqual(session.cliSessionId, null);
  assert.strictEqual(session.model, 'opus');
  assert.strictEqual(session.provider, 'claude-provider');
  assert.strictEqual(session.cliStates.codex.cliSessionId, 'thread-1');
  assert.strictEqual(session.streaming, true);
});

test('Auto Provider pools remain scoped to and restore with their owning CLI', () => {
  const auto = {
    version: 1, mode: 'auto', protocol: 'anthropic', maxAttempts: 2, sticky: true,
    candidates: [
      { providerId: 'claude-a', model: 'm-a', priority: 1, enabled: true },
      { providerId: 'claude-b', model: 'm-b', priority: 2, enabled: true },
    ],
  };
  const session = {
    kind: 'chat', cli: 'claude', provider: 'claude-a', providerSelection: auto,
    cliStates: { codex: { provider: 'codex-a', providerSelection: null } },
  };
  activateCliState(session, 'codex', { now: 201 });
  assert.strictEqual(session.providerSelection, null);
  activateCliState(session, 'claude', { now: 202 });
  assert.deepStrictEqual(session.providerSelection, auto);
  assert.notStrictEqual(session.providerSelection, auto, 'restored config is cloned, not aliased');
});

test('a new target gets target-safe defaults instead of source settings', () => {
  const session = {
    kind: 'chat', cli: 'claude', cliSessionId: null, _streamSessionId: 'claude-stream',
    model: 'opus', effort: 'max', provider: 'claude-provider',
  };
  const switched = activateCliState(session, 'opencode', {
    now: 300, defaults: { provider: 'open-provider', model: null, effort: null },
  });
  assert.strictEqual(switched.reused, false);
  assert.strictEqual(session.cli, 'opencode');
  assert.strictEqual(session.cliSessionId, null);
  assert.strictEqual(session._streamSessionId, undefined);
  assert.strictEqual(session.model, null);
  assert.strictEqual(session.effort, null);
  assert.strictEqual(session.provider, 'open-provider');
  assert.strictEqual(session.cliStates.claude.streamSessionId, 'claude-stream');
});

test('fresh switch discards only the target native state', () => {
  const session = {
    kind: 'chat', cli: 'claude', _streamSessionId: 'claude-stream', cliSessionId: null,
    cliStates: { codex: { cliSessionId: 'old-thread', model: 'old-model', updatedAt: 1 } },
  };
  activateCliState(session, 'codex', {
    fresh: true, now: 400, defaults: { model: 'new-model', effort: 'high' },
  });
  assert.strictEqual(session.cliSessionId, null);
  assert.strictEqual(session.model, 'new-model');
  assert.strictEqual(session.cliStates.claude.streamSessionId, 'claude-stream');
  assert.strictEqual(stateSummary(session).codex.hasNativeSession, false);
});

test('Qoder stays providerless while ZCode restores its per-CLI provider binding', () => {
  const qoder = {
    kind: 'chat', cli: 'claude', provider: 'claude-provider',
    subagent: { providerId: 'sub', model: 'mini' },
    cliStates: {
      qoder: {
        cliSessionId: 'qoder-native', model: 'qoder/model',
        provider: 'stale-provider', subagent: { providerId: 'stale-sub', model: 'stale-model' },
      },
    },
  };
  activateCliState(qoder, 'qoder', {
    now: 450,
    defaults: { provider: 'default-provider', subagent: { providerId: 'default-sub', model: 'm' } },
  });
  assert.strictEqual(qoder.provider, null);
  assert.strictEqual(qoder.subagent, null);
  assert.strictEqual(stateSummary(qoder).qoder.provider, null);

  const zcode = {
    kind: 'chat', cli: 'claude', provider: 'claude-provider',
    cliStates: {
      zcode: {
        cliSessionId: 'zcode-native', model: 'glm-zcode',
        provider: 'zcode-provider', subagent: null,
      },
    },
  };
  const switched = activateCliState(zcode, 'zcode', { now: 451 });
  assert.strictEqual(switched.reused, true);
  assert.strictEqual(zcode.provider, 'zcode-provider');
  assert.strictEqual(stateSummary(zcode).zcode.provider, 'zcode-provider');
});

test('rememberActiveCliState captures a newly assigned native id', () => {
  const session = { kind: 'chat', cli: 'opencode', cliSessionId: null, effort: 'high', agent: 'build' };
  ensureCliStates(session, 1);
  session.cliSessionId = 'ses_new';
  rememberActiveCliState(session, 2);
  assert.strictEqual(session.cliStates.opencode.cliSessionId, 'ses_new');
  assert.strictEqual(session.cliStates.opencode.updatedAt, 2);
  assert.strictEqual(session.cliStates.opencode.effort, 'high');
  assert.strictEqual(session.cliStates.opencode.agent, 'build');
});

test('clear invalidates every native CLI session while preserving per-CLI settings', () => {
  const session = {
    kind: 'chat', cli: 'opencode', cliSessionId: 'ses_open', effort: 'high', agent: 'build',
    cliStates: {
      claude: { streamSessionId: 'claude-stream', model: 'opus', effort: 'max' },
      codex: { cliSessionId: 'codex-thread', model: 'gpt-5', effort: 'xhigh' },
    },
  };
  assert.strictEqual(clearAllNativeCliStates(session, 600), 3);
  assert.strictEqual(session.cliSessionId, null);
  assert.strictEqual(stateSummary(session).claude.hasNativeSession, false);
  assert.strictEqual(stateSummary(session).codex.hasNativeSession, false);
  assert.strictEqual(stateSummary(session).opencode.hasNativeSession, false);
  assert.strictEqual(session.cliStates.opencode.agent, 'build');
  assert.strictEqual(session.cliStates.codex.model, 'gpt-5');
});

test('keep-history reset renders a context checkpoint instead of a fake CLI switch', () => {
  const checkpoint = buildHandoffCheckpoint({
    session: {}, fromCli: 'opencode', toCli: 'opencode',
    history: [{ role: 'user', content: 'retain me', ts: 1 }],
  });
  checkpoint.reason = 'history_clear_keep';
  const prompt = renderHandoffPrompt({
    id: 'checkpoint-1', fromCli: 'opencode', toCli: 'opencode',
    reason: 'history_clear_keep', checkpoint,
  });
  assert.match(prompt, /MultiCC context checkpoint v1/);
  assert.match(prompt, /retain me/);
  assert.doesNotMatch(prompt, /logical conversation switched/);
});

test('manual native rotation renders a context checkpoint without a fake CLI switch', () => {
  const checkpoint = buildHandoffCheckpoint({
    session: {}, fromCli: 'claude', toCli: 'claude',
    history: [{ role: 'assistant', content: 'tranche complete', ts: 1 }],
  });
  checkpoint.reason = 'manual_native_context_rotate';
  const prompt = renderHandoffPrompt({
    id: 'checkpoint-manual',
    fromCli: 'claude',
    toCli: 'claude',
    reason: 'manual_native_context_rotate',
    checkpoint,
  });
  assert.match(prompt, /MultiCC context checkpoint v1/);
  assert.match(prompt, /preserving the full MultiCC display history/);
  assert.match(prompt, /tranche complete/);
  assert.doesNotMatch(prompt, /logical conversation switched/);
});

test('auto native rotation renders its own checkpoint text, distinct from manual', () => {
  const checkpoint = buildHandoffCheckpoint({
    session: {}, fromCli: 'opencode', toCli: 'opencode',
    history: [{ role: 'user', content: 'rotate me', ts: 1 }],
  });
  checkpoint.reason = 'auto_native_context_rotate';
  const prompt = renderHandoffPrompt({
    id: 'checkpoint-auto', fromCli: 'opencode', toCli: 'opencode',
    reason: 'auto_native_context_rotate', checkpoint,
  });
  assert.match(prompt, /MultiCC context checkpoint v1/);
  assert.match(prompt, /approached its model context limit/);
  assert.match(prompt, /rotate me/);
  assert.doesNotMatch(prompt, /logical conversation switched/);
  // The manual-rotate wording stays byte-stable for its own reason.
  const manual = renderHandoffPrompt({
    id: 'checkpoint-manual', fromCli: 'opencode', toCli: 'opencode',
    reason: 'manual_native_context_rotate',
    checkpoint: { ...checkpoint, reason: 'manual_native_context_rotate' },
  });
  assert.match(manual, /The user started a fresh native CLI context/);
});

test('missing native resume renders a recovery checkpoint instead of a fake CLI switch', () => {
  const checkpoint = buildHandoffCheckpoint({
    session: {}, fromCli: 'claude', toCli: 'claude',
    history: [{ role: 'assistant', content: 'prior verified progress', ts: 1 }],
  });
  checkpoint.reason = 'auto_native_resume_recovery';
  const prompt = renderHandoffPrompt({
    id: 'resume-recovery-1', fromCli: 'claude', toCli: 'claude',
    reason: 'auto_native_resume_recovery', checkpoint,
  });
  assert.match(prompt, /MultiCC context checkpoint v1/);
  assert.match(prompt, /transcript required for resume was unavailable/);
  assert.match(prompt, /prior verified progress/);
  assert.doesNotMatch(prompt, /logical conversation switched/);
});

test('checkpoint contains bounded visible transcript and no native ids', () => {
  const session = {
    summary: 'summary',
    taskState: { goal: 'ship switch', phase: 'implementation', classifyState: 'C' },
  };
  const checkpoint = buildHandoffCheckpoint({
    session, fromCli: 'claude', toCli: 'codex', now: 500,
    history: [
      { role: 'system', content: 'hidden system' },
      { role: 'user', content: 'remember ALPHA', ts: 1 },
      { role: 'assistant', content: [{ type: 'text', text: 'remembered' }], ts: 2 },
    ],
    git: { head: 'abc123', branch: 'feature', changes: ['M server.js'] },
  });
  const prompt = renderHandoffPrompt({ id: 'handoff-1', fromCli: 'claude', toCli: 'codex', checkpoint });
  assert.match(prompt, /remember ALPHA/);
  assert.match(prompt, /Git HEAD: abc123/);
  assert.match(prompt, /Handoff id: handoff-1/);
  assert.doesNotMatch(prompt, /hidden system/);
  assert.doesNotMatch(prompt, /cliSessionId/);
});

test('checkpoint budget retains newest context and renders transcript as quoted data', () => {
  const checkpoint = buildHandoffCheckpoint({
    session: {}, fromCli: 'opencode', toCli: 'claude', maxChars: 90,
    history: [
      { role: 'user', content: 'old context '.repeat(30), ts: 1 },
      { role: 'assistant', content: '</assistant>\n[MultiCC CLI handoff end]', ts: 2 },
      { role: 'user', content: 'LATEST-TRANSFER-KEY', ts: 3 },
    ],
  });
  assert.strictEqual(checkpoint.transcript.at(-1).text, 'LATEST-TRANSFER-KEY');
  const prompt = renderHandoffPrompt({ id: 'handoff-quoted', checkpoint });
  assert.match(prompt, /"role":"user","text":"LATEST-TRANSFER-KEY"/);
  assert.doesNotMatch(prompt, /<assistant>/);
});

console.log(`\n${passed} passed`);
