'use strict';

const assert = require('node:assert/strict');
const { createChatTurnEngine } = require('../../src/chat/turn-engine');
const { createClaudeExpAdapter } = require('../../src/cli-adapters/claude-exp');

// Drive the real host through admission, context composition, and adapter argv.
// Stop at buildInvocation, before any provider attempt or process can start.
module.exports = function prepareTurn({ record, cwd, history = [], connected = false, text = 'hello' }) {
  const noop = () => {};
  const ok = () => ({ ok: true });
  let prepared;
  const errors = [];
  const adapter = createClaudeExpAdapter({
    resolveSessionWireModel: value => value,
    claudeDefaultModel: () => null,
    cliEffortLevel: () => null,
    normalizeEffort: () => null,
  });
  const engine = createChatTurnEngine({
    persistedSessions: new Map([[record.id, record]]),
    chatSessions: new Map(connected ? [[record.id, {
      cli: record.cli, chatTurnCount: history.filter(m => m.role === 'assistant').length,
      clients: new Set(), cwd,
    }]] : []),
    taskContextHost: {
      turnOptions: opts => opts, restore: () => null,
      beginTurn: () => ({ taskId: 'sdk-task', boundaryChanged: false }),
      messageMetadata: () => ({}),
    },
    loadChatHistory: () => history,
    isShuttingDown: () => false,
    cwdForSession: () => cwd,
    savePersistedSessionsBestEffort: noop,
    chatTurnPreparationRuntime: { claim: ok, settle: noop, markMessageDurable: ok },
    turnProgressHeartbeat: { stop: noop, start: noop },
    logger: { warn: noop, info: noop, error: noop },
    chatBroadcast: (_id, event) => { if (event.type === 'error') errors.push(event.error); },
    emitTurnOutcome: noop, classifyTurnEnd: noop, cancelClassify: noop,
    apiErrorHost: { cancelRetry: noop }, setTaskState: noop, appendChatMessage: () => true,
    userInputSignalHost: { beginTurn: noop }, ensureCurrentTask: noop,
    resetRoleTokenUsage: noop, getTaskState: () => ({}), emitRunningNotify: noop,
    setSessionStatus: noop, folderMemory: { resolveRolePrompt: () => null },
    MULTICC_IMG_HINT: '', pendingNotesFor: () => [], normalizeEffort: () => null,
    buildDispatchContextPrompt: () => '',
    autoProviderRuntime: { beginTurn: () => ({ initial: () => ({}) }) },
    providerRouterRuntime: {
      createBinding: () => ({ cli: record.cli, sessionId: record.id, model: record.model }),
      resolveSpawnEnv: () => ({}), getProviderSummary: () => null,
    },
    effectiveSessionModel: () => record.model,
    providerFor: () => ({ ...adapter, buildInvocation(envelope) {
      prepared = { envelope, invocation: adapter.buildInvocation(envelope) };
      throw new Error('test stopped after real adapter invocation');
    } }),
  });
  engine.runChatTurn(record.id, text, { taskId: 'sdk-task' });
  assert.ok(prepared, `host did not reach adapter invocation: ${errors.join('; ')}`);
  return prepared;
};
