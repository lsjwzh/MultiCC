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
    case 'taskReadModel': return { createTaskReadModel: forward('createTaskReadModel', 0) };
    case 'macosAgentProvision': {
      // Skill bootstrap may load before the platform addon. A disabled installer
      // can report its skip without opening the Agent files or spawning a child.
      const shared = new Map();
      function createMacosAgentProvisioner(options = {}) {
        const platform = options.platform || process.platform;
        const env = options.env || process.env;
        let owner, pending, last = null;
        const load = () => owner ??= ready().createMacosAgentProvisioner(options);
        const skip = () => platform !== 'darwin' ? 'not-macos'
          : env.MULTICC_AGENT_AUTO_INSTALL === '0' ? 'disabled-by-env' : null;
        return {
          plan(opts = {}) { const reason = skip(); return reason ? { action: 'skip', reason } : load().plan(opts); },
          inspect() { return load().inspect(); },
          ensure(opts = {}) {
            if (pending) return pending;
            const reason = skip();
            if (!reason) return load().ensure(opts);
            pending = Promise.resolve().then(() => {
              last = { action: 'skip', reason, ok: true, at: new Date().toISOString() };
              pending = undefined;
              return last;
            });
            return pending;
          },
          getStatus() { return owner ? owner.getStatus() : last; },
        };
      }
      return { LABEL: 'com.multicc.agent', SIGNING_DEFERRED_EXIT: 75, createMacosAgentProvisioner,
        sharedMacosAgentProvisioner({ rootDir, logger } = {}) {
          if (!shared.has(rootDir)) shared.set(rootDir, createMacosAgentProvisioner({ rootDir, logger }));
          return shared.get(rootDir);
        } };
    }
    case 'taskPlanningRoutes': {
      // Packaging diagnostics can report a planning refusal without a platform binary.
      const { codes, defaultStatus } = require('../../native/core/src/task_planning_status.json');
      return { responseStatus: code => Object.hasOwn(codes, code) ? codes[code] : defaultStatus,
        expectedRevision: body => body?.expectedRevision ?? body?.revision,
        createTaskPlanningRuntime: forward('createTaskPlanningRuntime', 0) };
    }
    case 'relayShares':
      return { MAX_SECRET_LENGTH: 128, MIN_SECRET_LENGTH: 8, TOKEN_PREFIX: 'mcr1',
        createProviderRelayShareStore(options = {}) {
          if (!options.file) throw new TypeError('provider relay share store requires { file }');
          return ready().createProviderRelayShareStore(options);
        },
        parseCredential: forward('parseCredential', 1), relayRouteFromBaseUrl: forward('relayRouteFromBaseUrl', 1),
        routeTarget: forward('routeTarget', 1) };
    case 'appPaths': {
      const { pathSafety } = require('./binding');
      return {
        createPaths(options = {}) { return ready().createPaths(options); },
        resolveDataDir(dir) { return ready().resolveDataDir(dir); },
        assertTestDir(dir) { return ready().assertTestDir(dir); },
        isHomeOrAbove: pathSafety.isHomeOrAbove, realPathOf: pathSafety.realPathOf,
        PKG_ROOT: require('node:path').resolve(__dirname, '../..'),
      };
    }
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
    case 'portableGit': {
      const path = require('node:path');
      const os = require('node:os');
      function portableGitDir(env = process.env) {
        return env.MULTICC_PORTABLE_GIT_DIR || path.join(os.homedir(), '.multicc', 'git');
      }
      function portableGitBin(env = process.env) { return path.join(portableGitDir(env), 'bin'); }
      function installScriptPath() { return path.resolve(__dirname, '../../install-git.sh'); }
      return { portableGitDir, portableGitBin, installScriptPath,
        isInstalled: forward('isInstalled', 0), addToPath: forward('addToPath', 0) };
    }
    case 'orchestrationHost':
      return { createOrchestrationRuntime: forward('createOrchestrationRuntime',0), publicWait: forward('publicWait',1),
        get DEFAULTS() { return ready().DEFAULTS; } };
    default: throw unavailable;
  }
}

module.exports = { bootstrapApi };
