import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/models/message.dart';
import 'package:multicc_app/providers/session_manager.dart';
import 'package:multicc_app/services/onboarding_store.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/widgets/air_tasks_view.dart';
import 'package:multicc_app/widgets/create_session_dialog.dart';

/// 目录首页顶部那道 Chat / Terminal 切换（Web `public/air.html` 的
/// `#directory-mode`）。
///
/// 判据是「不混在一起」：一次只显示一类，默认 chat；终端跟的是**当前目录**，
/// 别的目录的终端不该出现在这一份里（`/api/air` 的 `sessions` 已经按 `dirId`
/// 筛过，客户端只按这一份分）。
///
/// 刻意不点终端行、也不在 CLI 选择里真的选一个：两条路最后都会 push
/// `TerminalScreen`，那一页会去开真的 WebSocket，在 widget 测试里留下一串重连
/// 定时器。这里断到「列表 / 空态 / 新建入口与 CLI 提问」为止。
MockClient _client(List<String> requests) => MockClient((request) async {
  requests.add('${request.method} ${request.url.path}');
  return http.Response(
    jsonEncode({
      'ok': true,
      // 点「新建终端」时该问一句用哪个（只有一个就直接用，不问）。清单里混进
      // 两个**不该出现**的：`kimi` 这台客户端认不出（parseCli 会静默落回 claude，
      // 等于建错终端），`codex-exp` 是实验适配器 —— 两者都不该成为选项。
      'clis': const ['claude', 'codex', 'kimi', 'codex-exp'],
      'directories': const [
        {'id': 'd1', 'name': '工作目录 A', 'path': '/project/a'},
        {'id': 'd2', 'name': '工作目录 B', 'path': '/project/b'},
        // d3 一个终端都没有 —— 空态说的是「这个目录还没开过终端」。
        {'id': 'd3', 'name': '工作目录 C', 'path': '/project/c'},
      ],
      'tasks': const [
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
      ],
      'sessions': [
        // 三态由服务端折好给过来，行上画的只是这三个事实的翻译。五分钟是相对测试
        // 假钟量的，所以「最后输出 5 分钟前」那句是稳的。
        {
          'id': 's1',
          'dirId': 'd1',
          'label': 'a 的巡检终端',
          'cli': 'claude',
          'state': 'running',
          'lastActivityAt':
              DateTime.now().millisecondsSinceEpoch - 5 * 60 * 1000,
          'createdAt': 1700000000000,
        },
        {
          'id': 's2',
          'dirId': 'd1',
          'label': 'a 的另一个终端',
          'cli': 'codex',
          'state': 'route_dead',
          'lastActivityAt': null,
        },
        {
          'id': 's3',
          'dirId': 'd2',
          'label': 'b 的终端',
          'cli': 'claude',
          'state': 'stopped',
          'lastActivityAt': null,
        },
      ],
    }),
    200,
    headers: {'content-type': 'application/json; charset=utf-8'},
  );
});

/// 只记改名调用、不发请求：真 SessionManager 的 renameSession 会 PATCH 到真主机，
/// widget 测试关心的是「这一行把哪一对 (id, label) 交出去了」。
class _RecordingManager extends SessionManager {
  _RecordingManager({required super.settings});

  final renamedIds = <String>[];
  final renamedLabels = <String?>[];

  @override
  Future<void> renameSession(String id, String? label) async {
    renamedIds.add(id);
    renamedLabels.add(label);
  }
}

Future<SettingsService> _settings() async {
  SharedPreferences.setMockInitialValues({
    'multicc_host': 'http://localhost:3000',
    // 引导自己有一份测试；这里标成走完，免得首页被切到目录库模式。
    OnboardingStore.doneKey: '1',
  });
  return SettingsService.getInstance();
}

void main() {
  setUpAll(() => I18n.init('zh'));

  _RecordingManager? liveManager;

  Future<List<String>> pumpView(
    WidgetTester tester, {
    _RecordingManager? manager,
  }) async {
    final settings = await _settings();
    final requests = <String>[];
    final client = _client(requests);
    addTearDown(client.close);
    final mgr = manager ?? _RecordingManager(settings: settings);
    // SessionManager 构造里就起一条 5s 轮询定时器，而 widget 测试不允许 body 结束
    // 时还挂着定时器 —— 所以必须在 body 里 dispose（每个测试结尾都走 closeView），
    // 不能丢给 addTearDown（那在不变量检查之后才跑）。
    liveManager = mgr;
    // 手机竖屏那样高：默认 800×600 的测试视口里，顶部那道切换 + 输入框就把
    // 任务行/终端行挤出可见区，而 ListView 不会 build 看不见的孩子 —— 找不到
    // 不等于没渲染。
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(390, 900);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(
      ChangeNotifierProvider<SessionManager>.value(
        value: mgr,
        child: MaterialApp(
          home: AirTasksView(settings: settings, httpClient: client),
        ),
      ),
    );
    await tester.pumpAndSettle();
    return requests;
  }

  Future<void> switchTo(WidgetTester tester, String mode) async {
    await tester.tap(find.byKey(ValueKey('air-directory-mode-$mode')));
    await tester.pumpAndSettle();
  }

  /// 走目录库切到另一个目录（和用户点 ☰ › 工作目录库 › 目录卡是同一条路）。
  Future<void> openDirectory(WidgetTester tester, String dirId) async {
    await tester.tap(find.byKey(const ValueKey('air-header-menu')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('工作目录库'));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(ValueKey('air-directory-$dirId')));
    await tester.pumpAndSettle();
  }

  Future<void> closeView(WidgetTester tester) async {
    await tester.pumpWidget(const SizedBox());
    liveManager?.dispose();
    liveManager = null;
  }

  testWidgets('目录首页顶部有 Chat / Terminal 切换，默认停在 Chat', (tester) async {
    await pumpView(tester);

    expect(find.byKey(const ValueKey('air-directory-mode')), findsOneWidget);
    expect(find.text('Chat'), findsOneWidget);
    expect(find.text('Terminal'), findsOneWidget);
    // 默认 chat：任务那一类的内容在，终端那一类的不在。
    expect(find.text('登录页面'), findsOneWidget);
    expect(find.byKey(const ValueKey('air-terminals-heading')), findsNothing);
    expect(find.byKey(const ValueKey('air-new-terminal-button')), findsNothing);
    expect(tester.takeException(), isNull);
    await closeView(tester);
  });

  testWidgets('切到 Terminal：只列当前目录的终端，任务清单让位', (tester) async {
    await pumpView(tester);

    await switchTo(tester, 'terminal');

    expect(find.byKey(const ValueKey('air-terminals-heading')), findsOneWidget);
    expect(find.text('2 个终端'), findsOneWidget);
    expect(find.text('a 的巡检终端'), findsOneWidget);
    expect(find.text('a 的另一个终端'), findsOneWidget);
    // 别的目录的终端不该出现在当前目录这一份里。
    expect(find.text('b 的终端'), findsNothing);
    // 混排的判据：任务那一类的东西整块不在了（不是排在下面）。
    expect(find.text('登录页面'), findsNothing);
    expect(find.text('最近任务'), findsNothing);
    expect(tester.takeException(), isNull);

    // 切回 Chat，任务又回来 —— 两边是同一份快照的两种摆法，谁也不吃掉谁。
    await switchTo(tester, 'chat');
    expect(find.text('登录页面'), findsOneWidget);
    expect(find.byKey(const ValueKey('air-terminals-heading')), findsNothing);
    await closeView(tester);
  });

  testWidgets('终端行有删除按钮：先确认，取消就不发任何请求', (tester) async {
    final requests = await pumpView(tester);
    await switchTo(tester, 'terminal');

    // 每一行一颗删除（用户报过这里没有删除入口）。
    expect(find.byKey(const ValueKey('air-terminal-delete-s1')), findsOneWidget);
    expect(find.byKey(const ValueKey('air-terminal-delete-s2')), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('air-terminal-delete-s1')));
    await tester.pumpAndSettle();
    // 确认框和会话卡同一个口径（deleteSessionConfirm / deleteSessionBody）。
    expect(find.text(t('deleteSessionConfirm')), findsOneWidget);
    expect(
      find.text(t('deleteSessionBody', {'id': 'a 的巡检终端'})),
      findsOneWidget,
    );

    // 取消 = 一行都不发（删除是 DELETE，不能打成别的请求）。
    await tester.tap(find.text(t('cancel')));
    await tester.pumpAndSettle();
    expect(requests.where((r) => r.startsWith('DELETE')), isEmpty);
    expect(find.byKey(const ValueKey('air-terminal-delete-s1')), findsOneWidget);
    expect(tester.takeException(), isNull);
    await closeView(tester);
  });

  testWidgets('终端行也能重启：先确认，取消就不发请求', (tester) async {
    final requests = await pumpView(tester);
    await switchTo(tester, 'terminal');

    expect(find.byKey(const ValueKey('air-terminal-restart-s1')), findsOneWidget);
    expect(find.byKey(const ValueKey('air-terminal-restart-s2')), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('air-terminal-restart-s1')));
    await tester.pumpAndSettle();
    // 说清楚后果：进程被杀、CLI 以全新对话重开（服务端会清 cliSessionId）。
    expect(
      find.text(t('airTerminalRestartConfirm', {'label': 'a 的巡检终端'})),
      findsOneWidget,
    );

    await tester.tap(find.text(t('cancel')));
    await tester.pumpAndSettle();
    expect(requests.where((r) => r.contains('/restart')), isEmpty);
    expect(tester.takeException(), isNull);
    await closeView(tester);
  });

  testWidgets('终端行：状态点、元信息，与出问题时的提示行', (tester) async {
    await pumpView(tester);
    await switchTo(tester, 'terminal');

    // 状态点与元信息只翻译服务端折好的 state / lastActivityAt，客户端不自己推。
    expect(
      find.textContaining('claude · 运行中 · 最后输出 5 分钟前'),
      findsOneWidget,
    );
    expect(find.textContaining('codex · 路由失效'), findsOneWidget);
    // 路由失效的那条没有 lastActivityAt：「多久没动」整段不出现，全列表只有一处。
    expect(find.textContaining('最后输出'), findsOneWidget);
    // 出问题的状态要说清「怎么了、怎么办」；running 不给提示行（多一行字只是噪音）。
    expect(find.text(t('airTerminalRouteDeadHint')), findsOneWidget);
    expect(find.text(t('airTerminalStoppedHint')), findsNothing);
    expect(tester.takeException(), isNull);
    await closeView(tester);
  });

  testWidgets('终端行重命名：先问一句，交出 (id, label)，取消什么都不发', (tester) async {
    final mgr = _RecordingManager(settings: await _settings());
    final requests = await pumpView(tester, manager: mgr);
    await switchTo(tester, 'terminal');

    await tester.tap(find.byKey(const ValueKey('air-terminal-rename-s1')));
    await tester.pumpAndSettle();
    expect(
      find.text(t('airTerminalRenamePrompt', {'label': 'a 的巡检终端'})),
      findsOneWidget,
    );

    // 取消 = 不改名（也不能打成别的请求）。
    await tester.tap(find.text(t('cancel')));
    await tester.pumpAndSettle();
    expect(mgr.renamedIds, isEmpty);
    expect(requests.where((r) => r.startsWith('PATCH')), isEmpty);

    await tester.tap(find.byKey(const ValueKey('air-terminal-rename-s1')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), '  Build box  ');
    await tester.tap(find.text(t('save')));
    await tester.pumpAndSettle();
    // 首尾空白不交给服务端：服务端拿它当名字存。
    expect(mgr.renamedIds, ['s1']);
    expect(mgr.renamedLabels, ['Build box']);
    expect(find.text(t('airTerminalRenamed')), findsOneWidget);
    expect(tester.takeException(), isNull);
    await closeView(tester);
  });

  testWidgets('终端行复制 id：剪贴板里就是那一行的 id', (tester) async {
    final copied = <String>[];
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
      SystemChannels.platform,
      (call) async {
        if (call.method == 'Clipboard.setData') {
          copied.add('${(call.arguments as Map<Object?, Object?>)['text']}');
        }
        return null;
      },
    );
    addTearDown(
      () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        null,
      ),
    );

    await pumpView(tester);
    await switchTo(tester, 'terminal');

    await tester.tap(find.byKey(const ValueKey('air-terminal-copy-s1')));
    await tester.pumpAndSettle();
    // 「已复制」必须是真的：剪贴板里就是这一行的 id，不多不少。
    expect(copied, ['s1']);
    expect(find.text(t('airTerminalIdCopied', {'id': 's1'})), findsOneWidget);
    expect(tester.takeException(), isNull);
    await closeView(tester);
  });

  testWidgets('当前目录没有终端时给一句说明，不是空荡荡一片', (tester) async {
    await pumpView(tester);
    await openDirectory(tester, 'd3');
    await switchTo(tester, 'terminal');

    expect(find.byKey(const ValueKey('air-terminals-empty')), findsOneWidget);
    expect(find.text('本目录暂无终端会话'), findsOneWidget);
    expect(find.text('0 个终端'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await closeView(tester);
  });

  testWidgets('换一个目录：回到 Chat，且只列那个目录的终端', (tester) async {
    await pumpView(tester);
    await switchTo(tester, 'terminal');
    expect(find.text('a 的巡检终端'), findsOneWidget);

    await openDirectory(tester, 'd2');

    // 默认 chat 是「每个目录各回一次」的状态，不是被上一次切到 Terminal 记住。
    expect(find.byKey(const ValueKey('air-terminals-heading')), findsNothing);
    expect(find.text('a 的巡检终端'), findsNothing);

    await switchTo(tester, 'terminal');
    expect(find.text('b 的终端'), findsOneWidget);
    expect(find.text('a 的巡检终端'), findsNothing);
    expect(find.text('1 个终端'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await closeView(tester);
  });

  testWidgets('「新建终端」开的是 chat 那套配置对话框（kind=terminal）', (tester) async {
    await pumpView(tester);
    await switchTo(tester, 'terminal');

    await tester.tap(find.byKey(const ValueKey('air-new-terminal-button')));
    await tester.pumpAndSettle();

    // 和 chat 同一个对话框、同一份实现：CLI / Provider / 模型 / 推理强度都在那一层
    // 挑（用户要求终端能像 chat 一样选线路，不是只挑一个 CLI）。
    final dialog = tester.widget<CreateSessionDialog>(
      find.byType(CreateSessionDialog),
    );
    expect(dialog.kind, SessionKind.terminal);
    // 默认是快照里的第一个 CLI。
    expect(dialog.defaultCli, SessionCli.claude);
    // 终端始终给完整那张表：基础模式下 chat 会用「推荐」替你选一条线路，终端要挑的
    // 正是「跑哪个 CLI、哪条线路」，没有等价的可推荐项。
    expect(dialog.basicMode, isFalse);
    // 完整的表里 CLI 是可选的（不是一句只读的推荐摘要）。
    expect(find.byType(DropdownButtonFormField<SessionCli>), findsWidgets);
    expect(tester.takeException(), isNull);

    // 取消 = 什么都不建（建会话并 push 终端页那段见文件头说明，这里不点）。
    await tester.tap(find.text(t('cancel')));
    await tester.pumpAndSettle();
    expect(find.byType(CreateSessionDialog), findsNothing);
    await closeView(tester);
  });

  testWidgets('侧栏不再有 TERMINAL 一组：终端只在目录页里', (tester) async {
    await pumpView(tester);
    await tester.tap(find.byKey(const ValueKey('air-menu-button')));
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('更多与系统'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('更多与系统'));
    await tester.pumpAndSettle();

    // 这一组原来在「更多与系统」里，和设置、主机运维混着排；终端属于每个目录，
    // 已经搬到目录首页顶部那道切换后面，侧栏不该再有一份。
    expect(find.text('TERMINAL'), findsNothing);
    expect(find.byKey(const ValueKey('air-terminal-group')), findsNothing);
    expect(find.text('a 的巡检终端'), findsNothing);
    expect(tester.takeException(), isNull);
    await closeView(tester);
  });
}
