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

  var maxPct = 0.0;
  final parts = <String>[];
  for (final it in ordered) {
    final isActive = it['product'] == activePlan;
    final segs = <String>[];
    for (final p in it['periods'] as List) {
      if (p is! Map) continue;
      final pct = (p['percent'] as num?)?.toDouble() ?? 0;
      if (pct > maxPct) maxPct = pct;
      segs.add('${arkPeriodLabel(p['label']?.toString())} ${fmtQuotaNum(pct)}%');
    }
    parts.add(
      '${arkProductLabel(it['product']?.toString())}'
      '${isActive ? '（当前）' : ''} ${segs.join(' · ')}',
    );
  }

  var text = parts.join(' ｜ ');
  final syncRel = quotaRelAgo((value['fetchedAt'] as num?)?.toInt());
  if (syncRel.isNotEmpty) text += ' · $syncRel';
  text += ' ⟳';

  var color = VendorQuotaColor.blue;
  if (maxPct >= 90) {
    color = VendorQuotaColor.red;
  } else if (maxPct >= 70) {
    color = VendorQuotaColor.yellow;
  }
  return VendorQuotaView(text, color, '火山方舟套餐额度（arkcli usage plan）');
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

  var maxPct = 0.0;
  final parts = <String>[];
  for (final s in okSites) {
    final pct = (s['usedPercent'] as num).toDouble();
    if (pct > maxPct) maxPct = pct;
    final periodTag = s['period'] == 'weekly' ? '周' : '5h';
    parts.add('${s['site']} $periodTag ${fmtQuotaNum(pct)}%');
    final weekly = s['weeklyUsedPercent'];
    if (weekly is num) {
      if (weekly.toDouble() > maxPct) maxPct = weekly.toDouble();
      parts.add('周 ${fmtQuotaNum(weekly)}%');
    }
  }

  var text = parts.join(' · ');
  final syncRel = quotaRelAgo((value['fetchedAt'] as num?)?.toInt());
  if (syncRel.isNotEmpty) text += ' · $syncRel';
  text += ' ⟳';

  var color = VendorQuotaColor.blue;
  if (maxPct >= 90) {
    color = VendorQuotaColor.red;
  } else if (maxPct >= 70) {
    color = VendorQuotaColor.yellow;
  }
  return VendorQuotaView(text, color, 'Zhipu 官方站点窗口用量（glm-monitor 额度端点）');
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
  var minAvail = double.infinity;
  final parts = <String>[];
  for (final s in cachedOk) {
    final avail = (s['available'] as num).toDouble();
    if (avail < minAvail) minAvail = avail;
    parts.add('${s['site']} ¥${fmtQuotaNum(avail)}');
  }
  final syncRel = quotaRelAgo(fetchedAt);
  var text = parts.join(' · ');
  if (syncRel.isNotEmpty) text += ' · 上次 $syncRel';
  text += ' ⟳';
  var color = VendorQuotaColor.gray;
  if (minAvail <= 0) {
    color = VendorQuotaColor.red;
  } else if (minAvail <= 5) {
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

  var minAvail = double.infinity;
  final parts = <String>[];
  for (final s in okSites) {
    final avail = (s['available'] as num).toDouble();
    if (avail < minAvail) minAvail = avail;
    parts.add('${s['site']} ¥${fmtQuotaNum(avail)}');
  }
  var text = parts.join(' · ');
  final syncRel = quotaRelAgo((value['fetchedAt'] as num?)?.toInt());
  if (syncRel.isNotEmpty) text += ' · $syncRel';
  text += ' ⟳';

  var color = VendorQuotaColor.blue;
  if (minAvail <= 0) {
    color = VendorQuotaColor.red;
  } else if (minAvail <= 5) {
    color = VendorQuotaColor.yellow;
  }
  return VendorQuotaView(text, color, 'Kimi / Moonshot 预付余额');
}
