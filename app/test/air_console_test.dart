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
///   t1 等我回答 · t2 出错（两条都要我动手，t2 更新得更晚）·
///   t3 空闲（不进「谁在等我」）· t4 已归档（默认筛选里不出现）。
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

/// 现场里有「在跑」的任务时，它那圈彩虹是一直转的动画 —— `pumpAndSettle` 永远等
/// 不到静止，会一路超时。这几帧足够把两份数据落地、把路由推完。
Future<void> _pumpFrames(WidgetTester tester, [int frames = 5]) async {
  for (var i = 0; i < frames; i++) {
    await tester.pump(const Duration(milliseconds: 100));
  }
}

void main() {
  // 状态徽标上的字来自 i18n 词典（注册表只给 key），不加载就只有 key。
  setUpAll(() => I18n.init('zh'));

  testWidgets('四张统计卡说的是同一份判定：谁在跑、谁在等我', (tester) async {
    _tallCanvas(tester);
    final settings = await _settings();
    final requests = <String>[];
    final opened = <String>[];
    var openedAssistant = 0;
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
          onOpenAiAssistant: () => openedAssistant++,
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
    expect(
      find.byKey(const ValueKey('air-console-ai-assistant')),
      findsOneWidget,
    );
    await tester.tap(find.byKey(const ValueKey('air-console-ai-assistant')));
    expect(openedAssistant, 1);

    // 「谁在等我」只留等我回答 / 出错要处理 / 卡资源的，空闲和归档不进来。
    expect(find.byKey(const ValueKey('air-console-urgent-t1')), findsOneWidget);
    expect(find.byKey(const ValueKey('air-console-urgent-t2')), findsOneWidget);
    expect(find.byKey(const ValueKey('air-console-urgent-t3')), findsNothing);
    expect(find.byKey(const ValueKey('air-console-urgent-t4')), findsNothing);
    // 顺序是纯时间倒序，不是紧急度分层：t2 出错但动得更晚，就该排在等回答的
    // t1 上面（夹具故意让「更急的」更旧 —— 紧急度分层一旦回来，这两行就翻面）。
    expect(
      tester.getTopLeft(find.byKey(const ValueKey('air-console-urgent-t2'))).dy,
      lessThan(
        tester
            .getTopLeft(find.byKey(const ValueKey('air-console-urgent-t1')))
            .dy,
      ),
      reason: '最近动过的排在前面',
    );
    // 行上一眼能看出它在等我回答 / 出错了（同一条任务在两个分区里各一行）。
    expect(find.text('等待中'), findsWidgets);
    expect(find.text('异常'), findsWidgets);

    // 分区顺序：控制台要一眼回答两件事 —— 谁在等我、我有哪些目录 —— 所以「工作目录」
    // 紧跟「谁在等我」，不压到「全部任务」和工具格底下等用户滚到底才看见。
    // 拿 eyebrow 定位（「工作目录」这四个字统计卡上也有，用标题会撞上）。
    double sectionY(String eyebrow) => tester.getTopLeft(find.text(eyebrow)).dy;
    expect(
      sectionY('WORK DIRECTORIES'),
      greaterThan(sectionY('ACROSS ALL WORKSPACES')),
      reason: '「工作目录」在「谁在等我」后面',
    );
    expect(
      sectionY('WORK DIRECTORIES'),
      lessThan(sectionY('ALL TASKS · 全部目录')),
      reason: '「工作目录」在「全部任务」前面',
    );
    expect(
      sectionY('ALL TASKS · 全部目录'),
      lessThan(sectionY('SYSTEM TOOLS')),
      reason: '工具格仍在最后',
    );

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
    final requests = <String>[];
    final client = _client(requests);

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

    await tester.tap(find.byKey(const ValueKey('air-console-delete-t2')));
    await tester.pumpAndSettle();
    expect(find.text('删除任务「支付回调」？'), findsOneWidget);
    await tester.tap(
      find.byKey(const ValueKey('air-console-t2-delete-confirm-ok')),
    );
    await tester.pumpAndSettle();
    expect(requests, contains('/api/task-board/tasks/t2'));

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
    expect(find.byKey(const ValueKey('air-console-urgent-t1')), findsOneWidget);
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
    expect(
      tester
          .getSize(find.byKey(const ValueKey('air-console-task-scroll')))
          .height,
      340,
      reason: '全部任务在固定高度容器内滚动，不再把控制台无限拉长',
    );
    // 全部空闲，没有一条要我去处理。
    expect(find.text('没有正在等我的任务。'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    client.close();
  });

  testWidgets('「谁在等我」只留最近更新的 5 条，其余交给它自己的整页', (tester) async {
    _tallCanvas(tester);
    final settings = await _settings();
    final requests = <String>[];
    final opened = <String>[];
    // 七条要我动手的（等回答 / 出错），外加两条「最新但不用我动手」的：在跑的
    // r1、空闲的 i1。这两条的时间戳比谁都新 —— 一旦「正在跑」又被算进这份清单，
    // 头一行立刻是 r1，断言当场失败。留下的 5 条是最近动过的 w1 w2 e1 e2 w3，
    // 落选的是更久没动的 e3 e4。
    final client = _client(
      requests,
      tasks: [
        for (final (id, runState, updatedAt, lease) in const [
          ('i1', 'idle', 950, 'idle'),
          ('r1', 'running', 900, 'running'),
          ('w1', 'waiting', 800, 'idle'),
          ('w2', 'waiting', 700, 'idle'),
          ('e1', 'error', 600, 'idle'),
          ('e2', 'error', 500, 'idle'),
          ('w3', 'waiting', 400, 'idle'),
          ('e3', 'error', 300, 'idle'),
          ('e4', 'error', 200, 'idle'),
          ('r2', 'running', 100, 'running'),
        ])
          {
            'id': id,
            'dirId': 'd1',
            'title': '任务 $id',
            'status': 'active',
            'runState': runState,
            'updatedAt': 1700000000000 + updatedAt,
            'resource': {
              'residency': lease == 'running' ? 'materialized' : 'planned',
              'lease': lease,
            },
          },
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
    await _pumpFrames(tester);

    // ① 封顶：留下最近更新的 5 条，落选的不进这一格。
    expect(find.text('7 条 · 显示最近更新的 5 条'), findsOneWidget);
    for (final id in const ['w1', 'w2', 'e1', 'e2', 'w3']) {
      expect(
        find.byKey(ValueKey('air-console-urgent-$id')),
        findsOneWidget,
        reason: '$id 是最近更新的五条之一，该在控制台这一格里',
      );
    }
    for (final id in const ['e3', 'e4']) {
      expect(
        find.byKey(ValueKey('air-console-urgent-$id')),
        findsNothing,
        reason: '$id 被封顶挡在整页上，不该还留在控制台这一格',
      );
    }
    // 执行中的、空闲的从不进这份清单 —— 哪怕它们是最新的两条。
    for (final id in const ['r1', 'r2', 'i1']) {
      expect(
        find.byKey(ValueKey('air-console-urgent-$id')),
        findsNothing,
        reason: '$id 不需要我动手，不属于「谁在等我」',
      );
    }
    // 封顶不等于假装只有这几条：总数照报，出口带着同一个数。
    expect(find.text('查看全部 7 条 ›'), findsOneWidget);

    // ② 整页：同一份清单铺开，最近更新的排在最前。
    await tester.tap(find.byKey(const ValueKey('air-console-attention-all')));
    await _pumpFrames(tester);
    expect(find.byKey(const ValueKey('air-attention')), findsOneWidget);
    expect(find.text('7 条 · 按最近更新排序，点击直达'), findsOneWidget);
    for (final id in const ['e3', 'e4']) {
      expect(find.byKey(ValueKey('air-attention-task-$id')), findsOneWidget);
    }
    for (final id in const ['r1', 'r2', 'i1']) {
      expect(
        find.byKey(ValueKey('air-attention-task-$id')),
        findsNothing,
        reason: '整页是同一份清单，执行中的不该在这里冒出来',
      );
    }
    // 顺序是纯时间的证据：e2(500) 是一条出错的任务，w3(400) 比它旧但在等我回答
    // —— 按紧急度分层会把 w3 提到前面，纯时间不会。
    expect(
      tester.getTopLeft(find.byKey(const ValueKey('air-attention-task-e2'))).dy,
      lessThan(
        tester.getTopLeft(find.byKey(const ValueKey('air-attention-task-w3'))).dy,
      ),
      reason: '最近更新的排在前面，不按紧急度分层',
    );
    expect(opened, isEmpty, reason: '只是打开清单，不该顺手开一条任务');

    // ③ 整页里点一条：先把整页收掉，再由宿主导航（否则控制台会留在屏幕上）。
    await tester.tap(find.byKey(const ValueKey('air-attention-task-e3')));
    await _pumpFrames(tester);
    expect(opened, ['e3']);
    expect(
      find.byKey(const ValueKey('air-attention')),
      findsNothing,
      reason: '点走一条之后整页要收掉',
    );

    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    client.close();
  });

  testWidgets('没超过 5 条时没有第二页可去，出口不出现', (tester) async {
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
    await _pumpFrames(tester);

    // 默认现场只有 2 条（t1 等回答、t2 出错），远没到封顶。
    expect(find.text('按最近更新排序，点击直达'), findsOneWidget);
    expect(
      find.byKey(const ValueKey('air-console-attention-all')),
      findsNothing,
      reason: '没超过就不该常驻一个点了没反应的「查看全部」',
    );
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    client.close();
  });

  testWidgets('统计是一条窄读数带，不跟任务抢高度', (tester) async {
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
    await _pumpFrames(tester);

    final card = tester.getSize(find.byKey(const ValueKey('air-stat-工作目录')));
    // 原来是 24px 的数字 + 26×3 的色条，卡片明显更高。这里钉住「确实压扁了」，
    // 不钉死具体数值 —— 那会在下次微调时变成噪声。
    expect(card.height, lessThan(100), reason: '统计卡实测 ${card.height}');
    final value = tester.widget<Text>(
      find.descendant(
        of: find.byKey(const ValueKey('air-stat-工作目录')),
        matching: find.text('2'),
      ),
    );
    expect(value.style?.fontSize, lessThanOrEqualTo(20));
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    client.close();
  });
}
