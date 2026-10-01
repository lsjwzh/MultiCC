'use strict';

// 「运行配置」这一层的纯逻辑：CLI×线路 兼容矩阵、池子草稿 → providerSelection 线格式、
// 固定一条的 PATCH、顶栏胶囊的文案。DOM 部分（open() 里那些 render）不在这里测 ——
// 它们由 CDP 实拍覆盖（npm run test:task-first:cdp）。
const test = require('node:test');
const assert = require('node:assert/strict');

const run = require('../public/run-config');

// 显示名/短标记在三端只有一份（public/provider-catalog.js）。这里挂一个最小目录，
// 让 pillModel 走真实分支，而不是它自己的 clean(cli) 兜底。
function withCatalog(fn) {
  global.window = {
    MultiCCProviderCatalog: {
      cliDisplayName: cli => ({ codex: 'Codex', 'codex-exp': 'Codex', opencode: 'OpenCode', codebuddy: 'WorkBuddy', zcode: 'ZCode' }[cli] || cli),
      cliShortMark: cli => ({ codex: 'E', 'codex-exp': 'X', opencode: 'O', codebuddy: 'W', zcode: 'Z' }[cli] || cli.slice(0, 1).toUpperCase()),
      nativeRouteLabel: cli => (cli === 'codebuddy' ? 'WorkBuddy' : ''),
    },
  };
  try { return fn(); } finally { delete global.window; }
}

const anthropicLine = { id: 'zhipu', protocol: 'anthropic', hasToken: true, baseUrl: 'https://open.bigmodel.cn/api/anthropic' };
const openaiLine = { id: 'codex-official', protocol: 'openai_responses', hasToken: true, baseUrl: 'https://chatgpt.com/backend-api/codex' };
const noCredLine = { id: 'deepseek', protocol: 'openai_responses', hasToken: false, baseUrl: '' };
const nativeLine = { id: 'opencode-native:opencodego', native: true };

// ── 常量 ─────────────────────────────────────────────────────────────────────
test('导出面：模式、挑选方式、档位、池子上限', () => {
  assert.equal(run.MODE_FIXED, 'fixed');
  assert.equal(run.MODE_AUTO, 'auto');
  assert.equal(run.PICK_ORDER, 'order');
  assert.equal(run.PICK_DIFFICULTY, 'difficulty');
  assert.deepEqual([...run.TIERS], ['simple', 'medium', 'complex']);
  assert.deepEqual({ ...run.TIER_KEYS }, { simple: 't1', medium: 't2', complex: 't3' });
  assert.equal(run.MIN_ATTEMPTS, 2);
  assert.equal(run.MAX_ATTEMPTS, 4);
  assert.equal(run.NATIVE_PREFIX, 'opencode-native:');
  assert.equal(run.AUTO_MODEL_VALUE, '__auto_model__');
  // 直连上游的那两条才要凭据；claude/codex/opencode 用 multicc 线路。
  assert.deepEqual([...run.CREDENTIAL_CLIS], ['zcode', 'kimi']);
  // 协议矩阵：claude 家族 anthropic；codex/kimi openai_responses；opencode/zcode 两边都行。
  assert.equal(run.CLI_PROTOCOLS.claude, 'anthropic');
  assert.equal(run.CLI_PROTOCOLS.kimi, 'openai_responses');
  assert.equal(run.CLI_PROTOCOLS.opencode, 'both');
  assert.equal(run.CLI_PROTOCOLS.zcode, 'both');
});

test('reorder 不原地改，越界与原地都返回等价副本', () => {
  const list = ['a', 'b', 'c'];
  assert.deepEqual(run.reorder(list, 0, 2), ['b', 'c', 'a']);
  assert.deepEqual(run.reorder(list, 2, 0), ['c', 'a', 'b']);
  assert.deepEqual(list, ['a', 'b', 'c'], '源数组不该被动');
  assert.deepEqual(run.reorder(list, 1, 1), ['a', 'b', 'c']);
  assert.deepEqual(run.reorder(list, 9, 0), ['a', 'b', 'c']);
  assert.deepEqual(run.reorder(null, 0, 1), []);
});

test('protocolOf 归一化 openai_chat，未知协议答 null', () => {
  assert.equal(run.protocolOf({ apiFormat: 'anthropic' }), 'anthropic');
  assert.equal(run.protocolOf({ protocol: 'openai_responses' }), 'openai_responses');
  assert.equal(run.protocolOf({ protocol: 'openai_chat' }), 'openai_responses');
  assert.equal(run.protocolOf({ protocol: 'gemini' }), null);
  assert.equal(run.protocolOf(null), null);
});

test('原生线路值的前后缀互转', () => {
  assert.equal(run.nativeLineValue('opencodego'), 'opencode-native:opencodego');
  assert.equal(run.nativeLineId('opencode-native:opencodego'), 'opencodego');
  assert.equal(run.nativeLineId('zhipu'), '');
  assert.equal(run.isNativeLine('opencode-native:x'), true);
  assert.equal(run.isNativeLine('zhipu'), false);
  assert.deepEqual(run.lineShape('opencode-native:opencode', null), { id: 'opencode-native:opencode', native: true, protocol: null, hasToken: false, baseUrl: '' });
  assert.deepEqual(run.lineShape('zhipu', anthropicLine), { id: 'zhipu', native: false, protocol: 'anthropic', hasToken: true, baseUrl: 'https://open.bigmodel.cn/api/anthropic' });
});

// ── 兼容矩阵 ─────────────────────────────────────────────────────────────────
test('cliLineVerdict：协议对得上才 ok', () => {
  assert.deepEqual(run.cliLineVerdict('claude', anthropicLine), { ok: true });
  assert.deepEqual(run.cliLineVerdict('claude-exp', anthropicLine), { ok: true });
  assert.deepEqual(run.cliLineVerdict('codex', openaiLine), { ok: true });
  assert.deepEqual(run.cliLineVerdict('kimi', openaiLine), { ok: true });
  // opencode/zcode 两种协议都吃。
  assert.deepEqual(run.cliLineVerdict('opencode', anthropicLine), { ok: true });
  assert.deepEqual(run.cliLineVerdict('opencode', openaiLine), { ok: true });
  assert.deepEqual(run.cliLineVerdict('zcode', openaiLine), { ok: true });

  assert.equal(run.cliLineVerdict('claude', openaiLine).code, 'protocol_mismatch');
  assert.equal(run.cliLineVerdict('codex', anthropicLine).code, 'protocol_mismatch');
  assert.equal(run.cliLineVerdict('kimi', anthropicLine).code, 'protocol_mismatch');
  assert.equal(run.cliLineVerdict('nope', anthropicLine).code, 'unsupported_cli');
  assert.equal(run.cliLineVerdict('claude', { id: 'x' }).code, 'unknown_protocol');
});

test('cliLineVerdict：直连上游的车道必须自带 key 与 baseUrl', () => {
  assert.equal(run.cliLineVerdict('zcode', noCredLine).code, 'needs_credentials');
  assert.equal(run.cliLineVerdict('kimi', noCredLine).code, 'needs_credentials');
  // 只给了一半也不算。
  assert.equal(run.cliLineVerdict('zcode', { protocol: 'openai_responses', hasToken: true, baseUrl: '' }).code, 'needs_credentials');
  assert.equal(run.cliLineVerdict('zcode', { protocol: 'openai_responses', hasToken: false, baseUrl: 'https://x' }).code, 'needs_credentials');
  assert.deepEqual(run.cliLineVerdict('zcode', openaiLine), { ok: true });
});

test('cliLineVerdict：OpenCode 自己的线路只归 OpenCode', () => {
  assert.deepEqual(run.cliLineVerdict('opencode', nativeLine), { ok: true });
  for (const cli of ['claude', 'codex', 'zcode', 'kimi']) {
    assert.equal(run.cliLineVerdict(cli, nativeLine).code, 'native_line_needs_opencode', `${cli} 不该能跑原生线路`);
  }
});

test('cliChoicesForLine：不给能跑的车道，只标出哪条能跑', () => {
  const label = () => '智谱 GLM';
  const choices = run.cliChoicesForLine(anthropicLine, label, ['claude', 'codex', 'opencode']);
  assert.deepEqual(choices.map(item => [item.cli, item.ok]), [['claude', true], ['codex', false], ['opencode', true]]);
  assert.match(choices[1].reason, /协议/);
  // 不传 clis 时退回全部已知车道。
  assert.equal(run.cliChoicesForLine(anthropicLine, label).length, run.AUTO_CLIS.length);
});

test('rowIssue：池子里失效的老组合要留下并把原因说出来', () => {
  assert.equal(run.rowIssue({ cli: 'claude', providerId: 'zhipu' }, anthropicLine, () => 'Claude'), null);
  assert.equal(run.rowIssue({ cli: 'codex', providerId: 'gone' }, null, () => 'Codex').code, 'missing_line');
  const mismatch = run.rowIssue({ cli: 'codex', providerId: 'zhipu' }, anthropicLine, () => 'Codex');
  assert.equal(mismatch.code, 'protocol_mismatch');
  const cred = run.rowIssue({ cli: 'zcode', providerId: 'deepseek' }, noCredLine, () => 'ZCode');
  assert.equal(cred.code, 'needs_credentials');
  assert.match(cred.reason, /ZCode 需要 API key/);
});

// ── 固定一条 → PATCH ─────────────────────────────────────────────────────────
test('buildFixedPatch：普通线路写 provider，providerSelection 归 null', () => {
  const result = run.buildFixedPatch({ cli: 'codex', providerId: 'codex-official', model: 'gpt-5.5', effort: 'high' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { provider: 'codex-official', providerSelection: null, model: 'gpt-5.5', effort: 'high' });
});

test('buildFixedPatch：原生 OpenCode 线路写 provider 空 + <id>/<model>', () => {
  const result = run.buildFixedPatch({ cli: 'opencode', providerId: 'opencode-native:opencodego', model: 'z-ai/glm-4.6', effort: 'medium' });
  assert.equal(result.ok, true);
  // provider 归 null（原生配置 = 「没有 multicc 线路」，和 air-task-settings.js 的老写法一致）。
  assert.deepEqual(result.value, { provider: null, providerSelection: null, model: 'opencodego/z-ai/glm-4.6', effort: 'medium' });
  // 已经带了 <id>/ 前缀就不再拼一次。
  assert.equal(run.buildFixedPatch({ cli: 'opencode', providerId: 'opencode-native:opencodego', model: 'opencodego/z-ai/glm-4.6' }).value.model, 'opencodego/z-ai/glm-4.6');
  // 缺模型可以回落到线路默认。
  assert.equal(run.buildFixedPatch({ cli: 'opencode', providerId: 'opencode-native:opencodego', nativeDefaultModel: 'qwen3-coder' }).value.model, 'opencodego/qwen3-coder');
});

test('buildFixedPatch：原生线路配错车道 / 缺模型都拦下来', () => {
  assert.equal(run.buildFixedPatch({ cli: 'codex', providerId: 'opencode-native:opencodego', model: 'x' }).code, 'provider_cli_mismatch');
  assert.equal(run.buildFixedPatch({ cli: 'opencode', providerId: 'opencode-native:opencodego' }).code, 'invalid_provider_candidate');
});

test('buildFixedPatch：没选线路时 provider 归 null，effort 只在有 CLI 时写', () => {
  assert.deepEqual(run.buildFixedPatch({ cli: '', providerId: '' }).value, { provider: null, providerSelection: null, model: null, effort: null });
});

// ── 自动挑选 → providerSelection ─────────────────────────────────────────────
const rows = (extra = []) => ([
  { providerId: 'codex-official', cli: 'codex', model: 'gpt-5.5', enabled: true, ...extra[0] },
  { providerId: 'zhipu', cli: 'claude', model: 'glm-4.6', enabled: true, ...extra[1] },
]);

test('buildAutoSelection：少于两条可用线路直接拦', () => {
  const result = run.buildAutoSelection({ pick: run.PICK_ORDER, rows: [{ providerId: 'a', cli: 'codex' }] });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'insufficient_candidates');
});

test('buildAutoSelection：按顺序 = failover，无 routing，无 autoModel', () => {
  const result = run.buildAutoSelection({ pick: run.PICK_ORDER, rows: rows(), maxAttempts: 3 });
  assert.equal(result.ok, true);
  const value = result.value;
  assert.equal(value.mode, 'auto');
  assert.equal(value.cliSwitch, 'failover');
  assert.equal(value.routing, undefined);
  assert.equal(value.maxAttempts, 2, '两条线路只能试两次');
  assert.equal(value.sticky, true);
  // 每一行都带 cli（服务端按 cli 找目录）。
  assert.deepEqual(value.candidates.map(c => [c.cli, c.providerId, c.model, c.priority, c.enabled]), [
    ['codex', 'codex-official', 'gpt-5.5', 1, true],
    ['claude', 'zhipu', 'glm-4.6', 2, true],
  ]);
  assert.equal(value.candidates[0].autoModel, undefined);
  // 按顺序下即使行上标了 autoModel 也不生效。
  const noAuto = run.buildAutoSelection({ pick: run.PICK_ORDER, rows: rows([{ autoModel: true }, {}]) });
  assert.equal(noAuto.value.candidates[0].autoModel, undefined);
});

test('buildAutoSelection：maxAttempts 夹在 2..min(4, 行数)', () => {
  const five = [
    { providerId: 'a', cli: 'codex' }, { providerId: 'b', cli: 'claude' }, { providerId: 'c', cli: 'opencode' },
    { providerId: 'd', cli: 'kimi' }, { providerId: 'e', cli: 'zcode' },
  ];
  assert.equal(run.buildAutoSelection({ pick: run.PICK_ORDER, rows: rows(), maxAttempts: 99 }).value.maxAttempts, 2);
  assert.equal(run.buildAutoSelection({ pick: run.PICK_ORDER, rows: rows(), maxAttempts: 1 }).value.maxAttempts, 2);
  assert.equal(run.buildAutoSelection({ pick: run.PICK_ORDER, rows: rows(), maxAttempts: undefined }).value.maxAttempts, 2);
  assert.equal(run.buildAutoSelection({ pick: run.PICK_ORDER, rows: five.slice(0, 3), maxAttempts: 3 }).value.maxAttempts, 3);
  assert.equal(run.buildAutoSelection({ pick: run.PICK_ORDER, rows: five, maxAttempts: 99 }).value.maxAttempts, 4, '上限是 4');
});

test('buildAutoSelection：禁用的行不参与，空 providerId 也跳过', () => {
  const result = run.buildAutoSelection({
    pick: run.PICK_ORDER,
    rows: [
      { providerId: 'codex-official', cli: 'codex', enabled: true },
      { providerId: 'zhipu', cli: 'claude', enabled: false },
      { providerId: '', cli: 'opencode', enabled: true },
      { providerId: 'kimi-x', cli: 'kimi', enabled: true },
    ],
  });
  assert.deepEqual(result.value.candidates.map(c => c.providerId), ['codex-official', 'kimi-x']);
});

test('buildAutoSelection：按难度 + 交给 Jev = routing/tiering price，不带档位', () => {
  const result = run.buildAutoSelection({
    pick: run.PICK_DIFFICULTY, tiering: run.PRICE_TIERING, rows: rows(),
    routing: { gateway: 'vercel', apiKeyName: 'vercel-api-key' },
  });
  assert.equal(result.ok, true);
  const value = result.value;
  assert.equal(value.cliSwitch, 'routing');
  assert.equal(value.routing.provider, 'jev');
  assert.equal(value.routing.gateway, 'vercel');
  assert.equal(value.routing.apiKeyName, 'vercel-api-key');
  assert.equal(value.routing.tiering, 'price');
  assert.equal(value.routing.tiers, undefined);
  assert.equal(value.candidates.every(c => c.tier === undefined), true);
});

test('buildAutoSelection：按难度 + 我自己标 = 每行带 tier，tiers 弱→强', () => {
  const result = run.buildAutoSelection({
    pick: run.PICK_DIFFICULTY, tiering: run.DEFAULT_TIERING,
    rows: [
      { providerId: 'a', cli: 'codex', model: 'm1', tier: 'simple' },
      { providerId: 'b', cli: 'claude', model: 'm2', tier: 'complex' },
      { providerId: 'c', cli: 'opencode', model: 'm3', tier: 'medium' },
    ],
    routing: { gateway: 'openrouter' },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.candidates.map(c => c.tier), ['t1', 't3', 't2']);
  assert.deepEqual(result.value.routing.tiers, ['t1', 't2', 't3']);
  assert.equal(result.value.routing.tiering, undefined);
});

test('buildAutoSelection：我自己标要求至少两条落在不同档位', () => {
  const same = run.buildAutoSelection({
    pick: run.PICK_DIFFICULTY, tiering: 'manual',
    rows: [{ providerId: 'a', cli: 'codex', tier: 'medium' }, { providerId: 'b', cli: 'claude', tier: 'medium' }],
  });
  assert.equal(same.code, 'provider_routing_requires_tiers');
  const missing = run.buildAutoSelection({
    pick: run.PICK_DIFFICULTY, tiering: 'manual',
    rows: [{ providerId: 'a', cli: 'codex', tier: 'simple' }, { providerId: 'b', cli: 'claude' }],
  });
  assert.equal(missing.code, 'provider_routing_requires_tiers');
});

test('buildAutoSelection：自动（Jev 挑）只在按难度下折成 autoModel', () => {
  const result = run.buildAutoSelection({
    pick: run.PICK_DIFFICULTY, tiering: 'manual',
    rows: [
      { providerId: 'a', cli: 'codex', autoModel: true, tier: 'simple' },
      { providerId: 'b', cli: 'claude', model: 'glm-4.6', tier: 'complex' },
    ],
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.candidates[0].autoModel, true);
  assert.equal(result.value.candidates[0].model, undefined);
  assert.equal(result.value.candidates[1].autoModel, undefined);
  assert.equal(result.value.candidates[1].model, 'glm-4.6');
});

test('buildAutoSelection：官方与自管混池要显式确认', () => {
  const providers = [{ id: 'official-1', isOfficial: true }, { id: 'user-1', isOfficial: false }];
  const draft = {
    pick: run.PICK_ORDER, providers,
    rows: [{ providerId: 'official-1', cli: 'codex' }, { providerId: 'user-1', cli: 'claude' }],
  };
  assert.equal(run.buildAutoSelection(draft).code, 'cross_trust_confirmation_required');
  const confirmed = run.buildAutoSelection({ ...draft, crossTrustConfirmed: true });
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.value.allowCrossTrust, true);
  // 同一信任域不需要确认。
  const single = run.buildAutoSelection({ pick: run.PICK_ORDER, providers, rows: [{ providerId: 'official-1', cli: 'codex' }, { providerId: 'official-1', cli: 'opencode' }] });
  assert.equal(single.ok, true);
  assert.equal(single.value.allowCrossTrust, false);
});

// ── 胶囊 ─────────────────────────────────────────────────────────────────────
test('pillModel（固定一条）：CLI · 线路 · 模型，跑线路名不重复念', () => {
  withCatalog(() => {
    const model = run.pillModel({
      current: { cli: 'codex', model: 'gpt-5.5' },
      next: { cli: 'codex', model: 'gpt-5.5', routeName: 'Lab Responses' },
      currentRoute: 'Lab Responses',
      currentModel: 'gpt-5.5',
    });
    assert.equal(model.tone, 'fixed');
    assert.equal(model.mark, 'E');
    assert.equal(model.text, 'Codex · Lab Responses · gpt-5.5');
    assert.equal(run.pillText(model), 'Codex · Lab Responses · gpt-5.5');

    // 自持账号车道：线路名 == 产品名，只说一次。
    const buddy = run.pillModel({
      current: { cli: 'codebuddy', model: '默认模型' },
      next: { cli: 'codebuddy', model: '默认模型' },
      currentRoute: 'WorkBuddy',
    });
    assert.equal(buddy.text, 'WorkBuddy · 默认模型');
    assert.equal(buddy.mark, 'W');
  });
});

test('pillModel（固定一条）：待生效时补一句，色调不变仍写 fixed', () => {
  withCatalog(() => {
    const model = run.pillModel({
      current: { cli: 'codebuddy', model: '默认模型' },
      next: { cli: 'codebuddy', model: '默认模型' },
      currentRoute: 'WorkBuddy',
      pending: true,
      pendingLabel: '下轮生效',
    });
    assert.equal(model.pending, true);
    assert.equal(model.tone, 'fixed');
    assert.equal(model.text, 'WorkBuddy · 默认模型 · 下轮生效');
  });
});

test('pillModel（自动挑选）：⚡ · 怎么挑 · N 条，本轮另起一段', () => {
  withCatalog(() => {
    const selection = { version: 1, mode: 'auto', cliSwitch: 'failover', candidates: [{ providerId: 'a', cli: 'codex', enabled: true }, { providerId: 'b', cli: 'claude', enabled: true }, { providerId: 'c', cli: 'claude', enabled: false }] };
    const order = run.pillModel({
      current: { cli: 'codex', model: 'gpt-5.5' },
      next: { cli: 'codex', model: 'gpt-5.5', providerSelection: selection },
      currentRoute: 'Lab Responses',
      currentModel: 'gpt-5.5',
    });
    assert.equal(order.tone, 'auto');
    assert.equal(order.mark, '⚡');
    assert.equal(order.text, '⚡ 自动 · 按顺序 · 2 条', '禁用的行不进 N 条');
    assert.equal(order.turn, 'Lab Responses · gpt-5.5');
    assert.equal(run.pillText(order), '⚡ 自动 · 按顺序 · 2 条 ｜本轮 Lab Responses · gpt-5.5');

    const difficulty = run.pillModel({
      current: { cli: 'codex' },
      next: { cli: 'codex', providerSelection: { ...selection, cliSwitch: 'routing' } },
      currentRoute: 'Lab Responses',
    });
    assert.equal(difficulty.text, '⚡ 自动 · 按难度 · 2 条');
  });
});

test('pillModel（自动挑选）：已经是自动池时不重复报本轮', () => {
  withCatalog(() => {
    const selection = { version: 1, mode: 'auto', cliSwitch: 'failover', candidates: [{ providerId: 'a', cli: 'codex', enabled: true }, { providerId: 'b', cli: 'claude', enabled: true }] };
    const model = run.pillModel({
      current: { cli: 'codex', providerSelection: selection },
      next: { cli: 'codex', providerSelection: selection },
      currentRoute: 'Lab Responses',
      currentModel: 'gpt-5.5',
    });
    assert.equal(model.turn, '');
    assert.equal(run.pillText(model), '⚡ 自动 · 按顺序 · 2 条');
  });
});

test('pillModel：待生效的自动池也带那句后缀', () => {
  withCatalog(() => {
    const selection = { version: 1, mode: 'auto', cliSwitch: 'routing', candidates: [{ providerId: 'a', cli: 'codex', enabled: true }, { providerId: 'b', cli: 'claude', enabled: true }] };
    const model = run.pillModel({
      current: { cli: 'codex' }, next: { cli: 'codex', providerSelection: selection },
      currentRoute: 'x', pending: true, pendingLabel: '下一轮生效',
    });
    assert.equal(model.text, '⚡ 自动 · 按难度 · 2 条 · 下一轮生效');
  });
});
