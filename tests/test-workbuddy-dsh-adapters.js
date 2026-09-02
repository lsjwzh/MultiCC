'use strict';

// WorkBuddy (codebuddy) + DeepSeek Harness (dsh) adapter contract tests.
// codebuddy rides the qoder pattern (Claude-byte-compatible stream-json
// envelope, providerless vendor auth); dsh rides a repo-shipped runner plugin
// under a bootstrapped ~/.dsh/profiles/multicc profile and emits its own JSONL.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCodebuddyAdapter, CODEBUDDY_REASONING_LEVELS } = require('../src/cli-adapters/codebuddy');
const { createDshAdapter, ensureDshProfile, DSH_MODELS, DSH_PROFILE } = require('../src/cli-adapters/dsh');

const codebuddy = createCodebuddyAdapter({ cmd: 'codebuddy' });
const envelope = {
  systemPrompt: '',
  spawnOpts: { rawModel: 'glm-5.2', rawEffort: 'high', rawAgent: 'reviewer' },
  historyHandle: { isFirstTurn: true, cliSessionId: null },
  contextLayers: [], userText: 'hello', suffix: '', rolePrompt: '',
};

// ── codebuddy: adapter surface ────────────────────────────────────────────
for (const adapter of [codebuddy]) {
  assert.strictEqual(typeof adapter.buildInvocation, 'function', `${adapter.name} buildInvocation`);
  assert.strictEqual(typeof adapter.decodeEvent, 'function', `${adapter.name} decodeEvent`);
  assert.strictEqual(adapter.needsAsyncSessionIdCapture, false, `${adapter.name} captures session ids inline`);
}

// ── codebuddy: decodeEvent follows the Claude envelope exactly like qoder ─
assert.deepStrictEqual(
  codebuddy.decodeEvent({ type: 'system', subtype: 'init', model: 'glm-5.2', session_id: 'cb-1' }),
  [
    { type: 'session_init', model: 'glm-5.2', raw: { type: 'system', subtype: 'init', model: 'glm-5.2', session_id: 'cb-1' } },
    { type: 'session_started', sessionId: 'cb-1' },
  ],
);
assert.strictEqual(
  codebuddy.decodeEvent({ type: 'assistant', message: { content: [] } })[0].type,
  'claude_event',
);

// ── codebuddy: buildInvocation first turn / continuation / effort gating ──
assert.deepStrictEqual(
  codebuddy.buildInvocation(envelope).args,
  [
    '-p', '--output-format', 'stream-json', '--dangerously-skip-permissions',
    '--append-system-prompt', '', '--model', 'glm-5.2', '--effort', 'high', '--agent', 'reviewer',
  ],
);
assert.strictEqual(codebuddy.buildInvocation(envelope).payload, 'hello');
assert.deepStrictEqual(
  codebuddy.buildInvocation({
    ...envelope,
    historyHandle: { isFirstTurn: false, cliSessionId: 'cb-7' },
  }).args.slice(-2),
  ['--resume', 'cb-7'],
);
// The `minimal` rung exists on codebuddy but not qoder; unknown values drop.
assert.ok(CODEBUDDY_REASONING_LEVELS.has('minimal'));
assert.ok(!CODEBUDDY_REASONING_LEVELS.has('ultracode'));
assert.deepStrictEqual(
  codebuddy.buildInvocation({ ...envelope, spawnOpts: { rawModel: null, rawEffort: 'ultracode', rawAgent: null } }).args,
  ['-p', '--output-format', 'stream-json', '--dangerously-skip-permissions', '--append-system-prompt', ''],
);
assert.strictEqual(
  codebuddy.buildInvocation({ ...envelope, spawnOpts: { ...envelope.spawnOpts, rawEffort: 'minimal' } }).args.includes('minimal'),
  true,
);

// ── codebuddy: terminal command mirrors the invocation ────────────────────
assert.strictEqual(
  codebuddy.buildTerminalCmd({ model: 'glm-5.2', effort: 'max', agent: 'rev', cliSessionId: 'cb-9' }),
  'codebuddy --model glm-5.2 --effort max --agent rev --resume cb-9',
);

// ── dsh: profile bootstrap is derived state and idempotent ────────────────
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-dsh-home-'));
const runnerSrc = path.join(tmpHome, 'runner-src');
fs.mkdirSync(path.join(runnerSrc, 'lib'), { recursive: true });
fs.writeFileSync(path.join(runnerSrc, 'package.json'), '{"name":"multicc-dsh-runner","version":"1.0.0"}');
fs.writeFileSync(path.join(runnerSrc, 'lib', 'index.js'), 'export default null;\n');

const profileDir = path.join(tmpHome, '.dsh', 'profiles', DSH_PROFILE);
const boot = ensureDshProfile({ homeDir: tmpHome, runnerSrcDir: runnerSrc });
assert.strictEqual(boot.dir, profileDir);
assert.deepStrictEqual(
  JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8')).dsh.profile.bundles,
  ['dsh-base', 'dsh-headless'],
);
const patchText = fs.readFileSync(path.join(profileDir, 'cordis.patch.yml'), 'utf8');
assert.match(patchText, /- id: headless-runner\n {2}disabled: true/);
assert.match(patchText, /- insert:\n {4}- id: multicc-runner/);
assert.match(fs.readFileSync(path.join(profileDir, '.multicc-profile-version'), 'utf8'), /^1\n$/);
assert.ok(fs.existsSync(path.join(profileDir, 'node_modules', 'multicc-dsh-runner', 'lib', 'index.js')));

// Second run must be a no-op: count writes through a spying fsImpl.
let writes = 0;
const spyFs = new Proxy(fs, {
  get(target, key) {
    const value = target[key];
    if (key === 'writeFileSync' || key === 'copyFileSync') {
      return (...args) => { writes += 1; return value.apply(target, args); };
    }
    return typeof value === 'function' ? value.bind(target) : value;
  },
});
ensureDshProfile({ homeDir: tmpHome, runnerSrcDir: runnerSrc, fsImpl: spyFs });
assert.strictEqual(writes, 0, 'unchanged profile must not be rewritten');

// A missing runner copy heals without touching the rest of the profile.
fs.rmSync(path.join(profileDir, 'node_modules', 'multicc-dsh-runner'), { recursive: true, force: true });
ensureDshProfile({ homeDir: tmpHome, runnerSrcDir: runnerSrc, fsImpl: spyFs });
assert.ok(fs.existsSync(path.join(profileDir, 'node_modules', 'multicc-dsh-runner', 'package.json')));

// ── dsh: adapter surface + invocation gating ──────────────────────────────
const dsh = createDshAdapter({ cmd: 'dsh', homeDir: tmpHome, runnerSrcDir: runnerSrc });
assert.strictEqual(typeof dsh.buildInvocation, 'function');
assert.strictEqual(typeof dsh.decodeEvent, 'function');
assert.strictEqual(dsh.needsAsyncSessionIdCapture, false);

const dshFirst = dsh.buildInvocation({
  ...envelope,
  spawnOpts: { rawModel: 'deepseek-v4-pro', rawEffort: 'high', rawAgent: null },
});
assert.deepStrictEqual(dshFirst.args, ['--profile', 'multicc', '--multicc-model', 'deepseek-v4-pro']);
assert.strictEqual(dshFirst.payload, 'hello');

// Models outside DSH_MODELS are never forced onto the runner.
assert.deepStrictEqual(
  dsh.buildInvocation({ ...envelope, spawnOpts: { rawModel: 'gpt-5.6', rawEffort: null, rawAgent: null } }).args,
  ['--profile', 'multicc'],
);

// Continuation rides --multicc-resume; the first turn never does.
assert.deepStrictEqual(
  dsh.buildInvocation({
    ...envelope,
    spawnOpts: { rawModel: null, rawEffort: null, rawAgent: null },
    historyHandle: { isFirstTurn: false, cliSessionId: 'dsh-sess-1' },
  }).args,
  ['--profile', 'multicc', '--multicc-resume', 'dsh-sess-1'],
);
assert.strictEqual(
  dsh.buildInvocation({
    ...envelope,
    spawnOpts: { rawModel: null, rawEffort: null, rawAgent: null },
    historyHandle: { isFirstTurn: true, cliSessionId: 'dsh-sess-1' },
  }).args.includes('--multicc-resume'),
  false,
);

assert.deepStrictEqual(DSH_MODELS, ['deepseek-v4-flash', 'deepseek-v4-pro']);
assert.strictEqual(
  dsh.buildTerminalCmd({ model: 'deepseek-v4-flash', cliSessionId: 'dsh-3' }),
  'dsh --profile multicc --multicc-model deepseek-v4-flash --multicc-resume dsh-3',
);

// ── dsh: decodeEvent maps runner JSONL to generic chat events ─────────────
assert.deepStrictEqual(
  dsh.decodeEvent({ type: 'session_started', sessionId: 'dsh-11' }),
  [{ type: 'session_started', sessionId: 'dsh-11' }],
);
assert.deepStrictEqual(
  dsh.decodeEvent({ type: 'assistant_text', text: '答案' }),
  [{ type: 'assistant_text', text: '答案' }],
);
assert.deepStrictEqual(
  dsh.decodeEvent({ type: 'thinking', text: '推理' }),
  [{ type: 'thinking', text: '推理' }],
);
assert.deepStrictEqual(
  dsh.decodeEvent({ type: 'tool_update', id: 'call-1', name: 'bash', input: { cmd: 'ls' }, completed: false }),
  [{ type: 'tool_update', id: 'call-1', name: 'bash', input: { cmd: 'ls' }, currentFile: null, completed: false, content: '', isError: false }],
);
assert.deepStrictEqual(
  dsh.decodeEvent({ type: 'tool_update', id: 'call-1', name: 'bash', completed: true, content: 'ok', isError: true }),
  [{ type: 'tool_update', id: 'call-1', name: 'bash', input: {}, currentFile: null, completed: true, content: 'ok', isError: true }],
);
assert.deepStrictEqual(dsh.decodeEvent({ type: 'status', status: 'thinking' }), [{ type: 'status', status: 'thinking' }]);
assert.deepStrictEqual(dsh.decodeEvent({ type: 'complete' }), [{ type: 'complete' }]);
assert.match(
  dsh.decodeEvent({ type: 'error', message: 'MISSING_CREDENTIAL' })[0].message,
  /MISSING_CREDENTIAL/,
);
// session_finished and unknown lines stay silent.
assert.deepStrictEqual(dsh.decodeEvent({ type: 'session_finished' }), []);
assert.deepStrictEqual(dsh.decodeEvent(null), []);

fs.rmSync(tmpHome, { recursive: true, force: true });
console.log('WorkBuddy + DSH adapter tests passed');
