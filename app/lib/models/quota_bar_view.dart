/// Expands the two time-relative tokens in a server-rendered quota bar.
///
/// The bar's words, colors, ordering and vendor rules all live server-side in
/// src/quota/quota-bar-view.js, rendered once and displayed verbatim by both
/// clients. Only the parts that change while nobody is fetching anything have
/// to be resolved at paint time:
///
///   `{cd:<epochMs>}`   a deadline  → "42m" · "3.5h" · "3d 5h"
///   `{ago:<epochMs>}`  a timestamp → "刚刚" · "57s 前" · "3 分钟前"
///
/// A bar is cached and redisplayed for as long as the app stays open, so baking
/// these in would make a bar quietly lie about how old it is.
///
/// This file mirrors public/quota-bar-view.js and nothing else. Both are pure
/// arithmetic with no vendor strings, and app/test/quota_bar_render_test.dart +
/// tests/test-quota-bar-parity.js run the same golden fixtures
/// (tests/fixtures/quota-bar-golden.json) through both, so a change to one that
/// is not mirrored in the other fails on both ends.
library;

import '../utils/format.dart';

/// The server's palette, as ARGB. The client picks no colors of its own.
///
/// These four are a verbatim mirror of `COLOR` in `src/quota/quota-bar-view.js`
/// — the server renders the bar's colour as a `#rrggbb` string and [parse] hands
/// it straight back, so re-theming these to the local Air palette would only
/// desync the constants from the strings that actually arrive. The fallback is
/// the one place the value is really used; `tests/test-quota-bar-parity.js` and
/// `tests/fixtures/quota-bar-golden.json` pin the server side.
class QuotaBarColor {
  static const int gray = 0xFF8B949E;
  static const int red = 0xFFF85149;
  static const int yellow = 0xFFD29922;
  static const int blue = 0xFF58A6FF;

  /// `#rrggbb` → ARGB. Falls back to gray rather than throwing: a bar with an
  /// unreadable color should still show its text.
  static int parse(String? hex) {
    final h = (hex ?? '').replaceFirst('#', '').trim();
    if (h.length != 6) return gray;
    final v = int.tryParse(h, radix: 16);
    return v == null ? gray : (0xFF000000 | v);
  }
}

/// A bar as the client paints it: placeholders expanded, one state chosen.
class QuotaBar {
  final String text;
  final int color;
  final String title;
  final String? action;

  const QuotaBar({
    required this.text,
    required this.color,
    this.title = '',
    this.action,
  });
}

/// Time left, coarsening as it grows: minutes under an hour, one decimal of an
/// hour under a day, then days. Never returns '' for a real deadline, so a
/// segment's separators are safe to bake into the server-rendered string; a
/// deadline that has already passed is handled by [resolveQuotaText] (已重置),
/// which is the only caller.
String humanizeCountdown(num? ms) {
  if (ms == null || !ms.isFinite || ms < 0) return '';
  final totalH = ms / 3600000;
  if (totalH < 1) {
    final m = (ms / 60000).round();
    return '${m < 1 ? 1 : m}m';
  }
  if (totalH < 24) {
    final h = (totalH * 10).round() / 10;
    return '${h == h.roundToDouble() ? h.toStringAsFixed(0) : h.toStringAsFixed(1)}h';
  }
  final d = (totalH / 24).floor();
  final remH = (totalH % 24).floor();
  return remH > 0 ? '${d}d ${remH}h' : '${d}d';
}

/// How long ago a fetch landed. This is the number that tells the user whether
/// the bar in front of them is worth believing.
///
/// The table lives in utils/format.dart ([formatRelativeTime]) together with the
/// web copy in public/shared/format.js; this wrapper only pins the compact
/// seconds tier (`57s 前`, not `57 秒前`) the bar's narrow strip needs — the
/// same `compact: true` the web module passes. Before that the three strings
/// here were written out by hand and hardcoded in Chinese, so an English bar
/// said `5 分钟前`.
String relativeAgo(num? tsMs, int nowMs) {
  if (tsMs == null || !tsMs.isFinite) return '';
  return formatRelativeTime(tsMs.toInt(), nowMs: nowMs, compact: true);
}

final RegExp _token = RegExp(r'\{(cd|ago):(-?\d+)\}');

/// A deadline that is already past is NOT "one minute left". The window has
/// rolled, and the percentage printed next to it belongs to the window that
/// just ended — a bar restored from cache hours later would otherwise read
/// "5h 93% 1m", i.e. 93% used with a minute to go, which is the most misleading
/// thing this bar can say. Say what happened instead. The segment stays
/// non-empty, which is what keeps the separators the server baked in (see
/// [humanizeCountdown]) safe to expand. Mirrors `ROLLED_WINDOW` in
/// public/quota-bar-view.js.
const String rolledWindowText = '已重置';

String resolveQuotaText(String? text, int nowMs) {
  if (text == null || text.isEmpty || !text.contains('{')) return text ?? '';
  return text.replaceAllMapped(_token, (m) {
    final at = int.tryParse(m.group(2) ?? '') ?? 0;
    if (m.group(1) != 'cd') return relativeAgo(at, nowMs);
    final left = at - nowMs;
    return left > 0 ? humanizeCountdown(left) : rolledWindowText;
  });
}

/// A server-rendered bar → the strings to paint right now.
///
/// [state] picks one of the server's alternative renders (a fetch in flight, a
/// login window waiting on a human); an unknown state falls back to the default
/// render rather than blanking the bar.
QuotaBar? resolveQuotaBar(Map<String, dynamic>? bar, {String? state, int? now}) {
  if (bar == null) return null;
  final nowMs = now ?? DateTime.now().millisecondsSinceEpoch;
  Map<String, dynamic> picked = bar;
  if (state != null && state.isNotEmpty) {
    final states = bar['states'];
    if (states is Map && states[state] is Map) {
      picked = Map<String, dynamic>.from(states[state] as Map);
    }
  }
  final action = picked['action'];
  return QuotaBar(
    text: resolveQuotaText(picked['text']?.toString(), nowMs),
    color: QuotaBarColor.parse(picked['color']?.toString()),
    title: resolveQuotaText(picked['title']?.toString(), nowMs),
    action: action?.toString(),
  );
}
