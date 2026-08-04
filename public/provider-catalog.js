'use strict';

(function initProviderCatalog(root, factory) {
  const catalog = factory();
  if (typeof module === 'object' && module.exports) module.exports = catalog;
  if (root) root.MultiCCProviderCatalog = catalog;
})(typeof window !== 'undefined' ? window : null, function createProviderCatalog() {
  const APP_TYPES = new Set(['claude', 'codex']);
  const API_FORMATS = new Set(['anthropic', 'openai_responses', 'openai_chat']);
  const ALIAS_TIERS = ['opus', 'sonnet', 'haiku', 'fable'];

  function text(value, max = 300) {
    const out = String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
    return out.length > max ? out.slice(0, max) : out;
  }

  function number(value) {
    const result = Number(value);
    return Number.isFinite(result) && result >= 0 ? result : 0;
  }

  function formatCompactTokens(value) {
    const count = number(value);
    if (count >= 1000000) return `${(count / 1000000).toFixed(1).replace(/\.0$/, '')}M`;
    if (count >= 1000) return `${(count / 1000).toFixed(1).replace(/\.0$/, '')}K`;
    return String(count);
  }

  function formatUsageWindow(value) {
    const window = normalizeWindow(value);
    if (window.inputTokens + window.outputTokens === 0) return '';
    const output = formatCompactTokens(window.outputTokens);
    if (!window.breakdownKnown) {
      return `入(含缓存):${formatCompactTokens(window.inputTokens)}/出:${output}`;
    }
    const unknown = window.unattributedInputTokens;
    return `新:${formatCompactTokens(window.freshInputTokens)}` +
      `/缓读:${formatCompactTokens(window.cacheReadTokens)}` +
      `/缓写:${formatCompactTokens(window.cacheWriteTokens)}` +
      `${unknown ? `/未分:${formatCompactTokens(unknown)}` : ''}/出:${output}`;
  }

  function formatUsageCumulative(value) {
    const stat = value && typeof value === 'object' ? value : {};
    if (!stat.breakdownKnown) return `输入含缓存 ${formatCompactTokens(stat.inputTokens)}`;
    const unknown = number(stat.unattributedInputTokens);
    return `新 ${formatCompactTokens(stat.freshInputTokens)}` +
      ` / 缓读 ${formatCompactTokens(stat.cacheReadTokens)}` +
      ` / 缓写 ${formatCompactTokens(stat.cacheWriteTokens)}` +
      `${unknown ? ` / 未分 ${formatCompactTokens(unknown)}` : ''}`;
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
      : (appType === 'claude' ? 'anthropic' : (value.useChatResponsesProxy ? 'openai_chat' : 'openai_responses'));
    const zcodeCompatible = !!safeBaseUrl(value.baseUrl) && value.hasToken === true;
    const defaultClis = [
      ...(apiFormat === 'anthropic' ? ['claude', 'opencode'] : ['codex', 'opencode']),
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
        .filter(cli => ['claude', 'codex', 'opencode', 'zcode'].includes(cli)
          && (cli !== 'zcode' || zcodeCompatible))),
      requiresConversionFor: Object.freeze((Array.isArray(value.requiresConversionFor) ? value.requiresConversionFor : (apiFormat === 'openai_chat' ? ['codex'] : []))
        .filter(cli => cli === 'codex')),
      baseUrl: safeBaseUrl(value.baseUrl),
      model,
      modelOptions: Object.freeze(normalizeModelOptions(value.modelOptions || value.models, model)),
      aliasOnly: value.aliasOnly === true,
      aliasMap: Object.freeze(normalizeAliasMap(value.aliasMap)),
      useChatResponsesProxy: value.useChatResponsesProxy === true,
      tokenMask: safeTokenMask(value.tokenMask),
      hasToken: value.hasToken === true,
      isOfficial: value.isOfficial === true,
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
    const groups = { anthropic: [], openai_responses: [], openai_chat: [] };
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

  function quotaPctColor(pct) {
    if (pct >= 90) return '#f85149';
    if (pct >= 70) return QUOTA_AMBER;
    return '#58a6ff';
  }
  function quotaMoneyColor(v) {
    if (v <= 0) return '#f85149';
    if (v <= 5) return QUOTA_AMBER;
    return '#58a6ff';
  }
  function quotaFmt2(n) { return String(Number(Number(n).toFixed(2))); }

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
        const sum = (data.summary || []).filter(s => s && Number.isFinite(s.percent));
        if (!sum.length) return { text: '余量 Kimi 订阅（已抓取页面）', color: QUOTA_AMBER, title: `订阅页未解析出百分比。原文：${String(data.text || '').slice(0, 300)}` };
        const maxPct = Math.max.apply(null, sum.map(s => s.percent));
        return {
          text: '余量 ' + sum.map(s => `${s.label || 'Kimi'} ${s.percent}%`).join(' · '),
          color: quotaPctColor(maxPct),
          title: `Kimi 订阅用量（会员页抓取，已用百分比）。原文：${String(data.text || '').slice(0, 300)}`,
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
      return { text: `余量 ${worst.product || 'Ark'} ${worst.label || ''} ${usage}`, color: quotaPctColor(worst.percent), title: '火山方舟套餐额度（最紧张周期）' };
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
      // Bailian console scrape: percent windows like the kimi membership page.
      const sum = (data.summary || []).filter(s => s && Number.isFinite(s.percent));
      if (!sum.length) return { text: '余量 阿里云（已抓取页面）', color: QUOTA_AMBER, title: `百炼控制台未解析出百分比。原文：${String(data.text || '').slice(0, 300)}` };
      const maxPct = Math.max.apply(null, sum.map(s => s.percent));
      return {
        text: '余量 ' + sum.map(s => `${s.label || '百炼'} ${s.percent}%`).join(' · '),
        color: quotaPctColor(maxPct),
        title: `阿里云百炼用量（控制台抓取，已用百分比）。原文：${String(data.text || '').slice(0, 300)}`,
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
        const kind = quotaKindForProvider(byId.get(el.getAttribute('data-quota-id')));
        if (!kind) {
          // Never promise a result for a vendor with no quota endpoint.
          el.textContent = '余量 —（无余量接口）';
          el.style.color = QUOTA_GRAY;
          el.style.cursor = '';
          el.onclick = null;
          el.title = '该服务商未提供余量查询接口（目前支持 ark / 智谱 / Kimi / Codex / Qoder / OpenCode / 阿里云百炼 官方源）';
          return;
        }
        const entry = cache[kind];
        const view = entry ? formatProviderQuotaBadge(kind, entry.data) : null;
        if (view) {
          el.textContent = view.text;
          el.style.color = view.color;
          el.title = view.title + '。数字来自服务端配置的同厂商凭证，未必属于这张卡的 key；点击重新查询';
        } else if (pending.has(kind)) {
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
        el.onclick = actionable ? () => openLoginWindow(kind, el) : () => fetchKind(kind, true);
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

    function fetchKind(kind, force) {
      const now = Date.now();
      if (!force && quotaLastFetch[kind] && now - quotaLastFetch[kind] < QUOTA_REFETCH_MS) return;
      quotaLastFetch[kind] = now;
      pending.add(kind);
      paint();
      const done = (data) => {
        pending.delete(kind);
        cache[kind] = { fetchedAt: now, data };
        quotaCacheWrite(root, cache);
        paint();
      };
      Promise.resolve()
        .then(() => fetchFn(QUOTA_ROUTES[kind]))
        .then(done, (err) => done((err && err.details && typeof err.details === 'object') ? err.details : { status: 'unavailable' }));
    }

    const kinds = new Set(providers.map(quotaKindForProvider).filter(Boolean));
    for (const kind of kinds) fetchKind(kind, false);
  }

  return {
    normalizeProvider,
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
