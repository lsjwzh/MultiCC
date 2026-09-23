'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { createSdkStream } = require('../src/chat/claude-sdk-stream');
const { createStreamRouter } = require('../src/chat/stream-router');
const { createProviderAttemptRuntime } = require('../src/chat/provider-attempt-runtime');
const sdkFixture = require('./helpers/claude-sdk-fixture');

// The runtime is closed inside a try/finally so a throw from closeAndWait can
// never skip the sweep, and the sweep is what the temp-directory removal in the
// fixture depends on: a child still holding its session files makes rmSync fail
// with ENOTEMPTY, and a failing after hook skips every hook registered after it.
async function stopRuntime(runtime, children = []) {
  try { await runtime.closeAndWait('sdk'); }
  finally {
    for (const { proc } of children) {
      if (proc.exitCode !== null || proc.signalCode !== null) continue;
      try { proc.kill('SIGKILL'); } catch (_) { /* exited between check and kill */ }
    }
  }
}

async function runtimeFixture(t, reply, routing, streamDeps = {}) {
  const fixture = await sdkFixture(t, reply, routing);
  const children = [];
  const sdk = createSdkStream({ ...streamDeps, spawnProcess(...args) {
    const proc = spawn(...args); children.push({ proc, args }); return proc;
  } });
  const runtime = createStreamRouter({ status: () => null, closeAndWait: async () => ({ closed: true }) }, sdk);
  fixture.teardown.tasks.push(() => stopRuntime(runtime, children));
  const cfg = { cwd: fixture.cwd, sessionId: randomUUID(), env: fixture.env,
    sdkOptions: { model: 'claude-sonnet-4-6' } };
  const events = [];
  const send = text => runtime.send('sdk', text, event => events.push(event));
  return { ...fixture, runtime, cfg, children, events, send };
}

test('real SDK keeps one PID across rotated attempt routes, tool history and setModel', { timeout: 90000 }, async t => {
  const attempts = createProviderAttemptRuntime({ runtimeEpoch: 'sdk-test' });
  let expectedAuth, attempt;
  const attributed = [], rejected = [];
  const f = await runtimeFixture(t, ({ index, cwd }) => index === 1
    ? { type: 'tool_use', id: 'tool_read_sdk', name: 'Read', input: { file_path: path.join(cwd, 'fixture.txt') } }
    : null, {
    authorize(req, res) {
      const [, , providerId, sessionId] = req.url.split('/');
      const context = { providerId, sessionId, role: 'main' };
      const verdict = attempts.authorizeProxyRequest(context);
      if (!verdict.ok || req.headers.authorization !== `Bearer ${expectedAuth}`) {
        rejected.push(verdict); res.writeHead(403); res.end('{}'); return false;
      }
      if (!req.url.includes('count_tokens')) {
        attempts.onProxyActivity({ ...context, phase: 'request' });
        attributed.push(verdict.attempt.routeAttemptId);
        res.once('close', () => attempts.onProxyActivity({ ...context, phase: 'end' }));
      }
      return true;
    },
  });
  fs.writeFileSync(path.join(f.cwd, 'fixture.txt'), 'SDK_PERSISTED_TOOL_MARKER');
  fs.writeFileSync(path.join(f.configDir, 'settings.json'), JSON.stringify({ env: {
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', ANTHROPIC_AUTH_TOKEN: 'incorrect-user-route',
  } }));
  const origin = f.env.ANTHROPIC_BASE_URL;
  function configure(turnNo, model = 'claude-sonnet-4-6', providerId = 'provider-a') {
    if (attempt) attempts.finishAttempt(attempt, { outcome: 'completed' });
    attempt = attempts.beginAttempt({ sessionId: 'sdk', turnId: `turn-${turnNo}`, cli: 'claude-exp',
      providerId, providerRevision: 'revision-1', protocol: 'anthropic_messages', model, attemptNo: 1 });
    expectedAuth = `route-auth-${turnNo}`;
    f.cfg = { ...f.cfg, resume: turnNo > 1, sdkOptions: { ...f.cfg.sdkOptions, model },
      env: { ...f.env, ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: expectedAuth,
        ANTHROPIC_BASE_URL: `${origin}/claude-proxy/${providerId}/${attempts.proxySessionId(attempt)}` } };
    f.runtime.ensure('sdk', f.cfg);
  }
  configure(1);
  assert.equal((await f.send('remember FIRST_TURN and read fixture.txt')).subtype, 'success');
  const firstAttempt = attempt.routeAttemptId;
  const firstPid = f.runtime.status('sdk').pid;
  configure(2, 'claude-opus-4-6');
  assert.equal((await f.send('SECOND_TURN recall the tool result')).subtype, 'success');
  assert.equal(f.runtime.status('sdk').pid, firstPid);
  assert.equal(f.children.length, 1, 'two turns and setModel use one actual native child');
  assert.equal(f.requests.at(-1).model, 'claude-opus-4-6');
  assert.match(JSON.stringify(f.requests.at(-1).messages), /FIRST_TURN/);
  assert.match(JSON.stringify(f.requests.at(-1).messages), /SDK_PERSISTED_TOOL_MARKER/);
  assert.match(JSON.stringify(f.requests.at(-1).messages), /SECOND_TURN/);
  assert.deepEqual(attributed.slice(0, 2), [firstAttempt, firstAttempt]);
  assert.ok(attributed.length >= 3);
  assert.ok(attributed.slice(2).every(id => id === attempt.routeAttemptId));
  assert.deepEqual(rejected, []);
  assert.equal(attempts.authorizeProxyRequest({ sessionId: f.cfg.env.ANTHROPIC_BASE_URL.split('/').at(-1), providerId: 'provider-a' }).ok, true);

  configure(3, 'claude-opus-4-6', 'provider-b');
  await f.send('THIRD_TURN after provider switch');
  assert.equal(f.children.length, 2);
  assert.notEqual(f.runtime.status('sdk').pid, firstPid);
  assert.equal(f.children[0].proc.exitCode !== null || f.children[0].proc.signalCode !== null, true);
  assert.match(JSON.stringify(f.requests.at(-1).messages), /SDK_PERSISTED_TOOL_MARKER/);
  assert.ok(f.events.filter(e => e.subtype === 'init').every(e => e.session_id === f.cfg.sessionId));
  const privateSettings = f.children.map(({ args }) => args[1][args[1].indexOf('--settings') + 1]);
  assert.ok(privateSettings.every(file => file.endsWith('/settings.json')));
  assert.equal(fs.statSync(privateSettings.at(-1)).mode & 0o777, 0o600);
  assert.equal(f.children.some(({ args }) => args[1].some(a => a.includes('route-auth-'))), false);
  await f.runtime.closeAndWait('sdk');
  for (const file of privateSettings) assert.equal(fs.existsSync(file), false);
});

test('a stalled SDK interrupt falls back to closing the captured child before resume', { timeout: 90000 }, async t => {
  let requestStarted;
  const started = new Promise(resolve => { requestStarted = resolve; });
  const f = await runtimeFixture(t, async ({ index, res }) => {
    if (index === 1) { requestStarted(); await new Promise(resolve => res.once('close', resolve)); }
  }, undefined, { loadSdk: async () => {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    return { query(input) {
      const query = sdk.query(input);
      query.interrupt = () => new Promise(() => {});
      return query;
    } };
  } });
  f.cfg.interruptTimeoutMs = 30;
  f.runtime.ensure('sdk', f.cfg);
  const rejection = assert.rejects(f.send('blocked control'), /cancelled/);
  await started;
  f.runtime.cancel('sdk');
  await rejection;
  assert.equal(f.runtime.isAlive('sdk'), false);
  assert.equal(f.children[0].proc.exitCode !== null || f.children[0].proc.signalCode !== null, true);
  await f.send('resume after forced stop');
  assert.equal(f.children.length, 2);
  assert.ok(f.events.filter(e => e.subtype === 'init').every(e => e.session_id === f.cfg.sessionId));
});

test('SDK idle cleanup holds live background work, then closes and resumes the same history', { timeout: 90000 }, async t => {
  const f = await runtimeFixture(t);
  let background = true;
  f.cfg = { ...f.cfg, idleMs: 25, idleMaxHoldMs: 30, isBackgroundActive: () => background };
  f.runtime.ensure('sdk', f.cfg);
  await f.send('IDLE_HISTORY_MARKER');
  await new Promise(resolve => setTimeout(resolve, 90));
  assert.equal(f.runtime.isAlive('sdk'), true);
  const exited = new Promise(resolve => f.children[0].proc.once('exit', resolve));
  background = false;
  await exited;
  await f.send('after idle cleanup');
  assert.equal(f.children.length, 2);
  assert.match(JSON.stringify(f.requests.at(-1).messages), /IDLE_HISTORY_MARKER/);
});

test('closing during SDK loading cannot spawn a child after cleanup completes', async t => {
  let release, loading;
  const ready = new Promise(resolve => { loading = resolve; });
  let spawned = false;
  const runtime = createSdkStream({ loadSdk: async () => {
    loading();
    await new Promise(resolve => { release = resolve; });
    return { query() { spawned = true; throw new Error('must not spawn'); } };
  } });
  t.after(() => stopRuntime(runtime));
  runtime.ensure('sdk', { cwd: '/unused', sessionId: randomUUID(), env: {}, sdkOptions: {} });
  const rejected = assert.rejects(runtime.send('sdk', 'closing'), /cancelled/);
  await ready;
  await runtime.closeAndWait('sdk');
  release();
  await rejected;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(spawned, false);
  assert.equal(runtime.status('sdk'), null);
});

test('missing established native history fails without silently rotating its UUID', { timeout: 90000 }, async t => {
  const f = await runtimeFixture(t);
  f.cfg.resume = true;
  f.runtime.ensure('sdk', f.cfg);
  let failure;
  try { await f.send('missing history must stay missing'); } catch (error) { failure = error; }
  assert.match(JSON.stringify(f.events) + (failure?.message || ''), /No conversation found with session ID/);
  assert.equal(f.children.length, 1);
  assert.equal(f.requests.length, 0);
  assert.ok(f.children[0].args[1].includes(`--resume=${f.cfg.sessionId}`));
});

test('real SDK interrupt drains the cancelled turn and reuses the child', { timeout: 90000 }, async t => {
  let requestStarted;
  const started = new Promise(resolve => { requestStarted = resolve; });
  const f = await runtimeFixture(t, async ({ index, res }) => {
    if (index === 1) {
      requestStarted();
      await new Promise(resolve => res.once('close', resolve));
    }
  });
  f.runtime.ensure('sdk', f.cfg);
  const first = f.send('slow request');
  const rejection = assert.rejects(first, /cancelled/);
  await started;
  const pid = f.runtime.status('sdk').pid;
  const queued = assert.rejects(f.send('queued message must be cancelled'), /cancelled/);
  f.runtime.cancel('sdk');
  await Promise.all([rejection, queued]);
  assert.equal(f.runtime.status('sdk').alive, true, 'interrupt must not kill the child');
  const eventCount = f.events.length;
  assert.equal((await f.send('after interrupt')).subtype, 'success');
  assert.equal(f.runtime.status('sdk').pid, pid);
  assert.equal(f.children.length, 1);
  assert.equal(f.events.slice(eventCount).filter(e => e.type === 'result').length, 1);
  assert.doesNotMatch(JSON.stringify(f.requests), /queued message must be cancelled/);
});

test('real SDK crash recovery resumes unsuccessful tool history and pruning waits for background work', { timeout: 90000 }, async t => {
  const f = await runtimeFixture(t, ({ index, cwd }) => index === 1
    ? { type: 'tool_use', id: 'read_before_failure', name: 'Read', input: { file_path: path.join(cwd, 'fixture.txt') } }
    : null);
  fs.writeFileSync(path.join(f.cwd, 'fixture.txt'), 'ZERO_SUCCESS_HISTORY');
  f.cfg.sdkOptions.maxTurns = 1;
  f.runtime.ensure('sdk', f.cfg);
  assert.equal((await f.send('first unsuccessful round')).subtype, 'error_max_turns');
  await new Promise(resolve => { f.children[0].proc.once('exit', resolve); f.children[0].proc.kill('SIGKILL'); });
  await new Promise(resolve => setTimeout(resolve, 50));
  let background = false;
  f.cfg = { ...f.cfg, sdkOptions: { model: 'claude-sonnet-4-6' }, isBackgroundActive: () => background };
  f.runtime.ensure('sdk', f.cfg);
  await f.send('recover zero successful rounds');
  assert.equal(f.children.length, 2);
  assert.match(JSON.stringify(f.requests.at(-1).messages), /ZERO_SUCCESS_HISTORY/);
  const pid = f.runtime.status('sdk').pid;
  background = true;
  assert.equal(f.runtime.recycle('sdk', 'transcript-pruned').applied, 'deferred-background');
  await assert.rejects(f.send('must not terminate background work'), { code: 'SDK_BACKGROUND_ACTIVE' });
  assert.equal(f.runtime.status('sdk').pid, pid);
  background = false;
  await f.send('after transcript prune');
  assert.equal(f.children.length, 3);
  assert.ok(f.events.filter(e => e.subtype === 'init').every(e => e.session_id === f.cfg.sessionId));
});
