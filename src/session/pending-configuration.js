'use strict';

const { isChatStateBusy } = require('./runtime-busy');

// Desired settings are durable, but never replace the settings read by a live
// runner (including its retries and child processes).
const CONFIG_FIELDS = Object.freeze([
  'provider', 'providerSelection', 'model', 'effort', 'agent', 'subagent', 'rolePrompt',
]);
const clone = value => JSON.parse(JSON.stringify(value));

function readConfiguration(session) {
  return Object.fromEntries(CONFIG_FIELDS.map(key => [key, clone(session[key] ?? null)]));
}

function desiredSession(session) {
  const draft = clone(session);
  if (session.pendingConfiguration) {
    draft.cli = session.pendingConfiguration.cli;
    Object.assign(draft, session.pendingConfiguration.profile);
  }
  return draft;
}

function configurationBusy(id, { getChatState, getChatStream, hasLiveBackgroundTasks, getPreparation }) {
  // Failure to observe children must not cause a warm process to be closed.
  try {
    const chat = getChatState(id);
    const stream = getChatStream()?.status?.(id);
    const phase = getPreparation?.(id)?.phase;
    // chat 运行时忙判定的唯一来源（src/session/runtime-busy.js）；phase / stream /
    // 后台任务是另外三条独立的轴，各自 OR 上来。
    return !!(phase === 'preparing' || phase === 'running' || isChatStateBusy(chat)
      || stream?.busy || stream?.queued > 0 || hasLiveBackgroundTasks(id));
  } catch (_) { return true; }
}

function stageConfiguration(session, draft, { fresh = false } = {}) {
  session.pendingConfiguration = {
    cli: draft.cli || 'claude', fresh,
    profile: readConfiguration(draft),
    updatedAt: new Date().toISOString(),
  };
  return session.pendingConfiguration;
}

module.exports = { CONFIG_FIELDS, readConfiguration, desiredSession, configurationBusy, stageConfiguration };
