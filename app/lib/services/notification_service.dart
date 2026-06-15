import 'package:flutter_local_notifications/flutter_local_notifications.dart';

class NotificationService {
  static final _plugin = FlutterLocalNotificationsPlugin();
  static bool _initialized = false;

  /// Last time a notification fired for each id — used to de-dup the same
  /// verdict arriving over both the chat socket and the workspace socket.
  static final Map<int, DateTime> _recent = {};
  static const _dedupWindow = Duration(seconds: 6);

  static Future<void> init() async {
    if (_initialized) return;
    _initialized = true;

    await _plugin.initialize(
      settings: const InitializationSettings(
        android: AndroidInitializationSettings('@mipmap/ic_launcher'),
        // iOS was previously unconfigured, so notifications never surfaced on
        // iPhone at all. Darwin settings request the permission prompt on first
        // init and allow alerts/sound while the app is foregrounded.
        iOS: DarwinInitializationSettings(
          requestAlertPermission: true,
          requestBadgePermission: true,
          requestSoundPermission: true,
        ),
      ),
    );

    // Android 13+ requires an explicit runtime permission request; the Darwin
    // settings above already cover iOS.
    await _plugin
        .resolvePlatformSpecificImplementation<
          AndroidFlutterLocalNotificationsPlugin
        >()
        ?.requestNotificationsPermission();
  }

  static Future<void> show({
    required String title,
    required String body,
    int id = 0,
  }) async {
    final now = DateTime.now();
    final last = _recent[id];
    if (last != null && now.difference(last) < _dedupWindow) return;
    _recent[id] = now;

    const android = AndroidNotificationDetails(
      'multicc_tasks',
      'Task Notifications',
      channelDescription: 'MultiCC task completion and status notifications',
      importance: Importance.high,
      priority: Priority.high,
      playSound: true,
    );
    const ios = DarwinNotificationDetails(
      presentAlert: true,
      presentBadge: true,
      presentSound: true,
    );
    await _plugin.show(
      id: id,
      title: title,
      body: body,
      notificationDetails: const NotificationDetails(android: android, iOS: ios),
    );
  }
}
