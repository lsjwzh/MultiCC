import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/services/onboarding_store.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/widgets/air/air_sidebar.dart';
import 'package:multicc_app/widgets/air/air_task_actions.dart';
import 'package:multicc_app/widgets/air_tasks_view.dart';
import 'package:multicc_app/widgets/workspace_navigation_drawer.dart';

/// 一份两目录两任务的快照：d1 里有一条未完成的、一条归档的，d2 空着。
/// `/api/air/tasks/:id` 是另一套形状（多了 attribution / execution），单独给。
MockClient _client(
  List<String> requests, {
  bool lidSleepAvailable = false,
  bool lidSleepEnabled = false,
  List<String>? lidSleepPosts,
}) => MockClient((request) async {
  requests.add(request.url.path);
  // 关盖运行（macOS 电源）：Web 侧栏「常用设置」那一行、以及设置中心 › 全局配置
  // 那个开关，打的是同一条接口。默认这台主机没有这个能力（非 macOS 给的答案就是
  // available:false），要测那一行时再把这个能力打开。
  if (request.url.path == '/api/settings/power') {
    var enabled = lidSleepEnabled;
    if (request.method == 'POST') {
      lidSleepPosts?.add(request.body);
      enabled = (jsonDecode(request.body) as Map)['enabled'] == true;
    }
    return http.Response(
      jsonEncode({
        'ok': true,
        'available': lidSleepAvailable,
        'enabled': lidSleepAvailable && enabled,
      }),
      200,
      headers: {'content-type': 'application/json; charset=utf-8'},
    );
  }
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

/// 一个目录八条任务。用来盯首页抬头上那句「N 个任务」和它下面那块**截过的**
/// 「最近任务」—— Web 的 `recentRowLimit()` 在 760px 及以下取 6，`updatedAt`
/// 倒序（`air.js` 的 `[...tasks].sort((a, b) => Number(b.updatedAt || 0) - ...)`），
/// 所以屏上该是任务 8…3，「查看全部」说的是 8 而不是剩下的 2。
MockClient _manyTasksClient() => MockClient((request) async {
  if (request.url.path.startsWith('/api/air/tasks/')) {
    return http.Response(
      jsonEncode({
        'ok': true,
        'task': const {'id': 't1', 'title': '任务 1', 'status': 'active'},
        'status': 'active',
        'execution': const {'status': 'idle', 'busy': false, 'pending': false},
        'messages': const [],
        'attribution': const {},
        'resource': const {'residency': 'planned', 'lease': 'idle'},
        'configuration': const {},
        'readOnly': false,
      }),
      200,
      headers: {'content-type': 'application/json; charset=utf-8'},
    );
  }
  return http.Response(
    jsonEncode({
      'ok': true,
      'clis': const ['codex'],
      'directories': const [
        {'id': 'd1', 'name': '工作目录 A', 'path': '/project/a'},
      ],
      'tasks': [
        for (var i = 1; i <= 8; i++)
          {
            'id': 't$i',
            'dirId': 'd1',
            'title': '任务 $i',
            'status': 'active',
            'recordType': 'planned',
            'workflowStage': 'inbox',
            'runState': null,
            'updatedAt': 1000 + i,
            'resource': const {'residency': 'planned', 'lease': 'idle'},
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
        {'id': 'd2', 'name': '工作目录 B', 'path': '/project/b'},
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
  List<Map<String, dynamic>>? createBodies,
}) => MockClient((request) async {
  const headers = {'content-type': 'application/json; charset=utf-8'};
  if (request.method == 'POST') {
    posts.add(request.url.path);
    if (request.url.path == '/api/air/tasks') {
      createBodies?.add(
        (jsonDecode(request.body) as Map).cast<String, dynamic>(),
      );
    }
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
        {'id': 'd2', 'name': '工作目录 B', 'path': '/project/b'},
      ],
      'tasks': const [],
    }),
    200,
    headers: headers,
  );
});

/// Pin 住的任务：那份清单住在服务端（`air-pins.json`），Web 和 App 读同一份。
/// 这个桩把两件事分开说清楚 —— 快照里的 `taskPins` 是「钉了哪些」，POST
/// `/api/air/pins/toggle` 是唯一的写。第 6 个回 409，让界面把话原样说给用户。
MockClient _pinsClient(
  List<String> calls,
  List<Map<String, dynamic>> bodies, {
  required List<String> pins,
  List<String>? afterToggle,
  int toggleStatus = 200,
  String toggleMessage = '最多只能 Pin 5 个任务',
}) {
  const headers = {'content-type': 'application/json; charset=utf-8'};
  var current = pins;
  return MockClient((request) async {
    calls.add('${request.method} ${request.url.path}');
    if (request.url.path == '/api/air/pins/toggle') {
      bodies.add(jsonDecode(request.body) as Map<String, dynamic>);
      if (toggleStatus >= 400) {
        return http.Response(
          jsonEncode({'ok': false, 'code': 'pin_limit_reached', 'message': toggleMessage}),
          toggleStatus,
          headers: headers,
        );
      }
      current = afterToggle ?? pins;
      return http.Response(
        jsonEncode({'ok': true, 'taskIds': current}),
        200,
        headers: headers,
      );
    }
    // 六条任务：t1 最新，t6 最旧。pin 的那几条必须排在最前面，跟 updatedAt 无关。
    return http.Response(
      jsonEncode({
        'ok': true,
        'clis': const ['codex'],
        'directories': const [
          {'id': 'd1', 'name': '工作目录 A', 'path': '/project/a'},
        ],
        'taskPins': current,
        'tasks': [
          for (var i = 1; i <= 6; i++)
            {
              'id': 't$i',
              'dirId': 'd1',
              'title': '任务 $i',
              'status': 'active',
              'recordType': 'planned',
              'workflowStage': 'inbox',
              'runState': null,
              'updatedAt': 1000 - i,
              'resource': const {'residency': 'planned', 'lease': 'idle'},
            },
        ],
      }),
      200,
      headers: headers,
    );
  });
}

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

  testWidgets('Air 首页列出当前目录的最近任务（含归档行），320px 不溢出', (tester) async {
    final settings = await _settings();
    final requests = <String>[];
    final client = _client(requests);
    tester.view.devicePixelRatio = 1;
    // 视口比 800 高一截：任务行现在标题占一行（徽标挪到副行），一行比从前高十几
    // 像素，800 高的屏上第二条正好落到视口外 —— 而这条用例要断的「归档行也在树上」
    // 跟屏高无关，列表本来就会滚。
    tester.view.physicalSize = const Size(320, 900);
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
    // 抬头照 Web 的 `.section-heading`：小字「当前目录」+ 粗体「最近任务」+ 右侧计数。
    expect(find.byKey(const ValueKey('air-tasks-heading')), findsOneWidget);
    expect(find.text('最近任务'), findsOneWidget);
    expect(find.text('2 个任务'), findsOneWidget);
    // Web 的这块列表只按 dirId 过，归档行照摆（`renderDirectoryOverview` 里那道
    // `done/archived` 过滤只用在上面四张统计卡上），所以「旧任务」在「最近任务」
    // 里就该看得见 —— 从前这里默认把它藏起来，只留两条筛选 chip。
    expect(find.text('旧任务'), findsOneWidget);
    // 两条都摆得下，那颗「查看全部」就不出现（Web 的 `more.hidden = tasks.length
    // <= rows.length`）。
    expect(find.byKey(const ValueKey('air-tasks-more')), findsNothing);
    expect(tester.takeException(), isNull);
    // 首页只问一次 /api/air —— 目录库、侧栏、统计都从这一份快照里出。（侧栏底部
    // 的主机运维是另一条线，它自己问 /api/server-info 和 /api/version-check。）
    expect(requests.where((path) => path.startsWith('/api/air')), ['/api/air']);

    await tester.tap(find.byKey(const ValueKey('air-task-delete-t1')));
    await tester.pumpAndSettle();
    expect(find.text('删除任务「登录页面」？'), findsOneWidget);
    await tester.tap(
      find.byKey(const ValueKey('air-directory-t1-delete-confirm-ok')),
    );
    await tester.pumpAndSettle();
    expect(requests, contains('/api/task-board/tasks/t1'));
    await tester.pumpWidget(const SizedBox());
    client.close();
  });

  testWidgets('任务行的宽度归标题：徽标不占左列，行尾操作不再撑回 48px', (tester) async {
    // 用户报的是这张图：窄屏上「最近任务」的标题被折成两条还读不完。根因有两处，
    // 各断一次 —— 徽标曾经独占一列（左边 78px），而行尾三颗 IconButton 每颗都被
    // MaterialTapTargetSize.padded 撑到 48px（一共 144px），390px 的屏上留给标题
    // 的只剩 90 来 px。标题是这一行里唯一必须读全的东西，这两处都不该跟它抢宽度。
    final settings = await _settings();
    final client = _manyTasksClient();
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(390, 1200);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(
      MaterialApp(
        home: AirTasksView(settings: settings, httpClient: client),
      ),
    );
    await tester.pumpAndSettle();

    final tile = find.byKey(const ValueKey('air-directory-task-t8'));
    expect(tile, findsOneWidget);
    final tileWidth = tester.getSize(tile).width;
    final titleWidth = tester
        .getSize(find.byKey(const ValueKey('air-task-title-t8')))
        .width;
    // 行尾只剩三颗 42px 的操作（126px）加 4px 间隙，其余全给标题。
    expect(titleWidth, greaterThan(tileWidth - 3 * AirTaskRowAction.size - 30));
    expect(
      titleWidth,
      greaterThan(tileWidth / 2),
      reason: '标题该拿到这一行一半以上的宽度（实测 $titleWidth / $tileWidth）',
    );
    for (final prefix in ['air-task-pin', 'air-task-details', 'air-task-delete']) {
      final size = tester.getSize(find.byKey(ValueKey('$prefix-t8')));
      expect(
        size,
        const Size(AirTaskRowAction.size, AirTaskRowAction.size),
        reason: '行尾操作不许被 padded 撑回 48px',
      );
    }
    // 徽标跟副行同一行（标题那一行只有标题）。它得在标题行的下边。
    final badge = find.descendant(of: tile, matching: find.text('空闲'));
    expect(badge, findsOneWidget);
    expect(
      tester.getTopLeft(badge).dy,
      greaterThan(tester.getTopLeft(find.byKey(const ValueKey('air-task-title-t8'))).dy),
    );
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    client.close();
  });

  testWidgets('最近的条数跟着屏宽截断，剩下的走「查看全部 N 个任务」', (tester) async {
    final settings = await _settings();
    final client = _manyTasksClient();
    tester.view.devicePixelRatio = 1;
    // 视口给高一点，让整块面板（统计卡 + 输入框 + 抬头 + 六行 + 那颗按钮）一次全
    // 在树上：列表是懒建的，靠滚动去够某一行，会把「被截掉」和「在视口外」混成
    // 同一件事。
    tester.view.physicalSize = const Size(390, 1600);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(
      MaterialApp(
        home: AirTasksView(settings: settings, httpClient: client),
      ),
    );
    await tester.pumpAndSettle();

    // 抬头上的数字说的是这个目录一共几条，不是这一屏摆得下几条。
    expect(find.text('最近任务'), findsOneWidget);
    expect(find.text('8 个任务'), findsOneWidget);
    // 行序是 updatedAt 倒序，最新的一条排在最前（`AirSnapshot.tasksOf`）。
    expect(find.text('任务 8'), findsOneWidget);
    expect(find.text('任务 7'), findsOneWidget);
    // 窄屏截到六行（Web `recentRowLimit()` 的 760px 断点）：第 1、2 条不在树上。
    expect(find.text('任务 2'), findsNothing);
    expect(find.text('任务 1'), findsNothing);

    final more = find.byKey(const ValueKey('air-tasks-more'));
    expect(more, findsOneWidget);
    // 数字用的是这个目录的全部条数 —— Web 那句 `查看全部 ${tasks.length} 个任务 ›`。
    expect(find.text('查看全部 8 个任务 ›'), findsOneWidget);
    await tester.tap(more);
    await tester.pumpAndSettle();

    // 展开之后就是全量那几行，抬头跟着换名字，按钮翻面。
    expect(find.text('全部任务'), findsOneWidget);
    expect(find.text('收起，返回最近任务'), findsOneWidget);
    expect(
      find.byKey(const ValueKey('air-directory-task-search')),
      findsOneWidget,
    );
    expect(
      find.byKey(const ValueKey('air-directory-task-status')),
      findsOneWidget,
    );
    expect(
      find.byKey(const ValueKey('air-directory-task-scroll')),
      findsOneWidget,
    );
    final expandedList = tester.widget<ListView>(
      find.descendant(
        of: find.byKey(const ValueKey('air-directory-task-scroll')),
        matching: find.byType(ListView),
      ),
    );
    expect(expandedList.semanticChildCount, 8);
    expect(find.text('8 / 8 个任务'), findsOneWidget);

    await tester.tap(more);
    await tester.pumpAndSettle();
    expect(find.text('最近任务'), findsOneWidget);
    expect(find.text('任务 1'), findsNothing);
    expect(tester.takeException(), isNull);
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
      MaterialApp(
        home: AirTasksView(settings: settings, httpClient: client),
      ),
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
    // 侧栏那一组叫「最近任务」，首页抬头那块也叫「最近任务」（Web 上就是同一个
    // 词，`air.html` 的 `.section-heading` 与侧栏各一处），所以这里圈定抽屉里那份。
    expect(
      find.descendant(of: find.byType(Drawer), matching: find.text('最近任务')),
      findsOneWidget,
    );
    expect(find.text('新任务'), findsOneWidget);
    expect(find.text('更多与系统'), findsOneWidget);
    // 最近打开过的任务优先：这次会话没打开过任何任务，补位的是当前目录里
    // 最近更新过的那条。
    expect(find.byKey(const ValueKey('air-side-task-t1')), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    client.close();
  });

  // Pin 住的任务在 App 里就是侧栏「最近任务」的最上面那几条（Web 是页头顶上那排
  // tab；手机宽度的 Web 也是走这一份列表）。上限 5 个由服务端把着，界面不自己算。
  testWidgets('Pin 住的任务排在最近任务的最前面，并带着钉标记', (tester) async {
    final settings = await _settings();
    final client = _pinsClient(<String>[], [], pins: const ['t5']);
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

    // 钉住的 t5 排在 t1 上面 —— t1 才是 updatedAt 最新的那一条。
    final pinnedRow = find.byKey(const ValueKey('air-side-task-t5'));
    final newestRow = find.byKey(const ValueKey('air-side-task-t1'));
    expect(pinnedRow, findsOneWidget);
    expect(
      tester.getTopLeft(pinnedRow).dy < tester.getTopLeft(newestRow).dy,
      isTrue,
      reason: 'pin 住的那条排在最近任务的最上面',
    );
    expect(
      find.descendant(of: pinnedRow, matching: find.byIcon(Icons.push_pin_rounded)),
      findsOneWidget,
    );
    // 没钉住的那条没有标记（标记说的是「它为什么排在这儿」）。
    expect(
      find.descendant(of: newestRow, matching: find.byIcon(Icons.push_pin_rounded)),
      findsNothing,
    );
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    client.close();
  });

  testWidgets('点任务行上的 📌 会写服务端，顺序按服务端回来的清单走', (tester) async {
    final settings = await _settings();
    final calls = <String>[];
    final bodies = <Map<String, dynamic>>[];
    final client = _pinsClient(
      calls,
      bodies,
      pins: const ['t4'],
      afterToggle: const ['t4', 't1'],
    );
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
    await tester.tap(find.byKey(const ValueKey('air-task-pin-t1')));
    await tester.pumpAndSettle();
    expect(calls, contains('POST /api/air/pins/toggle'));
    expect(bodies.single, {'taskId': 't1'});
    expect(find.text('已 Pin 住「任务 1」'), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('air-menu-button')));
    await tester.pumpAndSettle();
    // 服务端回来的顺序是 [t4, t1]，不是客户端按 updatedAt 排的 [t1, t4]。
    expect(
      tester.getTopLeft(find.byKey(const ValueKey('air-side-task-t4'))).dy <
          tester.getTopLeft(find.byKey(const ValueKey('air-side-task-t1'))).dy,
      isTrue,
    );
    expect(
      find.descendant(
        of: find.byKey(const ValueKey('air-side-task-t1')),
        matching: find.byIcon(Icons.push_pin_rounded),
      ),
      findsOneWidget,
    );
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    client.close();
  });

  testWidgets('第六个 pin 被服务端拒绝：那句话原样说给用户，按钮不装成已钉', (tester) async {
    final settings = await _settings();
    final calls = <String>[];
    final bodies = <Map<String, dynamic>>[];
    final client = _pinsClient(
      calls,
      bodies,
      // 五条已经钉满；t1 是没钉的那一条（也是首页第一行，一定在屏上）。
      pins: const ['t2', 't3', 't4', 't5', 't6'],
      toggleStatus: 409,
    );
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
    await tester.tap(find.byKey(const ValueKey('air-task-pin-t1')));
    await tester.pumpAndSettle();
    expect(find.text('最多只能 Pin 5 个任务'), findsOneWidget);
    expect(
      find.descendant(
        of: find.byKey(const ValueKey('air-task-pin-t1')),
        matching: find.byIcon(Icons.push_pin_outlined),
      ),
      findsOneWidget,
      reason: '被拒绝的那条不该变成「已钉」',
    );
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
      MaterialApp(
        home: AirTasksView(settings: settings, httpClient: client),
      ),
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
    expect(find.byKey(const ValueKey('air-console-urgent-t1')), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    client.close();
  });

  testWidgets('侧栏的「定时任务」进原生中心，新建时默认当前目录', (tester) async {
    final settings = await _settings();
    final client = _airAndCronClient();
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
    await tester.tap(find.byKey(const ValueKey('air-directory-d2')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('air-menu-button')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('定时任务'));
    await tester.pumpAndSettle();

    // 不再是网页那一页，也不再是老抽屉里的那个只认 CLI 的页面。
    expect(find.byKey(const ValueKey('air-schedules')), findsOneWidget);
    expect(find.text('1 条规则'), findsOneWidget);
    expect(find.text('每日巡检'), findsWidgets);
    await tester.tap(find.byKey(const ValueKey('air-schedules-new')));
    await tester.pumpAndSettle();
    expect(
      tester
          .widget<DropdownButtonFormField<String>>(
            find.byKey(const ValueKey('air-schedule-dir')),
          )
          .initialValue,
      'd2',
    );
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

  testWidgets('「更多与系统」补齐 Web 侧栏那一行「任务图谱」', (tester) async {
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

    // Web `air.html` 的 `#side-more .global-links` 是四项：
    // 服务与文档 / 记忆图谱 / 任务图谱 / 设置中心。
    expect(find.byKey(const ValueKey('air-more-task-graph')), findsOneWidget);
    expect(find.text('任务图谱'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    client.close();
  });

  testWidgets('常用设置：两列排布、Provider 加粗，四个入口一个不少', (tester) async {
    final settings = await _settings();
    final opened = <WorkspaceDestination>[];
    final client = _client(
      <String>[],
      lidSleepAvailable: true,
      lidSleepEnabled: false,
    );
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

    // Web 的 `#frequent-settings` 是四条：Provider 配置 / 外网穿透 / 消息桥接 /
    // 关盖运行（最后一条只在 macOS 那台主机上出现）。
    final provider = tester.getRect(
      find.byKey(const ValueKey('air-more-provider')),
    );
    final tunnel = tester.getRect(find.byKey(const ValueKey('air-more-tunnel')));
    final bridges = tester.getRect(
      find.byKey(const ValueKey('air-more-bridges')),
    );
    final lid = tester.getRect(
      find.byKey(const ValueKey('air-more-lid-sleep')),
    );
    // 两列：同行两格并排、下一格换行，每格只有半栏宽 —— 一列那套尺寸排不下
    // 「Provider 配置」，两列才要求它窄到刚好一行。
    expect(tunnel.left, greaterThan(provider.right - 1));
    expect((tunnel.top - provider.top).abs(), lessThan(1));
    expect(bridges.left, closeTo(provider.left, 1));
    expect(bridges.top, greaterThan(provider.top + 10));
    expect(lid.left, closeTo(tunnel.left, 1));
    expect(provider.width, lessThan(AirSidebar.width / 2));
    // Provider 配置是这一组里最重的一行：字重比旁边那格高，颜色也更实。
    expect(
      tester
          .widget<Text>(
            find.descendant(
              of: find.byKey(const ValueKey('air-more-provider')),
              matching: find.text('Provider 配置'),
            ),
          )
          .style
          ?.fontWeight,
      FontWeight.w700,
    );
    expect(
      tester
          .widget<Text>(
            find.descendant(
              of: find.byKey(const ValueKey('air-more-tunnel')),
              matching: find.text('外网穿透'),
            ),
          )
          .style
          ?.fontWeight,
      FontWeight.w500,
    );
    // 点一下就交给宿主去开那一页（这几行就是老抽屉里的目的地）。
    await tapInSidebar(tester, find.text('外网穿透'));
    expect(opened, [WorkspaceDestination.tunnel]);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    client.close();
  });

  testWidgets('更多与系统：每组各套一个框，全局页那四行自成一格', (tester) async {
    final settings = await _settings();
    final client = _client(<String>[], lidSleepAvailable: true);
    await tester.pumpWidget(
      MaterialApp(
        home: AirTasksView(
          settings: settings,
          httpClient: client,
          onOpenVoiceCall: () {},
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('air-menu-button')));
    await tester.pumpAndSettle();
    await tapInSidebar(tester, find.byKey(const ValueKey('air-more-section')));

    // TERMINAL 那一组已经不在这里了：终端属于每个目录，走目录页顶部的
    // Chat / Terminal 切换（`air_directory_mode_test.dart` 盯那一边）。
    for (final group in const [
      'air-group-frequent',
      'air-group-global',
      'air-group-entries',
      'air-group-host',
    ]) {
      expect(find.byKey(ValueKey(group)), findsOneWidget, reason: group);
    }
    // 「服务与文档 / 记忆图谱 / 任务图谱 / 设置中心」四行同框，别的一行都不在。
    final global = tester.getRect(find.byKey(const ValueKey('air-group-global')));
    for (final row in const [
      'air-more-docs',
      'air-more-memory',
      'air-more-task-graph',
      'air-more-settings',
    ]) {
      final rect = tester.getRect(find.byKey(ValueKey(row)));
      expect(global.contains(rect.topLeft), isTrue, reason: row);
      expect(global.contains(rect.bottomRight), isTrue, reason: row);
    }
    expect(
      global.contains(
        tester.getRect(find.byKey(const ValueKey('air-more-board'))).topLeft,
      ),
      isFalse,
    );
    // 每一格都套在各自那个框里：框比行宽，四边都留得下那一条淡边。
    final provider = tester.getRect(
      find.byKey(const ValueKey('air-more-provider')),
    );
    final frequent = tester.getRect(
      find.byKey(const ValueKey('air-group-frequent')),
    );
    expect(frequent.left, lessThan(provider.left));
    expect(frequent.right, greaterThan(provider.right));
    // 四个框互不重叠地一路排下去（同一条竖线上，一个接一个）。
    final boxes = [
      'air-group-frequent',
      'air-group-global',
      'air-group-entries',
      'air-group-host',
    ].map((k) => tester.getRect(find.byKey(ValueKey(k)))).toList();
    for (var i = 1; i < boxes.length; i++) {
      expect(boxes[i].top, greaterThanOrEqualTo(boxes[i - 1].bottom - 1));
    }
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    client.close();
  });

  testWidgets('常用设置可以收起来：默认展开，点标题只剩一行', (tester) async {
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

    final tile = find.byKey(const ValueKey('air-more-frequent'));
    final expanded = tester.getSize(tile).height;
    await tapInSidebar(tester, find.text('常用设置'));
    // 收起后这一栏只剩标题：里面那两行入口不再占高度（Web 那边量 checkVisibility，
    // Flutter 这边量这一栏自己的高度，说的是同一件事）。
    expect(tester.getSize(tile).height, lessThan(expanded - 40));
    await tapInSidebar(tester, find.text('常用设置'));
    expect(tester.getSize(tile).height, closeTo(expanded, 1));
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    client.close();
  });

  testWidgets('关盖运行：主机不是 macOS 就不出现，是 macOS 就能直接切', (tester) async {
    // ① 非 macOS：整行不出现，不留一个点了没反应的开关。
    final settings = await _settings();
    final posts = <String>[];
    var client = _client(<String>[], lidSleepPosts: posts);
    await tester.pumpWidget(
      MaterialApp(
        home: AirTasksView(settings: settings, httpClient: client),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('air-menu-button')));
    await tester.pumpAndSettle();
    await tapInSidebar(tester, find.byKey(const ValueKey('air-more-section')));
    expect(find.byKey(const ValueKey('air-more-lid-sleep')), findsNothing);
    await tester.pumpWidget(const SizedBox());
    client.close();

    // ② macOS：这一行在，点一下就把开关翻过去（写的是取反后的值），回执落在
    // 折叠区外那一行上 —— 和设置中心 › 全局配置里那个开关是同一条接口。
    client = _client(<String>[], lidSleepAvailable: true, lidSleepPosts: posts);
    await tester.pumpWidget(
      MaterialApp(
        home: AirTasksView(settings: settings, httpClient: client),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('air-menu-button')));
    await tester.pumpAndSettle();
    await tapInSidebar(tester, find.byKey(const ValueKey('air-more-section')));
    await tapInSidebar(tester, find.byKey(const ValueKey('air-more-lid-sleep')));
    expect(posts, ['{"enabled":true}']);
    expect(find.text('已开启关盖保持运行'), findsOneWidget);
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
    expect(requests.where((path) => path.startsWith('/api/air')), [
      '/api/air',
      '/api/air/tasks/t1',
    ]);
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
    // 弹层默认当前目录，但给用户留下切换余地。
    expect(
      tester
          .widget<DropdownButtonFormField<String>>(
            find.byKey(const ValueKey('air-new-task-directory')),
          )
          .initialValue,
      'd1',
    );
    expect(
      tester
          .widget<Text>(
            find.byKey(const ValueKey('air-new-task-directory-path')),
          )
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
    final createBodies = <Map<String, dynamic>>[];
    final client = _createFromSheetClient(
      posts,
      firstMessageOk: true,
      createBodies: createBodies,
    );
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

    await tester.tap(
      find.descendant(
        of: find.byType(BottomSheet),
        matching: find.byKey(const ValueKey('air-new-task-directory')),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('工作目录 B').last);
    await tester.pumpAndSettle();

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
    expect(createBodies.single['dirId'], 'd2', reason: '下拉选择的目录要进入创建请求');
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
      MaterialApp(
        home: AirTasksView(settings: settings, httpClient: client),
      ),
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
