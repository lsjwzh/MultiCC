'use strict';

// Some CommonJS entry points can be loaded by bootstrap tools before a
// platform addon exists. Preserve only operations observable in that state.
// Every operation needing the domain owner retries the normal Rust factory.
function bootstrapApi(key, create, unavailable) {
  let api;
  const ready = () => api ??= create();
  const forward = (name, length) => {
    const f = (...args) => ready()[name](...args);
    Object.defineProperties(f, { name: { value: name }, length: { value: length } });
    return f;
  };
  switch (key) {
    case 'cliResultCompletion':
      return { isMainResult: forward('isMainResult',1), resultCompletion: forward('resultCompletion',1),
        createResultCompletionTracker: forward('createResultCompletionTracker',0) };
    case 'cliCompletion':
      return {
        createStepCompletionTracker({ streamBoundary = false } = {}) {
          return ready().createStepCompletionTracker({ streamBoundary });
        },
        completion: forward('completion',2), isCompleted: forward('isCompleted',1),
        createCompletionTracker: forward('createCompletionTracker',0),
        createAdapterCompletion(adapter) {
          if (typeof adapter?.createCompletionTracker === 'function') return adapter.createCompletionTracker();
          return ready().createCompletionTracker({ fallback: true });
        },
        createProtocolCompletionTracker: forward('createProtocolCompletionTracker',1),
      };
    case 'codexHistoryHooks':
      return { createCodexHistoryHooks(options = {}) {
        const logger = options.logger && typeof options.logger.warn === 'function' ? options.logger : null;
        let hooks;
        const owner = () => hooks ??= ready().createCodexHistoryHooks({ logger });
        return Object.freeze({ onRequest(context) { return owner().onRequest(context); },
          onUpstreamRejected(context) { return owner().onUpstreamRejected(context); } });
      } };
    case 'modelHistoryConverter':
      return { fillWebSearchQueries: forward('fillWebSearchQueries',1),
        normalizeResponsesHistory(body, { omitReasoningContent = false } = {}) {
          return ready().normalizeResponsesHistory(body, { omitReasoningContent });
        },
        preprocessResponsesHistory: forward('preprocessResponsesHistory',1),
        repairRejectedResponsesHistory: forward('repairRejectedResponsesHistory',2),
        stripReasoningContent: forward('stripReasoningContent',1),
        stripUnresolvedItemReferences: forward('stripUnresolvedItemReferences',1),
        stripUnverifiableEncryptedContent: forward('stripUnverifiableEncryptedContent',1) };
    case 'stateContainer': return { sessions: null, persistedSessions: null, directories: null };
    case 'eventBus': return new (require('node:events').EventEmitter)().setMaxListeners(50);
    case 'chatHistoryService':
      return { cleanThinkingBlocks: forward('cleanThinkingBlocks',1),
        createChatHistoryService: forward('createChatHistoryService',0),
        createChatHistoryServiceWithOwner: forward('createChatHistoryServiceWithOwner',0) };
    case 'voiceRouter':
      return { VOICE_ROUTER_ID: '__voice_router__', VOICE_ROUTER_LABEL: '🎙️ 实时语音 Router',
        createVoiceRouterProvisioner({ records, mutate, runtimeRoot, cli = 'claude', now } = {}) {
          if (!(records instanceof Map)) throw new TypeError('voice router provisioner requires records Map');
          if (typeof mutate !== 'function') throw new TypeError('voice router provisioner requires mutate');
          const root = String(runtimeRoot || process.cwd());
          return ready().createVoiceRouterProvisioner({ records, mutate, runtimeRoot: root, cli, now });
        },
        isVoiceRouterRecord: forward('isVoiceRouterRecord',1) };
    case 'rolloutPath':
      return { createRolloutPathResolver(deps = {}) {
        const { fs, path, sessionsDirFor, now = Date.now, missTtlMs = 30_000 } = deps;
        if (!fs || typeof fs.existsSync !== 'function' || typeof fs.readdirSync !== 'function') {
          throw new TypeError('[rollout-path] fs with existsSync/readdirSync is required');
        }
        if (!path || typeof path.join !== 'function') throw new TypeError('[rollout-path] path is required');
        if (typeof sessionsDirFor !== 'function') throw new TypeError('[rollout-path] sessionsDirFor is required');
        return ready().createRolloutPathResolver({ fs, path, sessionsDirFor, now, missTtlMs });
      }, DEFAULT_MISS_TTL_MS: 30_000 };
    case 'orchestrationHost':
      return { createOrchestrationRuntime: forward('createOrchestrationRuntime',0), publicWait: forward('publicWait',1),
        get DEFAULTS() { return ready().DEFAULTS; } };
    default: throw unavailable;
  }
}

module.exports = { bootstrapApi };
