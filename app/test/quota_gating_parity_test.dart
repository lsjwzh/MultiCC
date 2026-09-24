import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:multicc_app/models/vendor_quota.dart';

/// The gating parity contract — the Flutter half.
///
/// Deciding WHICH window/balance bar may be on screen is a pure function of
/// (window kind, cli, baseUrl), and that decision is copied on the web
/// (public/chat-rate-limit.js) and here. The two copies once disagreed on the
/// 借道 (borrowed provider) branch; the symptom was a bar that showed on the
/// phone and not in the browser, which no test on either side could see because
/// the two functions did not even have the same shape.
///
/// They now answer to one table: tests/fixtures/quota-gating-golden.json,
/// regenerated from the web module (the authority) by
/// scripts/generate-quota-gating-fixture.js and asserted on the node side by
/// tests/test-quota-gating-parity.js. This file re-runs the same cells through
/// the Dart mirror, so a rule that lands on one end and not the other fails
/// here with the exact cell named.
Map<String, dynamic> _loadFixture() {
  for (final candidate in [
    'tests/fixtures/quota-gating-golden.json',
    '../tests/fixtures/quota-gating-golden.json',
  ]) {
    final file = File(candidate);
    if (file.existsSync()) {
      return jsonDecode(file.readAsStringSync()) as Map<String, dynamic>;
    }
  }
  throw StateError('quota-gating-golden.json not found relative to CWD');
}

void main() {
  final fixture = _loadFixture();
  final clis = (fixture['clis'] as List).cast<String>();
  final windowKinds = (fixture['windowKinds'] as List).cast<String>();
  final baseUrls = (fixture['baseUrls'] as List).cast<Map<String, dynamic>>();
  final matches = (fixture['providerMatchesCliIn'] as Map).cast<String, dynamic>();
  final visible = (fixture['balanceBarVisibleFor'] as Map).cast<String, dynamic>();
  final traits = (fixture['baseUrlTraits'] as Map).cast<String, dynamic>();

  test('the fixture covers the whole table', () {
    expect(clis, isNotEmpty);
    expect(windowKinds.length, greaterThanOrEqualTo(4));
    expect(baseUrls.length, greaterThanOrEqualTo(20),
        reason: 'the baseUrl axis is where every host-confusion trap lives');
    expect(matches.length, windowKinds.length * baseUrls.length);
    expect(traits.length, baseUrls.length);
  });

  test('providerMatchesCli matches every cell of the fixture', () {
    final drift = <String>[];
    for (final kind in windowKinds) {
      for (final entry in baseUrls) {
        final label = entry['label'] as String;
        final url = entry['url'] as String?;
        final expected = (matches['$kind@$label'] as List).cast<String>();
        final actual =
            clis.where((cli) => providerMatchesCli(kind, cli, url)).toList();
        if (expected.join(',') != actual.join(',')) {
          drift.add('$kind@$label: fixture [${expected.join(',')}] vs app [${actual.join(',')}]');
        }
      }
    }
    expect(drift, isEmpty,
        reason: 'app/lib/models/vendor_quota.dart drifted from the web gate:\n${drift.join('\n')}');
  });

  test('balanceBarVisibleFor matches every cell of the fixture', () {
    final drift = <String>[];
    for (final entry in baseUrls) {
      final label = entry['label'] as String;
      final url = entry['url'] as String?;
      final expected = (visible[label] as List).cast<String>();
      final actual =
          clis.where((cli) => balanceBarVisibleFor(cli, url)).toList();
      if (expected.join(',') != actual.join(',')) {
        drift.add('$label: fixture [${expected.join(',')}] vs app [${actual.join(',')}]');
      }
    }
    expect(drift, isEmpty,
        reason: 'app/lib/models/vendor_quota.dart drifted from the web gate:\n${drift.join('\n')}');
  });

  test('baseUrl traits match every cell of the fixture', () {
    final drift = <String>[];
    for (final entry in baseUrls) {
      final label = entry['label'] as String;
      final url = entry['url'] as String?;
      final expected = (traits[label] as Map).cast<String, dynamic>();
      final actual = <String, dynamic>{
        'host': hostFromBaseUrl(url),
        'ark': isArkBaseUrl(url),
        'zhipu': isZhipuBaseUrl(url),
        'kimi': isKimiBaseUrl(url),
        'deepseek': isDeepseekBaseUrl(url),
        'claudeProvider': isClaudeProviderBaseUrl(url),
        'relayProtocol': relayProtocolFromBaseUrl(url),
        'arkPlan': arkPlanFromBaseUrl(url),
      };
      for (final key in expected.keys) {
        if (jsonEncode(expected[key]) != jsonEncode(actual[key])) {
          drift.add('$label.$key: fixture ${jsonEncode(expected[key])} vs app ${jsonEncode(actual[key])}');
        }
      }
    }
    expect(drift, isEmpty,
        reason: 'app/lib/models/vendor_quota.dart drifted from the web gate:\n${drift.join('\n')}');
  });
}
