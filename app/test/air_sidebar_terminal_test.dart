import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/services/air_service.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/widgets/air/air_ops_store.dart';
import 'package:multicc_app/widgets/air/air_sidebar.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// 侧栏「更多与系统」里的 TERMINAL 一组（Web `air.html` 的
/// `details.terminal-group` + `#legacy-sessions`）。
///
/// 这一组只认**当前目录**：同一个快照里别的目录的终端不该出现在这里 —— Web 那
/// 句 `session.dirId === directoryId` 就是唯一的筛选条件。
void main() {
  setUpAll(() => I18n.init('zh'));

  AirSnapshot snapshot() => AirSnapshot.fromJson(const {
    'directories': [
      {'id': 'd1', 'name': '工作目录 A', 'path': '/project/a'},
      {'id': 'd2', 'name': '工作目录 B', 'path': '/project/b'},
      // d3 一个终端都没有：空态是「这个目录还没开过终端」，不是整组坏掉。
      {'id': 'd3', 'name': '工作目录 C', 'path': '/project/c'},
    ],
    'tasks': [],
    'clis': ['claude'],
    'sessions': [
      {'id': 's1', 'dirId': 'd1', 'label': 'a 的巡检终端', 'cli': 'claude'},
      {'id': 's2', 'dirId': 'd2', 'label': 'b 的终端', 'cli': 'codex'},
      {'id': 's3', 'dirId': 'd1', 'label': 'a 的另一个终端', 'cli': 'claude'},
    ],
  });

  /// 展开「更多与系统」→ 展开 TERMINAL，返回被点开过的终端会话。
  Future<List<AirSession>> pumpAndOpenTerminal(
    WidgetTester tester, {
    String directoryId = 'd1',
  }) async {
    SharedPreferences.setMockInitialValues({
      'multicc_host': 'http://localhost:3000',
    });
    final settings = await SettingsService.getInstance();
    final ops = AirOpsStore(settings: settings);
    addTearDown(ops.dispose);

    final data = snapshot();
    final opened = <AirSession>[];
    final scaffoldKey = GlobalKey<ScaffoldState>();
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          key: scaffoldKey,
          drawer: AirSidebar(
            data: data,
            directoryId: directoryId,
            favorites: const [],
            recentTasks: const [],
            advancedMode: false,
            serverLabel: 'localhost:3000',
            onSelectDirectory: (_) {},
            onToggleFavorite: () {},
            onOpenLibrary: () {},
            onOpenSearch: () {},
            onOpenConsole: () {},
            onOpenSchedules: () {},
            onOpenTaskBoard: () {},
            onCreateTask: () {},
            onOpenTask: (_) {},
            terminalSessions: data.terminalSessionsOf(directoryId),
            onOpenTerminal: opened.add,
            onOpenDocs: () {},
            onOpenMemory: () {},
            onOpenSettings: () {},
            onOpenAllDestinations: () {},
            ops: ops,
            onOpenPush: () {},
            onLogout: () {},
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    scaffoldKey.currentState!.openDrawer();
    await tester.pumpAndSettle();

    // 「更多与系统」在侧栏底部，600 高的测试视口里要先滚到它。
    await tester.ensureVisible(find.text('更多与系统'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('更多与系统'));
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('TERMINAL'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('TERMINAL'));
    await tester.pumpAndSettle();
    return opened;
  }

  testWidgets('TERMINAL 一组只列当前目录的终端，点一行回传那一条', (tester) async {
    final opened = await pumpAndOpenTerminal(tester);

    expect(find.text('a 的巡检终端'), findsOneWidget);
    expect(find.text('a 的另一个终端'), findsOneWidget);
    // 别的目录的终端不该出现在这一组里。
    expect(find.text('b 的终端'), findsNothing);

    await tester.tap(find.text('a 的巡检终端'));
    await tester.pumpAndSettle();
    expect(opened.map((s) => s.id), ['s1']);
    expect(opened.single.dirId, 'd1');
    expect(tester.takeException(), isNull);
  });

  testWidgets('当前目录没有终端时给一句说明，不是空荡荡一片', (tester) async {
    final opened = await pumpAndOpenTerminal(tester, directoryId: 'd3');
    expect(find.text('本目录暂无终端会话'), findsOneWidget);
    expect(opened, isEmpty);
    expect(tester.takeException(), isNull);
  });
}
