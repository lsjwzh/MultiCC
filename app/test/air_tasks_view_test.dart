import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/widgets/air_tasks_view.dart';

void main() {
  testWidgets('Air shows directory tasks, filters records, and fits 320px', (tester) async {
    SharedPreferences.setMockInitialValues({'multicc_host': 'http://localhost:3000'});
    final settings = await SettingsService.getInstance();
    final requests = <String>[];
    final client = MockClient((request) async {
      requests.add(request.url.path);
      return http.Response(jsonEncode({'ok': true, 'clis': ['codex'], 'directories': [
        {'id': 'd1', 'name': '工作目录 A', 'path': '/project/a'},
        {'id': 'd2', 'name': '工作目录 B', 'path': '/project/b'},
      ], 'tasks': [
        {'id': 't1', 'dirId': 'd1', 'title': '登录页面', 'status': 'inbox', 'resource': {'residency': 'planned', 'lease': 'idle'}},
        {'id': 't2', 'dirId': 'd1', 'title': '旧任务', 'status': 'archived', 'resource': {'residency': 'resident', 'lease': 'idle'}},
      ]}), 200, headers: {'content-type': 'application/json; charset=utf-8'});
    });
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(320, 800);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: AirTasksView(settings: settings, httpClient: client))));
    await tester.pumpAndSettle();
    expect(find.text('登录页面'), findsOneWidget);
    expect(find.text('执行时准备目录'), findsOneWidget);
    expect(find.text('旧任务'), findsNothing);
    await tester.tap(find.byType(Switch)); await tester.pumpAndSettle();
    expect(find.text('旧任务'), findsOneWidget);
    await tester.enterText(find.byType(TextField), '登录'); await tester.pump();
    expect(find.text('旧任务'), findsNothing);
    expect(tester.takeException(), isNull);
    expect(requests, ['/api/air']);
    await tester.pumpWidget(const SizedBox()); client.close();
  });
}
