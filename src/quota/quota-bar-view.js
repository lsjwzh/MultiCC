'use strict';

// The one place a quota bar is written.
//
// Every limit bar in multicc — 8 of them, across two clients — used to be
// formatted twice: once in public/chat-rate-limit.js for the web, once by hand
// in app/lib/models/vendor_quota.dart for the app. Two implementations of the
// same pure function drift by construction, and they had: the app's Zhipu bar
// forgot sortWindowSegs, dropped both reset timestamps from its tooltip and the
// '点击 bar 刷新' line, and three bars (opencode / codex / DeepSeek balance) were
// never ported at all.
//
// So the vendor JSON is rendered HERE, once, and both clients display the
// result verbatim. What a client may still decide is deliberately tiny:
//
//   1. WHETHER a bar is on screen (gated on the session's cli / provider
//      baseUrl — the server does not know which chat you are looking at).
//   2. WHICH state to show: `view.states.<name>` are complete alternative
//      renders for the client-owned states (a fetch in flight, a login window
//      waiting on a human). The client picks; it never writes the words.
//   3. Substituting the two time-relative tokens, below.
//
// ── The two placeholders ────────────────────────────────────────────────────
// A rendered bar is cached by the client (localStorage on web, memory in the
// app) and re-displayed long after it was produced, so "3 分钟前" and "42m 后
// 重置" cannot be baked in. Both are emitted as placeholders over an ABSOLUTE
// epoch-ms anchor, and both clients expand them at paint time:
//
//   {cd:<epochMs>}   → humanizeCountdown(epochMs - now)   "42m" · "3d 5h"
//   {ago:<epochMs>}  → relativeAgo(epochMs)               "刚刚" · "57s 前"
//
// A placeholder is only emitted when its anchor exists, so neither ever expands
// to the empty string — the surrounding separators are safe to bake in. The
// expansion rule is the ONLY quota logic that still exists twice (see
// public/quota-bar-view.js and app/lib/models/quota_bar_view.dart); it is ~20
// lines of arithmetic with no vendor strings in it, and
// tests/test-quota-bar-parity.js pins both copies to the same golden fixtures.

const COLOR = Object.freeze({
  gray: '#8b949e',
  red: '#f85149',
  yellow: '#d29922',
  blue: '#58a6ff',
});

function finiteNumber(value) {
  if (value === null || value === '' || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

// ── Unified compact quota display ───────────────────────────────────────────
// Every provider renders its windows as `<window> <remaining%> <countdown>`
// segments joined by ' · ', e.g. `5h 20% 1.2h · 1wk 50% 3d 5h · 1m 60% 14d`.
// The percent is REMAINING (100 − used), not used. Money providers (DeepSeek /
// Kimi) render `¥<amount>` instead.

function unifiedRemaining(usedPercent) {
  const used = finiteNumber(usedPercent);
  if (used === null) return null;
  return Math.max(0, Math.min(100, Math.round(100 - used)));
}

function unifiedColorFromRemaining(rem) {
  if (rem === null) return COLOR.blue;
  if (rem <= 10) return COLOR.red;
  if (rem <= 30) return COLOR.yellow;
  return COLOR.blue;
}

function unifiedBalanceText(amount, currency) {
  const a = finiteNumber(amount);
  if (a === null) return '';
  const sym = currency === 'USD' ? '$' : currency === 'CNY' ? '¥' : '';
  return `${sym}${a.toFixed(2)}`;
}

function cdTag(resetsAtMs) {
  const at = finiteNumber(resetsAtMs);
  return at === null || at <= 0 ? '' : `{cd:${Math.trunc(at)}}`;
}

function agoTag(tsMs) {
  const ts = finiteNumber(tsMs);
  return ts === null || ts <= 0 ? '' : `{ago:${Math.trunc(ts)}}`;
}

// One window → `<label> <remaining>% [<countdown>]`; '' when percent is missing.
function windowSeg(label, usedPercent, resetsAtMs) {
  const rem = unifiedRemaining(usedPercent);
  if (rem === null) return '';
  const cd = cdTag(resetsAtMs);
  return cd ? `${label} ${rem}% ${cd}` : `${label} ${rem}%`;
}

// Canonical window-bar display order: short → long, 5h → 1wk → 1m. Rank by the
// window token, NOT by the segment's leading word — Claude names a weekly row
// after what it meters ("1wk-ALL"), and that must still sort as a week.
const WINDOW_RANK = Object.freeze({ '5h': 0, '1wk': 1, '1m': 2 });
function windowRank(token) {
  const r = WINDOW_RANK[String(token || '').split('-')[0]];
  return r === undefined ? 3 : r;
}

// Stable sort into canonical order. `entries` are {window, seg}; unknown window
// tokens sort last but keep their relative order.
function sortSegs(entries) {
  return entries
    .map((e, i) => ({ e, i }))
    .sort((a, b) => (windowRank(a.e.window) - windowRank(b.e.window)) || (a.i - b.i))
    .map(({ e }) => e.seg)
    .filter(Boolean);
}

function view(text, color, title, action) {
  return Object.freeze({ text, color, title: title || '', action: action || null });
}

// Every bar's "a fetch this client started is in flight" render. The vendor name
// still comes from here rather than from a client-side table.
function loadingView(label, title) {
  return view(`${label}：加载中…`, COLOR.gray, title);
}

// The one failure the server cannot render for the client, because the client
// never reached it: the request itself did not complete. Pre-rendered here with
// every other state so a dead network still shows the vendor's own name.
function unreachableView(label) {
  return view(`${label} · 请求失败 ⟳ 重试`, COLOR.gray,
    `无法连接 MultiCC 服务，未能取到${label}用量。点击重试。`);
}

function withStates(base, states) {
  return Object.freeze({ ...base, states: Object.freeze(states) });
}

// ── OpenCode Go (5h / weekly / monthly) ─────────────────────────────────────

function openCodeBar(value) {
  if (!value) {
    return view('OpenCode Go 余量 · ⟳ 刷新', COLOR.gray,
      '点击从 opencode.ai Zen console 拉取 Go 订阅 5h / 周 / 月 用量');
  }
  if (value.status === 'needs_login') {
    return view('OpenCode Go：需登录 · 点击打开登录窗口', COLOR.red,
      '你的 Chrome 里没有 opencode.ai 的登录态。点击将由 multicc 拉起一个 Chrome 登录窗口（opencode.ai/auth），走完 OAuth 后回来再点一次刷新。',
      'login');
  }
  if (value.status === 'chrome_unavailable') {
    return view('OpenCode Go：无可连的 Chrome · 点击尝试打开登录窗口', COLOR.yellow,
      '托管 Chrome 起不来，也没有可连的调试端点。点击会尝试拉起一个可见的 Chrome 登录窗口；也可以自己开一个带调试端点的 Chrome（--remote-debugging-port=0 即可，我们会从 DevToolsActivePort 找到它）并在其中登录 opencode.ai。',
      'login');
  }
  if (value.status !== 'ok' || !value.usage) {
    return view('OpenCode Go：用量暂不可用 · ⟳ 重试', COLOR.yellow,
      value.error || '无法从 opencode.ai 拉取 Go 用量');
  }
  const u = value.usage;
  const fmt = (n) => {
    const r = Math.round(n);
    return Number.isInteger(r) ? String(r) : (Math.round(n * 10) / 10).toString();
  };
  // `resetInSec` is a duration measured when the console was scraped. Anchoring
  // it to fetchedAt turns it into a real deadline, so the countdown decays on
  // screen instead of freezing at whatever it was when the scrape ran.
  const fetchedAt = finiteNumber(value.fetchedAt) || 0;
  const resetAt = (sec) => {
    const s = finiteNumber(sec);
    return s === null || !fetchedAt ? null : fetchedAt + s * 1000;
  };
  const entries = [];
  for (const [key, token] of [['rolling', '5h'], ['weekly', '1wk'], ['monthly', '1m']]) {
    const w = u[key];
    if (!w || !Number.isFinite(w.usagePercent)) continue;
    entries.push({ window: token, seg: windowSeg(token, w.usagePercent, resetAt(w.resetInSec)) });
  }
  const ago = agoTag(value.fetchedAt);
  let text = `OpenCode Go · ${sortSegs(entries).join(' · ') || '—'}`;
  if (ago) text += ` · ${ago}`;
  text += ' ⟳';

  const maxPct = Math.max(
    u.rolling?.usagePercent ?? 0,
    u.weekly?.usagePercent ?? 0,
    u.monthly?.usagePercent ?? 0,
  );
  let color = COLOR.blue;
  if (maxPct >= 90) color = COLOR.red;
  else if (maxPct >= 70) color = COLOR.yellow;

  const lines = ['OpenCode Go 订阅用量（CDP 抓 opencode.ai Zen console）'];
  for (const [key, zh] of [['rolling', '5h'], ['weekly', '周'], ['monthly', '月']]) {
    const w = u[key];
    if (!w) continue;
    const at = resetAt(w.resetInSec);
    // An exhausted window reports status:"rate-limited" — say so, because a
    // segment sitting at "0% 余量" alone reads like a glitch.
    const limited = w.status === 'rate-limited' ? ' · 已限流' : '';
    lines.push(`${zh}: ${fmt(w.usagePercent)}%${at ? ` · 重置 ${cdTag(at)} 后` : ''}${limited}`);
  }
  if (ago) lines.push(`同步于 ${ago}`);
  lines.push('点击 bar 刷新');
  if (u.useBalance) lines.push('已启用：超额用余额兜底');
  return view(text, color, lines.join('\n'));
}

// ── Qoder CN (billing-cycle credits) ────────────────────────────────────────

function normalizeResetTime(value) {
  const number = finiteNumber(value);
  if (number === null || number <= 0) return null;
  return Math.trunc(number < 10_000_000_000 ? number * 1000 : number);
}

function qoderBar(value) {
  if (!value) {
    return view('Qoder CN 余量 · ⟳ 刷新', COLOR.gray, '点击从 qoder.com.cn 拉取 credits 用量');
  }
  if (value.status === 'needs_login') {
    return view('Qoder CN：需登录 · 点击打开登录页', COLOR.red,
      '你的 Chrome 里没有 qoder.com.cn 的登录态。点击将在 Chrome 中打开登录页，登录后再点刷新。',
      'login');
  }
  if (value.status === 'chrome_unavailable') {
    return view('Qoder CN：无可连的 Chrome · 点击尝试打开登录窗口', COLOR.yellow,
      '托管 Chrome 起不来，也没有可连的调试端点。点击会尝试拉起一个可见的 Chrome 登录窗口；在其中登录 qoder.com.cn 一次，之后一周的刷新都走缓存 cookie，不再需要浏览器。',
      'login');
  }
  if (value.status !== 'ok' || !value.quota) {
    return view('Qoder CN：用量暂不可用 · ⟳ 重试', COLOR.yellow,
      value.error || '无法从 qoder.com.cn 拉取用量');
  }
  const q = value.quota;
  const total = q.total_quota?.quota_summary || {};
  const planQ = q.plan_quota?.quota_summary || {};
  const pkg = q.resource_package_quota?.quota_summary || {};
  const used = total.used_value ?? 0;
  const limit = total.limit_value ?? 0;
  const remaining = total.remaining_value ?? 0;
  const pct = total.usage_percentage ?? (limit > 0 ? Math.round(used / limit * 100) : 0);

  // Credits reset on the billing cycle: the usage API's top-level `nextResetAt`,
  // else the plan API's end_date / next_refresh_date.
  const resetAt = normalizeResetTime(q.nextResetAt)
    ?? normalizeResetTime(value.plan && value.plan.end_date)
    ?? normalizeResetTime(value.plan && value.plan.next_refresh_date);

  const ago = agoTag(value.fetchedAt);
  let text = windowSeg('1m', pct, resetAt) || '—';
  if (ago) text += ` · ${ago}`;
  text += ' ⟳';

  const planTier = value.plan?.plan_tier?.replace('PLAN_TIER_', '') || '';
  let title = `Qoder CN 用量（CDP 抓 qoder.com.cn）\n套餐: ${planTier}\n总计: ${used}/${limit} · 剩余 ${remaining}`;
  if (planQ.limit_value) title += `\n套餐配额: ${planQ.used_value}/${planQ.limit_value}`;
  if (pkg.limit_value) title += `\n加油包: ${pkg.used_value}/${pkg.limit_value} (剩 ${pkg.remaining_value})`;
  title += resetAt !== null
    ? `\n重置: ${cdTag(resetAt)} 后`
    : '\n到期时间未知（API 未返回 nextResetAt/套餐到期日）';
  if (ago) title += `\n同步于 ${ago}`;
  title += '\n点击 bar 刷新';
  return view(text, unifiedColorFromRemaining(unifiedRemaining(pct)), title);
}

// ── Codex (ChatGPT weekly quota) ────────────────────────────────────────────

function codexBar(value) {
  if (!value) {
    return view('Codex 余量 · ⟳ 刷新', COLOR.gray, '点击从 chatgpt.com 拉取 Codex 周额度用量');
  }
  if (value.status === 'no_auth') {
    return view('Codex：未登录 · ⟳ 重试', COLOR.red,
      '未找到 ~/.codex/auth.json。请先在终端运行 codex 完成登录。');
  }
  if (value.status !== 'ok' || !value.weekly) {
    return view('Codex：用量暂不可用 · ⟳ 重试', COLOR.yellow,
      value.error || '无法从 chatgpt.com 拉取用量');
  }
  const w = value.weekly;
  const used = w.usedPercent ?? 0;
  const resetAt = w.resetsAt ? w.resetsAt * 1000 : null;
  const ago = agoTag(value.fetchedAt);
  let text = windowSeg('1wk', used, resetAt) || '—';
  if (ago) text += ` · ${ago}`;
  text += ' ⟳';

  let title = `Codex 周额度（chatgpt.com/backend-api/wham/usage）\n套餐: ${value.planType || '?'}${value.email ? ' · ' + value.email : ''}\n已用 ${used}% · 剩余 ${w.remainingPercent ?? 0}%`;
  if (resetAt) title += `\n重置: ${cdTag(resetAt)} 后`;
  for (const a of (value.additional || [])) title += `\n${a.name}: ${a.usedPercent}% 已用`;
  if (value.credits && value.credits.hasCredits) title += `\nCredits 余额: ${value.credits.balance}`;
  if (ago) title += `\n同步于 ${ago}`;
  title += '\n点击 bar 刷新';
  return view(text, unifiedColorFromRemaining(unifiedRemaining(value.limitReached ? 100 : used)), title);
}

// ── Volcano Ark (火山方舟) ──────────────────────────────────────────────────

function arkProductLabel(product) {
  if (product === 'agent-plan') return 'Agent';
  if (product === 'coding-plan') return 'Coding';
  if (product === 'agent-plan-team') return 'Agent团队';
  if (product === 'coding-plan-team') return 'Coding团队';
  return product || '?';
}

function arkPeriodLabel(label) {
  const l = String(label || '').toLowerCase();
  if (l === 'weekly') return '周';
  if (l === 'monthly') return '月';
  if (l === 'session') return '会话';
  return String(label || '?');
}

function arkWindowLabel(label) {
  const l = String(label || '').toLowerCase();
  if (l === '5h') return '5h';
  if (l === 'weekly') return '1wk';
  if (l === 'monthly') return '1m';
  if (l === 'session') return '会话';
  return l || '?';
}

// Which subscription plan the provider's baseUrl points to: Volcano Ark serves
// Coding Plan under /api/coding(/v3) and Agent Plan under /api/plan.
function arkPlanFromBaseUrl(baseUrl) {
  if (!baseUrl || typeof baseUrl !== 'string') return null;
  try {
    const p = new URL(baseUrl).pathname.toLowerCase();
    if (p.includes('/coding')) return 'coding-plan';
    if (p.includes('/plan')) return 'agent-plan';
  } catch (_) { /* unparseable → unknown */ }
  return null;
}

// Round to at most 2 decimals; trailing zeros dropped (99.487 → 99.49, 250 → 250).
function fmtNum(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return String(n ?? '');
  return String(Number(v.toFixed(2)));
}

function arkBar(value, baseUrl) {
  if (!value) {
    return view('火山方舟 余量 · ⟳ 刷新', COLOR.gray, '点击通过 arkcli 拉取火山方舟套餐额度');
  }
  if (value.status === 'needs_auth') {
    return view('火山方舟：未登录 · 点击登录', COLOR.red,
      'arkcli 未配置火山 SSO 凭证。点击将打开浏览器完成 SSO 登录，登录后再点刷新。',
      'ark_login');
  }
  if (value.status === 'needs_install') {
    return view('火山方舟：未安装 arkcli · 点击安装', COLOR.yellow,
      '未检测到 arkcli。点击将自动执行 npm install -g @volcengine/ark-cli 安装（需本机有 npm）。',
      'ark_install');
  }
  if (value.status !== 'ok' || !Array.isArray(value.items)) {
    return view('火山方舟：用量暂不可用 · ⟳ 重试', COLOR.yellow,
      value.error || '无法通过 arkcli 拉取用量');
  }
  const subscribed = value.items.filter((it) => it.subscribed && !it.error && it.periods && it.periods.length);
  if (!subscribed.length) {
    return view('火山方舟：无生效套餐 · ⟳ 刷新', COLOR.gray,
      '当前身份名下没有已订阅的 AgentPlan / CodingPlan');
  }
  // The plan matching the session's provider baseUrl (or the first subscribed
  // plan when inconclusive) drives the compact bar; every plan's detail still
  // goes to the tooltip so the whole quota picture stays reachable.
  const activePlan = arkPlanFromBaseUrl(baseUrl);
  const ordered = activePlan
    ? [...subscribed].sort((a, b) => Number(b.product === activePlan) - Number(a.product === activePlan))
    : subscribed;
  const plan = ordered[0];
  const entries = [];
  let maxUsed = 0;
  for (const p of plan.periods) {
    const pct = p.percent ?? 0;
    if (pct > maxUsed) maxUsed = pct;
    const token = arkWindowLabel(p.label);
    entries.push({ window: token, seg: windowSeg(token, pct, p.resetAt || null) });
  }
  const titleLines = [];
  for (const it of ordered) {
    const isCurrent = it === plan;
    titleLines.push(`${arkProductLabel(it.product)}${it.tier ? ' · ' + it.tier : ''}${isCurrent ? '（当前 provider）' : ''}`);
    for (const p of it.periods) {
      let line = `  ${arkPeriodLabel(p.label)}: `;
      line += (p.used != null && p.total != null)
        ? `${fmtNum(p.used)}/${fmtNum(p.total)} (${fmtNum(p.percent ?? 0)}%)`
        : `${fmtNum(p.percent ?? 0)}%`;
      if (p.resetAt) line += ` · ${cdTag(p.resetAt)} 后重置`;
      titleLines.push(line);
    }
  }
  const ago = agoTag(value.fetchedAt);
  let text = sortSegs(entries).join(' · ') || '—';
  if (ago) text += ` · ${ago}`;
  text += ' ⟳';

  const viewer = value.viewer;
  let title = '火山方舟套餐额度（arkcli usage plan）';
  if (viewer && (viewer.user_name || viewer.account_id)) {
    title += `\n身份: ${viewer.user_name || viewer.account_id}${viewer.auth_method ? ' · ' + viewer.auth_method : ''}`;
  }
  title += '\n' + titleLines.join('\n');
  if (ago) title += `\n同步于 ${ago}`;
  title += '\n点击 bar 刷新';
  return view(text, unifiedColorFromRemaining(unifiedRemaining(maxUsed)), title);
}

// ── Zhipu official sites (z.ai / bigmodel.cn) ───────────────────────────────

function zhipuBar(value) {
  if (!value) {
    return view('Zhipu 余量 · ⟳ 刷新', COLOR.gray,
      '点击从 z.ai / bigmodel.cn 额度端点拉取窗口用量');
  }
  if (value.status === 'not_configured') {
    return view('Zhipu：未配置 provider · ⟳ 刷新', COLOR.gray,
      '没有 baseUrl 指向 z.ai / bigmodel.cn 的 provider，无法拉取用量');
  }
  if (value.status !== 'ok' || !Array.isArray(value.sites)) {
    return view('Zhipu：用量暂不可用 · ⟳ 重试', COLOR.yellow,
      value.error || '无法从 z.ai / bigmodel.cn 拉取用量');
  }
  const okSites = value.sites.filter((s) => s && s.ok && Number.isFinite(s.usedPercent));
  if (!okSites.length) {
    return view('Zhipu：用量暂不可用 · ⟳ 重试', COLOR.yellow,
      '所有 Zhipu 站点的额度端点都未返回有效窗口数据');
  }
  // The backend orders the caller's current site first; it drives the compact
  // bar (5h + 1wk windows) while every site's detail stays in the tooltip.
  const s = okSites[0];
  const entries = [];
  let maxUsed = s.usedPercent;
  entries.push({ window: '5h', seg: windowSeg('5h', s.usedPercent, s.resetsAt || null) });
  if (Number.isFinite(s.weeklyUsedPercent)) {
    if (s.weeklyUsedPercent > maxUsed) maxUsed = s.weeklyUsedPercent;
    entries.push({ window: '1wk', seg: windowSeg('1wk', s.weeklyUsedPercent, s.weeklyResetsAt || null) });
  }
  const titleLines = [];
  for (const site of okSites) {
    let line = `${site.site} (${site.host}): 5h ${fmtNum(site.usedPercent)}% 已用`;
    if (site.resetsAt) line += ` · ${cdTag(site.resetsAt)} 后重置`;
    if (Number.isFinite(site.weeklyUsedPercent)) {
      line += ` · 周 ${fmtNum(site.weeklyUsedPercent)}% 已用`;
      if (site.weeklyResetsAt) line += `（${cdTag(site.weeklyResetsAt)} 后重置）`;
    }
    if (site.tier) line += ` · ${site.tier}`;
    titleLines.push(line);
  }
  const ago = agoTag(value.fetchedAt);
  let text = sortSegs(entries).join(' · ') || '—';
  if (ago) text += ` · ${ago}`;
  text += ' ⟳';

  let title = 'Zhipu 官方站点窗口用量（glm-monitor 额度端点）';
  title += '\n' + titleLines.join('\n');
  if (ago) title += `\n同步于 ${ago}`;
  title += '\n点击 bar 刷新';
  return view(text, unifiedColorFromRemaining(unifiedRemaining(maxUsed)), title);
}

// ── Kimi / Moonshot (prepaid balance, or subscription-page windows) ─────────

function kimiReasonText(sites) {
  if (!Array.isArray(sites) || !sites.length) return '';
  const s = sites[0];
  if (s.reason === 'auth_rejected') return 'API Key 不支持余额查询（Kimi-for-Coding 密钥无余额接口）';
  if (s.reason === 'endpoint_not_found') return '余额端点不存在';
  if (s.reason === 'network_error') return '网络请求失败';
  if (s.reason === 'bad_shape' || s.reason === 'no_balance_fields') return '接口返回格式异常';
  return s.reason || '';
}

function kimiShortReason(sites) {
  if (!Array.isArray(sites) || !sites.length) return '';
  const s = sites[0];
  if (s.reason === 'auth_rejected') return '密钥不支持余额查询';
  if (s.reason === 'endpoint_not_found') return '余额端点不存在';
  if (s.reason === 'network_error') return '网络请求失败';
  if (s.reason === 'bad_shape' || s.reason === 'no_balance_fields') return '接口格式异常';
  return '';
}

function kimiCachedSites(cached) {
  return (cached && cached.status === 'ok' && Array.isArray(cached.sites))
    ? cached.sites.filter((s) => s && s.ok && Number.isFinite(s.available))
    : [];
}

// The last good cached balance, marked stale so it is never read as fresh.
function kimiCachedView(cachedOk, fetchedAt, reason, headline) {
  const s = cachedOk[0];
  const ago = agoTag(fetchedAt);
  let text = unifiedBalanceText(s.available, s.currency) || '—';
  if (ago) text += ` · 上次 ${ago}`;
  text += ' ⟳';
  let color = COLOR.gray;
  if (s.available <= 0) color = COLOR.red;
  else if (s.available <= 5) color = COLOR.yellow;
  let title = headline;
  if (reason) title += `\n原因：${reason}`;
  if (ago) title += `\n缓存于 ${ago}`;
  title += '\n点击 bar 重试';
  return view(text, color, title);
}

function kimiBar(value, cached) {
  const cachedOk = kimiCachedSites(cached);
  if (!value) {
    if (cachedOk.length) return kimiCachedView(cachedOk, cached.fetchedAt, '', '显示上次缓存值');
    return view('Kimi 余量 · ⟳ 刷新', COLOR.gray, '点击从 api.moonshot.cn 拉取预付余额');
  }
  if (value.status === 'not_configured') {
    return view('Kimi：未配置 provider · ⟳ 刷新', COLOR.gray,
      '没有 baseUrl 指向 moonshot / kimi 的 provider，无法拉取余额');
  }
  // An actionable top-level status comes FIRST — ahead of both sites[0].reason
  // and the stale cache. A Kimi-for-Coding key always 401s the balance API (that
  // is the key type, not a fault), so the backend falls back to scraping the
  // membership page and reports needs_login when that page has no session.
  if (value.status === 'needs_login' || value.status === 'chrome_unavailable') {
    const needsLogin = value.status === 'needs_login';
    const titleParts = [value.error || (needsLogin
      ? '托管浏览器中没有 kimi.com 登录态'
      : '没有可用的浏览器来打开 kimi.com 订阅页')];
    const reason = kimiReasonText(value.sites);
    if (reason) titleParts.push(`余额 API：${reason}`);
    if (cachedOk.length) {
      titleParts.push(`上次余额：${unifiedBalanceText(cachedOk[0].available, cachedOk[0].currency) || '—'}`);
    }
    titleParts.push('点击将由 multicc 拉起一个 Chrome 登录窗口；登录后回来再点一次刷新。');
    return view(
      needsLogin ? 'Kimi：需登录 · 点击打开登录窗口' : 'Kimi：无可用浏览器 · 点击尝试打开登录窗口',
      needsLogin ? COLOR.red : COLOR.yellow,
      titleParts.join('\n'),
      'login',
    );
  }
  // Subscription keys have no balance to report; their usage lives on the
  // membership page, which the backend scrapes into `summary`. Without this the
  // sites-only path below would call a SUCCESSFUL scrape "余额暂不可用".
  if (value.status === 'ok' && value.source === 'subscription-page') {
    // Unified window shape: { window, usedPercent, resetMs }. Old caches may
    // still carry { label, percent } — accept both.
    const summary = (Array.isArray(value.summary) ? value.summary : [])
      .map((s) => ({
        label: (s && s.window) || (s && s.label) || 'Kimi',
        used: s && Number.isFinite(s.usedPercent) ? s.usedPercent : (s ? s.percent : NaN),
        resetAt: s && Number.isFinite(s.resetMs) ? s.resetMs : null,
      }))
      .filter((s) => Number.isFinite(s.used));
    if (!summary.length) {
      return view('Kimi 订阅：已登录，未解析出用量 · ⟳ 重试', COLOR.yellow,
        `已抓到 kimi.com 会员页，但没解析出百分比。\n原文：${String(value.text || '').slice(0, 300)}`);
    }
    const maxPct = Math.max(...summary.map((s) => s.used));
    const ago = agoTag(value.fetchedAt);
    let text = sortSegs(summary.map((s) => ({
      window: s.label, seg: windowSeg(s.label, s.used, s.resetAt),
    }))).join(' · ');
    if (ago) text += ` · ${ago}`;
    text += ' ⟳';
    let title = 'Kimi 订阅用量（会员页抓取；订阅 key 无预付余额接口）';
    for (const s of summary) title += `\n${s.label}: 已用 ${s.used}%`;
    if (ago) title += `\n同步于 ${ago}`;
    title += '\n点击 bar 刷新';
    return view(text, unifiedColorFromRemaining(unifiedRemaining(maxPct)), title);
  }
  const okSites = (value.status === 'ok' && Array.isArray(value.sites))
    ? value.sites.filter((s) => s && s.ok && Number.isFinite(s.available))
    : [];
  if (!okSites.length) {
    const reason = kimiReasonText(value.sites);
    if (cachedOk.length) return kimiCachedView(cachedOk, cached.fetchedAt, reason, '余额刷新失败，显示上次缓存值');
    const short = kimiShortReason(value.sites);
    return view(
      short ? `Kimi：余额暂不可用（${short}）· ⟳ 重试` : 'Kimi：余额暂不可用 · ⟳ 重试',
      COLOR.yellow,
      reason || value.error || '无法从 api.moonshot.cn 拉取余额',
    );
  }
  const s = okSites[0];
  const titleLines = [];
  for (const site of okSites) {
    let line = `${site.site} (${site.host}): 可用 ¥${fmtNum(site.available)}`;
    if (Number.isFinite(site.voucher)) line += ` · 券 ¥${fmtNum(site.voucher)}`;
    if (Number.isFinite(site.cash)) line += ` · 现金 ¥${fmtNum(site.cash)}`;
    titleLines.push(line);
  }
  const ago = agoTag(value.fetchedAt);
  let text = unifiedBalanceText(s.available, s.currency) || '—';
  if (ago) text += ` · ${ago}`;
  text += ' ⟳';

  let color = COLOR.blue;
  if (s.available <= 0) color = COLOR.red;
  else if (s.available <= 5) color = COLOR.yellow;

  let title = 'Kimi / Moonshot 预付余额（api.moonshot.cn/v1/users/me/balance）';
  title += '\n' + titleLines.join('\n');
  if (ago) title += `\n同步于 ${ago}`;
  title += '\n点击 bar 刷新';
  return view(text, color, title);
}

// ── DeepSeek prepaid balance ────────────────────────────────────────────────
// A different species from the window bars: money remaining, no reset window,
// and it arrives on a WS event rather than a fetch route.

function normalizeBalance(info) {
  if (!info || typeof info !== 'object' || info.kind !== 'balance') return null;
  const total = finiteNumber(info.total);
  // Show it if we know the account is out of money (worth a warning) or we have
  // a number. "Balance unknown" is not worth a bar.
  if (total === null && info.available !== false) return null;
  return Object.freeze({
    kind: 'balance',
    provider: 'deepseek',
    available: info.available !== false,
    currency: typeof info.currency === 'string' ? info.currency : null,
    total,
  });
}

function balanceBar(value) {
  if (!value) return null;
  const total = finiteNumber(value.total);
  let text = unifiedBalanceText(total, value.currency) || '—';
  if (value.available === false) text += ' · 余额不足';
  const color = value.available === false || (total !== null && total <= 5)
    ? COLOR.red
    : (total !== null && total <= 20 ? COLOR.yellow : COLOR.blue);
  return view(text, color,
    'DeepSeek 预付费账户余额（来自 api.deepseek.com/user/balance，非窗口配额）');
}

// ── The passive window event ───────────────────────────────────────────────

/**
 * The raw rate-limit DTO → the value both the bar and the client's staleness
 * check read. Returns null for anything malformed, so a bad event leaves the
 * last good bar on screen instead of blanking it.
 */
function normalizeWindowEvent(info, nowMs) {
  if (!info || typeof info !== 'object' || Array.isArray(info)) return null;
  // A window limit is either a rolling 5h window (Claude, GLM) or a weekly one
  // (Codex — its binding, and on some plans only, window). Same DTO shape; the
  // provider drives the label (5h vs 1wk) so no extra field is needed here.
  if (!['five_hour', 'weekly'].includes(info.rateLimitType)) return null;
  if (!['allowed', 'allowed_warning', 'rejected'].includes(info.status)) return null;
  const utilization = finiteNumber(info.utilization);
  const usedPercentage = utilization === null
    ? null
    : Math.round(Math.max(0, Math.min(100, utilization * 100)) * 1000) / 1000;
  // Claude 5h arrives from the proxy's response-header extraction (no provider
  // field → 'claude'); GLM/Codex/OpenCode events carry explicit providers.
  const provider = info.provider === 'glm' ? 'glm'
    : info.provider === 'codex' ? 'codex'
      : info.provider === 'opencode' ? 'opencode' : 'claude';
  // Claude's weekly limit comes exclusively from the usage-page scrape, and the
  // poller always tags weekly with provider:'codex' — so a weekly event that
  // resolves to Claude is malformed. Reject it rather than mislabel it.
  if (info.rateLimitType === 'weekly' && provider === 'claude') return null;
  return Object.freeze({
    schemaVersion: 1,
    kind: info.rateLimitType === 'weekly' ? 'weekly' : 'five_hour',
    status: info.status,
    usedPercentage,
    resetsAtMs: normalizeResetTime(info.resetsAt),
    observedAtMs: Math.trunc(finiteNumber(nowMs) ?? Date.now()),
    source: provider === 'opencode' ? 'opencode_log' : 'claude_code',
    provider,
  });
}

// ── Single-window bars carried by the passive rate_limit_event ─────────────
// GLM (5h) and Codex (weekly) each report exactly one window and have no usage
// page behind them, so their bar is that single segment.

function windowEventBar(info) {
  if (!info) return null;
  const provider = info.provider === 'glm' ? 'glm'
    : info.provider === 'codex' ? 'codex'
      : info.provider === 'opencode' ? 'opencode' : 'claude';
  if (provider === 'claude') return null; // Claude's bar is the merged one below
  const used = info.status === 'rejected' ? 100 : finiteNumber(info.usedPercentage);
  const token = info.kind === 'weekly' || provider === 'codex' ? '1wk' : '5h';
  const seg = windowSeg(token, used, info.resetsAtMs);
  const label = provider === 'opencode' ? 'OpenCode Go · ' : '';
  return view(
    `${label}${seg || token}`,
    unifiedColorFromRemaining(unifiedRemaining(used)),
    provider === 'glm'
      ? 'GLM Coding Plan 五小时窗口用量（来自 open.bigmodel.cn 额度端点）'
      : provider === 'opencode'
        ? 'OpenCode Go 订阅窗口用量（来自 opencode 日志中的 provider limit 错误）'
        : 'Codex 订阅周额度用量（来自 chatgpt.com/backend-api/wham/usage）',
  );
}

// ── The Claude bar ─────────────────────────────────────────────────────────
// Every window the account has, one segment each, always the same shape:
//
//   5h 93% 42m · 1wk-ALL 75% 3d · 1wk-Fable 88% 3d · 57s 前 · ⟳ 刷新
//
// Claude meters its weekly limit more than one way (all models, and one per
// premium model), so a weekly row is named by what it meters. A window with no
// data renders `-` rather than vanishing, so the bar's shape does not change
// with the data and a missing number is visibly missing. The 刷新 affordance is
// always the last segment.
//
// Two sources merge here: the 5h rolling window arrives as a passive
// rate_limit_event (seconds old), the weekly rows come from the
// claude.ai/settings/usage scrape (minutes old). Both reach this function
// server-side, which is why neither client has to know how they combine.

const CLAUDE_PLACEHOLDER_WINDOWS = Object.freeze(['5h', '1wk']);
const CLAUDE_WINDOW_ZH = Object.freeze({ '5h': '5小时', '1wk': '周', '1m': '月' });

function claudeLabelNamesWindow(label) {
  return /session|hour|week|month|\d+\s*(h|day)/i.test(String(label || ''));
}

// "All models" → "1wk-ALL"; "Fable" → "1wk-Fable". A row whose label just names
// the window itself ("Weekly limit") needs no suffix.
function claudeRowName(window, label) {
  const l = String(label || '').trim();
  if (!l || claudeLabelNamesWindow(l)) return window;
  if (/^all\b/i.test(l)) return `${window}-ALL`;
  return `${window}-${l.split(/[\s(（]/)[0].slice(0, 10)}`;
}

function claudeWindowRows(usage, live) {
  const rows = [];
  if (usage && usage.status === 'ok' && Array.isArray(usage.summary)) {
    for (const s of usage.summary) {
      if (!s || CLAUDE_WINDOW_ZH[s.window] === undefined || !Number.isFinite(s.usedPercent)) continue;
      rows.push({
        window: s.window,
        name: claudeRowName(s.window, s.label),
        label: String(s.label || ''),
        used: s.usedPercent,
        resetAt: finiteNumber(s.resetMs),
      });
    }
  }
  if (live) {
    // The live event is this session's own 5h window, seconds old; the scrape's
    // 5h row is the same window, minutes old. Replace, never stack.
    const used = live.status === 'rejected' ? 100 : finiteNumber(live.usedPercentage);
    if (used !== null) {
      const i = rows.findIndex((r) => r.window === '5h');
      const row = { window: '5h', name: '5h', label: '', used, resetAt: finiteNumber(live.resetsAtMs) };
      if (i >= 0) rows[i] = row; else rows.push(row);
    }
  }
  return rows;
}

// Why a window has no number, said in the bar's own tooltip. The click action
// rides along: needs_login sends the click to the CDP login window.
const CLAUDE_SCRAPE_STATES = Object.freeze({
  needs_login: {
    note: '未登录 claude.ai — 点击打开登录窗口',
    title: '你的浏览器里没有 claude.ai 的登录态。点击将由 multicc 拉起一个 Chrome 登录窗口（claude.ai/settings/usage），登录后回来再点一次刷新。',
    action: 'login',
  },
  chrome_unavailable: {
    note: '无可连的 Chrome — 点击尝试登录',
    title: '托管 Chrome 起不来，也没有可连的调试端点。点击会尝试拉起一个可见的 Chrome 登录窗口；也可以自己开一个带调试端点的 Chrome 并在其中登录 claude.ai。',
    action: 'login',
  },
  ok: {
    note: '已登录但未解析出周用量',
    title: '已抓到 claude.ai 用量页，但没解析出窗口百分比。点击重试。',
  },
});
const CLAUDE_SCRAPE_UNAVAILABLE = Object.freeze({
  note: '用量抓取失败',
  title: '无法从 claude.ai/settings/usage 拉取窗口用量。点击重试。',
});
const CLAUDE_SCRAPE_IDLE = Object.freeze({
  note: '尚未抓取',
  title: 'Claude 订阅窗口用量。点击从 claude.ai/settings/usage 抓取周余量；5h 由 Claude Code 上报的 rate_limit_event 实时更新。',
});
const CLAUDE_SCRAPE_FETCHING = Object.freeze({
  note: '抓取中…',
  title: '正在通过 CDP 打开 claude.ai/settings/usage 解析窗口余量（要 30-40 秒）…',
  action: 'fetching',
});
const CLAUDE_SCRAPE_LOGIN_PENDING = Object.freeze({
  note: '等待登录…',
  title: '已拉起 Chrome 登录窗口。在其中登录 claude.ai，然后回来再点一次。',
  action: 'login_pending',
});

// The trailing segment is the bar's only feedback that a click landed. The
// scrape is a full browser drive — 30-40s — so a segment that reads the same
// before and during it makes the click look dead.
const CLAUDE_ACTION_SEG = Object.freeze({
  fetching: '⟳ 抓取中…',
  login_pending: '⟳ 等待登录…',
  login: '⟳ 登录',
});

function claudeBarForState(usage, live, state) {
  const rows = claudeWindowRows(usage, live);
  const ago = agoTag(usage && usage.status === 'ok' ? usage.fetchedAt : 0);

  // A placeholder for every window with no row, then the rows themselves,
  // ordered by window so the bar reads 5h → 1wk → 1m whether or not the data
  // arrived. Bar text and tooltip come off the same ordered list.
  const missing = CLAUDE_PLACEHOLDER_WINDOWS.filter((w) => !rows.some((r) => r.window === w));
  const entries = missing
    .map((w) => ({
      window: w,
      seg: `${w} -`,
      detail: `${CLAUDE_WINDOW_ZH[w]}: 无数据（${state.note}）`,
    }))
    .concat(rows.map((r) => {
      const from = r.label && !claudeLabelNamesWindow(r.label) ? `（${r.label}）` : '';
      const cd = cdTag(r.resetAt);
      return {
        window: r.window,
        seg: windowSeg(r.name, r.used, r.resetAt),
        detail: `${CLAUDE_WINDOW_ZH[r.window]}${from}: 已用 ${Math.round(r.used)}%${cd ? ` · ${cd} 后重置` : ''}`,
      };
    }))
    .map((e, i) => ({ e, i }))
    .sort((a, b) => (windowRank(a.e.window) - windowRank(b.e.window)) || (a.i - b.i))
    .map(({ e }) => e);

  const worst = rows.length ? Math.max(...rows.map((r) => r.used)) : null;
  const text = entries.map((e) => e.seg)
    .concat(ago ? [ago] : [], [CLAUDE_ACTION_SEG[state.action] || '⟳ 刷新'])
    .join(' · ');
  // The scrape's own status is worth a line only when it explains something — a
  // missing window, a failure, or a fetch in flight. With every window in hand
  // and nothing happening it is noise.
  const title = ['Claude 订阅窗口用量（5h 来自 Claude Code 上报的 rate_limit_event，周来自 claude.ai/settings/usage 抓取）']
    .concat(entries.map((e) => e.detail), ago ? [`同步于 ${ago}`] : [],
      missing.length || state.action === 'fetching' || state.action === 'login_pending' ? [state.title] : [])
    .join('\n');
  return view(text, worst === null ? COLOR.gray : unifiedColorFromRemaining(unifiedRemaining(worst)),
    title, state.action);
}

function claudeBar(usage, live) {
  const base = claudeBarForState(usage, live,
    !usage ? CLAUDE_SCRAPE_IDLE : (CLAUDE_SCRAPE_STATES[usage.status] || CLAUDE_SCRAPE_UNAVAILABLE));
  return withStates(base, {
    fetching: claudeBarForState(usage, live, CLAUDE_SCRAPE_FETCHING),
    login_pending: claudeBarForState(usage, live, CLAUDE_SCRAPE_LOGIN_PENDING),
    unreachable: unreachableView('Claude'),
  });
}

// ── OpenCode composition ───────────────────────────────────────────────────
// OpenCode Go has its own account-level 5h/weekly/monthly limits while the
// provider routed underneath it may independently report another window. Both
// are useful, but an unlabeled pair of `5h N%` values looks like one
// duplicated, contradictory meter, so the routed-provider row says whose it is.

function labelRoutedProvider(bar, provider) {
  if (!bar) return null;
  const source = provider === 'glm' ? 'GLM' : provider === 'codex' ? 'Codex' : 'Claude';
  return view(
    `路由供应商 ${source} · ${bar.text}`,
    bar.color,
    `${bar.title || `${source} 额度`}\n此行是当前路由供应商额度，不是 OpenCode Go 订阅额度。`,
    bar.action,
  );
}

function labelRoutedBalance(bar) {
  if (!bar) return null;
  return view(`DeepSeek 余额 · ${bar.text}`, bar.color, bar.title, bar.action);
}

// ── Public surface ─────────────────────────────────────────────────────────

const VENDOR_LABEL = Object.freeze({
  claude: 'Claude',
  opencode: 'OpenCode Go',
  codex: 'Codex',
  qoder: 'Qoder CN',
  ark: '火山方舟',
  zhipu: 'Zhipu',
  kimi: 'Kimi',
});

const LOADING_TITLE = Object.freeze({
  claude: '正在通过 CDP 打开 claude.ai/settings/usage 解析窗口余量…',
  opencode: '正在通过 CDP 抓取 opencode.ai/console ...',
  codex: '正在从 chatgpt.com 拉取 Codex 周额度...',
  qoder: '正在通过 CDP 抓取 qoder.com.cn 用量...',
  ark: '正在通过 arkcli 拉取火山方舟套餐额度...',
  zhipu: '正在从 z.ai / bigmodel.cn 额度端点拉取窗口用量...',
  kimi: '正在从 api.moonshot.cn 拉取预付余额...',
});

// Ark's install click has its own long-running state, and it is not a fetch.
const ARK_INSTALLING = Object.freeze({
  text: '火山方舟：正在安装 arkcli…',
  color: COLOR.gray,
  title: '正在执行 npm install -g @volcengine/ark-cli，首次安装可能需要一两分钟...',
  action: null,
});

/**
 * Render one vendor's quota response into the view both clients display.
 *
 * @param {string} kind  opencode | qoder | codex | ark | zhipu | kimi | claude
 * @param {object|null} value  the route's JSON body (null = never fetched)
 * @param {object} [opts]  { baseUrl } for ark, { cached } for kimi, { live } for claude
 * @returns {{text:string,color:string,title:string,action:?string,states:object}}
 */
function renderQuotaBar(kind, value, opts = {}) {
  let base;
  switch (kind) {
    case 'opencode': base = openCodeBar(value); break;
    case 'qoder': base = qoderBar(value); break;
    case 'codex': base = codexBar(value); break;
    case 'ark': base = arkBar(value, opts.baseUrl); break;
    case 'zhipu': base = zhipuBar(value); break;
    case 'kimi': base = kimiBar(value, opts.cached); break;
    case 'claude': return claudeBar(value, opts.live);
    default: return null;
  }
  const label = VENDOR_LABEL[kind] || kind;
  const states = {
    loading: loadingView(label, LOADING_TITLE[kind] || ''),
    unreachable: unreachableView(label),
  };
  if (kind === 'ark') states.installing = ARK_INSTALLING;
  return withStates(base, states);
}

/**
 * The view every bar shows before its first fetch has ever landed. Served once
 * at page/app load so a client with an empty cache still has a click target and
 * a vendor name, without triggering the 30-40s CDP scrapes on startup.
 */
function idleQuotaBars() {
  const bars = {};
  for (const kind of ['opencode', 'qoder', 'codex', 'ark', 'zhipu', 'kimi', 'claude']) {
    bars[kind] = renderQuotaBar(kind, null);
  }
  return bars;
}

/**
 * A persisted, client-agnostic fingerprint of a quota bar's text. The live bar
 * carries client-expanded placeholders (`{cd:<ms>}` countdown, `{ago:<ms>}`
 * relative time) and a trailing `⟳ 刷新` action segment that are meaningless
 * when the text is stored and re-shown inside a provider picker. Stripping them
 * yields a compact, sortable summary (e.g. `5h 20% 1.2h · 1wk 50% 3d 5h`) that
 * both the provider-limit cache and the Web/App selectors can render verbatim.
 */
function compactBarText(text) {
  if (!text) return '';
  return String(text)
    .replace(/\{[a-z]+:\d+\}/g, '')
    .replace(/\s*⟳.*$/g, '')
    // Split on '·' and drop empty cells so a stripped placeholder or the
    // refresh action never leaves a doubled / dangling separator behind.
    .split('·').map(s => s.trim()).filter(Boolean).join(' · ');
}

module.exports = {
  renderQuotaBar,
  idleQuotaBars,
  balanceBar,
  normalizeBalance,
  windowEventBar,
  normalizeWindowEvent,
  claudeBar,
  labelRoutedProvider,
  labelRoutedBalance,
  arkPlanFromBaseUrl,
  compactBarText,
  COLOR,
};
