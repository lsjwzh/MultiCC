'use strict';

// createProvider / updateProvider / deleteProvider（含虚拟线路保存）从
// src/providers/core.js 迁入 multicc_core::provider_writes 后的新旧差分。
//
// 旧实现冻结在 tests/helpers/legacy-provider-writes.js，它的 settingsConfig 依赖
// 又由冻结的 tests/helpers/legacy-settings-config.js 提供，整条旧链路都不随生产
// 代码变化。两侧吃同一份记录清单、同一份输入、同一组事实（uuid/时间/端口都固定
// 注入），然后比三样东西的字节：
//   1. 下一份记录清单（store 该被写成什么样）
//   2. 返回值 / 抛出的错误消息
//   3. 副作用调用序列（saveStore 调了几次、官方目录的 delete/provider 调没调）
// 第 3 项是关键：只比返回值的话，「少写一次盘」或「多删一次官方条目」会漏过去。

const test = require('node:test');
const assert = require('node:assert');

const { createLegacyWrites } = require('./helpers/legacy-provider-writes');
const legacySettings = require('./helpers/legacy-settings-config');
const { getNative } = require('../src/native/binding');

const native = getNative();
const PORT = '3000';
const NEW_ID = 'fixed-uuid-0000-0000-0000-000000000001';
const NOW = 1763000000000;

// ---------- 旧实现的依赖注入 ----------
// 这些是旧实现从 core.js 的词法作用域里读到的东西，逐一注入成可观测的替身。

function parseConfig(s) {
  if (s && typeof s === 'object') return s;
  try { return JSON.parse(s); } catch (_) { return {}; }
}
function tomlValue(toml, key) {
  const m = new RegExp(`(?:^|\\n)\\s*${key}\\s*=\\s*"([^"]+)"`).exec(toml || '');
  return m ? m[1] : '';
}
function normalizeEgressIpAllowlist(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const ip = raw == null ? '' : String(raw).trim();
    if (!ip || seen.has(ip)) continue;
    seen.add(ip);
    out.push(ip);
  }
  return out;
}
const EGRESS_ID = /^[a-z0-9][a-z0-9._-]*$/i;
function normalizeEgressBinding(value) {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('egressBinding must be an object');
  const pluginId = String(value.pluginId || '').trim();
  const profileId = String(value.profileId || '').trim();
  if (!EGRESS_ID.test(pluginId) || !EGRESS_ID.test(profileId)) {
    throw new Error('egressBinding needs a valid pluginId and profileId');
  }
  return { pluginId, profileId };
}

// 真实的 isOfficialProviderId(type, id) 是 id 的纯函数，所以两侧共用一个「官方 id
// 集合」，各自的事实都从它推导，而不是分别手填布尔值（手填会让两侧悄悄不一致，
// 比如 id 恰好等于 normalize 结果时）。
function officialSet(facts, args) {
  const ids = new Set();
  if (facts.idIsOfficial && args && args.id !== undefined) ids.add(args.id);
  if (facts.normalizedIdIsOfficial && facts.normalizedId) ids.add(facts.normalizedId);
  return ids;
}

// 一次对拍的运行环境：记录清单 + 事实 + 副作用日志。
function harness(records, facts, args) {
  const official = officialSet(facts, args);
  const calls = [];
  let stored = JSON.parse(JSON.stringify(records));
  const officialCatalog = facts.officialCatalogMounted ? {
    isOfficial: () => !!facts.assembledIsOfficial,
    normalize: () => facts.normalizedId,
    provider: appType => { calls.push(`catalog.provider(${appType})`); return { id: `${appType}-official`, appType }; },
    delete: (appType, id) => { calls.push(`catalog.delete(${appType},${id})`); return 'catalog-deleted'; },
  } : null;
  const deps = {
    loadStore: () => JSON.parse(JSON.stringify(stored)),
    saveStore: (list) => { calls.push(`saveStore(${list.length})`); stored = JSON.parse(JSON.stringify(list)); },
    officialCatalog,
    isOfficialProviderId: (_t, id) => official.has(id),
    summarize: p => { calls.push('summarize'); return { summarized: p.id }; },
    getProvider: () => facts.existingVirtual || undefined,
    listProviders: () => [],
    validateVirtual: () => { calls.push('validateVirtual'); return facts.virtualPlan; },
    buildSettingsConfig: (appType, input) => legacySettings.buildSettingsConfig(appType, { ...input, port: PORT }),
    normalizeApiFormat: legacySettings.normalizeApiFormat,
    assertApiFormatMatchesAppType: legacySettings.assertApiFormatMatchesAppType,
    normalizeEgressIpAllowlist,
    normalizeEgressBinding,
    parseConfig,
    parseModelList: legacySettings.parseModelList,
    applyAliasMapToEnv: legacySettings.applyAliasMapToEnv,
    ensureZhipuFableAlias: legacySettings.ensureZhipuFableAlias,
    tomlValue,
    randomUUID: () => facts.newId,
    now: () => facts.nowMs,
  };
  return { legacy: createLegacyWrites(deps), calls, final: () => stored };
}

// Rust 侧：宿主只做转发，和生产 core.js 的桩同构。
function runRust(op, records, facts, args) {
  const official = officialSet(facts, args);
  const calls = [];
  let stored = JSON.parse(JSON.stringify(records));
  const nativeFacts = {
    officialCatalogMounted: !!facts.officialCatalogMounted,
    idIsOfficial: args.id !== undefined && official.has(args.id),
    normalizedIdIsOfficial: facts.normalizedId != null && official.has(facts.normalizedId),
    normalizedId: facts.normalizedId == null ? null : facts.normalizedId,
    newId: facts.newId,
    nowMs: facts.nowMs,
    port: PORT,
    virtualPlan: null,
  };
  let retry = null;
  const run = commit => {
    if (commit.kind === 'error') { const e = new Error(commit.error); e.__thrown = true; throw e; }
    if (commit.kind === 'needsVirtualPlan') {
      calls.push('validateVirtual');
      nativeFacts.virtualPlan = facts.virtualPlan === undefined ? null : facts.virtualPlan;
      return retry();
    }
    if (commit.kind === 'answer') return commit.result;
    if (commit.kind === 'save') { calls.push(`saveStore(${commit.records.length})`); stored = commit.records; return commit.result; }
    if (commit.kind === 'officialCatalogEntry') {
      calls.push(`catalog.provider(${commit.appType})`); calls.push('summarize');
      return { summarized: `${commit.appType}-official` };
    }
    if (commit.kind === 'officialDelete') {
      calls.push(`catalog.delete(${commit.appType},${commit.id})`);
      if (commit.recordsChanged) { calls.push(`saveStore(${commit.records.length})`); stored = commit.records; }
      return 'catalog-deleted';
    }
    throw new Error('unknown commit ' + commit.kind);
  };
  let result, error = null;
  try {
    if (op === 'create') {
      // 生产桩的顺序：先探测记录拿官方裁决，再做决策。
      if (nativeFacts.officialCatalogMounted) {
        const probe = native.providerCreateRecord({ input: args.input, facts: nativeFacts });
        if (probe.kind === 'error') { const e = new Error(probe.error); e.__thrown = true; throw e; }
        if (probe.kind === 'record') nativeFacts.assembledIsOfficial = !!facts.assembledIsOfficial;
      }
      const call = () => run(native.providerCreate({ records: stored, input: args.input, facts: nativeFacts }));
      retry = call;
      result = call();
    } else if (op === 'update') {
      const call = () => run(native.providerUpdate({
        records: stored, appType: args.appType, id: args.id, input: args.input || {},
        existingVirtual: facts.existingVirtual || null, facts: nativeFacts,
      }));
      retry = call;
      result = call();
    } else {
      result = run(native.providerDelete({
        records: stored, appType: args.appType, id: args.id, facts: nativeFacts,
      }));
    }
  } catch (err) { error = err.message; }
  return { result, error, calls, final: stored };
}

let comparisons = 0;
let sideEffectChecks = 0;
function compare(label, op, records, facts, args) {
  const h = harness(records, facts, args);
  let legacyResult, legacyError = null;
  try {
    if (op === 'create') legacyResult = h.legacy.createProvider(args.input);
    else if (op === 'update') legacyResult = h.legacy.updateProvider(args.appType, args.id, args.input || {});
    else legacyResult = h.legacy.deleteProvider(args.appType, args.id);
  } catch (err) { legacyError = err.message; }

  const rust = runRust(op, records, facts, args);
  comparisons += 1;
  assert.equal(rust.error, legacyError, `${label}: 错误消息不一致`);
  assert.equal(JSON.stringify(rust.result), JSON.stringify(legacyResult), `${label}: 返回值字节不一致`);
  assert.equal(JSON.stringify(rust.final), JSON.stringify(h.final()), `${label}: 写入后的记录清单字节不一致`);
  sideEffectChecks += 1;
  assert.equal(rust.calls.join('|'), h.calls.join('|'), `${label}: 副作用调用序列不一致`);
}

// ---------- 语料 ----------
const BASE_FACTS = {
  officialCatalogMounted: false, idIsOfficial: false, normalizedIdIsOfficial: false,
  normalizedId: null, assembledIsOfficial: false, newId: NEW_ID, nowMs: NOW,
};
const CLAUDE_RECORD = {
  id: 'p-claude', appType: 'claude', apiFormat: 'anthropic', name: 'Claude 线路', source: 'local',
  settingsConfig: {
    env: {
      ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/anthropic',
      ANTHROPIC_AUTH_TOKEN: 'sk-old', ANTHROPIC_MODEL: 'glm-4.6',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-4.6', ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: 'GLM4.6',
    },
    modelCatalog: { models: [{ model: 'glm-4.6' }, { model: 'glm-4.5' }] },
  },
  createdAt: 1700000000000,
};
const CODEX_RECORD = {
  id: 'p-codex', appType: 'codex', apiFormat: 'openai_responses', name: 'Codex 线路', source: 'local',
  settingsConfig: {
    auth: { OPENAI_API_KEY: 'sk-codex' },
    config: 'model_provider = "custom"\nmodel = "gpt-5"\n\n[model_providers.custom]\nname = "custom"\nbase_url = "https://api.deepseek.com/v1"\nenv_key = "OPENAI_API_KEY"\nwire_api = "responses"\n',
    modelCatalog: { models: [{ model: 'gpt-5' }] },
  },
  createdAt: 1700000000001,
};
const COMPAT_RECORD = {
  id: 'p-compat', appType: 'codex', apiFormat: 'openai_responses', name: 'Compat', source: 'local',
  settingsConfig: {
    auth: { OPENAI_API_KEY: 'sk-x' },
    config: 'model_provider = "custom"\nbase_url = "http://127.0.0.1:3000/codex-proxy/p-compat"\nwire_api = "responses"\n',
    modelCatalog: { models: [{ model: 'm1' }] },
    proxyTarget: {
      baseUrl: 'https://maas-coding-api.cn-huabei-1.xf-yun.com/v1/responses',
      apiKey: 'sk-x', originalBaseUrl: 'https://maas-coding-api.cn-huabei-1.xf-yun.com/v1',
      mode: 'responses-compat',
    },
  },
  createdAt: 1700000000002,
};
// cc-switch 导入留下的、appType 不在 {claude, codex} 里的历史记录。updateProvider 在
// 走到 apiFormat 之前并不限定 appType，所以这类记录会真正走到「回退到已存 apiFormat」
// 的分支；只用 claude/codex 做语料时，这条分支的输出恒等，任何变异都测不出来。
const GEMINI_RECORD = {
  id: 'p-gemini', appType: 'gemini', apiFormat: 'anthropic', name: 'Gemini 导入', source: 'ccswitch',
  settingsConfig: { auth: { OPENAI_API_KEY: 'k' }, config: 'model = "gemini-2.5"\n', modelCatalog: { models: [{ model: 'gemini-2.5' }] } },
  createdAt: 1700000000003,
};
const GEMINI_OPENAI = { ...GEMINI_RECORD, id: 'p-gemini-o', apiFormat: 'openai_responses' };
const OVERRIDE_STUB = { id: 'claude-official-aaaaaaaaaaaaaaaa', appType: 'claude', source: 'builtin-override', egressIpAllowlist: ['1.2.3.4'] };
const LEGACY_NAMED = { id: 'claude-official-bbbbbbbbbbbbbbbb', appType: 'claude', source: 'ccswitch', name: '旧导入', egressBinding: { pluginId: 'p', profileId: 'q' } };

const LISTS = [
  [],
  [CLAUDE_RECORD],
  [CLAUDE_RECORD, CODEX_RECORD, COMPAT_RECORD],
  [OVERRIDE_STUB],
  [LEGACY_NAMED],
  [CLAUDE_RECORD, OVERRIDE_STUB, LEGACY_NAMED],
  [GEMINI_RECORD, GEMINI_OPENAI, CLAUDE_RECORD],
];

test('createProvider：校验分支、id/记录组装、官方目录分支', () => {
  const INPUTS = [
    { appType: 'claude', name: '新线路', baseUrl: 'https://api.anthropic.com', authToken: 'sk-a', model: 'claude-opus-4' },
    { appType: 'claude', name: '  带空白  ', baseUrl: 'https://open.bigmodel.cn/api/anthropic' },
    { appType: 'claude', name: 'Z', aliasMap: { opus: { model: 'o', name: 'O' } }, models: ['a', 'b'] },
    { appType: 'codex', name: 'Codex', baseUrl: 'https://api.deepseek.com/v1', authToken: 'sk-c', model: 'gpt-5' },
    { appType: 'codex', name: 'Compat', baseUrl: 'https://maas-coding-api.cn-huabei-1.xf-yun.com/v1', authToken: 'sk-x' },
    { appType: 'codex', name: 'OAuth' },
    { appType: 'claude', name: 'IP 白名单', baseUrl: 'https://x.example.com', egressIpAllowlist: [' 1.2.3.4 ', '1.2.3.4', '', null, 'bad'] },
    { appType: 'claude', name: '显式 settingsConfig', settingsConfig: { env: { ANTHROPIC_BASE_URL: 'https://e.example.com' } } },
    // 拒绝分支
    { appType: 'wrong', name: 'X' },
    { appType: 'claude' },
    { appType: 'claude', name: '   ' },
    { appType: 'claude', name: 'X', egressBinding: { pluginId: 'p', profileId: 'q' } },
    { appType: 'claude', name: 'X', apiFormat: 'openai_responses' },
    { appType: 'codex', name: 'X', apiFormat: 'anthropic' },
    { appType: 'claude', name: 'X', apiFormat: 'messages' },
  ];
  for (const records of LISTS) {
    for (const input of INPUTS) {
      for (const mounted of [false, true]) {
        for (const official of mounted ? [false, true] : [false]) {
          compare(
            `create ${JSON.stringify(input)} mounted=${mounted} official=${official}`,
            'create', records,
            { ...BASE_FACTS, officialCatalogMounted: mounted, assembledIsOfficial: official },
            { input }
          );
        }
      }
    }
  }
});

test('createProvider：虚拟线路分支', () => {
  const PLANS = [
    { virtual: { members: [{ providerId: 'p-claude' }] }, models: ['m1', 'm2'] },
    { virtual: { members: [] }, models: [] },
  ];
  for (const records of LISTS) {
    for (const plan of PLANS) {
      for (const name of ['组合线路', '  ', undefined]) {
        compare(
          `create virtual name=${JSON.stringify(name)}`,
          'create', records,
          { ...BASE_FACTS, virtualPlan: plan },
          { input: { appType: 'claude', name, virtual: plan.virtual } }
        );
      }
    }
  }
});

test('updateProvider：claude 逐字段改写、codex 重建、未找到', () => {
  const INPUTS = [
    {},
    { name: '改名' }, { name: '' }, { name: '  空白  ' },
    { baseUrl: 'https://new.example.com' }, { baseUrl: '' }, { baseUrl: null },
    { authToken: 'sk-new' }, { authToken: '' },
    { model: 'glm-5' }, { model: '' },
    { models: ['x', 'y'] }, { models: [] }, { models: 'x,y' },
    { model: 'glm-5', models: ['a'] },
    { aliasMap: { sonnet: { model: 's', name: 'S' } } },
    { aliasMap: {} }, { aliasMap: null },
    { apiFormat: 'anthropic' }, { apiFormat: 'openai_responses' }, { apiFormat: '' },
    { egressIpAllowlist: ['9.9.9.9'] }, { egressIpAllowlist: [] }, { egressIpAllowlist: null },
    { egressBinding: { pluginId: 'p', profileId: 'q' } },
    { settingsConfig: { env: { ANTHROPIC_BASE_URL: 'https://replaced.example.com' } } },
  ];
  for (const records of LISTS) {
    for (const [appType, id] of [['claude', 'p-claude'], ['codex', 'p-codex'], ['codex', 'p-compat'], ['claude', '缺失'], ['gemini', 'p-gemini'], ['gemini', 'p-gemini-o']]) {
      for (const input of INPUTS) {
        compare(
          `update ${appType}/${id} ${JSON.stringify(input)}`,
          'update', records, { ...BASE_FACTS }, { appType, id, input }
        );
      }
    }
  }
});

test('updateProvider：官方条目只接受高级设置，override 存根按需建立和清除', () => {
  const INPUTS = [
    { egressIpAllowlist: ['1.2.3.4'] },
    { egressIpAllowlist: [] },
    { egressIpAllowlist: null },
    { egressBinding: { pluginId: 'plug', profileId: 'prof' } },
    { egressBinding: null },
    { egressBinding: { pluginId: '', profileId: 'prof' } },
    { egressBinding: { pluginId: '-bad', profileId: 'prof' } },
    { egressBinding: [] },
    { egressIpAllowlist: ['1.2.3.4'], egressBinding: { pluginId: 'plug', profileId: 'prof' } },
    { egressIpAllowlist: [], egressBinding: null },
    // 被拒绝的字段
    { name: '改名' }, { baseUrl: 'https://x' }, { authToken: 't' },
    { model: 'm' }, { models: [] }, { apiFormat: 'anthropic' },
    { settingsConfig: {} }, { aliasMap: {} },
  ];
  for (const records of LISTS) {
    for (const input of INPUTS) {
      // 直接就是官方 id
      compare(
        `update official(direct) ${JSON.stringify(input)}`,
        'update', records,
        { ...BASE_FACTS, officialCatalogMounted: true, idIsOfficial: true, normalizedId: 'claude-official-aaaaaaaaaaaaaaaa' },
        { appType: 'claude', id: 'claude-official-aaaaaaaaaaaaaaaa', input }
      );
      // 别名经 normalize 才是官方 id
      compare(
        `update official(alias) ${JSON.stringify(input)}`,
        'update', records,
        { ...BASE_FACTS, officialCatalogMounted: true, idIsOfficial: false, normalizedIdIsOfficial: true, normalizedId: 'claude-official-aaaaaaaaaaaaaaaa' },
        { appType: 'claude', id: 'claude-official', input }
      );
    }
  }
});

test('updateProvider：虚拟线路与普通线路不可互转', () => {
  const plan = { virtual: { members: [{ providerId: 'p-claude' }] }, models: ['m1'] };
  for (const records of LISTS) {
    // 已是虚拟线路
    for (const input of [{}, { name: '新名' }, { name: null }, { virtual: plan.virtual }]) {
      compare(
        `update virtual-existing ${JSON.stringify(input)}`,
        'update', records,
        { ...BASE_FACTS, virtualPlan: plan, existingVirtual: { virtual: { members: [] }, name: '旧组合' } },
        { appType: 'claude', id: 'p-virtual', input }
      );
    }
    // 普通线路想变虚拟 → 拒绝
    compare(
      'update normal→virtual 拒绝',
      'update', records,
      { ...BASE_FACTS, virtualPlan: plan, existingVirtual: { name: '普通' } },
      { appType: 'claude', id: 'p-claude', input: { virtual: plan.virtual } }
    );
  }
});

test('deleteProvider：内置别名不可删、官方 id 走目录、普通 id 命中与未命中', () => {
  for (const records of LISTS) {
    for (const [appType, id] of [
      ['claude', 'p-claude'], ['codex', 'p-codex'], ['claude', '缺失'],
      ['claude', 'claude-official'], ['codex', 'codex-official'],
      ['claude', 'claude-official-aaaaaaaaaaaaaaaa'],
    ]) {
      for (const mounted of [false, true]) {
        for (const idIsOfficial of mounted ? [false, true] : [false]) {
          compare(
            `delete ${appType}/${id} mounted=${mounted} official=${idIsOfficial}`,
            'delete', records,
            { ...BASE_FACTS, officialCatalogMounted: mounted, idIsOfficial },
            { appType, id }
          );
        }
      }
    }
  }
});

test('宿主直接导出 Rust 注册表的写入方法，保留并发检查使用的源数组', () => {
  const fs = require('node:fs');
  const host = fs.readFileSync(require('node:path').join(__dirname, '../native/addon/src/providers_host_runtime/mod.rs'), 'utf8');
  assert.match(host, /service::provider_registry_service/);
  assert.doesNotMatch(host, /fn (create_provider|update_provider|delete_provider|run_commit|write_facts|save_virtual_provider)\b/);
  const native = fs.readFileSync(require('node:path').join(__dirname,
    '../native/addon/src/provider_service/registry.rs'), 'utf8');
  for (const op of ['create_provider', 'update_provider', 'delete_provider']) {
    assert.ok(native.includes('writes::' + op));
  }
  assert.match(native, /save\(p,\s*live\(p,\s*&records\)\?,\s*source\)/);
});

test('对拍规模与副作用覆盖都足够', () => {
  assert.ok(comparisons > 1000, `对拍次数只有 ${comparisons}`);
  assert.equal(sideEffectChecks, comparisons, '有对拍没检查副作用序列');
  console.log(`  对拍请求数: ${comparisons}；逐字节一致数: ${comparisons * 3}（返回值+记录清单+错误）；副作用序列比对数: ${sideEffectChecks}`);
});

test('写冲突原样返回，重试从存储重新读取版本', t => {
  const fs = require('node:fs'), path = require('node:path');
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'provider-registry-race-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { createNativeProviderStore } = require('../src/native/binding');
  const file = path.join(dir, 'providers.json');
  const owner = createNativeProviderStore(file), peer = createNativeProviderStore(file);
  let conflict;
  let writes = 0;
  const registry = native.providerRegistryService({
    store: {
      read: () => owner.read(),
      write(next, revision) {
        if (++writes === 1) {
          const rows = peer.read();
          rows.push({ id: 'concurrent', appType: 'claude', name: '已有线路' });
          peer.write(rows);
        }
        try { owner.write(next, revision); }
        catch (error) { conflict = error; throw error; }
      },
    },
    uuid: () => NEW_ID,
    getPort: () => PORT,
  });
  const request = { appType: 'claude', name: '新线路' };
  assert.throws(() => registry.createProvider(request),
    error => error === conflict && error.code === 'PROVIDER_STORE_CONFLICT');
  assert.deepStrictEqual(peer.read().map(row => row.id), ['concurrent']);
  registry.createProvider(request);
  assert.deepStrictEqual(peer.read().map(row => row.id), ['concurrent', NEW_ID]);
});
