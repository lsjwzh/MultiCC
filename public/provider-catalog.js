'use strict';

(function initProviderCatalog(root, factory) {
  const catalog = factory();
  if (typeof module === 'object' && module.exports) module.exports = catalog;
  if (root) root.MultiCCProviderCatalog = catalog;
})(typeof window !== 'undefined' ? window : null, function createProviderCatalog() {
  // 数字格式的唯一来源（shared/format.js，页面里先于本文件加载）。Node 侧的沙箱里
  // 没有页面全局，也没有 require，所以三种取法都留着 —— 测试要么注入
  // MultiCCFormat，要么让它落到 require 上。
  const FMT = (typeof window !== 'undefined' && window.MultiCCFormat)
    || (typeof globalThis !== 'undefined' && globalThis.MultiCCFormat)
    || (typeof require === 'function' ? require('./shared/format.js') : null);
  const APP_TYPES = new Set(['claude', 'codex']);
  const API_FORMATS = new Set(['anthropic', 'openai_responses']);
  const ALIAS_TIERS = ['opus', 'sonnet', 'haiku', 'fable'];

  function text(value, max = 300) {
    const out = String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
    return out.length > max ? out.slice(0, max) : out;
  }

  function number(value) {
    const result = Number(value);
    return Number.isFinite(result) && result >= 0 ? result : 0;
  }

  // 紧凑 token 数走全站唯一那份（shared/format.js）。原来这里抄了同一份（百万一位小数
  // 去尾零、千位一位小数去尾零），聊天的用量面板里还有第三份。
  const formatCompactTokens = value => FMT.formatCompactTokens(value);

  // 字段名走 i18n：浏览器里用 i18n.js 的 t()，Node 测试或还在用旧目录时回落到
  // 中文默认值——断言正是按中文写的。（工厂函数拿不到包装层的 root，自己找 window。）
  function tt(key, fallback, params) {
    const scope = typeof window !== 'undefined' ? window : null;
    const out = scope && typeof scope.t === 'function' ? scope.t(key, params) : '';
    if (out && out !== key) return out;
    return Object.keys(params || {}).reduce((text, name) => (
      text.split(`{${name}}`).join(String(params[name]))
    ), fallback);
  }

  const FIELD_NEW = () => tt('usageFieldNew', '新');
  const FIELD_CACHE_READ = () => tt('usageFieldCacheRead', '缓读');
  const FIELD_CACHE_WRITE = () => tt('usageFieldCacheWrite', '缓写');
  const FIELD_UNKNOWN = () => tt('usageFieldUnknown', '未分');
  const FIELD_OUT = () => tt('usageFieldOut', '出');

  // 内置官方供应商（Codex / Claude 官方）的名字是**服务端写进 provider 记录里的**，
  // 属于数据而不是前端字面量：'Codex 官方' 由 src/providers/official-catalog.js 合成，
  // 老的账号记录还带着 'Codex 官方 · <label>'（src/routes/*-accounts.js）。只改服务端
  // 字面量只能影响之后新建的记录，历史记录里的中文会一直漏出来，所以这里按「身份」在
  // 渲染时翻译一遍：zh 仍是中文原样，en 变英文，一条历史数据都不动。
  const OFFICIAL_NAME_LITERALS = Object.freeze({
    codex: Object.freeze(['Codex 官方', 'Codex Official']),
    claude: Object.freeze(['Claude 官方', 'Claude Official']),
  });
  const OFFICIAL_SUFFIX_SEPARATOR = ' · ';

  function officialKindFromName(value) {
    const name = text(value, 240);
    if (!name) return '';
    for (const type of APP_TYPES) {
      for (const literal of OFFICIAL_NAME_LITERALS[type]) {
        if (name === literal || name.startsWith(literal + OFFICIAL_SUFFIX_SEPARATOR)) return type;
      }
    }
    return '';
  }

  // 认内置官方身份：归一化后的 provider 看 id（builtinOfficial 会在 normalizeProvider
  // 里丢掉，isOfficial 对内置记录是 false，所以 id 才是可靠信号），裸名字串走字面量匹配。
  function officialProviderKind(value) {
    if (value && typeof value === 'object') {
      const id = text(value.id, 180).toLowerCase();
      if (id === 'codex-official') return 'codex';
      if (id === 'claude-official') return 'claude';
      const appType = text(value.appType, 20).toLowerCase();
      if (value.builtinOfficial === true && APP_TYPES.has(appType)) return appType;
      return officialKindFromName(value.name);
    }
    return officialKindFromName(value);
  }

  // 'Codex 官方 · ab12cd' 里的后缀是用户起的别名或账号 id，不是能翻译的东西，原样留着。
  function officialNameSuffix(value) {
    const name = text(value && typeof value === 'object' ? value.name : value, 240);
    const at = name.indexOf(OFFICIAL_SUFFIX_SEPARATOR);
    return at === -1 ? '' : name.slice(at + OFFICIAL_SUFFIX_SEPARATOR.length);
  }

  // 传入 provider 记录或裸名字串，返回展示用名字。非内置官方供应商原样返回。
  function providerDisplayName(value) {
    const name = text(value && typeof value === 'object' ? value.name : value, 240);
    const kind = officialProviderKind(value);
    if (!kind) return name;
    const base = kind === 'codex'
      ? tt('providerOfficialCodex', 'Codex 官方')
      : tt('providerOfficialClaude', 'Claude 官方');
    const suffix = officialNameSuffix(value);
    return suffix ? base + OFFICIAL_SUFFIX_SEPARATOR + suffix : base;
  }

  // ── CLI 目录（唯一的 web 侧副本）────────────────────────────────────────────
  //
  // 服务端 src/cli/cli-capability.js 的 CLIS 是权威表，这里是它在浏览器侧的镜像；
  // App 侧还有一份 app/lib/utils/cli_display.dart。tests/test-cli-display-parity.js
  // 读这三份，任何一列漂移就红。
  //
  // 一张表，两层 —— 一个 CLI 是**家族**，家族在每个**场景**（chat / terminal）里
  // 给出一组**衍生车道**：
  //
  //   CLI_FAMILIES[family]  name / colour / mark / providerless（对外只说一次）
  //                         lanes: { chat: [...], terminal: [...] }
  //   CLI_DISPLAY[lane]     上面这张表摊平后的**车道视图**，既有取词全读它
  //
  // 于是「一个 CLI，多种展示」是同一张表的两种读法：claude 在 chat 里是
  // 「Claude / Claude Agent SDK」（外加一条 offered:false 的 `claude -p`），在终端
  // 里就是 `claude`（大字 Claude Code）；对外（任务卡、线路位）只说家族名 Claude。
  //
  // 车道的 id 不动（会话记录、Provider 池、wire 路由都存着它），改的只是叫法；
  // 缺省值也都在家族上：label 缺省 = 家族名，engine 缺省 = 车道的 id（终端里那行
  // 小字指的就是要跑的命令），offered 缺省 = 给，deprecated 缺省 = 不在淘汰路上。
  //
  // 镜像之前，同样的列在页面上被抄了六七遍且各抄各的：chat.js 的 CLI_META、
  // air-task-settings.js 的 CLI_LABELS/CLI_MARKS、air-cli-update.js 的第三份标签表
  // （漏了 claude-exp/codex-exp）、air-provider.js 只列 4 个 CLI 的那份、
  // chat-ai-config.js 里把不认识的 CLI 印成「WorkBuddy」的三元链、以及 chat.js /
  // air.js 三处各写一遍的 NATIVE_ROUTE_LABELS。现在它们全部从这里取。
  //
  // 未知 id 一律用原 id 显示：回落成别的 CLI 的名字（旧代码里是 Claude / WorkBuddy）
  // 会把新 CLI 显示成另一个产品。
  const CLI_FAMILIES = {
    claude: {
      name: 'Claude',
      colour: '#ff9a76',
      lanes: {
        chat: [
          { id: 'claude-exp', mark: 'A', engine: 'Claude Agent SDK' },
          { id: 'claude', engine: 'claude -p', offered: false },
        ],
        terminal: [{ id: 'claude', label: 'Claude Code', mark: 'C', engine: 'claude' }],
      },
    },
    codex: {
      name: 'Codex',
      colour: '#20a66a',
      lanes: {
        chat: [
          { id: 'codex-exp', mark: 'X', engine: 'Codex App Server' },
          // 计划淘汰只写在 chat 这条目上：终端里它仍是本来的 codex 命令。
          { id: 'codex', engine: 'codex exec', offered: false, deprecated: true, replacedBy: 'codex-exp' },
        ],
        terminal: [{ id: 'codex', label: 'Codex Exec', mark: 'E', engine: 'codex' }],
      },
    },
    opencode: { name: 'OpenCode', colour: '#388bfd', mark: 'O' },
    zcode: { name: 'ZCode', colour: '#a371f7', mark: 'Z' },
    qoder: { name: 'Qoder CN', colour: '#ff8a3d', mark: 'Q', providerless: true },
    kimi: { name: 'Kimi Code', colour: '#13c2c2', mark: 'K' },
    codebuddy: { name: 'WorkBuddy', colour: '#0052d9', mark: 'W', providerless: true },
    dsh: { name: 'DSH', colour: '#4d6bfe', mark: 'D', providerless: true },
    gemini: { name: 'Gemini', colour: '#4285f4', mark: 'G', providerless: true },
    grok: { name: 'Grok', colour: '#8c8f96', mark: 'R', providerless: true },
  };
  const CLI_KINDS = ['chat', 'terminal'];
  const CLI_DEFAULT_COLOUR = '#8b949e';
  const CLI_DEFAULT_KINDS = ['chat', 'terminal'];

  const cliKey = cli => String(cli == null ? '' : cli).trim().toLowerCase();
  const cliEntry = cli => CLI_DISPLAY[cliKey(cli)] || null;

  // 摊平视图：一行一条衍生车道。与服务端同形同规则（那边是 buildDisplay），
  // 所以两端可以逐列对比，而不是各写一份结果。
  function cliLaneEntries(familyId, family, kind) {
    if (!family.lanes) return [{ id: familyId }];
    return family.lanes[kind] || [];
  }

  function cliBuildDisplay(families) {
    const display = {};
    const laneFamily = {};
    for (const familyId of Object.keys(families)) {
      const family = families[familyId];
      const lanes = new Map();
      for (const kind of CLI_KINDS) {
        for (const entry of cliLaneEntries(familyId, family, kind)) {
          const id = cliKey(entry.id) || familyId;
          const lane = lanes.get(id) || { labels: new Set(), marks: new Set(), engines: new Map(), kinds: [], deprecatedBy: null };
          laneFamily[id] = familyId;
          if (entry.label) lane.labels.add(entry.label);
          if (entry.mark) lane.marks.add(entry.mark);
          if (entry.engine) lane.engines.set(kind, entry.engine);
          if (entry.offered !== false && lane.kinds.indexOf(kind) === -1) lane.kinds.push(kind);
          if (entry.deprecated === true && !lane.deprecatedBy) lane.deprecatedBy = entry;
          lanes.set(id, lane);
        }
      }
      for (const [id, lane] of lanes) {
        const engineKind = lane.kinds.find(kind => lane.engines.has(kind)) || [...lane.engines.keys()][0];
        const row = {
          displayName: [...lane.labels][0] || family.name,
          shortMark: [...lane.marks][0] || family.mark || (family.name || '').slice(0, 1).toUpperCase() || '?',
          colour: family.colour || CLI_DEFAULT_COLOUR,
          providerless: family.providerless === true,
          deprecated: lane.deprecatedBy !== null,
        };
        if (lane.deprecatedBy && lane.deprecatedBy.replacedBy) row.replacedBy = lane.deprecatedBy.replacedBy;
        if (engineKind) row.engine = lane.engines.get(engineKind);
        if (lane.kinds.length !== CLI_KINDS.length) row.kinds = lane.kinds.slice();
        display[id] = row;
      }
    }
    return { display, laneFamily };
  }

  const _cliViews = cliBuildDisplay(CLI_FAMILIES);
  const CLI_DISPLAY = _cliViews.display;
  const CLI_LANE_FAMILY = _cliViews.laneFamily;

  // 家族 → 家族 id（车道 id 或家族 id 都认）；没听说过答 null。
  function cliFamilyOf(cli) {
    const key = cliKey(cli);
    if (!key) return null;
    if (CLI_FAMILIES[key]) return key;
    return CLI_LANE_FAMILY[key] || null;
  }

  // 对外的那个名字：claude / claude-exp（以及以后这条家族的其它衍生）都答 'Claude'。
  function cliFamilyName(cli) {
    const family = cliFamilyOf(cli);
    return family ? CLI_FAMILIES[family].name : String(cli == null ? '' : cli).trim();
  }

  // 一个家族在某场景里给的衍生，按选择器该有的顺序；每项自带该场景的大小字。
  function cliLanesOf(familyOrLane, kind) {
    const familyId = cliFamilyOf(familyOrLane);
    const wanted = cliKey(kind);
    if (!familyId || CLI_KINDS.indexOf(wanted) === -1) return [];
    const family = CLI_FAMILIES[familyId];
    return cliLaneEntries(familyId, family, wanted).map(entry => {
      const lane = cliKey(entry.id) || familyId;
      return {
        lane,
        kind: wanted,
        label: entry.label || family.name,
        engine: entry.engine || lane,
        mark: entry.mark || family.mark || (family.name || '').slice(0, 1).toUpperCase() || '?',
        colour: family.colour || CLI_DEFAULT_COLOUR,
        providerless: family.providerless === true,
        offered: entry.offered !== false,
        deprecated: entry.deprecated === true,
        replacedBy: entry.deprecated === true ? (entry.replacedBy || null) : null,
      };
    });
  }

  // 这个场景里有东西可给的家族。
  function cliFamiliesFor(kind) {
    const wanted = cliKey(kind);
    if (CLI_KINDS.indexOf(wanted) === -1) return [];
    return Object.keys(CLI_FAMILIES).filter(id => cliLanesOf(id, wanted).some(lane => lane.offered));
  }

  function cliDisplayName(cli) {
    const entry = cliEntry(cli);
    return entry ? entry.displayName : String(cli == null ? '' : cli).trim();
  }

  // chat-live-ui 的切换面板按 {label, color} 读每个 CLI（入口行、安装进度行、当前
  // 线路行三处），所以映射里就用它那两个字面 key。deprecated / replacedBy 也带上：
  // 面板要在这个 CLI 的名字后面标注「计划淘汰」，并说明该换成哪条线路；engine 是
  // 两行式 CLI 行的小字（引擎名）。
  function cliMeta(cli) {
    const entry = cliEntry(cli);
    if (!entry) return { label: String(cli == null ? '' : cli).trim(), color: CLI_DEFAULT_COLOUR, engine: cliEngine(cli), kinds: CLI_DEFAULT_KINDS };
    const meta = { label: entry.displayName, color: entry.colour, engine: cliEngine(cli), kinds: cliKinds(cli) };
    if (entry.deprecated === true) {
      meta.deprecated = true;
      if (entry.replacedBy) meta.replacedBy = entry.replacedBy;
    }
    return meta;
  }

  function cliMetaMap() {
    const out = {};
    for (const id of Object.keys(CLI_DISPLAY)) out[id] = cliMeta(id);
    return out;
  }

  // 两行式 CLI 行的小字：扶正后的两条常驻车道写引擎产品名（Claude Agent SDK /
  // Codex App Server），其余车道就是它自己的 id —— 终端里那行小字指的就是要跑的
  // 命令，所以 id 在这里不是「内部实现泄漏」，而是最准确的答案。
  function cliEngine(cli) {
    const entry = cliEntry(cli);
    if (entry && entry.engine) return entry.engine;
    return String(cli == null ? '' : cli).trim();
  }

  // 这条车道能出现在哪种会话的 CLI 选择里（'chat' / 'terminal'）。没听说过的 id
  // 两种都答 true：表里没有的 CLI 不该在选择器里凭空消失。
  function cliKinds(cli) {
    const entry = cliEntry(cli);
    return entry && entry.kinds ? entry.kinds : CLI_DEFAULT_KINDS;
  }

  function cliOffersIn(cli, kind) {
    return cliKinds(cli).indexOf(String(kind == null ? '' : kind).trim().toLowerCase()) !== -1;
  }

  // 车道还在用，但已在淘汰路上（服务端的 deprecated 列）。UI 拿它决定要不要说
  // 「兜底线路，计划淘汰」。未知 id 与退役无关 —— 返回 false 而不是报错。
  function cliDeprecated(cli) {
    const entry = cliEntry(cli);
    return entry ? entry.deprecated === true : false;
  }

  // 该换成谁；非淘汰线路与未知 id 都是 null。
  function cliReplacedBy(cli) {
    const entry = cliEntry(cli);
    return entry && entry.deprecated === true && entry.replacedBy ? entry.replacedBy : null;
  }

  function cliShortMark(cli) {
    const entry = cliEntry(cli);
    if (entry) return entry.shortMark;
    // An unknown id still gets its own letter; an empty one has none to give,
    // and the badge would otherwise collapse to nothing (the app draws '?').
    const name = cliDisplayName(cli);
    return name ? name.slice(0, 1).toUpperCase() : '?';
  }

  function cliColour(cli) {
    const entry = cliEntry(cli);
    return entry ? entry.colour : CLI_DEFAULT_COLOUR;
  }

  function cliProviderless(cli) {
    const entry = cliEntry(cli);
    return entry ? entry.providerless === true : false;
  }

  function providerlessClis() {
    return new Set(Object.keys(CLI_DISPLAY).filter(id => CLI_DISPLAY[id].providerless));
  }

  // 厂商自持账号的 CLI 在「线路」位置上显示自己的产品名，而不是 multicc 线路名
  // （NATIVE_ROUTE_LABELS 的四个副本就是这张表）。它就是「无 provider 的那些 CLI 的
  // 展示名」，所以不再单独列一份。
  function nativeRouteLabel(cli) {
    return cliProviderless(cli) ? cliDisplayName(cli) : '';
  }

  function formatUsageWindow(value) {
    const window = normalizeWindow(value);
    if (window.inputTokens + window.outputTokens === 0) return '';
    const output = formatCompactTokens(window.outputTokens);
    if (!window.breakdownKnown) {
      return `${tt('usageFieldInputInclCache', '入(含缓存)')}:${formatCompactTokens(window.inputTokens)}/${FIELD_OUT()}:${output}`;
    }
    const unknown = window.unattributedInputTokens;
    return `${FIELD_NEW()}:${formatCompactTokens(window.freshInputTokens)}` +
      `/${FIELD_CACHE_READ()}:${formatCompactTokens(window.cacheReadTokens)}` +
      `/${FIELD_CACHE_WRITE()}:${formatCompactTokens(window.cacheWriteTokens)}` +
      `${unknown ? `/${FIELD_UNKNOWN()}:${formatCompactTokens(unknown)}` : ''}/${FIELD_OUT()}:${output}`;
  }

  function formatUsageCumulative(value) {
    const stat = value && typeof value === 'object' ? value : {};
    if (!stat.breakdownKnown) return tt('usageFieldInputWithCache', '输入含缓存 {v}', { v: formatCompactTokens(stat.inputTokens) });
    const unknown = number(stat.unattributedInputTokens);
    return `${FIELD_NEW()} ${formatCompactTokens(stat.freshInputTokens)}` +
      ` / ${FIELD_CACHE_READ()} ${formatCompactTokens(stat.cacheReadTokens)}` +
      ` / ${FIELD_CACHE_WRITE()} ${formatCompactTokens(stat.cacheWriteTokens)}` +
      `${unknown ? ` / ${FIELD_UNKNOWN()} ${formatCompactTokens(unknown)}` : ''}`;
  }

  function safeBaseUrl(value) {
    const raw = text(value, 2048);
    if (!raw) return '';
    try {
      const url = new URL(raw);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
      url.username = '';
      url.password = '';
      url.search = '';
      url.hash = '';
      return url.href.replace(/\/$/, raw.endsWith('/') ? '/' : '');
    } catch (_) {
      return '';
    }
  }

  function normalizeModelOptions(value, primary) {
    const source = Array.isArray(value) ? value : String(value || '').split(/[\n,]/);
    const seen = new Set();
    const result = [];
    for (const item of [primary, ...source]) {
      const model = text(item, 240);
      if (model && !seen.has(model)) {
        seen.add(model);
        result.push(model);
      }
    }
    return result;
  }

  function normalizeAliasMap(value) {
    const source = value && typeof value === 'object' ? value : {};
    const result = {};
    for (const tier of ALIAS_TIERS) {
      const entry = source[tier];
      if (!entry || typeof entry !== 'object') continue;
      const model = text(entry.model, 240);
      if (!model) continue;
      result[tier] = { model, name: text(entry.name, 160) };
    }
    return result;
  }

  function safeTokenMask(value) {
    const mask = text(value, 32);
    return mask === '***' || mask.includes('…') ? mask : '';
  }

  function normalizeProvider(value) {
    if (!value || typeof value !== 'object') return null;
    const id = text(value.id, 180);
    const appType = text(value.appType, 20).toLowerCase();
    if (!id || !APP_TYPES.has(appType)) return null;
    const model = text(value.model, 240);
    const apiFormat = API_FORMATS.has(value.apiFormat)
      ? value.apiFormat
      : (appType === 'claude' ? 'anthropic' : 'openai_responses');
    const zcodeCompatible = !!safeBaseUrl(value.baseUrl) && value.hasToken === true;
    const defaultClis = [
      ...(apiFormat === 'anthropic' ? ['claude', 'claude-exp', 'opencode'] : ['codex', 'codex-exp', 'opencode']),
      ...(zcodeCompatible ? ['zcode'] : []),
    ];
    return Object.freeze({
      id,
      appType,
      name: text(value.name, 240) || id,
      source: value.source === 'ccswitch' ? 'ccswitch' : 'local',
      apiFormat,
      protocol: apiFormat,
      wireApi: ['messages', 'responses', 'chat_completions', 'chat-completions'].includes(value.wireApi) ? value.wireApi : '',
      compatibleClis: Object.freeze((Array.isArray(value.compatibleClis) ? value.compatibleClis : defaultClis)
        .filter(cli => ['claude', 'claude-exp', 'codex', 'codex-exp', 'opencode', 'zcode'].includes(cli)
          && (cli !== 'zcode' || zcodeCompatible))),
      baseUrl: safeBaseUrl(value.baseUrl),
      model,
      modelOptions: Object.freeze(normalizeModelOptions(value.modelOptions || value.models, model)),
      aliasOnly: value.aliasOnly === true,
      aliasMap: Object.freeze(normalizeAliasMap(value.aliasMap)),
        tokenMask: safeTokenMask(value.tokenMask),
      hasToken: value.hasToken === true,
      isOfficial: value.isOfficial === true,
      limit: normalizeProviderLimit(value.limit),
    });
  }

  function normalizeProviderLimit(value) {
    // Public projection of the server-side limit cache entry. Deliberately a
    // NEW frozen object that keeps only display-safe scalars — the structured
    // `summary` is large and the cache's `barText` carries time placeholders
    // ({cd}/{ago}) that must stay server-side.
    const source = value && typeof value === 'object' ? value : null;
    if (!source) return null;
    return Object.freeze({
      kind: text(source.kind, 30) || null,
      status: text(source.status, 20) || null,
      summaryText: text(source.summaryText, 300),
      fetchedAt: number(source.fetchedAt) || null,
      updatedAt: number(source.updatedAt) || null,
      lastError: text(source.lastError, 120) || null,
      lastErrorAt: number(source.lastErrorAt) || null,
      stale: source.stale === true,
    });
  }

  function normalizeDefaults(value) {
    const source = value && typeof value === 'object' ? value : {};
    return Object.freeze({
      claude: text(source.claude, 180) || null,
      codex: text(source.codex, 180) || null,
    });
  }

  function normalizeWindow(value) {
    const source = value && typeof value === 'object' ? value : {};
    const inputTokens = number(source.consumedInputTokens == null
      ? source.inputTokens
      : source.consumedInputTokens);
    const freshInputTokens = number(source.freshInputTokens);
    const cacheReadTokens = number(source.cacheReadTokens);
    const cacheWriteTokens = number(source.cacheWriteTokens);
    const breakdownKnown = source.breakdownKnown === true;
    return Object.freeze({
      inputTokens,
      consumedInputTokens: inputTokens,
      freshInputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      unattributedInputTokens: number(source.unattributedInputTokens),
      breakdownKnown,
      outputTokens: number(source.outputTokens),
    });
  }

  function normalizeStat(value) {
    if (!value || typeof value !== 'object') return null;
    const providerId = text(value.providerId, 180);
    if (!providerId) return null;
    return Object.freeze({
      providerId,
      inputTokens: number(value.consumedInputTokens == null ? value.inputTokens : value.consumedInputTokens),
      freshInputTokens: number(value.freshInputTokens),
      cacheReadTokens: number(value.cacheReadTokens),
      cacheWriteTokens: number(value.cacheWriteTokens),
      unattributedInputTokens: number(value.unattributedInputTokens),
      breakdownKnown: value.breakdownKnown === true,
      outputTokens: number(value.outputTokens),
      today: normalizeWindow(value.today),
      week: normalizeWindow(value.week),
      month: normalizeWindow(value.month),
      totalTokens: number(value.totalTokens),
      turnCount: number(value.turnCount),
      sessionCount: number(value.sessionCount),
    });
  }

  function normalizeCcSwitchStatus(value, availableFallback) {
    const source = value && typeof value === 'object' ? value : {};
    return Object.freeze({
      available: source.available === true || (!value && availableFallback === true),
      dbFound: source.dbFound === true || (!value && availableFallback === true),
      reason: text(source.reason, 100) || null,
      message: text(source.message, 500),
    });
  }

  function normalizeCatalog(value) {
    const source = value && typeof value === 'object' ? value : {};
    const providers = (Array.isArray(source.providers) ? source.providers : [])
      .map(normalizeProvider)
      .filter(Boolean);
    const stats = (Array.isArray(source.stats) ? source.stats : [])
      .map(normalizeStat)
      .filter(Boolean);
    const ccSwitchAvailable = source.ccSwitchAvailable === true;
    return Object.freeze({
      available: source.available === true,
      ccSwitchAvailable,
      ccSwitchStatus: normalizeCcSwitchStatus(source.ccSwitchStatus, ccSwitchAvailable),
      providers: Object.freeze(providers),
      defaults: normalizeDefaults(source.defaults),
      stats: Object.freeze(stats),
      limitCacheStaleMs: source.limitCacheStaleMs == null ? null : number(source.limitCacheStaleMs),
    });
  }

  function groupByAppType(value) {
    const providers = Array.isArray(value) ? value : ((value && value.providers) || []);
    const groups = { claude: [], codex: [] };
    for (const provider of providers) {
      if (provider && APP_TYPES.has(provider.appType)) groups[provider.appType].push(provider);
    }
    return groups;
  }

  function groupByProtocol(value) {
    const providers = Array.isArray(value) ? value : ((value && value.providers) || []);
    const groups = { anthropic: [], openai_responses: [] };
    for (const provider of providers) {
      if (provider && groups[provider.apiFormat]) groups[provider.apiFormat].push(provider);
    }
    return groups;
  }

  function providersForCli(value, cli) {
    const providers = Array.isArray(value) ? value : ((value && value.providers) || []);
    return providers.filter(provider => provider && provider.compatibleClis.includes(cli));
  }

  function findProvider(value, appType, id) {
    const providers = Array.isArray(value) ? value : ((value && value.providers) || []);
    const type = appType ? text(appType, 20).toLowerCase() : '';
    const providerId = text(id, 180);
    return providers.find(provider => provider && provider.id === providerId && (!type || provider.appType === type)) || null;
  }

  function modelsFor(value) {
    return value ? normalizeModelOptions(value.modelOptions, value.model) : [];
  }

  function normalizeDeleteReferences(value) {
    const source = value && value.details ? value.details : value;
    const refs = source && Array.isArray(source.references) ? source.references : [];
    return refs.slice(0, 100).map((ref) => {
      if (!ref || typeof ref !== 'object') return null;
      const kind = text(ref.kind, 30).toLowerCase();
      if (kind === 'main' || kind === 'subagent') {
        const sessionId = text(ref.sessionId, 180);
        const sessionName = text(ref.sessionName, 240);
        return { kind, title: sessionName || sessionId || kind, detail: sessionId };
      }
      if (kind === 'default') {
        const cli = text(ref.cli, 30);
        return { kind, title: cli || 'default', detail: '' };
      }
      if (kind === 'aux') {
        const protocol = text(ref.protocol, 40);
        return { kind, title: protocol || 'aux', detail: '' };
      }
      return null;
    }).filter(Boolean);
  }

  function deleteReferenceDisplayData(value) {
    const items = normalizeDeleteReferences(value);
    return Object.freeze({
      count: items.length,
      kinds: Object.freeze(Array.from(new Set(items.map(item => item.kind)))),
      items: Object.freeze(items.map(Object.freeze)),
    });
  }

  // ── Provider-card quota badges ──────────────────────────────────────────
  // Reuses the same /api/<kind>/quota endpoints the chat rate-limit bars use,
  // so each provider card shows the last-known value (cached in localStorage)
  // and never a blank gap. Kinds map 1:1 to the quota routes in server.js.
  const QUOTA_ROUTES = Object.freeze({
    ark: '/api/ark/quota',
    zhipu: '/api/zhipu/quota',
    kimi: '/api/kimi/quota',
    codex: '/api/codex/quota',
    qoder: '/api/qoder/quota',
    opencode: '/api/opencode/quota',
    aliyun: '/api/aliyun/quota',
  });
  // Kinds backed by a web login: clicking their "需登录" badge asks the server
  // to open a visible Chrome window (managed profile) for the user to log in.
  const QUOTA_LOGIN_ROUTES = Object.freeze({
    kimi: '/api/kimi/quota/login',
    qoder: '/api/qoder/quota/login',
    opencode: '/api/opencode/quota/login',
    aliyun: '/api/aliyun/quota/login',
  });
  const QUOTA_CACHE_KEY = 'multicc.providerQuota.v1';
  const QUOTA_GRAY = '#8b949e';
  const QUOTA_AMBER = '#d29922';
  // Throttle background refreshes (CDP-backed kinds open a Chrome tab, so we
  // don't want to re-hit them on every speed-test / edit re-render).
  const QUOTA_REFETCH_MS = 60000;
  const quotaLastFetch = {};

  // 余量百分比的三个门限也只有一张表（shared/format.js 的 USAGE_THRESHOLDS.quota，
  // 90/70/平常），与聊天页那条上下文条同一套 tone 名；具体色值由 USAGE_COLORS 定，
  // QUOTA_AMBER 这个别名留着是因为下面十几处状态色（需登录 / 暂不可用）也在用它。
  function quotaPctColor(pct) {
    return FMT.usageColor(pct, 'quota');
  }
  function quotaMoneyColor(v) {
    if (v <= 0) return '#f85149';
    if (v <= 5) return QUOTA_AMBER;
    return '#58a6ff';
  }
  function quotaFmt2(n) { return String(Number(Number(n).toFixed(2))); }

  // Console-scrape summaries (kimi membership page / aliyun Bailian console)
  // render through the SAME unified window template as the chat rate-limit bar
  // (chat-rate-limit.js unifiedWindowSeg): `<window> <remaining%> <countdown>`,
  // standard tokens 5h/1wk/1m. On pages that load chat-rate-limit.js we call
  // the real thing; on manage.html (catalog only) an identical-format fallback
  // keeps the two surfaces visually consistent.
  function unifiedWindowSegCompat(label, usedPercent, resetMs, root) {
    const api = root && root.MultiCCChatRateLimit;
    if (api && typeof api.unifiedWindowSeg === 'function') return api.unifiedWindowSeg(label, usedPercent, resetMs);
    const used = Number(usedPercent);
    if (!Number.isFinite(used)) return '';
    const rem = Math.max(0, Math.min(100, Math.round(100 - used)));
    let cd = '';
    const total = Number(resetMs);
    if (Number.isFinite(total) && total >= 0) {
      const totalH = total / 3600000;
      if (totalH < 1) cd = `${Math.max(1, Math.round(total / 60000))}m`;
      else if (totalH < 24) {
        const h = Math.round(totalH * 10) / 10;
        cd = `${Number.isInteger(h) ? h.toFixed(0) : h.toFixed(1)}h`;
      } else {
        const d = Math.floor(totalH / 24);
        const remH = Math.floor(totalH % 24);
        cd = remH ? `${d}d ${remH}h` : `${d}d`;
      }
    }
    return cd ? `${label} ${rem}% ${cd}` : `${label} ${rem}%`;
  }

  // Accepts both the unified shape { window, label, usedPercent, resetMs } and
  // pre-upgrade caches { label, percent }; returns normalized segments.
  function windowSummarySegments(summary, nowMs, root) {
    const items = Array.isArray(summary) ? summary : [];
    const segs = [];
    let maxUsed = 0;
    for (const s of items) {
      if (!s) continue;
      const used = Number.isFinite(s.usedPercent) ? s.usedPercent : Number(s.percent);
      if (!Number.isFinite(used)) continue;
      const label = s.window || s.label || '余量';
      const cd = Number.isFinite(s.resetMs) ? Math.max(0, s.resetMs - nowMs) : null;
      const seg = unifiedWindowSegCompat(label, used, cd, root);
      if (!seg) continue;
      maxUsed = Math.max(maxUsed, used);
      segs.push(seg);
    }
    return { segs, maxUsed };
  }

  // Explicit opt-in wins: a provider record may carry quotaKind to force (or
  // disable, via 'none') classification when its baseUrl sits behind a proxy
  // host no hostname rule could recognize.
  const QUOTA_KINDS = ['ark', 'zhipu', 'kimi', 'codex', 'qoder', 'opencode', 'aliyun'];
  function quotaKindForProvider(p) {
    if (!p) return null;
    if (QUOTA_KINDS.includes(p.quotaKind)) return p.quotaKind;
    if (p.quotaKind === 'none') return null;
    let host = '';
    try { host = p.baseUrl ? new URL(p.baseUrl).hostname.toLowerCase() : ''; } catch (_) { host = ''; }
    if (/(^|\.)volces\.com$/.test(host)) return 'ark';
    if (/(^|\.)(z\.ai|bigmodel\.cn)$/.test(host)) return 'zhipu';
    if (/(^|\.)(moonshot|kimi)\.(cn|com|ai)$/.test(host)) return 'kimi';
    if (/(^|\.)qoder\.com\.cn$/.test(host)) return 'qoder';
    if (/(^|\.)opencode\.ai$/.test(host)) return 'opencode';
    if (/(^|\.)aliyuncs\.com$/.test(host)) return 'aliyun';
    if (p.appType === 'codex' && (p.isOfficial === true || /(^|\.)(chatgpt|openai)\.com$/.test(host))) return 'codex';
    // Last resort: the provider NAME. Covers relays/proxies whose hostname
    // says nothing about the vendor (users name them 火山/阿里 explicitly).
    const name = String(p.name || '');
    if (/火山|volc|方舟|\bark\b/i.test(name)) return 'ark';
    if (/阿里|aliyun|阿里云|百炼|bailian|dashscope/i.test(name)) return 'aliyun';
    return null;
  }

  function arkPlanFromBaseUrl(baseUrl) {
    const path = (() => { try { return new URL(baseUrl || '').pathname.toLowerCase(); } catch (_) { return ''; } })();
    if (/(^|\/)coding(\/|$)/.test(path)) return 'coding-plan';
    if (/(^|\/)plan(\/|$)/.test(path)) return 'agent-plan';
    return '';
  }

  function quotaProviderCacheKey(kind, provider) {
    if (kind === 'ark') {
      const plan = arkPlanFromBaseUrl(provider && provider.baseUrl);
      return `ark:${plan || (provider && provider.baseUrl) || 'unknown'}`;
    }
    return kind;
  }

  function quotaRouteForProvider(kind, provider) {
    const route = QUOTA_ROUTES[kind];
    if (!route) return '';
    if (kind === 'ark' && provider && provider.baseUrl) return `${route}?baseUrl=${encodeURIComponent(provider.baseUrl)}`;
    return route;
  }

  function formatProviderQuotaBadge(kind, data) {
    if (!data || typeof data !== 'object') return null;
    const st = data.status;
    if (st === 'not_configured') return { text: '余量：未配置', color: QUOTA_GRAY, title: '未配置对应 provider' };
    if (st === 'needs_auth') return { text: '余量：需登录', color: QUOTA_AMBER, title: data.error || '需要登录后才能查询余量' };
    if (st === 'needs_login') return { text: '余量：需登录（点击登录）', color: QUOTA_AMBER, title: `${data.error || '需要登录后才能查询余量'}。${QUOTA_LOGIN_ROUTES[kind] ? '点击会由 multicc 拉起一个 Chrome 登录窗口，登录后回来重点一次即可' : '请先在浏览器中登录对应站点'}` };
    if (st === 'needs_install') return { text: '余量：未安装 arkcli', color: QUOTA_AMBER, title: data.error || 'arkcli 未安装' };
    if (st === 'chrome_unavailable') return { text: '余量：浏览器不可用（点击重试）', color: QUOTA_AMBER, title: `托管 headless Chrome 启动失败且没有可连的调试 Chrome${QUOTA_LOGIN_ROUTES[kind] ? '。点击可尝试拉起登录窗口' : ''}` };
    if (st !== 'ok') return { text: '余量：暂不可用', color: QUOTA_AMBER, title: data.error || '查询失败' };

    if (kind === 'zhipu') {
      const sites = (data.sites || []).filter(s => s && s.ok && Number.isFinite(s.usedPercent));
      if (!sites.length) return { text: '余量：暂不可用', color: QUOTA_AMBER, title: '无有效窗口数据' };
      let maxPct = 0; const parts = [];
      for (const s of sites) {
        maxPct = Math.max(maxPct, s.usedPercent, Number.isFinite(s.weeklyUsedPercent) ? s.weeklyUsedPercent : 0);
        let seg = `${s.site} ${s.period === 'weekly' ? '周' : '5h'} ${quotaFmt2(s.usedPercent)}%`;
        if (Number.isFinite(s.weeklyUsedPercent)) seg += ` · 周 ${quotaFmt2(s.weeklyUsedPercent)}%`;
        parts.push(seg);
      }
      return { text: '余量 ' + parts.join(' · '), color: quotaPctColor(maxPct), title: 'Zhipu 窗口用量（5h / 周）' };
    }
    if (kind === 'kimi') {
      // Subscription keys 401 on the balance API; their usage comes from the
      // logged-in membership page scrape instead.
      if (data.source === 'subscription-page') {
        const root = typeof window !== 'undefined' ? window : null;
        const { segs, maxUsed } = windowSummarySegments(data.summary, Date.now(), root);
        if (!segs.length) return { text: '余量 Kimi 订阅（已抓取页面）', color: QUOTA_AMBER, title: `订阅页未解析出百分比。原文：${String(data.text || '').slice(0, 300)}` };
        return {
          text: '余量 ' + segs.join(' · '),
          color: quotaPctColor(maxUsed),
          title: `Kimi 订阅用量（会员页抓取，统一窗口模板：剩余% + 倒计时）。原文：${String(data.text || '').slice(0, 300)}`,
        };
      }
      const sites = (data.sites || []).filter(s => s && s.ok && Number.isFinite(s.available));
      if (!sites.length) return { text: '余量：暂不可用', color: QUOTA_AMBER, title: '无有效余额数据' };
      const minAvail = Math.min.apply(null, sites.map(s => s.available));
      return { text: '余量 ' + sites.map(s => `${s.site} ¥${quotaFmt2(s.available)}`).join(' · '), color: quotaMoneyColor(minAvail), title: 'Kimi 预付余额（CNY）' };
    }
    if (kind === 'codex') {
      const w = data.weekly || {};
      if (!Number.isFinite(w.usedPercent)) return { text: '余量：暂不可用', color: QUOTA_AMBER, title: '无周窗口数据' };
      return { text: `余量 周 ${quotaFmt2(w.usedPercent)}% 已用`, color: quotaPctColor(w.usedPercent), title: 'Codex 周窗口用量' + (data.planType ? ` · ${data.planType}` : '') };
    }
    if (kind === 'ark') {
      if (data.bar && typeof data.bar === 'object' && data.bar.text) {
        return {
          text: `余量 ${data.bar.text}`,
          color: data.bar.color || QUOTA_GRAY,
          title: data.bar.title || '火山方舟套餐额度（当前 provider）',
        };
      }
      let worst = null;
      for (const it of (data.items || [])) {
        if (!it || it.subscribed !== true) continue;
        for (const pd of (it.periods || [])) {
          if (pd && Number.isFinite(pd.percent) && (!worst || pd.percent > worst.percent)) worst = { label: pd.label, used: pd.used, total: pd.total, percent: pd.percent, product: it.product };
        }
      }
      if (!worst) return { text: '余量：无生效套餐', color: QUOTA_GRAY, title: 'arkcli 未返回已订阅套餐' };
      // coding-plan periods (session/周/月) carry only a percent — no used/total —
      // so render percent-only instead of interpolating null into the text.
      const usage = (worst.used != null && worst.total != null)
        ? `${quotaFmt2(worst.used)}/${quotaFmt2(worst.total)} (${quotaFmt2(worst.percent)}%)`
        : `${quotaFmt2(worst.percent)}%`;
      // Coding Plan 的「当前会话」窗口就是与 Agent Plan 相同的 5h 滚动窗口。
      const windowLabel = String(worst.label || '').toLowerCase() === 'session' ? '5h' : (worst.label || '');
      return { text: `余量 ${worst.product || 'Ark'} ${windowLabel} ${usage}`, color: quotaPctColor(worst.percent), title: '火山方舟套餐额度（最紧张周期）' };
    }
    if (kind === 'qoder') {
      const total = (data.quota && data.quota.total_quota && data.quota.total_quota.quota_summary) || {};
      const limit = Number(total.limit_value) || 0;
      if (!limit) return { text: '余量：暂不可用', color: QUOTA_AMBER, title: '无 credits 数据' };
      const remaining = Number(total.remaining_value) || 0;
      const pct = Number(total.usage_percentage) || Math.round(((Number(total.used_value) || 0) / limit) * 100);
      return { text: `余量 ${remaining}/${limit} credits (${pct}%)`, color: quotaPctColor(pct), title: 'Qoder CN credits' };
    }
    if (kind === 'opencode') {
      const u = data.usage || {};
      const parts = []; let maxPct = 0;
      const win = (label, w) => { if (w && Number.isFinite(w.usagePercent)) { maxPct = Math.max(maxPct, w.usagePercent); parts.push(`${label} ${w.usagePercent}%`); } };
      win('5h', u.rolling); win('周', u.weekly); win('月', u.monthly);
      if (!parts.length) return { text: '余量：暂不可用', color: QUOTA_AMBER, title: '无用量窗口数据' };
      return { text: '余量 ' + parts.join(' · '), color: quotaPctColor(maxPct), title: 'OpenCode Go 窗口用量' };
    }
    if (kind === 'aliyun') {
      // Bailian console scrape: same unified window template as kimi.
      const root = typeof window !== 'undefined' ? window : null;
      const { segs, maxUsed } = windowSummarySegments(data.summary, Date.now(), root);
      if (!segs.length) return { text: '余量 阿里云（已抓取页面）', color: QUOTA_AMBER, title: `百炼控制台未解析出百分比。原文：${String(data.text || '').slice(0, 300)}` };
      return {
        text: '余量 ' + segs.join(' · '),
        color: quotaPctColor(maxUsed),
        title: `阿里云百炼用量（控制台抓取，统一窗口模板：剩余% + 倒计时）。原文：${String(data.text || '').slice(0, 300)}`,
      };
    }
    return null;
  }

  function quotaCacheRead(root) {
    try {
      const raw = root.localStorage ? root.localStorage.getItem(QUOTA_CACHE_KEY) : null;
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_) { return {}; }
  }
  function quotaCacheWrite(root, cache) {
    try { if (root.localStorage) root.localStorage.setItem(QUOTA_CACHE_KEY, JSON.stringify(cache)); } catch (_) { /* quota cache is best-effort */ }
  }

  function injectProviderQuotas(catalog, jsonFn) {
    const root = typeof window !== 'undefined' ? window : null;
    if (!root || !root.document) return;
    const providers = (catalog && catalog.providers) || [];
    const cache = quotaCacheRead(root);
    const byId = new Map(providers.map(p => [p.id, p]));
    const pending = new Set();
    let openLoginWindow = null;

    const paint = () => {
      root.document.querySelectorAll('[data-quota-id]').forEach(el => {
        const provider = byId.get(el.getAttribute('data-quota-id'));
        const kind = quotaKindForProvider(provider);
        const cacheKey = quotaProviderCacheKey(kind, provider);
        if (!kind) {
          // Never promise a result for a vendor with no quota endpoint.
          el.textContent = '余量 —（无余量接口）';
          el.style.color = QUOTA_GRAY;
          el.style.cursor = '';
          el.onclick = null;
          el.title = '该服务商未提供余量查询接口（目前支持 ark / 智谱 / Kimi / Codex / Qoder / OpenCode / 阿里云百炼 官方源）';
          return;
        }
        const entry = cache[cacheKey];
        const view = entry ? formatProviderQuotaBadge(kind, entry.data) : null;
        if (view) {
          el.textContent = view.text;
          el.style.color = view.color;
          el.title = view.title + '。数字来自服务端配置的同厂商凭证，未必属于这张卡的 key；点击重新查询';
        } else if (pending.has(cacheKey)) {
          el.textContent = '余量 查询中…';
          el.style.color = QUOTA_GRAY;
          el.title = '正在查询余量…';
        } else {
          el.textContent = '余量 —（暂无数据）';
          el.style.color = QUOTA_GRAY;
          el.title = '尚无余量数据；点击重新查询';
        }
        el.style.cursor = 'pointer';
        const st = entry && entry.data ? entry.data.status : '';
        const actionable = (st === 'needs_login' || st === 'chrome_unavailable') && QUOTA_LOGIN_ROUTES[kind] && openLoginWindow;
        el.onclick = actionable ? () => openLoginWindow(kind, el) : () => fetchKind(kind, provider, true);
      });
    };
    paint();

    const fetchFn = jsonFn || (root.MultiCCApi && typeof root.MultiCCApi.json === 'function' ? root.MultiCCApi.json.bind(root.MultiCCApi) : null);
    if (!fetchFn) return;

    // Ask the server to pop a visible Chrome (managed profile) at the vendor
    // login page. The server stops its headless instance first — one profile,
    // one Chrome — and the window stays for the user to log into.
    openLoginWindow = (kind, el) => {
      el.textContent = '正在打开登录窗口…';
      el.title = 'multicc 正在拉起 Chrome 登录窗口…';
      Promise.resolve()
        .then(() => fetchFn(QUOTA_LOGIN_ROUTES[kind], { method: 'POST' }))
        .then((data) => {
          el.textContent = '已打开登录窗口，登录后重点余量';
          el.title = (data && data.message) || '登录完成后点击重新查询余量';
        }, (err) => {
          el.textContent = '登录窗口打开失败（点击重试）';
          el.title = (err && err.message) || String(err);
        });
    };
    paint();

    function fetchKind(kind, provider, force) {
      const cacheKey = quotaProviderCacheKey(kind, provider);
      const now = Date.now();
      if (!force && quotaLastFetch[cacheKey] && now - quotaLastFetch[cacheKey] < QUOTA_REFETCH_MS) return;
      quotaLastFetch[cacheKey] = now;
      pending.add(cacheKey);
      paint();
      const done = (data) => {
        pending.delete(cacheKey);
        cache[cacheKey] = { fetchedAt: now, data };
        quotaCacheWrite(root, cache);
        paint();
      };
      Promise.resolve()
        .then(() => fetchFn(quotaRouteForProvider(kind, provider)))
        .then(done, (err) => done((err && err.details && typeof err.details === 'object') ? err.details : { status: 'unavailable' }));
    }

    const seen = new Set();
    for (const provider of providers) {
      const kind = quotaKindForProvider(provider);
      if (!kind) continue;
      const cacheKey = quotaProviderCacheKey(kind, provider);
      if (seen.has(cacheKey)) continue;
      seen.add(cacheKey);
      fetchKind(kind, provider, false);
    }
  }

  return {
    normalizeProvider,
    providerDisplayName,
    cliDisplayName,
    cliEngine,
    cliKinds,
    cliOffersIn,
    cliMeta,
    cliMetaMap,
    cliShortMark,
    cliColour,
    cliProviderless,
    cliDeprecated,
    cliReplacedBy,
    cliFamilyOf,
    cliFamilyName,
    cliLanesOf,
    cliFamiliesFor,
    providerlessClis,
    nativeRouteLabel,
    CLI_DISPLAY,
    CLI_FAMILIES,
    CLI_LANE_FAMILY,
    CLI_KINDS,
    CLI_DEFAULT_COLOUR,
    CLI_DEFAULT_KINDS,
    officialProviderKind,
    normalizeCatalog,
    normalizeDefaults,
    normalizeModelOptions,
    formatCompactTokens,
    formatUsageWindow,
    formatUsageCumulative,
    groupByAppType,
    groupByProtocol,
    providersForCli,
    findProvider,
    modelsFor,
    normalizeDeleteReferences,
    deleteReferenceDisplayData,
    quotaKindForProvider,
    formatProviderQuotaBadge,
    injectProviderQuotas,
  };
});
