'use strict';

// 「运行配置」：任务顶栏那一颗胶囊 + 它点开的那个对话框。它替掉了从前分开的
// CLI / 模型 / 推理强度三颗按钮，也替掉了 air-task-settings.js 那套「先选 CLI，
// 再到 Auto Provider 里再选一次 CLI」的三步表单 —— 一处选完 CLI、线路、模型。
//
// 两种运行方式画在同一层：
//   固定一条  一个 CLI + 一条线路 + 一个模型
//   自动挑选  一个线路池，池里每一行是「CLI · 线路 · 模型」的完整组合
//     按顺序  一直用第 1 条，额度用完或报错才往下换（cliSwitch=failover）
//     按难度  每条消息先让 Jev 判断难易，再挑线路和模型（cliSwitch=routing）
//
// 这个文件只负责「运行配置」这一件事：协议兼容矩阵、线格式映射、胶囊文案都是纯
// 函数（不需要 DOM，tests/test-run-config.js 直接调），真正的 DOM 只出现在 open()
// 与它下面那几个 render 函数里。复用的是邻居那份能力，不是它的皮：
//   · MultiCCProviderCatalog  车道/线路目录（显示名、短标记、协议、compatibleClis）
//   · MultiCCChatAiConfig     模型候选、effort 档位、OpenCode 原生线路、子任务判定
//   · MultiCCAutoProviderEditor  协议常量、Jev 网关表、跨信任域判定、预设存取
(function initRunConfig(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MultiCCRunConfig = api;
})(typeof window !== 'undefined' ? window : null, function createRunConfigApi() {
  const scope = () => (typeof window !== 'undefined' ? window : null);

  // ── 常量 ──────────────────────────────────────────────────────────────────
  const MODE_FIXED = 'fixed';
  const MODE_AUTO = 'auto';
  const PICK_ORDER = 'order';
  const PICK_DIFFICULTY = 'difficulty';
  // 档位只有三档：简单 / 中等 / 复杂。服务端只认 tiers 键（t1/t2/…），这三档在
  // 保存时按「弱→强」压成 t1..tn，最多三条。
  const TIERS = Object.freeze(['simple', 'medium', 'complex']);
  const TIER_KEYS = Object.freeze({ simple: 't1', medium: 't2', complex: 't3' });
  // 行里「自动（Jev 挑）」那一项在下拉里的值：它不是一个真实模型，保存时折成
  // candidate.autoModel。
  const AUTO_MODEL_VALUE = '__auto_model__';
  // auto-provider-editor.js 存预设用的 localStorage 键（那个模块没导出这个常量）。
  const PRESET_KEY = 'multicc.autoProvider.presets.v1';
  const DEFAULT_TIERING = 'manual';
  const PRICE_TIERING = 'price';
  const MAX_ATTEMPTS = 4;
  const MIN_ATTEMPTS = 2;
  const NATIVE_PREFIX = 'opencode-native:';
  // 用 API Key 认证的车道（Command Code、OpenCode 的 opencode.ai 线路）：会话可以给
  // 每条车道各挑一个账户（服务端 src/cli-key-accounts.js），留空 = 用 CLI 自己的登录。
  const KEY_ACCOUNT_CLIS = Object.freeze(['commandcode', 'opencode']);
  // OpenCode 的账户只换 opencode.ai 那几条线路（Zen / Go）的 key —— 与服务端
  // OPENCODE_ACCOUNT_PROVIDERS 是同一张表。
  const OPENCODE_ACCOUNT_LINES = Object.freeze(['opencode', 'opencode-go', 'opencodego']);
  const ACCOUNT_ADD_VALUE = '__add_account__';
  // 一条线路能不能被某条车道跑，只由两件事决定：协议对不对得上，以及那条车道要不要
  // 凭据。这张表是车道属性（权威表在服务端 src/cli/cli-capability.js）在这里的投影。
  // 'both' = 两种协议都能跑（opencode 自己配、zcode 直连上游）。
  const CLI_PROTOCOLS = Object.freeze({
    claude: 'anthropic',
    'claude-exp': 'anthropic',
    codex: 'openai_responses',
    'codex-exp': 'openai_responses',
    opencode: 'both',
    zcode: 'both',
    kimi: 'openai_responses',
  });
  const AUTO_CLIS = Object.freeze(Object.keys(CLI_PROTOCOLS));
  // 直连上游的车道：线路必须自带 baseUrl 与 token，否则这条组合跑不起来。
  const CREDENTIAL_CLIS = Object.freeze(['zcode', 'kimi']);

  // ── 小工具 ────────────────────────────────────────────────────────────────
  function fail(error, code) {
    return Object.freeze({ ok: false, value: null, error, code });
  }

  function ok(value) {
    return Object.freeze({ ok: true, value, error: null, code: null });
  }

  function clean(value) {
    return value == null ? '' : String(value).trim();
  }

  // 拖动排序：把 from 位置的元素挪到 to 位置，返回新数组（不原地改）。
  function reorder(list, from, to) {
    const out = [...(Array.isArray(list) ? list : [])];
    if (from < 0 || to < 0 || from >= out.length || to >= out.length || from === to) return out;
    const [item] = out.splice(from, 1);
    out.splice(to, 0, item);
    return out;
  }

  function protocolOf(value) {
    const raw = value && (value.protocol || value.apiFormat);
    const protocol = raw === 'openai_chat' ? 'openai_responses' : raw;
    return protocol === 'anthropic' || protocol === 'openai_responses' ? protocol : null;
  }

  function isNativeLine(providerId) {
    return clean(providerId).startsWith(NATIVE_PREFIX);
  }

  function nativeLineId(providerId) {
    const text = clean(providerId);
    return text.startsWith(NATIVE_PREFIX) ? text.slice(NATIVE_PREFIX.length) : '';
  }

  function nativeLineValue(id) {
    return NATIVE_PREFIX + clean(id);
  }

  // OpenCode 自己的线路（Zen / Go / `opencode auth login` 过的）不是 multicc 的
  // provider：会话里存成 provider 空 + `<线路id>/<模型>`（见 buildFixedPatch），
  // provider 表里查不到任何名字。药丸要摆「OpenCode Go」而不是「默认线路」，只能
  // 从这个前缀翻回来 —— boot() 认 nativeFromModel 是同一件事，名字表仍只有
  // chat-ai-config.js 那一份。
  function openCodeRouteName(cli, provider, model) {
    if (clean(cli) !== 'opencode' || clean(provider)) return '';
    const text = clean(model);
    const slash = text.indexOf('/');
    if (slash <= 0) return '';
    const id = text.slice(0, slash);
    const api = scope() && scope().MultiCCChatAiConfig;
    return api && typeof api.openCodeNativeProviderLabel === 'function'
      ? clean(api.openCodeNativeProviderLabel(id)) : '';
  }

  // 将原生线路或 Provider 归一化，供兼容性判定使用。
  function lineShape(value, provider) {
    if (isNativeLine(value)) {
      return { id: clean(value), native: true, protocol: null, hasToken: false, baseUrl: '' };
    }
    const source = provider || {};
    return {
      id: clean(value),
      ...(source.virtual ? { virtual: source.virtual, appType: source.appType } : {}),
      native: false,
      protocol: protocolOf(source),
      hasToken: source.hasToken === true,
      baseUrl: clean(source.baseUrl),
    };
  }

  // ── 子 agent（子任务）线路：家族、默认值、同步摘要 ────────────────────────
  // 服务端按「家族」存子 agent 默认（src 那份是 claude / codex）：claude 与
  // claude-exp 是同一族，codex 与 codex-exp 是同一族。这里只做这条映射，别处
  // （同步按钮文案、默认值查找、测试）都用它，不要再各写一张表。
  const SUBAGENT_GUIDE_KEY = 'multicc.runConfig.subagentGuide.v1';

  function subagentFamily(cli) {
    const value = clean(cli);
    if (value === 'claude' || value === 'claude-exp') return 'claude';
    if (value === 'codex' || value === 'codex-exp') return 'codex';
    return '';
  }

  // 家族在按钮文案里的名字是产品名（不翻译）；不认识就退回空串，调用方自己兜底。
  function subagentFamilyLabel(family) {
    return family === 'claude' ? 'Claude Code' : family === 'codex' ? 'Codex' : '';
  }

  // 家族对应的目录 CLI：/api/providers?cli=… 与默认线路的 provider 名字都按它查。
  function subagentFamilyCli(family) {
    return family === 'claude' ? 'claude' : family === 'codex' ? 'codex' : '';
  }

  // 一条 {providerId, model} 要么两半都在，要么根本不算设置 —— 与
  // chat-ai-config.js resolveSubagent()、服务端 subagent.js 同一条规矩。
  function normalizeSubagentRoute(value) {
    if (!value || typeof value !== 'object') return null;
    const providerId = clean(value.providerId).slice(0, 180);
    const model = clean(value.model).slice(0, 100);
    return providerId && model ? Object.freeze({ providerId, model }) : null;
  }

  function sameSubagentRoute(a, b) {
    const left = normalizeSubagentRoute(a);
    const right = normalizeSubagentRoute(b);
    if (!left || !right) return !left && !right;
    return left.providerId === right.providerId && left.model === right.model;
  }

  // defaults 既可以是 /api/providers 回来的整份目录（catalog.defaults），也可以
  // 只是那份 defaults 对象；两处都能查，调用方不用先剥一层。
  function subagentDefaultFor(defaults, cli) {
    const family = subagentFamily(cli);
    if (!family) return null;
    const source = defaults && typeof defaults === 'object' ? defaults : {};
    const table = source.defaults && typeof source.defaults === 'object' ? source.defaults : source;
    const routes = table.subagent && typeof table.subagent === 'object' ? table.subagent : {};
    return normalizeSubagentRoute(routes[family]);
  }

  // 同步预览（dry run）→ 状态行文案。preview 的形状：
  //   { state:'loading' }
  //   { state:'ready', family, counts:{applied,deferred,unchanged,skipped,kept} }
  //   { state:'error', error }
  //   { state:'unavailable' }   ← 503：服务端加载的原生模块还是旧的，没有同步接口
  // 只产出 {tone, text}，不碰 DOM —— tests/test-run-config.js 直接调。
  function syncSummary(preview) {
    if (!preview || typeof preview !== 'object') return { tone: 'idle', text: '' };
    if (preview.state === 'loading') {
      return { tone: 'loading', text: tt('runConfigSyncChecking', '正在检查要更新的任务…') };
    }
    if (preview.state === 'error') {
      return { tone: 'error', text: tt('runConfigSyncPreviewFailed', '无法读取同步预览：{error}', { error: clean(preview.error) }) };
    }
    if (preview.state === 'unavailable') {
      return { tone: 'error', text: tt('runConfigSyncUnavailable', '服务端加载的原生模块是旧版本，暂不支持同步。重启一次 MultiCC 会自动按当前代码重新编译加载，之后改这个设置不需要再重启。') };
    }
    const counts = preview.counts && typeof preview.counts === 'object' ? preview.counts : {};
    const applied = Number(counts.applied) || 0;
    const deferred = Number(counts.deferred) || 0;
    const skipped = Number(counts.skipped) || 0;
    const kept = Number(counts.kept) || 0;
    const total = applied + deferred;
    // 单独设置过子 agent 的任务同步不碰：单独说一句，免得以为漏了。
    const suffix = (kept > 0 ? tt('runConfigSyncKeptSuffix', '，{k} 个单独设置过的保持不变', { k: kept }) : '')
      + (skipped > 0 ? tt('runConfigSyncSkippedSuffix', '，{k} 个跳过', { k: skipped }) : '');
    if (total > 0) {
      return {
        tone: 'ready',
        text: (total === 1
          ? tt('runConfigSyncPreviewOne', '将更新 1 个任务')
          : tt('runConfigSyncPreview', '将更新 {n} 个任务', { n: total })) + suffix,
      };
    }
    return {
      tone: 'ready',
      text: tt('runConfigSyncNothing', '没有需要更新的 {cli} 任务',
        { cli: subagentFamilyLabel(preview.family) || '' }) + suffix,
    };
  }

  // 清除全局默认前的确认文案（清除的 dry run 计数）：恢复随主的是跟随全局的任务。
  function clearSummary(preview) {
    const counts = preview && preview.counts && typeof preview.counts === 'object' ? preview.counts : {};
    return tt('runConfigClearPreview', '清除后 {n} 个跟随全局的 {cli} 任务恢复随主，新建任务也不再默认使用；单独设置过的 {k} 个不受影响。', {
      n: (Number(counts.applied) || 0) + (Number(counts.deferred) || 0), k: Number(counts.kept) || 0,
      cli: subagentFamilyLabel(preview && preview.family) || '' });
  }

  // 首次引导只记「看过了」这一个事实；存储被禁（Safari 私密窗口等）时读不到
  // 就当作没看过，写失败也不抛 —— 引导只是提示，不能拦住对话框。
  function guideSeen(storage) {
    try {
      if (!storage || typeof storage.getItem !== 'function') return false;
      return !!storage.getItem(SUBAGENT_GUIDE_KEY);
    } catch (_) { return false; }
  }

  function markGuideSeen(storage) {
    try {
      if (!storage || typeof storage.setItem !== 'function') return false;
      storage.setItem(SUBAGENT_GUIDE_KEY, '1');
      return true;
    } catch (_) { return false; }
  }

  // ── 兼容矩阵（纯）────────────────────────────────────────────────────────
  // 返回值永远是 { ok } 或 { ok:false, code, reason, short }。reason 是可以直接
  // 摆在界面上的一句长话（行里的黄色告警用），short 是同一条理由的短标签 ——
  // 行上那颗 CLI 小下拉只有一行的位置，长句会被截断成看不懂的半截话。
  const SHORT_REASON = Object.freeze({
    unsupported_cli: '不支持',
    unknown_protocol: '没有协议信息',
    native_line_needs_opencode: '仅 OpenCode',
    protocol_mismatch: '协议不符',
    needs_credentials: '需要 API key',
  });

  function cliLineVerdict(cli, line, label) {
    const who = clean(cli);
    const target = line || {};
    const name = typeof label === 'function' ? label : value => value;
    if (target.virtual && who.replace(/-exp$/, '') !== target.appType) return { ok: false,
      code: 'virtual_cli_mismatch', reason: `此虚拟组合仅支持 ${target.appType} CLI`, short: '仅限同 CLI' };
    if (!CLI_PROTOCOLS[who]) {
      return { ok: false, code: 'unsupported_cli', reason: `不支持的 CLI：${who || '（空）'}`,
        short: SHORT_REASON.unsupported_cli };
    }
    if (target.native) {
      return who === 'opencode'
        ? { ok: true }
        : { ok: false, code: 'native_line_needs_opencode', reason: 'OpenCode 自己的线路只能用 OpenCode 跑',
          short: SHORT_REASON.native_line_needs_opencode };
    }
    const protocol = protocolOf(target);
    if (!protocol) {
      return { ok: false, code: 'unknown_protocol', reason: '这条线路没有协议信息，用不了',
        short: SHORT_REASON.unknown_protocol };
    }
    const allows = CLI_PROTOCOLS[who];
    if (allows !== 'both' && allows !== protocol) {
      return { ok: false, code: 'protocol_mismatch',
        reason: `${name(who)} 跑不了 ${protocol === 'anthropic' ? 'Anthropic' : 'OpenAI Responses'} 协议的线路`,
        short: SHORT_REASON.protocol_mismatch };
    }
    if (CREDENTIAL_CLIS.includes(who) && !(target.hasToken === true && target.baseUrl)) {
      return { ok: false, code: 'needs_credentials', reason: `${name(who)} 需要 API key，这条用不了`,
        short: SHORT_REASON.needs_credentials };
    }
    return { ok: true };
  }

  // 不兼容的旧配置留在原位说明原因，保存时拦截。
  function rowIssue(row, line, label) {
    if (!row) return null;
    if (!line) return { code: 'missing_line', reason: '这条线路已经不在线路表里了' };
    const verdict = cliLineVerdict(row.cli, line, label);
    if (verdict.ok) return null;
    return { code: verdict.code, reason: `${verdict.reason} —— 换个 CLI 或移除这一行` };
  }

  // 能把某条线路跑起来的所有 CLI，附「能不能跑」和一句短理由 —— 行上那颗 CLI
  // 下拉置灰不兼容的选项，当前不可用的 CLI 仍保留并说明原因。
  function cliChoicesForLine(line, label, clis) {
    const list = Array.isArray(clis) && clis.length ? clis : AUTO_CLIS;
    return list.map(cli => {
      const verdict = cliLineVerdict(cli, line, label);
      return { cli, ok: verdict.ok, reason: verdict.reason || '', short: verdict.short || verdict.reason || '' };
    });
  }

  // ── 自动挑选：草稿 → 服务端线格式 ──────────────────────────────────────────
  function crossesTrust(candidates, providers) {
    const editor = scope() && scope().MultiCCAutoProviderEditor;
    if (editor && typeof editor.selectionCrossesTrust === 'function') {
      return editor.selectionCrossesTrust(candidates, providers);
    }
    const byId = new Map((Array.isArray(providers) ? providers : []).map(item => [String(item.id), item]));
    const domains = new Set();
    for (const candidate of Array.isArray(candidates) ? candidates : []) {
      const provider = byId.get(String(candidate && candidate.providerId));
      if (provider) domains.add(provider.isOfficial ? 'official' : 'user-managed');
    }
    return domains.size > 1;
  }

  function gatewayTable() {
    const editor = scope() && scope().MultiCCAutoProviderEditor;
    return (editor && editor.ROUTING_GATEWAY_INFO) || {};
  }

  function defaultKeyName(gateway) {
    const info = gatewayTable()[gateway];
    return (info && info.keyName) || 'jev-api-key';
  }

  function routingOf(draft) {
    const source = (draft && draft.routing) || {};
    const editor = scope() && scope().MultiCCAutoProviderEditor;
    const gateway = (editor && typeof editor.routingGatewayOf === 'function'
      ? editor.routingGatewayOf(source.gateway)
      : clean(source.gateway)) || 'vercel';
    return {
      gateway,
      endpoint: clean(source.endpoint),
      model: clean(source.model),
      apiKeyName: clean(source.apiKeyName) || defaultKeyName(gateway),
    };
  }

  // 草稿 → providerSelection。返回 Result 形状，dialog 拿 ok 决定能不能保存。
  function buildAutoSelection(draft = {}) {
    const rows = [];
    for (const row of Array.isArray(draft.rows) ? draft.rows : []) {
      if (!row || row.enabled === false) continue;
      if (!clean(row.providerId)) continue;
      rows.push(row);
    }
    if (rows.length < 2) {
      return fail('自动挑选至少要两条线路（现在只有 1 条能用的）。', 'insufficient_candidates');
    }
    const difficulty = draft.pick === PICK_DIFFICULTY;
    const manual = difficulty && draft.tiering !== 'price';
    const candidates = [];
    for (const row of rows) {
      const cli = clean(row.cli);
      if (!cli) return fail('每一行都要有一个 CLI。', 'invalid_provider_candidate');
      const candidate = { providerId: clean(row.providerId), cli };
      const model = clean(row.model);
      // 「自动（Jev 挑）」只在按难度下存在：按顺序没有 Jev，就只有具体模型。
      if (difficulty && row.autoModel === true) candidate.autoModel = true;
      else if (model) candidate.model = model;
      if (manual) {
        const tier = TIERS.find(value => value === row.tier) || null;
        if (!tier) return fail('「我自己标」时，每行都要标一个档位。', 'provider_routing_requires_tiers');
        candidate._tier = tier;
      }
      candidate.priority = candidates.length + 1;
      candidate.enabled = true;
      candidates.push(candidate);
    }
    let tiers = [];
    if (manual) {
      const used = TIERS.filter(tier => candidates.some(candidate => candidate._tier === tier));
      if (used.length < 2) {
        return fail('至少要给两条线路分到不同的档位。', 'provider_routing_requires_tiers');
      }
      tiers = used.map(tier => TIER_KEYS[tier]);
      for (const candidate of candidates) {
        candidate.tier = TIER_KEYS[candidate._tier];
        delete candidate._tier;
      }
    }
    for (const candidate of candidates) delete candidate._tier;
    const providers = Array.isArray(draft.providers) ? draft.providers : [];
    const requested = Number(draft.maxAttempts) || MIN_ATTEMPTS;
    const selection = {
      version: 1,
      mode: 'auto',
      candidates,
      maxAttempts: Math.max(MIN_ATTEMPTS, Math.min(MAX_ATTEMPTS, candidates.length, requested)),
      sticky: draft.sticky !== false,
      // 混用官方账号与别人配的线路是允许的，默认就这样跑：跨信任域时一律带上
      // allowCrossTrust（服务端只有在它为 true 时才放行跨信任池）。
      allowCrossTrust: crossesTrust(candidates, providers),
      cliSwitch: difficulty ? 'routing' : 'failover',
    };
    if (difficulty) {
      const routing = routingOf(draft);
      selection.routing = {
        version: 1,
        provider: 'jev',
        gateway: routing.gateway,
        apiKeyName: routing.apiKeyName,
        ...(routing.endpoint ? { endpoint: routing.endpoint } : {}),
        ...(routing.model ? { model: routing.model } : {}),
        ...(manual ? { tiers } : { tiering: 'price' }),
      };
    }
    return ok(selection);
  }

  // 固定一条：provider + model 两个字段（providerSelection 归 null）。
  // 原生 OpenCode 线路保存成 provider 空 + `<id>/<model>` 模型，和服务端一致。
  function buildFixedPatch(draft = {}) {
    const value = clean(draft.providerId);
    const cli = clean(draft.cli);
    let model = clean(draft.model);
    let provider = null;
    if (isNativeLine(value)) {
      if (cli !== 'opencode') return fail('OpenCode 自己的线路只能用 OpenCode 跑。', 'provider_cli_mismatch');
      const id = nativeLineId(value);
      const chosen = model || clean(draft.nativeDefaultModel);
      if (!chosen) return fail('挑一条 OpenCode 的线路和它的模型。', 'invalid_provider_candidate');
      model = chosen.startsWith(`${id}/`) ? chosen : `${id}/${chosen}`;
    } else {
      provider = value || null;
    }
    return ok({
      provider,
      providerSelection: null,
      model: model || null,
      effort: cli ? clean(draft.effort) || null : null,
    });
  }

  // ── 胶囊 ─────────────────────────────────────────────────────────────────
  // 输入是会话配置的两份：current = 正在跑的那份，next = 把 pendingConfiguration
  // 折进来之后的那份。pending 只影响颜色与那句「下一轮生效」。
  function pillModel(input = {}) {
    const next = input.next || input.current || {};
    const current = input.current || {};
    const selection = next.providerSelection;
    const auto = !!(selection && selection.mode === 'auto');
    const catalog = scope() && scope().MultiCCProviderCatalog;
    const cliLabel = cli => (catalog && catalog.cliDisplayName ? catalog.cliDisplayName(cli) : clean(cli));
    const mark = cli => (catalog && catalog.cliShortMark ? catalog.cliShortMark(cli) : clean(cli).slice(0, 2).toUpperCase());
    const pending = input.pending === true;
    // 「下一轮生效」这句由调用方给（air.js 有 i18n 键 airTaskAiPending），缺了就用中文默认。
    const pendingLabel = clean(input.pendingLabel) || '下一轮生效';
    const native = (catalog && catalog.nativeRouteLabel ? catalog.nativeRouteLabel(next.cli) : '')
      || openCodeRouteName(next.cli, next.provider, next.model);
    if (auto) {
      const pickLabel = selection.cliSwitch === 'routing' ? PICK_DIFFICULTY : PICK_ORDER;
      const count = (selection.candidates || []).filter(candidate => candidate && candidate.enabled !== false).length;
      const currentAuto = current.providerSelection && current.providerSelection.mode === 'auto';
      const route = currentAuto ? '' : clean(input.currentRoute);
      const model = currentAuto ? '' : clean(input.currentModel);
      return {
        tone: 'auto',
        pending,
        mark: '⚡',
        text: [currentRouteLabel(pickLabel, count, matchPresetName(selection)), pending ? pendingLabel : ''].filter(Boolean).join(' · '),
        turn: route || model ? [route || (catalog && catalog.nativeRouteLabel ? catalog.nativeRouteLabel(current.cli) : ''), model].filter(Boolean).join(' · ') : '',
      };
    }
    const route = native || clean(input.currentRoute) || clean(next.routeName);
    return {
      tone: 'fixed',
      pending,
      mark: mark(next.cli),
      text: [laneRoute(cliLabel, next.cli, route), clean(next.model), pending ? pendingLabel : ''].filter(Boolean).join(' · '),
      turn: '',
    };
  }

  function currentRouteLabel(pick, count, presetName) {
    const pickLabel = pick === PICK_DIFFICULTY ? '按难度' : '按顺序';
    return `⚡ 自动 · ${presetName ? `${presetName} · ` : ''}${pickLabel} · ${count} 条`;
  }

  // 会话里只存线路池本身，不存「它来自哪个预设」。胶囊上要写预设名，就拿本机预设
  // 逐个比对：线路（CLI + 线路 id + 模型）按优先级顺序完全一致才算同一个预设。
  // 没有预设、读不到 localStorage、或有人改过池子 —— 都返回空串，胶囊照旧。
  function candidateKey(list) {
    return (Array.isArray(list) ? list : [])
      .filter(item => item && item.enabled !== false)
      .slice().sort((a, b) => (Number(a.priority) || 0) - (Number(b.priority) || 0))
      .map(item => `${clean(item.cli)}\n${clean(item.providerId)}\n${clean(item.model)}\n${item.autoModel ? 'auto' : ''}`)
      .join('\u0001');
  }

  function matchPresetName(selection) {
    try {
      const storage = scope() && scope().localStorage;
      if (!storage || !selection) return '';
      const raw = JSON.parse(storage.getItem(PRESET_KEY) || '[]');
      const key = candidateKey(selection.candidates);
      if (!key || !Array.isArray(raw)) return '';
      const hit = raw.find(item => item && !item.recent && clean(item.name) && candidateKey(item.candidates) === key);
      return hit ? clean(hit.name) : '';
    } catch (_) { return ''; }
  }

  // 单行文案里的「车道 + 线路」两段：自持账号的车道路由名就是它的产品名，只说一遍。
  function laneRoute(cliLabel, cli, route) {
    const name = cliLabel(cli);
    return route && route !== name ? `${name} · ${route}` : name;
  }

  // 把 pillModel 的结果拼成一行文字（含「本轮 …」那段）。测试与旧调用点都用它。
  function pillText(model) {
    if (!model) return '';
    const head = model.tone === 'auto'
      ? [model.text, model.turn ? `本轮 ${model.turn}` : ''].filter(Boolean).join(' ｜')
      : model.text;
    return head;
  }

  // ── DOM 小工具 ───────────────────────────────────────────────────────────
  // 文案走 t()（i18n.js），缺键就回落到中文默认值 —— 和 auto-provider-editor.js
  // 的 tt() 同一种写法，新增的键不需要先进目录才能用。
  function tt(key, fallback, params) {
    const api = scope();
    const out = api && typeof api.t === 'function' ? api.t(key, params) : '';
    if (out && out !== key) return out;
    // 词典里没有这个键时用中文兜底 —— 兜底串自己的 {name} 得在这儿替换掉，
    // 不然界面上会直接印出 `{name} 条线路`。
    if (!params) return fallback;
    return String(fallback).replace(/\{(\w+)\}/g, (match, name) => (
      Object.prototype.hasOwnProperty.call(params, name) ? params[name] : match));
  }

  const { el, show, option, segment, segButton } = (typeof module === 'object' && module.exports ? require('./provider-catalog') : scope().MultiCCProviderCatalog).dom;

  function mark(doc, cli, extra) {
    const catalog = scope() && scope().MultiCCProviderCatalog;
    const short = catalog && catalog.cliShortMark ? catalog.cliShortMark(cli) : clean(cli).slice(0, 2).toUpperCase();
    const badge = el(doc, 'span', `air-cli-mark rc-mark${extra ? ` ${extra}` : ''}`, short);
    badge.dataset.cli = clean(cli);
    return badge;
  }

  function cliLabel(cli) {
    const catalog = scope() && scope().MultiCCProviderCatalog;
    return catalog && catalog.cliDisplayName ? catalog.cliDisplayName(cli) : clean(cli);
  }

  // Only the product name belongs in runtime configuration. Legacy IDs remain
  // readable, but execution engines are an internal compatibility detail.
  function cliChoiceLabel(cli) {
    return cliLabel(cli);
  }

  function chatChoiceCli(cli) {
    return cli === 'claude' ? 'claude-exp' : cli === 'codex' ? 'codex-exp' : cli;
  }

  function request(url, body, method = 'POST') {
    const options = { method, headers: { Accept: 'application/json' } };
    if (body !== undefined) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    return fetch(url, options).then(response => response.text().then(raw => {
      let result = {};
      try { result = raw ? JSON.parse(raw) : {}; } catch (_) { result = {}; }
      if (!response.ok || result.ok === false) {
        // 大多数调用方只读 message；子 agent 同步要认出 503（服务端还没重启到
        // 带这个接口的原生模块），所以把状态码与错误码一并挂在 Error 上，其余
        // 行为一个字没变。
        const failure = new Error(result.message || result.error || result.code || `请求失败（${response.status}）`);
        failure.status = response.status;
        failure.code = result.code || null;
        throw failure;
      }
      return result;
    }));
  }

  // ── Jev 面板（按难度才有）─────────────────────────────────────────────────
  // 网关 / key / 测试这套逻辑和 auto-provider-editor.js 是同一份契约：key 只经
  // 宿主传进来的 routingKey（chat-ai-config 的 routingKeyApi）写进本机保险箱，
  // 明文永远不进配置、不发给模型。网关表与错误码都取自那个模块。
  function jevPanel(doc, options) {
    const editor = scope() && scope().MultiCCAutoProviderEditor;
    const gateways = (editor && editor.ROUTING_GATEWAYS) || ['vercel', 'openrouter', 'typesafe', 'custom'];
    const infoTable = (editor && editor.ROUTING_GATEWAY_INFO) || {};
    const customGateway = (editor && editor.CUSTOM_ROUTING_GATEWAY) || 'custom';
    const customModel = (editor && editor.CUSTOM_ROUTING_MODEL) || 'jev-latest';
    const routingKey = options.routingKey || null;

    const box = el(doc, 'div', 'rc-jev');
    const line = el(doc, 'div', 'rc-jev-line');
    const dot = el(doc, 'span', 'rc-dot');
    const status = el(doc, 'b', 'rc-jev-status');
    const detail = el(doc, 'span', 'rc-jev-detail');
    const actions = el(doc, 'span', 'rc-jev-actions');
    const testButton = el(doc, 'button', 'rc-link rc-jev-test', tt('runConfigJevTest', '测试'));
    const changeButton = el(doc, 'button', 'rc-link rc-jev-change', tt('runConfigJevChange', '更换'));
    testButton.type = 'button'; changeButton.type = 'button';
    actions.append(testButton, changeButton);
    line.append(dot, status, detail, actions);

    const form = el(doc, 'div', 'rc-jev-form');
    const gatewayRow = el(doc, 'div', 'rc-field');
    gatewayRow.append(el(doc, 'span', null, tt('runConfigJevGateway', '网关')));
    const gatewaySeg = segment(doc, 'rc-jev-gateways', tt('runConfigJevGateway', '网关'));
    const gatewayButtons = new Map();
    for (const name of gateways) {
      gatewayButtons.set(name, segButton(doc, gatewaySeg, `rc-gw-${name}`, routingGatewayLabel(name)));
    }
    gatewayRow.append(gatewaySeg);

    const endpointField = el(doc, 'label', 'rc-field');
    endpointField.append(el(doc, 'span', null, tt('runConfigJevEndpoint', '接口地址')));
    const endpointInput = el(doc, 'input');
    endpointInput.type = 'url'; endpointInput.placeholder = 'https://…';
    endpointField.append(endpointInput);

    const modelField = el(doc, 'label', 'rc-field');
    modelField.append(el(doc, 'span', null, tt('runConfigJevModel', '模型名')));
    const modelInput = el(doc, 'input');
    modelInput.placeholder = customModel;
    modelField.append(modelInput);

    const keyField = el(doc, 'label', 'rc-field');
    keyField.append(el(doc, 'span', null, tt('runConfigJevKey', 'Jev key')));
    const keyInput = el(doc, 'input');
    keyInput.type = 'password'; keyInput.autocomplete = 'off';
    keyField.append(keyInput);

    const keyHelp = el(doc, 'p', 'rc-fine');
    const result = el(doc, 'p', 'rc-jev-result');
    const keyActions = el(doc, 'div', 'rc-jev-key-actions');
    const keySave = el(doc, 'button', 'primary rc-jev-key-save', tt('runConfigJevSaveTest', '保存并测试'));
    keySave.type = 'button';
    keyActions.append(keySave);
    form.append(gatewayRow, endpointField, modelField, keyField, keyActions, keyHelp, result);

    let gateway = 'vercel';
    let keyState = 'unknown';
    let formOpen = false;
    let generation = 0;

    function gatewayName() {
      return gateway;
    }

    function keyName() {
      const info = infoTable[gateway];
      return (info && info.keyName) || `${gateway}-jev-key`;
    }

    function setChecked() {
      for (const [name, node] of gatewayButtons) node.setAttribute('aria-checked', String(name === gateway));
      const custom = gateway === customGateway;
      show(endpointField, custom);
      show(modelField, custom);
      for (const gw of gateways) {
        const info = infoTable[gw] || {};
        const button = gatewayButtons.get(gw);
        if (button && info.label) button.textContent = info.label;
      }
    }

    function setResult(text, tone) {
      result.textContent = text || '';
      result.classList.remove('good', 'bad');
      if (tone) result.classList.add(tone);
      show(result, !!text);
    }

    function render() {
      box.classList.remove('ok', 'missing');
      const canSave = !!routingKey && typeof routingKey.save === 'function';
      const canTest = !!routingKey && typeof routingKey.test === 'function';
      const present = keyState === 'present';
      if (!routingKey) {
        status.textContent = tt('runConfigJevUnavailable', 'Jev 判断难度');
        detail.textContent = tt('runConfigJevVaultOnly', 'key 从本机保险箱条目「{name}」读取。', { name: keyName() });
      } else if (keyState === 'checking' || keyState === 'unknown') {
        status.textContent = tt('runConfigJevChecking', '正在检查 Jev key…');
        detail.textContent = '';
      } else if (present) {
        box.classList.add('ok');
        status.textContent = tt('runConfigJevReady', 'Jev 已就绪');
        detail.textContent = ` · ${routingGatewayLabel(gateway)}`;
      } else {
        box.classList.add('missing');
        status.textContent = tt('runConfigJevMissing', '先配置 Jev');
        detail.textContent = keyState === 'error'
          ? tt('runConfigJevCheckFailed', ' · 查不到 key 状态，可直接重新粘贴保存')
          : tt('runConfigJevKeyMissingDetail', ' · 它负责判断每条消息是简单还是复杂');
      }
      const formVisible = canSave && (formOpen || keyState === 'missing' || keyState === 'error');
      show(form, formVisible);
      show(changeButton, canSave && present);
      show(testButton, canTest && present);
      keyHelp.textContent = tt('runConfigJevKeyHelp', 'key 只存进本机保险箱（条目 {name}），不写进配置、不发给模型。', { name: keyName() });
      keyInput.placeholder = (infoTable[gateway] && infoTable[gateway].placeholder) || 'sk-…';
    }

    function check() {
      if (!routingKey || typeof routingKey.check !== 'function') return Promise.resolve();
      const current = ++generation;
      keyState = 'checking'; render();
      return Promise.resolve().then(() => routingKey.check(keyName())).then(present => {
        if (current !== generation) return;
        keyState = present ? 'present' : 'missing';
        render();
      }, () => {
        if (current !== generation) return;
        keyState = 'error'; render();
      });
    }

    function testRequest() {
      return {
        apiKeyName: keyName(),
        gateway,
        ...(gateway === customGateway ? {
          endpoint: endpointInput.value.trim(),
          model: modelInput.value.trim(),
        } : {}),
      };
    }

    function describeFailure(body) {
      const code = String((body && body.code) || '');
      const httpStatus = Number(body && body.status) || 0;
      if (code === 'jev_key_missing') return tt('runConfigJevErrKeyMissing', '保险箱里没有这个 key，请先粘贴保存。');
      if (httpStatus === 401 || httpStatus === 403) return tt('runConfigJevErrKeyInvalid', 'key 无效或没有权限，请检查后更换。');
      if (code === 'jev_timeout') return tt('runConfigJevErrTimeout', 'Jev 超时没有回应，稍后再试。');
      if (code === 'jev_network') return tt('runConfigJevErrNetwork', '连不上网关，检查网络或代理。');
      if (code === 'test_unavailable') return tt('runConfigJevErrUnavailable', '服务端还没有测试接口：重启 multicc 后再试。');
      const detail = body && body.detail ? ` · ${String(body.detail).slice(0, 160)}` : '';
      return tt('runConfigJevErrOther', '测试失败：{code}', { code: code || 'unknown' }) + detail;
    }

    function runTest() {
      if (!routingKey || typeof routingKey.test !== 'function') return Promise.resolve();
      const current = generation;
      const body = testRequest();
      const sample = tt('runConfigJevSample', '把 README 里的一个错别字改掉');
      testButton.disabled = true;
      setResult(tt('runConfigJevTesting', '正在请 Jev 判断…'), '');
      return Promise.resolve().then(() => routingKey.test({ ...body, text: sample })).then(outcome => {
        if (current !== generation) return;
        if (outcome && outcome.ok) {
          setResult(tt('runConfigJevTestOk', '✓ 连通了（{ms} ms）', { ms: Math.round(Number(outcome.latencyMs) || 0) }), 'good');
          return;
        }
        if (outcome && outcome.code === 'jev_key_missing') keyState = 'missing';
        if (outcome && (outcome.status === 401 || outcome.status === 403)) formOpen = true;
        render();
        setResult(describeFailure(outcome), 'bad');
      }, error => {
        if (current !== generation) return;
        setResult(describeFailure({ code: 'request_failed', detail: error && error.message }), 'bad');
      }).finally(() => { testButton.disabled = false; });
    }

    function saveKey() {
      if (!routingKey || typeof routingKey.save !== 'function') return Promise.resolve();
      const value = keyInput.value.trim();
      keyInput.value = '';
      if (!value) { setResult(tt('runConfigJevKeyEmpty', '先把 key 粘贴到输入框里。'), 'bad'); return Promise.resolve(); }
      const current = ++generation;
      const name = keyName();
      const target = gateway;
      keySave.disabled = true;
      setResult(tt('runConfigJevKeySaving', '正在保存…'), '');
      return Promise.resolve().then(() => routingKey.save(name, value, { gateway: target })).then(() => {
        if (current !== generation) return null;
        keyState = 'present';
        formOpen = false;
        setResult('', '');
        render();
        return runTest();
      }, error => {
        if (current !== generation) return;
        setResult(tt('runConfigJevKeySaveFailed', '保存失败：{reason}', { reason: (error && error.message) || '' }), 'bad');
      }).finally(() => { keySave.disabled = false; });
    }

    for (const [name, button] of gatewayButtons) {
      button.onclick = () => {
        if (name === gateway) return;
        gateway = name;
        formOpen = false;
        keyInput.value = '';
        keyState = 'unknown';
        setResult('', '');
        setChecked();
        check();
        options.onChange?.();
      };
    }
    changeButton.onclick = () => { formOpen = !formOpen; render(); if (formOpen) keyInput.focus(); };
    testButton.onclick = () => runTest();
    keySave.onclick = () => saveKey();
    keyInput.addEventListener('keydown', event => { if (event.key === 'Enter') saveKey(); });

    setChecked();
    check();
    box.append(line, form);
    return {
      element: box,
      read() {
        return {
          gateway,
          endpoint: endpointInput.value.trim(),
          model: modelInput.value.trim(),
          apiKeyName: keyName(),
        };
      },
      ready: () => keyState === 'present',
    };
  }

  function routingGatewayLabel(name) {
    const editor = scope() && scope().MultiCCAutoProviderEditor;
    if (editor && typeof editor.routingGatewayLabel === 'function') return editor.routingGatewayLabel(name);
    return clean(name);
  }

  // ── 对话框 ───────────────────────────────────────────────────────────────
  function open(entry, clis, onSaved) {
    const doc = typeof document !== 'undefined' ? document : null;
    const catalogApi = scope() && scope().MultiCCProviderCatalog;
    const aiApi = scope() && scope().MultiCCChatAiConfig;
    const editorApi = scope() && scope().MultiCCAutoProviderEditor;
    if (!doc || !catalogApi || !aiApi) throw new Error(tt('runConfigComponentsMissing', '运行配置组件没有加载。'));

    const draft = !entry.sessionId;
    const terminalDraft = draft && entry.purpose === 'terminal';
    const stored = entry.configuration || {};
    const pending = stored.pendingConfiguration;
    const config = pending
      ? { ...stored, ...(pending.profile || {}), cli: pending.cli || stored.cli }
      : stored;
    const laneKind = terminalDraft ? 'terminal' : 'chat';
    const offersIn = cli => (catalogApi.cliOffersIn ? catalogApi.cliOffersIn(cli, laneKind) : true);
    const providerless = cli => (catalogApi.cliProviderless ? catalogApi.cliProviderless(cli) : false);
    const cliList = [...new Set([config.cli, ...(Array.isArray(clis) ? clis : [])].filter(Boolean))]
      .filter(cli => cli === config.cli || offersIn(cli));

    // ── 状态 ────────────────────────────────────────────────────────────────
    let mode = MODE_FIXED;
    let currentCli = config.cli || cliList[0] || (terminalDraft ? 'claude' : 'claude-exp');
    let providers = [];
    let providerValue = '';
    let modelValue = clean(config.model);
    let effortValue = null;
    let pick = PICK_ORDER;
    let tiering = DEFAULT_TIERING;
    let rows = [];
    let maxAttempts = MIN_ATTEMPTS;
    let sticky = true;
    let activePresetId = '';
    let jev = null;
    let loading = false;
    let epoch = 0;
    const catalogs = new Map();
    const catalogErrors = new Map();
    let modelWatchKey = '';
    let stopModelWatch = null;
    let modelCatalogStatus = null;
    let closed = false;
    let pendingNative = '';
    let pickerOpen = false;
    let pickerFilter = "";
    let pickerData = null;
    let pickerListHost = null;
    // 子任务（高级块）的草稿：config.subagent 是打开时读到的已存值，套用预设会把它
    // 换成预设里的那份。renderSub 只在「主 CLI + 种子」变化时重铺下拉，其余时候保留
    // 界面上的改动（拖排序、换主线路不该把子任务选择打回去）。
    let subagentSeed = config.subagent && typeof config.subagent === 'object' ? config.subagent : null;
    // 子 agent 默认（家族级，服务端存）：来自目录的 defaults.subagent，同步成功后
    // 用响应里的那份覆盖。subDefaultsSynced = 已经拿到比目录更新的服务端结果。
    let subDefaults = { claude: null, codex: null };
    let subDefaultsSynced = false;
    let subFamilyCatalogPending = false;
    // 用户在这一次打开里动过子 agent 下拉（草稿模式下别再拿默认值盖回去）。
    let subagentTouched = false;
    // 当前的 subagentSeed 是不是跟着「家族全局默认」走的：草稿里自动铺的，或打开时读到的
    // 线路本身带 inherited。换家族时可以整份替换；原样保存仍算跟随全局（服务端保留标记）。
    let subagentSeedAuto = !!(subagentSeed && (subagentSeed.inherited === true || config.subagentInherited === true));
    let subagentSeedFamily = subagentSeed ? subagentFamily(config.cli || currentCli) : '';
    // 已有会话在对话框里换过 CLI（可能换了子 agent 家族）：只有这时才按新家族
    // 默认回填；单纯打开对话框（CLI 没动）保持原样。
    let cliSwitched = false;
    // 首次强提示：读过一次 localStorage 就记住；本次打开内 dismissed 也是终态。
    let subGuideSeenOnOpen = guideSeen(scope() && scope().localStorage);
    let subGuideShown = false;
    let subGuideDismissed = false;
    // 同步预览（dry run）的状态机：loading / ready / error / unavailable。
    let subPreview = null;
    let subPreviewSeq = 0;
    let subPreviewTimer = null;
    let subPreviewKey = '';
    // 任务本身已经保存、只剩同步没成功：再次提交只重试同步（见 save()）。
    let savedPending = false;
    // 503 = 服务端加载的原生模块里还没有同步接口：同步与清除都锁上，只说原因。
    let subSyncUnavailable = false;
    // 清除全局默认：subClearPlan 是等用户确认的 dry run；subNotice 是最近一次结果 {tone, text}。
    let subClearPlan = null;
    let subClearBusy = false;
    let subNotice = null;
    // 账户：accountPicks 是「车道 → 账户 id」，打开时从会话现值读（运行配置的几个入口
    // 都不带这个字段，所以已有会话要自己拉一次详情）。保存只写用户动过的那条车道 ——
    // 服务端按车道合并，读不到现值时也不会把别处选好的账户清掉。
    let accountPicks = { ...(config.cliAccounts || {}) };
    let accountPicksReady = !entry.sessionId || config.cliAccounts !== undefined;
    const accountTouched = new Set();
    const accountLists = new Map(); // cli → 账户数组 | null（加载中）| Error
    let accountVanished = '';
    let commandcodeLogin;
    let commandcodeLoginLoading = false;

    function loadCatalog(cli) {
      if (catalogs.has(cli)) return Promise.resolve(catalogs.get(cli));
      if (catalogErrors.has(cli)) return Promise.reject(catalogErrors.get(cli));
      return request(`/api/providers?cli=${encodeURIComponent(cli)}`, undefined, 'GET').then(raw => {
        const catalog = catalogApi.normalizeCatalog(raw);
        catalogs.set(cli, catalog);
        absorbCatalogDefaults(catalog);
        return catalog;
      }, error => { catalogErrors.set(cli, error); throw error; });
    }

    function providersOf(cli) {
      const catalog = catalogs.get(cli);
      return catalog ? catalogApi.providersForCli(catalog, cli) : [];
    }

    function providerById(cli, id) {
      return providersOf(cli).find(item => String(item.id) === String(id)) || null;
    }

    function providerName(provider) {
      if (!provider) return '';
      return `${provider.name || provider.id}${provider.model ? ` · ${provider.model}` : ''}${limitSuffix(provider)}`;
    }

    // 线路有余量缓存（/api/providers 带回的 provider.limit）就把余量挂在选项后面，
    // 让用户挑线路时看得见还剩多少；没有缓存时返回空串，选项和以前一字不差。
    // 文案全由服务端的 bar + QuotaBarView 决定，这里不写任何余量措辞。
    function limitTranslate(key, params) {
      const api = scope();
      return api && typeof api.t === 'function' ? api.t(key, params) : key;
    }

    function limitSuffix(provider) {
      return aiApi && typeof aiApi.providerLimitLabel === 'function'
        ? aiApi.providerLimitLabel(provider, limitTranslate, Date.now())
        : '';
    }

    // 给真 DOM（Auto 池行、添加线路列表）用：带颜色的余量徽标，没数据返回 null。
    function limitBadge(provider) {
      const view = scope() && scope().QuotaBarView;
      if (!provider || !provider.limit || !view) return null;
      const resolved = view.resolveProviderLimit(provider.limit, {
        now: Date.now(),
        translate: (key, params, fallback) => {
          const translated = limitTranslate(key, params);
          return translated && translated !== key ? translated : fallback;
        },
        rolled: limitTranslate('quotaRolledWindow'),
      });
      if (!resolved || !resolved.text) return null;
      const badge = el(doc, 'span', 'rc-limit', resolved.text);
      badge.style.color = resolved.color;
      if (resolved.title) badge.title = resolved.title;
      return badge;
    }

    function modelState(cli, list) {
      const catalog = catalogs.get(cli);
      return {
        cli,
        providers: list || providersOf(cli),
        defaults: (catalog && catalog.defaults) || {},
        translate: key => ({ default: tt('runConfigModelDefault', '线路默认'), custom: tt('runConfigModelCustom', '自定义…') })[key] || key,
      };
    }

    function lineName(row) {
      const saved = row.name;
      if (isNativeLine(row.providerId)) return saved || nativeLabelOf(nativeLineId(row.providerId));
      const provider = providerById(row.cli, row.providerId);
      return provider ? (provider.name || provider.id) : (saved || row.providerId);
    }

    function nativeLabelOf(id) {
      const list = aiApi.openCodeNativeProviders();
      const found = list.find(item => item.value === nativeLineValue(id));
      return found ? found.label.replace(/^OpenCode 原生 · /, '') : id;
    }

    function rowLine(row) {
      if (isNativeLine(row.providerId)) return lineShape(row.providerId);
      const provider = providerById(row.cli, row.providerId);
      return provider ? lineShape(row.providerId, provider) : null;
    }

    function allProviders() {
      const out = [];
      // 每份目录都收一遍 `.providers`（`providersForCli(list, '')` 恒空 —— 空 CLI 不在
      // 任何 compatibleClis 里），跨信任判定要的就是这堆 provider 的 isOfficial。
      for (const list of catalogs.values()) {
        out.push(...((list && Array.isArray(list.providers)) ? list.providers : []));
      }
      const seen = new Set();
      return out.filter(item => {
        if (!item || seen.has(String(item.id))) return false;
        seen.add(String(item.id));
        return true;
      });
    }

    // ── 会话初始状态 ─────────────────────────────────────────────────────────
    function initialRows() {
      const selection = config.providerSelection;
      if (!selection || selection.mode !== 'auto') return [];
      return (selection.candidates || []).filter(Boolean).map(candidate => ({
        providerId: String(candidate.providerId || ''),
        cli: candidate.cli ? String(candidate.cli) : (isNativeLine(candidate.providerId) ? 'opencode' : currentCli),
        model: candidate.model ? String(candidate.model) : '',
        customModel: '',
        autoModel: candidate.autoModel === true,
        tier: candidate.tier === 't1' ? 'simple' : candidate.tier === 't2' ? 'medium' : candidate.tier === 't3' ? 'complex' : 'medium',
        name: '',
        enabled: candidate.enabled !== false,
      }));
    }

    function initialPick() {
      const selection = config.providerSelection;
      return selection && selection.mode === 'auto' && selection.cliSwitch === 'routing' ? PICK_DIFFICULTY : PICK_ORDER;
    }

    function initialTiering() {
      const selection = config.providerSelection;
      if (selection && selection.mode === 'auto' && selection.routing) {
        return selection.routing.tiering === 'price' ? PRICE_TIERING : DEFAULT_TIERING;
      }
      return DEFAULT_TIERING;
    }

    // ── 骨架 ────────────────────────────────────────────────────────────────
    const dialog = el(doc, 'dialog', 'air-config-dialog rc-dialog');
    const form = el(doc, 'form', 'air-config-form');
    const head = el(doc, 'header', 'air-config-head');
    const heading = el(doc, 'div');
    heading.append(
      el(doc, 'span', 'eyebrow', terminalDraft ? 'TERMINAL ROUTING' : 'TASK ROUTING'),
      el(doc, 'h2', null, tt('runConfigTitle', '运行配置')),
    );
    const close = el(doc, 'button', 'air-config-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', tt('runConfigClose', '关闭'));
    close.onclick = () => dialog.close();
    head.append(heading, close);
    form.append(head, el(doc, 'p', 'air-config-intro',
      draft
        ? tt('runConfigIntroDraft', '新任务用哪条线路跑：先挑 CLI，再挑线路和模型。')
        : tt('runConfigIntroTask', '这个任务用哪条线路跑：改完保存，下一轮生效。')));

    // 模式段
    const modeHost = el(doc, 'section', 'air-config-section rc-mode-host');
    const modeSeg = segment(doc, 'rc-modes', tt('runConfigModeLabel', '运行方式'));
    const fixedButton = segButton(doc, modeSeg, 'rc-mode-fixed', tt('runConfigModeFixed', '固定一条'));
    const autoButton = segButton(doc, modeSeg, 'rc-mode-auto', tt('runConfigModeAuto', '自动挑选'));
    modeHost.append(modeSeg);
    form.append(modeHost);

    // 固定一条
    const fixedSection = el(doc, 'section', 'air-config-section rc-fixed');
    const fixedHead = el(doc, 'div', 'air-config-section-head');
    fixedHead.append(el(doc, 'h3', null, 'CLI'), el(doc, 'p', null,
      draft ? tt('runConfigCliNoteDraft', '创建后生效') : tt('runConfigCliNote', '下一轮生效')));
    const cliGrid = el(doc, 'div', 'air-cli-grid');
    cliGrid.setAttribute('role', 'radiogroup');
    cliGrid.setAttribute('aria-label', 'CLI');
    const lineRow = el(doc, 'div', 'rc-two');
    const lineField = el(doc, 'label', 'rc-field rc-line-field');
    lineField.append(el(doc, 'span', null, tt('runConfigLineLabel', '线路')));
    const lineSelect = el(doc, 'select', 'rc-line');
    lineSelect.setAttribute('aria-label', tt('runConfigLineLabel', '线路'));
    const lineNote = el(doc, 'p', 'rc-note');
    lineField.append(lineSelect, lineNote);
    function manageButton() {
      const control = el(doc, 'button', 'rc-manage-providers', '找不到线路？添加 / 管理 Provider');
      control.type = 'button';
      control.onclick = async () => {
        await catalogApi.openManager();
        if (closed) return;
        catalogs.clear(); catalogErrors.clear(); pickerData = null;
        try {
          await loadCatalog(currentCli);
          providers = providersOf(currentCli);
          renderFixed(); renderSub(); renderPool(); renderFooter();
          if (pickerOpen) await renderPicker();
        } catch (_) { error.textContent = '刷新线路失败，请重新打开配置后重试'; }
      };
      return control;
    }
    lineField.append(manageButton());
    const modelField = el(doc, 'label', 'rc-field rc-model-field');
    // 标题行带「刷新模型」：opencode 的模型 id 跟着上游走，面板再打开时列表可能
    // 还是上次缓存里的旧 id（含已被下架的）。这个按钮跳过服务端与浏览器两层缓存。
    const modelHead = el(doc, 'div', 'rc-field-head');
    const modelRefresh = el(doc, 'button', 'rc-model-refresh', tt('runConfigModelRefresh', '刷新模型'));
    modelRefresh.type = 'button';
    modelRefresh.title = tt('runConfigModelRefreshHint', '重新读取本机 opencode 的模型列表');
    show(modelRefresh, false);
    modelHead.append(el(doc, 'span', null, tt('runConfigModelLabel', '模型')), modelRefresh);
    modelField.append(modelHead);
    const modelSelect = el(doc, 'select', 'rc-model');
    modelSelect.setAttribute('aria-label', tt('runConfigModelLabel', '模型'));
    const modelCustom = el(doc, 'input', 'rc-model-custom');
    modelCustom.maxLength = 100;
    modelCustom.placeholder = tt('runConfigModelPlaceholder', '自定义模型…');
    // 目录很长（Command Code 94 个）时才出现的过滤框：只过滤下拉里的选项，
    // 不碰当前选中的值。
    const modelSearch = el(doc, 'input', 'rc-model-search');
    modelSearch.type = 'search';
    modelSearch.hidden = true;
    modelSearch.placeholder = tt('runConfigModelSearch', '搜索模型…');
    modelSearch.setAttribute('aria-label', tt('runConfigModelSearch', '搜索模型…'));
    const modelStatus = el(doc, 'span', 'rc-model-status');
    modelStatus.setAttribute('role', 'status');
    modelStatus.hidden = true;
    modelField.append(modelSearch, modelSelect, modelCustom, modelStatus);
    lineRow.append(lineField, modelField);
    const accountField = el(doc, 'div', 'rc-field rc-account-field');
    accountField.append(el(doc, 'span', null, tt('runConfigAccountLabel', '账户')));
    const accountRow = el(doc, 'div', 'rc-account-row');
    const accountSelect = el(doc, 'select', 'rc-account');
    accountSelect.setAttribute('aria-label', tt('runConfigAccountLabel', '账户'));
    const accountDelete = el(doc, 'button', 'rc-account-delete', tt('runConfigAccountDelete', '删除'));
    accountDelete.type = 'button';
    accountRow.append(accountSelect, accountDelete);
    const accountLoginRow = el(doc, 'div', 'rc-account-login-row');
    const accountLoginStatus = el(doc, 'span', 'rc-login-status');
    accountLoginStatus.setAttribute('role', 'status');
    const accountLogin = el(doc, 'button', 'rc-account-login', tt('runConfigAccountLogin', '登录官方账号'));
    const accountLoginRefresh = el(doc, 'button', 'rc-account-login-refresh', tt('runConfigAccountRefresh', '刷新登录状态'));
    accountLogin.type = accountLoginRefresh.type = 'button';
    const accountLoginLink = el(doc, 'a', 'rc-account-login-link', tt('runConfigAccountLoginOpen', '打开登录终端'));
    accountLoginLink.target = '_blank';
    accountLoginLink.rel = 'noopener';
    show(accountLoginLink, false);
    accountLoginRow.append(accountLoginStatus, accountLogin, accountLoginRefresh, accountLoginLink);
    show(accountLoginRow, false);
    // 内联的添加表单：key 只经这一个输入框直接发给本机 MultiCC，不进聊天、不发给模型。
    const accountForm = el(doc, 'div', 'rc-account-form');
    const accountLabelInput = el(doc, 'input', 'rc-account-name');
    accountLabelInput.type = 'text';
    accountLabelInput.maxLength = 64;
    accountLabelInput.placeholder = tt('runConfigAccountName', '名称（可选）');
    accountLabelInput.setAttribute('aria-label', tt('runConfigAccountName', '名称（可选）'));
    const accountKeyInput = el(doc, 'input', 'rc-account-key');
    accountKeyInput.type = 'password';
    accountKeyInput.maxLength = 512;
    accountKeyInput.autocomplete = 'new-password';
    accountKeyInput.placeholder = tt('runConfigAccountKey', 'API Key');
    accountKeyInput.setAttribute('aria-label', tt('runConfigAccountKey', 'API Key'));
    const accountSave = el(doc, 'button', 'rc-account-save primary', tt('runConfigAccountSave', '保存账户'));
    accountSave.type = 'button';
    const accountCancel = el(doc, 'button', 'rc-account-cancel', tt('runConfigCancel', '取消'));
    accountCancel.type = 'button';
    accountForm.append(accountLabelInput, accountKeyInput, accountSave, accountCancel);
    show(accountForm, false);
    const accountNote = el(doc, 'p', 'rc-note');
    accountField.append(accountRow, accountLoginRow, accountForm, accountNote);
    const effortField = el(doc, 'div', 'rc-field rc-effort-field');
    effortField.append(el(doc, 'span', null, tt('runConfigEffortLabel', '推理强度')));
    const effortSeg = segment(doc, 'rc-efforts', tt('runConfigEffortLabel', '推理强度'));
    effortField.append(effortSeg);
    const fixedStatus = el(doc, 'p', 'air-config-status');
    fixedStatus.setAttribute('role', 'status');
    // 子 agent 不再是藏在「高级」里的 details：它是和「CLI」「怎么挑」平级的一节，
    // 常显 + 左侧强调条 + 状态芯片，第一眼就看得到自己有没有单独设置。显示/隐藏
    // 仍由 renderSub 按主线路的 CLI 决定（终端草稿不摆）。
    const subSection = el(doc, 'section', 'air-config-section rc-sub');
    const subHead = el(doc, 'div', 'air-config-section-head rc-sub-head');
    const subHeading = el(doc, 'div', 'rc-sub-heading');
    const subTitleRow = el(doc, 'div', 'rc-sub-title-row');
    const subNewBadge = el(doc, 'span', 'rc-sub-new', tt('runConfigGuideNew', 'NEW'));
    show(subNewBadge, false);
    const subState = el(doc, 'span', 'rc-sub-state');
    subTitleRow.append(el(doc, 'h3', null, tt('runConfigSubTitle', '子 agent')), subNewBadge, subState);
    subHeading.append(subTitleRow,
      el(doc, 'p', 'rc-sub-subtitle', tt('runConfigSubSubtitle', '子 agent 派出去的子任务用哪条线路和模型')));
    subHead.append(subHeading);
    const subWhy = el(doc, 'p', 'rc-sub-why',
      tt('runConfigSubWhy', '主任务用强模型，子 agent 换更便宜或更快的线路，主任务不受影响，能省不少额度'));
    const subGuide = el(doc, 'div', 'rc-sub-guide');
    subGuide.append(
      el(doc, 'h4', null, tt('runConfigGuideTitle', '新功能：子 agent 可以单独选线路和模型')),
      el(doc, 'p', null, tt('runConfigGuideBody',
        'CLI 派出去的子任务默认跟主线路走；换一条更便宜或更快的线路，主任务不受影响，能省额度；下面勾选「同步」可以一键套用到所有没单独设置的同 CLI 任务，以后新建的也默认这样')),
    );
    const subGuideActions = el(doc, 'div', 'rc-sub-guide-actions');
    const subGuideApply = el(doc, 'button', 'rc-sub-guide-apply primary', tt('runConfigGuideApply', '现在设置'));
    const subGuideDismiss = el(doc, 'button', 'rc-sub-guide-dismiss', tt('runConfigGuideDismiss', '知道了'));
    subGuideApply.type = subGuideDismiss.type = 'button';
    subGuideActions.append(subGuideApply, subGuideDismiss);
    subGuide.append(subGuideActions);
    show(subGuide, false);
    const subRow = el(doc, 'div', 'rc-two');
    const subProviderField = el(doc, 'label', 'rc-field');
    subProviderField.append(el(doc, 'span', null, tt('runConfigSubProvider', '子 agent 线路')));
    const subProviderSelect = el(doc, 'select', 'rc-sub-provider');
    subProviderSelect.setAttribute('aria-label', tt('runConfigSubProvider', '子 agent 线路'));
    subProviderField.append(subProviderSelect);
    subProviderField.append(manageButton());
    const subModelField = el(doc, 'label', 'rc-field');
    subModelField.append(el(doc, 'span', null, tt('runConfigSubModel', '子 agent 模型')));
    const subModelSelect = el(doc, 'select', 'rc-sub-model');
    subModelSelect.setAttribute('aria-label', tt('runConfigSubModel', '子 agent 模型'));
    const subModelCustom = el(doc, 'input', 'rc-sub-model-custom');
    subModelCustom.maxLength = 100;
    subModelField.append(subModelSelect, subModelCustom);
    subRow.append(subProviderField, subModelField);
    const subHint = el(doc, 'p', 'rc-note rc-sub-hint', tt('runConfigSubHint', '选「随主（默认）」就是子 agent 和主线路用同一条线路、同一个模型。'));
    // 「同步」默认不勾：勾上才在保存时把这一套推给同家族的全部任务；每次打开都
    // 重新从不勾开始，免得一次批量改动被悄悄带进下一次保存。
    const subSyncLabel = el(doc, 'label', 'rc-check rc-sub-sync');
    const subSyncBox = el(doc, 'input');
    subSyncBox.type = 'checkbox';
    const subSyncText = el(doc, 'span', null, tt('runConfigSyncLabel', '同步给所有没单独设置子 agent 的 {cli} 任务，之后新建的也默认用这套', { cli: '' }));
    subSyncLabel.append(subSyncBox, subSyncText);
    const subSyncStatus = el(doc, 'p', 'rc-sub-sync-status');
    subSyncStatus.setAttribute('role', 'status');
    // 全局默认一行：现值 +「清除」（显隐由 paintGlobal 管）。清除先 dry run 说清会恢复几个任务，再二次确认。
    const subGlobal = el(doc, 'div', 'rc-sub-global');
    const subGlobalText = el(doc, 'span', 'rc-sub-global-text');
    const subClear = el(doc, 'button', 'rc-sub-clear', tt('runConfigClearGlobal', '清除'));
    const subClearConfirm = el(doc, 'button', 'rc-sub-clear-confirm', tt('runConfigClearConfirm', '确认清除'));
    const subClearCancel = el(doc, 'button', 'rc-sub-clear-cancel', tt('runConfigCancel', '取消'));
    subClear.type = subClearConfirm.type = subClearCancel.type = 'button';
    subGlobal.append(subGlobalText, subClear, subClearConfirm, subClearCancel);
    subSection.append(subHead, subWhy, subGuide, subRow, subHint, subSyncLabel, subSyncStatus, subGlobal);
    fixedSection.append(fixedHead, cliGrid, lineRow, accountField, effortField, fixedStatus);
    form.append(fixedSection);

    // 自动挑选
    const autoSection = el(doc, 'section', 'air-config-section rc-auto');
    const presetBar = el(doc, 'div', 'rc-preset-bar');
    const presetField = el(doc, 'label', 'rc-field rc-preset-field');
    presetField.append(el(doc, 'span', null, tt('runConfigPreset', '预设')));
    const presetSelect = el(doc, 'select', 'rc-preset');
    presetSelect.setAttribute('aria-label', tt('autoEditorPresetPlaceholder', '套用预设…'));
    presetField.append(presetSelect);
    const presetOpen = el(doc, 'button', 'rc-preset-open', tt('autoEditorPresetOpen', '存为预设'));
    presetOpen.type = 'button';
    const presetDelete = el(doc, 'button', 'rc-preset-delete', tt('autoEditorPresetDelete', '删除预设'));
    presetDelete.type = 'button';
    const presetForm = el(doc, 'div', 'rc-preset-form');
    const presetName = el(doc, 'input', 'rc-preset-name');
    presetName.type = 'text';
    presetName.maxLength = 40;
    presetName.placeholder = tt('runConfigPresetName', '预设名称');
    presetName.setAttribute('aria-label', tt('runConfigPresetName', '预设名称'));
    const presetSave = el(doc, 'button', 'rc-preset-save primary', tt('autoEditorPresetOpen', '存为预设'));
    presetSave.type = 'button';
    const presetCancel = el(doc, 'button', 'rc-preset-cancel', tt('runConfigCancel', '取消'));
    presetCancel.type = 'button';
    const presetStatus = el(doc, 'p', 'rc-preset-status');
    presetStatus.setAttribute('role', 'status');
    presetForm.append(presetName, presetSave, presetCancel);
    // 每个预设一枚带 ✕ 的小标签：删除不必先「套用」。套用会替换草稿，还可能因线路
    // 失效而被拒 —— 那样的预设就永远删不掉了。
    const presetChips = el(doc, 'div', 'rc-preset-chips');
    presetBar.append(presetField, presetOpen, presetDelete, presetForm, presetChips, presetStatus);
    show(presetForm, false);
    show(presetDelete, false);
    const pickHead = el(doc, 'div', 'air-config-section-head');
    pickHead.append(el(doc, 'h3', null, tt('runConfigPickHead', '怎么挑')), el(doc, 'p', null, tt('runConfigPickNote', '线路之间可以跨 CLI')));
    const pickList = el(doc, 'div', 'rc-radios');
    const orderRow = radio(doc, 'rc-pick-order', tt('runConfigPickOrder', '按顺序'), tt('runConfigPickOrderDetail', '一直用第 1 条；额度用完或报错才往下换'));
    const difficultyRow = radio(doc, 'rc-pick-difficulty', tt('runConfigPickDifficulty', '按难度'), tt('runConfigPickDifficultyDetail', '每条消息先让 Jev 判断难易，再挑线路和模型'));
    pickList.append(orderRow.node, difficultyRow.node);
    const jevHost = el(doc, 'div', 'rc-jev-host');
    const tierRow = el(doc, 'div', 'rc-tier-row');
    tierRow.append(el(doc, 'span', null, tt('runConfigTierLabel', '档位')));
    const tierSeg = segment(doc, 'rc-tiers', tt('runConfigTierLabel', '档位'));
    const tierPrice = segButton(doc, tierSeg, 'rc-tier-price', tt('runConfigTierPrice', '交给 Jev'), tt('runConfigTierPriceHint', '由 Jev 按难度挑，不用逐行标'));
    const tierManual = segButton(doc, tierSeg, 'rc-tier-manual', tt('runConfigTierManual', '我自己标'), tt('runConfigTierManualHint', '每行标一个简单 / 中等 / 复杂'));
    tierRow.append(tierSeg);
    autoSection.append(presetBar, pickHead, pickList, jevHost, tierRow);

    const poolHead = el(doc, 'div', 'air-config-section-head');
    const poolTitle = el(doc, 'h3', null, tt('runConfigPoolHead', '线路池'));
    const poolNote = el(doc, 'p', null, tt('runConfigPoolNote', '拖动排序'));
    poolHead.append(poolTitle, poolNote);
    poolHead.append(manageButton());
    const poolList = el(doc, 'div', 'rc-pool');
    const addButton = el(doc, 'button', 'rc-add', `＋ ${tt('runConfigAddLine', '添加线路')}`);
    addButton.type = 'button';
    const pickerHost = el(doc, 'div', 'rc-picker-host');
    const more = el(doc, 'details', 'rc-more');
    const moreSummary = el(doc, 'summary', null, tt('runConfigMore', '更多：最多试几条 / 保持当前线路'));
    const moreBody = el(doc, 'div', 'rc-more-body');
    const maxField = el(doc, 'label', 'rc-field');
    maxField.append(el(doc, 'span', null, tt('runConfigMaxAttempts', '最多试几条')));
    const maxSelect = el(doc, 'select', 'rc-max-attempts');
    maxField.append(maxSelect);
    const stickyLabel = el(doc, 'label', 'rc-check');
    const stickyBox = el(doc, 'input');
    stickyBox.type = 'checkbox';
    stickyLabel.append(stickyBox, el(doc, 'span', null, tt('runConfigSticky', '保持当前线路')));
    moreBody.append(maxField, stickyLabel);
    more.append(moreSummary, moreBody);
    autoSection.append(poolHead, poolList, addButton, pickerHost, more);
    form.append(autoSection);
    // 子 agent 线路/模型是「固定一条」和「自动挑选」共用的一节 —— 两种模式下
    // 都只有这一处，摆在当前模式内容的下面（固定模式下 autoSection 是隐藏的，这
    // 块自然跟在固定段后面）。显示/隐藏由 renderSub 按主线路的 CLI 决定。
    form.append(subSection);

    const error = el(doc, 'p', 'air-config-error');
    error.setAttribute('role', 'alert');
    const foot = el(doc, 'footer', 'air-config-footer');
    const footCopy = el(doc, 'p', '');
    const actions = el(doc, 'div');
    const cancel = el(doc, 'button', null, tt('runConfigCancel', '取消'));
    cancel.type = 'button';
    cancel.onclick = () => dialog.close();
    const submit = el(doc, 'button', 'primary', draft ? tt('runConfigUse', '用这套配置') : tt('runConfigSave', '保存'));
    submit.type = 'submit';
    actions.append(cancel, submit);
    foot.append(footCopy, actions);
    form.append(error, foot);
    dialog.append(form);
    doc.body.append(dialog);
    dialog.showModal();
    // showModal 会把焦点丢给第一个可聚焦的后代 —— 也就是右上角的 ✕ —— 于是对话框
    // 一开就在那个叉上顶一圈蓝色焦点环。焦点收到对话框本身，叉要按 Tab 才到。
    dialog.tabIndex = -1;
    try { dialog.focus({ preventScroll: true }); } catch (_) { dialog.focus(); }
    dialog.onclose = () => {
      closed = true;
      ++epoch;
      if (stopModelWatch) stopModelWatch();
      dialog.remove();
    };

    function radio(docRef, className, title, detail) {
      const node = el(docRef, 'div', `rc-radio ${className}`);
      node.dataset.value = className.replace('rc-pick-', '');
      const dot = el(docRef, 'span', 'rc-radio-dot');
      const copy = el(docRef, 'div');
      copy.append(el(docRef, 'b', null, title));
      if (detail) copy.append(el(docRef, 'span', 'rc-radio-detail', detail));
      node.append(dot, copy);
      return { node, set: on => node.classList.toggle('on', !!on) };
    }

    // ── 渲染：固定一条 ───────────────────────────────────────────────────────
    // 一条 CLI 为什么不能出现在这个用途里：它在这个 kind 下不提供（chat 车道
    // offered:false 的两条一次性车道），或者服务端根本没装。说的是具体规则，不是
    // 「这个用途用不了」这种什么都没说的句子。
    function cliPurposeReason(cli) {
      const replacement = catalogApi.cliReplacedBy ? catalogApi.cliReplacedBy(cli) : null;
      const base = terminalDraft
        ? tt('runConfigCliNoTerminal', '终端模式不提供这条 CLI')
        : tt('runConfigCliNoChat', '对话模式不提供这条 CLI');
      return replacement ? `${base}（改用 ${cliLabel(replacement)}）` : base;
    }

    function availableClis() {
      const known = new Set(Array.isArray(clis) ? clis.map(String) : []);
      const list = [...new Set([...AUTO_CLIS, config.cli, ...known].filter(Boolean))].filter(offersIn);
      return list.map(cli => {
        if (cli === config.cli || known.has(cli) || (!terminalDraft && cli === chatChoiceCli(config.cli))) {
          return offersIn(cli)
            ? { cli, ok: true, reason: '' }
            : { cli, ok: false, reason: cliPurposeReason(cli) };
        }
        return { cli, ok: false, reason: tt('runConfigCliMissing', '未安装') };
      });
    }

    // The second line describes available routes, without exposing the engine.
    function cliCardCopy(cli) {
      if (providerless(cli)) return tt('runConfigCliOwnAccount', '使用 {name} 自己的账号', { name: cliLabel(cli) });
      const catalog = catalogs.get(cli);
      if (!catalog && !catalogErrors.has(cli)) return '…';
      if (catalogErrors.has(cli)) return tt('runConfigLoadFailedShort', '加载失败');
      const count = providersOf(cli).length + (cli === 'opencode' ? aiApi.openCodeNativeProviders().length : 0);
      return count ? tt('runConfigCliLineCount', '{n} 条', { n: count }) : tt('runConfigCliNoLines', '没有可用线路');
    }

    function renderCliCards() {
      cliGrid.replaceChildren(...availableClis().map(item => {
        const button = el(doc, 'button', 'air-cli-option rc-cli-card');
        button.type = 'button';
        button.dataset.cli = item.cli;
        button.setAttribute('role', 'radio');
        const selected = item.cli === (terminalDraft ? currentCli : chatChoiceCli(currentCli));
        button.setAttribute('aria-checked', String(selected));
        button.classList.toggle('selected', selected);
        button.classList.toggle('is-off', !item.ok);
        const copy = el(doc, 'span');
        const small = el(doc, 'small', null, item.ok ? cliCardCopy(item.cli) : item.reason);
        if (!item.ok) small.classList.add('rc-reason');
        copy.append(el(doc, 'strong', null, cliLabel(item.cli)), small);
        button.append(mark(doc, item.cli), copy);
        button.onclick = () => { if (item.ok && item.cli !== currentCli && !loading) selectCli(item.cli); };
        return button;
      }));
    }

    function officialFor(cli) {
      const kind = cli.startsWith('codex') ? 'codex' : 'claude';
      return (catalogs.get(cli) ? catalogApi.providersForCli(catalogs.get(cli), cli) : [])
        .find(item => catalogApi.officialProviderKind(item) === kind) || null;
    }

    function lineItems() {
      const items = [];
      const list = providersOf(currentCli);
      const official = officialFor(currentCli);
      if (providerless(currentCli) || !official) {
        const label = providerless(currentCli)
          ? tt('runConfigNativeOwnAccount', '{name} 自己的账号', { name: cliLabel(currentCli) })
          : tt('runConfigNativeDefault', '默认登录 / 官方账号');
        items.push({ value: '', label });
      }
      if (currentCli === 'opencode') {
        for (const nativeItem of aiApi.openCodeNativeProviders()) {
          items.push({ value: nativeItem.value, label: nativeItem.label.replace(/^OpenCode 原生 · /, '') + '（本机 OpenCode 登录）' });
        }
      }
      for (const provider of list) items.push({ value: provider.id, label: providerName(provider) });
      return items;
    }

    function renderModes() {
      fixedButton.classList.toggle("on", mode === MODE_FIXED);
      autoButton.classList.toggle("on", mode === MODE_AUTO);
      fixedButton.setAttribute("aria-checked", String(mode === MODE_FIXED));
      autoButton.setAttribute("aria-checked", String(mode === MODE_AUTO));
      show(fixedSection, mode === MODE_FIXED);
      show(autoSection, mode === MODE_AUTO);
    }
    function renderFixed() {
      renderCliCards();
      const own = providerless(currentCli);
      renderLineSelect();
      show(lineField, !own);
      // 自持账号的车道只是没有 MultiCC 线路池；模型仍从它自己的目录里挑
      // （buildModelChoices 的 qoder/codebuddy/dsh/gemini/grok/commandcode 分支），
      // 与 App 端 run_config_sheet 一致 —— 那边对自持车道也只藏线路、不藏模型。
      show(modelField, true);
      renderModel();
      renderEffort();
      renderSub();
      renderAccount();
    }

    function renderLineSelect() {
      if (providerless(currentCli)) {
        lineSelect.replaceChildren();
        lineNote.textContent = '';
        show(lineSelect, false);
        show(lineNote, false);
        providerValue = '';
        return;
      }
      const items = lineItems();
      if (!items.length) {
        lineSelect.replaceChildren();
        show(lineSelect, false);
        show(lineNote, true);
        lineNote.replaceChildren(
          catalogErrors.has(currentCli)
            ? tt('runConfigLoadFailed', '线路列表加载失败')
            : tt('runConfigNoLines', '没有可用线路'),
        );
        if (catalogErrors.has(currentCli)) {
          const retry = el(doc, 'button', 'rc-retry', tt('runConfigRetry', '重试'));
          retry.type = 'button';
          retry.onclick = () => { catalogErrors.delete(currentCli); boot(); };
          lineNote.append(' · ', retry);
        }
        providerValue = '';
        return;
      }
      if (pendingNative && items.some(item => item.value === pendingNative)) {
        providerValue = pendingNative;
        pendingNative = '';
      }
      if (!items.some(item => item.value === providerValue)) providerValue = items[0].value;
      lineSelect.replaceChildren(...items.map(item => option(doc, item.value, item.label)));
      lineSelect.value = providerValue;
      show(lineSelect, true);
      show(lineNote, false);
      lineNote.textContent = '';
    }

    // 下拉里的选项：厂商目录自带分组的（Command Code 的 Open Source / Anthropic /
    // OpenAI …）按原分组画 <optgroup>，没有分组信息的照旧平铺。filter 非空时只
    // 留标签或 id 含关键字的；默认项、自定义项和当前选中的值始终保留。
    const MODEL_SEARCH_MIN = 12;
    function paintModelOptions(select, choices, value, state, filter, keep) {
      const needle = String(filter || '').trim().toLowerCase();
      const children = [];
      let group = null;
      let groupName = null;
      for (const choice of choices) {
        const label = choice === '__custom__' ? tt('runConfigModelCustom', '自定义…') : aiApi.modelChoiceLabel(choice, value, state);
        const special = choice === '' || choice === '__custom__' || choice === keep;
        if (needle && !special && !`${label} ${choice}`.toLowerCase().includes(needle)) continue;
        const name = (typeof aiApi.modelChoiceGroup === 'function' && aiApi.modelChoiceGroup(choice, state)) || '';
        if (!name) { group = null; groupName = null; children.push(option(doc, choice, label)); continue; }
        if (!group || groupName !== name) {
          group = doc.createElement('optgroup');
          group.label = name;
          groupName = name;
          children.push(group);
        }
        group.append(option(doc, choice, label));
      }
      select.replaceChildren(...children);
    }

    function fillModel(select, custom, value, cli, preferred) {
      const state = modelState(cli);
      let choices = aiApi.buildModelChoices(value, state);
      if (!Array.isArray(choices) || !choices.length) choices = ['', '__custom__'];
      choices = [...new Set(choices)];
      modelSearch.value = '';
      modelSearch.hidden = choices.filter(choice => choice && choice !== '__custom__').length <= MODEL_SEARCH_MIN;
      modelSearch.oninput = () => {
        const keep = select.value;
        paintModelOptions(select, choices, value, state, modelSearch.value, keep);
        select.value = keep;
      };
      paintModelOptions(select, choices, value, state, '', '');
      let selected = aiApi.normalizeModel(value, preferred || '', state);
      if (!selected) selected = aiApi.defaultModelChoice(value, state) || '';
      const known = choices.includes(selected);
      select.value = known ? selected : (selected && choices.includes('__custom__') ? '__custom__' : choices[0]);
      custom.value = known ? '' : selected;
      show(custom, select.value === '__custom__');
    }

    function renderModel() {
      // 只有 opencode 的模型表是从本机 CLI 实时拉的，其余 CLI 的清单要么在
      // provider 目录里、要么是固定档位，没有可刷的东西。
      show(modelRefresh, currentCli === 'opencode');
      fillModel(modelSelect, modelCustom, providerValue, currentCli, modelValue);
      modelValue = currentModelValue();
      watchSelectedModels();
    }

    function watchSelectedModels() {
      const provider = providerById(currentCli, providerValue);
      // 借道线路继续使用出借方目录，不访问本机官方账号目录。
      const official = /^(codex)-official(?:-[a-f0-9]{16})?$/.test(providerValue)
        || !!(provider && (provider.builtinOfficial || provider.isOfficial) && provider.appType === 'codex');
      const key = !closed && (currentCli === 'codex' || currentCli === 'codex-exp') && official
        ? `${currentCli}:${providerValue}` : '';
      if (key !== modelWatchKey) {
        if (stopModelWatch) stopModelWatch();
        stopModelWatch = null;
        modelWatchKey = key;
        modelCatalogStatus = null;
        const api = scope();
        if (key && api && typeof api.watchCodexModels === 'function') {
          const selectedProvider = providerValue;
          const selectedCli = currentCli;
          stopModelWatch = api.watchCodexModels({ providerId: selectedProvider }, catalog => {
            if (closed || modelWatchKey !== key) return;
            modelCatalogStatus = catalog;
            // normalizeCatalog 返回冻结记录；替换副本，不修改共享目录对象。
            for (const [cli, existing] of catalogs) {
              if (cli !== 'codex' && cli !== 'codex-exp') continue;
              const list = existing.providers.map(item => item.id === selectedProvider
                ? { ...item, modelOptions: catalog.diagnostic.code === 'request_failed' && !catalog.models.length
                    ? item.modelOptions : catalog.models.map(model => model.model),
                    model: (catalog.models.find(model => model.isDefault) || {}).model || item.model }
                : item);
              catalogs.set(cli, { ...existing, providers: list });
            }
            if (currentCli !== selectedCli || providerValue !== selectedProvider) return;
            // 读取当前输入，异步返回期间用户选择/输入的模型必须保留。
            const selected = currentModelValue();
            fillModel(modelSelect, modelCustom, providerValue, currentCli, selected);
            modelValue = currentModelValue();
            paintModelStatus();
            renderFooter();
          });
        }
      }
      paintModelStatus();
    }

    function paintModelStatus() {
      const status = modelCatalogStatus;
      const code = status && status.diagnostic && status.diagnostic.code;
      modelStatus.textContent = !modelWatchKey ? '' : !status || status.refreshing
        ? (modelSelect.options.length > 2 ? '正在后台更新模型…' : '正在加载模型…')
        : code && code !== 'ok' && code !== 'none' && code !== 'ready'
          ? (status.diagnostic.message || '模型列表获取失败，请重新打开后重试。')
          : status.models.length ? '' : '当前账号没有可用模型。';
      modelStatus.hidden = !modelStatus.textContent;
    }

    // The sub-task model keeps an explicit "leave it to the main line" as its
    // first option — an empty value means "no subagent override at all", which
    // is not the same as picking the main provider's default model.
    function fillSubModel(select, custom, cli, providerId, preferred) {
      const state = modelState(cli);
      const choices = [...new Set(aiApi.buildModelChoices(providerId, state))]
        .filter(choice => choice && choice !== '__custom__');
      const wanted = aiApi.normalizeModel(providerId, preferred || '', state);
      const items = [option(doc, '', tt('runConfigNotSet', '不设置'))];
      for (const choice of choices) {
        items.push(option(doc, choice, aiApi.modelChoiceLabel(choice, providerId, state)));
      }
      items.push(option(doc, '__custom__', tt('runConfigModelCustom', '自定义…')));
      select.replaceChildren(...items);
      const known = !!wanted && choices.includes(wanted);
      select.value = known ? wanted : (wanted ? '__custom__' : '');
      custom.value = known ? '' : (wanted || '');
      show(custom, select.value === '__custom__');
    }

    // 推理强度只有档位值（wire value）是权威的，界面说的是中文档名 —— 值一样，
    // 所以保存出去的东西没变。表里没有的档位回落到模块给的英文名。
    const EFFORT_CN = Object.freeze({
      '': '默认', default: '默认', minimal: '最低', low: '低', medium: '中',
      high: '高', xhigh: '超高', max: '最高', ultra: '超高',
    });

    function renderEffort() {
      const options = aiApi.effortOptions(currentCli);
      show(effortField, !!options.length);
      effortSeg.replaceChildren();
      for (const choice of options) {
        const key = String(choice.value == null ? '' : choice.value);
        const label = EFFORT_CN[key] || choice.label;
        const button = segButton(doc, effortSeg, `rc-effort-${choice.value}`, label, choice.desc);
        button.dataset.value = choice.value;
        button.onclick = () => { effortValue = choice.value; renderEffort(); renderFooter(); };
        button.setAttribute('aria-checked', String(choice.value === effortValue));
      }
      if (!options.length) { effortValue = null; return; }
      if (!options.some(choice => choice.value === effortValue)) effortValue = aiApi.defaultEffort(currentCli);
      for (const button of effortSeg.children) {
        button.setAttribute('aria-checked', String(button.dataset.value === effortValue));
        button.classList.toggle('on', button.dataset.value === effortValue);
      }
    }

    // ── 账户（Command Code / OpenCode）────────────────────────────────────────
    function accountLane() {
      if (!KEY_ACCOUNT_CLIS.includes(currentCli)) return '';
      // 挑了 MultiCC 线路或别家的原生线路时，opencode.ai 的 key 用不上，账户行就不摆出来。
      if (currentCli === 'opencode' && providerValue
        && !(isNativeLine(providerValue) && OPENCODE_ACCOUNT_LINES.includes(nativeLineId(providerValue)))) return '';
      return currentCli;
    }

    function accountTitle(account) {
      const name = account.label || tt('runConfigAccountUnnamed', '账户 {id}', { id: String(account.id).slice(0, 6) });
      return [name, account.keyHint].filter(Boolean).join(' · ');
    }

    function pickedAccount() {
      const cli = accountLane();
      const list = cli ? accountLists.get(cli) : null;
      return Array.isArray(list) ? list.find(account => account.id === accountPicks[cli]) || null : null;
    }

    function loadAccounts(cli) {
      if (accountLists.has(cli)) return;
      accountLists.set(cli, null);
      request(`/api/cli-accounts/${encodeURIComponent(cli)}`, undefined, 'GET').then(
        result => { accountLists.set(cli, Array.isArray(result.accounts) ? result.accounts : []); },
        cause => { accountLists.set(cli, cause instanceof Error ? cause : new Error(String(cause))); },
      ).then(() => { if (accountLane() === cli) { renderAccount(); renderFooter(); } });
    }

    function renderAccount() {
      const cli = accountLane();
      show(accountField, !!cli);
      if (!cli) {
        show(accountForm, false);
        fixedStatus.textContent = providerless(currentCli)
          ? tt('runConfigStatusOwn', '使用 {name} 自己的账号', { name: cliLabel(currentCli) }) : '';
        return;
      }
      loadAccounts(cli);
      const list = accountLists.get(cli);
      const known = Array.isArray(list) ? list : [];
      const picked = accountPicks[cli] || '';
      // 会话选过、账户文件却没了：保存时改回本机登录，并且说出来 —— 否则下一轮
      // 服务端会拒绝启动（它不会悄悄换成本机账户扣费）。
      if (picked && Array.isArray(list) && !known.some(account => account.id === picked)) {
        accountPicks = { ...accountPicks, [cli]: null };
        accountTouched.add(cli);
        accountVanished = cli;
      }
      const items = [option(doc, '', tt('runConfigAccountLocal', '本机 CLI 登录（默认）'))];
      for (const account of known) items.push(option(doc, account.id, accountTitle(account)));
      if (accountPicks[cli] && !Array.isArray(list)) items.push(option(doc, accountPicks[cli], tt('runConfigAccountLoading', '加载中…')));
      items.push(option(doc, ACCOUNT_ADD_VALUE, tt('runConfigAccountAdd', '＋ 添加账户…')));
      accountSelect.replaceChildren(...items);
      accountSelect.value = accountPicks[cli] || '';
      accountSelect.disabled = !accountPicksReady;
      const account = pickedAccount();
      show(accountDelete, !!account);
      show(accountLoginRow, cli === 'commandcode');
      if (cli === 'commandcode') {
        if (commandcodeLogin === undefined) refreshCommandcodeLogin();
        accountLoginRefresh.disabled = commandcodeLoginLoading;
        accountLogin.textContent = tt(commandcodeLogin && commandcodeLogin.credentialSaved ? 'runConfigAccountRelogin' : 'runConfigAccountLogin',
          commandcodeLogin && commandcodeLogin.credentialSaved ? '查看／登录官方账号' : '登录官方账号');
        accountLoginStatus.textContent = commandcodeLogin instanceof Error
          ? tt('runConfigAccountLoginFailed', '无法读取登录状态，请重试。')
          : commandcodeLogin && commandcodeLogin.environmentKey
            ? tt('runConfigAccountLoginEnv', '当前默认使用环境变量中的 API Key，优先于本机账号。')
            : commandcodeLogin && commandcodeLogin.credentialSaved
              ? tt('runConfigAccountLoginSaved', '本机已保存登录：{name}（有效性以实际调用为准）', { name: commandcodeLogin.userName || 'Command Code' })
              : tt('runConfigAccountLoginMissing', '本机尚未保存官方账号登录。');
        if (commandcodeLoginLoading) accountLoginStatus.textContent = tt('runConfigAccountLoading', '加载中…');
      }
      accountNote.textContent = list instanceof Error
        ? tt('runConfigAccountLoadFailed', '账户列表加载失败')
        : accountVanished === cli
          ? tt('runConfigAccountVanished', '之前选的账户已不存在，保存后改用本机 CLI 登录。')
          : cli === 'opencode'
            ? tt('runConfigAccountHintOpencode', '添加时填 opencode.ai 的 API Key，Zen 与 Go 共用；只用于这个会话，不改本机配置。')
            : tt('runConfigAccountHintCommandcode', '官方账号通过登录按钮授权，选择“本机 CLI 登录”并保存后使用；影响所有复用本机登录的会话。添加 API Key 账户只用于所选会话。');
      fixedStatus.textContent = account
        ? tt('runConfigStatusAccount', '使用 {name} 账户「{account}」', { name: cliLabel(currentCli), account: account.label || String(account.id).slice(0, 6) })
        : providerless(currentCli) ? tt('runConfigStatusOwn', '使用 {name} 自己的账号', { name: cliLabel(currentCli) }) : '';
    }

    function refreshCommandcodeLogin() {
      if (commandcodeLoginLoading) return;
      commandcodeLoginLoading = true;
      commandcodeLogin = null;
      request('/api/commandcode/auth/status', undefined, 'GET').then(
        result => { commandcodeLogin = result; },
        cause => { commandcodeLogin = cause instanceof Error ? cause : new Error(String(cause)); },
      ).then(() => {
        commandcodeLoginLoading = false;
        if (dialog.isConnected && accountLane() === 'commandcode') renderAccount();
      });
    }

    accountLoginRefresh.onclick = () => { refreshCommandcodeLogin(); renderAccount(); };
    accountLogin.onclick = () => {
      // 同步打开标签页，避免异步请求完成后被浏览器拦截；拦截时仍提供可点击链接。
      const popup = scope().open('about:blank', '_blank');
      if (popup) popup.opener = null;
      accountLogin.disabled = true;
      request('/api/commandcode/auth/login', {}).then(result => {
        const url = `/?id=${encodeURIComponent(result.sessionId)}`;
        accountLoginLink.href = url;
        show(accountLoginLink, true);
        if (popup) popup.location.replace(url);
        accountLoginStatus.textContent = tt('runConfigAccountLoginHint', '在登录终端完成浏览器授权，回来点击“刷新登录状态”。远程访问时，请在运行 MultiCC 的电脑上完成授权。');
      }, cause => {
        if (popup) popup.close();
        accountLoginStatus.textContent = cause.message;
      }).then(() => { accountLogin.disabled = false; });
    };

    // 保存时要写回的那一格：只写用户动过的车道。
    function accountPatch() {
      const cli = accountLane();
      return cli && accountTouched.has(cli) ? { [cli]: accountPicks[cli] || null } : null;
    }

    function setAccountPick(cli, id) {
      accountPicks = { ...accountPicks, [cli]: id || null };
      accountTouched.add(cli);
      if (accountVanished === cli) accountVanished = '';
      renderAccount();
      renderFooter();
    }

    accountSelect.onchange = () => {
      const cli = accountLane();
      if (!cli) return;
      if (accountSelect.value === ACCOUNT_ADD_VALUE) {
        accountSelect.value = accountPicks[cli] || '';
        show(accountForm, true);
        accountLabelInput.focus();
        return;
      }
      setAccountPick(cli, accountSelect.value);
    };
    accountCancel.onclick = () => {
      accountLabelInput.value = '';
      accountKeyInput.value = '';
      show(accountForm, false);
      renderAccount();
    };
    accountSave.onclick = () => {
      const cli = accountLane();
      const apiKey = accountKeyInput.value.trim();
      if (!cli) return;
      if (!apiKey) {
        accountNote.textContent = tt('runConfigAccountKeyRequired', '先填 API Key。');
        accountKeyInput.focus();
        return;
      }
      accountSave.disabled = true;
      request(`/api/cli-accounts/${encodeURIComponent(cli)}`, { label: accountLabelInput.value, apiKey }).then((result) => {
        const list = accountLists.get(cli);
        accountLists.set(cli, [...(Array.isArray(list) ? list : []), result.account]);
        accountLabelInput.value = '';
        accountKeyInput.value = '';
        show(accountForm, false);
        if (accountLane() === cli) setAccountPick(cli, result.account.id);
      }, (cause) => { accountNote.textContent = cause.message; })
        .then(() => { accountSave.disabled = false; });
    };
    // 这两个输入框在运行配置的 <form> 里：回车只该保存账户，不能顺手把整份配置提交了。
    for (const input of [accountLabelInput, accountKeyInput]) {
      input.onkeydown = (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        accountSave.click();
      };
    }
    accountDelete.onclick = () => {
      const cli = accountLane();
      const account = pickedAccount();
      if (!cli || !account) return;
      const confirmed = typeof confirm !== 'function' || confirm(tt('runConfigAccountDeleteConfirm',
        '删除账户「{name}」？选了它的会话都会改回本机 CLI 登录。', { name: accountTitle(account) }));
      if (!confirmed) return;
      accountDelete.disabled = true;
      request(`/api/cli-accounts/${encodeURIComponent(cli)}/${encodeURIComponent(account.id)}`, undefined, 'DELETE').then(() => {
        const list = accountLists.get(cli);
        accountLists.set(cli, (Array.isArray(list) ? list : []).filter(item => item.id !== account.id));
        // 服务端已经把选了它的会话（包括这一个）改回本机登录，这里只同步界面。
        accountPicks = { ...accountPicks, [cli]: null };
        renderAccount();
        renderFooter();
      }, (cause) => { accountNote.textContent = cause.message; })
        .then(() => { accountDelete.disabled = false; });
    };

    function primaryProviderId() {
      if (mode === MODE_AUTO && rows.length) return rows[0].providerId;
      return providerValue;
    }

    // 子任务挂在「主线路」上：固定一条时是选中的 CLI，自动挑选时是池子里排第一
    // 那行的 CLI —— 与 primaryProviderId() 认的主线路一致。主 CLI 不支持子任务就
    // 整块隐藏（和服务端 SUBAGENT_CLIS 一张表）。
    function subCli() {
      if (mode === MODE_AUTO) return rows.length ? clean(rows[0].cli) : '';
      return currentCli;
    }

    // ── 子 agent：默认值 / 首次引导 / 同步 ──────────────────────────────────
    // 一条家族默认 = 服务端的 {providerId, model}。目录里带回来的默认是「当前值」，
    // 同步成功后响应里的那一份更新 —— 两者都收进 subDefaults，界面只读这里。
    function absorbCatalogDefaults(catalog) {
      if (subDefaultsSynced) return;
      const defaults = catalog && catalog.defaults;
      const routes = defaults && defaults.subagent;
      if (!routes || typeof routes !== 'object') return;
      subDefaults = { claude: normalizeSubagentRoute(routes.claude), codex: normalizeSubagentRoute(routes.codex) };
    }

    function applySyncedDefaults(value) {
      const source = value && typeof value === 'object' ? value : {};
      const routes = source.subagent && typeof source.subagent === 'object' ? source.subagent : source;
      subDefaults = { claude: normalizeSubagentRoute(routes.claude), codex: normalizeSubagentRoute(routes.codex) };
      subDefaultsSynced = true;
    }

    function findProviderAnywhere(id) {
      const wanted = clean(id);
      if (!wanted) return null;
      return allProviders().find(item => String(item.id) === wanted) || null;
    }

    // 默认线路的名字要在目录里查；当前 CLI 的目录不一定含这个家族的线路，缺了就
    // 背景补拉一次（失败就算了，状态行会按「线路已不可用」说）。
    function ensureFamilyCatalog(family) {
      const cli = subagentFamilyCli(family);
      if (!cli || catalogs.has(cli) || catalogErrors.has(cli) || subFamilyCatalogPending) return;
      subFamilyCatalogPending = true;
      loadCatalog(cli).then(() => {
        subFamilyCatalogPending = false;
        if (!closed) paintSubMeta();
      }, () => { subFamilyCatalogPending = false; });
    }

    function reduceMotion() {
      try {
        const api = scope();
        return !!(api && typeof api.matchMedia === 'function'
          && api.matchMedia('(prefers-reduced-motion: reduce)').matches);
      } catch (_) { return false; }
    }

    function maybeShowSubGuide() {
      if (terminalDraft || subGuideShown || subGuideDismissed || subGuideSeenOnOpen) return;
      subGuideShown = true;
      show(subGuide, true);
      show(subNewBadge, true);
      subSection.classList.add('is-guide');
      const smooth = !reduceMotion();
      const scroll = () => {
        if (closed || subGuideDismissed) return;
        try { subSection.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'center' }); } catch (_) {}
      };
      const raf = scope() && scope().requestAnimationFrame;
      if (typeof raf === 'function') raf(() => raf(scroll));
      else setTimeout(scroll, 0);
    }

    function dismissSubGuide() {
      if (!subGuideShown || subGuideDismissed) return;
      subGuideDismissed = true;
      subGuideSeenOnOpen = true;
      show(subGuide, false);
      show(subNewBadge, false);
      subSection.classList.remove('is-guide');
      markGuideSeen(scope() && scope().localStorage);
    }

    // 用户动过子 agent 的下拉：此后默认值不再自动回填。
    function markSubagentTouched() {
      subagentTouched = true;
      subagentSeedAuto = false;
      subagentSeedFamily = subagentFamily(subCli());
    }

    // 草稿，或已有会话在对话框里换了 CLI：子 agent 没设过或只跟着全局默认走时，
    // 按这一族当前的全局默认（subDefaults，比目录那份新）预填，换家族也照办；动过
    // 下拉或带来的是新家族自己单独设置的线路就不碰。返回 true = 种子变了，要重铺。
    function seedDraftSubagent() {
      if ((!draft && !cliSwitched) || terminalDraft || subagentTouched) return false;
      const cli = subCli();
      const family = subagentFamily(cli);
      if (!family || !catalogs.get(cli)) return false;
      if (subagentSeedFamily === family && subagentSeed && !subagentSeedAuto) return false;
      const def = subDefaults[family] || null;
      subagentSeedFamily = family;
      if (sameSubagentRoute(def, subagentSeed)) { subagentSeedAuto = !!def; return false; }
      subagentSeed = def;
      subagentSeedAuto = !!def;
      return true;
    }

    // 子 agent 的三种状态：没有线路 = 跟随主线路；打开时就跟着全局默认走、这次也没动过
    // = 跟随全局默认；其余 = 单独设置（之后的同步、清除都不会碰它）。
    function subagentFollowsGlobal(route = collectSubagent()) {
      return !!route && subagentSeedAuto && !subagentTouched && sameSubagentRoute(route, subagentSeed);
    }

    function resetSyncPreview() {
      subSyncBox.checked = false;
      ++subPreviewSeq;
      if (subPreviewTimer) { clearTimeout(subPreviewTimer); subPreviewTimer = null; }
      subPreviewKey = '';
      subPreview = null;
    }

    // 状态芯片、同步行、全局默认行：每次重铺下拉后都重新说一遍。
    function paintSubMeta() {
      const cli = subCli();
      if (terminalDraft || !cli || !aiApi.supportsSubagentCli(cli)) return;
      const family = subagentFamily(cli);
      const set = collectSubagent();
      const global = subagentFollowsGlobal(set);
      subState.textContent = !set ? tt('runConfigSubStateFollow', '跟随主线路')
        : global ? tt('runConfigSubStateGlobal', '跟随全局默认') : tt('runConfigSubStateSet', '已单独设置');
      subState.classList.toggle('is-set', !!set && !global);
      subState.classList.toggle('is-global', global);
      subSyncText.textContent = tt('runConfigSyncLabel', '同步给所有没单独设置子 agent 的 {cli} 任务，之后新建的也默认用这套',
        { cli: subagentFamilyLabel(family) || cliLabel(cli) });
      // 同步只用来「设」全局默认：选随主时没有可同步的线路，撤掉全局默认走下面的「清除」。
      if (!set && subSyncBox.checked) resetSyncPreview();
      subSyncBox.disabled = subSyncUnavailable || !set;
      paintSyncStatus();
      paintGlobal(family);
      queueSyncPreview();
      maybeShowSubGuide();
    }

    // 状态行：503 原因 > 勾选同步时的预览 > 最近一次清除的结果。
    function paintSyncStatus() {
      const summary = subSyncUnavailable ? syncSummary({ state: 'unavailable' })
        : subSyncBox.checked && subPreview ? syncSummary(subPreview) : subNotice;
      subSyncStatus.textContent = summary ? summary.text : '';
      subSyncStatus.classList.toggle('is-ready', !!summary && summary.tone === 'ready');
      subSyncStatus.classList.toggle('is-error', !!summary && summary.tone === 'error');
    }

    // 「全局默认」一行：现值 +「清除」；确认态换成 dry run 的说明 +「确认清除 / 取消」。
    // 线路名要在目录里查，当前 CLI 的目录里没有就背景补拉一次。
    function paintGlobal(family) {
      const lane = family || subagentFamily(subCli());
      const route = lane ? subDefaults[lane] : null;
      const provider = route && findProviderAnywhere(route.providerId);
      if (route && !provider) ensureFamilyCatalog(lane);
      const confirming = !!subClearPlan;
      subGlobal.classList.toggle('is-confirm', confirming);
      show(subClear, !confirming && !!route);
      show(subClearConfirm, confirming);
      show(subClearCancel, confirming);
      subClear.disabled = subClearBusy || subSyncUnavailable;
      subClearConfirm.disabled = subClearCancel.disabled = subClearBusy;
      subGlobalText.textContent = confirming ? clearSummary(subClearPlan)
        : !route ? tt('runConfigGlobalNone', '全局默认：未设置（新任务随主线路）')
          : provider ? tt('runConfigGlobalRoute', '全局默认：{line} · {model}', { line: provider.name || provider.id, model: route.model })
            : tt('runConfigGlobalMissing', '全局默认：{id} · {model}（线路已不可用）', { id: route.providerId, model: route.model });
    }

    // 勾上「同步」后 300ms 的 dry run：同一个选择只问一次；选择/主线路变了才重问。
    function queueSyncPreview() {
      if (!subSyncBox.checked || subSyncBox.disabled || closed || terminalDraft) return;
      const cli = subCli();
      if (!cli || !aiApi.supportsSubagentCli(cli)) return;
      const key = JSON.stringify([cli, collectSubagent()]);
      if (key === subPreviewKey) return;
      // 旧响应立刻作废：新请求还要等 debounce，不能让它在这段空窗里落地。
      ++subPreviewSeq;
      if (subPreviewTimer) clearTimeout(subPreviewTimer);
      subPreviewTimer = setTimeout(() => {
        subPreviewTimer = null;
        if (closed || key === subPreviewKey) return;
        if (!subSyncBox.checked || subSyncBox.disabled) return;
        const nowCli = subCli();
        if (!nowCli || !aiApi.supportsSubagentCli(nowCli)) return;
        subPreviewKey = key;
        runSyncPreview(nowCli, key);
      }, 300);
    }

    async function runSyncPreview(cli, key) {
      const seq = ++subPreviewSeq;
      subPreview = { state: 'loading' };
      paintSyncStatus();
      try {
        const result = await request('/api/subagent-defaults/sync',
          { cli, subagent: collectSubagent(), dryRun: true });
        if (closed || seq !== subPreviewSeq || key !== subPreviewKey) return;
        if (result && result.defaults) applySyncedDefaults(result.defaults);
        subPreview = { state: 'ready', family: (result && result.family) || subagentFamily(cli), counts: (result && result.counts) || {} };
        paintSyncStatus();
      } catch (cause) {
        if (closed || seq !== subPreviewSeq || key !== subPreviewKey) return;
        // 503：原生模块是旧的，同步和清除都锁上并说清原因，别让用户以为是自己选错了。
        if (cause && cause.status === 503) noteSubagentFailure(cause);
        else subPreview = { state: 'error', error: (cause && cause.message) || String(cause) };
        paintSyncStatus();
        paintGlobal();
      }
    }

    // 同步 / 清除共用：503 = 原生模块是旧的，锁上同步和清除；其余错误留在状态行。
    function noteSubagentFailure(cause) {
      subSyncUnavailable = subSyncUnavailable || !!(cause && cause.status === 503);
      if (subSyncUnavailable) { resetSyncPreview(); subSyncBox.disabled = true; subNotice = null; return; }
      subNotice = { tone: 'error', text: tt('runConfigClearFailed', '清除失败：{error}', { error: (cause && cause.message) || String(cause) }) };
    }

    // 清除全局默认分两步：先 dry run 说清会恢复几个、几个不受影响（subClearPlan），确认后才真的清 ——
    // 跟随全局的任务由服务端恢复随主，单独设置的不动。
    async function clearGlobal(confirmed) {
      const cli = subCli();
      const family = subagentFamily(cli);
      if (!family || subClearBusy || subSyncUnavailable || closed) return;
      subClearBusy = true;
      subNotice = null;
      paintGlobal(family);
      try {
        const result = await request('/api/subagent-defaults/sync', { cli, subagent: null, dryRun: !confirmed });
        if (closed) return;
        const counts = (result && result.counts) || {};
        subClearPlan = confirmed ? null : { family: (result && result.family) || family, counts };
        if (confirmed) {
          if (result && result.defaults) applySyncedDefaults(result.defaults);
          subNotice = { tone: 'ready', text: tt('runConfigClearDone', '已清除全局子 agent，{n} 个任务恢复随主',
            { n: (Number(counts.applied) || 0) + (Number(counts.deferred) || 0) }) };
          // 这个任务（或草稿）本来跟着全局默认走、这次也没动过下拉：服务端已把它恢复随主，界面跟上，
          // 免得之后点保存又把旧线路当成单独设置存回去。
          if (subagentFollowsGlobal()) { subagentSeed = null; subagentSeedAuto = false; renderSub(true); }
        }
      } catch (cause) {
        if (closed) return;
        subClearPlan = null;
        noteSubagentFailure(cause);
      } finally {
        subClearBusy = false;
        if (!closed) { paintSyncStatus(); paintGlobal(family); }
      }
    }

    // 保存落地后的收尾：勾了「同步」就先发真的同步再关对话框。同步失败 = 任务已经保存，只把同步
    // 留作重试（savedPending）：再点提交走 save() 开头那条分支，只重发同步，不会把保存做两遍。
    async function finishSubagentSync() {
      if (!subSyncBox.checked || subSyncBox.disabled) { dialog.close(); return; }
      const cli = subCli();
      if (!cli || !aiApi.supportsSubagentCli(cli)) { dialog.close(); return; }
      try {
        const result = await request('/api/subagent-defaults/sync', { cli, subagent: collectSubagent() });
        if (result && result.defaults) applySyncedDefaults(result.defaults);
        savedPending = false;
        dialog.close();
      } catch (cause) {
        savedPending = true;
        error.textContent = tt('runConfigSyncSaveFailed', '本任务已保存，但同步失败：{error}',
          { error: (cause && cause.message) || String(cause) });
        submit.textContent = tt('runConfigSyncRetry', '重试同步');
        submit.disabled = false;
        if (cause && cause.status === 503) noteSubagentFailure(cause);
        else subPreview = null;
        paintSyncStatus();
        paintGlobal();
      }
    }

    // force=true 只在套用预设这类「种子真的换了」的场合用；平时由 dataset.seedKey
    // 判断要不要重铺下拉，好让用户在界面上的改动活下来。
    function renderSub(force) {
      const cli = subCli();
      const supported = !!cli && aiApi.supportsSubagentCli(cli) && !terminalDraft;
      show(subSection, supported);
      if (!supported) { delete subProviderSelect.dataset.seedKey; return; }
      const prevProvider = subProviderSelect.value;
      const prevModel = subModelSelect.value === '__custom__' ? subModelCustom.value.trim() : subModelSelect.value;
      const prevCustom = subModelSelect.value === '__custom__';
      const items = [option(doc, '', tt('runConfigSubFollow', '随主（默认）'))];
      for (const provider of providersOf(cli)) {
        if ((cli === 'codex' || cli === 'codex-exp') && provider.isOfficial) continue;
        items.push(option(doc, provider.id, aiApi.providerLabel(provider, false) + limitSuffix(provider)));
      }
      subProviderSelect.replaceChildren(...items);
      const seed = subagentSeed;
      const wanted = seed ? String(seed.providerId || '') : '';
      const seedKey = [cli, wanted, seed ? (seed.model || '') : ''].join('\u0000');
      if (force || subProviderSelect.dataset.seedKey !== seedKey) {
        subProviderSelect.value = items.some(item => item.value === wanted) ? wanted : '';
        fillSubModel(subModelSelect, subModelCustom, cli,
          subProviderSelect.value || primaryProviderId(), seed ? seed.model || '' : '');
        subProviderSelect.dataset.seedKey = seedKey;
        paintSubMeta();
        return;
      }
      // 主 CLI 没变：保住用户在子任务上做的选择，只按新目录把下拉重铺一遍。
      subProviderSelect.value = items.some(item => item.value === prevProvider) ? prevProvider : '';
      fillSubModel(subModelSelect, subModelCustom, cli,
        subProviderSelect.value || primaryProviderId(), prevModel);
      if (prevCustom) { subModelSelect.value = '__custom__'; show(subModelCustom, true); }
      paintSubMeta();
    }

    // Switching the sub-task 线路 only reshuffles the model list for that line —
    // it must not snap the 线路 select back to the saved value.
    function refreshSubLine() {
      const cli = subCli();
      if (!cli || !aiApi.supportsSubagentCli(cli) || terminalDraft) return;
      const current = subModelSelect.value === '__custom__'
        ? subModelCustom.value.trim() : subModelSelect.value;
      fillSubModel(subModelSelect, subModelCustom, cli,
        subProviderSelect.value || primaryProviderId(), current);
      paintSubMeta();
    }

    // ── 渲染：自动挑选 ───────────────────────────────────────────────────────
    function renderAuto() {
      orderRow.set(pick === PICK_ORDER);
      difficultyRow.set(pick === PICK_DIFFICULTY);
      orderRow.node.setAttribute('aria-checked', String(pick === PICK_ORDER));
      difficultyRow.node.setAttribute('aria-checked', String(pick === PICK_DIFFICULTY));
      const difficulty = pick === PICK_DIFFICULTY;
      show(jevHost, difficulty);
      show(tierRow, difficulty);
      tierPrice.setAttribute('aria-checked', String(tiering === PRICE_TIERING));
      tierManual.setAttribute('aria-checked', String(tiering === DEFAULT_TIERING));
      if (difficulty && !jev) {
        jev = jevPanel(doc, {
          routingKey: typeof fetch === 'function' && aiApi.routingKeyApi ? aiApi.routingKeyApi() : null,
          onChange: () => renderFooter(),
        });
        jevHost.append(jev.element);
      }
      poolNote.textContent = difficulty && tiering === PRICE_TIERING
        ? tt('runConfigPoolNoteJev', '交给 Jev：不用标档位')
        : tt('runConfigPoolNote', '拖动排序');
      renderPool();
    }

    function rowModelChoices(row) {
      const state = modelState(row.cli);
      let choices = aiApi.buildModelChoices(row.providerId, state);
      if (!Array.isArray(choices) || !choices.length) choices = ['', '__custom__'];
      return [...new Set(choices)];
    }

    function poolRowView(row, index) {
      const node = el(doc, 'div', 'rc-row');
      node.dataset.providerId = row.providerId;
      node.dataset.cli = row.cli;
      node.draggable = true;
      const rank = el(doc, 'span', 'rc-rank', String(index + 1));
      const main = el(doc, 'div', 'rc-row-main');
      const first = el(doc, 'div', 'rc-row-l1');
      const cliSelect = el(doc, 'select', 'rc-chip rc-row-cli');
      cliSelect.setAttribute('aria-label', tt('runConfigRowCli', '用哪个 CLI 跑这条线路'));
      const line = rowLine(row);
      // 这一行自己的 CLI 永远在列表里、永远是选中的 —— 哪怕它在这个用途下跑不了，
      // 也是「留在原位标出来」而不是让下拉空着。其余能跑的 CLI 排后面，不能跑的
      // 置灰，理由用短标签（长句会被截断成看不懂的半截话）。原生线路（Zen / Go）
      // 只有 OpenCode 能跑，线路名自己已经说了是哪条，所以那颗下拉就只写「OpenCode」，
      // 名字和提示统一使用产品名，旧引擎值只保留在配置里。
      const native = isNativeLine(row.providerId);
      const cliValues = [...new Set([row.cli, ...availableClis().filter(item => item.ok)
        .map(item => !terminalDraft && item.cli === chatChoiceCli(row.cli) ? row.cli : item.cli)])].filter(Boolean);
      for (const choice of cliChoicesForLine(line, cliLabel, cliValues)) {
        const own = choice.cli === row.cli;
        const base = native ? cliLabel(choice.cli) : cliChoiceLabel(choice.cli);
        const label = choice.ok || own ? base : `${cliChoiceLabel(choice.cli)} · ${choice.short}`;
        cliSelect.append(option(doc, choice.cli, label, { disabled: !choice.ok && !own }));
      }
      cliSelect.value = row.cli;
      cliSelect.title = cliChoiceLabel(row.cli);
      cliSelect.onchange = () => {
        row.cli = cliSelect.value;
        // 换 CLI 之后线路的模型候选也换了一份，重新挑一个默认的。
        row.model = '';
        row.autoModel = false;
        renderPool();
      };
      const chip = el(doc, 'span', 'rc-cli-chip');
      chip.append(mark(doc, row.cli, 's'), cliSelect);
      first.append(chip, el(doc, 'b', 'rc-line-name', lineName(row)));
      const rowLimit = isNativeLine(row.providerId) ? null : limitBadge(providerById(row.cli, row.providerId));
      if (rowLimit) first.append(rowLimit);
      const second = el(doc, 'div', 'rc-row-l2');
      const issue = rowIssue(row, line, cliLabel);
      if (issue) {
        node.classList.add('rc-warn');
        second.append(el(doc, 'span', 'rc-issue', `⚠ ${issue.reason}`));
      } else {
        const difficulty = pick === PICK_DIFFICULTY;
        const modelSelect = el(doc, 'select', 'rc-select rc-row-model');
        modelSelect.setAttribute('aria-label', tt('runConfigRowModel', '模型'));
        const custom = el(doc, 'input', 'rc-row-model-custom');
        custom.maxLength = 100;
        const choices = rowModelChoices(row);
        if (difficulty) {
          modelSelect.append(option(doc, AUTO_MODEL_VALUE, tt('runConfigAutoModel', '自动（Jev 挑）')));
        }
        for (const choice of choices) {
          modelSelect.append(option(doc, choice,
            choice === '__custom__' ? tt('runConfigModelCustom', '自定义…') : aiApi.modelChoiceLabel(choice, row.providerId, modelState(row.cli))));
        }
        const wanted = row.autoModel ? AUTO_MODEL_VALUE : (row.model || '');
        const known = wanted === AUTO_MODEL_VALUE || choices.includes(wanted);
        modelSelect.value = known ? wanted : (items => (wanted && items.includes('__custom__') ? '__custom__' : choices[0]))(choices);
        custom.value = wanted === AUTO_MODEL_VALUE || known ? '' : wanted;
        show(custom, modelSelect.value === '__custom__');
        modelSelect.onchange = () => {
          row.autoModel = modelSelect.value === AUTO_MODEL_VALUE;
          row.model = row.autoModel || modelSelect.value === '__custom__' ? '' : modelSelect.value;
          show(custom, modelSelect.value === '__custom__');
          renderFooter();
        };
        custom.oninput = () => { row.model = custom.value.trim(); renderFooter(); };
        second.append(modelSelect, custom);
        if (pick === PICK_DIFFICULTY && tiering === DEFAULT_TIERING) {
          const tierSelect = el(doc, 'select', 'rc-select rc-row-tier');
          tierSelect.setAttribute('aria-label', tt('runConfigRowTier', '档位'));
          for (const value of TIERS) tierSelect.append(option(doc, value, tierLabelOf(value)));
          tierSelect.value = TIERS.includes(row.tier) ? row.tier : 'medium';
          row.tier = tierSelect.value;
          tierSelect.onchange = () => { row.tier = tierSelect.value; renderFooter(); };
          second.append(tierSelect);
        }
      }
      main.append(first, second);
      const ops = el(doc, 'span', 'rc-ops');
      const handle = el(doc, 'button', 'rc-handle', '⠿');
      handle.type = 'button';
      handle.title = tt('runConfigRowDrag', '拖动排序');
      const remove = el(doc, 'button', 'rc-remove', '✕');
      remove.type = 'button';
      remove.title = tt('runConfigRowRemove', '移除这条线路');
      remove.onclick = () => { rows = rows.filter(item => item !== row); renderPool(); renderFooter(); };
      ops.append(handle, remove);
      node.append(rank, main, ops);
      node.ondragstart = event => { dragIndex = index; if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'; };
      node.ondragover = event => { event.preventDefault(); node.classList.add('rc-drop'); };
      node.ondragleave = () => node.classList.remove('rc-drop');
      node.ondrop = event => {
        event.preventDefault();
        node.classList.remove('rc-drop');
        rows = reorder(rows, dragIndex, index);
        dragIndex = -1;
        renderPool();
      };
      return node;
    }

    function tierLabelOf(value) {
      return { simple: tt('runConfigTierSimple', '简单'), medium: tt('runConfigTierMedium', '中等'), complex: tt('runConfigTierComplex', '复杂') }[value] || value;
    }

    let dragIndex = -1;

    function renderPool() {
      poolList.replaceChildren(...rows.map((row, index) => poolRowView(row, index)));
      renderMore();
      // 池子第一行就是 Auto 的主线路，子任务高级块跟着它走（换主/排序要重铺）。
      renderSub();
    }

    function renderMore() {
      const ceiling = Math.max(MIN_ATTEMPTS, Math.min(MAX_ATTEMPTS, rows.length));
      maxSelect.replaceChildren(...[2, 3, 4].map(value => option(doc, String(value), `${value} 条`, { disabled: value > ceiling })));
      if (maxAttempts > ceiling) maxAttempts = ceiling;
      maxSelect.value = String(Math.max(MIN_ATTEMPTS, maxAttempts));
      maxAttempts = Number(maxSelect.value);
      stickyBox.checked = sticky;
      renderPresets();
    }

    function renderPresets() {
      const presets = readPresets();
      presetSelect.replaceChildren(option(doc, '', presets.length
        ? tt('autoEditorPresetPlaceholder', '套用预设…') : tt('autoEditorPresetEmpty', '还没有预设')),
      ...presets.map(item => option(doc, item.id, item.name || tt('runConfigPresetRecent', '最近用过'))));
      if (!presets.some(item => item.id === activePresetId)) activePresetId = '';
      presetSelect.value = activePresetId;
      presetSelect.disabled = !presets.length;
      show(presetDelete, !!activePresetId);
      presetChips.replaceChildren(...presets.map(item => {
        const chip = el(doc, 'span', 'rc-preset-chip');
        const label = item.name || tt('runConfigPresetRecent', '最近用过');
        const remove = el(doc, 'button', 'rc-preset-chip-x', '✕');
        remove.type = 'button';
        remove.title = remove.ariaLabel = `${tt('autoEditorPresetDelete', '删除预设')}：${label}`;
        remove.onclick = () => deletePreset(item.id);
        chip.append(el(doc, 'span', null, label), remove);
        return chip;
      }));
      show(presetChips, presets.length > 0);
    }

    function deletePreset(id) {
      if (!id || !scope().confirm(tt('runConfigPresetDeleteConfirm', '只删除本机预设，不会修改当前线路池。确定删除吗？'))) return;
      if (!writePresets(readPresets().filter(item => item.id !== id))) {
        presetStatus.textContent = tt('runConfigPresetStoreFailed', '预设未能保存到本机，请重试。'); return;
      }
      if (activePresetId === id) activePresetId = '';
      renderPresets();
      presetStatus.textContent = tt('autoEditorPresetDeleted', '预设已删除。');
    }

    function readPresets() {
      try {
        const storage = scope() && scope().localStorage;
        if (!storage) return [];
        const raw = JSON.parse(storage.getItem(PRESET_KEY) || '[]');
        return (Array.isArray(raw) ? raw : []).filter(item => item && Array.isArray(item.candidates) && item.candidates.length >= 2);
      } catch (_) { return []; }
    }

    function writePresets(list) {
      try {
        const storage = scope() && scope().localStorage;
        if (!storage) return false;
        storage.setItem(PRESET_KEY, JSON.stringify(list));
        return true;
      } catch (_) { return false; }
    }

    function showPresetForm(open) {
      show(presetForm, open);
      show(presetOpen, !open);
      if (open) presetName.focus();
    }

    function savePreset() {
      const built = buildAutoSelection({ rows, pick, tiering, routing: jev ? jev.read() : null,
        providers: allProviders(), maxAttempts, sticky });
      if (!built.ok) { presetStatus.textContent = built.error; return; }
      const name = presetName.value.trim();
      if (!name) { presetStatus.textContent = tt('runConfigPresetNameRequired', '请先填写预设名称。'); presetName.focus(); return; }
      const current = readPresets();
      const existing = current.find(item => clean(item.name).toLowerCase() === name.toLowerCase());
      if (existing && !scope().confirm(tt('runConfigPresetOverwrite', '同名预设已存在。覆盖后无法恢复旧组合，确定覆盖吗？'))) return;
      const protocol = rows.map(row => protocolOf(rowLine(row))).find(Boolean) || 'anthropic';
      // 子任务设置（线路 id + 模型，不含任何密钥）跟池子一起存进预设；留空 = 跟随主线路。
      const subagent = collectSubagent();
      const entry = {
        id: existing?.id || `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        name, protocol, pick, tiering, maxAttempts: built.value.maxAttempts,
        sticky: sticky !== false, savedAt: Date.now(),
        candidates: built.value.candidates.map(candidate => ({
          providerId: candidate.providerId, cli: candidate.cli, model: candidate.model || null,
          priority: candidate.priority, ...(candidate.tier ? { tier: candidate.tier } : {}),
          ...(candidate.autoModel ? { autoModel: true } : {}),
        })),
        ...(subagent ? { subagent } : {}),
      };
      // 与 auto-provider-editor 共用原有本机预设目录；不写 key、Jev 端点。
      const named = [entry, ...current.filter(item => !item.recent && item.id !== entry.id
        && clean(item.name).toLowerCase() !== name.toLowerCase())].slice(0, 20);
      if (!writePresets([...named, ...current.filter(item => item.recent)])) {
        presetStatus.textContent = tt('runConfigPresetStoreFailed', '预设未能保存到本机，请重试。');
        return;
      }
      activePresetId = entry.id;
      presetName.value = '';
      showPresetForm(false);
      renderPresets();
      presetStatus.textContent = tt('runConfigPresetSavedDraft', '已存为预设；当前会话还需点击底部“保存”才会生效。');
    }

    // ── 添加线路：按 CLI 分组 ────────────────────────────────────────────────
    function togglePicker() {
      pickerOpen = !pickerOpen;
      renderPicker();
    }

    async function renderPicker() {
      // 弹窗本身是滚动容器：先清空 pickerHost 会让内容变短、scrollTop 被夹回去，
      // 随后 focus() 又会把搜索框滚进视野 —— 用户看到的就是「滑着滑着弹回开头」。
      const keepTop = dialog.scrollTop;
      const keepFilter = pickerListHost ? pickerListHost.scrollTop : 0;
      pickerHost.replaceChildren();
      show(pickerHost, pickerOpen);
      addButton.classList.toggle('on', pickerOpen);
      if (!pickerOpen) { pickerListHost = null; return; }
      const search = el(doc, 'input', 'rc-search');
      search.type = 'search';
      search.placeholder = tt('runConfigSearchLine', '搜索线路或模型…');
      search.value = pickerFilter;
      search.oninput = () => { pickerFilter = search.value; renderPickerList(); };
      pickerListHost = el(doc, 'div', 'rc-picker-list');
      pickerHost.append(search, pickerListHost);
      if (!pickerData) {
        pickerListHost.append(el(doc, 'p', 'rc-faint', tt('runConfigLoading', '正在读取线路…')));
        pickerData = await loadPickerData();
      }
      renderPickerList();
      if (pickerListHost) pickerListHost.scrollTop = keepFilter;
      dialog.scrollTop = keepTop;
      try { search.focus({ preventScroll: true }); } catch (_) { search.focus(); }
      dialog.scrollTop = keepTop;
    }

    function loadPickerData() {
      const wanted = availableClis().filter(item => item.ok).map(item => item.cli);
      return Promise.all(wanted.map(cli => {
        if (cli === 'opencode') {
          const natives = aiApi.openCodeNativeProviders();
          if (!natives.length) {
            aiApi.refreshOpenCodeModels(() => { if (pickerOpen) { pickerData = null; renderPicker(); } });
          }
          return { cli, native: true, error: false, items: natives.map(item => ({
            providerId: item.value, cli, model: '',
            label: item.label.replace(/^OpenCode 原生 · /, ''),
          })) };
        }
        return loadCatalog(cli).then(catalog => ({
          cli,
          native: false,
          error: false,
          items: catalogApi.providersForCli(catalog, cli).map(provider => ({
            providerId: String(provider.id), cli, model: provider.model || '', label: provider.name || provider.id,
            provider,
          })),
        }), () => ({ cli, native: false, error: true, items: [] }));
      }));
    }

    function renderPickerList() {
      const host = pickerListHost;
      if (!host) return;
      const keepScroll = host.scrollTop;
      host.replaceChildren();
      const pooled = new Set(rows.map(row => `${row.cli}\n${row.providerId}`));
      const needle = pickerFilter.trim().toLowerCase();
      for (const group of pickerData || []) {
        const items = group.items.filter(item => !needle || `${item.label} ${item.model}`.toLowerCase().includes(needle));
        if (group.error) {
          const head = el(doc, 'div', 'rc-picker-group');
          head.append(mark(doc, group.cli, 's'), el(doc, 'span', null, cliChoiceLabel(group.cli)));
          host.append(head);
          const failure = el(doc, 'div', 'rc-picker-error');
          failure.append(el(doc, 'span', null, tt('runConfigLoadFailed', '线路列表加载失败')));
          const retry = el(doc, 'button', 'rc-retry', tt('runConfigRetry', '重试'));
          retry.type = 'button';
          retry.onclick = () => { catalogErrors.delete(group.cli); pickerData = null; renderPicker(); };
          failure.append(retry);
          host.append(failure);
          continue;
        }
        if (!items.length) continue;
        const head = el(doc, 'div', 'rc-picker-group');
        head.append(mark(doc, group.cli, 's'), el(doc, 'span', null, cliChoiceLabel(group.cli)));
        if (group.native) head.append(el(doc, 'em', null, tt('runConfigNativeNote', '上面的线路也都能跑')));
        host.append(head);
        for (const item of items) {
          const rowNode = el(doc, 'button', 'rc-picker-item');
          rowNode.type = 'button';
          const already = pooled.has(`${item.cli}\n${item.providerId}`);
          if (already) rowNode.classList.add('is-pooled');
          rowNode.append(
            el(doc, 'span', 'rc-picker-name', item.label),
            el(doc, 'span', 'rc-picker-model', item.model || ''),
          );
          const itemLimit = limitBadge(item.provider);
          if (itemLimit) rowNode.append(itemLimit);
          if (already) rowNode.append(el(doc, 'span', 'rc-picker-right', `✓ ${tt('runConfigInPool', '已在池里')}`));
          rowNode.onclick = () => addRow(item);
          host.append(rowNode);
        }
      }
      host.scrollTop = keepScroll;
    }

    function addRow(item) {
      rows = [...rows, {
        providerId: item.providerId, cli: item.cli, model: item.model || '', customModel: '',
        autoModel: false, tier: 'medium', name: item.label, enabled: true,
      }];
      renderPool();
      renderPickerList();
      renderFooter();
    }

    function defaultRows() {
      const list = providersOf(currentCli);
      const picks = list.filter(provider => provider.isOfficial !== true).slice(0, 2);
      return picks.map(provider => ({
        providerId: String(provider.id), cli: currentCli, model: provider.model || '', customModel: '',
        autoModel: false, tier: 'medium', name: provider.name || provider.id, enabled: true,
      }));
    }

    async function applyPreset(id) {
      const preset = readPresets().find(item => item.id === id);
      if (!preset) return;
      if (!scope().confirm(tt('runConfigPresetReplaceDraft', '套用预设会替换当前未保存的线路池草稿；当前会话不会立即改变。确定套用吗？'))) {
        presetSelect.value = activePresetId;
        return;
      }
      const nextRows = (preset.candidates || []).map(candidate => ({
        providerId: String(candidate.providerId || ''),
        cli: candidate.cli || (isNativeLine(candidate.providerId) ? 'opencode' : currentCli),
        model: candidate.model || '', customModel: '', autoModel: candidate.autoModel === true,
        tier: candidate.tier === 't2' ? 'medium' : candidate.tier === 't3' ? 'complex' : 'simple',
        name: '', enabled: true,
      }));
      const available = new Set(availableClis().filter(item => item.ok).map(item => item.cli));
      for (const cli of new Set(nextRows.map(row => row.cli))) {
        if (!available.has(cli)) { presetStatus.textContent = tt('runConfigPresetLineUnavailable', '预设中的线路或 CLI 已不可用，未套用。'); presetSelect.value = activePresetId; return; }
        if (nextRows.some(row => row.cli === cli && !isNativeLine(row.providerId))) {
          try { await loadCatalog(cli); } catch (_) { presetStatus.textContent = tt('runConfigPresetLineUnavailable', '预设中的线路或 CLI 已不可用，未套用。'); presetSelect.value = activePresetId; return; }
        }
      }
      if (nextRows.some(row => isNativeLine(row.providerId)
        ? !aiApi.openCodeNativeProviders().some(item => item.value === row.providerId)
        : !!rowIssue(row, rowLine(row), cliLabel))) {
        presetStatus.textContent = tt('runConfigPresetLineUnavailable', '预设中的线路或 CLI 已不可用，未套用。');
        presetSelect.value = activePresetId;
        return;
      }
      rows = nextRows;
      if (preset.pick === PICK_ORDER || preset.pick === PICK_DIFFICULTY) pick = preset.pick;
      if (preset.tiering === PRICE_TIERING || preset.tiering === DEFAULT_TIERING) tiering = preset.tiering;
      if (preset.maxAttempts) maxAttempts = Number(preset.maxAttempts);
      if (preset.sticky != null) sticky = preset.sticky !== false;
      // 预设里的子任务设置（老预设没有这一段 = 跟随主线路）。
      subagentSeed = preset.subagent && preset.subagent.model ? preset.subagent : null;
      // 套用预设是用户明确的一次选择：之后切 CLI 别再拿家族默认盖掉它。
      subagentTouched = true;
      subagentSeedAuto = false;
      subagentSeedFamily = subagentFamily(subCli());
      activePresetId = id;
      renderAuto();
      renderSub(true);
      renderFooter();
      presetStatus.textContent = tt('runConfigPresetAppliedDraft', '已套用草稿；检查线路后点击底部“保存”。');
    }

    // ── 页脚 / 忙闲 / 子任务 ────────────────────────────────────────────────
    function currentModelValue() {
      return modelSelect.value === '__custom__' ? modelCustom.value.trim() : modelSelect.value;
    }

    function renderFooter() {
      if (mode === MODE_FIXED) {
        const label = providerless(currentCli)
          ? ''
          : (lineItems().find(item => item.value === providerValue) || {}).label || '';
        const model = currentModelValue();
        const account = pickedAccount();
        footCopy.textContent = [cliLabel(currentCli), label, model, account && accountTitle(account)].filter(Boolean).join(' · ');
      } else {
        footCopy.textContent = tt('runConfigSummaryAuto', '{n} 条线路 · 跨 {m} 个 CLI', {
          n: rows.length,
          m: new Set(rows.map(row => chatChoiceCli(row.cli))).size,
        });
      }
      // 主线路换了（模式切换不重铺子任务块时也走这里）：同步预览按新组合重问。
      queueSyncPreview();
    }

    function setBusy(value) {
      loading = value;
      submit.disabled = value;
      for (const button of cliGrid.querySelectorAll('button')) button.disabled = value;
    }

    function collectSubagent() {
      const cli = subCli();
      if (terminalDraft || !cli || !aiApi.supportsSubagentCli(cli)) return null;
      const model = subModelSelect.value === '__custom__' ? subModelCustom.value.trim() : subModelSelect.value;
      return aiApi.resolveSubagent({
        cli,
        providerId: subProviderSelect.value,
        primaryProviderId: primaryProviderId(),
        model,
      });
    }

    // ── 保存 ────────────────────────────────────────────────────────────────
    async function save() {
      // 上一次提交已经把任务/草稿保存好了，只剩同步失败：这一次只重试同步。
      if (savedPending) { await finishSubagentSync(); return; }
      if (mode === MODE_FIXED) {
        const patch = buildFixedPatch({ cli: currentCli, providerId: providerValue,
          model: currentModelValue(), effort: effortValue });
        if (!patch.ok) throw new Error(patch.error);
        const subagent = collectSubagent();
        const providerName = (providersOf(currentCli).find(item => String(item.id) === String(patch.value.provider)) || {}).name || null;
        if (draft) {
          const picks = Object.fromEntries(Object.entries(accountPicks).filter(([, id]) => id));
          await onSaved({ cli: currentCli, provider: patch.value.provider, providerSelection: null,
            model: patch.value.model, effort: patch.value.effort, providerName, subagent,
            ...(subagentFollowsGlobal(subagent) ? { subagentInherited: true } : {}),
            cliAccounts: Object.keys(picks).length ? picks : null });
          await finishSubagentSync();
          return;
        }
        const base = `/api/sessions/${encodeURIComponent(entry.sessionId)}`;
        if (currentCli !== config.cli) await request(`${base}/switch-cli`, { cli: currentCli });
        // Provider and model form one choice. Splitting them lets a turn start
        // between saves, or lets an old model overwrite the new route's default.
        await request(base, {
          ...(!providerless(currentCli) ? { provider: patch.value.provider, providerSelection: null } : {}),
          model: patch.value.model, effort: patch.value.effort, subagent,
          // switch-cli 可能刚把目标家族的默认标成 inherited；这里跟同一份线路，
          // 明确带上标记，避免 PATCH 把它降成单独设置。
          ...(subagentFollowsGlobal(subagent) ? { subagentInherited: true } : {}),
          ...(accountPatch() ? { cliAccounts: accountPatch() } : {}),
        }, 'PATCH');
        await onSaved();
        await finishSubagentSync();
        return;
      }
      const built = buildAutoSelection({
        rows, pick, tiering, routing: jev ? jev.read() : null,
        providers: allProviders(), maxAttempts, sticky,
      });
      if (!built.ok) throw new Error(built.error);
      const selection = built.value;
      const primary = selection.candidates[0];
      // 子任务的高级设置和固定一条共用：留空 = 跟随主线路（resolveSubagent 会给 null）。
      const subagent = collectSubagent();
      if (draft) {
        await onSaved({ cli: primary.cli, provider: primary.providerId, providerSelection: selection,
          model: primary.model || null, effort: null, subagent,
          ...(subagentFollowsGlobal(subagent) ? { subagentInherited: true } : {}) });
        await finishSubagentSync();
        return;
      }
      const base = `/api/sessions/${encodeURIComponent(entry.sessionId)}`;
      if (!selection.candidates.some(candidate => candidate.cli === currentCli)) {
        await request(`${base}/switch-cli`, { cli: primary.cli });
      }
      await request(base, { provider: primary.providerId, providerSelection: selection }, 'PATCH');
      await request(base, { model: primary.model || null, subagent,
        ...(subagentFollowsGlobal(subagent) ? { subagentInherited: true } : {}) }, 'PATCH');
      await onSaved();
      await finishSubagentSync();
    }

    // ── 交互 ────────────────────────────────────────────────────────────────
    // 自持账号 CLI 的模型目录是异步拉的（qoder --list-models 1 天缓存、
    // codebuddy --help 1 小时缓存）；冷缓存先按内置表画，拉回来再画一遍。
    // OpenCode 的原生线路同理，但只在认不出任何原生线路时才补拉。
    function warmNativeModels(cli, marker) {
      const rebuild = () => { if (marker === epoch) { renderFixed(); renderFooter(); } };
      if (cli === 'opencode') {
        if (!aiApi.openCodeNativeProviders().length) aiApi.refreshOpenCodeModels(rebuild);
      } else if (cli === 'qoder') aiApi.refreshQoderModels(rebuild);
      else if (cli === 'codebuddy') aiApi.refreshCodebuddyModels(rebuild);
      else if (cli === 'commandcode') aiApi.refreshCommandcodeModels(rebuild);
      else if (cli === 'grok') aiApi.refreshGrokModels(rebuild);
    }

    function selectCli(cli) {
      cliSwitched = true;
      if (stopModelWatch) stopModelWatch();
      stopModelWatch = null;
      modelWatchKey = '';
      currentCli = cli;
      providerValue = '';
      modelValue = '';
      error.textContent = '';
      setBusy(true);
      const current = ++epoch;
      // 模型缓存与线路目录互不依赖（自持车道甚至没有线路目录），先拉起来。
      warmNativeModels(cli, current);
      loadCatalog(cli).then(() => {
        if (current !== epoch) return;
        providers = providersOf(cli);
        setBusy(false);
        renderFixed();
        // 草稿或已有会话在对话框里换了 CLI（可能换了家族）：没动过子 agent 就按新家族的默认预填。
        if (seedDraftSubagent()) renderSub(true);
        renderFooter();
      }, () => {
        if (current !== epoch) return;
        providers = [];
        setBusy(false);
        renderFixed();
        renderFooter();
      });
    }

    fixedButton.onclick = () => {
      if (mode === MODE_FIXED) return;
      mode = MODE_FIXED;
      renderModes();
      renderFooter();
    };
    autoButton.onclick = () => {
      if (mode === MODE_AUTO) return;
      mode = MODE_AUTO;
      if (!rows.length) rows = defaultRows();
      renderModes();
      renderAuto();
      renderFooter();
    };
    orderRow.node.onclick = () => {
      if (pick === PICK_ORDER) return;
      pick = PICK_ORDER;
      // 按顺序没有 Jev，就没有「自动（Jev 挑）」这一项 —— 老行折回「线路默认」。
      rows = rows.map(row => ({ ...row, autoModel: false, model: row.autoModel ? '' : row.model }));
      renderAuto();
      renderFooter();
    };
    difficultyRow.node.onclick = () => {
      if (pick === PICK_DIFFICULTY) return;
      pick = PICK_DIFFICULTY;
      renderAuto();
      renderFooter();
    };
    tierPrice.onclick = () => {
      if (tiering === PRICE_TIERING) return;
      tiering = PRICE_TIERING;
      renderAuto();
      renderFooter();
    };
    tierManual.onclick = () => {
      if (tiering === DEFAULT_TIERING) return;
      tiering = DEFAULT_TIERING;
      rows = rows.map((row, index) => ({ ...row, tier: row.tier || (index % 2 ? 'complex' : 'simple') }));
      renderAuto();
      renderFooter();
    };
    addButton.onclick = () => togglePicker();
    maxSelect.onchange = () => { maxAttempts = Number(maxSelect.value); renderFooter(); };
    stickyBox.onchange = () => { sticky = stickyBox.checked; };
    presetSelect.onchange = () => {
      const id = presetSelect.value;
      if (id) applyPreset(id);
      else { activePresetId = ''; show(presetDelete, false); }
    };
    presetOpen.onclick = () => { presetStatus.textContent = ''; showPresetForm(true); };
    presetCancel.onclick = () => showPresetForm(false);
    presetSave.onclick = () => savePreset();
    // 输入法组字时按回车是「确认候选词」，不是提交：不拦的话敲一两个拼音就触发保存，
    // 名字没打完就走了校验/保存流程。
    presetName.onkeydown = event => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      if (event.isComposing || event.keyCode === 229) return;
      savePreset();
    };
    presetDelete.onclick = () => deletePreset(activePresetId);
    lineSelect.onchange = () => {
      providerValue = lineSelect.value;
      modelValue = '';
      renderModel();
      renderSub();
      renderAccount();
      renderFooter();
    };
    modelSelect.onchange = () => {
      modelValue = currentModelValue();
      show(modelCustom, modelSelect.value === '__custom__');
      if (modelSelect.value === '__custom__') modelCustom.focus();
      renderFooter();
    };
    modelCustom.oninput = () => { modelValue = currentModelValue(); renderFooter(); };
    // 手动刷新 opencode 模型表：绕过两层缓存重新读本机 CLI。当前选中的模型原样
    // 保留 —— 即使它已经下架，换不换、换成哪个得由用户决定，这里只把真实列表摆出来。
    modelRefresh.onclick = async event => {
      if (event) { event.preventDefault(); event.stopPropagation(); }
      if (modelRefresh.disabled) return;
      const selected = currentModelValue();
      modelRefresh.disabled = true;
      modelRefresh.textContent = tt('runConfigModelRefreshing', '刷新中…');
      let models = [];
      try { models = await aiApi.refreshOpenCodeModels(null, { force: true }); } catch (_) { models = []; }
      if (!closed) {
        fillModel(modelSelect, modelCustom, providerValue, currentCli, selected);
        modelValue = currentModelValue();
        modelStatus.textContent = models.length
          ? tt('runConfigModelRefreshed', '模型列表已刷新：{count} 个', { count: models.length })
          : tt('runConfigModelRefreshFailed', '刷新失败，请稍后重试');
        modelStatus.hidden = false;
        renderFooter();
      }
      modelRefresh.disabled = false;
      modelRefresh.textContent = tt('runConfigModelRefresh', '刷新模型');
    };
    subProviderSelect.onchange = () => {
      markSubagentTouched();
      dismissSubGuide();
      refreshSubLine();
    };
    subModelSelect.onchange = () => {
      markSubagentTouched();
      dismissSubGuide();
      show(subModelCustom, subModelSelect.value === '__custom__');
      if (subModelSelect.value === '__custom__') subModelCustom.focus();
      paintSubMeta();
    };
    subModelCustom.oninput = () => { markSubagentTouched(); paintSubMeta(); };
    // 首次强提示的两颗按钮：一个直接把人送到线路下拉，一个只是收掉提示。
    subGuideApply.onclick = () => {
      dismissSubGuide();
      subProviderSelect.focus();
    };
    subGuideDismiss.onclick = () => dismissSubGuide();
    // 「同步」每次打开都是不勾的；勾上先跑 dry run 说清楚会改几个任务。
    subSyncBox.onchange = () => {
      subNotice = null;
      if (subSyncBox.checked) {
        subPreviewKey = '';
        subPreview = { state: 'loading' };
        paintSyncStatus();
        queueSyncPreview();
      } else {
        resetSyncPreview();
        paintSyncStatus();
      }
    };
    subClear.onclick = () => { clearGlobal(false); };
    subClearConfirm.onclick = () => { clearGlobal(true); };
    subClearCancel.onclick = () => { subClearPlan = null; paintGlobal(); };
    form.onsubmit = async event => {
      event.preventDefault();
      if (loading) return;
      submit.disabled = true;
      error.textContent = '';
      try {
        await save();
      } catch (cause) {
        error.textContent = cause.message;
        submit.disabled = false;
      }
    };

    // ── 启动 ────────────────────────────────────────────────────────────────
    async function boot() {
      if (!accountPicksReady) {
        request(`/api/sessions/${encodeURIComponent(entry.sessionId)}`, undefined, 'GET').then(
          (detail) => { accountPicks = { ...(detail && detail.cliAccounts || {}), ...accountPicks }; },
          () => { /* 读不到现值：只写用户动过的车道，保持安全 */ },
        ).then(() => { accountPicksReady = true; renderAccount(); renderFooter(); });
      }
      setBusy(true);
      try { await loadCatalog(currentCli); } catch (_) { /* 渲染里会把失败说出来 */ }
      providers = providersOf(currentCli);
      const items = lineItems();
      let desired = clean(config.provider);
      // provider 为空 + 模型是 `<id>/<model>`：这是 OpenCode 自己的线路（保存时就是这么
      // 写的）。原生线路表第一次打开时可能还没拉回来，先记下来，等它到了再切过去。
      const nativeFromModel = currentCli === 'opencode' && !desired ? String(config.model || '').split('/')[0] : '';
      if (nativeFromModel) {
        pendingNative = nativeLineValue(nativeFromModel);
        desired = pendingNative;
      }
      if (!desired && !providerless(currentCli)) {
        const official = officialFor(currentCli);
        desired = official ? official.id : '';
      }
      providerValue = items.some(item => item.value === desired) ? desired : (items[0] ? items[0].value : '');
      effortValue = config.effort || null;
      setBusy(false);
      renderModes();
      renderFixed();
      // 草稿没带子 agent：这一族有默认就预填一次（用户动过下拉则不碰）。
      if (seedDraftSubagent()) renderSub(true);
      renderAuto();
      renderFooter();
      warmOtherClis();
      // 自持账号 CLI（qoder/codebuddy）与 OpenCode 原生线路的模型目录是异步缓存；
      // 第一次打开是冷的，拉回来之后重画一遍 —— 上面记下的 pendingNative 这时才认得出。
      warmNativeModels(currentCli, epoch);
    }

    async function warmOtherClis() {
      const wanted = new Set([...availableClis().filter(item => item.ok).map(item => item.cli),
        ...rows.map(row => row.cli)].filter(Boolean));
      for (const cli of wanted) {
        if (cli === currentCli || catalogs.has(cli)) continue;
        const current = epoch;
        try { await loadCatalog(cli); } catch (_) { /* 计数位会显示加载失败 */ }
        if (current !== epoch) return;
        renderCliCards();
        // Stored pools may include another product or an older compatible ID.
        // Refresh those rows when their catalog arrives, clearing stale warnings.
        renderPool();
      }
    }

    if (config.providerSelection && config.providerSelection.mode === 'auto') {
      mode = MODE_AUTO;
      pick = initialPick();
      tiering = initialTiering();
      rows = initialRows();
      maxAttempts = Number(config.providerSelection.maxAttempts) || MIN_ATTEMPTS;
      sticky = config.providerSelection.sticky !== false;
    }
    boot();
    return dialog;
  }

  return Object.freeze({
    AUTO_CLIS,
    AUTO_MODEL_VALUE,
    CLI_PROTOCOLS,
    CREDENTIAL_CLIS,
    DEFAULT_TIERING,
    MAX_ATTEMPTS,
    MIN_ATTEMPTS,
    MODE_AUTO,
    MODE_FIXED,
    NATIVE_PREFIX,
    PICK_DIFFICULTY,
    PICK_ORDER,
    PRESET_KEY,
    PRICE_TIERING,
    SUBAGENT_GUIDE_KEY,
    TIERS,
    TIER_KEYS,
    buildAutoSelection,
    buildFixedPatch,
    clearSummary,
    cliChoicesForLine,
    cliLineVerdict,
    guideSeen,
    isNativeLine,
    lineShape,
    markGuideSeen,
    nativeLineId,
    nativeLineValue,
    normalizeSubagentRoute,
    openCodeRouteName,
    open,
    pillModel,
    pillText,
    protocolOf,
    reorder,
    rowIssue,
    sameSubagentRoute,
    subagentDefaultFor,
    subagentFamily,
    subagentFamilyLabel,
    syncSummary,
  });
});
