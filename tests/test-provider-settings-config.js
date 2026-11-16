'use strict';

// settingsConfig 簇（parseModelList / responses-compat 探测 / aliasMap env /
// Zhipu fable 填充 / buildSettingsConfig / apiFormat 归一与校验）从
// src/providers/core.js 迁入 multicc_core 后的新旧差分。
//
// 旧实现冻结在 tests/helpers/legacy-settings-config.js；这里用同一份语料同时喂
// 两侧，比较 JSON.stringify 的字节（因此键序也在比较范围内）。断言数、逐字节
// 一致数与语料规模都打印出来，便于在报告里引用。

const test = require('node:test');
const assert = require('node:assert');

const legacy = require('./helpers/legacy-settings-config');
const { getNative } = require('../src/native/runtime');

const native = getNative();
const PORT = '3000';

// 对拍语料：每一项都对应旧实现里的一个分支或边界。
const BASE_URLS = [
  undefined, null, '', 'https://api.anthropic.com',
  'https://open.bigmodel.cn/api/anthropic',        // Zhipu 主机（fable 填充）
  'HTTPS://API.Z.AI/v1',                           // 大小写 + 协议前缀
  'https://sub.bigmodel.cn/v1', 'https://sub.z.ai/v1',
  'https://notz.ai.example.com/v1',                // 以 .ai 结尾但不是 z.ai
  'https://maas-coding-api.cn-huabei-1.xf-yun.com/v1', // compat 跳板
  'maas-coding-api.cn-huabei-1.xf-yun.com',        // 不可解析成 URL
  'not a url', 'http://127.0.0.1:8080/v1',
];
const AUTH_TOKENS = [undefined, '', 'sk-token'];
const MODELS = [undefined, '', 'glm-4.6', 'claude-opus-4'];
const MODEL_LISTS = [
  undefined, null, '', [],
  ['a', ' a ', '', 'b'],                           // 去重 + trim + 滤空
  'x,y\nz', 'x, ,y', ['glm-4.6', 'glm-4.5'],
  [null, undefined, 0, false, 'keep'],             // 非字符串元素
];
const ALIAS_MAPS = [
  undefined, null, '', 42, [],
  { opus: 'm-opus' },                              // 字符串形态
  { opus: { model: 'm-opus', name: 'Opus' } },      // 对象形态（带 name）
  { opus: { model: ' m ', name: '  ' } },           // name 全空白 → 删 _NAME
  { sonnet: { model: '' } },                        // 空 model → 删两键
  { fable: { model: 'custom-fable' } },             // 非空 fable → 阻止 Zhipu 填充
  { opus: 'o', sonnet: 's', haiku: 'h', fable: 'f' },
  { unknown: 'ignored' },
];
const PROVIDER_IDS = [undefined, '', 'p-1', 'p/2'];
const APP_TYPES = ['claude', 'codex', undefined, null, '', 'other'];
const API_FORMATS = [
  undefined, null, '', 'anthropic', 'messages', 'anthropic_messages',
  'ANTHROPIC', ' anthropic ', 'anthropic-messages', 'anthropic messages',
  'openai_responses', 'openai_chat', 'openai', 'nonsense', 42, true,
];

let comparisons = 0;
// 逐字节比较两侧结果：同一个 stringify，所以键序不同就会红。
function sameBytes(label, left, right) {
  comparisons += 1;
  assert.equal(
    JSON.stringify(right), JSON.stringify(left),
    `${label}: Rust 与冻结的旧实现字节不一致`
  );
}

test('parseModelList 与旧实现逐字节一致', () => {
  for (const models of MODEL_LISTS) {
    for (const model of MODELS) {
      sameBytes(
        `parseModelList(${JSON.stringify(models)}, ${JSON.stringify(model)})`,
        legacy.parseModelList(models, model),
        native.providerParseModelList({ models, model })
      );
    }
  }
});

test('responses-compat 探测与旧实现逐字节一致', () => {
  for (const baseUrl of BASE_URLS) {
    const expected = legacy.detectResponsesCompatTarget(baseUrl);
    const actual = native.providerResponsesCompatTarget({ baseUrl });
    sameBytes(
      `detectResponsesCompatTarget(${JSON.stringify(baseUrl)})`,
      expected,
      actual === undefined ? null : actual
    );
  }
});

test('isZhipuBaseUrl 与旧实现逐字节一致', () => {
  for (const baseUrl of BASE_URLS) {
    sameBytes(
      `isZhipuBaseUrl(${JSON.stringify(baseUrl)})`,
      legacy.isZhipuBaseUrl(baseUrl),
      native.providerIsZhipuBaseUrl({ baseUrl })
    );
  }
});

test('aliasMap env 写入/删除与旧实现逐字节一致', () => {
  // 预置 env 覆盖三种情况：空、带别名键、带别名键以外的键（必须原样保留）。
  const SEEDS = [
    {},
    { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' },
    {
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'stale',
      ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: 'Stale',
      ANTHROPIC_MODEL: 'keep-me',
    },
  ];
  for (const seed of SEEDS) {
    for (const aliasMap of ALIAS_MAPS) {
      const expected = { ...seed };
      legacy.applyAliasMapToEnv(expected, aliasMap);
      const actual = native.providerApplyAliasMap({ env: { ...seed }, aliasMap });
      sameBytes(
        `applyAliasMapToEnv(${JSON.stringify(seed)}, ${JSON.stringify(aliasMap)})`,
        expected, actual
      );
    }
  }
});

test('Zhipu fable 填充的返回值与就地写入都与旧实现一致', () => {
  const SEEDS = [
    {},
    { ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/anthropic' },
    { ANTHROPIC_BASE_URL: 'https://api.z.ai/v1', ANTHROPIC_DEFAULT_FABLE_MODEL: 'mine' },
    { ANTHROPIC_BASE_URL: 'https://api.z.ai/v1', ANTHROPIC_DEFAULT_FABLE_MODEL: '   ' },
    { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' },
  ];
  for (const seed of SEEDS) {
    const expected = { ...seed };
    const expectedApplied = legacy.ensureZhipuFableAlias(expected);
    const result = native.providerEnsureZhipuFableAlias({ env: { ...seed } });
    sameBytes(`ensureZhipuFableAlias(${JSON.stringify(seed)}) 的 applied`,
      expectedApplied, result.applied);
    sameBytes(`ensureZhipuFableAlias(${JSON.stringify(seed)}) 的 env`,
      expected, result.env);
  }
});

test('apiFormat 归一化与冲突判定都与旧实现一致', () => {
  for (const appType of APP_TYPES) {
    for (const apiFormat of API_FORMATS) {
      sameBytes(
        `normalizeApiFormat(${JSON.stringify(apiFormat)}, ${JSON.stringify(appType)})`,
        legacy.normalizeApiFormat(apiFormat, appType),
        native.providerNormalizeApiFormat({ apiFormat, appType })
      );
      let expected = null;
      try { legacy.assertApiFormatMatchesAppType(apiFormat, appType); }
      catch (err) { expected = err.message; }
      const actual = native.providerApiFormatConflict({ apiFormat, appType });
      sameBytes(
        `assertApiFormatMatchesAppType(${JSON.stringify(apiFormat)}, ${JSON.stringify(appType)})`,
        expected, actual === undefined ? null : actual
      );
    }
  }
});

test('buildSettingsConfig 在整个语料矩阵上与旧实现逐字节一致', () => {
  for (const appType of ['claude', 'codex']) {
    for (const baseUrl of BASE_URLS) {
      for (const authToken of AUTH_TOKENS) {
        for (const model of MODELS) {
          for (const models of MODEL_LISTS) {
            for (const aliasMap of ALIAS_MAPS) {
              for (const providerId of PROVIDER_IDS) {
                const input = { baseUrl, authToken, model, models, aliasMap, providerId };
                sameBytes(
                  `buildSettingsConfig(${appType}, ${JSON.stringify(input)})`,
                  legacy.buildSettingsConfig(appType, { ...input, port: PORT }),
                  native.providerBuildSettingsConfig({ appType, ...input, port: PORT })
                );
              }
            }
          }
        }
      }
    }
  }
});

test('生产代码的 core.js 入口本身走的就是 Rust（而不是残留的 JS 副本）', () => {
  const source = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '../src/providers/core.js'), 'utf8');
  // 旧实现的标志性字面量必须已经不在生产文件里，否则说明双轨还在。
  // 旧实现独有的字面量。ZHIPU_FABLE_ALIAS / ALIAS_TIER_KEYS 这两个名字还留在
  // core.js，但只作为 summarize() 读路径的入口：常量值本身已经改成从 Rust 取，
  // 档位名表则被另一个特性（ALIAS_TIER_REGEX）消费，都不是本簇的残留双轨。
  for (const gone of [
    'RESPONSES_COMPAT_PROXY_MAP',
    'anthropic_messages',
    'ANTHROPIC_DEFAULT_FABLE_MODEL_NAME',
    'auth_mode',
    "{ model: 'glm-5.3', name: 'GLM5.3' }",
  ]) {
    assert.ok(!source.includes(gone), `core.js 仍残留旧实现片段: ${gone}`);
  }
  // 接线现状：settingsConfig 的组装已整体下沉到 provider_writes（Rust 内部直接调用
  // build_settings_config），所以 core.js 不再需要、也不再持有 buildSettingsConfig /
  // parseModelList / applyAliasMapToEnv / assertApiFormatMatchesAppType 这几个 JS 函数
  // 及其 addon 入口调用。它仍直接用到的只剩读路径上的几个：
  for (const wired of [
    'providerNormalizeApiFormat', 'providerIsZhipuBaseUrl',
    'providerEnsureZhipuFableAlias', 'providerResponsesCompatTarget',
    'providerZhipuFableAlias',
  ]) {
    assert.ok(source.includes(wired), `core.js 没有接上 ${wired}`);
  }
  // 反过来：被下沉的 JS 函数不许复活。
  for (const gone of [
    'function buildSettingsConfig', 'function parseModelList',
    'function applyAliasMapToEnv', 'function assertApiFormatMatchesAppType',
  ]) {
    assert.ok(!source.includes(gone), `core.js 复活了已下沉的 ${gone}`);
  }
});

test('对拍规模足够大（防止语料被改空后测试仍然绿）', () => {
  assert.ok(comparisons > 4000, `逐字节比较次数只有 ${comparisons}，语料被缩小了`);
  console.log(`  逐字节一致的比较次数: ${comparisons}`);
});
