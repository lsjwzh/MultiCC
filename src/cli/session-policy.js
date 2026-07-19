'use strict';

const defaultFs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultracode']);
const CODEX_REASONING_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const OPENCODE_VARIANTS = new Set(['minimal', 'low', 'medium', 'high', 'max']);
const CODEX_STREAM_DISCONNECT_CONTINUE_MAX = 2;

function assertProviderDependencies(options) {
  if (!options || typeof options !== 'object') throw new TypeError('[session-policy] options are required');
  if (!options.providerRouter || typeof options.providerRouter.getProviderSummary !== 'function') {
    throw new TypeError('[session-policy] providerRouter.getProviderSummary is required');
  }
  if (!options.providers || typeof options.providers.appTypeForCli !== 'function') {
    throw new TypeError('[session-policy] providers.appTypeForCli is required');
  }
}

function createSessionPolicy(options) {
  assertProviderDependencies(options);
  const providerRouter = options.providerRouter;
  const providers = options.providers;
  const fs = options.fs || defaultFs;
  const env = options.env || process.env;
  const homeDir = options.homeDir || os.homedir;
  if (typeof homeDir !== 'function') throw new TypeError('[session-policy] homeDir must be a function');

  function claudeDefaultModel() {
    try {
      const settings = JSON.parse(fs.readFileSync(path.join(homeDir(), '.claude', 'settings.json'), 'utf8'));
      return typeof settings.model === 'string' && settings.model ? settings.model : null;
    } catch (_) {
      return null;
    }
  }

  function effectiveSessionModel(session) {
    if (!session) return null;
    const appType = session.cli === 'codex' ? 'codex' : 'claude';
    if (session.model) {
      const providerId = session.provider;
      if (providerId) {
        try {
          const aliasMap = providerRouter.getProviderSummary(appType, providerId)?.aliasMap;
          const entry = aliasMap && aliasMap[session.model];
          if (entry && entry.model) return entry.model;
        } catch (_) {}
      }
      return session.model;
    }
    const providerId = session.provider;
    if (providerId) {
      try {
        const provider = providerRouter.getProviderSummary(appType, providerId);
        if (provider && provider.model) return provider.model;
        if (appType === 'claude' && provider && provider.baseUrl) return session.reportedModel || null;
      } catch (_) {}
    }
    if (appType === 'claude') return claudeDefaultModel() || session.reportedModel || null;
    return session.reportedModel || null;
  }

  function effectiveSubagentModel(subagent) {
    if (!subagent || !subagent.providerId || !subagent.model) return null;
    try {
      const aliasMap = providerRouter.getProviderSummary('claude', subagent.providerId)?.aliasMap;
      const entry = aliasMap && aliasMap[subagent.model];
      if (entry && entry.model) return entry.model;
    } catch (_) {}
    return subagent.model;
  }

  function serializeSubagent(subagent) {
    if (!subagent || !subagent.providerId || !subagent.model) return null;
    return {
      providerId: subagent.providerId,
      model: subagent.model,
      effectiveModel: effectiveSubagentModel(subagent),
    };
  }

  function providerDefaultModel(appType, providerId) {
    if (!providerId) return appType === 'claude' ? claudeDefaultModel() : null;
    try {
      const provider = providerRouter.getProviderSummary(appType, providerId);
      if (!provider) return null;
      if (provider.aliasOnly) return providers.WIRE_DEFAULT_MODEL;
      return provider.model || (provider.modelOptions && provider.modelOptions[0]) || null;
    } catch (_) {
      return null;
    }
  }

  function sessionProviderName(session) {
    const providerId = session && session.provider;
    if (!providerId) return null;
    try {
      return providerRouter.getProviderSummary(
        providers.appTypeForCli(session.cli),
        providerId,
      )?.name || providerId;
    } catch (_) {
      return providerId;
    }
  }

  function normalizeEffort(value) {
    const normalized = (value == null ? '' : String(value)).trim().toLowerCase();
    if (!normalized) return null;
    return EFFORT_LEVELS.has(normalized)
      || CODEX_REASONING_LEVELS.has(normalized)
      || OPENCODE_VARIANTS.has(normalized)
      ? normalized
      : undefined;
  }

  function validEffortForCli(cli, effort) {
    if (!effort) return true;
    if (cli === 'codex') return CODEX_REASONING_LEVELS.has(effort);
    if (cli === 'opencode') return OPENCODE_VARIANTS.has(effort);
    if (cli === 'zcode') return false;
    return EFFORT_LEVELS.has(effort);
  }

  function cliEffortLevel(session) {
    const effort = normalizeEffort(session?.effort);
    if (!effort || !EFFORT_LEVELS.has(effort)) return null;
    return effort === 'ultracode' ? 'xhigh' : effort;
  }

  function codexReasoningLevel(session) {
    const effort = normalizeEffort(session?.effort);
    return effort && CODEX_REASONING_LEVELS.has(effort) ? effort : null;
  }

  function codexReasoningConfigArg(session) {
    const level = codexReasoningLevel(session);
    return level ? `model_reasoning_effort="${level}"` : null;
  }

  function codexModelConfigArg(session) {
    const model = session && session.model ? String(session.model).trim() : '';
    return model ? `model="${model}"` : null;
  }

  function claudeDefaultEffort() {
    for (const file of ['settings.local.json', 'settings.json']) {
      try {
        const settings = JSON.parse(fs.readFileSync(path.join(homeDir(), '.claude', file), 'utf8'));
        const effort = normalizeEffort(settings.effort || settings.thinkingEffort);
        if (effort) return effort;
      } catch (_) {}
    }
    return 'medium';
  }

  function codexDefaultReasoningLevel() {
    const homes = [env.CODEX_HOME, path.join(homeDir(), '.codex')].filter(Boolean);
    for (const home of homes) {
      try {
        const toml = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
        const match = toml.match(/^\s*model_reasoning_effort\s*=\s*["']?([A-Za-z0-9_-]+)["']?\s*$/m);
        const effort = normalizeEffort(match && match[1]);
        if (effort && CODEX_REASONING_LEVELS.has(effort)) return effort;
      } catch (_) {}
    }
    return 'xhigh';
  }

  function effectiveSessionEffort(session) {
    if (!session) return null;
    const cli = session.cli || 'claude';
    if (cli === 'codex') return codexReasoningLevel(session) || codexDefaultReasoningLevel();
    if (cli === 'opencode') {
      const effort = normalizeEffort(session.effort);
      return effort && OPENCODE_VARIANTS.has(effort) ? effort : null;
    }
    if (cli === 'zcode') return null;
    const effort = normalizeEffort(session.effort);
    return effort && EFFORT_LEVELS.has(effort) ? effort : claudeDefaultEffort();
  }

  function effortLabel(effort) {
    return effort || claudeDefaultEffort();
  }

  function normalizeCliAgent(cli, value) {
    const agent = value == null ? '' : String(value).trim();
    if (!agent) return null;
    if (!['claude', 'opencode'].includes(cli) || !/^[A-Za-z0-9._-]{1,80}$/.test(agent)) return undefined;
    return agent;
  }

  function isCodexResponseCompletedDisconnect(message) {
    const text = String(message || '');
    return /stream disconnected before completion/i.test(text) && /response\.completed/i.test(text);
  }

  function isCodexTransportDisconnect(message) {
    const text = String(message || '');
    return /stream disconnected before completion/i.test(text)
      && (/error sending request/i.test(text) || /\/backend-api\/codex\/responses/i.test(text));
  }

  function codexStreamDisconnectContinuePrompt() {
    return [
      '上一轮因为传输连接中断提前停了，已有部分输出已经显示给用户。',
      '请不要重复已经完成或已经输出的内容，从中断处继续完成原任务。',
      '如果原任务其实已经全部完成，只用一句话确认完成；否则继续执行必要步骤，直到可以交付。',
    ].join('\n');
  }

  function isGlm52Session(session) {
    return String(session?.model || '').toLowerCase() === 'xopglm52';
  }

  return Object.freeze({
    codexSessionsDir: path.join(homeDir(), '.codex', 'sessions'),
    claudeDefaultModel,
    effectiveSessionModel,
    effectiveSubagentModel,
    serializeSubagent,
    providerDefaultModel,
    sessionProviderName,
    normalizeEffort,
    validEffortForCli,
    cliEffortLevel,
    codexReasoningLevel,
    codexReasoningConfigArg,
    codexModelConfigArg,
    claudeDefaultEffort,
    codexDefaultReasoningLevel,
    effectiveSessionEffort,
    effortLabel,
    normalizeCliAgent,
    isCodexResponseCompletedDisconnect,
    isCodexTransportDisconnect,
    codexStreamDisconnectContinuePrompt,
    isGlm52Session,
    CODEX_STREAM_DISCONNECT_CONTINUE_MAX,
  });
}

function createReportedModelRuntime(options) {
  if (!options || typeof options !== 'object') throw new TypeError('[reported-model] options are required');
  const { records, effectiveSessionModel, rememberActiveCliState, saveBestEffort } = options;
  if (!records || typeof records.get !== 'function' || typeof records.values !== 'function') {
    throw new TypeError('[reported-model] records map is required');
  }
  for (const [name, value] of Object.entries({
    effectiveSessionModel,
    rememberActiveCliState,
    saveBestEffort,
  })) {
    if (typeof value !== 'function') throw new TypeError(`[reported-model] ${name} is required`);
  }
  const fs = options.fs || defaultFs;
  const homeDir = options.homeDir || os.homedir;
  const log = options.log || (() => {});
  if (typeof homeDir !== 'function') throw new TypeError('[reported-model] homeDir must be a function');
  if (typeof log !== 'function') throw new TypeError('[reported-model] log must be a function');

  function note(sessionId, model) {
    if (!model || typeof model !== 'string' || model.includes('<synthetic>')) return false;
    const record = records.get(sessionId);
    if (!record || record.reportedModel === model) return false;
    record.reportedModel = model;
    rememberActiveCliState(record);
    saveBestEffort('runtime.reported-model');
    return true;
  }

  function backfill() {
    const projects = path.join(homeDir(), '.claude', 'projects');
    let directories;
    try {
      directories = fs.readdirSync(projects, { withFileTypes: true }).filter(entry => entry.isDirectory());
    } catch (_) {
      return 0;
    }
    let updated = 0;
    for (const record of records.values()) {
      if (record.reportedModel || (record.cli && record.cli !== 'claude') || !record.cliSessionId) continue;
      if (effectiveSessionModel(record)) continue;
      for (const directory of directories) {
        const transcript = path.join(projects, directory.name, `${record.cliSessionId}.jsonl`);
        let tail;
        try {
          const fd = fs.openSync(transcript, 'r');
          try {
            const size = fs.fstatSync(fd).size;
            const length = Math.min(256 * 1024, size);
            const buffer = Buffer.alloc(length);
            fs.readSync(fd, buffer, 0, length, size - length);
            tail = buffer.toString('utf8');
          } finally {
            fs.closeSync(fd);
          }
        } catch (_) {
          continue;
        }
        const lines = tail.split('\n');
        for (let index = lines.length - 1; index >= 0; index -= 1) {
          try {
            const event = JSON.parse(lines[index]);
            const model = event.type === 'assistant' && event.message && event.message.model;
            if (model && typeof model === 'string' && !model.includes('<synthetic>')) {
              record.reportedModel = model;
              updated += 1;
              break;
            }
          } catch (_) {}
        }
        break;
      }
    }
    if (updated) {
      saveBestEffort('startup.reported-model-backfill');
      log(`[multicc] Backfilled reportedModel for ${updated} session(s) from CLI transcripts`);
    }
    return updated;
  }

  return Object.freeze({ note, backfill });
}

module.exports = {
  CODEX_STREAM_DISCONNECT_CONTINUE_MAX,
  createSessionPolicy,
  createReportedModelRuntime,
};
