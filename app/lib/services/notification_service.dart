import 'package:flutter_local_notifications/flutter_local_notifications.dart';

class NotificationService {
  static final _plugin = FlutterLocalNotificationsPlugin();
  static bool _initialized = false;

  /// Last time a notification fired for each id — used to de-dup the same
  /// verdict arriving over both the chat socket and the workspace socket.
  static final Map<int, DateTime> _recent = {};
  static const _dedupWindow = Duration(seconds: 6);

  /// Invoked with a session id when the user taps a notification. Wired by
  /// [SessionManager] via [setSelectHandler] once it can route to a session.
  static void Function(String sessionId)? _onSelectSession;

  /// A payload captured before [_onSelectSession] was wired — e.g. a cold
  /// start where the app was launched by tapping a notification. Flushed once
  /// the handler is set.
  static String? _pendingPayload;

  static Future<void> init() async {
    if (_initialized) return;
    _initialized = true;

    // On iOS simulators, DarwinInitializationSettings with permission requests
    // can hang indefinitely because the simulator doesn't have a real
    // notification service.  Wrap the whole init in a timeout so the app doesn't
    // black-screen on startup.
    try {
      await _plugin
          .initialize(
            settings: const InitializationSettings(
              android: AndroidInitializationSettings('@mipmap/ic_launcher'),
              iOS: DarwinInitializationSettings(
                requestAlertPermission: true,
                requestBadgePermission: true,
                requestSoundPermission: true,
              ),
            ),
            onDidReceiveNotificationResponse: _onResponse,
          )
          .timeout(const Duration(seconds: 5));
    } catch (_) {
      // init timed out or threw — the app is still usable without local
      // notifications, so don't crash.  The plugin's _initialized flag stays
      // true so callers don't try to re-init and hit the same hang.
    }

    // Android 13+ requires an explicit runtime permission request; the Darwin
    // settings above already cover iOS.
    try {
      await _plugin
          .resolvePlatformSpecificImplementation<
            AndroidFlutterLocalNotificationsPlugin
          >()
          ?.requestNotificationsPermission();
    } catch (_) {}

    // Cold start: the app may have been launched by tapping a notification
    // while it was fully terminated. The tap doesn't fire the callback above,
    // so recover the payload here and hold it until the router is wired.
    try {
      final launch = await _plugin.getNotificationAppLaunchDetails();
      final p = launch?.notificationResponse?.payload;
      if (launch?.didNotificationLaunchApp == true &&
          p != null &&
          p.isNotEmpty) {
        _pendingPayload = p;
      }
    } catch (_) {}
  }

  static void _onResponse(NotificationResponse resp) {
    final p = resp.payload;
    if (p == null || p.isEmpty) return;
    final cb = _onSelectSession;
    if (cb != null) {
      cb(p);
    } else {
      _pendingPayload = p; // router not ready yet — flush when it arrives
    }
  }

  /// Register the session router and immediately flush any payload captured
  /// before it was ready (cold start / very early tap).
  static void setSelectHandler(void Function(String sessionId) handler) {
    _onSelectSession = handler;
    final pending = _pendingPayload;
    if (pending != null && pending.isNotEmpty) {
      _pendingPayload = null;
      handler(pending);
    }
  }

  static Future<void> show({
    required String title,
    required String body,
    int id = 0,
    String? payload,
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
      payload: payload,
    );
  }
}
