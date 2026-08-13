import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:multicc_app/models/quota_bar_view.dart';

/// The golden parity contract: the server renders a quota bar once (words,
/// colors, ordering and vendor rules all baked in, with only {cd:}/{ago:} time
/// tokens left for the client), and BOTH clients must resolve those tokens to
/// the same strings. This is the Flutter half; tests/test-quota-bar-parity.js is
/// the node half. Both read the same fixture (tests/fixtures/quota-bar-golden.json),
/// so a resolver change that is not mirrored on the other end fails here AND there.
Map<String, dynamic> _loadFixture() {
  for (final candidate in [
    'tests/fixtures/quota-bar-golden.json',
    '../tests/fixtures/quota-bar-golden.json',
  ]) {
    final file = File(candidate);
    if (file.existsSync()) {
      return jsonDecode(file.readAsStringSync()) as Map<String, dynamic>;
    }
  }
  throw StateError('quota-bar-golden.json not found relative to CWD');
}

void main() {
  final fixture = _loadFixture();
  final now = (fixture['now'] as num).toInt();
  final cases = (fixture['cases'] as List).cast<Map<String, dynamic>>();

  test('the golden fixture is non-empty and anchored to a fixed now', () {
    expect(now, isPositive);
    expect(cases.length, greaterThanOrEqualTo(20),
        reason: 'expected broad coverage');
  });

  for (final c in cases) {
    final name = c['name'] as String;
    test('flutter resolver matches golden: $name', () {
      final bar = (c['bar'] as Map).cast<String, dynamic>();
      final state = c['state'] as String?;
      final expected =
          (c['expected'] as Map).cast<String, dynamic>();
      final view = resolveQuotaBar(bar, state: state, now: now);

      expect(view, isNotNull, reason: 'a bar must resolve, never null');
      expect(view!.text, expected['text'], reason: 'text');
      expect(view.color, QuotaBarColor.parse(expected['colorHex'] as String),
          reason: 'color');
      expect(view.title, expected['title'], reason: 'title');
      expect(view.action, expected['action'], reason: 'action');
    });
  }

  test('the resolver never leaves a {cd:} or {ago:} token in the output', () {
    final token = RegExp(r'\{(cd|ago):');
    for (final c in cases) {
      final bar = (c['bar'] as Map).cast<String, dynamic>();
      final state = c['state'] as String?;
      final view = resolveQuotaBar(bar, state: state, now: now);
      expect(view, isNotNull);
      expect(token.hasMatch(view!.text), isFalse,
          reason: '${c['name']}: unresolved token in text');
      expect(token.hasMatch(view.title), isFalse,
          reason: '${c['name']}: unresolved token in title');
    }
  });
}
