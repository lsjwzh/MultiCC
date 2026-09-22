import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:multicc_app/services/air_service.dart';
import 'package:multicc_app/widgets/air/air_panels.dart';

/// 造一条任务，只给这份统计真正会读的字段。
AirTask _task({
  required String id,
  String status = 'active',
  String recordType = '',
  String? runState,
}) => AirTask(
  id: id,
  dirId: 'd1',
  title: '任务 $id',
  status: status,
  recordType: recordType,
  updatedAt: 0,
  readOnly: false,
  runState: runState,
);

Future<void> _pump(WidgetTester tester, List<AirTask> tasks, {int worktreeCount = 0}) async {
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(body: AirDirectoryStats(tasks: tasks, worktreeCount: worktreeCount)),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('目录统计四张卡与 Web renderDirectoryOverview 同数同词', (tester) async {
    await _pump(tester, [
      // 进行中：生命周期没走完的两条，其中一条这一轮真的在跑。
      _task(id: 'run', runState: 'running'),
      _task(id: 'open'),
      // 计划任务：还没执行、只是排进计划的那些。
      _task(id: 'plan', recordType: 'planned'),
      // 已完成：workflow 走到 done，但仍留在这个目录。
      _task(id: 'done', status: 'done'),
      _task(id: 'done2', status: 'done'),
      // 全部记录：归档也算记录，只是不算「进行中」。
      _task(id: 'archived', status: 'archived'),
      _task(id: 'archived2', status: 'archived'),
      _task(id: 'archived3', status: 'archived'),
    ], worktreeCount: 2);

    // Web 那四张卡：进行中 / 计划任务 / 已完成 / 全部记录。
    for (final label in const ['进行中', '计划任务', '已完成', '全部记录']) {
      expect(find.text(label), findsOneWidget);
    }
    expect(find.text('3'), findsOneWidget); // 进行中 = 8 条里减掉 2 完成 3 归档
    expect(find.text('1 个正在执行'), findsOneWidget);
    expect(find.text('1'), findsOneWidget); // 计划任务
    expect(find.text('待开始或继续规划'), findsOneWidget);
    expect(find.text('2'), findsOneWidget); // 已完成
    expect(find.text('仍保留在本目录'), findsOneWidget);
    expect(find.text('8'), findsOneWidget); // 全部记录
    expect(find.text('3 个已归档 · 2 个 WT'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('归档与完成都不算「进行中」，也不会被算成计划任务', (tester) async {
    await _pump(tester, [
      _task(id: 'done', status: 'done', recordType: 'planned'),
      _task(id: 'archived', status: 'archived', recordType: 'planned'),
    ]);

    expect(find.text('0'), findsNWidgets(2)); // 进行中 / 计划任务
    expect(find.text('1'), findsOneWidget); // 已完成
    expect(find.text('2'), findsOneWidget); // 全部记录
    expect(find.text('0 个正在执行'), findsOneWidget);
    expect(find.text('1 个已归档 · 0 个 WT'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('窄到 320px 也不溢出：四张卡是抬头，不是正文', (tester) async {
    tester.view.physicalSize = const Size(320, 720);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    await _pump(tester, [
      _task(id: 'run', runState: 'running'),
      _task(id: 'plan', recordType: 'planned'),
      _task(id: 'archived', status: 'archived'),
    ]);

    expect(find.text('全部记录'), findsOneWidget);
    expect(find.text('1 个已归档 · 0 个 WT'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('手机屏按 Web 的 1040px 断点折成两行，副标题不再被挤掉', (tester) async {
    tester.view.physicalSize = const Size(430, 932);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    await _pump(tester, [_task(id: 'run', runState: 'running')]);

    final first = tester.getTopLeft(find.text('进行中')).dy;
    expect(tester.getTopLeft(find.text('计划任务')).dy, first);
    expect(tester.getTopLeft(find.text('已完成')).dy, greaterThan(first));
    expect(tester.getTopLeft(find.text('全部记录')).dy, greaterThan(first));
    expect(tester.takeException(), isNull);
  });

  testWidgets('宽屏回到 Web 的四列', (tester) async {
    tester.view.physicalSize = const Size(1280, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    await _pump(tester, [_task(id: 'run', runState: 'running')]);

    final first = tester.getTopLeft(find.text('进行中')).dy;
    for (final label in const ['计划任务', '已完成', '全部记录']) {
      expect(tester.getTopLeft(find.text(label)).dy, first);
    }
    expect(tester.takeException(), isNull);
  });
}
