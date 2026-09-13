import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/widgets/air_tasks_view.dart';

/// 一份两目录两任务的快照：d1 里有一条未完成的、一条归档的，d2 空着。
MockClient _client(List<String> requests) => MockClient((request) async {
  requests.add(request.url.path);
  return http.Response(
    jsonEncode({
      'ok': true,
      'clis': ['codex'],
      'directories': [
        {'id': 'd1', 'name': '工作目录 A', 'path': '/project/a'},
        {'id': 'd2', 'name': '工作目录 B', 'path': '/project/b'},
      ],
      'tasks': [
        {
          'id': 't1',
          'dirId': 'd1',
          'title': '登录页面',
          'status': 'inbox',
          'resource': {'residency': 'planned', 'lease': 'idle'},
        },
        {
          'id': 't2',
          'dirId': 'd1',
          'title': '旧任务',
          'status': 'archived',
          'resource': {'residency': 'resident', 'lease': 'idle'},
        },
      ],
    }),
    200,
    headers: {'content-type': 'application/json; charset=utf-8'},
  );
});

Future<SettingsService> _settings() async {
  SharedPreferences.setMockInitialValues({
    'multicc_host': 'http://localhost:3000',
  });
  return SettingsService.getInstance();
}

void main() {
  testWidgets('Air 首页列出当前目录的任务，归档记录默认不出现，320px 不溢出', (
    tester,
  ) async {
    final settings = await _settings();
    final requests = <String>[];
    final client = _client(requests);
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(320, 800);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(
      MaterialApp(
        home: AirTasksView(settings: settings, httpClient: client),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('登录页面'), findsOneWidget);
    expect(find.text('执行时准备目录'), findsOneWidget);
    expect(find.text('旧任务'), findsNothing);
    // 「全部」是筛选，不是开关：它在同一个列表上多放出归档的那些行。
    await tester.tap(find.widgetWithText(ChoiceChip, '全部'));
    await tester.pumpAndSettle();
    expect(find.text('旧任务'), findsOneWidget);
    expect(tester.takeException(), isNull);
    // 首页只问一次 /api/air —— 目录库、侧栏、统计都从这一份快照里出。
    expect(requests, ['/api/air']);
    await tester.pumpWidget(const SizedBox());
    client.close();
  });

  testWidgets('Air 侧栏给出控制台、定时任务与最近任务', (tester) async {
    final settings = await _settings();
    final client = _client(<String>[]);
    await tester.pumpWidget(
      MaterialApp(
        home: AirTasksView(settings: settings, httpClient: client),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('air-menu-button')));
    await tester.pumpAndSettle();
    expect(find.text('控制台'), findsOneWidget);
    expect(find.text('定时任务'), findsOneWidget);
    expect(find.text('最近任务'), findsOneWidget);
    expect(find.text('新任务'), findsOneWidget);
    expect(find.text('更多与系统'), findsOneWidget);
    // 最近打开过的任务优先：这次会话没打开过任何任务，补位的是当前目录里
    // 最近更新过的那条。
    expect(find.byKey(const ValueKey('air-side-task-t1')), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    client.close();
  });

  testWidgets('目录库可以搜到另一个目录并切过去', (tester) async {
    final settings = await _settings();
    final client = _client(<String>[]);
    await tester.pumpWidget(
      MaterialApp(
        home: AirTasksView(settings: settings, httpClient: client),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('air-header-menu')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('工作目录库'));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('air-directory-d1')), findsOneWidget);
    expect(find.byKey(const ValueKey('air-directory-d2')), findsOneWidget);
    await tester.enterText(
      find.byKey(const ValueKey('air-directory-search')),
      '目录 B',
    );
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('air-directory-d1')), findsNothing);
    await tester.tap(find.byKey(const ValueKey('air-directory-d2')));
    await tester.pumpAndSettle();
    // 切过去之后回到任务主区，标题就是新目录。
    expect(find.text('工作目录 B'), findsWidgets);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    client.close();
  });
}
