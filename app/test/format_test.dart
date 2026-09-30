import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/utils/format.dart';

/// The Flutter half of the golden contract for `app/lib/utils/format.dart`.
///
/// `tests/fixtures/format-cases.json` is hand-written and reviewed — every
/// `expected` string was typed out by a human, not copied from either
/// implementation — and it is run through BOTH ends: the node half lives in
/// `tests/test-format.js`, this is the Dart half. A change made on one side only
/// therefore fails on both sides.
///
/// The tables themselves (units, tiers, thresholds) are pinned across the two
/// languages by `tests/test-format-parity.js`, which parses this package's
/// format.dart. This file is about values.
Map<String, dynamic> _loadFixture() {
  for (final candidate in [
    'tests/fixtures/format-cases.json',
    '../tests/fixtures/format-cases.json',
  ]) {
    final file = File(candidate);
    if (file.existsSync()) {
      return jsonDecode(file.readAsStringSync()) as Map<String, dynamic>;
    }
  }
  throw StateError('format-cases.json not found relative to CWD');
}

/// Runs one fixture entry against the Dart implementation. The fixture is
/// JSON, so its option names are the JavaScript ones (`now`, not `nowMs`);
/// translating them here is the only place the two APIs are allowed to differ.
String _run(String fn, List<dynamic> args, Map<String, dynamic> opts) {
  final placeholder = (opts['placeholder'] as String?) ?? '';
  switch (fn) {
    case 'formatBytes':
      return formatBytes(
        args[0] as num?,
        decimals: (opts['decimals'] as num?)?.toInt() ?? kByteDefaultDecimals,
        unitDecimals: ((opts['unitDecimals'] as Map?) ?? const {})
            .map((k, v) => MapEntry('$k', (v as num).toInt())),
        space: (opts['space'] as bool?) ?? true,
        maxUnit: (opts['maxUnit'] as String?) ?? kByteDefaultMaxUnit,
        placeholder: placeholder,
        zeroIsMissing: (opts['zeroIsMissing'] as bool?) ?? false,
      );
    case 'formatRelativeTime':
      return formatRelativeTime(
        (args[0] as num?)?.toInt(),
        nowMs: (opts['now'] as num?)?.toInt(),
        placeholder: placeholder,
        compact: (opts['compact'] as bool?) ?? false,
      );
    case 'formatDuration':
      return formatDuration(args[0] as num?);
    case 'formatPercent':
      return formatPercent(
        args[0] as num?,
        decimals: (opts['decimals'] as num?)?.toInt() ?? 1,
      );
    case 'formatTokenCount':
      return formatTokenCount(
        (args[0] as num).toInt(),
        dropZeroDecimal: (opts['dropZeroDecimal'] as bool?) ?? false,
      );
    case 'formatCompactTokens':
      return formatCompactTokens((args[0] as num).toInt());
    case 'usageTone':
      return usageTone(args[0] as num?, args[1] as String);
  }
  throw StateError('unknown formatter in the fixture: $fn');
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  // zh is the default language and the language the fixture's expected strings
  // are written in; the node half has no catalog at all and carries the same zh
  // words as a literal fallback, which is what keeps the two ends comparable.
  setUpAll(() => I18n.init('zh'));

  final fixture = _loadFixture();
  final cases = (fixture['cases'] as List).cast<Map<String, dynamic>>();

  test('the fixture is broad enough to be worth trusting', () {
    expect(cases.length, greaterThanOrEqualTo(100));
    final fns = cases.map((c) => c['fn'] as String).toSet();
    for (final fn in [
      'formatBytes', 'formatRelativeTime', 'formatDuration', 'formatPercent',
      'formatTokenCount', 'formatCompactTokens', 'usageTone',
    ]) {
      expect(fns, contains(fn));
    }
  });

  for (final c in cases) {
    final fn = c['fn'] as String;
    final args = c['args'] as List;
    final opts = (c['opts'] as Map).cast<String, dynamic>();
    test('$fn(${args.join(', ')}${opts.isEmpty ? '' : ', $opts'})', () {
      expect(_run(fn, args, opts), c['expected']);
    });
  }

  test('an unmeasurable span is empty, never a fabricated zero', () {
    // The fixture covers the values; this covers the contract at the type level,
    // where Dart can also hand it null (which JSON cannot express as a call).
    expect(formatDuration(null), '');
    expect(formatDuration(double.nan), '');
    expect(formatDuration(double.infinity), '');
    expect(formatRelativeTime(null), '');
    expect(formatRelativeTime(0), '');
    expect(formatBytes(null), '');
    expect(formatPercent(null), '');
  });

  test('a missing byte size is the caller\'s placeholder, not a fabricated 0 B', () {
    // The three surfaces that had a "no size yet" state say so with their own
    // glyph; the module must not invent a zero for them.
    expect(formatBytes(null, placeholder: '–'), '–');
    expect(formatBytes(0, placeholder: '—', zeroIsMissing: true), '—');
    expect(formatBytes(0, placeholder: '—', zeroIsMissing: false), '0 B');
  });

  test('the tone and the colour table agree with the thresholds', () {
    expect(kUsageKinds, ['quota', 'context']);
    for (final entry in kUsageThresholds.entries) {
      for (final row in entry.value) {
        expect(usageTone(row[0] as num, entry.key), row[1],
            reason: '${entry.key} at ${row[0]}');
      }
    }
    expect(usageTone(95, 'unknown-kind-falls-back-to-quota'), 'danger');
    expect(kUsageColors.keys.toSet(), {'danger', 'warning', 'calm', 'success'});
  });
}
