import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/services/air_service.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/widgets/air/air_ops_store.dart';
import 'package:multicc_app/widgets/air/air_sidebar.dart';
import 'package:multicc_app/widgets/air/air_task_status.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// 侧栏「最近任务」每一行上的状态：一条记录到底在不在跑，只有 `airTaskStatus`
/// （生命周期 + 这一轮的 runState）说了算。
///
/// 这一行原来写的是 `airLabel(task.workflowStage ?? task.status)`：观察型记录没有
/// workflowStage，`status` 只有 active/done/archived，翻出来清一色「进行中」——
/// 一条正在跑的、一条等着我回答的、一条早就收工的，在这一行上长得一模一样，
/// 而右边那行小字里的「执行中 · 执行中」还跟它自己说反话。四条不同状态的任务
/// 摆在一起，那个 bug 就再也回不来了。
void main() {
  setUpAll(() => I18n.init('zh'));

  const listKey = ValueKey('air-sidebar-tasks');
  // 长到一定程度的标题（两个汉字的宽度装不下），用来量标题有没有拿回整行宽度。
  const longTitle = '把这一行的状态改对：标题也要能占满整行宽度才对';

  AirSnapshot snapshot() => AirSnapshot.fromJson(const {
    'directories': [
      {'id': 'd1', 'name': '工作目录 A', 'path': '/project/a'},
    ],
    'clis': ['claude'],
    'sessions': [],
    // 四条的生命周期都是「没走完」（done 那条除外），分开它们的只有 runState。
    'tasks': [
      {
        'id': 'run',
        'dirId': 'd1',
        'title': longTitle,
        'status': 'active',
        'recordType': '',
        'runState': 'running',
        // 租约也是 running：徽标已经说了「执行中」，第二层就不该再说一遍。
        'resource': {'lease': 'running'},
        'updatedAt': 400,
      },
      {
        'id': 'wait',
        'dirId': 'd1',
        'title': '等我回答的这条',
        'status': 'active',
        'recordType': '',
        'runState': 'waiting',
        'resource': {'capacityReason': 'workspace_execution_capacity'},
        'updatedAt': 300,
      },
      {
        'id': 'idle',
        'dirId': 'd1',
        'title': '上一轮跑完的这条',
        'status': 'active',
        'recordType': '',
        'runState': 'idle',
        'resource': {'residency': 'resident'},
        'updatedAt': 200,
      },
      {
        'id': 'done',
        'dirId': 'd1',
        'title': '已经收工的这条',
        'status': 'done',
        'recordType': '',
        'runState': 'succeeded',
        'updatedAt': 100,
      },
    ],
  });

  Future<void> pumpSidebar(WidgetTester tester) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(420, 880);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    SharedPreferences.setMockInitialValues({
      'multicc_host': 'http://localhost:3000',
    });
    final settings = await SettingsService.getInstance();
    final ops = AirOpsStore(settings: settings);
    addTearDown(ops.dispose);

    final data = snapshot();
    final scaffoldKey = GlobalKey<ScaffoldState>();
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          key: scaffoldKey,
          drawer: AirSidebar(
            data: data,
            directoryId: 'd1',
            recentTasks: data.tasksOf('d1'),
            pinnedTaskIds: const <String>{},
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
            onOpenDocs: () {},
            onOpenMemory: () {},
            onOpenTaskGraph: () {},
            onOpenSettings: () {},
            onOpenAllDestinations: () {},
            onOpenDestination: (_) {},
            ops: ops,
            onOpenPush: () {},
            onLogout: () {},
          ),
        ),
      ),
    );
    await tester.pump();
    scaffoldKey.currentState!.openDrawer();
    // 「在跑」那条的彩虹圈是永不收尾的动画，`pumpAndSettle` 会一直等下去
    //（app/test/air_console_test.dart 里踩的是同一个坑），所以按时长表态。
    await tester.pump(const Duration(milliseconds: 400));
  }

  Finder inRow(String id, String text) => find.descendant(
    of: find.byKey(ValueKey('air-side-task-$id')),
    matching: find.text(text),
  );

  testWidgets('一条一个说法：在跑的、等我的、闲着的、收工的各说各的状态', (tester) async {
    await pumpSidebar(tester);

    expect(inRow('run', '执行中'), findsOneWidget);
    expect(inRow('wait', '等待回答'), findsOneWidget);
    expect(inRow('idle', '空闲'), findsOneWidget);
    expect(inRow('done', '已完成'), findsOneWidget);

    // 这一带里不该再出现「进行中」这个字眼：它是生命周期 active 的翻法，不是状态。
    expect(
      find.descendant(of: find.byKey(listKey), matching: find.text('进行中')),
      findsNothing,
      reason: '把 status（生命周期）当状态写在这一行，就是这个 bug 的样子',
    );

    expect(tester.takeException(), isNull);
  });

  testWidgets('第二层写在徽标后面，徽标说过的词不再重复', (tester) async {
    await pumpSidebar(tester);

    // 徽标只有一个（不是「执行中」+ 第二层「执行中」两个）。
    expect(inRow('run', '执行中'), findsOneWidget, reason: '租约也是执行中，不该说第二遍');
    expect(inRow('wait', '等待执行名额'), findsOneWidget);
    expect(inRow('idle', '目录已准备'), findsOneWidget);
    expect(inRow('done', '已完成'), findsOneWidget);

    expect(tester.takeException(), isNull);
  });

  testWidgets('标题在上一行、徽标在下一行：标题拿回整行宽度', (tester) async {
    await pumpSidebar(tester);

    final row = tester.getRect(find.byKey(const ValueKey('air-side-task-run')));
    final title = tester.getRect(inRow('run', longTitle));
    // 量徽标那一块（不只是它里面那个词）：`getRect` 拿的是徽标这个部件的框。
    final badge = tester.getRect(
      find.descendant(
        of: find.byKey(const ValueKey('air-side-task-run')),
        matching: find.byType(AirTaskStatusBadge),
      ),
    );

    // 徽标原来占着标题左边那一列（6px 的圆点 + 10px 间距），窄屏上把标题挤成一
    // 个字一个字的竖条；现在它跟第二层信息一起在标题下面那一行。
    expect(
      badge.top,
      greaterThanOrEqualTo(title.bottom),
      reason: '徽标在标题下面那一行，不跟标题抢宽度',
    );
    expect(
      title.width,
      greaterThan(row.width - 32),
      reason: '标题该占满整行（只减去这一格的左右内边距）',
    );
    expect(badge.left, closeTo(title.left, 1), reason: '两行左对齐');

    expect(tester.takeException(), isNull);
  });
}
