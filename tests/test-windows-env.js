'use strict';
// Windows never refreshes a running process's environment block. These tests
// lock the two repairs that let MultiCC detect a git/CLI installed after it
// started, without the restart that would kill every hosted session: the
// standard install directories are searched directly, and the persisted PATH is
// re-read from the registry (throttled, de-duplicated, never destructive).
const { test } = require('node:test');
const assert = require('node:assert');
const windowsEnv = require('../src/windows-env');
const { isCommandAvailable, createCommandResolver } = require('../src/cli-adapters/commands');
const { createCliAdapters } = require('../src/cli-adapters');
const { createOpsTerminalRoutes } = require('../src/routes/ops-terminal');

function fakeRes() {
  return {
    statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
}

// Windows paths are compared the way the OS does: case-insensitively, with
// either separator.
const keyOf = (value) => String(value).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

function fakeFs(existing) {
  const dirs = new Set(existing.map(keyOf));
  return {
    statSync(file) {
      if (!dirs.has(keyOf(file))) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return { isFile: () => true, isDirectory: () => true };
    },
    accessSync() {},
  };
}

test('known install directories join PATH once and keep the user order', () => {
  windowsEnv._resetForTests();
  const env = {
    ProgramFiles: 'C:\\Program Files',
    APPDATA: 'C:\\Users\\me\\AppData\\Roaming',
    PATH: 'C:\\Windows',
  };
  const fsImpl = fakeFs(['C:\\Program Files\\Git\\cmd', 'C:\\Users\\me\\AppData\\Roaming\\npm']);
  assert.equal(windowsEnv.augmentPath(env, { windows: true, fsImpl, force: true }), true);
  assert.equal(env.PATH, 'C:\\Windows;C:\\Program Files\\Git\\cmd;C:\\Users\\me\\AppData\\Roaming\\npm');
  assert.equal(windowsEnv.augmentPath(env, { windows: true, fsImpl, force: true }), false, 'idempotent');
  assert.equal(env.PATH.split(';').filter(entry => entry === 'C:\\Program Files\\Git\\cmd').length, 1);
  assert.equal(windowsEnv.augmentPath(env, { windows: false, fsImpl, force: true }), false, 'POSIX is untouched');
});

test('a git in the standard installer directory is detected with a stale PATH', () => {
  windowsEnv._resetForTests();
  const env = { ProgramFiles: 'C:\\Program Files', PATH: 'C:\\Windows' };
  const fsImpl = fakeFs(['C:\\Program Files\\Git\\cmd', 'C:\\Program Files\\Git\\cmd\\git.exe']);
  assert.equal(isCommandAvailable('git', { isWindows: true, env, fsImpl }), false, 'not on the frozen PATH');
  windowsEnv.augmentPath(env, { windows: true, force: true, fsImpl });
  assert.equal(isCommandAvailable('git', { isWindows: true, env, fsImpl }), true);
});

test('registry PATH is appended after the live one, expanded and de-duplicated', () => {
  const merged = windowsEnv.mergePath('C:\\Windows; C:\\Tools ', [
    'C:\\Program Files\\Git\\cmd;%USERPROFILE%\\bin',
    'c:\\windows;C:\\Program Files\\Git\\cmd',
  ], { USERPROFILE: 'C:\\Users\\me' });
  assert.equal(merged, 'C:\\Windows;C:\\Tools;C:\\Program Files\\Git\\cmd;C:\\Users\\me\\bin');
});

test('refresh reads both persisted PATH values and only writes when something is new', async () => {
  windowsEnv._resetForTests();
  let clock = 100000;
  const calls = [];
  const run = (exe, args, options, callback) => {
    if (args[3] !== 'Path') return callback(new Error('missing Git registry key'));
    calls.push(args[1]);
    if (args[1].startsWith('HKLM')) {
      callback(null, 'HKEY_LOCAL_MACHINE\\...\\Environment\n    Path    REG_EXPAND_SZ    C:\\Program Files\\Git\\cmd;%USERPROFILE%\\bin\n');
    } else {
      callback(null, 'HKEY_CURRENT_USER\\Environment\n    Path    REG_EXPAND_SZ    C:\\Tools\n');
    }
  };
  const env = { USERPROFILE: 'C:\\Users\\me', SystemRoot: 'C:\\Windows', PATH: 'C:\\Windows' };
  const options = { env, run, windows: true, fsImpl: fakeFs([]), now: () => clock };

  const first = await windowsEnv.refresh(options);
  assert.equal(first.changed, true);
  assert.equal(env.PATH, 'C:\\Windows;C:\\Program Files\\Git\\cmd;C:\\Users\\me\\bin;C:\\Tools');
  assert.equal(calls.length, 2, 'machine and user PATH are both read');

  clock += 100;
  const cached = await windowsEnv.refresh(options);
  assert.equal(cached.cached, true, 'a re-check inside the throttle window reuses the last read');
  assert.equal(calls.length, 2);
});

test('refresh discovers versioned Codex and custom Git without relying on persisted PATH', async () => {
  windowsEnv._resetForTests();
  const env = { Path: 'C:\\Windows', localappdata: 'C:\\Users\\me\\AppData\\Local' };
  const run = (_exe, args, _options, callback) => {
    callback(null, args[3] === 'InstallPath' && args[1].startsWith('HKCU')
      ? '    InstallPath    REG_SZ    D:\\Custom Git\n' : '');
  };
  const gitDir = 'D:\\Custom Git\\cmd';
  const codexDir = 'C:\\Users\\me\\AppData\\Local\\OpenAI\\Codex\\bin\\0.166.0';
  let discoveryCount = 0;
  const discover = async input => {
    discoveryCount += 1;
    assert.deepEqual(input, { localAppData: env.localappdata, gitInstallPaths: ['D:\\Custom Git'] });
    return { codex: `${codexDir}\\codex.exe`, pathDirs: [gitDir, codexDir] };
  };
  const options = { windows: true, force: true, env, run, discover, fsImpl: fakeFs([]) };
  assert.equal((await windowsEnv.refresh(options)).changed, true);
  assert.equal(env.Path, `C:\\Windows;${gitDir};${codexDir}`);
  assert.equal(env.PATH, undefined, 'case-insensitive Path is updated without creating a second key');
  const revision = windowsEnv.version();
  assert.equal((await windowsEnv.refresh(options)).changed, false);
  assert.ok(windowsEnv.version() > revision, 'installing a binary inside an existing directory also invalidates command maps');
  assert.equal(discoveryCount, 2);
});

test('concurrent environment probes share one discovery and failed registry reads still allow discovery', async () => {
  windowsEnv._resetForTests();
  let release;
  let count = 0;
  const env = { PATH: 'C:\\Windows' };
  const options = { windows: true, force: true, env, fsImpl: fakeFs([]),
    run: (_exe, _args, _options, callback) => callback(new Error('denied')),
    discover: async () => { count += 1; return new Promise(resolve => { release = resolve; }); } };
  const first = windowsEnv.refresh(options);
  const second = windowsEnv.refresh(options);
  assert.equal(first, second);
  await new Promise(resolve => setImmediate(resolve));
  release({ codex: null, pathDirs: ['D:\\Git\\cmd'] });
  assert.equal((await first).changed, true);
  assert.equal(count, 1);
  assert.equal(env.PATH, 'C:\\Windows;D:\\Git\\cmd');
});

test('a failed registry read never damages the current PATH', async () => {
  windowsEnv._resetForTests();
  const run = (exe, args, options, callback) => callback(new Error('access denied'));
  const env = { PATH: 'C:\\Windows', SystemRoot: 'C:\\Windows' };
  const result = await windowsEnv.refresh({ env, run, windows: true, force: true, fsImpl: fakeFs([]) });
  assert.equal(result.changed, false);
  assert.equal(env.PATH, 'C:\\Windows');
});

test('a scan that changes the environment immediately refreshes the command map', () => {
  let revision = 0;
  let resolutions = 0;
  const seed = { codex: 'codex.exe' };
  const environment = { version: () => revision, augmentPath: () => { revision = 1; }, scheduleRefresh() {} };
  const commands = createCommandResolver({ isWindows: true, seed, environment,
    resolve: () => { resolutions += 1; return { codex: 'D:\\Codex\\codex.exe' }; } });
  assert.equal(commands(), seed, 'the shared map remains stable for login and auxiliary consumers');
  assert.equal(seed.codex, 'D:\\Codex\\codex.exe', 'the first call sees the scan performed on that call');
  commands();
  assert.equal(resolutions, 1);
});

test('CLI invocation and app-server bridge follow the refreshed availability command map', () => {
  let revision = 0;
  let codex = 'codex.exe';
  const environment = { version: () => revision, augmentPath() {}, scheduleRefresh() {} };
  const { commands, registry } = createCliAdapters({ isWindows: true, commandEnvironment: environment,
    resolveCliCommands: () => ({ claude: 'claude.exe', codex, 'codex-exp': codex }),
    codexReasoningConfigArg: () => null, codexModelConfigArg: () => null,
  });
  const oldAdapter = registry.get('codex');
  const invocation = { spawnOpts: {}, historyHandle: { isFirstTurn: true }, contextLayers: [], userText: 'probe' };
  codex = 'C:\\Users\\me\\AppData\\Local\\OpenAI\\Codex\\bin\\0.166.0\\codex.exe';
  revision += 1;
  const next = registry.get('codex');
  assert.equal(commands.codex, codex);
  assert.equal(next.buildInvocation(invocation).cmd, codex);
  const bridge = registry.get('codex-exp').buildInvocation(invocation);
  assert.equal(bridge.args[bridge.args.indexOf('--codex-bin') + 1], codex);
  assert.equal(oldAdapter.cmd, 'codex.exe', 'an active turn keeps its original adapter');
  assert.equal(registry.get('codex'), next, 'unchanged maps preserve adapter state');
});

const native = require('../src/native/runtime').getNative();
test('native installer discovery feeds the Windows PATH refresh', {
  skip: typeof native?.windowsToolsDiscover !== 'function' && 'Rust installer discovery is not built',
}, async t => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  windowsEnv._resetForTests();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-windows-install-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'OpenAI', 'Codex', 'bin', '0.166.0');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'codex.exe'), 'fixture');
  const env = { LOCALAPPDATA: root, PATH: 'C:\\Windows' };
  await windowsEnv.refresh({ env, windows: true, force: true, fsImpl: fakeFs([]),
    run: (_exe, _args, _opts, callback) => callback(new Error('missing')) });
  assert.equal(env.PATH, `C:\\Windows;${bin}`);
  assert.equal(isCommandAvailable('codex.exe', { isWindows: true, env }), true);
});

test('the Windows env probe names the resolved git instead of trusting PATH', async () => {
  windowsEnv._resetForTests();
  const calls = [];
  const git = 'C:\\Program Files\\Git\\cmd\\git.exe';
  const exec = async (command) => {
    calls.push(command);
    if (command === 'where winget') return { code: 0, stdout: 'winget.exe\n' };
    return { code: 127, stdout: '' };
  };
  const gitCalls = [];
  const runGit = async (file, args) => {
    assert.equal(file, git);
    gitCalls.push(args);
    return { code: 0, stdout: args[0] === '--version' ? 'git version 2.56.0.windows.4\n'
      : args[2] === 'user.name' ? 'me\n' : 'me@example.com\n' };
  };
  const routes = createOpsTerminalRoutes({
    platform: 'win32', log: { warn() {} }, exec, runGit,
    findGit: () => git,
    refreshEnv: async () => ({ changed: false }),
  });
  const res = fakeRes();
  await routes.envHandler({}, res, (error) => { throw error; });
  assert.deepEqual(res.body.git, { available: true, version: '2.56.0.windows.4' });
  assert.equal(res.body.identity.valid, true);
  assert.deepEqual(gitCalls, [['--version'], ['config', '--get', 'user.name'], ['config', '--get', 'user.email']]);
  assert.ok(!calls.some(command => command.includes('git')), 'Git never passes through CMD string parsing');
  assert.ok(!calls.includes('where git'), 'git is no longer looked up through the frozen PATH');
});

test('a Windows re-check forces the registry refresh before probing', async () => {
  windowsEnv._resetForTests();
  let refreshes = 0;
  const routes = createOpsTerminalRoutes({
    platform: 'win32', log: { warn() {} },
    exec: async () => ({ code: 1, stdout: '' }),
    findGit: () => null,
    refreshEnv: async () => { refreshes += 1; return { changed: false }; },
  });
  const res = fakeRes();
  await routes.envHandler({}, res, (error) => { throw error; });
  assert.equal(refreshes, 1);
  assert.deepEqual(res.body.git, { available: false, version: null });
});
