import 'package:flutter_test/flutter_test.dart';
import 'package:multicc_app/services/notification_service.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/widgets/chat_header.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// ⋯ 菜单里「任务提醒」的点击语义，必须和 Web 页头那颗 `#notify-btn` 的
/// toggle() 一致（public/chat-notifications.js:96-125）：
///
///   * 已在开启态、且系统通知在授权态 → 只是关闭；
///   * 其余情况 → 先打开，再去申请系统通知权限（Web 是 ensurePushSubscribed()
///     → Notification.requestPermission()，public/pwa.js:195 / 224）；
///   * 申请失败 → 把开关回滚成关闭（同文件 112-117 行 `if (!ok) { enabled =
///     false; persistPreference(false); }`）。
///
/// 这里直接驱动 chat_header 的 toggleTaskNotifyWithPermission()，权限申请换成
/// NotificationService 的注入点 —— 全程不碰平台通道。
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
    NotificationService.debugPermissionRequester = null;
    NotificationService.debugSetPermissionGranted(false);
  });

  tearDown(() {
    NotificationService.debugPermissionRequester = null;
    NotificationService.debugSetPermissionGranted(false);
  });

  test('已开启且系统通知已授权：点击只是关闭，不再申请权限', () async {
    final settings = await SettingsService.getInstance();
    var requested = 0;
    NotificationService.debugPermissionRequester = () async {
      requested++;
      return true;
    };
    NotificationService.debugSetPermissionGranted(true);
    await settings.setTaskNotifyEnabled('p-on-granted', true);

    final result = await toggleTaskNotifyWithPermission(
      settings: settings,
      sessionId: 'p-on-granted',
    );

    expect(result, TaskNotifyToggleResult.off);
    expect(settings.taskNotifyEnabled('p-on-granted'), isFalse);
    expect(requested, 0);
  });

  test('开着但系统通知还没授权：点击照样去申请，授权到手后停在开启态', () async {
    final settings = await SettingsService.getInstance();
    var requested = 0;
    NotificationService.debugPermissionRequester = () async {
      requested++;
      return true;
    };
    // 新会话的默认就是这一档：偏好开着（缺省 'on'），系统通知还没授权。
    expect(settings.taskNotifyEnabled('p-on-nopush'), isTrue);

    final result = await toggleTaskNotifyWithPermission(
      settings: settings,
      sessionId: 'p-on-nopush',
    );

    expect(requested, 1);
    expect(result, TaskNotifyToggleResult.on);
    expect(settings.taskNotifyEnabled('p-on-nopush'), isTrue);
  });

  test('已关闭：点击先打开再申请权限，授权成功就留在开启态', () async {
    final settings = await SettingsService.getInstance();
    var requested = 0;
    NotificationService.debugPermissionRequester = () async {
      requested++;
      return true;
    };
    await settings.setTaskNotifyEnabled('p-off', false);

    final result = await toggleTaskNotifyWithPermission(
      settings: settings,
      sessionId: 'p-off',
    );

    expect(requested, 1);
    expect(result, TaskNotifyToggleResult.on);
    expect(settings.taskNotifyEnabled('p-off'), isTrue);
  });

  test('系统通知被拒：开关回滚成关闭（Web 的 if (!ok) → persistPreference(false)）', () async {
    final settings = await SettingsService.getInstance();
    var requested = 0;
    NotificationService.debugPermissionRequester = () async {
      requested++;
      return false;
    };
    await settings.setTaskNotifyEnabled('p-denied', true);

    final result = await toggleTaskNotifyWithPermission(
      settings: settings,
      sessionId: 'p-denied',
    );

    expect(requested, 1);
    expect(result, TaskNotifyToggleResult.denied);
    expect(settings.taskNotifyEnabled('p-denied'), isFalse);
  });

  test('权限缓存已授权时 ensurePermission 短路，不再走申请链路', () async {
    var requested = 0;
    NotificationService.debugPermissionRequester = () async {
      requested++;
      return true;
    };
    NotificationService.debugSetPermissionGranted(true);

    expect(await NotificationService.ensurePermission(), isTrue);
    expect(requested, 0);

    // 缓存说没授权时才真的去申请，并把结果灌回缓存（菜单 itemBuilder 同步读它）。
    NotificationService.debugSetPermissionGranted(false);
    expect(await NotificationService.ensurePermission(), isTrue);
    expect(requested, 1);
    expect(NotificationService.permissionGranted, isTrue);
  });
}
