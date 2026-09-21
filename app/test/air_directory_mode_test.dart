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
      // 两个 CLI：点「新建终端」时该问一句用哪个（只有一个就直接用，不问）。
      'clis': const ['claude', 'codex'],
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
      'sessions': const [
        {'id': 's1', 'dirId': 'd1', 'label': 'a 的巡检终端', 'cli': 'claude'},
        {'id': 's2', 'dirId': 'd1', 'label': 'a 的另一个终端', 'cli': 'codex'},
        {'id': 's3', 'dirId': 'd2', 'label': 'b 的终端', 'cli': 'claude'},
      ],
    }),
    200,
    headers: {'content-type': 'application/json; charset=utf-8'},
  );
});

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

  Future<void> pumpView(WidgetTester tester) async {
    final settings = await _settings();
    final client = _client(<String>[]);
    addTearDown(client.close);
    // 手机竖屏那样高：默认 800×600 的测试视口里，顶部那道切换 + 输入框就把
    // 任务行/终端行挤出可见区，而 ListView 不会 build 看不见的孩子 —— 找不到
    // 不等于没渲染。
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(390, 900);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(
      MaterialApp(home: AirTasksView(settings: settings, httpClient: client)),
    );
    await tester.pumpAndSettle();
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

  testWidgets('「新建终端」问 CLI，不替用户猜', (tester) async {
    await pumpView(tester);
    await switchTo(tester, 'terminal');

    await tester.tap(find.byKey(const ValueKey('air-new-terminal-button')));
    await tester.pumpAndSettle();
    expect(find.text('用哪个 CLI 开这个终端？'), findsOneWidget);
    expect(find.byKey(const ValueKey('air-terminal-cli-claude')), findsOneWidget);
    expect(find.byKey(const ValueKey('air-terminal-cli-codex')), findsOneWidget);
    expect(tester.takeException(), isNull);

    // 关掉这一层：选一个会去建会话并 push 真的终端页（见文件头）。
    Navigator.of(
      tester.element(find.byKey(const ValueKey('air-terminal-cli-claude'))),
    ).pop();
    await tester.pumpAndSettle();
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
