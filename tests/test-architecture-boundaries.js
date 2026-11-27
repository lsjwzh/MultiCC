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
  const historyPort = path.join('src/session', 'chat-history-service', 'index.js');
  files.push(historyPort);
  assert.ok(files.length >= 5);
  for (const file of files) {
    for (const dependency of requires(file)) {
      assert.notEqual(dependency.includes('server'), true, `${file} reverse requires the host`);
      assert.doesNotMatch(dependency, /(?:directory|providers?|git|tmux|orchestration|outbox|wait-service)/);
      // node:-prefixed builtins carry no cross-context coupling, so IO modules
      // (persistence/hibernation) may use them; everything else must stay local.
      // The migrated transition, record table, history query-identity rule and
      // chat-runtime busy and hibernation path resolution reach Rust through
      // the shared addon loader.
      // This grants no other session module a host import.
      const nativeCorePort = (file === path.join('src/session', 'hibernation-composition.js')
        || file === path.join('src/session', 'records.js')
        || file === path.join('src/session', 'hibernation.js')
        || file === path.join('src/session', 'workspace-service.js')
        || file === path.join('src/session', 'query-service.js'))
        && dependency === '../native/binding'
        || file === historyPort && dependency === '../../native/binding';
      assert.equal(
        dependency.startsWith('node:') || dependency.startsWith('./')
          || nativeCorePort,
        true,
        `${file} has unapproved dependency ${dependency}`,
      );
    }
  }
});

test('session filesystem adapter stays retired in favour of the native facade factory', () => {
  assert.equal(fs.existsSync('src/session/adapters/chat-history-file-repository.js'), false);
  const server = fs.readFileSync('server.js', 'utf8');
  assert.ok(server.includes('getNative().chatHistoryFileRepositoryCreate('));
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
  // src/server-processes.js is the restart manager's CLI: the multicc script
  // and the delayed restart manager spawn it as its own process (`node
  // src/server-processes.js list|stop|lock-alive|owner`), so it never runs
  // inside a request path and may deliberately block.
  // src/cli-adapters/commands.js probes Qoder install candidates with
  // `--version` once per process (resolveCliCommands() is a synchronous
  // startup-time API and the probe is memoized), so it never blocks a request;
  // removing the memo or probing per request must also remove this exemption.
  const exempt = new Set(['src/server-processes.js', 'src/cli-adapters/commands.js']);
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
    if (exempt.has(file)) continue;
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
  // The gate is spelled as a reason list — so the outbox skip log and the
  // insert-queued response can say WHICH veto fired — plus a boolean derived
  // from that one list. The obligations below live in the list.
  const start = source.indexOf('const dispatchTargetBusyReasons = getNative().createDispatchBusyReasons({');
  assert.ok(start >= 0, 'the single dispatch busy predicate must exist');
  const predicate = source.slice(start, source.indexOf('\n});', start));
  // Classify answers "is work in flight"; the repo lease is a resource lock on
  // the session worktree (gitMergeBack rewrites the very path the CLI runs in),
  // which classify structurally cannot see — so it, and only it, is OR'd in.
  assert.match(predicate, /sessionWorkHost\?\.isRunActive\(sid\)/);
  assert.match(predicate, /defaultRepoActor\.isLeased\(sid\)/);
  for (const liveness of [/isStreaming/, /orchestrationChatBusy/, /chatTurnPreparationRuntime/, /claudeProc/]) {
    assert.doesNotMatch(predicate, liveness, 'dispatch admission must not read liveness');
  }
  // The boolean has to stay derived from the list: if the two could disagree,
  // the skip log would explain a veto the caller never saw.
  const wrapperStart = source.indexOf('function dispatchTargetBusy(sid, item = null) {');
  assert.ok(wrapperStart >= 0, 'the derived boolean wrapper must exist');
  const wrapper = source.slice(wrapperStart, source.indexOf('\n}', wrapperStart));
  assert.match(wrapper, /dispatchTargetBusyReasons\(sid, item\)\.length > 0/);
  // Every admission consumer is wired to that one predicate — no second opinion.
  // (The Commander routing host was a third consumer until #38 retired pooled
  // dispatch; task work now enters through the task-bound session, which admits
  // via the same predicate inside the gateway host.)
  assert.match(source, /createDispatchTargeting\([\s\S]*?isTargetBusy: dispatchTargetBusy/);
  assert.match(source, /createGatewayHost\([\s\S]*?isTargetBusy: dispatchTargetBusy/);
  assert.match(source, /createOrchestrationRuntime\([\s\S]*?isBusy: dispatchTargetBusy/);
});

test('dispatch checks every veto in order and only diagnoses a busy target', () => {
  const { createDispatchBusyReasons } = require('../src/native/binding').getNative();
  const seen = [];
  const probe = (name, result) => id => {
    seen.push([name, id]);
    if (result instanceof Error) throw result;
    return result;
  };
  const names = ['occupied', 'runActive', 'leased', 'shellBusy', 'stuckHint'];
  const check = values => createDispatchBusyReasons(Object.fromEntries(
    names.map((key, i) => [key, probe(key, values[i])])))('s');
  const err = Object.assign(new Error('workspace unavailable'), { code: 'missing_workspace' });
  assert.deepEqual(check([false, false, false, false, true]), []);
  assert.deepEqual(seen.splice(0), names.slice(0, 4).map(key => [key, 's']));
  assert.deepEqual(check([err, true, err, err, 'stuck']), [
    'missing_workspace', 'run_active', 'repo_lease_check_failed', 'task_shell_busy_check_failed', 'stuck',
  ]);
  assert.deepEqual(seen.splice(0), names.map(key => [key, 's']));
  assert.deepEqual(check([new Error(), err, true, true, err]), [
    'workspace_occupied_check_failed', 'run_active_check_failed', 'repo_lease', 'task_shell_workspace_busy',
  ]);
});

test('the classify-derived busy predicate exempts transient assessing work', () => {
  const source = fs.readFileSync('native/addon/src/session_work_host/transitions/recovery.rs', 'utf8');
  const start = source.indexOf('fn run_active');
  assert.ok(start >= 0);
  const body = source.slice(start, source.indexOf('\n}', start));
  // Aux attribution is asynchronous bookkeeping. It must not make the runner
  // look busy and block the session's next real request.
  assert.match(body, /c"queueState"[\s\S]*?"assessing"/);
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
  for (const file of [
    'native/addon/src/task_board_runtime/core.rs', 'src/task-board/core/index.js', 'src/task-board/normalize.js',
    'src/task-board/native-bridge.js', 'src/task-board/routing.js', 'native/addon/src/task_board_runtime/routing.rs',
    'native/addon/src/task_board_view.rs', 'src/task-board/planning.js',
    'src/routes/task-board/index.js', 'native/addon/src/task_board_runtime/projection/events.rs',
    'native/addon/src/task_board_runtime/projection/view.rs',
  ]) {
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /isStreaming|claudeProc/, file);
  }
});

test('liveness never becomes a display state and never completes work', () => {
  const workHost = fs.readFileSync('native/addon/src/session_work_host/transitions/recovery.rs', 'utf8');
  const start = workHost.indexOf('fn run_state');
  const runState = workHost.slice(start, workHost.indexOf('\n}', start));
  assert.doesNotMatch(runState, /isStreaming|claudeProc|liveness/);
  // The liveness verdict (working|idle|stalled|unknown) has its own pill and must
  // never leak into the run-state vocabulary the cards and bars render from.
  assert.doesNotMatch(workHost, /'(?:working|stalled)'/);
  // Classify publishes only a turn projection. A D verdict returns succeeded
  // directly and cannot manufacture TaskBoard lifecycle done.
  assert.match(runState, /c"classifyDisplay"[\s\S]*?c"cardStatus"/);
  assert.doesNotMatch(runState, /\bdone\b|completed/);
});

test('session creation factory stays in the native addon', () => {
  assert.equal(fs.existsSync('src/session/create-record.js'), false);
  assert.ok(fs.readFileSync('server.js', 'utf8').includes('getNative().sessionCreateRecordFactory('));
});


test('login-terminal disposer is owned by the native addon', () => {
  assert.equal(fs.existsSync('src/session/login-terminal.js'), false);
  assert.ok(fs.readFileSync('server.js', 'utf8').includes('getNative().sessionLoginTerminalDisposer('));
});


test('session delivery is provided by the native addon', () => {
  assert.equal(fs.existsSync('src/session/delivery.js'), false);
  assert.ok(fs.readFileSync('server.js', 'utf8').includes('getSessionDeliveryApi().createSessionDelivery('));
});
