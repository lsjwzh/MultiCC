'use strict';

const { getNative } = require('../native/runtime');
const turnProgress = require('./turn-progress');

const REQUIRED_PORTS = Object.freeze([
  'persistAssistant',
  'commitUsage',
  'broadcast',
  'cancelClassify',
  'clearIncrementalSave',
  'setStatus',
  'completeSessionTurn',
  'classifyTurnEnd',
  'resetInterrupted',
  'resumeInterrupted',
  'emitTurnOutcome',
  'runPostTurn',
]);

function assertFinalizeHostPorts(ports) {
  if (!ports || typeof ports !== 'object') throw new TypeError('finalize host ports are required');
  for (const name of REQUIRED_PORTS) {
    if (typeof ports[name] !== 'function') throw new TypeError(`finalize host port missing: ${name}`);
  }
  return ports;
}

function createTurnFinalizationExecutor(rawPorts) {
  const ports = assertFinalizeHostPorts(rawPorts);
  const now = typeof ports.now === 'function' ? ports.now : Date.now;
  const timelineField = typeof ports.timelineField === 'function' ? ports.timelineField : turnProgress.field;
  const log = typeof ports.log === 'function' ? ports.log : () => {};
  const logError = typeof ports.logError === 'function' ? ports.logError : () => {};

  // 执行顺序、历史写入确认、用量屏障及失败清理由 Rust 负责。
  // Node 只保留现有宿主端口和 Promise 拒绝处理；端口迁出后即可移除。
  const runtime = {
    now, timelineField, log, logError,
    completeSessionTurn(sessionName) {
      Promise.resolve(ports.completeSessionTurn(sessionName)).catch(error => {
        logError('complete-session-turn-failed', { sessionName, error });
      });
    },
  };
  const native = getNative();
  if (typeof native.chatExecuteTurnFinalization !== 'function') {
    throw new Error('rust_chat_finalization_execution_unavailable');
  }
  function execute(plan, rawContext = {}) {
    return native.chatExecuteTurnFinalization(plan, rawContext, ports, runtime);
  }
  return Object.freeze({ execute });
}

module.exports = { assertFinalizeHostPorts, createTurnFinalizationExecutor };
