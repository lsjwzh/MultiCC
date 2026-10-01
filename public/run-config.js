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

  // 一条线路的规范化形状：固定模式从线路下拉里选出来的值（可能是 opencode-native:
  // 前缀、也可能是一个 Provider id）折成这个形状，后面的兼容判定只看它。
  function lineShape(value, provider) {
    if (isNativeLine(value)) {
      return { id: clean(value), native: true, protocol: null, hasToken: false, baseUrl: '' };
    }
    const source = provider || {};
    return {
      id: clean(value),
      native: false,
      protocol: protocolOf(source),
      hasToken: source.hasToken === true,
      baseUrl: clean(source.baseUrl),
    };
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

  // 池子里一行的问题（null = 没问题）。老配置里已经用不了的组合不静默丢掉，
  // 留在原位标黄把原因说出来，保存时才拦。
  function rowIssue(row, line, label) {
    if (!row) return null;
    if (!line) return { code: 'missing_line', reason: '这条线路已经不在线路表里了' };
    const verdict = cliLineVerdict(row.cli, line, label);
    if (verdict.ok) return null;
    return { code: verdict.code, reason: `${verdict.reason} —— 换个 CLI 或移除这一行` };
  }

  // 能把某条线路跑起来的所有 CLI，附「能不能跑」和一句短理由 —— 行上那颗 CLI
  // 小下拉就用这个列表（不能跑的置灰说明原因）。调用方必须把这一行自己的 CLI
  // 传进来：跑不了的组合要留在原位标出来，而不是让下拉空着。
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
      allowCrossTrust: crossesTrust(candidates, providers) && draft.crossTrustConfirmed === true,
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
    if (crossesTrust(candidates, providers) && draft.crossTrustConfirmed !== true) {
      return fail('这份池子同时用了官方账号和别人配的线路，需要确认后再保存。',
        'cross_trust_confirmation_required');
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
    const native = catalog && catalog.nativeRouteLabel ? catalog.nativeRouteLabel(next.cli) : '';
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
        text: [currentRouteLabel(pickLabel, count), pending ? pendingLabel : ''].filter(Boolean).join(' · '),
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

  function currentRouteLabel(pick, count) {
    const pickLabel = pick === PICK_DIFFICULTY ? '按难度' : '按顺序';
    return `⚡ 自动 · ${pickLabel} · ${count} 条`;
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

  function el(doc, tag, className, text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function show(node, visible) {
    if (node) node.hidden = !visible;
    return node;
  }

  function option(doc, value, label, { disabled = false } = {}) {
    const item = el(doc, 'option', null, label);
    item.value = value;
    item.disabled = disabled;
    return item;
  }

  function segment(doc, className, label) {
    const group = el(doc, 'div', `rc-seg ${className}`);
    if (label) {
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', label);
    }
    return group;
  }

  function segButton(doc, group, className, text, label) {
    const button = el(doc, 'button', `rc-seg-btn ${className}`, text);
    button.type = 'button';
    button.setAttribute('aria-checked', 'false');
    if (label) button.title = label;
    group.append(button);
    return button;
  }

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

  // The engine name minus the family word it repeats: "Claude Agent SDK" under
  // the family "Claude" is just "Agent SDK"; "Codex App Server" under "Codex" is
  // "App Server". Returns '' when the engine says nothing the family doesn't
  // already say (the plain lane's engine is its own id).
  function shortEngine(family, engine, id) {
    const value = String(engine || '').trim();
    if (!value) return '';
    const lower = value.toLowerCase();
    const fam = String(family || '').toLowerCase();
    if (lower === fam || lower === String(id || '').toLowerCase()) return '';
    if (fam && lower.startsWith(fam + ' ')) return value.slice(fam.length + 1).trim();
    return value;
  }

  // 一行文字里的 CLI 名字。家族名分不开同一家族的两条车道（claude / claude-exp
  // 都叫 Claude，codex / codex-exp 都叫 Codex），所以凡是只有一行位置的地方
  // （下拉选项、分组标题）都补上引擎当区分 —— 但引擎里重复家族名的那截要去掉，
  // 不然就成了「Codex · Codex App Server」：`Codex` / `Codex · App Server`，
  // `Claude` / `Claude · Agent SDK`。家族名已经是唯一区分的（zcode / kimi）就
  // 不补后缀。
  function cliChoiceLabel(cli) {
    const family = cliLabel(cli);
    const catalog = scope() && scope().MultiCCProviderCatalog;
    const engine = catalog && catalog.cliEngine ? catalog.cliEngine(cli) : '';
    const suffix = shortEngine(family, engine, clean(cli));
    return suffix ? `${family} · ${suffix}` : family;
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
        throw new Error(result.message || result.error || result.code || `请求失败（${response.status}）`);
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
    let currentCli = config.cli || cliList[0] || 'claude';
    let providers = [];
    let providerValue = '';
    let customModelValue = '';
    let effortValue = null;
    let pick = PICK_ORDER;
    let tiering = DEFAULT_TIERING;
    let rows = [];
    let maxAttempts = MIN_ATTEMPTS;
    let sticky = true;
    let crossTrustConfirmed = false;
    let jev = null;
    let loading = false;
    let epoch = 0;
    const catalogs = new Map();
    const catalogErrors = new Map();
    let pendingNative = '';
    let pickerOpen = false;
    let pickerFilter = "";
    let pickerData = null;
    let pickerListHost = null;

    function loadCatalog(cli) {
      if (catalogs.has(cli)) return Promise.resolve(catalogs.get(cli));
      if (catalogErrors.has(cli)) return Promise.reject(catalogErrors.get(cli));
      return request(`/api/providers?cli=${encodeURIComponent(cli)}`, undefined, 'GET').then(raw => {
        const catalog = catalogApi.normalizeCatalog(raw);
        catalogs.set(cli, catalog);
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
      return `${provider.name || provider.id}${provider.model ? ` · ${provider.model}` : ''}`;
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
    const modelField = el(doc, 'label', 'rc-field rc-model-field');
    modelField.append(el(doc, 'span', null, tt('runConfigModelLabel', '模型')));
    const modelSelect = el(doc, 'select', 'rc-model');
    modelSelect.setAttribute('aria-label', tt('runConfigModelLabel', '模型'));
    const modelCustom = el(doc, 'input', 'rc-model-custom');
    modelCustom.maxLength = 100;
    modelCustom.placeholder = tt('runConfigModelPlaceholder', '自定义模型…');
    modelField.append(modelSelect, modelCustom);
    lineRow.append(lineField, modelField);
    const effortField = el(doc, 'div', 'rc-field rc-effort-field');
    effortField.append(el(doc, 'span', null, tt('runConfigEffortLabel', '推理强度')));
    const effortSeg = segment(doc, 'rc-efforts', tt('runConfigEffortLabel', '推理强度'));
    effortField.append(effortSeg);
    const fixedStatus = el(doc, 'p', 'air-config-status');
    fixedStatus.setAttribute('role', 'status');
    const advanced = el(doc, 'details', 'rc-advanced');
    const advancedSummary = el(doc, 'summary', null, tt('runConfigAdvanced', '高级：子任务线路 / 模型'));
    const advancedBody = el(doc, 'div', 'rc-advanced-body');
    const subRow = el(doc, 'div', 'rc-two');
    const subProviderField = el(doc, 'label', 'rc-field');
    subProviderField.append(el(doc, 'span', null, tt('runConfigSubProvider', '子任务线路')));
    const subProviderSelect = el(doc, 'select', 'rc-sub-provider');
    subProviderSelect.setAttribute('aria-label', tt('runConfigSubProvider', '子任务线路'));
    subProviderField.append(subProviderSelect);
    const subModelField = el(doc, 'label', 'rc-field');
    subModelField.append(el(doc, 'span', null, tt('runConfigSubModel', '子任务模型')));
    const subModelSelect = el(doc, 'select', 'rc-sub-model');
    subModelSelect.setAttribute('aria-label', tt('runConfigSubModel', '子任务模型'));
    const subModelCustom = el(doc, 'input', 'rc-sub-model-custom');
    subModelCustom.maxLength = 100;
    subModelField.append(subModelSelect, subModelCustom);
    subRow.append(subProviderField, subModelField);
    advancedBody.append(subRow, el(doc, 'p', 'rc-note', tt('runConfigSubHint', '子任务留空就是跟随主线路。')));
    advanced.append(advancedSummary, advancedBody);
    fixedSection.append(fixedHead, cliGrid, lineRow, effortField, fixedStatus, advanced);
    form.append(fixedSection);

    // 自动挑选
    const autoSection = el(doc, 'section', 'air-config-section rc-auto');
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
    autoSection.append(pickHead, pickList, jevHost, tierRow);

    const poolHead = el(doc, 'div', 'air-config-section-head');
    const poolTitle = el(doc, 'h3', null, tt('runConfigPoolHead', '线路池'));
    const poolNote = el(doc, 'p', null, tt('runConfigPoolNote', '拖动排序'));
    poolHead.append(poolTitle, poolNote);
    const poolList = el(doc, 'div', 'rc-pool');
    const addButton = el(doc, 'button', 'rc-add', `＋ ${tt('runConfigAddLine', '添加线路')}`);
    addButton.type = 'button';
    const pickerHost = el(doc, 'div', 'rc-picker-host');
    const more = el(doc, 'details', 'rc-more');
    const moreSummary = el(doc, 'summary', null, tt('runConfigMore', '更多：最多试几条 / 粘住上次成功 / 预设'));
    const moreBody = el(doc, 'div', 'rc-more-body');
    const maxField = el(doc, 'label', 'rc-field');
    maxField.append(el(doc, 'span', null, tt('runConfigMaxAttempts', '最多试几条')));
    const maxSelect = el(doc, 'select', 'rc-max-attempts');
    maxField.append(maxSelect);
    const stickyLabel = el(doc, 'label', 'rc-check');
    const stickyBox = el(doc, 'input');
    stickyBox.type = 'checkbox';
    stickyLabel.append(stickyBox, el(doc, 'span', null, tt('runConfigSticky', '粘住上次成功的线路')));
    const presetField = el(doc, 'label', 'rc-field');
    presetField.append(el(doc, 'span', null, tt('runConfigPreset', '预设')));
    const presetSelect = el(doc, 'select', 'rc-preset');
    presetField.append(presetSelect);
    moreBody.append(maxField, stickyLabel, presetField);
    more.append(moreSummary, moreBody);
    autoSection.append(poolHead, poolList, addButton, pickerHost, more);
    form.append(autoSection);
    const crossTrustLabel = el(doc, 'label', 'rc-cross-trust');
    const crossTrustBox = el(doc, 'input');
    crossTrustBox.type = 'checkbox';
    crossTrustLabel.append(crossTrustBox, el(doc, 'span', null,
      tt('runConfigCrossTrust', '这份池子混用了「官方账号」和别人配的线路，我确认要这样跑。')));
    autoSection.append(crossTrustLabel);

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
    dialog.onclose = () => dialog.remove();

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
      const list = [...new Set([...AUTO_CLIS, config.cli, ...known].filter(Boolean))];
      return list.map(cli => {
        if (cli === config.cli || known.has(cli)) {
          return offersIn(cli)
            ? { cli, ok: true, reason: '' }
            : { cli, ok: false, reason: cliPurposeReason(cli) };
        }
        return { cli, ok: false, reason: tt('runConfigCliMissing', '未安装') };
      });
    }

    // 卡片的第二行：家族名分不开两条车道（Claude / Claude Agent SDK、Codex /
    // Codex App Server），所以这里说引擎，后面再带上有几条可用的线路。引擎就是
    // 车道的 id 时（zcode / kimi / 终端里的 claude）不重复念一遍。
    function cliCardCopy(cli) {
      if (providerless(cli)) return tt('runConfigCliOwnAccount', '使用 {name} 自己的账号', { name: cliLabel(cli) });
      const catalog = catalogs.get(cli);
      if (!catalog && !catalogErrors.has(cli)) return '…';
      const engine = catalogApi.cliEngine ? catalogApi.cliEngine(cli) : '';
      const head = shortEngine(cliLabel(cli), engine, clean(cli));
      if (catalogErrors.has(cli)) return [head, tt('runConfigLoadFailedShort', '加载失败')].filter(Boolean).join(' · ');
      const count = providersOf(cli).length + (cli === 'opencode' ? aiApi.openCodeNativeProviders().length : 0);
      const tail = count ? tt('runConfigCliLineCount', '{n} 条', { n: count }) : tt('runConfigCliNoLines', '没有可用线路');
      return [head, tail].filter(Boolean).join(' · ');
    }

    function renderCliCards() {
      cliGrid.replaceChildren(...availableClis().map(item => {
        const button = el(doc, 'button', 'air-cli-option rc-cli-card');
        button.type = 'button';
        button.dataset.cli = item.cli;
        button.setAttribute('role', 'radio');
        button.setAttribute('aria-checked', String(item.cli === currentCli));
        button.classList.toggle('selected', item.cli === currentCli);
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
      show(modelField, !own || currentCli === 'opencode');
      renderModel();
      renderEffort();
      renderSub();
      fixedStatus.textContent = own
        ? tt('runConfigStatusOwn', '使用 {name} 自己的账号', { name: cliLabel(currentCli) })
        : '';
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

    function fillModel(select, custom, value, cli, preferred) {
      const state = modelState(cli);
      let choices = aiApi.buildModelChoices(value, state);
      if (!Array.isArray(choices) || !choices.length) choices = ['', '__custom__'];
      choices = [...new Set(choices)];
      select.replaceChildren(...choices.map(choice => option(doc, choice,
        choice === '__custom__' ? tt('runConfigModelCustom', '自定义…') : aiApi.modelChoiceLabel(choice, value, state))));
      let selected = aiApi.normalizeModel(value, preferred || '', state);
      if (!selected) selected = aiApi.defaultModelChoice(value, state) || '';
      const known = choices.includes(selected);
      select.value = known ? selected : (selected && choices.includes('__custom__') ? '__custom__' : choices[0]);
      custom.value = known ? '' : selected;
      show(custom, select.value === '__custom__');
    }

    function renderModel() {
      fillModel(modelSelect, modelCustom, providerValue, currentCli, config.model || customModelValue);
    }

    // The sub-task model keeps an explicit "leave it to the main line" as its
    // first option — an empty value means "no subagent override at all", which
    // is not the same as picking the main provider's default model.
    function fillSubModel(select, custom, providerId, preferred) {
      const state = modelState(currentCli);
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

    function primaryProviderId() {
      if (mode === MODE_AUTO && rows.length) return rows[0].providerId;
      return providerValue;
    }

    function renderSub() {
      const supported = aiApi.supportsSubagentCli(currentCli) && !terminalDraft;
      show(advanced, supported);
      if (!supported) return;
      const items = [option(doc, '', tt('runConfigSubFollow', '随主（默认）'))];
      for (const provider of providersOf(currentCli)) {
        if ((currentCli === 'codex' || currentCli === 'codex-exp') && provider.isOfficial) continue;
        items.push(option(doc, provider.id, aiApi.providerLabel(provider, false)));
      }
      subProviderSelect.replaceChildren(...items);
      const saved = config.subagent && config.subagent.model ? config.subagent : null;
      const wanted = saved ? String(saved.providerId || '') : '';
      subProviderSelect.value = items.some(item => item.value === wanted) ? wanted : '';
      fillSubModel(subModelSelect, subModelCustom,
        subProviderSelect.value || primaryProviderId(), saved ? saved.model || '' : '');
    }

    // Switching the sub-task 线路 only reshuffles the model list for that line —
    // it must not snap the 线路 select back to the saved value.
    function refreshSubLine() {
      if (!aiApi.supportsSubagentCli(currentCli) || terminalDraft) return;
      const current = subModelSelect.value === '__custom__'
        ? subModelCustom.value.trim() : subModelSelect.value;
      fillSubModel(subModelSelect, subModelCustom,
        subProviderSelect.value || primaryProviderId(), current);
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
      // 不再补引擎后缀免得被 176px 截成半句；完整名字进 title。
      const native = isNativeLine(row.providerId);
      const cliValues = [...new Set([row.cli, ...availableClis().filter(item => item.ok).map(item => item.cli)])].filter(Boolean);
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
      presetSelect.replaceChildren(option(doc, '', tt('runConfigPresetNone', '（不用预设）')), ...presets.map(item => option(doc, item.id, item.name || tt('runConfigPresetRecent', '最近用过'))));
      presetSelect.value = '';
      show(presetField, presets.length > 0);
    }

    function readPresets() {
      try {
        const storage = scope() && scope().localStorage;
        if (!storage) return [];
        const raw = JSON.parse(storage.getItem(PRESET_KEY) || '[]');
        return (Array.isArray(raw) ? raw : []).filter(item => item && Array.isArray(item.candidates) && item.candidates.length >= 2);
      } catch (_) { return []; }
    }

    // ── 添加线路：按 CLI 分组 ────────────────────────────────────────────────
    function togglePicker() {
      pickerOpen = !pickerOpen;
      renderPicker();
    }

    async function renderPicker() {
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
      search.focus();
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
          })),
        }), () => ({ cli, native: false, error: true, items: [] }));
      }));
    }

    function renderPickerList() {
      const host = pickerListHost;
      if (!host) return;
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
          if (already) rowNode.append(el(doc, 'span', 'rc-picker-right', `✓ ${tt('runConfigInPool', '已在池里')}`));
          rowNode.onclick = () => addRow(item);
          host.append(rowNode);
        }
      }
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

    function applyPreset(id) {
      const preset = readPresets().find(item => item.id === id);
      if (!preset) return;
      rows = (preset.candidates || []).map(candidate => ({
        providerId: String(candidate.providerId || ''),
        cli: candidate.cli || (isNativeLine(candidate.providerId) ? 'opencode' : currentCli),
        model: candidate.model || '', customModel: '', autoModel: false,
        tier: candidate.tier === 't2' ? 'medium' : candidate.tier === 't3' ? 'complex' : 'simple',
        name: '', enabled: true,
      }));
      if (preset.maxAttempts) maxAttempts = Number(preset.maxAttempts);
      if (preset.sticky != null) sticky = preset.sticky !== false;
      renderPool();
      renderFooter();
    }

    // ── 页脚 / 忙闲 / 子任务 ────────────────────────────────────────────────
    function currentModelValue() {
      return modelSelect.value === '__custom__' ? modelCustom.value.trim() : modelSelect.value;
    }

    function autoPreview() {
      const built = buildAutoSelection({
        rows, pick, tiering, maxAttempts, sticky, crossTrustConfirmed: true, providers: allProviders(),
      });
      return built.ok ? built.value : null;
    }

    function renderFooter() {
      if (mode === MODE_FIXED) {
        const label = providerless(currentCli)
          ? ''
          : (lineItems().find(item => item.value === providerValue) || {}).label || '';
        const model = currentModelValue();
        footCopy.textContent = [cliLabel(currentCli), label, model].filter(Boolean).join(' · ');
      } else {
        footCopy.textContent = tt('runConfigSummaryAuto', '{n} 条线路 · 跨 {m} 个 CLI', {
          n: rows.length,
          m: new Set(rows.map(row => row.cli)).size,
        });
      }
      const built = autoPreview();
      const mixed = !!(built && buildAutoSelection({
        rows, pick, tiering, maxAttempts, sticky, crossTrustConfirmed: false, providers: allProviders(),
      }).code === 'cross_trust_confirmation_required');
      show(crossTrustLabel, mode === MODE_AUTO && mixed);
      crossTrustBox.checked = crossTrustConfirmed;
    }

    function setBusy(value) {
      loading = value;
      submit.disabled = value;
      for (const button of cliGrid.querySelectorAll('button')) button.disabled = value;
    }

    function collectSubagent() {
      if (terminalDraft || !aiApi.supportsSubagentCli(currentCli)) return null;
      const model = subModelSelect.value === '__custom__' ? subModelCustom.value.trim() : subModelSelect.value;
      return aiApi.resolveSubagent({
        cli: currentCli,
        providerId: subProviderSelect.value,
        primaryProviderId: primaryProviderId(),
        model,
      });
    }

    // ── 保存 ────────────────────────────────────────────────────────────────
    async function save() {
      if (mode === MODE_FIXED) {
        const patch = buildFixedPatch({ cli: currentCli, providerId: providerValue,
          model: currentModelValue(), effort: effortValue });
        if (!patch.ok) throw new Error(patch.error);
        const subagent = collectSubagent();
        const providerName = (providersOf(currentCli).find(item => String(item.id) === String(patch.value.provider)) || {}).name || null;
        if (draft) {
          await onSaved({ cli: currentCli, provider: patch.value.provider, providerSelection: null,
            model: patch.value.model, effort: patch.value.effort, providerName, subagent });
          dialog.close();
          return;
        }
        const base = `/api/sessions/${encodeURIComponent(entry.sessionId)}`;
        if (currentCli !== config.cli) await request(`${base}/switch-cli`, { cli: currentCli });
        if (!providerless(currentCli)) await request(base, { provider: patch.value.provider, providerSelection: null }, 'PATCH');
        await request(base, { model: patch.value.model, effort: patch.value.effort, subagent }, 'PATCH');
        await onSaved();
        dialog.close();
        return;
      }
      const built = buildAutoSelection({
        rows, pick, tiering, routing: jev ? jev.read() : null,
        providers: allProviders(), maxAttempts, sticky, crossTrustConfirmed,
      });
      if (!built.ok) throw new Error(built.error);
      const selection = built.value;
      const primary = selection.candidates[0];
      const subagent = aiApi.resolveSubagent({ cli: primary.cli, providerId: primary.providerId, primaryProviderId: primary.providerId, model: '' });
      if (draft) {
        await onSaved({ cli: primary.cli, provider: primary.providerId, providerSelection: selection,
          model: primary.model || null, effort: null, subagent });
        dialog.close();
        return;
      }
      const base = `/api/sessions/${encodeURIComponent(entry.sessionId)}`;
      if (!selection.candidates.some(candidate => candidate.cli === currentCli)) {
        await request(`${base}/switch-cli`, { cli: primary.cli });
      }
      await request(base, { provider: primary.providerId, providerSelection: selection }, 'PATCH');
      await request(base, { model: primary.model || null }, 'PATCH');
      await onSaved();
      dialog.close();
    }

    // ── 交互 ────────────────────────────────────────────────────────────────
    function selectCli(cli) {
      currentCli = cli;
      providerValue = '';
      customModelValue = '';
      error.textContent = '';
      setBusy(true);
      const current = ++epoch;
      loadCatalog(cli).then(() => {
        if (current !== epoch) return;
        providers = providersOf(cli);
        setBusy(false);
        renderFixed();
        renderFooter();
        if (cli === 'opencode' && !aiApi.openCodeNativeProviders().length) {
          aiApi.refreshOpenCodeModels(() => { if (current === epoch) renderFixed(); });
        }
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
    crossTrustBox.onchange = () => { crossTrustConfirmed = crossTrustBox.checked; };
    presetSelect.onchange = () => applyPreset(presetSelect.value);
    lineSelect.onchange = () => {
      providerValue = lineSelect.value;
      customModelValue = '';
      renderModel();
      renderSub();
      renderFooter();
    };
    modelSelect.onchange = () => {
      show(modelCustom, modelSelect.value === '__custom__');
      if (modelSelect.value === '__custom__') modelCustom.focus();
      renderFooter();
    };
    modelCustom.oninput = () => renderFooter();
    subProviderSelect.onchange = () => refreshSubLine();
    subModelSelect.onchange = () => {
      show(subModelCustom, subModelSelect.value === '__custom__');
      if (subModelSelect.value === '__custom__') subModelCustom.focus();
    };
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
      renderAuto();
      renderFooter();
      warmOtherClis();
      // OpenCode 自己的线路（Zen / Go / auth login 过的）靠那张 1 天的模型缓存认出来；
      // 第一次打开是冷的，拉回来之后再画一遍 —— 上面记下的 pendingNative 这时才认得出。
      if (currentCli === 'opencode' && !aiApi.openCodeNativeProviders().length) {
        aiApi.refreshOpenCodeModels(() => { renderFixed(); renderFooter(); });
      }
    }

    async function warmOtherClis() {
      for (const item of availableClis()) {
        if (!item.ok || item.cli === currentCli || catalogs.has(item.cli)) continue;
        const current = epoch;
        try { await loadCatalog(item.cli); } catch (_) { /* 计数位会显示加载失败 */ }
        if (current !== epoch) return;
        renderCliCards();
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
    TIERS,
    TIER_KEYS,
    buildAutoSelection,
    buildFixedPatch,
    cliChoicesForLine,
    cliLineVerdict,
    isNativeLine,
    lineShape,
    nativeLineId,
    nativeLineValue,
    open,
    pillModel,
    pillText,
    protocolOf,
    reorder,
    rowIssue,
  });
});
