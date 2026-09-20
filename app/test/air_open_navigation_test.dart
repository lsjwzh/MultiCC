import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:multicc_app/services/onboarding_store.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/widgets/air/air_sidebar.dart';
import 'package:multicc_app/widgets/air_tasks_view.dart';
import 'package:shared_preferences/shared_preferences.dart';

// ☰ 要开的是 Air 首页那层 Scaffold 自己的抽屉，而打开着的对话 / 目录详情是宿主叠在
// 它上面的浮层 —— 不先把浮层让开，抽屉会拉在浮层底下（屏幕上什么也看不到）。所以
// ☰ 按下去是「先请宿主让路、让开了再开抽屉」，等不了的这一拍谁也不能省。
//
// 宿主做让路这件事有它自己的测试（session_layer_collapse_test.dart）；这里只管
// Air 这一侧的时序：宿主没回话之前，抽屉不许开。
void main() {
  Future<SettingsService> settings() async {
    SharedPreferences.setMockInitialValues({
      'multicc_host': 'http://localhost:3000',
      OnboardingStore.doneKey: '1',
    });
    return SettingsService.getInstance();
  }

  http.Client client() => MockClient((request) async {
    final path = request.url.path;
    Map<String, dynamic> body;
    if (path == '/api/air') {
      body = {
        'ok': true,
        'directories': const [],
        'tasks': const [],
        'sessions': const [],
        'clis': const [],
        'migration': const {'errors': []},
      };
    } else if (path == '/api/settings/power') {
      body = {'ok': true, 'available': false, 'enabled': false};
    } else {
      return http.Response('[]', 200,
          headers: {'content-type': 'application/json; charset=utf-8'});
    }
    return http.Response(jsonEncode(body), 200,
        headers: {'content-type': 'application/json; charset=utf-8'});
  });

  testWidgets('☰ 等宿主把浮层让开之后才拉抽屉', (tester) async {
    final gate = Completer<void>();
    var asked = 0;
    final settingsService = await settings();
    final httpClient = client();
    addTearDown(httpClient.close);

    await tester.pumpWidget(
      MaterialApp(
        home: AirTasksView(
          settings: settingsService,
          httpClient: httpClient,
          beforeOpenNavigation: () {
            asked++;
            return gate.future;
          },
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const ValueKey('air-menu-button')));
    await tester.pump();
    expect(asked, 1, reason: '☰ 要先问宿主一遍');
    expect(
      find.byType(AirSidebar),
      findsNothing,
      reason: '宿主还没回话，抽屉不能先拉出来（它会被浮层盖住）',
    );

    gate.complete();
    await tester.pumpAndSettle();
    expect(find.byType(AirSidebar), findsOneWidget, reason: '浮层让开了，抽屉就该在眼前');
    expect(tester.takeException(), isNull);
  });

  testWidgets('没有浮层的宿主：☰ 直接开抽屉，不绕这一趟', (tester) async {
    final settingsService = await settings();
    final httpClient = client();
    addTearDown(httpClient.close);

    await tester.pumpWidget(
      MaterialApp(
        home: AirTasksView(settings: settingsService, httpClient: httpClient),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const ValueKey('air-menu-button')));
    await tester.pumpAndSettle();
    expect(find.byType(AirSidebar), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
