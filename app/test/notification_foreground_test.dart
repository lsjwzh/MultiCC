import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/services/notification_service.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const channel = MethodChannel('dexterous.com/flutter/local_notifications');
  final calls = <MethodCall>[];
  late SettingsService settings;
  var failShow = false;

  setUpAll(() async {
    SharedPreferences.setMockInitialValues({});
    settings = await SettingsService.getInstance();
    await I18n.init('zh');
    debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
    IOSFlutterLocalNotificationsPlugin.registerWith();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
          calls.add(call);
          if (call.method == 'show' && failShow) {
            throw PlatformException(code: 'unavailable');
          }
          return call.method == 'initialize' ? true : null;
        });
    await NotificationService.init();
    debugDefaultTargetPlatformOverride = null;
  });

  setUp(() async {
    calls.clear();
    failShow = false;
    debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
    await settings.save(notificationsEnabled: true);
    await settings.setTaskNotifyEnabled('foreground', true);
  });

  tearDown(() => debugDefaultTargetPlatformOverride = null);
  tearDownAll(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
  });

  bool allowed({bool active = true, bool background = false}) =>
      NotificationService.shouldNotifySession(
        sessionId: 'foreground',
        isActive: active,
        isInBackground: background,
      );

  test(
    'iOS alerts for the visible conversation, other sessions and background',
    () {
      expect(allowed(), isTrue);
      expect(allowed(active: false), isTrue);
      expect(allowed(background: true), isTrue);
    },
  );

  test('Android retains suppression of the visible conversation', () {
    debugDefaultTargetPlatformOverride = TargetPlatform.android;
    expect(allowed(), isFalse);
    expect(allowed(active: false), isTrue);
    expect(allowed(background: true), isTrue);
  });

  test(
    'global and per-session mute apply in foreground and background',
    () async {
      await settings.save(notificationsEnabled: false);
      expect(allowed(), isFalse);
      expect(allowed(active: false), isFalse);
      expect(allowed(background: true), isFalse);
      await settings.save(notificationsEnabled: true);
      await settings.setTaskNotifyEnabled('foreground', false);
      expect(allowed(), isFalse);
      expect(allowed(background: true), isFalse);
    },
  );

  test(
    'iOS channel receives banner, sound and session tap payload once',
    () async {
      for (var source = 0; source < 2; source++) {
        await NotificationService.show(
          id: 7101,
          title: '需要交互',
          body: '请选择方案',
          payload: 'foreground',
        );
      }
      final shows = calls.where((c) => c.method == 'show').toList();
      expect(
        shows,
        hasLength(1),
        reason: 'chat/workspace delivery must deduplicate',
      );
      final args = shows.single.arguments as Map;
      expect(args['payload'], 'foreground');
      final ios = args['platformSpecifics'] as Map;
      expect(ios['presentAlert'], isTrue);
      expect(ios['presentBanner'], isTrue);
      expect(ios['presentList'], isTrue);
      expect(ios['presentSound'], isTrue);
    },
  );

  test('failed native delivery is contained and allows retry', () async {
    failShow = true;
    await NotificationService.show(id: 7102, title: '完成', body: '任务完成');
    failShow = false;
    await NotificationService.show(id: 7102, title: '完成', body: '任务完成');
    expect(calls.where((c) => c.method == 'show'), hasLength(2));
  });
}
