import 'dart:async';

import 'package:flutter/foundation.dart' show visibleForTesting;
import 'package:flutter_local_notifications/flutter_local_notifications.dart';

import '../i18n.dart';

class NotificationService {
  static final _plugin = FlutterLocalNotificationsPlugin();
  static bool _initialized = false;

  /// Whether the notification permission alert may be shown. Defaults to true;
  /// set `--dart-define=SKIP_NOTIF_PROMPT=true` to suppress it (used for
  /// automated simulator runs).
  static const bool _promptForPermission =
      !bool.fromEnvironment('SKIP_NOTIF_PROMPT');

  /// 系统通知权限的**同步**缓存。
  ///
  /// 由来：⋯ 菜单里的「任务提醒」要按 Web `#notify-btn` 的三态显示
  /// （public/chat-notifications.js:78-86 的 updateButton() 把状态写进 `title`），
  /// 而 `itemBuilder` 是同步的、平台的 `checkPermissions()` /
  /// `areNotificationsEnabled()` 却是异步的 —— 菜单不可能为了一次查询卡住一帧。
  /// 所以这里维护一份「最近一次查到的权限状态」，代价是它可能比真实状态旧一拍
  /// （用户在系统设置里改过权限后，第一次展开菜单仍显示旧值），由
  /// [refreshPermissionCache] 每次展开菜单时 fire-and-forget 地补上。
  ///
  /// 默认 false：Web 那边 `getPushInfo().subscribed` 在用户订阅之前就是 false
  /// （public/pwa.js:367 的 isPushSubscribed），所以「开着但还没授权」的三态文案
  /// 默认落在「点击开启系统通知」这一档，跟 Web 首屏一致。
  static bool _permissionGranted = false;

  static bool get permissionGranted => _permissionGranted;

  /// 测试注入点：替换真实的系统权限申请链路。非 null 时 [ensurePermission] 与
  /// [refreshPermissionCache] 都只走它，绝不碰平台通道。
  @visibleForTesting
  static Future<bool> Function()? debugPermissionRequester;

  /// 测试注入点：直接写缓存，省掉一次平台查询（三态文案的 widget 测试用）。
  @visibleForTesting
  static void debugSetPermissionGranted(bool granted) {
    _permissionGranted = granted;
  }

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
              iOS: const DarwinInitializationSettings(
                // Deliberately not requested here. The iOS authorization alert
                // is presented before the Flutter view has drawn its first
                // frame, so a cold start sits on the launch screen — looking
                // exactly like a hang — until somebody answers it.
                // [requestPermissions] only asks when the user turns task
                // reminders on from the chat header's ⋯ menu.
                requestAlertPermission: false,
                requestBadgePermission: false,
                requestSoundPermission: false,
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

    // 顺手把权限缓存热起来：只靠菜单展开时刷新的话，用户第一次展开看到的会是
    // 默认值 —— 明明早就授权过，却显示「点击开启系统通知」。fire-and-forget，
    // 且和上面的 initialize 一样套超时：iOS 模拟器的通知通道可能整个卡住，而
    // 这段代码跑在第一帧之前，不能让它拖住启动。
    unawaited(
      refreshPermissionCache().timeout(
        const Duration(seconds: 5),
        onTimeout: () {},
      ),
    );
  }

  /// Ask the user for notification permission, once the app is on screen.
  ///
  /// Split out of [init] rather than folded into it: `initialize()` is the only
  /// call that can raise the iOS authorization alert, and that alert goes up
  /// before the Flutter view's first frame — so asking there freezes a cold
  /// start on the launch screen until a human answers.
  ///
  /// 现在只有一处调用方：⋯ 菜单里用户主动打开「任务提醒」时（chat_header 的
  /// toggleTaskNotifyWithPermission → [ensurePermission]）。Web 也是同一个触发
  /// 条件 —— 授权弹窗来自 `#notify-btn` 的 toggle() → `ensurePushSubscribed()`
  /// → `Notification.requestPermission()`（public/pwa.js:224），页面加载本身
  /// 从不弹窗。App 此前在冷启动的 post-frame 无条件弹一次，跟 Web 不一致，已经
  /// 去掉（见 main.dart）。
  static Future<void> requestPermissions() async {
    if (!_promptForPermission) return;
    bool? granted;
    try {
      final ios = await _plugin
          .resolvePlatformSpecificImplementation<
            IOSFlutterLocalNotificationsPlugin
          >()
          ?.requestPermissions(alert: true, badge: true, sound: true);
      if (ios != null) granted = ios;
    } catch (_) {}
    // Android 13+ needs its own explicit runtime request.
    try {
      final android = await _plugin
          .resolvePlatformSpecificImplementation<
            AndroidFlutterLocalNotificationsPlugin
          >()
          ?.requestNotificationsPermission();
      if (android != null) granted = android;
    } catch (_) {}
    // 申请结果就是最新的权限状态，顺手灌进同步缓存，下次展开菜单即读到。
    if (granted != null) {
      _permissionGranted = granted;
    } else {
      // 平台没给结果（没有对应实现 / 通道不可用）：退回一次查询，别据此判定
      // 「被拒」—— 那会把用户已经开好的权限在 UI 上抹掉。
      await refreshPermissionCache();
    }
  }

  /// 申请系统通知权限（若还没有），返回「现在是否已授权」。
  ///
  /// 对齐 Web `#notify-btn` 的打开分支：toggle() 先本地置为开启，再
  /// `ensurePushSubscribed()`（public/chat-notifications.js:112 → public/pwa.js:195），
  /// 里面第一件事就是 `Notification.requestPermission()`；被拒则 `return false`，
  /// 调用方把开关回滚成关闭。这里返回同一个布尔。
  static Future<bool> ensurePermission() async {
    // 已经是授权态就不用再问 —— 重复申请不会有第二次弹窗，但能省一次异步等待。
    if (_permissionGranted) return true;
    // SKIP_NOTIF_PROMPT=true 的自动化巡游构建：系统弹窗没人点，一次都不弹，
    // 直接返回当前缓存值（Web 在浏览器不支持推送时同样只是 `return false`，
    // public/pwa.js:214-217）。
    if (!_promptForPermission) return _permissionGranted;
    final injected = debugPermissionRequester;
    if (injected != null) {
      _permissionGranted = await injected();
      return _permissionGranted;
    }
    await requestPermissions();
    return _permissionGranted;
  }

  /// 重新读一遍平台的权限状态，刷新同步缓存 [permissionGranted]。
  ///
  /// 调用方 fire-and-forget 即可（chat_header 在菜单展开时调一次）：查到的状态
  /// 会让**下一次**展开的菜单变准，这一次已经渲染出去的那份标签仍然是旧值 ——
  /// 这就是同步缓存换来的取舍。
  static Future<void> refreshPermissionCache() async {
    if (!_promptForPermission) return;
    // 测试注入了 fake 时权限状态归 fake 管，别让真实查询把它盖回去。
    if (debugPermissionRequester != null) return;
    bool? granted;
    try {
      final ios = await _plugin
          .resolvePlatformSpecificImplementation<
            IOSFlutterLocalNotificationsPlugin
          >()
          ?.checkPermissions();
      if (ios != null) granted = ios.isEnabled;
    } catch (_) {}
    try {
      // Android 没有 checkPermissions()，等价的查询是 areNotificationsEnabled()
      // （插件 20.x；Android 13+ 返回 POST_NOTIFICATIONS 的授权状态）。
      final android = await _plugin
          .resolvePlatformSpecificImplementation<
            AndroidFlutterLocalNotificationsPlugin
          >()
          ?.areNotificationsEnabled();
      if (android != null) granted = android;
    } catch (_) {}
    // 查询失败或平台无实现（null）时保留旧值，别把 UI 误判成「未授权」。
    if (granted != null) _permissionGranted = granted;
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
