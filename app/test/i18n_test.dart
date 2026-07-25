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
    expect(
      t('syncSuccess', {'base': 'main', 'n': '2'}),
      '✓ Synced 2 commits from main',
    );
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

  test('chat runtime queue and pending-input copy is bilingual', () {
    I18n.switchLang('zh');
    expect(t('queuedMessageCount', {'n': '2'}), '暂存消息 2');
    expect(t('pendingInputTitle'), '等待你的回答');

    I18n.switchLang('en');
    expect(t('queuedMessageCount', {'n': '2'}), '2 queued messages');
    expect(t('confirmQueueChangeBody'), contains('FIFO'));
  });

  test('legacy classify C degrades to waiting instead of auto-continue', () {
    I18n.switchLang('zh');
    final legacy = classifyBadge('C');
    final waiting = classifyBadge('W');
    expect(legacy?.label, waiting?.label);
    expect(legacy?.emoji, waiting?.emoji);
  });
}
