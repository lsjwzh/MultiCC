// 为什么这么测：
//
// 任务图谱页是 Web `?view=taskgraph`（渲染器 `public/task-graph.js`）的原生
// 对应物。这块移植真正容易错的地方**不是力导向好不好看**，而是几处「照抄也会
// 抄错一个字」的对外行为：
//   1. 计数行 / 图例的文案（以及 meta.truncated 那句后缀）；
//   2. 切项目是**客户端过滤**，而且边要两端都在子图里才留（Web 的
//      `filterPayload()`）——过滤错了会画出跨项目的假关联；
//   3. 点节点开详情：标题、出/入两组邻居、每条边类型的中文标签；
//   4. 空图与请求失败各自说哪句话（失败必须带出真实错误，不能吞）。
// 这些都能在没有真实服务、没有真实布局的前提下验证。
//
// 点击坐标怎么来：力导向的节点位置由布局算出来，测试里没法（也不该）重算一遍
// —— 所以用页面自己暴露的 `nodeCenterInCanvas()` 拿画布内坐标，再
// `localToGlobal` 换成屏幕坐标喂给 `tapAt`。测试因此不依赖任何布局细节，
// 改力导向参数也不会让这组测试变哑。
//
// 网络用 `package:http/testing.dart` 的 MockClient（仓库已依赖 http，
// 不新增包），指向不可达端口的 host 只是为了不误打真实服务。
import 'dart:convert';

import 'package:flutter/gestures.dart' show kDoubleTapTimeout;
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:multicc_app/screens/task_graph_screen.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/services/task_graph_service.dart';

/// `http.Response(String, …)` 默认按 latin1 编码 body，中文会直接抛
/// 「Contains invalid characters」；统一带上 utf-8 的 content-type。
http.Response jsonResponse(Object payload, [int status = 200]) => http.Response(
  jsonEncode(payload),
  status,
  headers: {'content-type': 'application/json; charset=utf-8'},
);

const Map<String, String> _jsonHeaders = {
  'content-type': 'application/json; charset=utf-8',
};

/// 一份五个节点四个边的快照：
///   d1：n1（P）—parent→ n2（E）、n1 —shell-link→ sh1（壳）
///   d2：n3（无 classify，provisional）—group→ n4
///   再加一条 n2 —group→ n3 **跨项目**（两端过滤时都不该留）。
/// 计数：全部 5 节点 / 4 边，d1 3 / 2，d2 2 / 1。
Map<String, dynamic> _samplePayload({bool truncated = false}) => {
  'meta': {
    'dirId': 'all',
    'projects': [
      {'dirId': 'd1', 'name': '工作目录 A', 'count': 3},
      {'dirId': 'd2', 'name': '工作目录 B', 'count': 2},
    ],
    'truncated': truncated,
    'maxNodes': 1200,
    'durationMs': 7,
  },
  'nodes': [
    {
      'id': 'n1',
      'kind': 'task',
      'title': '登录页面',
      'dirId': 'd1',
      'status': 'active',
      'classifyState': 'P',
      'goal': '把登录做出来',
      'origin': 'session',
      'degree': 2,
      'refCount': 1,
      'canonical': true,
      'sources': ['board'],
    },
    {
      'id': 'n2',
      'kind': 'task',
      'title': '部署脚本',
      'dirId': 'd1',
      'status': 'active',
      'classifyState': 'E',
      'degree': 2,
      'provisional': true,
      'sources': ['board'],
    },
    {
      'id': 'sh1',
      'kind': 'shell',
      'title': '全栈工程师 1',
      'dirId': 'd1',
      'degree': 1,
      'sources': ['shell'],
      'currentTaskId': 'tsk_abcdefghijklmnopqrstuvwx',
    },
    {
      'id': 'n3',
      'kind': 'task',
      'title': '营销素材',
      'dirId': 'd2',
      'status': 'active',
      'degree': 2,
      'provisional': true,
      'sources': ['board', 'session'],
    },
    {
      'id': 'n4',
      'kind': 'task',
      'title': '发布计划',
      'dirId': 'd2',
      'status': 'archived',
      'degree': 1,
      'sources': ['board'],
    },
  ],
  'edges': [
    {'source': 'n1', 'target': 'n2', 'type': 'parent'},
    {'source': 'n1', 'target': 'sh1', 'type': 'shell-link'},
    {'source': 'n2', 'target': 'n3', 'type': 'group'},
    {'source': 'n3', 'target': 'n4', 'type': 'group'},
  ],
};

/// 记录请求头的假 client：顺带验证鉴权头是照 air_service 的写法发的。
http.Client _client(Map<String, dynamic> payload, {List<String>? sentTokens}) {
  return MockClient((request) async {
    if (request.url.path != '/api/task-graph') {
      return http.Response('not found', 404, headers: _jsonHeaders);
    }
    sentTokens?.add(request.headers['X-Access-Token'] ?? '');
    return jsonResponse(payload);
  });
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  // SettingsService 是按进程缓存的单例，host/token 只读一次；整个文件共用
  // 一份「不可达端口 + 固定 token」的设置（真请求全被 MockClient 截住）。
  late SettingsService settings;

  setUpAll(() async {
    SharedPreferences.setMockInitialValues({
      'multicc_host': 'http://127.0.0.1:9',
      'multicc_token': 'tkn-task-graph',
    });
    settings = await SettingsService.getInstance();
  });

  Future<TaskGraphScreenState> pumpScreen(
    WidgetTester tester,
    http.Client client, {
    void Function(String dirId, String taskId)? onOpenTaskInAir,
  }) async {
    await tester.pumpWidget(
      MaterialApp(
        home: TaskGraphScreen(
          settings: settings,
          httpClient: client,
          onOpenTaskInAir: onOpenTaskInAir,
        ),
      ),
    );
    await tester.pumpAndSettle();
    return tester.state<TaskGraphScreenState>(find.byType(TaskGraphScreen));
  }

  /// 点在画布内的某个坐标上。GestureDetector 上同时挂着双击，单击要等双击
  /// 窗口（kDoubleTapTimeout）过去才会回调，所以这里先把时钟推过去。
  Future<void> tapCanvas(WidgetTester tester, Offset local) async {
    final box = tester.renderObject<RenderBox>(
      find.byKey(const ValueKey('task-graph-canvas')),
    );
    await tester.tapAt(box.localToGlobal(local));
    await tester.pump(kDoubleTapTimeout + const Duration(milliseconds: 50));
    await tester.pumpAndSettle();
  }

  group('TaskGraphPayload', () {
    test('缺字段一律给默认值，不抛', () {
      final payload = TaskGraphPayload.fromJson({
        'nodes': [
          {'id': 'tsk_1'},
          {'id': 'tsk_2', 'kind': 'shell'},
          'not-a-map',
        ],
        'edges': [
          {'source': 'tsk_1', 'target': 'tsk_2'},
          {'source': 'tsk_1'}, // 缺目标端点 —— 画不出来，整条丢掉
        ],
        'meta': null,
      });
      expect(payload.nodes.length, 2);
      expect(payload.nodes.first.kind, 'task');
      expect(payload.nodes.first.degree, 0);
      expect(payload.nodes.first.sources, isEmpty);
      expect(payload.nodes[1].isShell, isTrue);
      expect(payload.edges.length, 1);
      expect(payload.edges.first.type, '');
      expect(payload.meta.projects, isEmpty);
      expect(payload.meta.truncated, isFalse);
      expect(payload.meta.durationMs, isNull);
    });

    test('filterByProject：只留命中的节点，边要两端都在子图里', () {
      final payload = TaskGraphPayload.fromJson(_samplePayload());
      final all = payload.filterByProject('all');
      expect(all.nodes.length, 5);
      expect(all.edges.length, 4);
      expect(payload.filterByProject(null).nodes.length, 5);

      final d1 = payload.filterByProject('d1');
      expect(d1.nodes.map((n) => n.id), ['n1', 'n2', 'sh1']);
      // n2→n3 那条跨项目边必须消失（n3 不在子图里）。
      expect(d1.edges.map((e) => '${e.source}->${e.target}'), [
        'n1->n2',
        'n1->sh1',
      ]);

      final d2 = payload.filterByProject('d2');
      expect(d2.nodes.map((n) => n.id), ['n3', 'n4']);
      expect(d2.edges.length, 1);
    });

    test('totalCount 是项目数之和（截断时和 nodes.length 不一样）', () {
      final payload = TaskGraphPayload.fromJson(_samplePayload());
      expect(payload.totalCount, 5);
      expect(TaskGraphPayload.empty.totalCount, 0);
    });
  });

  group('TaskGraphScreen', () {
    testWidgets('正常渲染：画布 + 计数行 + 图例', (tester) async {
      final tokens = <String>[];
      await pumpScreen(tester, _client(_samplePayload(), sentTokens: tokens));

      expect(find.byKey(const ValueKey('task-graph-canvas')), findsOneWidget);
      expect(find.text('5 节点 · 4 边 · 服务端 7ms'), findsOneWidget);
      // 图例：六个 classify 色 + 四种边类型（文案照 Web 的 CLASSIFY/EDGE）。
      for (final label in [
        'P 进行中',
        'D 执行成功',
        'W 等待用户',
        'B 后台等待',
        'E 异常',
        '无 classify',
      ]) {
        expect(find.text(label), findsOneWidget);
      }
      for (final label in ['父任务', '同组', '合并']) {
        expect(find.text(label), findsOneWidget);
      }
      // 「任务壳」在图上出现两次：壳色块 + shell-link 边类型。
      expect(find.text('任务壳'), findsNWidgets(2));
      // provisional 提示只在有这种节点时出现。
      expect(find.text('provisional(身份未锁)'), findsOneWidget);
      expect(find.text('加载中…'), findsNothing);
      // 鉴权头照 air_service 的写法发。
      expect(tokens, ['tkn-task-graph']);
    });

    testWidgets('meta.truncated 补上「已截断至 N」', (tester) async {
      await pumpScreen(tester, _client(_samplePayload(truncated: true)));
      expect(find.text('5 节点 · 4 边 · 服务端 7ms · 已截断至 1200'), findsOneWidget);
    });

    testWidgets('切项目：计数变成子图数量，跨项目边不留', (tester) async {
      final state = await pumpScreen(tester, _client(_samplePayload()));

      await tester.tap(find.byKey(const ValueKey('task-graph-project-filter')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('工作目录 A (3)').last);
      await tester.pumpAndSettle();

      expect(find.text('3 节点 · 2 边 · 服务端 7ms'), findsOneWidget);
      // 过滤是重建布局：d1 的节点还在，d2 的已经不在图里了。
      expect(state.nodeCenterInCanvas('n1'), isNotNull);
      expect(state.nodeCenterInCanvas('sh1'), isNotNull);
      expect(state.nodeCenterInCanvas('n3'), isNull);
      expect(state.nodeCenterInCanvas('n4'), isNull);
    });

    testWidgets('点节点 → 详情面板（标题 + 邻居边类型标签 + 点邻居换人）', (tester) async {
      final state = await pumpScreen(tester, _client(_samplePayload()));

      // n2：入边一条（n1 —parent→），出边一条（—group→ n3）。
      final n2 = state.nodeCenterInCanvas('n2');
      expect(n2, isNotNull);
      await tapCanvas(tester, n2!);

      expect(
        tester
            .widget<Text>(find.byKey(const ValueKey('task-graph-node-title')))
            .data,
        '部署脚本',
      );
      expect(find.text('指向 (1)'), findsOneWidget);
      expect(find.text('被指向 (1)'), findsOneWidget);
      expect(find.text('→ [同组] 营销素材'), findsOneWidget);
      expect(find.text('← [父任务] 登录页面'), findsOneWidget);
      // 标签区：provisional 身份 + classify + 关联度。
      expect(find.text('provisional（身份未锁）'), findsOneWidget);
      expect(find.text('classify E · API 异常'), findsOneWidget);
      expect(find.text('关联度: 2'), findsOneWidget);

      // 点邻居 = 换成它的详情（视口同时也对准它，这里只验面板）。
      await tester.tap(find.text('→ [同组] 营销素材'));
      await tester.pumpAndSettle();
      expect(
        tester
            .widget<Text>(find.byKey(const ValueKey('task-graph-node-title')))
            .data,
        '营销素材',
      );
      expect(find.text('← [同组] 部署脚本'), findsOneWidget);
    });

    testWidgets('孤立节点显示「（暂无关联，孤立节点）」', (tester) async {
      final payload = _samplePayload();
      (payload['edges'] as List).clear();
      final state = await pumpScreen(tester, _client(payload));
      await tapCanvas(tester, state.nodeCenterInCanvas('n1')!);
      expect(find.text('（暂无关联，孤立节点）'), findsOneWidget);
      // 详情是一整块多行 Text（Web 那边也是 `detailEl.textContent =
      // lines.join('\n')`），所以断言要看这一块的 data，不能按整串精确匹配某一行。
      final detail =
          tester
                  .widget<Text>(
                    find.byKey(const ValueKey('task-graph-node-detail')),
                  )
                  .data ??
              '';
      expect(detail.contains('目标：把登录做出来'), isTrue);
      expect(detail.contains('（无更多详情）'), isFalse); // n1 有 goal
    });

    testWidgets('壳节点没有「在 Air 打开」，任务节点有并回传 (dirId, taskId)', (tester) async {
      final opened = <String>[];
      final state = await pumpScreen(
        tester,
        _client(_samplePayload()),
        onOpenTaskInAir: (dirId, taskId) => opened.add('$dirId/$taskId'),
      );

      await tapCanvas(tester, state.nodeCenterInCanvas('sh1')!);
      expect(find.text('◈ 全栈工程师 1'), findsOneWidget);
      expect(find.text('任务壳'), findsWidgets); // 标签区里那枚
      expect(find.byKey(const ValueKey('task-graph-open-air')), findsNothing);
      // 关掉面板，换一个任务节点。
      await tester.tap(find.byIcon(Icons.close_rounded));
      await tester.pumpAndSettle();

      await tapCanvas(tester, state.nodeCenterInCanvas('n1')!);
      expect(find.byKey(const ValueKey('task-graph-open-air')), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('task-graph-open-air')));
      await tester.pumpAndSettle();
      expect(opened, ['d1/n1']);
    });

    testWidgets('空图 → 空状态文案与 0 计数', (tester) async {
      await pumpScreen(
        tester,
        _client({
          'meta': {'projects': <Object>[], 'truncated': false, 'durationMs': 3},
          'nodes': <Object>[],
          'edges': <Object>[],
        }),
      );
      expect(
        find.text('暂无任务节点。任务看板或任务壳里出现任务后，这里会画出父子 / 分组 / 合并 / 壳链接。'),
        findsOneWidget,
      );
      expect(find.byKey(const ValueKey('task-graph-canvas')), findsNothing);
      expect(find.text('0 节点 · 0 边 · 服务端 3ms'), findsOneWidget);
    });

    testWidgets('接口失败 → 显示服务端那句真实错误', (tester) async {
      await pumpScreen(
        tester,
        MockClient(
          (request) async => http.Response(
            jsonEncode({'error': 'boom'}),
            500,
            headers: _jsonHeaders,
          ),
        ),
      );
      expect(find.text('加载失败：boom'), findsOneWidget);
      expect(find.byKey(const ValueKey('task-graph-retry')), findsOneWidget);
      expect(find.byKey(const ValueKey('task-graph-canvas')), findsNothing);
    });

    testWidgets('连不上服务 → 原始网络错误也要带出来', (tester) async {
      await pumpScreen(
        tester,
        MockClient((request) async {
          throw http.ClientException('连接被拒绝');
        }),
      );
      expect(find.textContaining('加载失败：'), findsOneWidget);
      expect(find.textContaining('连接被拒绝'), findsOneWidget);
    });
  });
}
