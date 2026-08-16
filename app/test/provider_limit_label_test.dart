import 'package:flutter_test/flutter_test.dart';

import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/models/provider_limit_label.dart';

/// Deterministic coverage for the app-side provider-limit label. The same
/// semantics as the web picker (public/chat-ai-config.js providerLimitLabel):
/// summary + freshness, with lastError/stale markers riding on top; a missing
/// cache entry reads exactly like the pre-cache option ('' — clean absence).
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() => I18n.init('zh'));

  tearDown(() => I18n.switchLang('zh'));

  final now = 1_000_000;
  Map<String, dynamic> provider(Map<String, dynamic> limit) =>
      {'id': 'p1', 'name': 'GLM', 'limit': limit};

  test('no cache entry is a clean absence', () {
    expect(providerLimitLabel(null, nowMs: now), '');
    expect(providerLimitLabel(const {}, nowMs: now), '');
    expect(providerLimitLabel({'limit': null}, nowMs: now), '');
    expect(providerLimitLabel(const {'id': 'p1', 'name': 'GLM'}, nowMs: now),
        '');
  });

  test('summary only, and stale without a summary means nothing to age', () {
    expect(providerLimitLabel(provider({'summaryText': '5h 80%'}), nowMs: now),
        ' · 5h 80%');
    expect(providerLimitLabel(provider({'stale': true}), nowMs: now), '');
  });

  test('fresh entry shows a relative updated time (20s ago)', () {
    expect(
      providerLimitLabel(
        provider({
          'summaryText': '5h 80%',
          'fetchedAt': now - 20_000,
          'stale': false,
        }),
        nowMs: now,
      ),
      ' · 5h 80% · 更新于 20 秒前',
    );
  });

  test('last fetch failed keeps the cached summary but drops the age', () {
    expect(
      providerLimitLabel(
        provider({
          'summaryText': '5h 80%',
          'fetchedAt': now - 20_000,
          'lastError': 'boom',
        }),
        nowMs: now,
      ),
      ' · 5h 80% · 查询失败',
    );
  });

  test('stale marker rides on a summary alongside the age', () {
    expect(
      providerLimitLabel(
        provider({
          'summaryText': '5h 80%',
          'fetchedAt': now - 20_000,
          'stale': true,
        }),
        nowMs: now,
      ),
      ' · 5h 80% · 更新于 20 秒前 · 过期',
    );
  });

  test('failure without any cached summary still says so', () {
    expect(providerLimitLabel(provider({'lastError': 'boom'}), nowMs: now),
        ' · 查询失败');
  });

  test('english catalog phrases the same states', () {
    I18n.switchLang('en');
    expect(
      providerLimitLabel(
        provider({
          'summaryText': '5h 80%',
          'fetchedAt': now - 20_000,
          'stale': true,
          'lastError': 'boom',
        }),
        nowMs: now,
      ),
      ' · 5h 80% · fetch failed · stale',
    );
    expect(
      providerLimitLabel(provider({'summaryText': '5h 80%'}), nowMs: now),
      ' · 5h 80%',
    );
  });

  test('limitAgoText coarsens through the localized units', () {
    expect(limitAgoText(now - 3_000, now), '刚刚');
    expect(limitAgoText(now - 20_000, now), '20 秒前');
    expect(limitAgoText(now - 3 * 60_000, now), '3 分钟前');
    expect(limitAgoText(now - 2 * 3_600_000, now), '2 小时前');
    expect(limitAgoText(now - 50 * 3_600_000, now), '2 天前');
    // future timestamps clamp to just-now
    expect(limitAgoText(now + 30_000, now), '刚刚');

    I18n.switchLang('en');
    expect(limitAgoText(now - 20_000, now), '20s ago');
    expect(limitAgoText(now - 2 * 3_600_000, now), '2h ago');
  });
}
