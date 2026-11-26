'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
// The chat turn engine (runChatTurn / runChatTurnStreaming / finalizeStreamingTurn)
// now uses src/chat/turn-engine-host.js for its Node ports; assertions that scan for those shapes read
// the concatenated host + engine source.
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8')
  + '\n' + fs.readFileSync(path.join(root, 'src', 'chat', 'turn-engine-host.js'), 'utf8');
// Adapter-neutral native-session capture and the resume-mismatch kill live in
// the native chat-event reducer.
const nativeChatEvents = fs.readFileSync(
  path.join(root, 'native', 'addon', 'src', 'chat_events.rs'), 'utf8');
// The classify E-branch (with its classifier_legacy fallback) now lives in the
// extracted classify state machine.
const classifyStateMachine = fs.readFileSync(
  path.join(root, 'native/addon/src/classify_machine/dispatch/settle.rs'), 'utf8');
const apiErrorHost = fs.readFileSync(
  path.join(root, 'src', 'chat', 'api-error-host.js'), 'utf8');
const waitInjector = fs.readFileSync(path.join(root, 'src', 'wait', 'injector.js'), 'utf8');

test('Classify no longer owns an uncapped API retry or error-text pruning channel', () => {
  assert.equal(server.includes('API error -> retry (uncapped)'), false);
  assert.equal(server.includes('pruneErrorTurnPairs'), false);
  assert.equal(server.includes('API_RETRY_DELAY_MS'), false);
  assert.equal(classifyStateMachine.includes('"classifier_legacy"'), true);
  assert.equal(waitInjector.includes('API retries now live in src/chat/api-error-policy.js'), true);
});

test('process and stream retries reuse the owned turn without appending a second user message', () => {
  const native = require('../src/native/binding').getNative();
  const processPlan = fs.readFileSync(path.join(root, 'native/addon/src/turn_process_close.rs'), 'utf8');
  const processEffects = fs.readFileSync(path.join(root, 'native/addon/src/turn_process_close/execute.rs'), 'utf8');
  assert.ok(processPlan.indexOf('let guarded =') >= 0 && processPlan.indexOf('let classify =') > processPlan.indexOf('let guarded ='));
  assert.match(processPlan, /\(!guarded \|\| error_only\)/);
  assert.match(processPlan, /cs.get\(c"_adapterError"\)\?\.truthy\(\)\?\s*\|\| run.get\(c"adapterError"/);
  assert.match(processEffects, /"retryBlocked"/);
  assert.doesNotMatch(processEffects, /c"appendChatMessage"/);
  const invoked = [], scheduled = [];
  const ctx = { cs: { cli: 'codex' }, turn: { turnId: 't' }, persisted: {}, sessionName: 's',
    runner: { providerAttempt: { providerId: 'owned', model: '_default_' } } };
  const ports = {
    finishProviderAttempt() {}, scheduleOwnedRetry: value => scheduled.push(value),
    prepareInvocation: opts => { invoked.push(opts); return opts; }, spawnChat: (...args) => args,
  };
  for (const auto of [null, { invocationOptions: { providerId: 'next', model: 'm' } }]) {
    native.chatExecuteProcessClose(ports, ctx, { finalizePlan: { action: 'retry-api', retry: { attempt: 3 } },
      apiErrorDecision: {}, autoFailover: auto });
    const [invocation, retry, attempt] = scheduled.at(-1).start();
    assert.equal(invocation, invoked.at(-1));
    assert.equal(invocation.providerId, auto ? 'next' : 'owned');
    assert.equal(invocation.model, auto ? 'm' : null);
    assert.equal(retry, true);
    assert.equal(attempt, 3);
  }

  const finish = path.join(root, 'native/addon/src/turn_engine/stream_finish');
  const streamPlan = fs.readFileSync(finish + '.rs', 'utf8');
  const streamExecution = fs.readFileSync(path.join(finish, 'execution.rs'), 'utf8');
  assert.match(streamPlan, /c"evaluateTurnApiError"/);
  assert.match(streamExecution, /c"scheduleOwnedRetry"/);
  assert.match(streamExecution, /"same_provider_retry"[\s\S]{0,240}provider_retry_route_options\(/);
  assert.match(streamExecution, /c"runChatTurnStreaming"[\s\S]{0,480}prop\(prop\(plan, c"retry"\)\?, c"attempt"\)/);
  assert.match(streamExecution, /"retryBlocked"/);
  assert.doesNotMatch(streamExecution, /c"runChatTurn"/);

});

test('a fresh Codex fallback owns and replaces its newly allocated native thread', () => {
  const launch = fs.readFileSync(path.join(root, 'native/addon/src/turn_engine/process_runner.rs'), 'utf8');
  assert.match(launch, /c"freshNativeSession",[\s\S]{0,280}c"invocationEnvelope"[\s\S]{0,100}c"historyHandle"[\s\S]{0,80}c"isFirstTurn"[\s\S]{0,60}is_true/);
  assert.match(nativeChatEvents,
    /chat_events::capture_session_id\(previous\.as_ref\(\), incoming\.as_ref\(\), may_replace\)/,
    'native session capture must still gate a changed resume on the fresh-thread flag');
  assert.match(nativeChatEvents,
    /assign_kill_reason\(\s*runner,\s*text\(anchor, "native_resume_mismatch"\)/,
    'a resume that starts an unexpected native thread must be killed, not silently ignored');
  assert.match(launch,
    /\("logicalSessionId", st\.session\),\s*\("nativeSessionId", rec\.get\(c"cliSessionId"\)/,
    'every physical Codex attempt must bind its canonical session root before spawn');
});

test('host persistence and broadcast expose only stable policy fields', () => {
  assert.equal(apiErrorHost.includes("type: 'api_error_policy'"), true);
  assert.equal(apiErrorHost.includes('setTaskState(sessionName, { apiError: durableSafe }'), true);
  assert.equal(apiErrorHost.includes('providerRouteScope: _scope, runtimeEpoch: _epoch, turnId: _turnId'), true,
    'ephemeral attempt correlation must be stripped from durable task state');
  assert.equal(apiErrorHost.includes('...safe,'), true,
    'the live policy event keeps exact attempt correlation for client fencing');
  const io = fs.readFileSync(path.join(root, 'native/addon/src/turn_engine/process_runner/io.rs'), 'utf8');
  assert.match(io, /st\.log\(\s*c"warn",\s*"chat_provider_stderr"/);
  assert.equal(server.includes('[multicc/chat] stderr:'), false);
});

test('typed continuations clear stale API error ownership before launching', () => {
  const execution = fs.readFileSync(path.join(root, 'native/addon/src/turn_engine/execution.rs'), 'utf8');
  assert.match(execution, /opts\.get\(c"directUserInput"\)\?\.is_true\(\)/);
  const prepare = fs.readFileSync(path.join(root, 'native/addon/src/turn_engine/task_start/preparation.rs'), 'utf8');
  assert.match(prepare, /!self\.ctx\.get\(c"originContinue"\)[\s\S]{0,70}\|\| self\.ctx\.get\(c"directUserInput"\)/);
  assert.match(prepare, /if self\.fresh\(\)\? \{\s*self\.service\(c"apiErrorHost", c"cancelRetry"/);
  assert.match(prepare, /"originContinue", flag\(s, !self\.fresh\(\)\?\)/);
});

test('API error handling installs no cross-request recovery or admission gate', () => {
  assert.equal(apiErrorHost.includes('heldSessions'), false);
  assert.equal(apiErrorHost.includes('resumeHeldSessions'), false);
  assert.equal(apiErrorHost.includes('auxHealthProbe'), false);
  assert.equal(apiErrorHost.includes('isNetworkUnhealthy'), false);
  assert.equal(apiErrorHost.includes('sessionDelivery.deliverRetry'), false);
});
