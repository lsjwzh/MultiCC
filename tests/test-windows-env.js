'use strict';
// Windows never refreshes a running process's environment block. These tests
// lock the two repairs that let MultiCC detect a git/CLI installed after it
// started, without the restart that would kill every hosted session: the
// standard install directories are searched directly, and the persisted PATH is
// re-read from the registry (throttled, de-duplicated, never destructive).
const { test } = require('node:test');
const assert = require('node:assert');
const windowsEnv = require('../src/windows-env');
const { isCommandAvailable } = require('../src/cli-adapters/commands');
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

test('a failed registry read never damages the current PATH', async () => {
  windowsEnv._resetForTests();
  const run = (exe, args, options, callback) => callback(new Error('access denied'));
  const env = { PATH: 'C:\\Windows', SystemRoot: 'C:\\Windows' };
  const result = await windowsEnv.refresh({ env, run, windows: true, force: true, fsImpl: fakeFs([]) });
  assert.equal(result.changed, false);
  assert.equal(env.PATH, 'C:\\Windows');
});

test('the Windows env probe names the resolved git instead of trusting PATH', async () => {
  windowsEnv._resetForTests();
  const calls = [];
  const git = 'C:\\Program Files\\Git\\cmd\\git.exe';
  const exec = async (command) => {
    calls.push(command);
    if (command === `"${git}" --version`) return { code: 0, stdout: 'git version 2.56.0.windows.4\n' };
    if (command.endsWith('config --get user.name')) return { code: 0, stdout: 'me\n' };
    if (command.endsWith('config --get user.email')) return { code: 0, stdout: 'me@example.com\n' };
    if (command === 'where winget') return { code: 0, stdout: 'winget.exe\n' };
    return { code: 127, stdout: '' };
  };
  const routes = createOpsTerminalRoutes({
    platform: 'win32', log: { warn() {} }, exec,
    findGit: () => git,
    refreshEnv: async () => ({ changed: false }),
  });
  const res = fakeRes();
  await routes.envHandler({}, res, (error) => { throw error; });
  assert.deepEqual(res.body.git, { available: true, version: '2.56.0.windows.4' });
  assert.equal(res.body.identity.valid, true);
  assert.ok(calls.includes(`"${git}" config --get user.name`));
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
