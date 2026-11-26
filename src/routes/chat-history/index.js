'use strict';

const crypto = require('node:crypto');
const { createChatHistoryServiceWithOwner } = require('../../session/chat-history-service/index');
const { getNative, getPublicSafety } = require('../../native/binding');
const { buildHandoffCheckpoint: defaultCheckpoint } = require('../../cli-switch');

const DEFAULT_HISTORY_PAGE_SIZE = 5;
const DEFAULT_HISTORY_LIMIT = 10000;
const DEFAULT_MEMORY_DISTILL_BATCH = 10;
const DEFAULT_INCREMENTAL_SAVE_DELAY_MS = 5000;
const positiveInteger = (value, fallback) => Number.isSafeInteger(value) && value > 0 ? value : fallback;
function buildReplayMessages(messages, state, now = Date.now) {
  return getNative().chatHistoryBuildReplayMessages(messages, state, now);
}

function createChatHistoryRuntime(rawDeps) {
  const native = getNative();
  const deps = native.historyAssertDeps(rawDeps);
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const pageSize = positiveInteger(deps.historyPageSize, DEFAULT_HISTORY_PAGE_SIZE);
  const { service, owner, anchor: serviceAnchor } = createChatHistoryServiceWithOwner({
    history: deps.history, idFactory: deps.idFactory, clock: now,
    maxMessages: positiveInteger(deps.maxMessages, DEFAULT_HISTORY_LIMIT),
    retentionPolicy: typeof deps.retentionPolicy === 'function' ? deps.retentionPolicy : null,
    canDeleteSession: deps.canDeleteSession, isMessageProtected: deps.isMessageProtected,
    referencingTasks: deps.referencingTasks,
    postPersist: event => run('handleCommittedHistoryEvent', event),
    onPostPersistError: (error, event) => run('postPersistError', error, event),
  });
  const anchor = { ports: {
    history: deps.history, service: owner, serviceAnchor, sessionDeletionFacts: deps.sessionDeletionFacts,
    chatSessions: deps.chatSessions, idFactory: deps.idFactory, clock: now, chatBroadcast: deps.chatBroadcast,
    distillHistoryIntoMemory: deps.distillHistoryIntoMemory,
    maybeSchedulePeriodicMemoryReview: deps.maybeSchedulePeriodicMemoryReview,
    auxSessionId: deps.auxSessionId, maxMessages: deps.maxMessages, maxBytes: deps.maxBytes,
    taskShortCode: typeof deps.taskShortCode === 'function' ? deps.taskShortCode : null,
    projectMessages: typeof deps.projectMessages === 'function' ? deps.projectMessages : null,
    retentionPolicy: typeof deps.retentionPolicy === 'function' ? deps.retentionPolicy : null,
    historyPageSize: pageSize, memoryDistillBatch: positiveInteger(deps.memoryDistillBatch, DEFAULT_MEMORY_DISTILL_BATCH),
    incrementalSaveDelayMs: Number.isFinite(deps.incrementalSaveDelayMs) && deps.incrementalSaveDelayMs >= 0
      ? deps.incrementalSaveDelayMs : DEFAULT_INCREMENTAL_SAVE_DELAY_MS,
    logger: deps.logger || console, sanitizePublicText: getPublicSafety().sanitizePublicText,
    setImmediate: typeof deps.setImmediate === 'function' ? deps.setImmediate : setImmediate,
    setTimeout: typeof deps.setTimeout === 'function' ? deps.setTimeout : setTimeout,
    clearTimeout: typeof deps.clearTimeout === 'function' ? deps.clearTimeout : clearTimeout,
    runIncrementalSave(id, state, generation, epoch) {
      if (run('incrementalSaveTick', id, state, generation, epoch)) drive(String(id));
    },
    runPeriodicReview: id => run('runPeriodicReview', id),
    runDistillFailure: (id, error) => run('distillFailed', id, error),
    afterCommitTick: (state, at) => run('lastActivityCommit', state, at),
  } };
  const runtime = new native.RustChatHistoryRuntime(anchor);
  function run(name, ...args) { return runtime.run(anchor, name, args); }

  let reader;
  const host = native.historyHostApi({
    deps, runtime, anchor, service, now, drive, pageSize, replay: buildReplayMessages, defaultCheckpoint,
    randomBytes: typeof deps.randomBytes === 'function' ? deps.randomBytes : crypto.randomBytes,
    pruning: () => require('../../native/binding').getTranscriptPruning(),
    readOpencode(session, model) {
      reader ||= deps.opencodeContextReader || require('../../chat/opencode-context')
        .createOpencodeContextReader({ logger: deps.logger });
      return reader.read(session, model);
    },
  });

  // Register the loop before entering any reentrant storage port. The Rust
  // owner advances the FIFO, commits or discards the write, and settles callers.
  const drivers = new Map();
  function drive(id) {
    if (drivers.has(id)) return drivers.get(id);
    const loop = Promise.withResolvers();
    drivers.set(id, loop.promise);
    (async () => {
      try {
        for (;;) {
          const io = host.advance(id);
          if (!io) break;
          await io;
        }
        loop.resolve();
      } catch (error) {
        host.failWaiters(id, error);
        loop.reject(error);
      } finally {
        drivers.delete(id);
      }
    })();
    loop.promise.catch(() => {});
    return loop.promise;
  }

  async function settle(options = {}) {
    const deadline = Number.isFinite(options.deadline) ? options.deadline : Date.now()
      + (Number.isFinite(options.timeoutMs) && options.timeoutMs >= 0 ? options.timeoutMs : 60000);
    for (;;) {
      for (const id of run('pendingMutationSessions') || []) drive(String(id));
      if (!drivers.size && !run('hasPendingMutations')) return true;
      const remaining = deadline - Date.now();
      if (!(remaining > 0)) return false;
      if (!drivers.size) {
        await new Promise(resolve => setTimeout(resolve, Math.min(10, remaining)));
        continue;
      }
      let timer;
      try {
        const drained = Promise.allSettled([...drivers.values()]).then(() => true);
        const timeout = new Promise(resolve => { timer = setTimeout(resolve, remaining, false); });
        if (!await Promise.race([drained, timeout])) return false;
      } finally { clearTimeout(timer); }
    }
  }

  function mountRoutes(app) {
    for (const method of ['get', 'delete']) {
      if (typeof app?.[method] !== 'function') throw new TypeError(`Express app.${method} is required`);
    }
    app.delete('/api/sessions/:id/messages/:msgId', host.deleteMessage);
    app.get('/api/sessions/:id/history', host.historyPage);
    app.get('/api/sessions/:id/context-level', host.contextLevel);
    return app;
  }

  const { mutate, clearHistory, rotateNativeContext } = host;
  return Object.freeze({
    appendMessage: (id, message) => mutate(id, 'append', [message]),
    annotateTurn: (id, turn, patch = {}, options = {}) => mutate(id, 'replace', [turn, patch, options]),
    clearAllIncrementalSaves: () => run('clearAllIncrementalSaves'), clearHistory,
    clearIncrementalSave: id => run('clearIncrementalSave', id),
    hasIncrementalSave: id => run('hasIncrementalSave', id),
    hideMessages: (id, ids, options = {}) => mutate(id, options?.quiet ? 'removeMany' : 'hide', [ids]),
    lastActivity: (id, state) => run('lastActivity', id, state),
    latestAssistantAt: id => run('latestAssistantAt', id),
    latestAssistantConclusion: (id, home) => run('latestAssistantConclusion', id, home),
    load: id => run('load', id), viewHistory: id => run('viewHistory', id),
    projectedMessages: (id, includeHidden = false) => run('projectedMessages', id, includeHidden),
    mountRoutes, paginate: (id, options = {}) => run('paginate', id, options),
    canDeleteSession: id => run('canDeleteSession', String(id)) === true,
    deletionVerdict: id => run('deletionVerdict', String(id)),
    dropMessages: (id, ids, options = {}) => mutate(id, 'dropMessages', [ids, options || {}]),
    mergeHistory: (id, messages, options = {}) => mutate(id, 'mergeAll', [messages, options || {}]),
    registerSession: id => run('registerSession', String(id)),
    removeSession: id => mutate(id, 'removeSession', []),
    replaceHistory: (id, messages, options = {}) => mutate(id, 'replaceAll', [messages, options || {}]),
    rotateNativeContext, scheduleIncrementalSave: (id, state) => run('scheduleIncrementalSave', id, state),
    service, settle, stop: () => run('stop'),
  });
}

module.exports = {
  DEFAULT_HISTORY_LIMIT, DEFAULT_HISTORY_PAGE_SIZE, DEFAULT_INCREMENTAL_SAVE_DELAY_MS, DEFAULT_MEMORY_DISTILL_BATCH,
  createChatHistoryRuntime, buildReplayMessages,
  publicCommittedMessage: message => getNative().chatHistoryPublicCommittedMessage(message),
};
