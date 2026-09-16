import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/services/air_service.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/widgets/air/air_ops_store.dart';
import 'package:multicc_app/widgets/air/air_sidebar.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// 侧栏的「最近任务」那一带：它吃掉侧栏剩下的高度并在内部滚。
///
/// 这是 Web `#tasks{flex:1 1 auto; overflow-y:auto}` 的对应物，也是侧栏下半截那片
/// 空白的去处 —— 任务带以前是「八条任务 + 一大片什么都没有」，因为列表按内容
/// 自然高度摆，剩下的高度没人要。这里盯的是三件事：框吃掉剩余高度（跟任务条数
/// 无关）、多出来的行在框里滚、页脚仍贴着下沿。
void main() {
  setUpAll(() => I18n.init('zh'));

  const listKey = ValueKey('air-sidebar-tasks');
  const slogan = '让每一次对话，都有清晰的目标。';

  AirSnapshot snapshot(int taskCount) => AirSnapshot.fromJson({
    'directories': const [
      {'id': 'd1', 'name': '工作目录 A', 'path': '/project/a'},
    ],
    'clis': const ['claude'],
    'sessions': const [],
    'tasks': [
      for (var i = 1; i <= taskCount; i += 1)
        {
          'id': 't$i',
          'dirId': 'd1',
          'title': '任务 $i',
          'status': 'active',
          'recordType': 'planned',
          'workflowStage': 'doing',
          'updatedAt': 100 - i,
        },
    ],
  });

  Future<void> pumpSidebar(
    WidgetTester tester, {
    required int taskCount,
    required Size surface,
  }) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = surface;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    SharedPreferences.setMockInitialValues({
      'multicc_host': 'http://localhost:3000',
    });
    final settings = await SettingsService.getInstance();
    final ops = AirOpsStore(settings: settings);
    addTearDown(ops.dispose);

    final data = snapshot(taskCount);
    final scaffoldKey = GlobalKey<ScaffoldState>();
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          key: scaffoldKey,
          drawer: AirSidebar(
            data: data,
            directoryId: 'd1',
            recentTasks: data.tasksOf('d1'),
            advancedMode: false,
            serverLabel: 'localhost:3000',
            onSelectDirectory: (_) {},
            onOpenLibrary: () {},
            onOpenSearch: () {},
            onOpenConsole: () {},
            onOpenSchedules: () {},
            onOpenTaskBoard: () {},
            onCreateTask: () {},
            onOpenTask: (_) {},
            terminalSessions: const [],
            onOpenTerminal: (_) {},
            onOpenDocs: () {},
            onOpenMemory: () {},
            onOpenTaskGraph: () {},
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
  }

  ScrollableState listScroll(WidgetTester tester) => tester.state<ScrollableState>(
    find.descendant(of: find.byKey(listKey), matching: find.byType(Scrollable)),
  );

  ScrollableState sidebarScroll(WidgetTester tester) => tester.state<ScrollableState>(
    find.ancestor(of: find.byKey(listKey), matching: find.byType(Scrollable)).last,
  );

  testWidgets('任务清单吃掉侧栏剩下的高度，多出来的行在框里滚', (tester) async {
    await pumpSidebar(tester, taskCount: 24, surface: const Size(420, 880));

    final list = tester.getRect(find.byKey(listKey));
    final caption = tester.getRect(find.text('最近任务'));
    final foot = tester.getRect(find.text(slogan));

    // 框高是「剩下的高度」，不是 24 条任务的自然高度（那得一千多像素）。
    expect(list.height, greaterThan(200), reason: '清单该吃掉剩下的高度');
    expect(list.height, lessThan(500), reason: '清单是侧栏的一部分，不该把页脚顶出屏幕');
    // 清单紧跟在「＋ 新任务」下面（中间只有那 6px）—— 这一段以前是清单的自然
    // 高度换来的空白，现在是清单自己的框。
    final create = tester.getRect(find.byKey(const ValueKey('air-sidebar-create')));
    expect(list.top - create.bottom, lessThan(20));
    // 三段加起来正好是侧栏的高度：既没有多出来的空白留在页脚上面，也没有谁被
    // 顶出屏幕（那才会让整条侧栏需要滚）。
    expect(sidebarScroll(tester).position.maxScrollExtent, 0);
    // 页脚仍贴着抽屉下沿 —— 那点剩余高度是清单的，不是把页脚推上去推出来的。
    expect(foot.bottom, closeTo(868, 8));

    // 多出来的行在这个框里，滚得出来。
    final scroll = listScroll(tester);
    expect(scroll.position.maxScrollExtent, greaterThan(0), reason: '24 条任务装不进这一屏');
    expect(find.byKey(const ValueKey('air-side-task-t24')), findsNothing, reason: '长尾还没进视口');
    scroll.position.jumpTo(scroll.position.maxScrollExtent);
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('air-side-task-t24')), findsOneWidget, reason: '滚下去能拿到最后一条');
    // 滚的是清单，抬头不动。
    expect(tester.getRect(find.text('最近任务')), caption);

    expect(tester.takeException(), isNull);
  });

  testWidgets('只有两条任务时框也不缩：空白留在框里，页脚仍在下沿', (tester) async {
    await pumpSidebar(tester, taskCount: 2, surface: const Size(420, 880));

    final list = tester.getRect(find.byKey(listKey));
    final foot = tester.getRect(find.text(slogan));

    // 两条任务的自然高度不到 100，框仍然是那一份剩余高度 —— 容器相对固定，
    // 空白是框内部的（看不见），不是页脚上面的一片空地。
    expect(list.height, greaterThan(150));
    expect(listScroll(tester).position.maxScrollExtent, 0, reason: '两条任务用不着滚');
    expect(sidebarScroll(tester).position.maxScrollExtent, 0);
    expect(foot.bottom, closeTo(868, 8));
    expect(tester.takeException(), isNull);
  });

  testWidgets('矮屏上清单压到下限，改由整条侧栏一起滚', (tester) async {
    await pumpSidebar(tester, taskCount: 24, surface: const Size(400, 620));

    final list = tester.getRect(find.byKey(listKey));
    // 上下两段固定内容加起来就快把 620 占满了，清单只剩 120 的下限。
    expect(list.height, closeTo(120, 1));
    expect(listScroll(tester).position.maxScrollExtent, greaterThan(0));
    // 装不下就整条侧栏一起滚（同 Web 矮屏退回整条 aside 滚动），页脚滚得到。
    final sidebar = sidebarScroll(tester);
    expect(sidebar.position.maxScrollExtent, greaterThan(0));
    sidebar.position.jumpTo(sidebar.position.maxScrollExtent);
    await tester.pumpAndSettle();
    expect(find.text(slogan), findsOneWidget);
    expect(tester.getRect(find.text(slogan)).bottom, closeTo(620, 12));
    expect(tester.takeException(), isNull);
  });
}
