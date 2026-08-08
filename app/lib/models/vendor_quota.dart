// Vendor (ark / zhipu / kimi) quota bars for the chat runtime notice panel.
//
// These mirror the web `public/chat-rate-limit.js` fetch-based bars. The app
// does not hit the vendor APIs directly — it calls the same backend routes the
// web uses (GET /api/ark/quota · /api/zhipu/quota · /api/kimi/quota), which do
// the credential handling + CDP/CLI work server-side. Each bar is gated on the
// active session provider's baseUrl host, exactly like the web:
//   ark   → *.volces.com
//   zhipu → z.ai / *.z.ai / bigmodel.cn / *.bigmodel.cn
//   kimi  → (moonshot|kimi).(cn|com|ai)
//
// Formatting below reproduces the web bar text/colors so all three ends agree.
// The Claude subscription bar lives here too (formatClaudeLimit /
// formatClaudeUsageOnly) — it consumes the passive rate_limit_event plus the
// /api/claude/quota usage-page scrape, exactly like the web formatters.

import 'chat_runtime_state.dart';

/// ARGB color values matching the web bar palette.
class VendorQuotaColor {
  static const int gray = 0xFF8b949e;
  static const int red = 0xFFf85149;
  static const int yellow = 0xFFd29922;
  static const int blue = 0xFF58a6ff;
}

/// A renderable vendor quota bar (text + color + optional long tooltip).
class VendorQuotaView {
  final String text;
  final int color;
  final String tooltip;

  const VendorQuotaView(this.text, this.color, [this.tooltip = '']);
}

// ── baseUrl host gating ─────────────────────────────────────────────────────

String hostFromBaseUrl(String? baseUrl) {
  if (baseUrl == null || baseUrl.isEmpty) return '';
  try {
    return Uri.parse(baseUrl).host.toLowerCase();
  } catch (_) {
    return '';
  }
}

bool isArkBaseUrl(String? baseUrl) {
  if (baseUrl == null || baseUrl.isEmpty) return false;
  final h = hostFromBaseUrl(baseUrl);
  if (h.isNotEmpty) return h == 'volces.com' || h.endsWith('.volces.com');
  return baseUrl.contains('volces.com');
}

bool isZhipuBaseUrl(String? baseUrl) {
  final h = hostFromBaseUrl(baseUrl);
  if (h.isEmpty) return false;
  return h == 'z.ai' ||
      h.endsWith('.z.ai') ||
      h == 'bigmodel.cn' ||
      h.endsWith('.bigmodel.cn');
}

bool isKimiBaseUrl(String? baseUrl) {
  final h = hostFromBaseUrl(baseUrl);
  if (h.isEmpty) return false;
  return RegExp(r'(^|\.)(moonshot|kimi)\.(cn|com|ai)$').hasMatch(h);
}

/// Host to pass as `?host=` so the backend puts the current site first.
String zhipuHostFromBaseUrl(String? baseUrl) => hostFromBaseUrl(baseUrl);
String kimiHostFromBaseUrl(String? baseUrl) => hostFromBaseUrl(baseUrl);

/// Which Ark plan the provider baseUrl points to (Volcano serves Coding Plan
/// under /api/coding… and Agent Plan under /api/plan). null = unknown.
String? arkPlanFromBaseUrl(String? baseUrl) {
  if (baseUrl == null || baseUrl.isEmpty) return null;
  try {
    final p = Uri.parse(baseUrl).path.toLowerCase();
    if (p.contains('/coding')) return 'coding-plan';
    if (p.contains('/plan')) return 'agent-plan';
  } catch (_) {}
  return null;
}

// ── small formatting helpers ────────────────────────────────────────────────

/// 2-decimal display, trailing zeros dropped (12.3456 → 12.35, 100 → 100).
String fmtQuotaNum(num? n) {
  if (n == null || n.isNaN || n.isInfinite) return '';
  var s = n.toStringAsFixed(2);
  if (s.contains('.')) {
    s = s.replaceFirst(RegExp(r'0+$'), '');
    if (s.endsWith('.')) s = s.substring(0, s.length - 1);
  }
  return s;
}

/// Relative "synced … ago" label matching the web `relativeAgo`.
String quotaRelAgo(int? tsMs) {
  if (tsMs == null) return '';
  final sec =
      (DateTime.now().millisecondsSinceEpoch - tsMs) ~/ 1000;
  if (sec < 0) return '';
  if (sec < 5) return '刚刚';
  if (sec < 60) return '${sec}s 前';
  final min = sec ~/ 60;
  if (min < 60) return '$min 分钟前';
  final h = min ~/ 60;
  if (h < 24) return '$h 小时前';
  return '${h ~/ 24} 天前';
}

// ── Unified compact quota display ───────────────────────────────────────────
// Mirrors the web `public/chat-rate-limit.js` unified format: every provider
// renders its windows as `<window> <remaining%> <countdown>` segments joined by
// ' · ' (e.g. `5h 20% 1.2h · 1wk 50% 3d 5h`); money providers render `¥<amount>`.

/// Remaining percent from a used percent (rounded, clamped 0..100); null when the
/// input is not a finite number.
int? unifiedRemaining(num? usedPercent) {
  if (usedPercent == null || usedPercent.isNaN || usedPercent.isInfinite) {
    return null;
  }
  return (100 - usedPercent).round().clamp(0, 100);
}

/// Humanized reset countdown (`45m`, `1.2h`, `3d 5h`, `14d`) from a duration in
/// ms; '' when missing/negative.
String humanizeCountdown(num? ms) {
  if (ms == null || ms.isNaN || ms.isInfinite || ms < 0) return '';
  final totalH = ms / 3600000;
  if (totalH < 1) {
    var m = (ms / 60000).round();
    if (m < 1) m = 1;
    return '${m}m';
  }
  if (totalH < 24) {
    final h = (totalH * 10).round() / 10;
    return h == h.truncateToDouble() ? '${h.toInt()}h' : '${h.toStringAsFixed(1)}h';
  }
  final d = totalH ~/ 24;
  final remH = (totalH % 24).floor();
  return remH > 0 ? '${d}d ${remH}h' : '${d}d';
}

/// One window → `<label> <remaining>% [<countdown>]`; '' when percent is missing.
String unifiedWindowSeg(String label, num? usedPercent, num? resetMs) {
  final rem = unifiedRemaining(usedPercent);
  if (rem == null) return '';
  final cd = humanizeCountdown(resetMs);
  return cd.isEmpty ? '$label $rem%' : '$label $rem% $cd';
}

/// Rank a window segment by its leading token: 5h → 1wk → 1m, unknown last.
int windowSegRank(String? seg) {
  final m = RegExp(r'^(\S+)').firstMatch(seg ?? '');
  switch (m?.group(1)) {
    case '5h':
      return 0;
    case '1wk':
      return 1;
    case '1m':
      return 2;
    default:
      return 3;
  }
}

/// Stable sort of window segments into the canonical display order
/// (5h → 1wk → 1m, unknown labels last), applied at the single render merge
/// point. Matches the web `sortWindowSegs`; the explicit index tiebreak keeps
/// equal-rank segments in their input order.
List<String> sortWindowSegs(Iterable<String> segs) {
  final items = <(int, String)>[];
  var i = 0;
  for (final s in segs) {
    if (s.isNotEmpty) items.add((i++, s));
  }
  items.sort(
    (a, b) => windowSegRank(a.$2) != windowSegRank(b.$2)
        ? windowSegRank(a.$2) - windowSegRank(b.$2)
        : a.$1 - b.$1,
  );
  return [for (final e in items) e.$2];
}

int unifiedColorFromRemaining(int? rem) {
  if (rem == null) return VendorQuotaColor.blue;
  if (rem <= 10) return VendorQuotaColor.red;
  if (rem <= 30) return VendorQuotaColor.yellow;
  return VendorQuotaColor.blue;
}

/// Money balance text (`¥110.00` / `$5.00`); '' when amount is missing.
String unifiedBalanceText(num? amount, String? currency) {
  if (amount == null || amount.isNaN || amount.isInfinite) return '';
  final sym = currency == 'USD' ? '\$' : currency == 'CNY' ? '¥' : '';
  return '$sym${amount.toStringAsFixed(2)}';
}

String arkProductLabel(String? product) {
  switch (product) {
    case 'agent-plan':
      return 'Agent';
    case 'coding-plan':
      return 'Coding';
    case 'agent-plan-team':
      return 'Agent团队';
    case 'coding-plan-team':
      return 'Coding团队';
    default:
      return (product == null || product.isEmpty) ? '?' : product;
  }
}

String arkPeriodLabel(String? label) {
  final l = (label ?? '').toLowerCase();
  if (l == 'weekly') return '周';
  if (l == 'monthly') return '月';
  if (l == 'session') return '会话';
  return (label == null || label.isEmpty) ? '?' : label;
}

/// Short unified window token for the compact bar (vs. the Chinese tooltip label).
String arkWindowLabel(String? label) {
  final l = (label ?? '').toLowerCase();
  if (l == '5h') return '5h';
  if (l == 'weekly') return '1wk';
  if (l == 'monthly') return '1m';
  if (l == 'session') return '会话';
  return (label == null || label.isEmpty) ? '?' : l;
}

// ── Ark (火山方舟) ──────────────────────────────────────────────────────────

VendorQuotaView formatArkQuota(
  Map<String, dynamic>? value,
  String baseUrl, {
  bool loading = false,
}) {
  if (loading) return const VendorQuotaView('火山方舟：加载中…', VendorQuotaColor.gray);
  if (value == null) {
    return const VendorQuotaView(
      '火山方舟 余量 · ⟳ 刷新',
      VendorQuotaColor.gray,
      '通过 arkcli 拉取火山方舟套餐额度',
    );
  }
  final status = value['status']?.toString();
  if (status == 'needs_auth') {
    return const VendorQuotaView(
      '火山方舟：未登录',
      VendorQuotaColor.red,
      'arkcli 未配置火山 SSO 凭证，请在网页端登录后重试',
    );
  }
  if (status == 'needs_install') {
    return const VendorQuotaView(
      '火山方舟：未安装 arkcli',
      VendorQuotaColor.yellow,
      '服务端未检测到 arkcli，请在网页端一键安装',
    );
  }
  final items = value['items'];
  if (status != 'ok' || items is! List) {
    return VendorQuotaView(
      '火山方舟：用量暂不可用 · ⟳ 重试',
      VendorQuotaColor.yellow,
      value['error']?.toString() ?? '无法通过 arkcli 拉取用量',
    );
  }

  final subscribed = <Map<String, dynamic>>[];
  for (final it in items) {
    if (it is! Map) continue;
    final periods = it['periods'];
    if (it['subscribed'] == true &&
        it['error'] == null &&
        periods is List &&
        periods.isNotEmpty) {
      subscribed.add(Map<String, dynamic>.from(it));
    }
  }
  if (subscribed.isEmpty) {
    return const VendorQuotaView(
      '火山方舟：无生效套餐 · ⟳ 刷新',
      VendorQuotaColor.gray,
      '当前身份名下没有已订阅的 AgentPlan / CodingPlan',
    );
  }

  final activePlan = arkPlanFromBaseUrl(baseUrl);
  final ordered = List<Map<String, dynamic>>.from(subscribed);
  if (activePlan != null) {
    ordered.sort(
      (a, b) =>
          (b['product'] == activePlan ? 1 : 0) -
          (a['product'] == activePlan ? 1 : 0),
    );
  }

  final plan = ordered.first;
  final segs = <String>[];
  var maxUsed = 0.0;
  final nowMs = DateTime.now().millisecondsSinceEpoch;
  for (final p in plan['periods'] as List) {
    if (p is! Map) continue;
    final pct = (p['percent'] as num?)?.toDouble() ?? 0;
    if (pct > maxUsed) maxUsed = pct;
    final resetAt = (p['resetAt'] as num?)?.toInt();
    final resetMs =
        resetAt == null ? null : (resetAt - nowMs < 0 ? 0 : resetAt - nowMs);
    segs.add(
      unifiedWindowSeg(arkWindowLabel(p['label']?.toString()), pct, resetMs),
    );
  }

  final titleLines = <String>[];
  for (final it in ordered) {
    final isActive = it['product'] == activePlan;
    titleLines.add(
      '${arkProductLabel(it['product']?.toString())}'
      '${it['tier'] != null ? ' · ${it['tier']}' : ''}'
      '${isActive ? '（当前 provider）' : ''}',
    );
    for (final p in it['periods'] as List) {
      if (p is! Map) continue;
      final used = p['used'] as num?;
      final total = p['total'] as num?;
      final pct = (p['percent'] as num?)?.toDouble() ?? 0;
      var line = '  ${arkPeriodLabel(p['label']?.toString())}: ';
      line += (used != null && total != null)
          ? '${fmtQuotaNum(used)}/${fmtQuotaNum(total)} (${fmtQuotaNum(pct)}%)'
          : '${fmtQuotaNum(pct)}%';
      titleLines.add(line);
    }
  }

  var text = segs.where((x) => x.isNotEmpty).join(' · ');
  if (text.isEmpty) text = '—';
  final syncRel = quotaRelAgo((value['fetchedAt'] as num?)?.toInt());
  if (syncRel.isNotEmpty) text += ' · $syncRel';
  text += ' ⟳';

  final color = unifiedColorFromRemaining(unifiedRemaining(maxUsed));

  var title = '火山方舟套餐额度（arkcli usage plan）';
  title += '\n${titleLines.join('\n')}';
  if (syncRel.isNotEmpty) title += '\n同步于 $syncRel';
  return VendorQuotaView(text, color, title);
}

// ── Zhipu (z.ai / bigmodel.cn) ──────────────────────────────────────────────

VendorQuotaView formatZhipuQuota(
  Map<String, dynamic>? value, {
  bool loading = false,
}) {
  if (loading) return const VendorQuotaView('Zhipu：加载中…', VendorQuotaColor.gray);
  if (value == null) {
    return const VendorQuotaView(
      'Zhipu 余量 · ⟳ 刷新',
      VendorQuotaColor.gray,
      '从 z.ai / bigmodel.cn 额度端点拉取窗口用量',
    );
  }
  final status = value['status']?.toString();
  if (status == 'not_configured') {
    return const VendorQuotaView(
      'Zhipu：未配置 provider · ⟳ 刷新',
      VendorQuotaColor.gray,
      '没有 baseUrl 指向 z.ai / bigmodel.cn 的 provider',
    );
  }
  final sites = value['sites'];
  if (status != 'ok' || sites is! List) {
    return VendorQuotaView(
      'Zhipu：用量暂不可用 · ⟳ 重试',
      VendorQuotaColor.yellow,
      value['error']?.toString() ?? '无法从 z.ai / bigmodel.cn 拉取用量',
    );
  }

  final okSites = <Map>[];
  for (final s in sites) {
    if (s is Map && s['ok'] == true && s['usedPercent'] is num) okSites.add(s);
  }
  if (okSites.isEmpty) {
    return const VendorQuotaView(
      'Zhipu：用量暂不可用 · ⟳ 重试',
      VendorQuotaColor.yellow,
      '所有 Zhipu 站点的额度端点都未返回有效窗口数据',
    );
  }

  final s = okSites.first;
  final segs = <String>[];
  var maxUsed = 0.0;
  final nowMs = DateTime.now().millisecondsSinceEpoch;
  final pct = (s['usedPercent'] as num).toDouble();
  if (pct > maxUsed) maxUsed = pct;
  final resetsAt = (s['resetsAt'] as num?)?.toInt();
  segs.add(unifiedWindowSeg(
    '5h',
    pct,
    resetsAt == null ? null : (resetsAt - nowMs < 0 ? 0 : resetsAt - nowMs),
  ));
  final weekly = s['weeklyUsedPercent'];
  if (weekly is num) {
    if (weekly.toDouble() > maxUsed) maxUsed = weekly.toDouble();
    final weeklyResetsAt = (s['weeklyResetsAt'] as num?)?.toInt();
    segs.add(unifiedWindowSeg(
      '1wk',
      weekly.toDouble(),
      weeklyResetsAt == null
          ? null
          : (weeklyResetsAt - nowMs < 0 ? 0 : weeklyResetsAt - nowMs),
    ));
  }

  final titleLines = <String>[];
  for (final site in okSites) {
    var line =
        '${site['site']} (${site['host']}): 5h ${fmtQuotaNum((site['usedPercent'] as num).toDouble())}% 已用';
    final weeklyPct = site['weeklyUsedPercent'];
    if (weeklyPct is num) {
      line += ' · 周 ${fmtQuotaNum(weeklyPct.toDouble())}% 已用';
    }
    if (site['tier'] != null) line += ' · ${site['tier']}';
    titleLines.add(line);
  }

  var text = segs.where((x) => x.isNotEmpty).join(' · ');
  if (text.isEmpty) text = '—';
  final syncRel = quotaRelAgo((value['fetchedAt'] as num?)?.toInt());
  if (syncRel.isNotEmpty) text += ' · $syncRel';
  text += ' ⟳';

  final color = unifiedColorFromRemaining(unifiedRemaining(maxUsed));

  var title = 'Zhipu 官方站点窗口用量（glm-monitor 额度端点）';
  title += '\n${titleLines.join('\n')}';
  if (syncRel.isNotEmpty) title += '\n同步于 $syncRel';
  return VendorQuotaView(text, color, title);
}

// ── Kimi / Moonshot (prepaid balance) ───────────────────────────────────────

String kimiReasonText(List sites) {
  if (sites.isEmpty) return '';
  final s = sites.first;
  if (s is! Map) return '';
  switch (s['reason']?.toString()) {
    case 'auth_rejected':
      return 'API Key 不支持余额查询（Kimi-for-Coding 密钥无余额接口）';
    case 'endpoint_not_found':
      return '余额端点不存在';
    case 'network_error':
      return '网络请求失败';
    case 'bad_shape':
    case 'no_balance_fields':
      return '接口返回格式异常';
    default:
      return s['reason']?.toString() ?? '';
  }
}

String kimiShortReason(List sites) {
  if (sites.isEmpty) return '';
  final s = sites.first;
  if (s is! Map) return '';
  switch (s['reason']?.toString()) {
    case 'auth_rejected':
      return '密钥不支持余额查询';
    case 'endpoint_not_found':
      return '余额端点不存在';
    case 'network_error':
      return '网络请求失败';
    case 'bad_shape':
    case 'no_balance_fields':
      return '接口格式异常';
    default:
      return '';
  }
}

List<Map> kimiCachedSites(Map<String, dynamic>? cached) {
  if (cached == null || cached['status'] != 'ok') return const [];
  final sites = cached['sites'];
  if (sites is! List) return const [];
  return sites
      .whereType<Map>()
      .where((s) => s['ok'] == true && s['available'] is num)
      .toList();
}

/// Render the last good cached balance with a stale indicator so it is never
/// confused with fresh data.
VendorQuotaView kimiCachedView(
  List<Map> cachedOk,
  int? fetchedAt,
  String reason,
  String headline,
) {
  final s = cachedOk.first;
  final avail = (s['available'] as num).toDouble();
  var text = unifiedBalanceText(avail, s['currency']?.toString());
  if (text.isEmpty) text = '—';
  final syncRel = quotaRelAgo(fetchedAt);
  if (syncRel.isNotEmpty) text += ' · 上次 $syncRel';
  text += ' ⟳';
  var color = VendorQuotaColor.gray;
  if (avail <= 0) {
    color = VendorQuotaColor.red;
  } else if (avail <= 5) {
    color = VendorQuotaColor.yellow;
  }
  var tooltip = headline;
  if (reason.isNotEmpty) tooltip += '\n原因：$reason';
  if (syncRel.isNotEmpty) tooltip += '\n缓存于 $syncRel';
  return VendorQuotaView(text, color, tooltip);
}

VendorQuotaView formatKimiQuota(
  Map<String, dynamic>? value,
  Map<String, dynamic>? cached, {
  bool loading = false,
}) {
  if (loading) return const VendorQuotaView('Kimi：加载中…', VendorQuotaColor.gray);
  final cachedOk = kimiCachedSites(cached);
  if (value == null) {
    if (cachedOk.isNotEmpty) {
      return kimiCachedView(
        cachedOk,
        (cached!['fetchedAt'] as num?)?.toInt(),
        '',
        '显示上次缓存值',
      );
    }
    return const VendorQuotaView(
      'Kimi 余量 · ⟳ 刷新',
      VendorQuotaColor.gray,
      '从 api.moonshot.cn 拉取预付余额',
    );
  }
  final status = value['status']?.toString();
  if (status == 'not_configured') {
    return const VendorQuotaView(
      'Kimi：未配置 provider · ⟳ 刷新',
      VendorQuotaColor.gray,
      '没有 baseUrl 指向 moonshot / kimi 的 provider',
    );
  }

  // Kimi subscription keys 401 the prepaid balance API — the backend falls back
  // to scraping the membership page into `summary` ({status:'ok',
  // source:'subscription-page'}). Render those windows like the web
  // `formatKimiQuota` subscription branch; without this a SUCCESSFUL scrape is
  // mislabelled "余额暂不可用".
  if (status == 'ok' && value['source'] == 'subscription-page') {
    final nowMs = DateTime.now().millisecondsSinceEpoch;
    final rawSummary = value['summary'];
    final summary = <Map>[];
    if (rawSummary is List) {
      for (final s in rawSummary) {
        if (s is! Map) continue;
        final label = (s['window'] ?? s['label'] ?? 'Kimi').toString();
        final used = s['usedPercent'] ?? s['percent'];
        if (used is! num || used.isNaN) continue;
        final resetMs = s['resetMs'];
        final resetRemaining = resetMs is num
            ? (resetMs - nowMs < 0 ? 0 : resetMs - nowMs)
            : null;
        summary.add({
          'label': label,
          'used': used.toDouble(),
          'resetMs': resetRemaining,
        });
      }
    }
    final syncRel = quotaRelAgo((value['fetchedAt'] as num?)?.toInt());
    if (summary.isEmpty) {
      final raw = value['text']?.toString() ?? '';
      return VendorQuotaView(
        'Kimi 订阅：已登录，未解析出用量 · ⟳ 重试',
        VendorQuotaColor.yellow,
        '已抓到 kimi.com 会员页，但没解析出百分比。\n原文：'
        '${raw.length > 300 ? raw.substring(0, 300) : raw}',
      );
    }
    var maxUsed = 0.0;
    final segs = <String>[];
    for (final s in summary) {
      final used = (s['used'] as num).toDouble();
      if (used > maxUsed) maxUsed = used;
      final seg = unifiedWindowSeg(
        s['label'] as String,
        used,
        s['resetMs'] as num?,
      );
      segs.add(seg.isNotEmpty ? seg : '${s['label']} $used%');
    }
    var text = sortWindowSegs(segs).join(' · ');
    if (syncRel.isNotEmpty) text += ' · $syncRel';
    text += ' ⟳';
    var title = 'Kimi 订阅用量（会员页抓取；订阅 key 无预付余额接口）';
    for (final s in summary) {
      title += '\n${s['label']}: 已用 ${fmtQuotaNum((s['used'] as num).toDouble())}%';
    }
    if (syncRel.isNotEmpty) title += '\n同步于 $syncRel';
    title += '\n点击 bar 刷新';
    return VendorQuotaView(
      text,
      unifiedColorFromRemaining(unifiedRemaining(maxUsed)),
      title,
    );
  }

  final okSites = <Map>[];
  if (status == 'ok' && value['sites'] is List) {
    for (final s in value['sites'] as List) {
      if (s is Map && s['ok'] == true && s['available'] is num) okSites.add(s);
    }
  }
  if (okSites.isEmpty) {
    final sites = value['sites'] is List ? value['sites'] as List : const [];
    final reason = kimiReasonText(sites);
    if (cachedOk.isNotEmpty) {
      return kimiCachedView(
        cachedOk,
        (cached!['fetchedAt'] as num?)?.toInt(),
        reason,
        '余额刷新失败，显示上次缓存值',
      );
    }
    final short = kimiShortReason(sites);
    final text = short.isNotEmpty
        ? 'Kimi：余额暂不可用（$short）· ⟳ 重试'
        : 'Kimi：余额暂不可用 · ⟳ 重试';
    return VendorQuotaView(
      text,
      VendorQuotaColor.yellow,
      reason.isNotEmpty ? reason : (value['error']?.toString() ?? ''),
    );
  }

  final s = okSites.first;
  final avail = (s['available'] as num).toDouble();
  var text = unifiedBalanceText(avail, s['currency']?.toString());
  if (text.isEmpty) text = '—';

  final titleLines = <String>[];
  for (final site in okSites) {
    var line =
        '${site['site']} (${site['host']}): 可用 ¥${fmtQuotaNum((site['available'] as num).toDouble())}';
    final voucher = site['voucher'];
    if (voucher is num) line += ' · 券 ¥${fmtQuotaNum(voucher.toDouble())}';
    final cash = site['cash'];
    if (cash is num) line += ' · 现金 ¥${fmtQuotaNum(cash.toDouble())}';
    titleLines.add(line);
  }

  final syncRel = quotaRelAgo((value['fetchedAt'] as num?)?.toInt());
  if (syncRel.isNotEmpty) text += ' · $syncRel';
  text += ' ⟳';

  var color = VendorQuotaColor.blue;
  if (avail <= 0) {
    color = VendorQuotaColor.red;
  } else if (avail <= 5) {
    color = VendorQuotaColor.yellow;
  }

  var title = 'Kimi / Moonshot 预付余额';
  title += '\n${titleLines.join('\n')}';
  if (syncRel.isNotEmpty) title += '\n同步于 $syncRel';
  return VendorQuotaView(text, color, title);
}

// ── Qoder CN (credits) ──────────────────────────────────────────────────────
//
// Qoder's usage is a credits balance on a monthly billing cycle, published by
// qoder.com.cn (CDP / cached-cookie, see /api/qoder/quota, mirroring the web
// `formatQoderQuota`). The usage API exposes the next reset as top-level
// `nextResetAt` (epoch ms) and the plan API carries end_date /
// next_refresh_date — both feed the countdown so the bar shows an expiry
// dimension like every other provider.

VendorQuotaView formatQoderQuota(
  Map<String, dynamic>? value, {
  bool loading = false,
  int? nowMs,
}) {
  final now = nowMs ?? DateTime.now().millisecondsSinceEpoch;
  if (loading) {
    return const VendorQuotaView('Qoder CN：加载中…', VendorQuotaColor.gray);
  }
  if (value == null) {
    return const VendorQuotaView(
      'Qoder CN 余量 · ⟳ 刷新',
      VendorQuotaColor.gray,
      '点击从 qoder.com.cn 拉取 credits 用量',
    );
  }
  final status = value['status']?.toString();
  if (status == 'needs_login') {
    return const VendorQuotaView(
      'Qoder CN：需登录 · 点击打开登录页',
      VendorQuotaColor.red,
      '你的 Chrome 里没有 qoder.com.cn 的登录态。点击将在 Chrome 中打开登录页，登录后再点刷新。',
    );
  }
  if (status == 'chrome_unavailable') {
    return const VendorQuotaView(
      'Qoder CN：无可连的 Chrome · 点击尝试打开登录窗口',
      VendorQuotaColor.yellow,
      '托管 Chrome 起不来，也没有可连的调试端点。点击会尝试拉起一个可见的 Chrome 登录窗口；在其中登录 qoder.com.cn 一次，之后一周的刷新都走缓存 cookie，不再需要浏览器。',
    );
  }
  final quota = value['quota'];
  if (status != 'ok' || quota is! Map) {
    return VendorQuotaView(
      'Qoder CN：用量暂不可用 · ⟳ 重试',
      VendorQuotaColor.yellow,
      value['error']?.toString() ?? '无法从 qoder.com.cn 拉取用量',
    );
  }

  final total = _qoderSummary(quota['total_quota']);
  final planQ = _qoderSummary(quota['plan_quota']);
  final pkg = _qoderSummary(quota['resource_package_quota']);
  final used = _qoderNum(total, 'used_value') ?? 0;
  final limit = _qoderNum(total, 'limit_value') ?? 0;
  final remaining = _qoderNum(total, 'remaining_value') ?? 0;
  var pct = _qoderNum(total, 'usage_percentage') ??
      (limit > 0 ? (used / limit * 100).roundToDouble() : 0.0);

  // Credits reset on the billing cycle. The usage API exposes the next reset
  // as top-level `nextResetAt` (epoch ms); the plan API's end_date /
  // next_refresh_date are the fallback when the usage response omits it.
  final resetAt = _qoderEpochMs(quota['nextResetAt']) ??
      _qoderEpochMs(_mapField(value['plan'], 'end_date')) ??
      _qoderEpochMs(_mapField(value['plan'], 'next_refresh_date'));
  final resetMs =
      resetAt == null ? null : (resetAt - now < 0 ? 0 : resetAt - now);

  var text = unifiedWindowSeg('1m', pct, resetMs);
  if (text.isEmpty) text = '—';
  final syncRel = quotaRelAgo((value['fetchedAt'] as num?)?.toInt());
  if (syncRel.isNotEmpty) text += ' · $syncRel';
  text += ' ⟳';

  final color = unifiedColorFromRemaining(unifiedRemaining(pct));

  final planTier = (value['plan'] is Map)
      ? ((value['plan'] as Map)['plan_tier']
              ?.toString()
              .replaceFirst('PLAN_TIER_', '') ??
          '')
      : '';
  var title =
      'Qoder CN 用量（CDP 抓 qoder.com.cn）\n套餐: $planTier'
      '\n总计: ${fmtQuotaNum(used)}/${fmtQuotaNum(limit)} · 剩余 ${fmtQuotaNum(remaining)}';
  final planLimit = _qoderNum(planQ, 'limit_value');
  if (planLimit != null && planLimit > 0) {
    title +=
        '\n套餐配额: ${fmtQuotaNum(_qoderNum(planQ, 'used_value') ?? 0)}/${fmtQuotaNum(planLimit)}';
  }
  final pkgLimit = _qoderNum(pkg, 'limit_value');
  if (pkgLimit != null && pkgLimit > 0) {
    title +=
        '\n加油包: ${fmtQuotaNum(_qoderNum(pkg, 'used_value') ?? 0)}/${fmtQuotaNum(pkgLimit)} (剩 ${fmtQuotaNum(_qoderNum(pkg, 'remaining_value') ?? 0)})';
  }
  // 到期/重置维度与其它 bar 一致：有真实时间戳显示倒计时与绝对时间，
  // 缺失时在 tooltip 如实标注（文本保持统一格式 <window> <remaining%>）。
  if (resetAt != null) {
    final cd = humanizeCountdown(resetMs);
    final dt = DateTime.fromMillisecondsSinceEpoch(resetAt).toLocal();
    title += '\n重置: ${dt.toString().substring(0, 16)}（$cd 后）';
  } else {
    title += '\n到期时间未知（API 未返回 nextResetAt/套餐到期日）';
  }
  if (syncRel.isNotEmpty) title += '\n同步于 $syncRel';
  return VendorQuotaView(text, color, title);
}

Map? _qoderSummary(dynamic block) =>
    block is Map ? (block['quota_summary'] is Map ? block['quota_summary'] as Map : null) : null;

num? _qoderNum(dynamic summary, String key) {
  if (summary is Map) {
    final v = summary[key];
    if (v is num) return v.toDouble();
  }
  return null;
}

dynamic _mapField(dynamic map, String key) => map is Map ? map[key] : null;

/// Epoch seconds-or-ms → epoch ms (matches the web `normalizeResetTime`).
int? _qoderEpochMs(dynamic v) {
  if (v is! num || v <= 0) return null;
  final ms = v < 10000000000 ? v * 1000 : v;
  return ms.toInt();
}

// ── Claude subscription (claude.ai/settings/usage) ──────────────────────────
//
// Claude's window data arrives through TWO sources, mirroring the web
// formatFiveHourRateLimit + formatClaudeUsageOnly:
//   1. the passive rate_limit_event → the 5h rolling window ([UsageWindowLimit]);
//   2. the /api/claude/quota scrape of claude.ai/settings/usage (CDP) → the
//      weekly (and monthly, when the page shows one) limits.
// The scrape's own 5h row duplicates the event, so only 1wk/1m are appended;
// the merge point normalises order via sortWindowSegs (5h → 1wk → 1m).

/// GLM/Codex window bar from the passive rate_limit_event, in the web unified
/// compact format (`formatFiveHourRateLimit`): 'window + remaining% +
/// countdown' with the canonical window label (GLM → 5h, Codex → 1wk) and the
/// shared remaining-percent color scale. Replaces the old verbose view
/// (label + used% + 更新于/重置于) which never matched the web bar.
VendorQuotaView formatWindowLimit(UsageWindowLimit limit, {int? nowMs}) {
  final now = nowMs ?? DateTime.now().millisecondsSinceEpoch;
  final rejected = limit.status == 'rejected';
  final effectiveUsed = rejected ? 100.0 : limit.usedPercentage;
  final resetMs = limit.resetsAtMs == null
      ? null
      : (limit.resetsAtMs! - now < 0 ? 0 : limit.resetsAtMs! - now);
  final windowLabel = limit.provider == 'codex' ? '1wk' : '5h';
  final seg = unifiedWindowSeg(windowLabel, effectiveUsed, resetMs);
  final text = seg.isNotEmpty ? seg : windowLabel;
  final color = unifiedColorFromRemaining(unifiedRemaining(effectiveUsed));
  final title = limit.provider == 'glm'
      ? 'GLM Coding Plan 五小时窗口用量（来自 open.bigmodel.cn 额度端点）'
      : limit.provider == 'codex'
          ? 'Codex 订阅周额度用量（来自 chatgpt.com/backend-api/wham/usage）'
          : 'Claude 订阅五小时用量（来自 Claude Code 结构化 rate_limit_event）';
  return VendorQuotaView(text, color, title);
}

/// Claude bar when a passive window limit is present: render the event's 5h
/// window plus the weekly/monthly windows from the usage-page scrape (the
/// scrape's own 5h row is skipped so the event stays the single 5h source).
/// A rejected event forces 0% remaining, like the web.
VendorQuotaView formatClaudeLimit(
  UsageWindowLimit limit,
  Map<String, dynamic>? usage, {
  int? nowMs,
}) {
  final now = nowMs ?? DateTime.now().millisecondsSinceEpoch;
  final used = limit.usedPercentage;
  final rejected = limit.status == 'rejected';
  final effectiveUsed = rejected ? 100.0 : used;
  final resetMs = limit.resetsAtMs == null
      ? null
      : (limit.resetsAtMs! - now < 0 ? 0 : limit.resetsAtMs! - now);

  final segs = <String>[];
  final first = unifiedWindowSeg('5h', effectiveUsed, resetMs);
  if (first.isNotEmpty) segs.add(first);

  final summary = usage?['summary'];
  final ok = usage != null && usage['status'] == 'ok' && summary is List;
  if (ok) {
    final List items = summary; // checked `is List` above; dynamic → List
    for (final s in items) {
      if (s is! Map) continue;
      final window = s['window']?.toString();
      final pct = (s['usedPercent'] as num?)?.toDouble();
      if (pct == null || pct.isNaN) continue;
      if (window != '1wk' && window != '1m') continue; // dedup vs the event 5h
      final cd = (s['resetMs'] as num?)?.toDouble();
      final cdMs = cd == null ? null : (cd - now < 0 ? 0 : cd - now);
      final seg = unifiedWindowSeg(window!, pct, cdMs);
      if (seg.isNotEmpty) segs.add(seg);
    }
  }

  var text = sortWindowSegs(segs).join(' · ');
  if (text.isEmpty) text = '—';
  final color = unifiedColorFromRemaining(unifiedRemaining(effectiveUsed));

  final titleLines = <String>[
    'Claude 订阅五小时用量（来自 Claude Code 结构化 rate_limit_event）',
  ];
  if (ok) {
    final List items = summary; // checked `is List` above; dynamic → List
    const zh = {'1wk': '周', '1m': '月'};
    for (final s in items) {
      if (s is! Map) continue;
      final window = s['window']?.toString();
      final pct = (s['usedPercent'] as num?)?.toDouble();
      if (pct == null || pct.isNaN || window == null || window == '5h') continue;
      final cd = (s['resetMs'] as num?)?.toDouble();
      final cdMs = cd == null ? null : (cd - now < 0 ? 0 : cd - now);
      titleLines.add(
        '${zh[window] ?? window}: 已用 ${pct.round()}%'
        '${cdMs != null && cdMs > 0 ? ' · ${humanizeCountdown(cdMs)} 后重置' : ''}',
      );
    }
    final fetchedAt = (usage['fetchedAt'] as num?)?.toInt();
    if (fetchedAt != null) {
      titleLines.add('同步于 ${quotaRelAgo(fetchedAt)}（claude.ai/settings/usage 抓取）');
    }
  }
  return VendorQuotaView(text, color, titleLines.join('\n'));
}

/// Idle placeholder for the always-visible Claude bar (no data yet). Mirrors
/// the web `formatClaudeIdle` — the bar stays a visible tap target.
VendorQuotaView _claudeIdleView() => const VendorQuotaView(
      '5h · — · ⟳ 刷新',
      VendorQuotaColor.gray,
      'Claude 订阅窗口用量。点击从 claude.ai/settings/usage 抓取 5h / 周 / 月 余量；'
      '5h 也会由 Claude Code 上报的 rate_limit_event 实时更新。',
    );

/// Claude bar when no passive rate_limit_event has landed yet: render the
/// usage-page scrape's windows, or an actionable state (needs_login /
/// chrome_unavailable), else the idle placeholder. Mirrors the web
/// `formatClaudeUsageOnly`.
VendorQuotaView formatClaudeUsageOnly(Map<String, dynamic>? usage, {int? nowMs}) {
  final now = nowMs ?? DateTime.now().millisecondsSinceEpoch;
  if (usage == null) return _claudeIdleView();
  final status = usage['status']?.toString();
  if (status == 'needs_login') {
    return const VendorQuotaView(
      'Claude：需登录 · 点击打开登录窗口',
      VendorQuotaColor.red,
      '你的浏览器里没有 claude.ai 的登录态。点击将在服务端拉起一个 Chrome 登录窗口'
      '（claude.ai/settings/usage），登录后回来再点一次刷新。',
    );
  }
  if (status == 'chrome_unavailable') {
    return const VendorQuotaView(
      'Claude：无可连的 Chrome · 点击尝试打开登录窗口',
      VendorQuotaColor.yellow,
      '托管 Chrome 起不来，也没有可连的调试端点。点击会尝试在服务端拉起一个可见的'
      ' Chrome 登录窗口。',
    );
  }
  final summaryRaw = usage['summary'];
  if (status != 'ok' || summaryRaw is! List) {
    return VendorQuotaView(
      'Claude：用量暂不可用 · ⟳ 重试',
      VendorQuotaColor.yellow,
      usage['error']?.toString() ?? '无法从 claude.ai/settings/usage 拉取窗口用量',
    );
  }
  final summary = <Map>[];
  for (final s in summaryRaw) {
    if (s is! Map) continue;
    final pct = (s['usedPercent'] as num?)?.toDouble();
    if (pct == null || pct.isNaN) continue;
    summary.add(s);
  }
  if (summary.isEmpty) {
    final raw = usage['text']?.toString() ?? '';
    return VendorQuotaView(
      'Claude：已登录，未解析出用量 · ⟳ 重试',
      VendorQuotaColor.yellow,
      '已抓到 claude.ai 用量页，但没解析出百分比。\n原文：'
      '${raw.length > 300 ? raw.substring(0, 300) : raw}',
    );
  }

  final segs = <String>[];
  var maxUsed = 0.0;
  for (final s in summary) {
    final pct = (s['usedPercent'] as num).toDouble();
    if (pct > maxUsed) maxUsed = pct;
    final window = s['window']?.toString();
    final label = (window == null || window.isEmpty)
        ? (s['label']?.toString() ?? '5h')
        : window;
    final cd = (s['resetMs'] as num?)?.toDouble();
    final cdMs = cd == null ? null : (cd - now < 0 ? 0 : cd - now);
    final seg = unifiedWindowSeg(label, pct, cdMs);
    if (seg.isNotEmpty) segs.add(seg);
  }
  var text = sortWindowSegs(segs).join(' · ');
  if (text.isEmpty) text = '—';
  final syncRel = quotaRelAgo((usage['fetchedAt'] as num?)?.toInt());
  if (syncRel.isNotEmpty) text += ' · $syncRel';
  text += ' ⟳';

  var title = 'Claude 订阅窗口用量（claude.ai/settings/usage 抓取）';
  for (final s in summary) {
    final window = s['window']?.toString();
    final label = (window == null || window.isEmpty)
        ? (s['label']?.toString() ?? '?')
        : window;
    title += '\n$label: 已用 ${(s['usedPercent'] as num).toDouble().round()}%';
  }
  if (syncRel.isNotEmpty) title += '\n同步于 $syncRel';
  title += '\n点击 bar 刷新';
  return VendorQuotaView(
    text,
    unifiedColorFromRemaining(unifiedRemaining(maxUsed)),
    title,
  );
}
