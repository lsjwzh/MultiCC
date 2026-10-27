'use strict';
// Environment doctor regression. It hands an add-directory failure to the AI
// Assistant's model, so the tests lock what it may do on the host (read-only
// argv probes, path metadata), what reaches the model (the failure, the same
// probe the repair terminal shows, recent terminal jobs — credentials
// redacted), and what comes back to the panel (a normalized report whose
// runHere cannot promise a command the service account is unable to run).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runToolLoop } = require('../src/doctor/llm-loop');
const { createEnvironmentDoctor, checkArgv, inspectPath, normalizeReport, SYSTEM_PROMPT } = require('../src/doctor/environment');
const { mountEnvDoctorRoutes } = require('../src/routes/env-doctor');
const { mountDoctor } = require('../src/doctor/host');

const PLAIN_ACCOUNT = { user: 'multicc', uid: 996, sudo: false };
const ROOT_ACCOUNT = { user: 'root', uid: 0, sudo: false };
const probeFor = account => async () => ({
  git: { available: false, version: null },
  identity: { name: null, email: null, valid: false },
  account,
  packageManager: 'dnf',
  suggestions: { gitInstall: 'dnf install -y git', gitInstallRunnable: account.uid === 0, identity: null },
});
const target = { target: { wireApi: 'chat_completions', url: 'http://127.0.0.1:9/v1', apiKey: 'k' }, model: 'm' };

async function settled(doctor, runId) {
  for (let i = 0; i < 200; i++) {
    const run = doctor.get(runId);
    if (run && run.status !== 'running') return run;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('run never settled');
}

test('probes are argv allowlisted and read-only', () => {
  for (const argv of [['git', '--version'], ['git', 'config', '--global', '--get', 'user.email'],
    ['git', 'config', '--show-origin', '--get-all', 'safe.directory'], ['git', 'status'], ['git', 'branch', '-a'],
    ['git', 'remote', '-v'], ['git', 'worktree', 'list'], ['id'], ['ls', '-ld', '/tmp'], ['stat', '/tmp'],
    ['getent', 'passwd', 'multicc'], ['sudo', '-n', '-l']]) {
    assert.equal(checkArgv(argv), null, `allowed: ${argv.join(' ')}`);
  }
  for (const argv of [['git', 'log', '--output=/tmp/x'], ['git', '-c', 'core.pager=sh', 'log'], ['git', 'branch', 'evil'],
    ['git', 'remote', 'add', 'o', 'u'], ['git', 'config', '--global', 'user.email', 'a@b'], ['git', 'config', '--list'],
    ['git', 'worktree', 'add', 'x'], ['git', 'init'], ['git', 'commit'], ['sh', '-c', 'id'], ['rm', '-rf', '/'],
    ['sudo', 'dnf', 'install', 'git'], ['getent', 'shadow', 'root'], [], 'git --version']) {
    assert.ok(checkArgv(argv), `denied: ${JSON.stringify(argv)}`);
  }
});

test('inspect_path walks a missing path up to the first parent that exists', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'env-doctor-')));
  const chain = inspectPath(path.join(root, 'a', 'b'));
  assert.deepEqual(chain.map(c => c.exists), [false, false, true]);
  assert.equal(chain[2].path, root);
  assert.equal(chain[2].type, 'directory');
  assert.equal(chain[2].writable, true);
  assert.match(chain[2].mode, /^[0-7]{4}$/);
  // An existing directory also reports its parent: "permission denied" often
  // sits one level up.
  assert.equal(inspectPath(root).length, 2);
  assert.throws(() => inspectPath('relative/path'), /absolute/);
});

test('a report cannot promise a root-only command to an unprivileged account', () => {
  const raw = {
    summary: 'git 未安装', rootCause: '缺少 git',
    commands: [
      { command: 'dnf install -y git', purpose: '安装', runHere: true },
      { command: 'sudo -n dnf install -y git', runHere: true },
      { command: 'git config --global user.email "a@b" && sudo chown x /p', runHere: true },
      { command: 'git config --global user.name "multicc"' },
      'git config --global --add safe.directory /srv/p',
      { command: 'x'.repeat(2001) },
      { command: '' },
    ],
    evidence: ['token=sk-abcdefghijklmnopqrstuvwxyz'],
  };
  const plain = normalizeReport(raw, PLAIN_ACCOUNT);
  assert.deepEqual(plain.commands.map(c => c.runHere), [false, false, false, true, true]);
  assert.equal(plain.commands[0].purpose, '安装');
  assert.doesNotMatch(plain.evidence[0], /sk-abc/, 'credentials are redacted before they reach the panel');
  assert.deepEqual(plain.nextSteps, []);
  const root = normalizeReport(raw, ROOT_ACCOUNT);
  assert.deepEqual(root.commands.map(c => c.runHere), [true, true, true, true, true]);
  assert.equal(normalizeReport({ commands: new Array(10).fill('id') }, ROOT_ACCOUNT).commands.length, 6);
  // The model's own runHere=false is never overridden upwards.
  assert.equal(normalizeReport({ commands: [{ command: 'id', runHere: false }] }, ROOT_ACCOUNT).commands[0].runHere, false);
});

test('without an AI Assistant the start is refused with a code the panel can route on', () => {
  const doctor = createEnvironmentDoctor({
    resolveTarget: () => { throw new Error('Aux Provider 不可用：provider not found'); },
    probe: probeFor(PLAIN_ACCOUNT),
  });
  assert.deepEqual(doctor.start({ error: ' ' }), { ok: false, status: 400, code: 'INVALID', error: 'error text required' });
  const out = doctor.start({ error: 'spawn git ENOENT' });
  assert.equal(out.status, 503);
  assert.equal(out.code, 'AUX_UNAVAILABLE');
});

test('the model gets the failure, the host probe, the path and recent jobs; the panel gets a normalized report', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'env-doctor-')));
  let seen = null;
  const doctor = createEnvironmentDoctor({
    resolveTarget: () => target,
    probe: probeFor(PLAIN_ACCOUNT),
    pathEnv: [root, path.join(root, 'missing')].join(path.delimiter),
    loop: async args => {
      seen = args;
      args.onEvent({ type: 'tool', name: 'host_env' });
      args.onEvent({ type: 'tool', name: 'finish' });
      return { finished: true, turns: 2, report: { summary: '缺 git', rootCause: '未安装', commands: [{ command: 'dnf install -y git', runHere: true }] } };
    },
  });
  const out = doctor.start({
    error: '无法将目录初始化为 git 仓库: git-error: spawn git ENOENT', path: path.join(root, 'proj'), fix: 'fix-git-missing',
    recent: [{ command: 'dnf install -y git', exitCode: 1, output: 'Error: This command has to be run with superuser privileges\nkey=sk-abcdefghijklmnopqrstuvwxyz' }],
    lang: 'en',
  });
  assert.equal(out.ok, true);
  assert.deepEqual(doctor.start({ error: 'again' }), { ok: true, runId: out.runId, reused: true }, 'one diagnosis at a time');
  const run = await settled(doctor, out.runId);
  assert.equal(run.status, 'done');
  assert.ok(seen.system.startsWith(SYSTEM_PROMPT));
  assert.match(seen.system, /in English/);
  assert.equal(seen.maxTurns, 12, 'the run is bounded: it spends the user\'s AI Assistant quota');
  assert.match(seen.user, /spawn git ENOENT/);
  assert.match(seen.user, /Server repair code: fix-git-missing/);
  assert.match(seen.user, /superuser privileges/);
  assert.doesNotMatch(seen.user, /sk-abc/);
  assert.match(seen.user, /"uid": 996/);
  assert.match(seen.user, /"servicePath"/);
  assert.match(seen.user, new RegExp(`inspect_path\\(${path.join(root, 'proj').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`));
  assert.deepEqual(seen.tools.map(t => t.name), ['host_env', 'inspect_path', 'run_command', 'finish']);
  assert.deepEqual(run.steps.map(s => s.name), ['host_env'], 'finish is not a progress step');
  assert.deepEqual(run.report.commands, [{ command: 'dnf install -y git', purpose: '', runHere: false }]);
});

test('cancel stops a running diagnosis', async () => {
  const doctor = createEnvironmentDoctor({
    resolveTarget: () => target,
    probe: probeFor(PLAIN_ACCOUNT),
    loop: ({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => {
      const error = new Error('cancelled'); error.cancelled = true; reject(error);
    })),
  });
  const { runId } = doctor.start({ error: 'boom' });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(doctor.cancel(runId), true);
  const run = await settled(doctor, runId);
  assert.equal(run.status, 'cancelled');
  assert.equal(run.error, null);
  assert.equal(doctor.cancel(runId), false);
});

test('a real tool loop runs read-only probes and finishes with the report', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'env-doctor-')));
  const replies = [
    { choices: [{ message: { role: 'assistant', content: '', tool_calls: [
      { id: 'c1', type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ argv: ['rm', '-rf', root] }) } },
      { id: 'c2', type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ argv: ['git', '--version'] }) } },
      { id: 'c3', type: 'function', function: { name: 'inspect_path', arguments: '{}' } },
    ] } }] },
    { choices: [{ message: { role: 'assistant', content: '', tool_calls: [
      { id: 'c4', type: 'function', function: { name: 'finish', arguments: JSON.stringify({ summary: 'ok', rootCause: 'none', commands: ['git config --global user.name "multicc"'] }) } },
    ] } }] },
  ];
  const sent = [];
  const doctor = createEnvironmentDoctor({
    resolveTarget: () => target,
    probe: probeFor(ROOT_ACCOUNT),
    exec: async (argv, cwd) => ({ code: 0, stdout: `ran ${argv.join(' ')} in ${cwd}`, stderr: '' }),
    loop: args => runToolLoop({ ...args, post: async (_t, body) => { sent.push(JSON.parse(JSON.stringify(body))); return replies[sent.length - 1]; } }),
  });
  const { runId } = doctor.start({ error: 'boom', path: path.join(root, 'proj') });
  const run = await settled(doctor, runId);
  assert.equal(run.status, 'done');
  const toolMessages = sent[1].messages.filter(m => m.role === 'tool').map(m => m.content);
  assert.match(toolMessages[0], /ERROR: rm is not allowed/);
  assert.ok(fs.existsSync(root), 'a denied command never runs');
  assert.match(toolMessages[1], /ran git --version/);
  assert.match(toolMessages[2], /"exists": false/);
  assert.deepEqual(run.steps.map(s => s.name), ['run_command', 'run_command', 'inspect_path']);
  assert.deepEqual(run.report.commands, [{ command: 'git config --global user.name "multicc"', purpose: '', runHere: true }]);
});

function fakeApp() {
  const routes = new Map();
  const app = { get: (p, h) => routes.set(`GET ${p}`, h), post: (p, h) => routes.set(`POST ${p}`, h) };
  const call = (key, req = {}) => new Promise(resolve => {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { resolve({ status: this.statusCode, body }); } };
    routes.get(key)({ params: {}, body: {}, ...req }, res);
  });
  return { app, routes, call };
}

test('routes carry the refusal code and are mounted with the session doctor', async () => {
  const { app, call } = fakeApp();
  mountEnvDoctorRoutes(app, { doctor: createEnvironmentDoctor({
    resolveTarget: () => { throw new Error('Aux Provider 不可用'); }, probe: probeFor(PLAIN_ACCOUNT) }) });
  const refused = await call('POST /api/system/env-doctor', { body: { error: 'spawn git ENOENT' } });
  assert.equal(refused.status, 503);
  assert.equal(refused.body.code, 'AUX_UNAVAILABLE');
  const missing = await call('GET /api/system/env-doctor/:runId', { params: { runId: 'nope' } });
  assert.equal(missing.status, 404);

  const host = fakeApp();
  mountDoctor(host.app, { persistedSessions: new Map(), loadChatHistory: () => [], cwdForSession: () => null,
    auxQueue: { resolveHttpTarget: () => target.target }, getAuxConfig: () => ({ model: 'm' }), rootDir: os.tmpdir(), dataDir: os.tmpdir() });
  for (const key of ['POST /api/system/env-doctor', 'GET /api/system/env-doctor/:runId', 'POST /api/system/env-doctor/:runId/cancel', 'POST /api/sessions/:id/doctor']) {
    assert.ok(host.routes.has(key), `mounted: ${key}`);
  }
});
