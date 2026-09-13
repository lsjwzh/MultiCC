import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/services/air_service.dart';
import 'package:multicc_app/widgets/air/air_palette.dart';

const List<AirDirectory> _directories = [
  AirDirectory(id: 'd1', name: 'storefront', path: '/projects/storefront'),
  AirDirectory(id: 'd2', name: '后台服务', path: '/projects/api'),
];

AirTask _task({
  required String id,
  String dirId = 'd1',
  String title = '登录页面',
  String status = 'active',
  String? runState = 'idle',
}) => AirTask(
  id: id,
  dirId: dirId,
  title: title,
  status: status,
  recordType: '',
  updatedAt: 0,
  readOnly: false,
  runState: runState,
);

void main() {
  // 详情里那个状态词来自词典（注册表只给 key）。
  setUpAll(() => I18n.init('zh'));

  group('候选：目录和任务同一次搜索', () {
    test('目录在前、任务在后，任务带上它在哪个目录、现在算什么', () {
      final items = airPaletteCandidates(_directories, const [], [
        _task(id: 't1'),
      ]);
      expect(items.map((i) => i.kind).toList(), [
        AirPaletteKind.directory,
        AirPaletteKind.directory,
        AirPaletteKind.task,
      ]);
      expect(items[0].title, 'storefront');
      expect(items[0].detail, '/projects/storefront');
      expect(items[2].title, '登录页面');
      expect(items[2].detail, 'storefront · 空闲');
      expect(items[2].taskId, 't1');
      expect(items[2].kindLabel, '任务');
      expect(items[0].kindLabel, '目录');
    });

    test('目录按名字或路径都能搜到，任务只按标题搜', () {
      // 路径里的 api 能搜到「后台服务」。
      final byPath = airPaletteCandidates(_directories, const [], const [], query: 'api');
      expect(byPath.map((i) => i.title).toList(), ['后台服务']);
      // 任务标题里没有「storefront」，不因为它在 storefront 里就被搜出来。
      final byName = airPaletteCandidates(
        _directories,
        const [],
        [_task(id: 't1')],
        query: 'storefront',
      );
      expect(byName.map((i) => i.kind).toList(), [AirPaletteKind.directory]);
    });

    test('空着手来就少给几个，搜起来才多给', () {
      final many = [
        for (var i = 1; i <= 9; i++)
          AirDirectory(id: 'd$i', name: '目录 $i', path: '/p/$i'),
      ];
      final tasks = [
        for (var i = 1; i <= 12; i++)
          _task(id: 't$i', dirId: 'd1', title: '任务 $i'),
      ];
      // 没搜索词：目录 5、任务 6。
      final idle = airPaletteCandidates(many, const [], tasks);
      expect(idle.where((i) => i.kind == AirPaletteKind.directory).length, 5);
      expect(idle.where((i) => i.kind == AirPaletteKind.task).length, 6);
      // 有搜索词：目录 6、任务 8 —— 人已经在找了，就多给几条。
      final searching = airPaletteCandidates(many, const [], tasks, query: '任务');
      expect(
        searching.where((i) => i.kind == AirPaletteKind.directory).length,
        0,
      );
      expect(searching.where((i) => i.kind == AirPaletteKind.task).length, 8);
    });

    test('最近用过的排前面，同一条任务不会出现两次', () {
      final items = airPaletteCandidates(
        _directories,
        [_task(id: 't9', title: '刚开过的')],
        [_task(id: 't9', title: '刚开过的'), _task(id: 't1')],
      );
      final tasks = items
          .where((i) => i.kind == AirPaletteKind.task)
          .map((i) => i.taskId)
          .toList();
      expect(tasks, ['t9', 't1']);
    });

    test('标题空着就叫未命名任务，目录查不到就说未知目录', () {
      final items = airPaletteCandidates(_directories, const [], [
        _task(id: 't1', title: '', dirId: 'd404'),
      ]);
      final task = items.singleWhere((i) => i.kind == AirPaletteKind.task);
      expect(task.title, '未命名任务');
      expect(task.detail, '未知目录 · 空闲');
    });

    test('底栏那两个数：目录几个、任务几个，一条都没有就说这一页是干什么的', () {
      final items = airPaletteCandidates(_directories, const [], [
        _task(id: 't1'),
      ]);
      expect(airPaletteNote(items), '2 个目录 · 1 个任务');
      expect(airPaletteNote(const []), '目录与任务一起搜');
    });
  });

  // 真身是从宿主页推上来的一层：选完它自己 pop 掉，底下那页还在。
  Future<void> pump(
    WidgetTester tester, {
    List<AirTask> recentTasks = const [],
    List<AirTask> allTasks = const [],
    ValueChanged<String>? onSelectDirectory,
    void Function(String dirId, String taskId)? onOpenTask,
  }) async {
    final navigator = GlobalKey<NavigatorState>();
    await tester.pumpWidget(
      MaterialApp(
        navigatorKey: navigator,
        home: const Scaffold(body: Center(child: Text('宿主页'))),
      ),
    );
    unawaited(
      navigator.currentState!.push(
        MaterialPageRoute<void>(
          builder: (_) => AirPaletteScreen(
            directories: _directories,
            recentTasks: recentTasks,
            allTasks: allTasks,
            onSelectDirectory: onSelectDirectory ?? (_) {},
            onOpenTask: onOpenTask ?? (_, _) {},
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  testWidgets('一进来就把最近的和目录摆出来，输入就往下收窄', (tester) async {
    await pump(
      tester,
      recentTasks: [_task(id: 't9', title: '刚开过的')],
      allTasks: [_task(id: 't1')],
    );

    expect(find.byKey(const ValueKey('air-palette-directory-d1')), findsOneWidget);
    expect(find.byKey(const ValueKey('air-palette-task-t1')), findsOneWidget);
    expect(find.text('2 个目录 · 2 个任务'), findsOneWidget);

    await tester.enterText(
      find.byKey(const ValueKey('air-palette-input')),
      '登录',
    );
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('air-palette-task-t1')), findsOneWidget);
    expect(find.byKey(const ValueKey('air-palette-task-t9')), findsNothing);
    expect(find.byKey(const ValueKey('air-palette-directory-d1')), findsNothing);
    expect(find.text('0 个目录 · 1 个任务'), findsOneWidget);

    // 什么都没有的时候也要说话。
    await tester.enterText(
      find.byKey(const ValueKey('air-palette-input')),
      '不存在的东西',
    );
    await tester.pumpAndSettle();
    expect(find.text('没有匹配的工作目录或任务。'), findsOneWidget);
    expect(find.text('目录与任务一起搜'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('点目录切过去，点任务进那条任务 —— 两条路各自带走自己的目录', (tester) async {
    final dirs = <String>[];
    final tasks = <String>[];
    final allTasks = [
      _task(id: 't1'),
      _task(id: 't2', dirId: 'd2', title: '接口文档'),
    ];
    Future<void> open() => pump(
      tester,
      allTasks: allTasks,
      onSelectDirectory: dirs.add,
      onOpenTask: (dirId, taskId) => tasks.add('$dirId/$taskId'),
    );

    await open();
    await tester.tap(find.byKey(const ValueKey('air-palette-directory-d2')));
    await tester.pumpAndSettle();
    expect(dirs, ['d2']);
    expect(tasks, isEmpty);
    // 选完就收页：往下推对话页是宿主的事，搜索页自己赖在栈上会挡住刚推上来的那层。
    expect(find.byKey(const ValueKey('air-palette')), findsNothing);

    await open();
    await tester.tap(find.byKey(const ValueKey('air-palette-task-t2')));
    await tester.pumpAndSettle();
    expect(tasks, ['d2/t2']);
    expect(find.byKey(const ValueKey('air-palette')), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('高亮那条是回车进得去的，跟点它一下一样', (tester) async {
    final tasks = <String>[];
    final dirs = <String>[];
    await pump(
      tester,
      allTasks: [_task(id: 't1')],
      onSelectDirectory: dirs.add,
      onOpenTask: (dirId, taskId) => tasks.add('$dirId/$taskId'),
    );

    // 第一条是目录 d1：回车进的就是它。
    await tester.enterText(
      find.byKey(const ValueKey('air-palette-input')),
      'store',
    );
    await tester.pumpAndSettle();
    await tester.testTextInput.receiveAction(TextInputAction.go);
    await tester.pumpAndSettle();
    expect(dirs, ['d1']);
    expect(tasks, isEmpty);
    expect(tester.takeException(), isNull);
  });

  testWidgets('320px 上排得下：一行里的标题、副行和类型标签都不溢出', (tester) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(320, 720);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await pump(
      tester,
      allTasks: [
        _task(id: 't1', title: '一个特别特别长的任务标题用来把这一行撑到边上'),
      ],
    );

    expect(tester.takeException(), isNull);
    expect(find.byKey(const ValueKey('air-palette')), findsOneWidget);
    // 两条目录、一条任务，行尾那枚类型标签各挂各的。
    expect(find.text('目录'), findsNWidgets(2));
    expect(find.text('任务'), findsOneWidget);
  });
}
