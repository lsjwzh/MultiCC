import 'package:flutter_test/flutter_test.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// 会话级「任务提醒」偏好必须和 Web 页头那颗 `#notify-btn` 是同一份语义 ——
/// 同一个 key 名、同一个取值域、同一个默认值，关掉只影响这一个会话。
/// Web 出处：public/pwa.js 的 taskNotifyKey / getTaskNotifyEnabled /
/// setTaskNotifyEnabled（`multicc_notify:<sessionId>`，'on' / 'off'，缺省为开）。
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  // 一个 test 里跑完全部断言：SettingsService 是单例，第二次
  // setMockInitialValues 不会再作用到已经建好的实例上。
  test('会话级提醒偏好 = Web 的 multicc_notify:<sessionId>（on/off，缺省开）', () async {
    SharedPreferences.setMockInitialValues({
      'multicc_host': 'http://127.0.0.1:3000',
    });
    final settings = await SettingsService.getInstance();
    final prefs = await SharedPreferences.getInstance();

    // 没记录过的会话默认开着。
    expect(settings.taskNotifyEnabled('s-new'), isTrue);

    // 关掉一个会话：key / 取值域都跟 Web 一致，隔壁会话不受影响。
    await settings.setTaskNotifyEnabled('s-a', false);
    expect(prefs.getString('multicc_notify:s-a'), 'off');
    expect(settings.taskNotifyEnabled('s-a'), isFalse);
    expect(settings.taskNotifyEnabled('s-b'), isTrue);

    // 再打开。
    await settings.setTaskNotifyEnabled('s-a', true);
    expect(prefs.getString('multicc_notify:s-a'), 'on');
    expect(settings.taskNotifyEnabled('s-a'), isTrue);
    // 会话 id 为空时回落到 Web 的 legacy 全局键 multicc_notify。
    await prefs.setString('multicc_notify', 'off');
    expect(settings.taskNotifyEnabled(''), isFalse);
    await prefs.setString('multicc_notify', 'on');
    expect(settings.taskNotifyEnabled(''), isTrue);
  });
}
