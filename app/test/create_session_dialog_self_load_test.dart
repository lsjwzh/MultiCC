import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/models/message.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/widgets/create_session_dialog.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Air 的「新建终端」过去是先把 Provider 池和安装情况 await 完，再 showDialog ——
/// 按下去到弹窗出现之间是空白（用户报的「切换 provider 的窗口要等很久」同一件事）。
/// 现在弹窗先出来、数据由自己补（`selfLoad`），这份测试把那一刻钉住。
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() => I18n.init('zh'));

  Future<SettingsService> settings() async {
    SharedPreferences.setMockInitialValues({
      'multicc_host': 'http://127.0.0.1:1', // 不可达：安装情况那一趟快速失败
      'multicc_token': '',
    });
    return SettingsService.getInstance();
  }

  testWidgets('池子还在路上，配置表已经开出来了；到了自己填进去', (tester) async {
    final s = await settings();
    final gate = Completer<http.Response>();
    var providerCalls = 0;
    final client = MockClient((request) async {
      if (request.url.path.startsWith('/api/providers')) {
        providerCalls++;
        return gate.future;
      }
      return http.Response(
        jsonEncode({'ok': true}),
        200,
        headers: {'content-type': 'application/json; charset=utf-8'},
      );
    });

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: CreateSessionDialog(
            kind: SessionKind.terminal,
            defaultCli: SessionCli.claude,
            providers: const [],
            settings: s,
            selfLoad: true,
            httpClient: client,
          ),
        ),
      ),
    );

    // 只推几帧：池子那趟请求还卡在 gate 上。
    for (var i = 0; i < 5; i++) {
      await tester.pump(const Duration(milliseconds: 10));
    }

    // 表的骨架已经在屏幕上了（CLI 那一格就先画着），并且明说池子在读。
    expect(find.byType(DropdownButtonFormField<SessionCli>), findsWidgets);
    expect(find.text(t('airProviderLoadingList')), findsOneWidget);
    expect(providerCalls, 1, reason: '池子这一趟已经发出去了');

    gate.complete(
      http.Response(
        jsonEncode({
          'ok': true,
          'providers': [
            {'id': 'p1', 'name': '火山方舟', 'appType': 'claude'},
          ],
          'defaults': {'claude': 'p1'},
        }),
        200,
        headers: {'content-type': 'application/json; charset=utf-8'},
      ),
    );
    await tester.pumpAndSettle();

    // 数据到了：提示撤掉，线路自己选上默认那条。
    expect(find.text(t('airProviderLoadingList')), findsNothing);
    expect(find.textContaining('火山方舟'), findsWidgets);
    expect(tester.takeException(), isNull);
  });
}
