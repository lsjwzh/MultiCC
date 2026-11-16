'use strict';

// 冻结基线：`src/providers/core.js` 在 settingsConfig 簇迁入 Rust 之前的实现
// （逐字取自提交 0860ed62 的 parseModelList / detectResponsesCompatTarget /
// applyAliasMapToEnv / isZhipuBaseUrl / ensureZhipuFableAlias /
// buildSettingsConfig / apiFormatForAppType / normalizeApiFormat /
// assertApiFormatMatchesAppType / uniqueModels）。
//
// 它刻意不再随生产代码变化：tests/test-provider-settings-config.js 用同一份语料
// 同时喂给它和 Rust，比较 JSON.stringify 的字节与键序。如果这里跟着生产一起改，
// 对拍就变成「拿新实现和自己比」而永久失去辨别力。
//
// 唯一的改动：`port` 从参数传入而不是读 `process.env.PORT`，这样两侧看到的
// 回环端口一定相同（Rust 侧本来就是参数）。

const API_FORMATS = Object.freeze({
  ANTHROPIC: 'anthropic',
  OPENAI_RESPONSES: 'openai_responses',
});

function uniqueModels(values) {
  const seen = new Set();
  const out = [];
  for (const raw of values || []) {
    const v = String(raw || '').trim();
    if (v && !seen.has(v)) { seen.add(v); out.push(v); }
  }
  return out;
}

function parseModelList(models, primary) {
  const extras = Array.isArray(models)
    ? models
    : String(models || '').split(/[\n,]/);
  return uniqueModels([primary, ...extras]);
}

const RESPONSES_COMPAT_PROXY_MAP = [
  { host: 'maas-coding-api.cn-huabei-1.xf-yun.com', target: 'https://maas-coding-api.cn-huabei-1.xf-yun.com/v1/responses' },
];

function detectResponsesCompatTarget(baseUrl) {
  if (!baseUrl) return null;
  let host;
  try { host = new URL(baseUrl).host; } catch (_) { return null; }
  for (const m of RESPONSES_COMPAT_PROXY_MAP) {
    if (m.host && host === m.host) return m.target;
    if (m.hostRe && m.hostRe.test(host)) return m.target;
  }
  return null;
}

const ALIAS_TIER_KEYS = {
  opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  fable: 'ANTHROPIC_DEFAULT_FABLE_MODEL',
};

function applyAliasMapToEnv(env, aliasMap) {
  if (!aliasMap || typeof aliasMap !== 'object') return;
  for (const [tier, key] of Object.entries(ALIAS_TIER_KEYS)) {
    const entry = aliasMap[tier];
    const model = (entry && typeof entry === 'object' ? entry.model : entry) || '';
    const name = (entry && typeof entry === 'object' ? entry.name : '') || '';
    if (String(model).trim()) {
      env[key] = String(model).trim();
      if (String(name).trim()) env[key + '_NAME'] = String(name).trim();
      else delete env[key + '_NAME'];
    } else {
      delete env[key];
      delete env[key + '_NAME'];
    }
  }
}

const ZHIPU_FABLE_ALIAS = { model: 'glm-5.3', name: 'GLM5.3' };

function isZhipuBaseUrl(baseUrl) {
  const host = String(baseUrl || '').replace(/^https?:\/\//, '').split('/')[0].toLowerCase();
  return host === 'open.bigmodel.cn' || host === 'api.z.ai'
    || host.endsWith('.bigmodel.cn') || host.endsWith('.z.ai');
}

function ensureZhipuFableAlias(env) {
  if (!env || typeof env !== 'object') return false;
  if (!isZhipuBaseUrl(env.ANTHROPIC_BASE_URL)) return false;
  if (String(env.ANTHROPIC_DEFAULT_FABLE_MODEL || '').trim()) return false;
  env.ANTHROPIC_DEFAULT_FABLE_MODEL = ZHIPU_FABLE_ALIAS.model;
  env.ANTHROPIC_DEFAULT_FABLE_MODEL_NAME = ZHIPU_FABLE_ALIAS.name;
  return true;
}

function buildSettingsConfig(appType, { baseUrl, authToken, model, models, providerId, apiFormat, aliasMap, port }) {
  const modelOptions = parseModelList(models, model);
  if (appType === 'claude') {
    const env = {};
    if (baseUrl) env.ANTHROPIC_BASE_URL = baseUrl;
    if (authToken) env.ANTHROPIC_AUTH_TOKEN = authToken;
    if (model) env.ANTHROPIC_MODEL = model;
    applyAliasMapToEnv(env, aliasMap);
    ensureZhipuFableAlias(env);
    return { env, modelCatalog: { models: modelOptions.map(m => ({ model: m })) } };
  }
  const provName = 'custom';
  const compat = detectResponsesCompatTarget(baseUrl);
  const proxySpec = compat ? { baseUrl: compat, mode: 'responses-compat' } : null;
  const proxyBaseUrl = (proxySpec && providerId)
    ? `http://127.0.0.1:${port}/codex-proxy/${providerId}`
    : baseUrl;
  const lines = [
    `model_provider = "${provName}"`,
    model ? `model = "${model}"` : '',
    '',
    `[model_providers.${provName}]`,
    `name = "${provName}"`,
    proxyBaseUrl ? `base_url = "${proxyBaseUrl}"` : '',
    authToken ? 'env_key = "OPENAI_API_KEY"' : '',
    'wire_api = "responses"',
  ].filter(Boolean);
  const cfg = {
    auth: !baseUrl && !authToken
      ? { auth_mode: 'chatgpt' }
      : { OPENAI_API_KEY: authToken || null },
    config: lines.join('\n') + '\n',
    modelCatalog: { models: modelOptions.map(m => ({ model: m })) },
  };
  if (proxySpec) {
    cfg.proxyTarget = {
      baseUrl: proxySpec.baseUrl,
      apiKey: authToken || '',
      originalBaseUrl: baseUrl || '',
      mode: proxySpec.mode,
    };
  }
  return cfg;
}

function apiFormatForAppType(appType) {
  if (appType === 'claude') return API_FORMATS.ANTHROPIC;
  if (appType === 'codex') return API_FORMATS.OPENAI_RESPONSES;
  return null;
}

function normalizeApiFormat(value, appType) {
  const fixed = apiFormatForAppType(appType);
  if (fixed) return fixed;
  const raw = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (raw === 'anthropic' || raw === 'messages' || raw === 'anthropic_messages') return API_FORMATS.ANTHROPIC;
  return API_FORMATS.OPENAI_RESPONSES;
}

function assertApiFormatMatchesAppType(apiFormat, appType) {
  if (apiFormat === undefined || apiFormat === null || apiFormat === '') return;
  const raw = String(apiFormat).trim().toLowerCase().replace(/[\s-]+/g, '_');
  const asked = (raw === 'anthropic' || raw === 'messages' || raw === 'anthropic_messages')
    ? API_FORMATS.ANTHROPIC : API_FORMATS.OPENAI_RESPONSES;
  const fixed = apiFormatForAppType(appType);
  if (fixed && asked !== fixed) {
    throw new Error(appType === 'codex'
      ? 'Codex 线路只能用 OpenAI Responses 协议；Anthropic 协议的上游请建成 Claude 线路'
      : 'Claude 线路只能用 Anthropic Messages 协议；OpenAI 协议的上游请建成 Codex 线路');
  }
}

module.exports = {
  API_FORMATS,
  uniqueModels,
  parseModelList,
  detectResponsesCompatTarget,
  applyAliasMapToEnv,
  isZhipuBaseUrl,
  ensureZhipuFableAlias,
  buildSettingsConfig,
  normalizeApiFormat,
  assertApiFormatMatchesAppType,
};
