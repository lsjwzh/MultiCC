import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/screens/settings_screen.dart';
import 'package:multicc_app/services/settings_service.dart';

// 保险箱入口的位置是有要求的：它管的是子进程的 spawn 环境（条目按同名环境变量
// 注入），不是「服务器设置」里的一个开关，所以必须在设置页第一屏就看得见 ——
// 埋进 _advancedOnly 分组里就等于没有（web 侧同理，见 manage.html 的 .nav-pinned
// 与 Air 设置中心的第一组）。这条测试守住「别把它挪回去」。

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(() => I18n.init('zh'));

  testWidgets('vault entry stays above the fold on the settings screen', (
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

    // 默认（体验模式）下也要在：不滚动就能看到 = 落在首屏（测试视口高 600）。
    final entry = find.text(t('secretsVaultEntry'));
    expect(entry, findsOneWidget, reason: '设置页要有保险箱入口');
    expect(
      tester.getTopLeft(entry).dy,
      lessThan(600),
      reason: '入口要在首屏，不能只出现在高级分组的折叠项里',
    );

    // 点进去落到保险箱页（新增条目的名称输入框是那一页的锚点）。
    await tester.tap(entry);
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('secrets-add-name')), findsOneWidget);
  });
}
