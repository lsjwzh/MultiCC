import '../i18n.dart';

/// Compact suffix appended to a provider option: the cached limit summary plus
/// freshness / failure / stale markers. Returns '' when there is no cache entry
/// (never queried, cache disabled, or a provider that predates the cache) so the
/// option reads exactly as before — no data is a clean, intentional absence.
///
/// Mirrors the web picker's `providerLimitLabel` (public/chat-ai-config.js) so
/// both clients age and phrase the cached limit the same way. The `limit` field
/// arrives inside each provider DTO of `/api/providers` as
/// `{kind, status, summaryText, fetchedAt, updatedAt, lastError, stale}`.
///
/// [nowMs] injects a fixed clock for deterministic tests; defaults to now.
String providerLimitLabel(Map<String, dynamic>? provider, {int? nowMs}) {
  final detail = providerLimitDetail(provider, nowMs: nowMs);
  return detail.isEmpty ? '' : ' · $detail';
}

/// The limit summary + freshness markers joined by ' · ' WITHOUT the leading
/// separator that [providerLimitLabel] prepends for single-line suffix use.
/// Two-line picker rows render this as their second line so the quota text is
/// never eaten by a single-line ellipsis on narrow phones.
String providerLimitDetail(Map<String, dynamic>? provider, {int? nowMs}) {
  final limit = provider?['limit'];
  if (limit is! Map) return '';
  final parts = <String>[];
  final summaryText = (limit['summaryText'] ?? '').toString();
  if (summaryText.isNotEmpty) parts.add(summaryText);
  final lastError = (limit['lastError'] ?? '').toString();
  final fetchedAt =
      (limit['fetchedAt'] is num) ? (limit['fetchedAt'] as num).toInt() : 0;
  if (lastError.isNotEmpty) {
    parts.add(t('limitFetchFailed'));
  } else if (fetchedAt > 0) {
    parts.add(t('limitUpdatedAgo', {'ago': limitAgoText(fetchedAt, nowMs)}));
  }
  if (limit['stale'] == true && summaryText.isNotEmpty) {
    parts.add(t('limitStale'));
  }
  return parts.join(' · ');
}

/// Locale-aware relative freshness. Reuses the existing justNow/secondsAgo/…
/// keys (same granularity as formatRelativeTime in session_status_helpers).
String limitAgoText(int tsMs, int? nowMs) {
  final now = nowMs ?? DateTime.now().millisecondsSinceEpoch;
  var sec = ((now - tsMs) / 1000).floor();
  if (sec < 0) sec = 0;
  if (sec < 5) return t('justNow');
  if (sec < 60) return t('secondsAgo', {'n': '$sec'});
  final min = sec ~/ 60;
  if (min < 60) return t('minutesAgo', {'n': '$min'});
  final h = min ~/ 60;
  if (h < 24) return t('hoursAgo', {'n': '$h'});
  return t('daysAgo', {'n': '${h ~/ 24}'});
}
