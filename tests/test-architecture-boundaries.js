'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

function requires(file) {
  const source = fs.readFileSync(file, 'utf8');
  return [...source.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map(match => match[1]);
}

test('session bounded-context core has no host or cross-context dependencies', () => {
  const files = fs.readdirSync('src/session', { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.js'))
    .map(entry => path.join('src/session', entry.name));
  assert.ok(files.length >= 5);
  for (const file of files) {
    for (const dependency of requires(file)) {
      assert.notEqual(dependency.includes('server'), true, `${file} reverse requires the host`);
      assert.doesNotMatch(dependency, /(?:directory|providers?|git|tmux|orchestration|outbox|wait-service)/);
      assert.equal(
        dependency.startsWith('./') || dependency === '../session-dto',
        true,
        `${file} has unapproved dependency ${dependency}`,
      );
    }
  }
});

test('session filesystem adapter depends only on shared data-root infrastructure', () => {
  const file = 'src/session/adapters/chat-history-file-repository.js';
  const allowed = new Set(['fs', 'path', '../../paths', '../../runtime-security']);
  for (const dependency of requires(file)) assert.equal(allowed.has(dependency), true, dependency);
});

test('no source module reverse requires server.js', () => {
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.name.endsWith('.js')) files.push(target);
    }
  };
  visit('src');
  for (const file of files) {
    for (const dependency of requires(file)) assert.doesNotMatch(dependency, /(?:^|\/)server(?:\.js)?$/);
  }
});

test('production request paths do not run synchronous child processes', () => {
  const files = ['server.js'];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.name.endsWith('.js')) files.push(target);
    }
  };
  visit('src');
  visit('plugins');
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /\b(?:execSync|execFileSync|spawnSync)\b/, file);
  }
});

test('session bundle import never resets a worktree with reset --hard', () => {
  const files = ['server.js'];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.name.endsWith('.js')) files.push(target);
    }
  };
  visit('src');
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /reset["'`,\s]+--hard/, file);
  }
});

// ── liveness → classify is a one-way dependency ──────────────────────────────
// liveness observes physical transport facts (isStreaming, claudeProc, proxy
// activity). classify is the semantic verdict (D/W/B/E/P) and is the ONLY thing
// allowed to answer "is this session busy" or "is this work done". classify may
// read liveness; nothing else may read liveness to make a work decision.

test('dispatch admission derives busy from classify plus the repo lease, never from liveness', () => {
  const source = fs.readFileSync('server.js', 'utf8');
  const start = source.indexOf('function dispatchTargetBusy(sid, item = null) {');
  assert.ok(start >= 0, 'the single dispatch busy predicate must exist');
  const predicate = source.slice(start, source.indexOf('\n}', start));
  // Classify answers "is work in flight"; the repo lease is a resource lock on
  // the session worktree (gitMergeBack rewrites the very path the CLI runs in),
  // which classify structurally cannot see — so it, and only it, is OR'd in.
  assert.match(predicate, /sessionWorkHost\?\.isRunActive\(sid\)/);
  assert.match(predicate, /taskRunHost\?\.isSlotUnavailable\(sid, item \|\| \{\}\)/);
  assert.match(predicate, /defaultRepoActor\.isLeased\(sid\)/);
  for (const liveness of [/isStreaming/, /orchestrationChatBusy/, /chatTurnPreparationRuntime/, /claudeProc/]) {
    assert.doesNotMatch(predicate, liveness, 'dispatch admission must not read liveness');
  }
  // Every admission consumer is wired to that one predicate — no second opinion.
  // (The Commander routing host was a third consumer until #38 retired pooled
  // dispatch; task work now enters through the task-bound session, which admits
  // via the same predicate inside the gateway host.)
  assert.match(source, /createGatewayHost\([\s\S]*?isTargetBusy: dispatchTargetBusy/);
  assert.match(source, /createOrchestrationRuntime\([\s\S]*?isBusy: dispatchTargetBusy/);
});

test('the classify-derived busy predicate exempts assessing so an unhealthy Aux cannot wedge dispatch', () => {
  const source = fs.readFileSync('src/session-work-host.js', 'utf8');
  const start = source.indexOf('function isRunActive(sessionId) {');
  assert.ok(start >= 0);
  const body = source.slice(start, source.indexOf('\n  }', start));
  // A turn that ends while Aux is unhealthy keeps classifyState 'P' forever:
  // classifyUnavailable defers by design, scanAndReclassify bails on an
  // unhealthy Aux, and the process watchdog deliberately skips 'assessing'.
  // Without this exemption that stuck P reads as busy and blocks every dispatch
  // for the whole outage. Do not remove it.
  assert.match(body, /queueState === 'assessing'/);
  assert.doesNotMatch(body, /isStreaming|claudeProc|chatStream/);
});

test('only the shutdown drain reads raw liveness for a work decision', () => {
  // The drain cannot wait on classify: classify is produced by the Aux queue the
  // drain is draining, so depending on it would be circular. Every other
  // consumer goes through classify.
  const drain = fs.readFileSync('src/host-lifecycle.js', 'utf8');
  assert.match(drain, /shutdownCoordinator\.onDrain/);
  assert.match(drain, /cs\.claudeProc \|\| isStreamingBusy\(name, cs\)/);
  const gateway = fs.readFileSync('src/dispatch/gateway-host.js', 'utf8');
  assert.match(gateway, /active: !!isTargetBusy\(s\.id\)/);
  assert.doesNotMatch(gateway, /activeChat\.isStreaming|clients\.size > 0/);
  for (const file of ['src/commander-router.js', 'src/task-board.js', 'src/routes/task-board.js']) {
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /isStreaming|claudeProc/, file);
  }
});

test('liveness never becomes a display state and never completes work', () => {
  const workHost = fs.readFileSync('src/session-work-host.js', 'utf8');
  const start = workHost.indexOf('function getRunState(sessionId) {');
  const runState = workHost.slice(start, workHost.indexOf('\n  }', start));
  assert.doesNotMatch(runState, /isStreaming|claudeProc|liveness/);
  // The liveness verdict (working|idle|stalled|unknown) has its own pill and must
  // never leak into the run-state vocabulary the cards and bars render from.
  assert.doesNotMatch(workHost, /'(?:working|stalled)'/);
  // Classify publishes only a turn projection. A D verdict returns succeeded
  // directly and cannot manufacture TaskBoard lifecycle done.
  assert.match(runState, /return deps\.classifyDisplay\(classifyState\)\.cardStatus/);
  assert.doesNotMatch(runState, /\bdone\b|completed/);
});
