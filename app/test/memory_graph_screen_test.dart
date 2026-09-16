// 为什么这么测：
//
// 记忆图谱页是 Web `?view=memory`（渲染器 `public/memory-graph.js`）的原生
// 对应物。这块移植真正容易错的地方**不是力导向好不好看**，而是几处「照抄也会
// 抄错一个字」的对外行为：
//   1. 切项目是**客户端过滤**，而且**全局层（machine / cli）必须保留** —— 跨层
//      wikilink 的另一端不能因为切项目就消失（Web 的 `filterPayload()`）；
//   2. 默认项目是「节点最多的那个」（Web 的 `projects[0]`），不是「全部」；
//   3. 图例只画**当前子图里出现过**的类型与作用域（与任务图谱「固定画全套」的
//      取舍不同）；
//   4. 详情里的路径 / 复制 / 编辑 / tokens / 尺寸 / 摘要，以及悬空引用那条
//      「不能编辑、显示 –」的分支；
//   5. 空图与请求失败各自说哪句话（失败必须带出真实错误，不能吞）。
// 这些都能在没有真实服务、没有真实布局的前提下验证。
//
// 点击坐标怎么来：力导向的节点位置由布局算出来，测试里没法（也不该）重算一遍
// —— 所以用页面自己暴露的 `nodeCenterInCanvas()` 拿画布内坐标，再
// `localToGlobal` 换成屏幕坐标喂给 `tapAt`。改力导向参数也不会让这组测试变哑。
//
// 网络用 `package:http/testing.dart` 的 MockClient（仓库已依赖 http，不新增包），
// 指向不可达端口的 host 只是为了不误打真实服务。
import 'dart:convert';

import 'package:flutter/gestures.dart' show kDoubleTapTimeout;
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:multicc_app/screens/memory_graph_screen.dart';
import 'package:multicc_app/services/memory_graph_service.dart';
import 'package:multicc_app/services/settings_service.dart';

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

/// 一份两个项目 + 全局层的快照：
///   d1（4 个）：m1 公共项目记忆 —→ m2 会话记忆、—→ m3 悬空引用（strength 3）；
///              m4 孤立任务级笔记（degree 0）
///   d2（2 个）：n1（**scope = cli**，与 m1 相连）、n2（scope = session，
///              n1 —→ n2）
///   全局层：g1 机器全局（dirId 为 null）—→ m1
/// Web 的 `filterPayload()` 把 `machine` / `cli` 两种 scope 当**全局层**：不论
/// 当前选哪个项目都保留（跨层 wikilink 的另一端不能消失）。所以：
///   - d1 子图 = m1 m2 m3 m4 + g1(machine) + n1(cli) = 6 节点；边 4 条
///     （n1—→n2 那条因为 n2 不在子图里而消失）；
///   - d2 子图 = n1 n2 + g1 = 3 节点；边 1 条（n1—→n2）。
/// 计数：全部 7 节点 / 5 边；默认项目是「节点最多的那个」（d1）。
Map<String, dynamic> _samplePayload({bool truncated = false}) => {
  'meta': {
    'dirId': 'all',
    'projects': [
      {'dirId': 'd1', 'name': '工作目录 A', 'count': 4},
      {'dirId': 'd2', 'name': '工作目录 B', 'count': 2},
    ],
    'truncated': truncated,
    'maxNodes': 1200,
    'durationMs': 7,
  },
  'nodes': [
    {
      'id': 'm1',
      'slug': 'dragon',
      'file': 'dragon.md',
      'title': '龙头战法',
      'summary': '打板负EV，低吸+扩展度过滤是唯一突破',
      'type': 'project',
      'scope': 'shared',
      'dirId': 'd1',
      'size': 5240,
      'path': '/mem/d1/_shared/dragon.md',
      'rel': 'd1/_shared/dragon.md',
      'tokens': 2045,
      'missing': false,
      'degree': 3,
    },
    {
      'id': 'm2',
      'slug': 'AGENTS',
      'file': 'AGENTS.md',
      'title': '本会话私有记忆',
      'summary': '会话专属的长期记忆',
      'type': 'index',
      'scope': 'session',
      'sessionId': 'chat-1',
      'sub': 'chat-1',
      'dirId': 'd1',
      'size': 373,
      'path': '/mem/d1/sessions/chat-1/AGENTS.md',
      'rel': 'd1/sessions/chat-1/AGENTS.md',
      'tokens': 163,
      'missing': false,
      'degree': 1,
    },
    {
      'id': 'm3',
      'slug': 'future',
      'file': 'future.md',
      'title': '未创建的记忆',
      'summary': '（尚未创建的记忆 · 被引用但文件不存在）',
      'type': 'missing',
      'scope': 'missing',
      'dirId': 'd1',
      'size': 0,
      'path': null,
      'rel': null,
      'tokens': 0,
      'missing': true,
      'degree': 2,
    },
    {
      'id': 'm4',
      'slug': 'lonely',
      'file': 'lonely.md',
      'title': '孤立笔记',
      'summary': '',
      'type': 'note',
      'scope': 'task',
      'sub': 'tsk_9',
      'dirId': 'd1',
      'size': 12,
      'path': '/mem/d1/tasks/tsk_9/lonely.md',
      'rel': 'd1/tasks/tsk_9/lonely.md',
      'tokens': 3,
      'missing': false,
      'degree': 0,
    },
    {
      'id': 'g1',
      'slug': 'MACHINE',
      'file': 'MACHINE.md',
      'title': '机器全局记忆',
      'summary': '跨项目共享',
      'type': 'auto',
      'scope': 'machine',
      'dirId': null,
      'size': 100,
      'path': '/mem/_machine/MACHINE.md',
      'rel': '_machine/MACHINE.md',
      'tokens': 25,
      'missing': false,
      'degree': 2,
    },
    {
      'id': 'n1',
      'slug': 'mkt',
      'file': 'mkt.md',
      'title': '营销素材',
      'summary': '素材库',
      'type': 'feedback',
      'scope': 'cli',
      'sub': 'codex',
      'dirId': 'd2',
      'size': 9,
      'path': '/mem/d2/_cli/codex/mkt.md',
      'rel': 'd2/_cli/codex/mkt.md',
      'tokens': 2,
      'missing': false,
      'degree': 1,
    },
    {
      'id': 'n2',
      'slug': 'session-note',
      'file': 'note.md',
      'title': '会话笔记',
      'summary': '会话里记下来的东西',
      'type': 'note',
      'scope': 'session',
      'sessionId': 'chat-2',
      'sub': 'chat-2',
      'dirId': 'd2',
      'size': 30,
      'path': '/mem/d2/sessions/chat-2/note.md',
      'rel': 'd2/sessions/chat-2/note.md',
      'tokens': 8,
      'missing': false,
      'degree': 1,
    },
  ],
  'edges': [
    {'source': 'm1', 'target': 'm2', 'type': 'reference', 'strength': 1},
    {'source': 'm1', 'target': 'm3', 'type': 'reference', 'strength': 3},
    {'source': 'g1', 'target': 'm1', 'type': 'reference', 'strength': 1},
    {'source': 'm1', 'target': 'n1', 'type': 'reference', 'strength': 1},
    {'source': 'n1', 'target': 'n2', 'type': 'reference', 'strength': 1},
  ],
};

/// 记录请求头的假 client：顺带验证鉴权头是照 air_service 的写法发的。
http.Client _client(Map<String, dynamic> payload, {List<String>? sentTokens}) {
  return MockClient((request) async {
    if (request.url.path != '/api/memory/graph') {
      return http.Response('not found', 404, headers: _jsonHeaders);
    }
    sentTokens?.add(request.headers['X-Access-Token'] ?? '');
    return jsonResponse(payload);
  });
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  // SettingsService 是按进程缓存的单例，host/token 只读一次；整个文件共用一份
  // 「不可达端口 + 固定 token」的设置（真请求全被 MockClient 截住）。
  late SettingsService settings;

  setUpAll(() async {
    SharedPreferences.setMockInitialValues({
      'multicc_host': 'http://127.0.0.1:9',
      'multicc_token': 'tkn-memory-graph',
    });
    settings = await SettingsService.getInstance();
  });

  Future<MemoryGraphScreenState> pumpScreen(
    WidgetTester tester,
    http.Client client, {
    void Function(String rel)? onOpenFile,
  }) async {
    await tester.pumpWidget(
      MaterialApp(
        home: MemoryGraphScreen(
          settings: settings,
          httpClient: client,
          onOpenFile: onOpenFile,
        ),
      ),
    );
    await tester.pumpAndSettle();
    return tester.state<MemoryGraphScreenState>(find.byType(MemoryGraphScreen));
  }

  /// 点在画布内的某个坐标上。GestureDetector 上同时挂着双击，单击要等双击窗口
  /// （kDoubleTapTimeout）过去才会回调，所以这里先把时钟推过去。
  Future<void> tapCanvas(WidgetTester tester, Offset local) async {
    final box = tester.renderObject<RenderBox>(
      find.byKey(const ValueKey('memory-graph-canvas')),
    );
    await tester.tapAt(box.localToGlobal(local));
    await tester.pump(kDoubleTapTimeout + const Duration(milliseconds: 50));
    await tester.pumpAndSettle();
  }

  group('MemoryGraphPayload', () {
    test('缺字段一律给默认值，不抛', () {
      final payload = MemoryGraphPayload.fromJson({
        'nodes': [
          {'id': 'n1'},
          {'id': 'n2', 'missing': true},
          'not-a-map',
          {'slug': 'no-id'}, // 没有 id 的节点画不出来，丢掉
        ],
        'edges': [
          {'source': 'n1', 'target': 'n2'},
          {'source': 'n1'}, // 缺目标端点 —— 整条丢掉
        ],
        'meta': null,
      });
      expect(payload.nodes.length, 2);
      expect(payload.nodes.first.type, '');
      expect(payload.nodes.first.degree, 0);
      expect(payload.nodes.first.rel, isNull);
      expect(payload.nodes[1].missing, isTrue);
      expect(payload.edges.length, 1);
      expect(payload.edges.first.strength, 1);
      expect(payload.meta.projects, isEmpty);
      expect(payload.meta.truncated, isFalse);
    });

    test('filterByProject：命中 dirId 的留下，全局层（machine / cli）都保留', () {
      final payload = MemoryGraphPayload.fromJson(_samplePayload());
      final all = payload.filterByProject('all');
      expect(all.nodes.length, 7);
      expect(all.edges.length, 5);

      final d1 = payload.filterByProject('d1');
      // n1 虽然是 d2 的目录，但 scope 是 cli —— 全局层，对每个项目都保留。
      expect(d1.nodes.map((n) => n.id), ['m1', 'm2', 'm3', 'm4', 'g1', 'n1']);
      // n1—→n2 那条边必须消失（n2 不在子图里）。
      expect(d1.edges.map((e) => '${e.source}->${e.target}'), [
        'm1->m2',
        'm1->m3',
        'g1->m1',
        'm1->n1',
      ]);

      final d2 = payload.filterByProject('d2');
      // n1 + n2 + 全局层 g1；g1—→m1、m1—→n1 两条都因为另一端不在子图里而消失。
      expect(d2.nodes.map((n) => n.id), ['g1', 'n1', 'n2']);
      expect(d2.edges.map((e) => '${e.source}->${e.target}'), ['n1->n2']);
    });
  });

  group('MemoryGraphScreen', () {
    testWidgets('正常渲染：画布 + 计数行 + 图例只画出现过的类型与作用域', (tester) async {
      final tokens = <String>[];
      await pumpScreen(tester, _client(_samplePayload(), sentTokens: tokens));

      expect(find.byKey(const ValueKey('memory-graph-canvas')), findsOneWidget);
      // 默认落在「节点最多的那个项目」（Web `projects[0]`），不是「全部」。
      expect(
        find.textContaining('6 节点 · 4 边 · 服务端 7ms'),
        findsOneWidget,
      );
      // 图例：当前子图里出现过的类型与作用域。
      for (final label in [
        '项目',
        '索引/入口',
        '未创建(悬空引用)',
        '笔记',
        '自动提炼',
        '反馈',
      ]) {
        expect(find.text(label), findsOneWidget);
      }
      for (final label in ['公共记忆', '机器全局', '任务级', 'CLI 特有']) {
        expect(find.text(label), findsOneWidget);
      }
      expect(find.text('加载中…'), findsNothing);
      // 鉴权头照 air_service 的写法发。
      expect(tokens, ['tkn-memory-graph']);
    });

    testWidgets('meta.truncated 补上「已截断至 N」', (tester) async {
      await pumpScreen(tester, _client(_samplePayload(truncated: true)));
      expect(find.textContaining('已截断至 1200'), findsOneWidget);
    });

    testWidgets('切项目：全局层保留，跨项目边消失', (tester) async {
      final state = await pumpScreen(tester, _client(_samplePayload()));

      await tester.tap(find.byKey(const ValueKey('memory-graph-project-filter')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('工作目录 B (2)').last);
      await tester.pumpAndSettle();

      expect(find.textContaining('3 节点 · 1 边'), findsOneWidget);
      // 过滤是重建布局：d2 的节点 + 全局层在，d1 的已经不在图里。
      expect(state.nodeCenterInCanvas('n1'), isNotNull);
      expect(state.nodeCenterInCanvas('n2'), isNotNull);
      expect(state.nodeCenterInCanvas('g1'), isNotNull);
      expect(state.nodeCenterInCanvas('m1'), isNull);
      expect(state.nodeCenterInCanvas('m4'), isNull);
    });

    testWidgets('点节点 → 详情：路径 / tokens / 尺寸 / 摘要 / 邻居 ×strength', (tester) async {
      final state = await pumpScreen(tester, _client(_samplePayload()));
      await tapCanvas(tester, state.nodeCenterInCanvas('m1')!);

      expect(
        tester
            .widget<Text>(find.byKey(const ValueKey('memory-graph-node-title')))
            .data,
        '龙头战法',
      );
      expect(find.text('dragon.md   ·   公共记忆'), findsOneWidget);
      expect(find.text('类型: 项目'), findsOneWidget);
      expect(find.text('作用域: shared'), findsOneWidget);
      expect(find.text('关联度: 3'), findsOneWidget);
      expect(find.text('/mem/d1/_shared/dragon.md'), findsOneWidget);
      expect(find.text('~2045 tokens'), findsOneWidget);
      expect(find.text('5.1 KB'), findsOneWidget);
      expect(
        tester
            .widget<Text>(
              find.byKey(const ValueKey('memory-graph-node-detail')),
            )
            .data,
        '打板负EV，低吸+扩展度过滤是唯一突破',
      );
      expect(find.text('引用了 (3)'), findsOneWidget);
      expect(find.text('被引用 (1)'), findsOneWidget);
      expect(find.text('→ 本会话私有记忆'), findsOneWidget);
      // 引用 3 次才显示 ×3（Web：`it.s > 1 ? '  ×' + it.s : ''`）。
      expect(find.text('→ 未创建的记忆  ×3'), findsOneWidget);
      expect(find.text('← 机器全局记忆'), findsOneWidget);
      expect(find.byKey(const ValueKey('memory-graph-node-copy')), findsOneWidget);
      expect(find.byKey(const ValueKey('memory-graph-node-edit')), findsOneWidget);

      // 点邻居 = 换成它的详情（视口同时也对准它，这里只验面板）。
      await tester.tap(find.text('→ 未创建的记忆  ×3'));
      await tester.pumpAndSettle();
      expect(
        tester
            .widget<Text>(find.byKey(const ValueKey('memory-graph-node-title')))
            .data,
        '未创建的记忆',
      );
      // 悬空引用：没有路径可复制/编辑，token 与尺寸显示成「–」。
      expect(find.text('（文件尚未创建）'), findsOneWidget);
      expect(find.text('⚠ 悬空引用'), findsOneWidget);
      expect(find.text('–'), findsNWidgets(2));
      expect(find.byKey(const ValueKey('memory-graph-node-edit')), findsNothing);
      expect(find.byKey(const ValueKey('memory-graph-node-copy')), findsNothing);
    });

    testWidgets('编辑：先收起面板再回调 rel（Web 也是先关弹窗）', (tester) async {
      final opened = <String>[];
      final state = await pumpScreen(
        tester,
        _client(_samplePayload()),
        onOpenFile: opened.add,
      );
      await tapCanvas(tester, state.nodeCenterInCanvas('m1')!);
      await tester.tap(find.byKey(const ValueKey('memory-graph-node-edit')));
      await tester.pumpAndSettle();

      expect(opened, ['d1/_shared/dragon.md']);
      // 面板已经收掉（不叠在编辑器上）。
      expect(find.byKey(const ValueKey('memory-graph-node-title')), findsNothing);
    });

    testWidgets('孤立节点显示「（暂无关联，孤立节点）」', (tester) async {
      final state = await pumpScreen(tester, _client(_samplePayload()));
      await tapCanvas(tester, state.nodeCenterInCanvas('m4')!);
      expect(find.text('（暂无关联，孤立节点）'), findsOneWidget);
      // 空摘要给「（无摘要）」（Web 同一句）。
      expect(
        tester
            .widget<Text>(
              find.byKey(const ValueKey('memory-graph-node-detail')),
            )
            .data,
        '（无摘要）',
      );
      // 副标题是「文件名   ·   作用域全名」一整串（Web 的 slugEl 也是拼出来的）。
      expect(find.text('lonely.md   ·   任务级 · tsk_9'), findsOneWidget);
    });

    testWidgets('缩放级标签：缩到最小只剩枢纽，放大到位孤立节点也标', (tester) async {
      final state = await pumpScreen(tester, _client(_samplePayload()));
      final layout = state.layout!;
      TextPainter? labelOf(String id) => layout.visibleLabel(layout.byId[id]!);

      layout.scale = 1;
      expect(labelOf('m1'), isNotNull); // degree 3
      expect(labelOf('m4'), isNull); // 孤立节点默认不标

      layout.scale = 0.2;
      expect(labelOf('m1'), isNull); // degree 3 < 8

      layout.scale = 1.4;
      expect(labelOf('m4'), isNotNull);
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
      expect(find.text('暂无任何记忆节点。'), findsOneWidget);
      expect(find.byKey(const ValueKey('memory-graph-canvas')), findsNothing);
      expect(find.textContaining('0 节点 · 0 边 · 服务端 3ms'), findsOneWidget);
    });

    testWidgets('接口失败 → 显示服务端那句真实错误', (tester) async {
      await pumpScreen(
        tester,
        MockClient(
          (request) async => http.Response(
            jsonEncode({'error': 'graph build failed: EACCES'}),
            500,
            headers: _jsonHeaders,
          ),
        ),
      );
      expect(find.text('加载失败：graph build failed: EACCES'), findsOneWidget);
      expect(find.byKey(const ValueKey('memory-graph-retry')), findsOneWidget);
      expect(find.byKey(const ValueKey('memory-graph-canvas')), findsNothing);
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
