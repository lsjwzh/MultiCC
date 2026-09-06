'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
// The chat turn engine (runChatTurn / runChatTurnStreaming / finalizeStreamingTurn)
// now lives in src/chat/turn-engine.js; assertions that scan for those shapes read
// the concatenated host + engine source.
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8')
  + '\n' + fs.readFileSync(path.join(root, 'src', 'chat', 'turn-engine.js'), 'utf8');
// The classify E-branch (with its classifier_legacy fallback) now lives in the
// extracted classify state machine.
const classifyStateMachine = fs.readFileSync(
  path.join(root, 'src', 'classify', 'state-machine.js'), 'utf8');
const apiErrorHost = fs.readFileSync(
  path.join(root, 'src', 'chat', 'api-error-host.js'), 'utf8');
const waitInjector = fs.readFileSync(path.join(root, 'src', 'wait-injector.js'), 'utf8');
const sessionDelivery = fs.readFileSync(path.join(root, 'src', 'session-delivery.js'), 'utf8');

test('Classify no longer owns an uncapped API retry or error-text pruning channel', () => {
  assert.equal(server.includes('API error -> retry (uncapped)'), false);
  assert.equal(server.includes('pruneErrorTurnPairs'), false);
  assert.equal(server.includes('API_RETRY_DELAY_MS'), false);
  assert.equal(classifyStateMachine.includes("source: 'classifier_legacy'"), true);
  assert.equal(waitInjector.includes('API retries now live in src/chat/api-error-policy.js'), true);
});

test('process and stream retries reuse the owned turn without appending a second user message', () => {
  const processStart = server.indexOf('const spawnChat = (prepared, isRetry, apiRetryAttempt = 0)');
  const processEnd = server.indexOf('cs.claudeProc = spawnChat(initialInvocation, false)', processStart);
  const processBody = server.slice(processStart, processEnd);
  assert.ok(processStart >= 0 && processEnd > processStart);
  assert.equal(processBody.includes('evaluateTurnApiError({'), true);
  const processGuard = processBody.indexOf('const guardedHandoffResumeFailure = isGuardedHandoffFailure({');
  const processPolicy = processBody.indexOf('const apiErrorDecision = shouldClassifyApiError');
  assert.ok(processGuard >= 0 && processPolicy > processGuard,
    'process reused-target guard must run before generic API policy');
  assert.match(processBody,
    /const shouldClassifyApiError = \(!guardedHandoffResumeFailure \|\| errorOnlyBoundary\) && !!\(/,
    'process guard yields only to a host-proved, replay-safe provider error envelope');
  assert.match(processBody,
    /retryBlockedByAdapterError: !!cs\._adapterError \|\| !!runner\.adapterError/,
    'process guard must preserve both close-time and runner-owned adapter vetoes');
  assert.equal(processBody.includes('scheduleOwnedRetry({'), true);
  assert.match(processBody,
    /const currentRouteOptions = \(\) => providerRetryRouteOptions\(runner\.providerAttempt\)/,
    'all process retries must decode the physical default-model sentinel before rebuilding');
  assert.match(processBody,
    /retryInvocation = prepareInvocation\(autoFailover\?\.invocationOptions\s*\|\| \{ reasonCode: 'same_provider_retry', \.\.\.currentRouteOptions\(\) \}\)/,
    'each physical retry must resolve a fresh concrete provider attempt, optionally on the Auto fallback');
  assert.match(processBody,
    /reasonCode: 'codex_transport_continuation', \.\.\.currentRouteOptions\(\)/,
    'native continuation must remain pinned to the current physical Auto route');
  assert.equal(processBody.includes('spawnChat(retryInvocation, true, finalizePlan.retry.attempt)'), true);
  assert.equal(processBody.includes('appendChatMessage(sessionName'), false,
    'retry runner reuses the already durable canonical user event');

  const streamStart = server.indexOf('function runChatTurnStreaming(');
  const streamEnd = server.indexOf('// ── Chat mode:', streamStart);
  const streamBody = server.slice(streamStart, streamEnd);
  assert.ok(streamStart >= 0 && streamEnd > streamStart);
  assert.equal(streamBody.includes('evaluateTurnApiError({'), true);
  assert.equal(streamBody.includes('scheduleOwnedRetry({'), true);
  assert.match(streamBody,
    /reasonCode: 'same_provider_retry',\s*\.\.\.providerRetryRouteOptions\(runner\.providerAttempt\)/,
    'stream retries must decode the physical default-model sentinel before rebuilding');
  assert.match(streamBody,
    /runChatTurnStreaming\(\s*sessionName,\s*cs,\s*persisted,\s*retryInvocation,\s*provider,\s*turn,\s*prepareInvocation,\s*autoTurn,\s*plan\.retry\.attempt,?\s*\)/);
  assert.equal(streamBody.includes('runChatTurn(sessionName'), false,
    'stream retry must not create a second canonical user message');
});

test('a fresh Codex fallback owns and replaces its newly allocated native thread', () => {
  assert.match(server,
    /runner\.freshNativeSession = prepared\.invocationEnvelope\.historyHandle\.isFirstTurn === true/);
  assert.match(server,
    /captureNativeSessionId\(persisted, evt\.sessionId, \{ fresh: runner\.freshNativeSession \}\)/);
  assert.match(server, /assignKillReason\(runner, 'native_resume_mismatch'\)/,
    'a resume that starts an unexpected native thread must be killed, not silently ignored');
  assert.match(server,
    /logicalSessionId: sessionName, nativeSessionId: persisted\.cliSessionId/,
    'every physical Codex attempt must bind its canonical session root before spawn');
});

test('host persistence and broadcast expose only stable policy fields', () => {
  assert.equal(apiErrorHost.includes("type: 'api_error_policy'"), true);
  assert.equal(apiErrorHost.includes('setTaskState(sessionName, { apiError: durableSafe }'), true);
  assert.equal(apiErrorHost.includes('providerRouteScope: _scope, runtimeEpoch: _epoch, turnId: _turnId'), true,
    'ephemeral attempt correlation must be stripped from durable task state');
  assert.equal(apiErrorHost.includes('...safe,'), true,
    'the live policy event keeps exact attempt correlation for client fencing');
  assert.equal(server.includes("logger.warn('chat_provider_stderr'"), true);
  assert.equal(server.includes('[multicc/chat] stderr:'), false);
});

test('typed continuations clear stale API error ownership before launching', () => {
  assert.match(server, /const directUserInput = opts\.directUserInput === true/);
  assert.match(server, /if \(!originContinue \|\| directUserInput\) \{\s*apiErrorHost\.cancelRetry/);
  assert.match(server,
    /originContinue: originContinue && !directUserInput,\s*turnId/);
});

test('network recovery uses the typed retry delivery boundary', () => {
  assert.equal(apiErrorHost.includes('sessionDelivery.deliverRetry(sessionId, message'), true);
  assert.equal(apiErrorHost.includes('waitInjector.safeInject(sessionId, message)'), false);
  assert.equal(sessionDelivery.includes("if (kind === 'retry') admission.retry = true"), true);
});
