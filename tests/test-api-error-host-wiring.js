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

test('Classify no longer owns an uncapped API retry or error-text pruning channel', () => {
  assert.equal(server.includes('API error -> retry (uncapped)'), false);
  assert.equal(server.includes('pruneErrorTurnPairs'), false);
  assert.equal(server.includes('API_RETRY_DELAY_MS'), false);
  assert.equal(classifyStateMachine.includes("source: 'classifier_legacy'"), true);
  assert.equal(waitInjector.includes('API retries now live in src/chat/api-error-policy.js'), true);
});

test('process and stream retries reuse the owned turn without appending a second user message', () => {
  const processStart = server.indexOf('const spawnChat = (spawnArgs, isRetry, apiRetryAttempt = 0)');
  const processEnd = server.indexOf('cs.claudeProc = spawnChat(args, false)', processStart);
  const processBody = server.slice(processStart, processEnd);
  assert.ok(processStart >= 0 && processEnd > processStart);
  assert.equal(processBody.includes('evaluateTurnApiError({'), true);
  assert.equal(processBody.includes('scheduleOwnedRetry({'), true);
  assert.equal(processBody.includes('spawnChat(spawnArgs, true, finalizePlan.retry.attempt)'), true);
  assert.equal(processBody.includes('appendChatMessage(sessionName'), false,
    'retry runner reuses the already durable canonical user event');

  const streamStart = server.indexOf('function runChatTurnStreaming(');
  const streamEnd = server.indexOf('// ── Chat mode:', streamStart);
  const streamBody = server.slice(streamStart, streamEnd);
  assert.ok(streamStart >= 0 && streamEnd > streamStart);
  assert.equal(streamBody.includes('evaluateTurnApiError({'), true);
  assert.equal(streamBody.includes('scheduleOwnedRetry({'), true);
  assert.match(streamBody,
    /runChatTurnStreaming\(\s*sessionName,\s*cs,\s*persisted,\s*invocation,\s*provider,\s*turn,\s*plan\.retry\.attempt\)/);
  assert.equal(streamBody.includes('runChatTurn(sessionName'), false,
    'stream retry must not create a second canonical user message');
});

test('host persistence and broadcast expose only stable policy fields', () => {
  assert.equal(apiErrorHost.includes("type: 'api_error_policy'"), true);
  assert.equal(apiErrorHost.includes('setTaskState(sessionName, { apiError: safe }'), true);
  assert.equal(server.includes("logger.warn('chat_provider_stderr'"), true);
  assert.equal(server.includes('[multicc/chat] stderr:'), false);
});

test('typed continuations clear stale API error ownership before launching', () => {
  assert.match(server, /const directUserInput = opts\.directUserInput === true/);
  assert.match(server, /if \(!originContinue \|\| directUserInput\) \{\s*apiErrorHost\.cancelRetry/);
  assert.match(server,
    /originContinue: originContinue && !directUserInput,\s*turnId/);
});
