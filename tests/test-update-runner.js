'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const {
  EXIT_MARKER,
  START_MARKER,
  UPDATE_LOG_RELATIVE,
  buildUpdateShellCommand,
  preflightUpdate,
  parseUpdateLog,
  readUpdateStatus,
  startDetachedUpdate,
} = require('../src/update-runner');
const { createUpdateRoute } = require('../src/routes/update-route');

// The directory name contains a space and a quote on purpose: the shell command
// is assembled as a string, so a naive concatenation would write the log
// somewhere else entirely (or run the wrong command) on a path like this.
function createFixture({ managerBody = '#!/bin/bash\necho "manager ran: $*"\n' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "multicc up'date-"));
  fs.writeFileSync(path.join(root, 'multicc'), managerBody, { mode: 0o600 });
  fs.mkdirSync(path.join(root, '.git'));
  return root;
}

function runUpdateSynchronously(root, { force = false } = {}) {
  const command = buildUpdateShellCommand({ rootDir: root, force });
  const result = spawnSync('/bin/sh', ['-c', command], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result;
}

function createChild() {
  const child = new EventEmitter();
  child.unrefCount = 0;
  child.unref = () => { child.unrefCount += 1; };
  return child;
}

function createFakeApp() {
  const routes = { get: new Map(), post: new Map() };
  return {
    routes,
    get(routePath, handler) { routes.get.set(routePath, handler); },
    post(routePath, handler) { routes.post.set(routePath, handler); },
  };
}

function createRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  return res;
}

test('the update runs through bash without an executable bit and its outcome survives on disk', () => {
  const root = createFixture();
  assert.equal((fs.statSync(path.join(root, 'multicc')).mode & 0o111), 0, 'fixture intentionally has no executable bit');
  runUpdateSynchronously(root);

  const status = readUpdateStatus({ rootDir: root });
  assert.equal(status.state, 'succeeded');
  assert.equal(status.running, false);
  assert.equal(status.exitCode, 0);
  assert.equal(status.force, false);
  assert.match(status.tail, /manager ran: update$/m);
  // The markers are bookkeeping, not output the user should read.
  assert.equal(status.tail.includes(EXIT_MARKER), false);
  assert.equal(status.tail.includes(START_MARKER), false);
  assert.match(status.startedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.equal(status.logPath, path.join(root, UPDATE_LOG_RELATIVE));
});

test('--force reaches the manager as a flag and is reported back in the status', () => {
  const root = createFixture();
  runUpdateSynchronously(root, { force: true });

  const status = readUpdateStatus({ rootDir: root });
  assert.equal(status.state, 'succeeded');
  assert.equal(status.force, true);
  assert.match(status.tail, /manager ran: update --force$/m);
});

test('a failing update is reported as failed with the manager exit code, not as merely finished', () => {
  const root = createFixture({ managerBody: '#!/bin/bash\necho "conflict in working tree" >&2\nexit 3\n' });
  runUpdateSynchronously(root);

  const status = readUpdateStatus({ rootDir: root });
  assert.equal(status.state, 'failed');
  assert.equal(status.running, false);
  assert.equal(status.exitCode, 3);
  // stderr is captured too — the reason a force update is needed is usually there.
  assert.match(status.tail, /conflict in working tree/);
});

test('each run truncates the log so a previous run cannot be read as this one', () => {
  const root = createFixture({ managerBody: '#!/bin/bash\necho "FIRST RUN OUTPUT"\n' });
  runUpdateSynchronously(root);
  assert.match(readUpdateStatus({ rootDir: root }).tail, /FIRST RUN OUTPUT/);

  fs.writeFileSync(path.join(root, 'multicc'), '#!/bin/bash\necho "SECOND RUN OUTPUT"\nexit 1\n', { mode: 0o600 });
  runUpdateSynchronously(root);
  const status = readUpdateStatus({ rootDir: root });
  assert.equal(status.exitCode, 1, 'the second run owns the exit code');
  assert.equal(status.tail.includes('FIRST RUN OUTPUT'), false);
  assert.match(status.tail, /SECOND RUN OUTPUT/);
});

test('status is idle before any update and running while one is in flight', () => {
  const root = createFixture();
  const idle = readUpdateStatus({ rootDir: root });
  assert.equal(idle.state, 'idle');
  assert.equal(idle.running, false);
  assert.equal(idle.exitCode, null);

  fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(root, UPDATE_LOG_RELATIVE), `${START_MARKER} 2026-08-03T10:00:00Z force=0\nUpdating MultiCC...\n`);
  const running = readUpdateStatus({ rootDir: root });
  assert.equal(running.state, 'running');
  assert.equal(running.running, true);
  assert.equal(running.exitCode, null);
  assert.match(running.tail, /Updating MultiCC/);
});

test('a run that dies without writing its marker goes stale instead of running forever', () => {
  const root = createFixture();
  fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
  const logPath = path.join(root, UPDATE_LOG_RELATIVE);
  fs.writeFileSync(logPath, `${START_MARKER} 2026-08-03T10:00:00Z force=1\nhalf a log\n`);
  const mtime = fs.statSync(logPath).mtimeMs;

  // Silence is measured from the last write: a quiet npm install must stay
  // "running", but a run silent past the threshold is gone for good.
  const nearlyStale = readUpdateStatus({ rootDir: root, now: () => mtime + (14 * 60 * 1000) });
  assert.equal(nearlyStale.state, 'running');
  assert.equal(nearlyStale.running, true);

  const stale = readUpdateStatus({ rootDir: root, now: () => mtime + (16 * 60 * 1000) });
  assert.equal(stale.state, 'stale');
  assert.equal(stale.running, false, 'a stale run must not block a retry');
  assert.equal(stale.force, true);
});

test('the log parser takes the newest exit marker and never a truncated number', () => {
  const parsed = parseUpdateLog(`${START_MARKER} 2026-08-03T10:00:00Z force=0\nfirst\n${EXIT_MARKER} 1\nsecond\n${EXIT_MARKER} 0\n`);
  assert.equal(parsed.exitCode, 0);
  assert.equal(parsed.startedAt, '2026-08-03T10:00:00Z');
  assert.equal(parsed.force, false);
  assert.equal(parseUpdateLog('').exitCode, null);
  assert.equal(parseUpdateLog(null).exitCode, null);
});

test('preflight refuses an install the update cannot possibly work on', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-update-preflight-'));
  assert.throws(
    () => preflightUpdate({ rootDir: root }),
    error => error && error.code === 'UPDATE_MANAGER_MISSING',
  );

  fs.writeFileSync(path.join(root, 'multicc'), '#!/bin/bash\n', { mode: 0o600 });
  assert.throws(
    () => preflightUpdate({ rootDir: root }),
    error => error && error.code === 'UPDATE_NOT_A_GIT_CHECKOUT',
  );

  fs.mkdirSync(path.join(root, '.git'));
  assert.deepEqual(preflightUpdate({ rootDir: root }), Object.freeze({
    managerPath: path.join(root, 'multicc'),
    bashPath: '/bin/bash',
  }));
  assert.ok(fs.statSync(path.join(root, 'logs')).isDirectory(), 'preflight creates the log directory it checks');
});

// A `>` redirect that cannot be opened makes /bin/sh skip the whole block: the
// update never runs and never writes a log, so status would read `idle` until the
// client gives up minutes later. Preflight has to turn that into an error at the
// HTTP boundary instead.
test('an unwritable log directory is refused up front, not discovered by timeout', () => {
  if (process.getuid && process.getuid() === 0) return; // root ignores mode bits

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-update-logdir-'));
  fs.writeFileSync(path.join(root, 'multicc'), '#!/bin/bash\n', { mode: 0o600 });
  fs.mkdirSync(path.join(root, '.git'));

  // logs/ exists but cannot be written into.
  fs.mkdirSync(path.join(root, 'logs'), { mode: 0o500 });
  try {
    assert.throws(
      () => preflightUpdate({ rootDir: root }),
      error => error && error.code === 'UPDATE_LOG_UNWRITABLE',
    );
  } finally {
    fs.chmodSync(path.join(root, 'logs'), 0o700);
  }

  // logs/ missing, and the root it would be created in is read-only.
  fs.rmSync(path.join(root, 'logs'), { recursive: true });
  fs.chmodSync(root, 0o500);
  try {
    assert.throws(
      () => preflightUpdate({ rootDir: root }),
      error => error && error.code === 'UPDATE_LOG_UNWRITABLE',
    );
  } finally {
    fs.chmodSync(root, 0o700);
  }
});

test('the update child is detached so the restart it performs cannot kill it', () => {
  const root = createFixture();
  const calls = [];
  const child = createChild();
  const result = startDetachedUpdate({
    spawn(command, args, options) {
      calls.push({ command, args, options });
      return child;
    },
    rootDir: root,
    force: true,
    env: { MARKER: 'yes' },
    log: { log() {}, error() {} },
  });
  assert.equal(result, child);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, '/bin/sh');
  assert.equal(calls[0].options.detached, true, 'do_stop kills the server process group');
  assert.equal(calls[0].options.cwd, root);
  assert.equal(calls[0].options.stdio, 'ignore');
  assert.deepEqual(calls[0].options.env, { MARKER: 'yes' });
  assert.match(calls[0].args[1], /multicc update --force/);
  assert.equal(child.unrefCount, 1);
});

test('a synchronous spawn failure reaches the HTTP boundary as 503 with a code, and frees the flag', () => {
  const root = createFixture();
  const route = createUpdateRoute({
    chatSessions: new Map(),
    spawn() { const error = new Error('nope'); error.code = 'EAGAIN'; throw error; },
    rootDir: root,
    log: { log() {}, error() {} },
  });
  const app = createFakeApp();
  route.mountRoutes(app);

  const res = createRes();
  app.routes.post.get('/api/update')({ body: {}, id: 'req-1' }, res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, 'UPDATE_START_FAILED');

  // The failed attempt must not leave the route 409-ing forever.
  const second = createRes();
  app.routes.post.get('/api/update')({ body: {}, id: 'req-2' }, second);
  assert.equal(second.statusCode, 503);
});

test('the route starts one update, reports the turns it will interrupt, and rejects a second', () => {
  const root = createFixture();
  const spawned = [];
  const chatSessions = new Map([
    ['a', { isStreaming: true, lastStreamAt: Date.now() }],
    ['b', { isStreaming: true, lastStreamAt: Date.now() - (20 * 60 * 1000) }],
    ['c', { isStreaming: false, lastStreamAt: Date.now() }],
  ]);
  const route = createUpdateRoute({
    chatSessions,
    spawn(command, args, options) { spawned.push({ command, args, options }); return createChild(); },
    rootDir: root,
    log: { log() {}, error() {} },
  });
  const app = createFakeApp();
  route.mountRoutes(app);

  const res = createRes();
  app.routes.post.get('/api/update')({ body: { force: true }, id: 'req-1' }, res);
  assert.equal(res.statusCode, 202);
  assert.deepEqual(res.body, { ok: true, status: 'started', force: true, activeStreaming: 1 });
  assert.match(spawned[0].args[1], /multicc update --force/);

  // Second call within the debounce window: the log does not exist yet, so only
  // the in-memory flag can catch this.
  const second = createRes();
  app.routes.post.get('/api/update')({ body: {}, id: 'req-2' }, second);
  assert.equal(second.statusCode, 409);
  assert.equal(spawned.length, 1, 'a concurrent update must never be spawned');
});

test('a running update on disk blocks a new one even in a server that never started it', () => {
  // This is the restart case: the process that answers the second request is
  // not the one that started the update, so its in-memory flag is false.
  const root = createFixture();
  fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(root, UPDATE_LOG_RELATIVE), `${START_MARKER} 2026-08-03T10:00:00Z force=0\nrunning\n`);

  const route = createUpdateRoute({
    chatSessions: new Map(),
    spawn() { throw new Error('must not spawn'); },
    rootDir: root,
    log: { log() {}, error() {} },
  });
  const app = createFakeApp();
  route.mountRoutes(app);

  const res = createRes();
  app.routes.post.get('/api/update')({ body: {}, id: 'req-1' }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.status.state, 'running');

  const status = createRes();
  app.routes.get.get('/api/update/status')({}, status);
  assert.equal(status.body.state, 'running');
});

test('the status route survives an unreadable root instead of failing the page', () => {
  const route = createUpdateRoute({
    chatSessions: new Map(),
    spawn() {},
    rootDir: path.join(os.tmpdir(), 'multicc-does-not-exist-' + process.pid),
    log: { log() {}, error() {} },
  });
  const app = createFakeApp();
  route.mountRoutes(app);
  const res = createRes();
  app.routes.get.get('/api/update/status')({}, res);
  assert.equal(res.body.state, 'idle');
  assert.equal(res.body.running, false);
});

test('server.js wires the update route with the package root and keeps it auth-gated', () => {
  const hostSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const authSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'auth.js'), 'utf8');
  assert.match(hostSrc, /createUpdateRoute\(\{[\s\S]*?rootDir:\s*__dirname/);
  assert.equal(authSrc.includes('/api/update'), false, 'the update route must not be in the auth bypass list');
});
