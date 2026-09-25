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
  cancelStopsProcess,
  capabilityOf,
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
