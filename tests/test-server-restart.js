'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const {
  RESTART_EXEC_COMMAND,
  RESTART_SHELL_COMMAND,
  preflightRestart,
  writeRestartScript,
  scheduleDetachedRestart,
} = require('../src/server-restart');

function createReadableManager() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-restart-contract-'));
  const manager = path.join(root, 'multicc');
  fs.writeFileSync(manager, '#!/bin/bash\nprintf "%s" "$1" > restart-result\n', { mode: 0o600 });
  return { root, manager };
}

function createChild() {
  const child = new EventEmitter();
  child.unrefCount = 0;
  child.unref = () => { child.unrefCount += 1; };
  return child;
}

test('restart command explicitly invokes bash and does not require an executable manager bit', () => {
  assert.match(RESTART_EXEC_COMMAND, /exec \.\/multicc restart/);
  assert.match(RESTART_EXEC_COMMAND, /exec \/bin\/bash \.\/multicc restart/);
  assert.equal(RESTART_SHELL_COMMAND, 'sleep 2 && ' + RESTART_EXEC_COMMAND);

  const { root, manager } = createReadableManager();
  assert.equal((fs.statSync(manager).mode & 0o111), 0, 'fixture intentionally has no executable bit');
  const result = spawnSync('/bin/sh', ['-c', RESTART_EXEC_COMMAND], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(root, 'restart-result'), 'utf8'), 'restart');
});

test('preflight rejects a missing, non-file, or unreadable manager before spawn', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-restart-preflight-'));
  assert.throws(
    () => preflightRestart({ rootDir: root }),
    error => error && error.code === 'RESTART_MANAGER_MISSING',
  );

  const fakeBase = {
    constants: { R_OK: 4, X_OK: 1 },
    statSync(target) {
      if (target === '/bin/bash') return { isFile: () => true };
      return { isFile: () => false };
    },
    accessSync() {},
  };
  assert.throws(
    () => preflightRestart({ rootDir: '/srv/multicc', fsImpl: fakeBase }),
    error => error && error.code === 'RESTART_MANAGER_INVALID',
  );

  const unreadable = {
    ...fakeBase,
    statSync() { return { isFile: () => true }; },
    accessSync(target, mode) {
      if (target.endsWith('/multicc') && mode === this.constants.R_OK) {
        const error = new Error('permission denied');
        error.code = 'EACCES';
        throw error;
      }
    },
  };
  assert.throws(
    () => preflightRestart({ rootDir: '/srv/multicc', fsImpl: unreadable }),
    error => error && error.code === 'RESTART_MANAGER_UNREADABLE',
  );
});

test('preflight requires an executable regular-file bash', () => {
  const fakeFs = {
    constants: { R_OK: 4, X_OK: 1 },
    statSync(target) {
      return { isFile: () => target !== '/bin/bash' };
    },
    accessSync() {},
  };
  assert.throws(
    () => preflightRestart({ rootDir: '/srv/multicc', fsImpl: fakeFs }),
    error => error && error.code === 'RESTART_BASH_INVALID',
  );

  fakeFs.statSync = () => ({ isFile: () => true });
  fakeFs.accessSync = (target, mode) => {
    if (target === '/bin/bash' && mode === fakeFs.constants.X_OK) throw new Error('not executable');
  };
  assert.throws(
    () => preflightRestart({ rootDir: '/srv/multicc', fsImpl: fakeFs }),
    error => error && error.code === 'RESTART_BASH_UNUSABLE',
  );
});

test('server composition returns 202 scheduled and resets debounce on scheduling failure', () => {
  // Restart handler + debounce live in src/routes/server-restart-route.js; server.js
  // only wires the factory. Positive assertions read the route module; the host is
  // checked for the factory wiring with the package-root rootDir.
  const routeSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'server-restart-route.js'), 'utf8');
  const hostSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(routeSrc, /try\s*\{[\s\S]*?scheduleDetachedRestart\(\{[\s\S]*?rootDir\b/);
  assert.match(routeSrc, /onFailure:[\s\S]*?_restartScheduled\s*=\s*false/);
  assert.match(routeSrc, /catch\s*\(error\)[\s\S]*?_restartScheduled\s*=\s*false[\s\S]*?res\.status\(503\)/);
  assert.match(routeSrc, /res\.status\(202\)\.json\(\{\s*ok:\s*true,\s*status:\s*'scheduled',\s*activeStreaming\s*\}\)/);
  assert.match(hostSrc, /createServerRestartRoute\(\{[\s\S]*?rootDir:\s*__dirname/);
  // Negative safety net: neither host nor route may resurrect the old shell-string form.
  const combined = hostSrc + '\n' + routeSrc;
  assert.equal(combined.includes("sleep 2 && ./multicc restart"), false);
  assert.equal(combined.includes("spawn('/bin/sh', ['-c', 'sleep 2"), false);
});

test('detached scheduler preflights, preserves lifecycle options and unreferences the child', () => {
  const { root } = createReadableManager();
  const calls = [];
  const child = createChild();
  const logs = [];
  const result = scheduleDetachedRestart({
    spawn(command, args, options) {
      calls.push({ command, args, options });
      return child;
    },
    rootDir: root,
    env: { MARKER: 'yes' },
    log: { log: (...args) => logs.push(args), error() {} },
  });
  assert.equal(result, child);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, '/bin/sh');
  assert.equal(calls[0].args.length, 1);
  const script = calls[0].args[0];
  assert.match(fs.readFileSync(script, 'utf8'), /sleep 2/);
  assert.match(fs.readFileSync(script, 'utf8'), /exec \.\/multicc restart/);
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.cwd, root);
  assert.equal(calls[0].options.env.MARKER, 'yes');
  assert.equal(calls[0].options.env.MULTICC_NODE, process.execPath);
  assert.equal(calls[0].options.stdio[0], 'ignore');
  assert.equal(calls[0].options.stdio[1], calls[0].options.stdio[2]);
  assert.equal(child.unrefCount, 1);
  assert.match(logs[0][0], /scheduled/);
});

test('detached scheduler reports a nonzero exit exactly once', () => {
  const { root } = createReadableManager();
  const child = createChild();
  const failures = [];
  const errors = [];
  scheduleDetachedRestart({
    spawn: () => child,
    rootDir: root,
    onFailure: error => failures.push(error),
    log: { log() {}, error: (...args) => errors.push(args) },
  });

  child.emit('exit', 126, null);
  child.emit('error', new Error('late duplicate'));
  assert.equal(failures.length, 1);
  assert.equal(failures[0].code, 'RESTART_CHILD_EXIT');
  assert.equal(failures[0].exitCode, 126);
  assert.match(failures[0].message, /exit 126/);
  assert.equal(errors.length, 1);
});

test('detached scheduler propagates synchronous spawn failure to the HTTP boundary', () => {
  const { root } = createReadableManager();
  assert.throws(() => scheduleDetachedRestart({
    spawn() { throw new Error('spawn unavailable'); },
    rootDir: root,
    log: { log() {}, error() {} },
  }), /spawn unavailable/);
});

test('generated delayed script invokes the manual entry safely in a quoted directory', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "multicc-restart ' $() "));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'multicc'), '#!/bin/sh\nprintf "%s" "$1" > restart-result\n', { mode: 0o700 });
  const { scriptPath } = writeRestartScript(root);
  assert.equal(fs.statSync(scriptPath).mode & 0o777, 0o700);
  const started = Date.now();
  const result = spawnSync('/bin/sh', [scriptPath], { cwd: os.tmpdir(), encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(Date.now() - started >= 1800);
  assert.equal(fs.readFileSync(path.join(root, 'restart-result'), 'utf8'), 'restart');
});
