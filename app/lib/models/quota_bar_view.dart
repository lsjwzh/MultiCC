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

/// The server's palette, as ARGB. The client picks no colors of its own.
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
/// hour under a day, then days. Never returns '' for a real deadline — a
/// deadline in the past reads as "1m", so a segment's separators are safe to
/// bake into the server-rendered string.
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
String relativeAgo(num? tsMs, int nowMs) {
  if (tsMs == null || !tsMs.isFinite || tsMs <= 0) return '';
  var sec = ((nowMs - tsMs) / 1000).floor();
  if (sec < 0) sec = 0;
  if (sec < 5) return '刚刚';
  if (sec < 60) return '${sec}s 前';
  final min = sec ~/ 60;
  if (min < 60) return '$min 分钟前';
  final h = min ~/ 60;
  if (h < 24) return '$h 小时前';
  return '${h ~/ 24} 天前';
}

final RegExp _token = RegExp(r'\{(cd|ago):(-?\d+)\}');

String resolveQuotaText(String? text, int nowMs) {
  if (text == null || text.isEmpty || !text.contains('{')) return text ?? '';
  return text.replaceAllMapped(_token, (m) {
    final at = int.tryParse(m.group(2) ?? '') ?? 0;
    return m.group(1) == 'cd'
        ? humanizeCountdown((at - nowMs) < 0 ? 0 : (at - nowMs))
        : relativeAgo(at, nowMs);
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
