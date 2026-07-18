import 'package:flutter_test/flutter_test.dart';

import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/utils/session_status_helpers.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() => I18n.init('zh'));

  tearDown(() => I18n.switchLang('zh'));

  test('switches catalogs and interpolates named parameters', () {
    I18n.switchLang('zh');
    expect(t('minutesAgo', {'n': '3'}), '3 分钟前');

    I18n.switchLang('en');
    expect(t('minutesAgo', {'n': '3'}), '3m ago');
    expect(t('syncSuccess', {'base': 'main', 'n': '2'}),
        '✓ Synced 2 commits from main');
  });

  test('relative time follows the active language', () {
    final now = DateTime(2026, 7, 18, 12);
    final value = now.subtract(const Duration(hours: 2));

    I18n.switchLang('zh');
    expect(formatRelativeTime(value, now: now), '2 小时前');

    I18n.switchLang('en');
    expect(formatRelativeTime(value, now: now), '2h ago');
  });

  test('run duration uses localized units', () {
    const value = Duration(minutes: 3, seconds: 4);

    I18n.switchLang('zh');
    expect(formatRunDuration(value), '3分04秒');

    I18n.switchLang('en');
    expect(formatRunDuration(value), '3m 04s');
  });
}
