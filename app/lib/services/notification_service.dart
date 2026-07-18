import 'package:flutter_local_notifications/flutter_local_notifications.dart';

import '../i18n.dart';

class NotificationService {
  static final _plugin = FlutterLocalNotificationsPlugin();
  static bool _initialized = false;

  /// Whether to request iOS notification permission at init. Defaults to true;
  /// set `--dart-define=SKIP_NOTIF_PROMPT=true` to suppress the launch-time
  /// permission alert (used for automated simulator runs).
  static const bool _requestNotifPermission =
      !bool.fromEnvironment('SKIP_NOTIF_PROMPT');

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

    // Skip the entire notification init for builds run with
    // `--dart-define=SKIP_NOTIF_PROMPT=true` (automated sim runs where the
    // iOS permission alert can't be tapped). Default builds initialize normally.
    if (const bool.fromEnvironment('SKIP_NOTIF_PROMPT')) return;

    // On iOS simulators, DarwinInitializationSettings with permission requests
    // can hang indefinitely because the simulator doesn't have a real
    // notification service.  Wrap the whole init in a timeout so the app doesn't
    // black-screen on startup.
    try {
      await _plugin
          .initialize(
            settings: InitializationSettings(
              android: const AndroidInitializationSettings('@mipmap/ic_launcher'),
              iOS: DarwinInitializationSettings(
                requestAlertPermission: _requestNotifPermission,
                requestBadgePermission: _requestNotifPermission,
                requestSoundPermission: _requestNotifPermission,
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

    final android = AndroidNotificationDetails(
      'multicc_tasks',
      t('taskNotifications'),
      channelDescription: t('taskNotificationsDescription'),
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
      notificationDetails: NotificationDetails(android: android, iOS: ios),
      payload: payload,
    );
  }
}
