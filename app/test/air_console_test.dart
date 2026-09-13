import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/widgets/air/air_console.dart';
import 'package:multicc_app/widgets/workspace_navigation_drawer.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// `/api/air` 一份快照 + `/api/cron` 一份规则表。控制台只读这两样。
MockClient _client(
  List<String> requests, {
  List<Map<String, dynamic>>? tasks,
  List<Map<String, dynamic>>? schedules,
  int directories = 2,
}) => MockClient((request) async {
  requests.add(request.url.path);
  if (request.url.path == '/api/cron') {
    return http.Response(
      jsonEncode(schedules ?? const []),
      200,
      headers: {'content-type': 'application/json; charset=utf-8'},
    );
  }
  return http.Response(
    jsonEncode({
      'ok': true,
      'clis': const ['claude'],
      'directories': [
        for (var i = 1; i <= directories; i++)
          {'id': 'd$i', 'name': '工作目录 ${i == 1 ? 'A' : 'B'}', 'path': '/p/$i'},
      ],
      'tasks': tasks ?? _tasks,
    }),
    200,
    headers: {'content-type': 'application/json; charset=utf-8'},
  );
});

/// 四条任务，四种处境：
///   t1 等我回答（最急）· t2 出错（其次）· t3 空闲（不进「谁在等我」）·
///   t4 已归档（默认筛选里不出现）。
const List<Map<String, dynamic>> _tasks = [
  {
    'id': 't1',
    'dirId': 'd1',
    'title': '登录页面',
    'status': 'active',
    'recordType': 'planned',
    'workflowStage': 'inbox',
    'runState': 'waiting',
    'updatedAt': 1700000000000,
    'resource': {'residency': 'planned', 'lease': 'idle', 'reason': null},
  },
  {
    'id': 't2',
    'dirId': 'd1',
    'title': '支付回调',
    'status': 'active',
    'runState': 'error',
    'updatedAt': 1700000100000,
    'resource': {'residency': 'resident', 'lease': 'idle'},
  },
  {
    'id': 't3',
    'dirId': 'd2',
    'title': '整理文档',
    'status': 'active',
    'runState': 'idle',
    'updatedAt': 1700000200000,
    'resource': {'residency': 'planned', 'lease': 'idle'},
  },
  {
    'id': 't4',
    'dirId': 'd2',
    'title': '旧任务',
    'status': 'archived',
    'runState': null,
    'updatedAt': 1700000300000,
    'resource': {'residency': 'retained', 'lease': 'idle'},
  },
];

Future<SettingsService> _settings() async {
  SharedPreferences.setMockInitialValues({
    'multicc_host': 'http://localhost:3000',
  });
  return SettingsService.getInstance();
}

/// 控制台这一页很高（统计 + 三个分区 + 工具格），默认 800×600 的画布会把下面的
/// 分区挤出渲染树，点击就落空了。给测试一块够高的画布。
void _tallCanvas(WidgetTester tester) {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = const Size(900, 2600);
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
}

void main() {
  // 状态徽标上的字来自 i18n 词典（注册表只给 key），不加载就只有 key。
  setUpAll(() => I18n.init('zh'));

  testWidgets('四张统计卡说的是同一份判定：谁在跑、谁在等我', (tester) async {
    _tallCanvas(tester);
    final settings = await _settings();
    final requests = <String>[];
    final opened = <String>[];
    final client = _client(
      requests,
      schedules: const [
        {'id': 'c1', 'name': '每日巡检', 'cron': '0 9 * * *', 'enabled': true},
        {'id': 'c2', 'name': '周报', 'cron': '0 9 * * 1', 'enabled': false},
        {'id': 'c3', 'name': '备份', 'cron': '0 3 * * *', 'enabled': true},
      ],
    );

    await tester.pumpWidget(
      MaterialApp(
        home: AirConsoleScreen(
          settings: settings,
          httpClient: client,
          onOpenTask: (task) => opened.add(task.id),
          onOpenTasks: () {},
          onOpenLibrary: () {},
          onSelectDirectory: (_) {},
          onOpenDestination: (_) {},
          onOpenMemory: () {},
          onOpenWebConsole: () {},
        ),
      ),
    );
    await tester.pumpAndSettle();

    // 两份数据各拉一次，控制台不自己造统计口径。中间的 `/api/external-fleets`
    // 是快照自带的一趟：导入进来的远端工作区要一起铺进目录列表（Web
    // `manage-fleet-sharing.js` 的 `dashboardData()` 也是这么合的）。
    expect(requests, ['/api/air', '/api/external-fleets', '/api/cron']);

    Finder statValue(String label, String value) => find.descendant(
      of: find.byKey(ValueKey('air-stat-$label')),
      matching: find.text(value),
    );
    // 两个目录，一个有活在跑（t1 在等回答、t2 出错都算在处理中，但都不在跑）。
    expect(statValue('工作目录', '2'), findsOneWidget);
    expect(find.text('统一目录库'), findsOneWidget);
    // 未归档的三条都算「进行中」。
    expect(statValue('进行中任务', '3'), findsOneWidget);
    // 「执行中」只认 runState=running：一条都没有，就不该编出一个数字来。
    expect(find.text('0 个正在执行'), findsOneWidget);
    // 等待回答、出错、卡资源都算要我去处理。
    expect(statValue('等待处理', '2'), findsOneWidget);
    expect(find.text('等待回答、资源或重试'), findsOneWidget);
    expect(statValue('定时任务', '2'), findsOneWidget);
    expect(find.text('共 3 条规则'), findsOneWidget);

    // 「谁在等我」按紧急度排：等回答的在前，出错的在后，空闲 / 归档的不进来。
    expect(
      find.byKey(const ValueKey('air-console-urgent-t1')),
      findsOneWidget,
    );
    expect(
      find.byKey(const ValueKey('air-console-urgent-t2')),
      findsOneWidget,
    );
    expect(find.byKey(const ValueKey('air-console-urgent-t3')), findsNothing);
    expect(find.byKey(const ValueKey('air-console-urgent-t4')), findsNothing);
    expect(
      tester.getTopLeft(find.byKey(const ValueKey('air-console-urgent-t1'))).dy,
      lessThan(
        tester.getTopLeft(find.byKey(const ValueKey('air-console-urgent-t2'))).dy,
      ),
    );
    // 行上一眼能看出它在等我回答 / 出错了（同一条任务在两个分区里各一行）。
    expect(find.text('等待中'), findsWidgets);
    expect(find.text('异常'), findsWidgets);

    await tester.tap(find.byKey(const ValueKey('air-console-urgent-t1')));
    await tester.pumpAndSettle();
    expect(opened, ['t1']);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    client.close();
  });

  testWidgets('全部任务的筛选：默认只看没结束的，搜索和状态各收窄一层', (tester) async {
    _tallCanvas(tester);
    final settings = await _settings();
    final client = _client(<String>[]);

    await tester.pumpWidget(
      MaterialApp(
        home: AirConsoleScreen(
          settings: settings,
          httpClient: client,
          onOpenTask: (_) {},
          onOpenTasks: () {},
          onOpenLibrary: () {},
          onSelectDirectory: (_) {},
          onOpenDestination: (_) {},
          onOpenMemory: () {},
          onOpenWebConsole: () {},
        ),
      ),
    );
    await tester.pumpAndSettle();

    Finder row(String id) => find.byKey(ValueKey('air-console-task-$id'));
    // 默认「进行中与待处理」：归档的那条不出现。
    expect(row('t1'), findsOneWidget);
    expect(row('t3'), findsOneWidget);
    expect(row('t4'), findsNothing);
    expect(find.text('3 条'), findsOneWidget);

    // 搜索同时看标题和目录名。
    await tester.enterText(
      find.byKey(const ValueKey('air-console-search')),
      '支付',
    );
    await tester.pumpAndSettle();
    expect(row('t1'), findsNothing);
    expect(row('t2'), findsOneWidget);
    expect(find.text('1 条'), findsOneWidget);

    await tester.enterText(
      find.byKey(const ValueKey('air-console-search')),
      '工作目录 B',
    );
    await tester.pumpAndSettle();
    expect(row('t3'), findsOneWidget);
    expect(row('t2'), findsNothing);

    await tester.enterText(
      find.byKey(const ValueKey('air-console-search')),
      '',
    );
    await tester.pumpAndSettle();

    // 放宽到全部记录，归档的那条就回来了。
    await tester.tap(find.byKey(const ValueKey('air-console-status')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('全部记录').last);
    await tester.pumpAndSettle();
    expect(row('t4'), findsOneWidget);
    expect(find.text('4 条'), findsOneWidget);

    // 「已归档」只剩它一条。
    await tester.tap(find.byKey(const ValueKey('air-console-status')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('已归档').last);
    await tester.pumpAndSettle();
    expect(row('t4'), findsOneWidget);
    expect(row('t1'), findsNothing);

    // 按目录收窄：t4 在 d2 里。
    await tester.tap(find.byKey(const ValueKey('air-console-status')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('全部记录').last);
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('air-console-dir')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('工作目录 A').last);
    await tester.pumpAndSettle();
    expect(row('t1'), findsOneWidget);
    expect(row('t3'), findsNothing);

    // 空态也要说话，不是一片空白。
    await tester.enterText(
      find.byKey(const ValueKey('air-console-search')),
      '不存在的东西',
    );
    await tester.pumpAndSettle();
    expect(find.text('没有符合条件的任务。换个关键词或放宽筛选。'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    client.close();
  });

  testWidgets('工作目录栏数的是「没做完几个 / 有几个在跑」，点进去切到那个目录', (tester) async {
    _tallCanvas(tester);
    final settings = await _settings();
    final picked = <String>[];
    final client = _client(<String>[]);

    await tester.pumpWidget(
      MaterialApp(
        home: AirConsoleScreen(
          settings: settings,
          httpClient: client,
          onOpenTask: (_) {},
          onOpenTasks: () {},
          onOpenLibrary: () {},
          onSelectDirectory: picked.add,
          onOpenDestination: (_) {},
          onOpenMemory: () {},
          onOpenWebConsole: () {},
        ),
      ),
    );
    await tester.pumpAndSettle();

    // d1 有两条没结束（t1 在等我、t2 出错），一条在跑的都没有 —— 没在跑就把
    // 任务总数说出来，而不是写一个 0。
    expect(find.text('2 进行中'), findsOneWidget);
    // d2 一条没结束、一条归档。
    expect(find.text('1 进行中'), findsOneWidget);
    expect(find.text('2 个任务'), findsNWidgets(2));

    await tester.tap(find.byKey(const ValueKey('air-console-dir-d2')));
    await tester.pumpAndSettle();
    expect(picked, ['d2']);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    client.close();
  });

  testWidgets('服务与设置四张卡各去各的地方', (tester) async {
    _tallCanvas(tester);
    final settings = await _settings();
    final destinations = <WorkspaceDestination>[];
    var memory = 0, tasks = 0, library = 0, web = 0;
    final client = _client(<String>[]);

    await tester.pumpWidget(
      MaterialApp(
        home: AirConsoleScreen(
          settings: settings,
          httpClient: client,
          onOpenTask: (_) {},
          onOpenTasks: () => tasks++,
          onOpenLibrary: () => library++,
          onSelectDirectory: (_) {},
          onOpenDestination: destinations.add,
          onOpenMemory: () => memory++,
          onOpenWebConsole: () => web++,
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const ValueKey('air-console-tool-docs')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('air-console-tool-memory')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('air-console-tool-settings')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('air-console-tool-schedules')));
    await tester.pumpAndSettle();
    expect(destinations, [
      WorkspaceDestination.docs,
      WorkspaceDestination.global,
      WorkspaceDestination.cron,
    ]);
    expect(memory, 1);

    // 统计卡也是入口：进行中任务回到任务主页，工作目录去目录库。
    await tester.tap(find.byKey(const ValueKey('air-stat-进行中任务')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('air-stat-工作目录')));
    await tester.pumpAndSettle();
    expect(tasks, 1);
    expect(library, 1);

    // 原生页之外留一个网页版的出口。
    await tester.tap(find.byKey(const ValueKey('air-console-menu')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('在网页里打开控制台'));
    await tester.pumpAndSettle();
    expect(web, 1);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    client.close();
  });

  testWidgets('定时任务读不到只是那张卡说实话，不把整页变成错误页', (tester) async {
    _tallCanvas(tester);
    final settings = await _settings();
    final client = MockClient((request) async {
      if (request.url.path == '/api/cron') {
        return http.Response('nope', 500);
      }
      return http.Response(
        jsonEncode({
          'ok': true,
          'clis': const ['claude'],
          'directories': const [
            {'id': 'd1', 'name': '工作目录 A', 'path': '/p/1'},
          ],
          'tasks': _tasks,
        }),
        200,
        headers: {'content-type': 'application/json; charset=utf-8'},
      );
    });

    await tester.pumpWidget(
      MaterialApp(
        home: AirConsoleScreen(
          settings: settings,
          httpClient: client,
          onOpenTask: (_) {},
          onOpenTasks: () {},
          onOpenLibrary: () {},
          onSelectDirectory: (_) {},
          onOpenDestination: (_) {},
          onOpenMemory: () {},
          onOpenWebConsole: () {},
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(
      find.descendant(
        of: find.byKey(const ValueKey('air-stat-定时任务')),
        matching: find.text('—'),
      ),
      findsOneWidget,
    );
    expect(find.text('定时任务读取失败，下拉重试'), findsOneWidget);
    // 主体照常。
    expect(
      find.byKey(const ValueKey('air-console-urgent-t1')),
      findsOneWidget,
    );
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    client.close();
  });

  testWidgets('宿主给了原生定时任务中心，两张卡就都不去老抽屉', (tester) async {
    _tallCanvas(tester);
    final settings = await _settings();
    final destinations = <WorkspaceDestination>[];
    var schedules = 0;
    final client = _client(<String>[]);

    await tester.pumpWidget(
      MaterialApp(
        home: AirConsoleScreen(
          settings: settings,
          httpClient: client,
          onOpenTask: (_) {},
          onOpenTasks: () {},
          onOpenLibrary: () {},
          onSelectDirectory: (_) {},
          onOpenDestination: destinations.add,
          onOpenMemory: () {},
          onOpenWebConsole: () {},
          onOpenSchedules: () => schedules++,
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const ValueKey('air-console-tool-schedules')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('air-stat-定时任务')));
    await tester.pumpAndSettle();
    expect(schedules, 2);
    expect(destinations, isEmpty);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    client.close();
  });

  testWidgets('320px 上排得下：统计两列、筛选两列、行不横向溢出', (tester) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(320, 1400);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final settings = await _settings();
    final client = _client(<String>[]);

    await tester.pumpWidget(
      MaterialApp(
        home: AirConsoleScreen(
          settings: settings,
          httpClient: client,
          onOpenTask: (_) {},
          onOpenTasks: () {},
          onOpenLibrary: () {},
          onSelectDirectory: (_) {},
          onOpenDestination: (_) {},
          onOpenMemory: () {},
          onOpenWebConsole: () {},
        ),
      ),
    );
    await tester.pumpAndSettle();

    // 一排两张卡、筛选两列，都不该撑破 320px 的画布。
    expect(tester.takeException(), isNull);
    expect(find.byKey(const ValueKey('air-stat-工作目录')), findsOneWidget);
    expect(find.byKey(const ValueKey('air-console-status')), findsOneWidget);
    expect(find.byKey(const ValueKey('air-console-dir')), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
    client.close();
  });

  testWidgets('列表是给人看的：超过 60 条只显示最近的，并说清总数', (tester) async {
    _tallCanvas(tester);
    final settings = await _settings();
    final client = _client(
      <String>[],
      tasks: [
        for (var i = 0; i < 65; i++)
          {
            'id': 'n$i',
            'dirId': 'd1',
            'title': '任务 $i',
            'status': 'active',
            'runState': 'idle',
            'updatedAt': 1700000000000 + i,
            'resource': const {'residency': 'planned', 'lease': 'idle'},
          },
      ],
    );

    await tester.pumpWidget(
      MaterialApp(
        home: AirConsoleScreen(
          settings: settings,
          httpClient: client,
          onOpenTask: (_) {},
          onOpenTasks: () {},
          onOpenLibrary: () {},
          onSelectDirectory: (_) {},
          onOpenDestination: (_) {},
          onOpenMemory: () {},
          onOpenWebConsole: () {},
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('65 条 · 显示最近 60 条'), findsOneWidget);
    // 全部空闲，没有一条要我去处理。
    expect(find.text('没有正在等待或正在执行的任务。'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    client.close();
  });
}
