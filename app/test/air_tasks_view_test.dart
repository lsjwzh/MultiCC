import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/services/onboarding_store.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/widgets/air_tasks_view.dart';
import 'package:multicc_app/widgets/workspace_navigation_drawer.dart';

/// 一份两目录两任务的快照：d1 里有一条未完成的、一条归档的，d2 空着。
/// `/api/air/tasks/:id` 是另一套形状（多了 attribution / execution），单独给。
MockClient _client(List<String> requests) => MockClient((request) async {
  requests.add(request.url.path);
  if (request.url.path.startsWith('/api/air/tasks/')) {
    return http.Response(
      jsonEncode({
        'ok': true,
        'task': {
          'id': 't1',
          'title': '登录页面',
          'status': 'inbox',
          'recordType': 'planned',
          'workflowStage': 'inbox',
        },
        'status': 'inbox',
        'execution': {'status': 'idle', 'busy': false, 'pending': false},
        'messages': const [],
        'attribution': const {},
        'resource': {'residency': 'planned', 'lease': 'idle'},
        'configuration': const {},
        'sessionId': 'sess-1',
        'readOnly': false,
      }),
      200,
      headers: {'content-type': 'application/json; charset=utf-8'},
    );
  }
  return http.Response(
    jsonEncode({
      'ok': true,
      'clis': ['codex'],
      'directories': [
        {'id': 'd1', 'name': '工作目录 A', 'path': '/project/a'},
        {'id': 'd2', 'name': '工作目录 B', 'path': '/project/b'},
      ],
      // status 只有 active / done / archived 三个生命周期取值，「在不在跑」由
      // runState 说（服务端 air-routes.js）。t1 是刚建出来还没跑过的计划任务。
      'tasks': [
        {
          'id': 't1',
          'dirId': 'd1',
          'title': '登录页面',
          'status': 'active',
          'recordType': 'planned',
          'workflowStage': 'inbox',
          'runState': null,
          'resource': {'residency': 'planned', 'lease': 'idle'},
        },
        {
          'id': 't2',
          'dirId': 'd1',
          'title': '旧任务',
          'status': 'archived',
          'runState': null,
          'resource': {'residency': 'resident', 'lease': 'idle'},
        },
      ],
    }),
    200,
    headers: {'content-type': 'application/json; charset=utf-8'},
  );
});

/// 任务快照 + 一条定时规则。所有「进定时任务中心」的用例都要这两份数据 ——
/// 中心那一页自己拉 `/api/cron`。
MockClient _airAndCronClient() => MockClient((request) async {
  if (request.url.path == '/api/cron') {
    return http.Response(
      jsonEncode(const [
        {
          'id': 'c1',
          'name': '每日巡检',
          'dirId': 'd1',
          'dirName': '工作目录 A',
          'cli': 'claude',
          'prompt': '看一眼线上',
          'cron': '0 9 * * *',
          'enabled': true,
          'taskId': 't1',
          'taskTitle': '每日巡检',
        },
      ]),
      200,
      headers: {'content-type': 'application/json; charset=utf-8'},
    );
  }
  return http.Response(
    jsonEncode({
      'ok': true,
      'clis': const ['claude'],
      'directories': const [
        {'id': 'd1', 'name': '工作目录 A', 'path': '/project/a'},
      ],
      'tasks': const [],
    }),
    200,
    headers: {'content-type': 'application/json; charset=utf-8'},
  );
});

/// 「从弹层创建」那两条用例要的桩：建任务是成功的，第一条消息听 [firstMessageOk]。
/// GET 永远是那一份**不含新任务**的快照 —— 服务端还没把它列出来，正是要盯的延迟。
MockClient _createFromSheetClient(
  List<String> posts, {
  required bool firstMessageOk,
}) => MockClient((request) async {
  const headers = {'content-type': 'application/json; charset=utf-8'};
  if (request.method == 'POST') {
    posts.add(request.url.path);
    if (request.url.path.endsWith('/messages') && !firstMessageOk) {
      return http.Response(
        jsonEncode({'ok': false, 'error': 'temporary failure'}),
        503,
        headers: headers,
      );
    }
    return http.Response(
      jsonEncode({'ok': true, 'taskId': 't9', 'sessionId': 'sess-9'}),
      200,
      headers: headers,
    );
  }
  return http.Response(
    jsonEncode({
      'ok': true,
      'clis': const ['claude'],
      'directories': const [
        {'id': 'd1', 'name': '工作目录 A', 'path': '/project/a'},
      ],
      'tasks': const [],
    }),
    200,
    headers: headers,
  );
});

Future<SettingsService> _settings({bool onboarded = true}) async {
  SharedPreferences.setMockInitialValues({
    'multicc_host': 'http://localhost:3000',
    // 新手引导自己有一份测试（tour_overlay_test.dart）。这里默认把它标成走完：
    // 头一回打开时第 1 步圈的是目录库里的「添加」，会把首页切到目录库模式，
    // 于是任务列表和任务头部工具条都不在树上 —— 那份活儿归引导的测试管。
    if (onboarded) OnboardingStore.doneKey: '1',
  });
  return SettingsService.getInstance();
}

void main() {
  // 侧栏整条一起滚（底部那组在 600 高的测试视口里要滚一下才到眼前）。
  Future<void> tapInSidebar(WidgetTester tester, Finder finder) async {
    await tester.ensureVisible(finder);
    await tester.pumpAndSettle();
    await tester.tap(finder);
    await tester.pumpAndSettle();
  }

  // 状态徽标上的字来自 i18n 词典（注册表只给 key），不加载就只有 key。
  setUpAll(() => I18n.init('zh'));

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
    // 徽标说的是「这一轮在不在跑」（还没跑过 → 空闲），副行才说它走到哪一步、
    // 卡在哪 —— 与 Web Air 的任务行同一套分工。页头那颗「空闲」是目录的，这里
    // 只看行上的那一颗。
    expect(
      find.descendant(
        of: find.byKey(const ValueKey('air-task-t1')),
        matching: find.text('空闲'),
      ),
      findsOneWidget,
    );
    expect(find.text('计划 · 待处理 · 执行时准备目录'), findsOneWidget);
    expect(find.text('旧任务'), findsNothing);
    // 「全部」是筛选，不是开关：它在同一个列表上多放出归档的那些行。
    await tester.tap(find.widgetWithText(ChoiceChip, '全部'));
    await tester.pumpAndSettle();
    expect(find.text('旧任务'), findsOneWidget);
    expect(tester.takeException(), isNull);
    // 首页只问一次 /api/air —— 目录库、侧栏、统计都从这一份快照里出。（侧栏底部
    // 的主机运维是另一条线，它自己问 /api/server-info 和 /api/version-check。）
    expect(
      requests.where((path) => path.startsWith('/api/air')),
      ['/api/air'],
    );
    await tester.pumpWidget(const SizedBox());
    client.close();
  });

  testWidgets('头一回打开：引导从第 1 步开始，圈的是目录库那颗「添加」', (tester) async {
    final settings = await _settings(onboarded: false);
    final client = _client(<String>[]);
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(390, 800);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(
      MaterialApp(home: AirTasksView(settings: settings, httpClient: client)),
    );
    await tester.pumpAndSettle();

    expect(find.text('选择一个工作区'), findsOneWidget);
    // 第 1 步圈的是目录库那颗「添加」：首页得先切到目录库模式，任务列表这时
    // 不在树上（Web 那边第 1 步圈的也是「新建目录」）。
    expect(find.byKey(const ValueKey('air-add-directory')), findsOneWidget);
    expect(find.text('登录页面'), findsNothing);

    await tester.tap(find.byKey(const ValueKey('tour-next')));
    await tester.pumpAndSettle();
    // 第 2 步回到任务模式，圈的是快速新建那条输入区。
    expect(find.text('开始一段对话'), findsOneWidget);
    expect(find.text('登录页面'), findsOneWidget);
    expect(tester.takeException(), isNull);
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

  testWidgets('控制台入口带着「谁在等我」的数字，点进去是原生控制台', (tester) async {
    final settings = await _settings();
    final client = MockClient((request) async {
      if (request.url.path == '/api/cron') {
        return http.Response(
          jsonEncode(const []),
          200,
          headers: {'content-type': 'application/json; charset=utf-8'},
        );
      }
      return http.Response(
        jsonEncode({
          'ok': true,
          'clis': const ['claude'],
          'directories': const [
            {'id': 'd1', 'name': '工作目录 A', 'path': '/project/a'},
          ],
          'tasks': const [
            {
              'id': 't1',
              'dirId': 'd1',
              'title': '登录页面',
              'status': 'active',
              'runState': 'waiting',
              'updatedAt': 1700000000000,
              'resource': {'residency': 'planned', 'lease': 'idle'},
            },
          ],
        }),
        200,
        headers: {'content-type': 'application/json; charset=utf-8'},
      );
    });
    await tester.pumpWidget(
      MaterialApp(home: AirTasksView(settings: settings, httpClient: client)),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('air-menu-button')));
    await tester.pumpAndSettle();

    // 侧栏上的数字就是控制台第一个分区那一条 —— 一处定义，两处显示。
    expect(
      find.descendant(
        of: find.byKey(const ValueKey('air-nav-console')),
        matching: find.text('1'),
      ),
      findsOneWidget,
    );

    await tester.tap(find.text('控制台'));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('air-console')), findsOneWidget);
    expect(
      find.byKey(const ValueKey('air-console-urgent-t1')),
      findsOneWidget,
    );
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    client.close();
  });

  testWidgets('侧栏的「定时任务」进的是原生定时任务中心', (tester) async {
    final settings = await _settings();
    final client = _airAndCronClient();
    await tester.pumpWidget(
      MaterialApp(home: AirTasksView(settings: settings, httpClient: client)),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('air-menu-button')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('定时任务'));
    await tester.pumpAndSettle();

    // 不再是网页那一页，也不再是老抽屉里的那个只认 CLI 的页面。
    expect(find.byKey(const ValueKey('air-schedules')), findsOneWidget);
    expect(find.text('1 条规则'), findsOneWidget);
    expect(find.text('每日巡检'), findsWidgets);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    client.close();
  });

  testWidgets('「全部功能」里的定时任务也走同一个原生页', (tester) async {
    final settings = await _settings();
    final client = _airAndCronClient();
    final opened = <WorkspaceDestination>[];
    await tester.pumpWidget(
      MaterialApp(
        home: AirTasksView(
          settings: settings,
          httpClient: client,
          onOpenDestination: opened.add,
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('air-menu-button')));
    await tester.pumpAndSettle();
    await tapInSidebar(tester, find.byKey(const ValueKey('air-more-section')));
    await tapInSidebar(tester, find.text('全部功能'));
    await tester.tap(find.byKey(const ValueKey('air-dest-cron')));
    await tester.pumpAndSettle();

    // 宿主那条老路由一次都没被叫到 —— 定时任务在 Air 里只有这一个落点。
    expect(opened, isEmpty);
    expect(find.byKey(const ValueKey('air-schedules')), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    client.close();
  });

  testWidgets('侧栏的「全部功能」能进到老抽屉里那些页面，语音通话按宿主决定', (tester) async {
    final settings = await _settings();
    final client = _client(<String>[]);
    final opened = <WorkspaceDestination>[];
    await tester.pumpWidget(
      MaterialApp(
        home: AirTasksView(
          settings: settings,
          httpClient: client,
          onOpenDestination: opened.add,
          onOpenVoiceCall: () {},
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('air-menu-button')));
    await tester.pumpAndSettle();
    // 展开「更多与系统」，原生独占的语音通话就摆在这里。
    await tapInSidebar(tester, find.byKey(const ValueKey('air-more-section')));
    expect(find.text('全部功能'), findsOneWidget);
    expect(find.text('语音通话 · BETA'), findsOneWidget);

    await tapInSidebar(tester, find.text('全部功能'));
    expect(find.byKey(const ValueKey('air-all-destinations')), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('air-dest-push')));
    await tester.pumpAndSettle();
    expect(opened, [WorkspaceDestination.push]);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    client.close();
  });

  testWidgets('宿主不给语音入口时，侧栏就不出现这一行', (tester) async {
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
    await tapInSidebar(tester, find.byKey(const ValueKey('air-more-section')));
    expect(find.text('全部功能'), findsOneWidget);
    expect(find.text('语音通话 · BETA'), findsNothing);
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

  testWidgets('任务行上的详情按钮升起详情面板，进对话是另一步', (tester) async {
    final settings = await _settings();
    final requests = <String>[];
    final client = _client(requests);
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(390, 844);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(
      MaterialApp(
        home: AirTasksView(settings: settings, httpClient: client),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('air-task-details-t1')));
    await tester.pumpAndSettle();

    // 面板自己拉一次详情 —— 任务行那份快照里没有 attribution / execution。
    expect(
      requests.where((path) => path.startsWith('/api/air')),
      ['/api/air', '/api/air/tasks/t1'],
    );
    expect(find.byKey(const ValueKey('air-details-panel')), findsOneWidget);
    // 计划任务还没发第一条消息：交付卡说的是「计划尚未执行」，不是「任务已就绪」。
    expect(find.text('计划尚未执行'), findsOneWidget);
    expect(
      find.byKey(const ValueKey('air-details-open-conversation')),
      findsOneWidget,
    );
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    client.close();
  });

  // Web `#task-tools` 的可见性由 `air.js:935-937` 按视图切换：目录库才给
  // 「添加工作目录」，定时任务视图才给「新建定时任务」，没打开任务时才给
  // 「打开完整任务看板」；「刷新」一直挂着。App 这边跟着同一套规矩走，但整条
  // 工具条只在够宽时摆出来 —— Web 的 `air.css` 760px 块在窄屏上就是整条收进 ⋯。
  testWidgets('宽屏下任务头部工具条按视图换，刷新一直都在', (tester) async {
    final settings = await _settings();
    final client = _client(<String>[]);
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(900, 800);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(
      MaterialApp(
        home: AirTasksView(settings: settings, httpClient: client),
      ),
    );
    await tester.pumpAndSettle();

    // 默认落在某个目录上：给的是看板，不是目录管理那两件。
    expect(find.byKey(const ValueKey('air-tool-board')), findsOneWidget);
    expect(find.byKey(const ValueKey('air-tool-refresh')), findsOneWidget);
    expect(find.byKey(const ValueKey('air-tool-add-directory')), findsNothing);
    expect(find.byKey(const ValueKey('air-tool-schedules')), findsNothing);

    // 换到目录库：看板收走，目录与定时任务那两件摆出来。
    await tester.tap(find.byKey(const ValueKey('air-header-menu')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('工作目录库'));
    await tester.pumpAndSettle();

    expect(find.byKey(const ValueKey('air-tool-board')), findsNothing);
    expect(
      find.byKey(const ValueKey('air-tool-add-directory')),
      findsOneWidget,
    );
    expect(find.byKey(const ValueKey('air-tool-schedules')), findsOneWidget);
    expect(find.byKey(const ValueKey('air-tool-refresh')), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    client.close();
  });

  testWidgets('窄屏（手机）工具条整条收进 ⋯，但一件都没少', (tester) async {
    final settings = await _settings();
    final client = _client(<String>[]);
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(390, 844);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(
      MaterialApp(
        home: AirTasksView(settings: settings, httpClient: client),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.byKey(const ValueKey('air-tool-board')), findsNothing);
    expect(find.byKey(const ValueKey('air-tool-refresh')), findsNothing);

    await tester.tap(find.byKey(const ValueKey('air-header-menu')));
    await tester.pumpAndSettle();
    // Web 那边「菜单保留完整列表」：收起来的那几件在这里一件不少。
    expect(find.text('打开完整任务看板'), findsOneWidget);
    expect(find.text('添加工作目录'), findsOneWidget);
    expect(find.text('定时任务'), findsOneWidget);
    expect(find.text('刷新'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    client.close();
  });

  testWidgets('宽屏下工具条上的刷新真的再问一次快照', (tester) async {
    final settings = await _settings();
    final requests = <String>[];
    final client = _client(requests);
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(900, 800);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(
      MaterialApp(
        home: AirTasksView(settings: settings, httpClient: client),
      ),
    );
    await tester.pumpAndSettle();
    final before = requests.where((p) => p == '/api/air').length;

    await tester.tap(find.byKey(const ValueKey('air-tool-refresh')));
    await tester.pumpAndSettle();

    expect(requests.where((p) => p == '/api/air').length, before + 1);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    client.close();
  });

  testWidgets('侧栏的「＋ 新任务」开的是统一输入框，不是把首页切回来', (tester) async {
    final settings = await _settings();
    final requests = <String>[];
    final client = _client(requests);
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(390, 844);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(
      MaterialApp(
        home: AirTasksView(settings: settings, httpClient: client),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('air-menu-button')));
    await tester.pumpAndSettle();
    await tapInSidebar(tester, find.text('新任务'));

    // 开出来的是目录首页那一个统一输入框模块本身 —— AI 配置和角色都在同一套
    // 胶囊里，提交就是那颗「创建并执行」。旧的简易表单（任务名称 / 模型 / 角色
    // 文本框）已经整块删掉，不再有第二份实现。
    final sheet = find.byType(BottomSheet);
    expect(
      find.descendant(
        of: sheet,
        matching: find.byKey(const ValueKey('air-quick-input')),
      ),
      findsOneWidget,
    );
    expect(
      find.descendant(
        of: sheet,
        matching: find.byKey(const ValueKey('air-quick-ai')),
      ),
      findsOneWidget,
      reason: '选模型选线路的那颗胶囊跟着一起来',
    );
    expect(
      find.descendant(
        of: sheet,
        matching: find.byKey(const ValueKey('air-quick-role')),
      ),
      findsOneWidget,
    );
    expect(
      find.descendant(of: sheet, matching: find.text('创建并执行 ↑')),
      findsOneWidget,
    );
    expect(find.byKey(const ValueKey('air-new-task-title')), findsNothing);
    expect(find.text('任务名称'), findsNothing);
    // 弹层里那句目录路径取的是当前目录。
    expect(
      tester
          .widget<Text>(find.byKey(const ValueKey('air-new-task-directory')))
          .data,
      '/project/a',
    );
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    client.close();
  });

  /// 从弹层创建走的是首页那条同一条流水线（[_createFromComposer]）：这段话既是
  /// 任务名也是第一条消息。跑完了这一层就该收掉 —— **哪怕快照还没反映出新任务**
  /// （服务端有延迟），因为「收不收」说的是草稿交出去没有，不是快照更没更新。
  /// 留着一层空输入框压在页面上才是真的错。
  testWidgets('从弹层创建：交出去之后这一层就收掉，不等快照', (tester) async {
    final settings = await _settings();
    final posts = <String>[];
    final client = _createFromSheetClient(posts, firstMessageOk: true);
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(390, 844);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(
      MaterialApp(home: AirTasksView(settings: settings, httpClient: client)),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('air-menu-button')));
    await tester.pumpAndSettle();
    await tapInSidebar(tester, find.text('新任务'));

    await tester.enterText(
      find.descendant(
        of: find.byType(BottomSheet),
        matching: find.byKey(const ValueKey('air-quick-input')),
      ),
      '把登录页的错误提示改清楚',
    );
    // 首页那一片还挂在弹层后面（同一个模块的另一个实例），提交要认弹层里那颗。
    await tester.tap(
      find.descendant(
        of: find.byType(BottomSheet),
        matching: find.byKey(const ValueKey('air-quick-submit')),
      ),
    );
    await tester.pumpAndSettle();

    expect(posts, contains('/api/air/tasks'), reason: '任务建出去了');
    expect(
      posts,
      contains('/api/task-shell-tasks/t9/messages'),
      reason: '第一条消息就是这段话',
    );
    expect(find.byType(BottomSheet), findsNothing, reason: '交出去了就收掉');
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    client.close();
  });

  /// 任务建出来了、第一条消息没送到：这一份草稿同样已经有归属了（服务端认得它，
  /// 人也该进去看），所以这一层照样收掉 —— 留在屏幕上只会让人以为白点了，
  /// 而同 Web 一样，两条路径都关。
  testWidgets('第一条消息没送到：任务已经建了，这一层也收掉', (tester) async {
    final settings = await _settings();
    final posts = <String>[];
    final client = _createFromSheetClient(posts, firstMessageOk: false);
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(390, 844);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(
      MaterialApp(home: AirTasksView(settings: settings, httpClient: client)),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('air-menu-button')));
    await tester.pumpAndSettle();
    await tapInSidebar(tester, find.text('新任务'));

    await tester.enterText(
      find.descendant(
        of: find.byType(BottomSheet),
        matching: find.byKey(const ValueKey('air-quick-input')),
      ),
      '这条会卡在第一条消息上',
    );
    await tester.tap(
      find.descendant(
        of: find.byType(BottomSheet),
        matching: find.byKey(const ValueKey('air-quick-submit')),
      ),
    );
    await tester.pumpAndSettle();

    expect(posts, contains('/api/air/tasks'), reason: '任务建出去了');
    expect(
      posts,
      contains('/api/task-shell-tasks/t9/messages'),
      reason: '第一条消息发过一次（没成）',
    );
    expect(
      find.byType(BottomSheet),
      findsNothing,
      reason: '任务已经有归属了，这一层留着只会让人以为白点了',
    );
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    client.close();
  });
}
