import 'package:flutter_test/flutter_test.dart';

import 'package:multicc_app/models/message.dart';
import 'package:multicc_app/models/role_tokens.dart';

/// role_token_stats parsing + attach contract (web buildUsageLine
/// roleBreakdown parity). Payload shape from src/role-token-tracker.js:
///   { type, role: { main: {…}, sub: {…}|null, subByProvider: […] } }
void main() {
  Map<String, dynamic> event({
    Map<String, dynamic>? sub,
    List<Map<String, dynamic>> byProvider = const [],
  }) =>
      {
        'type': 'role_token_stats',
        'role': {
          'main': {
            'inputTokens': 1000,
            'outputTokens': 200,
            'cacheWrite': 50,
            'cacheRead': 5000,
          },
          'sub': sub,
          'subByProvider': byProvider,
        },
      };

  test('parses main / sub / subByProvider buckets', () {
    final breakdown = RoleTokenBreakdown.fromEvent(event(
      sub: {
        'inputTokens': 100,
        'outputTokens': 300,
        'cacheWrite': 10,
        'cacheRead': 700,
      },
      byProvider: [
        {
          'providerId': 'xf',
          'name': '讯飞',
          'model': 'ds4',
          'inputTokens': 100,
          'outputTokens': 300,
          'cacheWrite': 10,
          'cacheRead': 700,
        },
      ],
    ));

    expect(breakdown, isNotNull);
    expect(breakdown!.main.inputTokens, 1000);
    expect(breakdown.main.cacheRead, 5000);
    expect(breakdown.sub?.outputTokens, 300);
    expect(breakdown.subByProvider, hasLength(1));
    expect(breakdown.subByProvider.first.label, '讯飞');
    expect(breakdown.subByProvider.first.model, 'ds4');
    expect(breakdown.subByProvider.first.bucket.total, 1110);
  });

  test('sub null and missing numbers degrade to zeros, not crashes', () {
    final breakdown = RoleTokenBreakdown.fromEvent(event(sub: null));
    expect(breakdown, isNotNull);
    expect(breakdown!.sub, isNull);
    expect(breakdown.savedMainTokens, 0);
    expect(breakdown.subByProvider, isEmpty);
  });

  test('event without a role payload parses to null', () {
    expect(RoleTokenBreakdown.fromEvent({'type': 'role_token_stats'}), isNull);
    expect(
      RoleTokenBreakdown.fromEvent({'type': 'role_token_stats', 'role': 42}),
      isNull,
    );
  });

  test('savedMainTokens = sub in+out+cacheWrite+cacheRead (省主 badge)', () {
    final breakdown = RoleTokenBreakdown.fromEvent(event(sub: {
      'inputTokens': 1000,
      'outputTokens': 2000,
      'cacheWrite': 300,
      'cacheRead': 700,
    }));
    expect(breakdown!.savedMainTokens, 4000);
  });

  test('provider label falls back to providerId when name is absent', () {
    final breakdown = RoleTokenBreakdown.fromEvent(event(byProvider: [
      {'providerId': 'volcano'},
    ]));
    expect(breakdown!.subByProvider.first.label, 'volcano');
  });

  test('MessageUsage.roleBreakdown carries the split without affecting totals',
      () {
    final usage = MessageUsage(
      inputTokens: 10,
      outputTokens: 20,
      roleBreakdown: RoleTokenBreakdown.fromEvent(event(sub: {
        'inputTokens': 1,
        'outputTokens': 2,
      })),
    );
    expect(usage.roleBreakdown?.sub?.inputTokens, 1);
    // The badge totals stay the raw usage numbers.
    expect(usage.inputTokens, 10);
    expect(usage.total, 30);
  });

  test('history-built messages have no breakdown (no stale data on replay)', () {
    final fromHistory = ChatMessage.fromHistory({
      'role': 'assistant',
      'content': [{'type': 'text', 'text': 'done'}],
      'usage': {'input_tokens': 5, 'output_tokens': 6},
    });
    final usage = fromHistory.usage;
    if (usage != null) {
      expect(usage.roleBreakdown, isNull);
    }
  });
}
