import '../i18n.dart';

/// ONE source for every number the app puts in front of a reader: byte sizes,
/// relative times, elapsed spans, token counts and the tone a usage percentage
/// is painted with.
///
/// The web mirror is `public/shared/format.js`, and the two are pinned together:
/// `tests/test-format-parity.js` parses the tables below out of this file and
/// fails if they disagree with the JavaScript ones, and both ends run the same
/// fixture (`tests/fixtures/format-cases.json`) — the Node half in
/// `tests/test-format.js`, the Flutter half in `app/test/format_test.dart`. A
/// change made on one side only therefore fails on both.
///
/// Before this file the app carried its own arithmetic per screen: `_fmtBytes`
/// in Agent resources (0 decimals under KB, nothing above GB), `_formatSize` in
/// the file browser (no space, no TB), `formatMemorySize` in the memory service
/// (one decimal everywhere), `opsPackageSize` in Air Ops (whole KB) — four
/// answers to "how big is this file". Relative time had three tables, and the
/// two quota-bar copies had a fourth. The tables are the contract; only the
/// *units of presentation* the surfaces genuinely need are options.
///
/// Deliberately NOT here: absolute wall-clock formatting (`toLocaleString` /
/// `DateFormat` — a locale concern, not a unit), exact token counts with
/// thousands separators (a reader comparing two exact numbers wants no
/// compaction), and counting logic such as "how full is the window" — this file
/// formats numbers, it does not decide which number to show.
///
/// i18n: the app's [I18n.t] already falls back to zh and then to the key, so a
/// relative time renders the zh catalog words by default and the en ones under
/// `en`. `public/shared/format.js` has no catalog on the terminal page or in a
/// Node test, so it carries the same zh words as a literal fallback — and the
/// parity test asserts that literal against `app/assets/i18n/zh.json`, which is
/// what keeps the two ends rendering identical text in zh.

// ── Tables (parsed by tests/test-format-parity.js — keep the literals flat) ──

const int kByteBase = 1024;
const List<String> kByteUnits = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
const int kByteDefaultDecimals = 1;
const String kByteDefaultMaxUnit = 'TB';

/// `[maxSeconds (exclusive), divisor, tier]`, walked top to bottom.
const List<List<Object>> kRelativeTiers = [
  [5, 1, 'justNow'],
  [60, 1, 'seconds'],
  [3600, 60, 'minutes'],
  [86400, 3600, 'hours'],
  [double.infinity, 86400, 'days'],
];

/// tier → i18n key. The compact set differs in the seconds tier ONLY.
const Map<String, String> kRelativeTierKeys = {
  'justNow': 'justNow',
  'seconds': 'secondsAgo',
  'minutes': 'minutesAgo',
  'hours': 'hoursAgo',
  'days': 'daysAgo',
};
const Map<String, String> kRelativeTierKeysCompact = {
  'justNow': 'justNow',
  'seconds': 'secondsAgoCompact',
  'minutes': 'minutesAgo',
  'hours': 'hoursAgo',
  'days': 'daysAgo',
};

const int kSpanMsLimit = 1000;
const int kSpanSecondsLimit = 60;
const int kSpanDecimalLimit = 10;

/// `[min (inclusive), divisor, suffix, decimals]`, walked top to bottom.
const List<List<Object>> kTokenUnits = [
  [1000000, 1000000, 'M', 2],
  [1000, 1000, 'k', 1],
];

/// kind → `[min (inclusive) used percent, tone]`, walked top to bottom.
///
/// `quota` is a subscription window (90/70 is the complement of the server
/// renderer's remaining cut at 10/30); `context` is how full the model window is
/// (warns earlier — a compaction is not a lockout). The tone is shared with the
/// web; the hex is per-platform (`kUsageColors` here, `AppColors`/CSS vars in a
/// widget).
const Map<String, List<List<Object>>> kUsageThresholds = {
  'quota': [
    [90, 'danger'],
    [70, 'warning'],
    [0, 'calm'],
  ],
  'context': [
    [80, 'danger'],
    [50, 'warning'],
    [0, 'success'],
  ],
};
const List<String> kUsageKinds = ['quota', 'context'];

/// The web palette, carried here ONLY so the parity test can prove the two ends
/// would paint the same tone the same way. No Flutter widget may use these
/// values — the app has its own light palette in `AppColors`, and a quota bar
/// reaches the app fully coloured from the server renderer.
const Map<String, String> kUsageColors = {
  'danger': '#f85149',
  'warning': '#d29922',
  'calm': '#58a6ff',
  'success': '#3fb950',
};

// ── Byte sizes ──────────────────────────────────────────────────────────────

/// `formatBytes(1536)` → `'1.5 KB'`, `formatBytes(0)` → `'0 B'`.
///
/// Bytes are never given a decimal (`'512 B'`, not `'512.0 B'`).
///
/// [decimals] applies to every unit above B; [unitDecimals] overrides it per
/// unit, for the two surfaces whose precision is a contract rather than a taste
/// (Air Ops rounds KB to a whole number so it reports the same figure as the
/// manage panel for the same file; Agent resources keeps two decimals for MB so
/// the number can be checked against `du`). [space] false renders `'1.5KB'`.
/// [placeholder] is returned for null / NaN / Infinity / negative, and
/// [zeroIsMissing] also treats 0 as "no value" (an unpublished 0-byte artifact).
String formatBytes(
  num? bytes, {
  int decimals = kByteDefaultDecimals,
  Map<String, int> unitDecimals = const {},
  bool space = true,
  String maxUnit = kByteDefaultMaxUnit,
  String placeholder = '',
  bool zeroIsMissing = false,
}) {
  if (bytes == null) return placeholder;
  final value = bytes.toDouble();
  if (!value.isFinite || value < 0) return placeholder;
  if (value == 0 && zeroIsMissing) return placeholder;

  var maxIndex = kByteUnits.indexOf(maxUnit);
  if (maxIndex < 0) maxIndex = kByteUnits.length - 1;
  var index = 0;
  var scaled = value;
  while (scaled >= kByteBase && index < maxIndex) {
    scaled /= kByteBase;
    index += 1;
  }
  final unit = kByteUnits[index];
  final digits = index == 0 ? 0 : (unitDecimals[unit] ?? decimals);
  return '${scaled.toStringAsFixed(digits)}${space ? ' ' : ''}$unit';
}

// ── Relative time ───────────────────────────────────────────────────────────

/// `formatRelativeTime(Date.now() - 90000)` → `'1 分钟前'`.
///
/// [nowMs] injects a fixed clock for deterministic tests; it defaults to now.
/// [placeholder] is returned for a missing / zero / negative stamp (which is not
/// the same as "zero seconds ago"). [compact] picks the compact seconds tier the
/// quota bar uses. A future stamp clamps to "just now" rather than counting
/// backwards.
String formatRelativeTime(
  int? tsMs, {
  int? nowMs,
  String placeholder = '',
  bool compact = false,
}) {
  if (tsMs == null || tsMs <= 0) return placeholder;
  final clock = nowMs ?? DateTime.now().millisecondsSinceEpoch;
  final seconds = ((clock - tsMs) ~/ 1000).clamp(0, 1 << 62).toInt();
  final keys = compact ? kRelativeTierKeysCompact : kRelativeTierKeys;
  for (final tier in kRelativeTiers) {
    final maxSeconds = (tier[0] as num).toDouble();
    if (seconds >= maxSeconds) continue;
    final tierName = tier[2] as String;
    final key = keys[tierName] ?? tierName;
    if (tierName == 'justNow') return t(key);
    final divisor = tier[1] as int;
    return t(key, {'n': '${seconds ~/ divisor}'});
  }
  return placeholder;
}

// ── Elapsed spans ───────────────────────────────────────────────────────────

/// A measured wall-clock span: sub-second stays in ms (a tool that took 900ms
/// must not read "0.9s" next to one that took 1.1s), under a minute keeps one
/// decimal only while the number is small enough for it to mean something, and
/// past a minute the seconds are spelled out separately.
///
/// This is NOT [formatRunDuration] — that one is a localized sentence about how
/// long a task ran (`1分05秒`); this one is a measurement suffix.
/// `''` for null / negative / NaN: we never fabricate `0ms`.
String formatDuration(num? ms) {
  if (ms == null || !ms.isFinite || ms < 0) return '';
  final value = ms.toDouble();
  if (value < kSpanMsLimit) return '${value.round()}ms';
  final seconds = value / 1000;
  if (seconds < kSpanSecondsLimit) {
    return seconds < kSpanDecimalLimit
        ? '${seconds.toStringAsFixed(1)}s'
        : '${seconds.round()}s';
  }
  final minutes = seconds ~/ kSpanSecondsLimit;
  final rest = (seconds - minutes * kSpanSecondsLimit).round();
  return rest > 0 ? '${minutes}m ${rest}s' : '${minutes}m';
}

/// The localized "how long has this been running" duration, zero-padded:
/// `1时05分` / `1m 05s` / `5s`. Moved here from session_status_helpers so the
/// app has ONE duration module; `runTimeText` (which needs a SessionStatus)
/// stays there and calls this.
String formatRunDuration(Duration d) {
  final totalSec = d.inSeconds;
  final h = totalSec ~/ 3600;
  final m = (totalSec % 3600) ~/ 60;
  final sec = totalSec % 60;
  if (h > 0) {
    return t('durationHoursMinutes', {
      'h': '$h',
      'm': m.toString().padLeft(2, '0'),
    });
  }
  if (m > 0) {
    return t('durationMinutesSeconds', {
      'm': '$m',
      's': sec.toString().padLeft(2, '0'),
    });
  }
  return t('durationSeconds', {'s': '$sec'});
}

// ── Percentages ─────────────────────────────────────────────────────────────

/// `formatPercent(61.54)` → `'61.5%'`. Clamped to [0, 100]; `''` when unknown.
String formatPercent(num? value, {int decimals = 1}) {
  if (value == null || !value.isFinite) return '';
  return '${value.toDouble().clamp(0.0, 100.0).toStringAsFixed(decimals)}%';
}

/// The tone name for a used percent — one of danger / warning / calm / success.
String usageTone(num? pct, String kind) {
  final table = kUsageThresholds[kind] ?? kUsageThresholds['quota']!;
  final value = (pct == null || !pct.isFinite) ? 0.0 : pct.toDouble();
  for (final entry in table) {
    if (value >= (entry[0] as num)) return entry[1] as String;
  }
  return table.last[1] as String;
}

// ── Token counts ────────────────────────────────────────────────────────────

/// Thousands separators without an intl dependency, so the output matches
/// `groupedNumber` in `public/shared/format.js` exactly.
String groupedNumber(int n) => '$n'.replaceAllMapped(
      RegExp(r'\B(?=(\d{3})+(?!\d))'),
      (m) => ',',
    );

/// A billed token breakdown (`↑入 56 ↓出 5.2k ♻读 2.70M`): two decimals once the
/// number is in the millions, so a difference of ten thousand tokens is still
/// visible, and thousands separators below that so an exact count stays
/// readable. [dropZeroDecimal] renders `200000` as `'200k'` — for a context
/// window, which is always a whole thousand, the trailing `.0` is noise.
String formatTokenCount(int value, {bool dropZeroDecimal = false}) {
  final n = value > 0 ? value : 0;
  for (final unit in kTokenUnits) {
    final min = unit[0] as int;
    if (n < min) continue;
    final divisor = unit[1] as int;
    var text = (n / divisor).toStringAsFixed(unit[3] as int);
    if (dropZeroDecimal) text = text.replaceAll(RegExp(r'\.0+$'), '');
    return '$text${unit[2]}';
  }
  return groupedNumber(n);
}

/// `formatCompactTokens(200000)` → `'200K'`.
///
/// The same "how many tokens" question asked at a coarser precision: a window
/// size and an approximate context estimate are rounded figures, so a trailing
/// `.0` says precision the number does not have.
String formatCompactTokens(int value) {
  final n = value > 0 ? value : 0;
  if (n >= 1000000) {
    return '${(n / 1000000).toStringAsFixed(1).replaceAll(RegExp(r'\.0$'), '')}M';
  }
  if (n >= 1000) {
    return '${(n / 1000).toStringAsFixed(1).replaceAll(RegExp(r'\.0$'), '')}K';
  }
  return '$n';
}
