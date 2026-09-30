import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/services/air_service.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/theme.dart';
import 'package:multicc_app/widgets/air/air_console.dart';
import 'package:multicc_app/widgets/workspace_navigation_drawer.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// 控制台现在是 Air 首页主区里的一页正文（`AirConsoleBody`），不是一条自己 push
/// 的路由：没有 Scaffold，也没有自己的 AppBar。数据仍然只有两份 —— `/api/air`
/// 那份快照（任务 + 目录）和 `/api/cron`。
///
/// 这一页的形状照 Web `public/air-admin.js` 的 `renderOverview`：五个可点选的统计
/// 格 → 一行小字 → 点开哪一格就在原地长出来的清单 → 工作目录 → AI Assistant →
/// 工具格。默认什么都不展开：第一眼是数字，不是一堵清单墙。
MockClient _client(
  List<String> requests, {
  List<Map<String, dynamic>>? tasks,
  List<Map<String, dynamic>>? schedules,
  int directories = 2,
  bool schedulesFail = false,
  List<String> searchHits = const [],
  bool searchFails = false,
  bool Function()? auxConfigured,
  Map<String, dynamic>? cliAvailability,
  bool installSpecsFail = false,
}) => MockClient((request) async {
  const headers = {'content-type': 'application/json; charset=utf-8'};
  final path = request.url.path;
  // 记录带查询串的完整路径：控制台那一份检索是**跨目录**的，它不传 dirId 这件事
  // 只能从请求本身看出来（见「服务端命中」那条用例）。
  requests.add(
    request.url.query.isEmpty ? path : '$path?${request.url.query}',
  );
  if (path == '/api/cron') {
    if (schedulesFail) return http.Response('nope', 500);
    return http.Response(
      jsonEncode(schedules ?? const []),
      200,
      headers: headers,
    );
  }
  // 首启配置卡的那一眼：`/api/aux/config` 里有没有 providerId。默认「已配置」
  // —— 除了专测那张卡的用例，其余用例都不该被它打扰。
  if (path == '/api/aux/config') {
    return http.Response(
      jsonEncode({
        'protocol': 'anthropic',
        'providerId': (auxConfigured?.call() ?? true) ? 'p1' : '',
        'model': 'glm-4-flash',
        'cliAvailability':
            cliAvailability ?? const {'claude': true, 'codex': true},
        'protocols': const [],
        'providersByProtocol': const {'anthropic': [], 'openai': []},
      }),
      200,
      headers: headers,
    );
  }
  // 一个 CLI 都没装时卡片要给出的官方安装命令（取法与 Web 一致：display || command）。
  if (path == '/api/cli/install-specs') {
    if (installSpecsFail) {
      return http.Response(jsonEncode({'ok': false}), 500, headers: headers);
    }
    return http.Response(
      jsonEncode({
        'ok': true,
        'specs': const {
          'claude': {'command': 'npm i -g @anthropic-ai/claude-code'},
          'codex': {'command': 'npm i -g @openai/codex'},
        },
      }),
      200,
      headers: headers,
    );
  }
  // 远端工作区是快照自带的一趟，跟目录一起铺进列表。
  if (path == '/api/external-fleets') {
    return http.Response(
      jsonEncode({'ok': true, 'fleets': const []}),
      200,
      headers: headers,
    );
  }
  // 全文检索（`air-directory-search.js`）：任务板一份、对话正文一份。
  if (path == '/api/task-board/search' || path == '/api/search/messages') {
    if (searchFails) return http.Response('nope', 500);
    return http.Response(
      jsonEncode({
        'ok': true,
        'results': [
          for (final id in searchHits)
            path == '/api/task-board/search'
                ? {'taskId': id}
                : {
                    'taskIds': [id],
                  },
        ],
      }),
      200,
      headers: headers,
    );
  }
  return http.Response(
    jsonEncode({
      'ok': true,
      'clis': const ['claude'],
      'directories': [
        for (var i = 1; i <= directories; i++)
          {
            'id': 'd$i',
            'name': '工作目录 ${i == 1 ? 'A' : 'B'}',
            'path': '/p/$i',
          },
      ],
      'tasks': tasks ?? _baseTasks,
    }),
    200,
    headers: headers,
  );
});

/// 四条任务，四种处境：
///   t1 等我回答 · t2 出错（两条都要我动手，t2 更新得更晚）·
///   t3 空闲（不进「谁在等我」，也不在跑）· t4 已归档（默认筛选里不出现）。
const List<Map<String, dynamic>> _baseTasks = [
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

/// 五格数字各要吃一份不同的料：一条在跑（r1，落在 d1）、一条空闲（t3，落在
/// d2）、一条今天跑完（n1）、一条很久以前就跑完的（n2，不该算进「今日完成」），
/// 外加基础夹具那四条。算出来是：
///   进行中 4（t1 t2 t3 r1）· 等我回复 1（t1）· 异常 1（t2）· 今日完成 1（n1）·
///   全部 4 / 共 7 条记录。
List<Map<String, dynamic>> _fiveTileTasks() => [
  ..._baseTasks,
  {
    'id': 'r1',
    'dirId': 'd1',
    'title': '在跑的活',
    'status': 'active',
    'runState': 'running',
    'updatedAt': 1700000400000,
    'resource': {'residency': 'materialized', 'lease': 'running'},
  },
  {
    'id': 'n1',
    'dirId': 'd1',
    'title': '今天跑完的',
    'status': 'done',
    'runState': 'done',
    'updatedAt': DateTime.now().millisecondsSinceEpoch,
    'resource': const {'residency': 'planned', 'lease': 'idle'},
  },
  {
    'id': 'n2',
    'dirId': 'd2',
    'title': '很久以前跑完的',
    'status': 'done',
    'runState': 'done',
    'updatedAt': 1600000000000,
    'resource': const {'residency': 'planned', 'lease': 'idle'},
  },
];

Future<SettingsService> _settings() async {
  SharedPreferences.setMockInitialValues({
    'multicc_host': 'http://localhost:3000',
  });
  return SettingsService.getInstance();
}

/// 控制台这一页很高（读数带 + 小字 + 展开的清单 + 工作目录 + AI + 工具格），默认
/// 800×600 的画布会把下面的分区挤出渲染树，点击就落空了。给测试一块够高的画布。
void _tallCanvas(WidgetTester tester, {Size size = const Size(900, 3200)}) {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = size;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
}

/// 装上控制台。回调默认都是空实现，用例只传自己关心的那几个。
Widget _console({
  required SettingsService settings,
  required http.Client client,
  ValueChanged<AirTask>? onOpenTask,
  VoidCallback? onOpenLibrary,
  ValueChanged<String>? onSelectDirectory,
  ValueChanged<WorkspaceDestination>? onOpenDestination,
  VoidCallback? onOpenMemory,
  VoidCallback? onOpenTaskgraph,
  Future<void> Function()? onOpenAiAssistant,
  VoidCallback? onOpenSchedules,
}) => MaterialApp(
  home: Scaffold(
    body: AirConsoleBody(
      settings: settings,
      httpClient: client,
      onOpenTask: onOpenTask ?? (_) {},
      onOpenLibrary: onOpenLibrary ?? () {},
      onSelectDirectory: onSelectDirectory ?? (_) {},
      onOpenDestination: onOpenDestination ?? (_) {},
      onOpenMemory: onOpenMemory ?? () {},
      onOpenTaskgraph: onOpenTaskgraph ?? () {},
      onOpenAiAssistant: onOpenAiAssistant,
      onOpenSchedules: onOpenSchedules,
    ),
  ),
);

Finder _tile(String id) => find.byKey(ValueKey('air-console-tile-$id'));

/// 一格里的那个数字（标签和小字都不是纯数字，所以精确匹配数字不会撞上）。
Finder _tileValue(String id, String value) =>
    find.descendant(of: _tile(id), matching: find.text(value));

/// 展开某一格。清单默认是收起的 —— 控制台第一眼只看数字。
Future<void> _openTile(WidgetTester tester, String id) async {
  await tester.tap(_tile(id));
  await tester.pumpAndSettle();
}

/// 格的选中态只体现在边框和底色上（没有别的 widget 可断言），所以这里读边框。
Color _tileBorder(WidgetTester tester, String id) {
  final ink = tester.widget<InkWell>(_tile(id));
  final card = ink.child! as Container;
  final border = (card.decoration! as BoxDecoration).border! as Border;
  return border.top.color;
}

Finder _row(String id) => find.byKey(ValueKey('air-console-task-$id'));

/// 在「全部」那一格的搜索框里打字。检索是防抖的（180ms），这一跳要跑过它，服务端
/// 那一步才会真的发出去；结果回来之前列表先按本地标题筛过一遍，所以两头都稳。
Future<void> _type(WidgetTester tester, String text) async {
  await tester.enterText(find.byKey(const ValueKey('air-console-search')), text);
  await tester.pump(const Duration(milliseconds: 250));
  await tester.pumpAndSettle();
}

/// 检索那一跳的请求路径。查询串是 URL 编码过的（中文会变成 %E7%…），所以期望值
/// 也走同一套编码，别在断言里手写中文字面量。
String _searchPath(String path, String query) =>
    Uri(path: path, queryParameters: {'q': query, 'limit': '20'}).toString();

/// 从某一格的下拉里选一项。菜单是覆盖层，所以同名的字会出现两次 —— 选 `.last`
/// 那一份（覆盖层排在主树之后）。
Future<void> _pick(WidgetTester tester, String pickerId, String label) async {
  await tester.tap(find.byKey(ValueKey(pickerId)));
  await tester.pumpAndSettle();
  await tester.tap(find.text(label).last);
  await tester.pumpAndSettle();
}

void main() {
  // 状态徽标、格上的词都来自 i18n 词典（注册表只给 key），不加载就只有 key。
  setUpAll(() => I18n.init('zh'));

  testWidgets('五张统计格数的是同一份判定：谁在跑、谁在等我、今天跑完了什么', (tester) async {
    _tallCanvas(tester);
    final settings = await _settings();
    final requests = <String>[];
    final client = _client(
      requests,
      tasks: _fiveTileTasks(),
      schedules: const [
        {'id': 'c1', 'name': '每日巡检', 'cron': '0 9 * * *', 'enabled': true},
        {'id': 'c2', 'name': '周报', 'cron': '0 9 * * 1', 'enabled': false},
        {'id': 'c3', 'name': '备份', 'cron': '0 3 * * *', 'enabled': true},
      ],
    );

    await tester.pumpWidget(_console(settings: settings, client: client));
    await tester.pumpAndSettle();

    // 两份数据各拉一次，控制台不自己造统计口径；第三趟只问首启卡该不该亮
    // （aux 配没配），不参与任何一个数字。
    expect(requests, [
      '/api/air',
      '/api/external-fleets',
      '/api/cron',
      '/api/aux/config',
    ]);

    // 「进行中」只认注册表说在转的那一个状态：r1 在跑，t1/t2/t3 都不在跑。
    expect(_tileValue('running', '1'), findsOneWidget);
    expect(find.text('1 个目录正在跑'), findsOneWidget);
    // 「等我回复」和「异常」是两格：一个有人等我回答，一个是跑出错了。
    expect(_tileValue('waiting', '1'), findsOneWidget);
    expect(find.text('等待回答或卡在资源上'), findsOneWidget);
    expect(_tileValue('error', '1'), findsOneWidget);
    expect(find.text('执行出错，需要处理或重试'), findsOneWidget);
    // 「今日完成」按最后一次更新落在今天本地零点之后算：n1 是刚刚，n2 是几年前。
    expect(_tileValue('today', '1'), findsOneWidget);
    // 「全部」数是**未归档**的条数，小字里另外报整份记录的总数 —— 两个数说的不是
    // 一件事，所以都得写出来。
    expect(_tileValue('all', '4'), findsOneWidget);
    expect(find.text('未归档 · 共 7 条记录，可搜索'), findsOneWidget);

    // 目录数与定时任务数降成一行小字：它们是背景信息，不占读数带。
    expect(find.text('2 个工作目录'), findsOneWidget);
    expect(find.text('定时任务 2/3 条启用'), findsOneWidget);

    // 默认什么都不展开：第一眼是数字，不是一堵清单墙。
    expect(find.byKey(const ValueKey('air-console-collapse')), findsNothing);
    expect(_row('t1'), findsNothing);

    // AI Assistant 是控制台的一级入口，不再要求先钻进设置中心。
    await tester.tap(find.byKey(const ValueKey('air-console-ai-assistant')));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    client.close();
  });

  testWidgets('点一格展开它自己的清单，再点同一格收起；选中态落在边框上', (tester) async {
    _tallCanvas(tester);
    final settings = await _settings();
    final opened = <String>[];
    final client = _client(<String>[]);

    await tester.pumpWidget(
      _console(
        settings: settings,
        client: client,
        onOpenTask: (task) => opened.add(task.id),
      ),
    );
    await tester.pumpAndSettle();

    expect(_tileBorder(tester, 'waiting'), AppColors.line);

    // 「等我回复」那一格：清单就是上面那个数字用的同一份数组，所以数字和清单不会
    // 分叉；这一格也没有搜索条和删除键 —— 那两样只属于「全部」。
    await _openTile(tester, 'waiting');
    expect(_tileBorder(tester, 'waiting'), AppColors.accent);
    expect(find.text('ACROSS ALL WORKSPACES'), findsOneWidget);
    expect(_row('t1'), findsOneWidget, reason: 't1 在等我回答');
    expect(_row('t2'), findsNothing, reason: 't2 是出错，归「异常」那一格');
    expect(find.byKey(const ValueKey('air-console-search')), findsNothing);
    expect(find.byKey(const ValueKey('air-console-delete-t1')), findsNothing);
    expect(find.text('1 条'), findsOneWidget);

    // 再点同一格收起。
    await _openTile(tester, 'waiting');
    expect(find.byKey(const ValueKey('air-console-collapse')), findsNothing);
    expect(_tileBorder(tester, 'waiting'), AppColors.line);

    // 换一格只换内容，位置还在读数带正下方。
    await _openTile(tester, 'error');
    expect(_row('t2'), findsOneWidget);
    expect(_row('t1'), findsNothing);

    // 「全部」那一格才有控制条。
    await _openTile(tester, 'all');
    expect(
      find.byKey(const ValueKey('air-console-search')),
      findsOneWidget,
      reason: '换格只换标题和清单，控制条只属于「全部」',
    );
    expect(find.byKey(const ValueKey('air-console-scope')), findsOneWidget);
    expect(find.byKey(const ValueKey('air-console-status')), findsOneWidget);
    expect(find.byKey(const ValueKey('air-console-dir')), findsOneWidget);
    expect(find.byKey(const ValueKey('air-console-delete-t1')), findsOneWidget);

    // 收起键是这一格的整页出口之一。
    await tester.tap(find.byKey(const ValueKey('air-console-collapse')));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('air-console-collapse')), findsNothing);

    // 点一行交给宿主开那条任务。
    await _openTile(tester, 'waiting');
    await tester.tap(_row('t1'));
    await tester.pumpAndSettle();
    expect(opened, ['t1']);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    client.close();
  });

  testWidgets('分区的先后：谁在等我 → 我有哪些目录 → 工具格', (tester) async {
    _tallCanvas(tester);
    final settings = await _settings();
    final client = _client(<String>[]);

    await tester.pumpWidget(_console(settings: settings, client: client));
    await tester.pumpAndSettle();
    await _openTile(tester, 'all');

    // 拿 eyebrow 定位（「工作目录」这几个字别处也有，用标题会撞上）。
    double sectionY(String eyebrow) => tester.getTopLeft(find.text(eyebrow)).dy;
    expect(
      sectionY('WORK DIRECTORIES'),
      greaterThan(sectionY('ACROSS ALL WORKSPACES')),
      reason: '「工作目录」在展开的清单后面',
    );
    expect(
      sectionY('WORK DIRECTORIES'),
      lessThan(sectionY('SYSTEM TOOLS')),
      reason: '工具格仍在最后',
    );
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    client.close();
  });

  testWidgets('全部任务的筛选：默认只看没结束的，搜索、状态、目录各收窄一层', (tester) async {
    _tallCanvas(tester);
    final settings = await _settings();
    final requests = <String>[];
    final client = _client(requests);

    await tester.pumpWidget(_console(settings: settings, client: client));
    await tester.pumpAndSettle();
    await _openTile(tester, 'all');

    // 默认「进行中与待处理」：归档的那条不出现。
    expect(_row('t1'), findsOneWidget);
    expect(_row('t3'), findsOneWidget);
    expect(_row('t4'), findsNothing);
    expect(find.text('3 条'), findsOneWidget);

    // 搜索先按本地那两条语料筛（标题 + 目录名），服务端结果没回来也不会空着。
    await _type(tester, '支付');
    expect(_row('t1'), findsNothing);
    expect(_row('t2'), findsOneWidget);
    expect(find.text('1 条'), findsOneWidget);

    await _type(tester, '工作目录 B');
    expect(_row('t3'), findsOneWidget);
    expect(_row('t2'), findsNothing);

    await _type(tester, '');

    // 放宽到全部记录，归档的那条就回来了。
    await _pick(tester, 'air-console-status', '全部记录');
    expect(_row('t4'), findsOneWidget);
    expect(find.text('4 条'), findsOneWidget);

    // 删除只在「全部」这一格给：确认弹窗沿用同一条流水线，成功后真的写了服务端。
    await tester.tap(find.byKey(const ValueKey('air-console-delete-t2')));
    await tester.pumpAndSettle();
    expect(find.text('删除任务「支付回调」？'), findsOneWidget);
    await tester.tap(
      find.byKey(const ValueKey('air-console-t2-delete-confirm-ok')),
    );
    await tester.pumpAndSettle();
    expect(requests, contains('/api/task-board/tasks/t2'));

    // 「已归档」只剩归档的那条。
    await _pick(tester, 'air-console-status', '已归档');
    expect(_row('t4'), findsOneWidget);
    expect(_row('t1'), findsNothing);

    // 按目录收窄：t1/t2 在 d1，t3 在 d2。
    await _pick(tester, 'air-console-status', '全部记录');
    await _pick(tester, 'air-console-dir', '工作目录 A');
    expect(_row('t1'), findsOneWidget);
    expect(_row('t2'), findsOneWidget);
    expect(_row('t3'), findsNothing);

    // 空态也要说话，不是一片空白。
    await _type(tester, '不存在的东西');
    expect(find.text('没有符合条件的任务。换个关键词或放宽筛选。'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    client.close();
  });

  testWidgets('有搜索词时，状态那格被换成「全部记录」——归档的命中不会被静默滤掉', (tester) async {
    _tallCanvas(tester);
    final settings = await _settings();
    final client = _client(<String>[]);

    await tester.pumpWidget(_console(settings: settings, client: client));
    await tester.pumpAndSettle();
    await _openTile(tester, 'all');

    // 状态一直是默认的「进行中与待处理」，谁也没去动它。
    expect(find.text('进行中与待处理'), findsOneWidget);
    expect(_row('t4'), findsNothing);

    // 搜一条已归档的：服务端命中已归档任务时，默认只看在办会把结果整片滤掉，所以
    // 有搜索词这一格强制按「全部记录」走。
    await _type(tester, '旧任务');
    expect(
      _row('t4'),
      findsOneWidget,
      reason: '有搜索词时不再被状态档静默滤掉',
    );
    // 那一格自己的档位没被改写 —— 清空关键词就回到原样。
    expect(find.text('进行中与待处理'), findsOneWidget);
    await _type(tester, '');
    expect(_row('t4'), findsNothing);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    client.close();
  });

  testWidgets('检索跨目录且带全文：服务端命中能捞出标题里没这个词的任务', (tester) async {
    _tallCanvas(tester);
    final settings = await _settings();
    final requests = <String>[];
    final client = _client(
      requests,
      tasks: [
        ..._baseTasks,
        {
          'id': 'x1',
          'dirId': 'd2',
          'title': '重构登录',
          'status': 'active',
          'runState': 'idle',
          'updatedAt': 1700000500000,
          'resource': const {'residency': 'planned', 'lease': 'idle'},
        },
      ],
      searchHits: const ['x1'],
    );

    await tester.pumpWidget(_console(settings: settings, client: client));
    await tester.pumpAndSettle();
    await _openTile(tester, 'all');
    await _type(tester, 'OAuth');

    // 服务端在对话正文里命中了 x1，标题「重构登录」里并没有 OAuth。
    expect(_row('x1'), findsOneWidget);
    expect(_row('t1'), findsNothing);
    // 两条语料都问了，而且**不带 dirId** —— 控制台是跨目录的一页（Web 那边同一处
    // 也不传 dirId）。
    expect(
      requests,
      contains('/api/task-board/search?q=OAuth&limit=20'),
      reason: '任务板那一路不带 dirId',
    );
    expect(requests, contains('/api/search/messages?q=OAuth&limit=20'));
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    client.close();
  });

  testWidgets('检索拿不到结果就退回本地按标题筛，面板从不空着', (tester) async {
    _tallCanvas(tester);
    final settings = await _settings();
    final client = _client(
      <String>[],
      tasks: [
        ..._baseTasks,
        {
          'id': 'x1',
          'dirId': 'd2',
          'title': '重构登录',
          'status': 'active',
          'runState': 'idle',
          'updatedAt': 1700000500000,
          'resource': const {'residency': 'planned', 'lease': 'idle'},
        },
      ],
      searchFails: true,
    );

    await tester.pumpWidget(_console(settings: settings, client: client));
    await tester.pumpAndSettle();
    await _openTile(tester, 'all');

    // 服务端全挂了：正文命中拿不到，但按标题筛照旧工作。
    await _type(tester, '重构');
    expect(_row('x1'), findsOneWidget);
    expect(_row('t1'), findsNothing);

    await _type(tester, 'OAuth');
    expect(_row('x1'), findsNothing);
    expect(
      find.text('没有符合条件的任务。换个关键词或放宽筛选。'),
      findsOneWidget,
      reason: '搜不到也是「空态在说话」，不是一片空白',
    );
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    client.close();
  });

  testWidgets('搜索范围默认连对话正文一起搜，切成只看标题与摘要要重问一次', (tester) async {
    _tallCanvas(tester);
    final settings = await _settings();
    final requests = <String>[];
    final client = _client(requests);

    await tester.pumpWidget(_console(settings: settings, client: client));
    await tester.pumpAndSettle();
    await _openTile(tester, 'all');

    expect(find.text('全部记录（含对话）'), findsOneWidget);
    await _type(tester, '登录');
    expect(requests, contains(_searchPath('/api/search/messages', '登录')));

    requests.clear();
    await _pick(tester, 'air-console-scope', '仅任务标题与摘要');
    expect(
      requests,
      isNot(contains(_searchPath('/api/search/messages', '登录'))),
      reason: '范围换了要重新问服务端，不能只重画',
    );
    expect(requests, contains(_searchPath('/api/task-board/search', '登录')));
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    client.close();
  });

  testWidgets('工作目录栏数的是「没做完几个 / 有几个在跑」，点进去切到那个目录', (tester) async {
    _tallCanvas(tester);
    final settings = await _settings();
    final picked = <String>[];
    var library = 0;
    final client = _client(<String>[], tasks: _fiveTileTasks());

    await tester.pumpWidget(
      _console(
        settings: settings,
        client: client,
        onSelectDirectory: picked.add,
        onOpenLibrary: () => library++,
      ),
    );
    await tester.pumpAndSettle();

    // d1：t1 在等回答、t2 出错、r1 在跑（n1 已经做完）→ 三条没做完，一条在跑。
    expect(find.text('3 进行中'), findsOneWidget);
    expect(find.text('1 执行中'), findsOneWidget);
    // d2：t3 没做完（t4 归档、n2 已 done）→ 一条没做完，一条都不在跑，所以把这一栏
    // 的任务总数说出来，而不是写一个 0。
    expect(find.text('1 进行中'), findsOneWidget);
    expect(find.text('3 个任务'), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('air-console-dir-d2')));
    await tester.pumpAndSettle();
    expect(picked, ['d2']);

    // 那一栏右上角是目录库的出口。
    await tester.tap(find.byKey(const ValueKey('air-console-library')));
    await tester.pumpAndSettle();
    expect(library, 1);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    client.close();
  });

  testWidgets('工具格五格各去各的地方，AI Assistant 走宿主给的那条', (tester) async {
    _tallCanvas(tester);
    final settings = await _settings();
    final destinations = <WorkspaceDestination>[];
    var memory = 0, taskgraph = 0, assistant = 0;
    final client = _client(<String>[]);

    await tester.pumpWidget(
      _console(
        settings: settings,
        client: client,
        onOpenDestination: destinations.add,
        onOpenMemory: () => memory++,
        onOpenTaskgraph: () => taskgraph++,
        onOpenAiAssistant: () async => assistant++,
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const ValueKey('air-console-ai-assistant')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('air-console-tool-docs')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('air-console-tool-memory')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('air-console-tool-taskgraph')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('air-console-tool-settings')));
    await tester.pumpAndSettle();
    // 宿主没给原生定时任务中心，所以这一格退回老抽屉那条路。
    await tester.tap(find.byKey(const ValueKey('air-console-tool-schedules')));
    await tester.pumpAndSettle();

    expect(assistant, 1);
    expect(memory, 1);
    expect(taskgraph, 1);
    expect(destinations, [
      WorkspaceDestination.docs,
      WorkspaceDestination.global,
      WorkspaceDestination.cron,
    ]);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    client.close();
  });

  testWidgets('宿主给了原生定时任务中心，控制台这两个入口就都不去老抽屉', (tester) async {
    _tallCanvas(tester);
    final settings = await _settings();
    final destinations = <WorkspaceDestination>[];
    var schedules = 0;
    final client = _client(<String>[]);

    await tester.pumpWidget(
      _console(
        settings: settings,
        client: client,
        onOpenDestination: destinations.add,
        onOpenSchedules: () => schedules++,
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const ValueKey('air-console-tool-schedules')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('air-console-meta-schedules')));
    await tester.pumpAndSettle();
    expect(schedules, 2);
    expect(destinations, isEmpty);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    client.close();
  });

  testWidgets('定时任务读不到只是那行小字说实话，不把整页变成错误页', (tester) async {
    _tallCanvas(tester);
    final settings = await _settings();
    final client = _client(<String>[], schedulesFail: true);

    await tester.pumpWidget(_console(settings: settings, client: client));
    await tester.pumpAndSettle();

    // 读不到就说读不到，不拿 0 去充数 —— 0 条启用和「不知道有几条」是两件事。
    expect(find.text('定时任务读取失败：请刷新 Air 页面后重试。'), findsOneWidget);
    expect(find.text('定时任务 0/0 条启用'), findsNothing);
    // 主体照常：任务和目录才是这一页的主体。
    expect(_tileValue('waiting', '1'), findsOneWidget);
    await _openTile(tester, 'waiting');
    expect(_row('t1'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    client.close();
  });

  testWidgets('「等我回复」那一格的整页出口只在有东西等我时出现，且不属于别的格', (tester) async {
    _tallCanvas(tester);
    final settings = await _settings();
    final client = _client(<String>[]);

    await tester.pumpWidget(_console(settings: settings, client: client));
    await tester.pumpAndSettle();

    // 基础夹具有两条要我动手（t1 等我回答、t2 出错），出口带上同一个总数。
    await _openTile(tester, 'waiting');
    expect(find.text('查看全部 2 条 ›'), findsOneWidget);
    expect(
      find.byKey(const ValueKey('air-console-attention-all')),
      findsOneWidget,
    );
    // 异常那一格是「现在有事」的清单，别处没有这个出口。
    await _openTile(tester, 'error');
    expect(
      find.byKey(const ValueKey('air-console-attention-all')),
      findsNothing,
      reason: '整页出口只挂在「等我回复」那一格后面',
    );
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    client.close();
  });

  testWidgets('没有东西等我时，那一格说实话，也不常驻一个点了没反应的出口', (tester) async {
    _tallCanvas(tester);
    final settings = await _settings();
    final client = _client(
      <String>[],
      tasks: [
        {
          'id': 'i1',
          'dirId': 'd1',
          'title': '空转的活',
          'status': 'active',
          'runState': 'idle',
          'updatedAt': 1700000000000,
          'resource': const {'residency': 'planned', 'lease': 'idle'},
        },
      ],
    );

    await tester.pumpWidget(_console(settings: settings, client: client));
    await tester.pumpAndSettle();

    expect(_tileValue('waiting', '0'), findsOneWidget);
    expect(find.text('当前没有要处理的事'), findsOneWidget);
    expect(find.text('现在没有在跑的任务'), findsOneWidget);

    await _openTile(tester, 'waiting');
    expect(find.text('没有正在等我的任务。'), findsOneWidget);
    expect(
      find.byKey(const ValueKey('air-console-attention-all')),
      findsNothing,
      reason: '没超过就不该常驻一个点了没反应的「查看全部」',
    );
    await _openTile(tester, 'running');
    expect(find.text('现在没有正在执行的任务。'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    client.close();
  });

  testWidgets('整页「谁在等我」是同一份清单：纯时间倒序，点一条先收它自己再交给宿主', (tester) async {
    _tallCanvas(tester);
    final settings = await _settings();
    final opened = <String>[];
    // 七条要我动手的（等回答 / 出错），外加两条「最新但不用我动手」的：在跑的
    // r1、空闲的 i1。这两条的时间戳比谁都新 —— 一旦「正在跑」又被算进这份清单，
    // 头一行立刻是 r1，断言当场失败。
    final client = _client(
      <String>[],
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
      _console(
        settings: settings,
        client: client,
        onOpenTask: (task) => opened.add(task.id),
      ),
    );
    await tester.pumpAndSettle();

    // 两格加起来仍是 urgent 那个总数（7）；「等我回复」这一格只放等回答的三条，跑出
    // 错的四条归「异常」那一格。
    expect(_tileValue('waiting', '3'), findsOneWidget);
    expect(_tileValue('error', '4'), findsOneWidget);
    expect(_tileValue('running', '2'), findsOneWidget);

    await _openTile(tester, 'waiting');
    // 出口带着整份清单的总数（不只是这一格里的三条）。
    expect(find.text('查看全部 7 条 ›'), findsOneWidget);
    for (final id in const ['w1', 'w2', 'w3']) {
      expect(_row(id), findsOneWidget, reason: '$id 在等我回答');
    }
    for (final id in const ['e1', 'e2', 'e3', 'e4']) {
      expect(_row(id), findsNothing, reason: '$id 是出错，归「异常」那一格');
    }
    // 执行中的、空闲的从不进这份清单 —— 哪怕它们是最新的两条。
    for (final id in const ['r1', 'r2', 'i1']) {
      expect(_row(id), findsNothing, reason: '$id 不需要我动手，不属于「谁在等我」');
    }

    // 整页：同一份清单铺开。
    await tester.tap(find.byKey(const ValueKey('air-console-attention-all')));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('air-attention')), findsOneWidget);
    expect(find.text('7 条 · 按最近更新排序，点击直达'), findsOneWidget);
    for (final id in const ['w1', 'w2', 'e1', 'e2', 'e3', 'e4', 'w3']) {
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

    // 整页里点一条：先把整页收掉，再由宿主导航（否则控制台会留在屏幕上）。
    await tester.tap(find.byKey(const ValueKey('air-attention-task-e3')));
    await tester.pumpAndSettle();
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

  testWidgets('列表是给人看的：超过 60 条只显示最近的，并说清总数', (tester) async {
    // 60 条任务行都要真的落在渲染树里（滚动列表只建可见的那几行），所以这一块画布
    // 得给够。
    _tallCanvas(tester, size: const Size(900, 9000));
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

    await tester.pumpWidget(_console(settings: settings, client: client));
    await tester.pumpAndSettle();
    await _openTile(tester, 'all');

    expect(find.text('65 条 · 显示最近 60 条'), findsOneWidget);
    // 留下的是最近更新的那 60 条，最旧的那 5 条被封顶挡在外面。
    expect(_row('n64'), findsOneWidget);
    expect(_row('n5'), findsOneWidget);
    for (final id in const ['n4', 'n3', 'n2', 'n1', 'n0']) {
      expect(_row(id), findsNothing, reason: '$id 太旧，进不了这一页');
    }
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    client.close();
  });

  testWidgets('320px 上排得下：读数带两列、筛选两列、行不横向溢出', (tester) async {
    _tallCanvas(tester, size: const Size(320, 2600));
    final settings = await _settings();
    final client = _client(<String>[]);

    await tester.pumpWidget(_console(settings: settings, client: client));
    await tester.pumpAndSettle();
    await _openTile(tester, 'all');

    expect(tester.takeException(), isNull);
    for (final id in const ['running', 'waiting', 'error', 'today', 'all']) {
      expect(_tile(id), findsOneWidget);
    }
    expect(find.byKey(const ValueKey('air-console-scope')), findsOneWidget);
    expect(find.byKey(const ValueKey('air-console-status')), findsOneWidget);
    expect(find.byKey(const ValueKey('air-console-dir')), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    client.close();
  });

  testWidgets('读数带是一条压扁的窄带，不跟任务抢高度', (tester) async {
    _tallCanvas(tester);
    final settings = await _settings();
    final client = _client(<String>[]);

    await tester.pumpWidget(_console(settings: settings, client: client));
    await tester.pumpAndSettle();

    final card = tester.getSize(_tile('all'));
    // 钉住「确实压扁了」，不钉死具体数值 —— 那会在下次微调时变成噪声。
    expect(card.height, lessThan(120), reason: '统计格实测 ${card.height}');
    final value = tester.widget<Text>(_tileValue('all', '3'));
    expect(value.style?.fontSize, lessThanOrEqualTo(20));
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    client.close();
  });

  // ── 首启配置卡（Web `#setup-card`，2.0 起住在控制台最上方） ────────────────
  // 裸 /air 落的就是这一页，所以引导必须开在这儿 —— 它是新用户唯一会看到的
  // 第一屏。亮不亮只看一件事：`/api/aux/config` 里有没有 providerId。

  testWidgets('aux 没配就亮首启卡，配好了不亮', (tester) async {
    _tallCanvas(tester);
    final settings = await _settings();

    final unconfigured = _client(<String>[], auxConfigured: () => false);
    await tester.pumpWidget(_console(settings: settings, client: unconfigured));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('air-console-setup')), findsOneWidget);
    expect(find.text(t('airSetupTitle')), findsOneWidget);
    expect(find.byKey(const ValueKey('air-console-setup-import')), findsOneWidget);
    expect(find.byKey(const ValueKey('air-console-setup-aux')), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    unconfigured.close();

    final configured = _client(<String>[]);
    await tester.pumpWidget(_console(settings: settings, client: configured));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('air-console-setup')), findsNothing);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    configured.close();
  });

  testWidgets('首启卡两颗动作各去各的地方；从 AI Assistant 页回来会重查一次', (tester) async {
    _tallCanvas(tester);
    final settings = await _settings();
    var auxConfigured = false;
    final destinations = <WorkspaceDestination>[];
    var assistant = 0;
    final client = _client(<String>[], auxConfigured: () => auxConfigured);

    await tester.pumpWidget(
      _console(
        settings: settings,
        client: client,
        onOpenDestination: destinations.add,
        // 宿主那一页在测试里不真去：这里只演「它关掉之前，配置被配好了」。
        onOpenAiAssistant: () async {
          assistant++;
          auxConfigured = true;
        },
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const ValueKey('air-console-setup-import')));
    await tester.pumpAndSettle();
    expect(destinations, [WorkspaceDestination.provider]);

    await tester.tap(find.byKey(const ValueKey('air-console-setup-aux')));
    await tester.pumpAndSettle();
    expect(assistant, 1);
    // 刚在那一页配好 —— 卡片当场消失，不用等下一次刷新（同 Web 离开 aux 页重查）。
    expect(find.byKey(const ValueKey('air-console-setup')), findsNothing);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    client.close();
  });

  testWidgets('一个 CLI 都没装时，首启卡直接说清并提供官方安装命令', (tester) async {
    _tallCanvas(tester);
    final settings = await _settings();
    final client = _client(
      <String>[],
      auxConfigured: () => false,
      cliAvailability: const {'claude': false, 'codex': false},
    );

    await tester.pumpWidget(_console(settings: settings, client: client));
    await tester.pumpAndSettle();

    expect(
      find.byKey(const ValueKey('air-console-setup-cli-missing')),
      findsOneWidget,
    );
    // 拿不到命令（接口失败）时这一行空着，但卡片照旧把话说全 —— 所以只断言
    // 「命令取到了」，不把它当成卡片成立的前提。
    expect(
      find.textContaining('npm i -g @anthropic-ai/claude-code'),
      findsOneWidget,
    );
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    client.close();
  });

  // 放在这一组最后：它落的是这台设备的本地偏好（`air:setup-dismissed`），
  // SettingsService 是单例，之后才跑的用例不该吃到这一笔。
  testWidgets('「暂时跳过」把卡片收掉并记在本机，重开这一页也不再亮', (tester) async {
    _tallCanvas(tester);
    final settings = await _settings();
    final client = _client(<String>[], auxConfigured: () => false);

    await tester.pumpWidget(_console(settings: settings, client: client));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('air-console-setup')), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('air-console-setup-dismiss')));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('air-console-setup')), findsNothing);
    // 跳过的只是这张卡，不是那项配置 —— 所以它记在本机，不写服务端。
    expect(settings.airSetupDismissed, isTrue);

    await tester.pumpWidget(const SizedBox());
    await tester.pumpWidget(_console(settings: settings, client: client));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('air-console-setup')), findsNothing);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    client.close();
  });
}
