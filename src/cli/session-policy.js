'use strict';

const defaultFs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isResidentSession } = require('./cli-capability');
const { createModelDefaultResolver } = require('./model-default');
const { CLAUDE_MODELS_FALLBACK, listClaudeModelsSync } = require('../routes/claude-models');

const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultracode']);
const CODEX_REASONING_LEVELS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
// Codex 5.6 supports the product tiers `max` and `ultra`; older models top out
// at `xhigh`. Keep the tiers in persisted state and normalize only at the wire
// boundary, using the model that will actually handle the turn.
const CODEX_REASONING_56_LEVELS = new Set(['max', 'ultra']);
const PI_THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']);
const OPENCODE_VARIANTS = new Set(['minimal', 'low', 'medium', 'high', 'max']);
const QODER_REASONING_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const CODEBUDDY_REASONING_LEVELS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
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
  // 宿主只读取已有记录与线路目录；历史 TTL、查询缓存和选择规则归 Rust。
  const records = typeof options.records === 'function' ? options.records : () => [];
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const resolveModelDefault = createModelDefaultResolver({ history: collectHistory, now,
    historyTtlMs: options.historyTtlMs });

  const GLOBAL_PROVIDER_CLIS = new Set(['opencode', 'zcode', 'kimi']);

  // The model list the picker shows for this lane. Official lanes have no
  // provider; Claude reads the CLI-extracted list (static fallback), Codex the
  // account catalog cache. Provider lanes pass their own modelOptions.
  function officialModelsFor(appType, cli) {
    if (appType === 'claude') {
      try { return listClaudeModelsSync(); } catch (_) { return CLAUDE_MODELS_FALLBACK.map(entry => entry.model); }
    }
    if (appType === 'codex') {
      try { return typeof providers.readCodexOfficialModels === 'function' ? providers.readCodexOfficialModels() : []; } catch (_) { return []; }
    }
    return [];
  }

  // Official provider ids (the built-in alias and per-account ids) are the same
  // picker line as a provider-less official session, so their explicit
  // selections count toward the same history.
  function laneProviderKey(cli, providerId) {
    if (!providerId) return null;
    const appType = providers.appTypeForCli(cli);
    if (!appType || typeof providers.isOfficialProviderId !== 'function') return providerId;
    try { return providers.isOfficialProviderId(appType, providerId) ? null : providerId; } catch (_) { return providerId; }
  }

  function collectHistory() {
    const entries = [];
    let source;
    try { source = records(); } catch (_) { return entries; }
    if (!source) return entries;
    const values = typeof source.values === 'function' ? source.values() : source;
    try {
      for (const record of values) {
        if (!record || typeof record.model !== 'string') continue;
        const model = record.model.trim();
        if (!model) continue;
        const cli = record.cli || 'claude';
        entries.push({ cli, provider: laneProviderKey(cli, record.provider), model });
      }
    } catch (_) { /* a half-mutated map must not break model display */ }
    return entries;
  }

  function providerPayload(summary) {
    return {
      model: typeof summary.model === 'string' && summary.model ? summary.model : null,
      modelOptions: Array.isArray(summary.modelOptions)
        ? summary.modelOptions.filter(model => typeof model === 'string' && model) : [],
      aliasOnly: summary.aliasOnly === true,
      official: summary.isOfficial === true,
    };
  }

  function resolveDefault(request) {
    return resolveModelDefault({
      ...request,
      wireDefaultModel: typeof providers.WIRE_DEFAULT_MODEL === 'string' ? providers.WIRE_DEFAULT_MODEL : null,
    });
  }

  function effectiveSessionModel(session) {
    if (!session) return null;
    const appType = providers.appTypeForCli(session.cli);
    const globalProviderCli = GLOBAL_PROVIDER_CLIS.has(session.cli);
    if (!appType && !globalProviderCli) return session.model || session.reportedModel || null;
    const lookupType = globalProviderCli ? undefined : appType;
    if (session.model) {
      const providerId = session.provider;
      if (providerId && session.cli !== 'zcode') {
        try {
          const aliasMap = providerRouter.getProviderSummary(lookupType, providerId)?.aliasMap;
          const entry = aliasMap && aliasMap[session.model];
          if (entry && entry.model) return entry.model;
        } catch (_) {}
      }
      return session.model;
    }
    // No explicit selection: ask the core for the lane default. Terminal
    // configuration (~/.claude/settings.json, ~/.codex/config.toml) is never
    // read — the choice comes from the lane's model list and this user's
    // explicit selections on that list.
    const providerId = session.provider || null;
    let summary = null;
    if (providerId) {
      try { summary = providerRouter.getProviderSummary(lookupType, providerId) || null; } catch (_) { summary = null; }
    }
    return resolveDefault({
      kind: 'effective',
      cli: session.cli || 'claude',
      appType: appType || null,
      providerId,
      historyProviderId: summary && summary.isOfficial === true ? null : providerId,
      provider: summary ? providerPayload(summary) : null,
      models: officialModelsFor(appType, session.cli),
      reportedModel: session.reportedModel || null,
      globalProviderCli,
    });
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
      ...(subagent.inherited === true ? { inherited: true } : {}),
    };
  }

  function providerDefaultModel(appType, providerId) {
    const requestedId = providerId || null;
    let summary = null;
    if (requestedId) {
      try { summary = providerRouter.getProviderSummary(appType, requestedId) || null; } catch (_) { summary = null; }
    }
    return resolveDefault({
      kind: 'providerDefault',
      cli: appType === 'codex' ? 'codex' : 'claude',
      appType: appType || null,
      providerId: requestedId,
      historyProviderId: summary && summary.isOfficial === true ? null : requestedId,
      provider: summary ? providerPayload(summary) : null,
      models: officialModelsFor(appType, appType === 'codex' ? 'codex' : 'claude'),
    });
  }

  function sessionProviderName(session) {
    const providerId = session && session.provider;
    if (!providerId) return null;
    const appType = providers.appTypeForCli(session.cli);
    const globalProviderCli = session.cli === 'opencode' || session.cli === 'zcode' || session.cli === 'kimi';
    if (!appType && !globalProviderCli) return null;
    try {
      return providerRouter.getProviderSummary(
        globalProviderCli ? undefined : appType,
        providerId,
      )?.name || providerId;
    } catch (_) {
      return providerId;
    }
  }

  function sessionProviderBaseUrl(session) {
    const providerId = session && session.provider;
    if (!providerId) return null;
    const appType = providers.appTypeForCli(session.cli);
    const globalProviderCli = session.cli === 'opencode' || session.cli === 'zcode' || session.cli === 'kimi';
    if (!appType && !globalProviderCli) return null;
    try {
      return providerRouter.getProviderSummary(
        globalProviderCli ? undefined : appType,
        providerId,
      )?.baseUrl || null;
    } catch (_) {
      return null;
    }
  }

  function normalizeEffort(value) {
    const normalized = (value == null ? '' : String(value)).trim().toLowerCase();
    if (!normalized) return null;
    return EFFORT_LEVELS.has(normalized)
      || CODEX_REASONING_LEVELS.has(normalized)
      || CODEX_REASONING_56_LEVELS.has(normalized)
      || OPENCODE_VARIANTS.has(normalized)
      || PI_THINKING_LEVELS.has(normalized)
      ? normalized
      : undefined;
  }

  function validEffortForCli(cli, effort) {
    if (!effort) return true;
    if (cli === 'codex' || cli === 'codex-exp') {
      return CODEX_REASONING_LEVELS.has(effort) || CODEX_REASONING_56_LEVELS.has(effort);
    }
    if (cli === 'opencode') return OPENCODE_VARIANTS.has(effort);
    if (cli === 'pi') return PI_THINKING_LEVELS.has(effort);
    if (cli === 'zcode' || cli === 'kimi' || cli === 'dsh'
      || cli === 'gemini' || cli === 'grok' || cli === 'commandcode') return false;
    if (cli === 'qoder') return QODER_REASONING_LEVELS.has(effort);
    if (cli === 'codebuddy') return CODEBUDDY_REASONING_LEVELS.has(effort);
    return EFFORT_LEVELS.has(effort);
  }

  function cliEffortLevel(session) {
    const effort = normalizeEffort(session?.effort);
    if (!effort || !EFFORT_LEVELS.has(effort)) return null;
    return effort === 'ultracode' ? 'xhigh' : effort;
  }

  function isCodex56Model(model) {
    const normalized = String(model || '').trim().toLowerCase().replace(/\[[^\]]*\]$/, '');
    const basename = normalized.split('/').pop();
    return /^gpt[-_.]?5[.]6(?:$|[-_.])/.test(basename);
  }

  function codexReasoningLevel(session) {
    const effort = normalizeEffort(session?.effort);
    if (!effort) return null;
    if (CODEX_REASONING_LEVELS.has(effort)) return effort;
    if (!CODEX_REASONING_56_LEVELS.has(effort)) return null;
    const model = session?.effectiveModel || effectiveSessionModel(session);
    return isCodex56Model(model) ? effort : 'xhigh';
  }

  function qoderEffortLevel(session) {
    const effort = normalizeEffort(session?.effort);
    return effort && QODER_REASONING_LEVELS.has(effort) ? effort : null;
  }

  function codebuddyEffortLevel(session) {
    const effort = normalizeEffort(session?.effort);
    return effort && CODEBUDDY_REASONING_LEVELS.has(effort) ? effort : null;
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
        const modelMatch = toml.match(/^\s*model\s*=\s*["']([^"']+)["']\s*$/m);
        const effort = codexReasoningLevel({
          effort: match && match[1],
          effectiveModel: modelMatch && modelMatch[1],
        });
        if (effort) return effort;
      } catch (_) {}
    }
    return 'xhigh';
  }

  function effectiveSessionEffort(session) {
    if (!session) return null;
    const cli = session.cli || 'claude';
    if (cli === 'codex' || cli === 'codex-exp') return codexReasoningLevel(session) || codexDefaultReasoningLevel();
    if (cli === 'pi') {
      const effort = normalizeEffort(session.effort);
      return effort && PI_THINKING_LEVELS.has(effort) ? effort : null;
    }
    if (cli === 'opencode') {
      const effort = normalizeEffort(session.effort);
      return effort && OPENCODE_VARIANTS.has(effort) ? effort : null;
    }
    if (cli === 'zcode' || cli === 'kimi' || cli === 'dsh'
      || cli === 'gemini' || cli === 'grok' || cli === 'commandcode') return null;
    if (cli === 'qoder') return qoderEffortLevel(session);
    if (cli === 'codebuddy') return codebuddyEffortLevel(session);
    const effort = normalizeEffort(session.effort);
    return effort && EFFORT_LEVELS.has(effort) ? effort : claudeDefaultEffort();
  }

  function effortLabel(effort) {
    return effort || claudeDefaultEffort();
  }

  function normalizeCliAgent(cli, value) {
    const agent = value == null ? '' : String(value).trim();
    if (!agent) return null;
    if (!['claude', 'claude-exp', 'opencode', 'qoder', 'codebuddy'].includes(cli) || !/^[A-Za-z0-9._-]{1,80}$/.test(agent)) return undefined;
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
    effectiveSessionModel,
    effectiveSubagentModel,
    serializeSubagent,
    providerDefaultModel,
    sessionProviderName,
    sessionProviderBaseUrl,
    normalizeEffort,
    validEffortForCli,
    cliEffortLevel,
    codexReasoningLevel,
    qoderEffortLevel,
    codebuddyEffortLevel,
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
      if (record.reportedModel || (record.cli && !isResidentSession(record.cli, record)) || !record.cliSessionId) continue;
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
