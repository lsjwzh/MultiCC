import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/screens/settings_screen.dart';
import 'package:multicc_app/services/settings_service.dart';

// 「更多连接方式」以前要 设置 → 开高级模式 → 管理 → 线路 → 滚到页底 → 展开
// 才够得到。跨设备共享和 ZCode/Kimi 登录本身就是独立向导，所以入口必须
// 在默认（基础）模式的设置页首屏就能点到。这条测试守住「别再把它们藏回去」。

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(() => I18n.init('zh'));

  testWidgets('connection entries stay above the fold in basic mode', (
    tester,
  ) async {
    SharedPreferences.setMockInitialValues({
      'multicc_host': 'http://server.example',
      'multicc_token': 'secret',
    });
    final settings = await SettingsService.getInstance();
    await tester.pumpWidget(
      MaterialApp(home: SettingsScreen(settings: settings)),
    );
    await tester.pumpAndSettle();

    final device = find.text(t('connectionDeviceTitle'));
    final native = find.text(t('connectionNativeTitle'));
    expect(device, findsOneWidget, reason: '设置页要有「连接或共享另一台设备」');
    expect(native, findsOneWidget, reason: '设置页要有「单独登录 ZCode / Kimi」');
    expect(
      tester.getTopLeft(device).dy,
      lessThan(600),
      reason: '入口要在首屏，不能只出现在高级模式的管理分组里',
    );
    expect(
      tester.getTopLeft(native).dy,
      lessThan(600),
      reason: '入口要在首屏，不能只出现在高级模式的管理分组里',
    );
  });
}
