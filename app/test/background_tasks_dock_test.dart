// BackgroundTasksFloatingDock：后台任务的可拖动悬浮入口。
//
// 与 DispatchFloatingDock 共用同一 FloatingDock primitive（拖动/吸附/持久
// 化/锚定），这里锁定 bg 侧特有的行为：
//   * 空任务列表 → 完全不渲染；进行中（start）数量才是 badge 口径；
//   * tap 展开 BackgroundTaskPanel（展开态），再 tap / 点空白 / 面板 ⌄ 收起；
//   * 持久化 key 与 dispatch 完全独立（互不污染）；
//   * obstacle 避让：dispatch 球（高优先级）同侧锚点重叠时，bg 球确定性
//     推到其上方（上方放不下走下方），恢复/拖动落点同样校正；
//   * 任务清空 → 立即收起并隐藏（父层收到 onExpandedChanged(false)）。
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/models/background_task_board.dart';
import 'package:multicc_app/widgets/background_tasks_dock.dart';
import 'package:multicc_app/widgets/dispatch_floating_dock.dart';
import 'package:multicc_app/widgets/floating_dock.dart';
import 'package:multicc_app/models/dispatch_queue.dart';

List<BackgroundTaskRow> _rows(List<BackgroundTaskState> states) => [
  for (var i = 0; i < states.length; i++)
    BackgroundTaskRow(
      key: 't:task-$i',
      taskId: 'task-$i',
      description: '后台任务 $i',
      state: states[i],
      updatedAt: 1000 + i,
    ),
];

Widget _host(Widget child) =>
    MaterialApp(home: Scaffold(body: child));

final Finder _bgIcon = find.byKey(const Key('bg-dock-icon'));
final Finder _dispatchIcon = find.byKey(const Key('dispatch-dock-icon'));

void main() {
  // Default test surface: 800×600 logical px.
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(() => I18n.init('zh'));
  setUp(() {
    SharedPreferences.setMockInitialValues(const {});
  });

  testWidgets('no rows renders nothing; running count is the badge', (
    tester,
  ) async {
    await tester.pumpWidget(
      _host(BackgroundTasksFloatingDock(rows: const [], onDismiss: (_) {})),
    );
    await tester.pump(); // prefs resolve
    expect(_bgIcon, findsNothing);

    // 2 running + 1 finished → badge 2, not 3.
    await tester.pumpWidget(
      _host(
        BackgroundTasksFloatingDock(
          rows: _rows([
            BackgroundTaskState.start,
            BackgroundTaskState.start,
            BackgroundTaskState.done,
          ]),
          onDismiss: (_) {},
        ),
      ),
    );
    await tester.pump();
    expect(_bgIcon, findsOneWidget);
    expect(find.byKey(const Key('bg-dock-badge')), findsOneWidget);
    expect(find.text('2'), findsOneWidget);
    // All finished → no badge (spinning is the badge口径).
    await tester.pumpWidget(
      _host(
        BackgroundTasksFloatingDock(
          rows: _rows([BackgroundTaskState.done, BackgroundTaskState.stale]),
          onDismiss: (_) {},
        ),
      ),
    );
    await tester.pump();
    expect(find.byKey(const Key('bg-dock-badge')), findsNothing);
  });

  testWidgets('bg circle stays the full 48dp (dispatch-only shrink)', (
    tester,
  ) async {
    await tester.pumpWidget(
      _host(
        BackgroundTasksFloatingDock(
          rows: _rows([BackgroundTaskState.start]),
          onDismiss: (_) {},
        ),
      ),
    );
    await tester.pump();
    // The visualSize halving is dispatch-only: bg keeps a 48dp circle that
    // fills its whole 48dp hit box.
    expect(tester.getSize(_bgIcon), const Size(48, 48));
    final circle = find
        .descendant(of: _bgIcon, matching: find.byType(Material))
        .first;
    expect(tester.getSize(circle), const Size(48, 48));
  });

  testWidgets('tap expands the task panel; blank tap / ⌄ collapses', (
    tester,
  ) async {
    final expandedLog = <bool>[];
    await tester.pumpWidget(
      _host(
        BackgroundTasksFloatingDock(
          rows: _rows([BackgroundTaskState.start]),
          onDismiss: (_) {},
          onExpandedChanged: expandedLog.add,
        ),
      ),
    );
    await tester.pump();
    await tester.tap(_bgIcon);
    await tester.pump();
    expect(find.byKey(const Key('bg-dock-panel')), findsOneWidget);
    expect(find.byKey(const Key('bg-task-panel')), findsOneWidget);
    expect(expandedLog, [true]);

    // Blank-area tap (the transparent barrier) collapses.
    await tester.tapAt(const Offset(400, 10));
    await tester.pump();
    expect(find.byKey(const Key('bg-dock-panel')), findsNothing);
    expect(expandedLog, [true, false]);

    // Re-open, then the panel's own ▾ affordance folds the dock with it.
    await tester.tap(_bgIcon);
    await tester.pump();
    await tester.tap(find.byIcon(Icons.keyboard_arrow_down_rounded));
    await tester.pump();
    expect(find.byKey(const Key('bg-dock-panel')), findsNothing);
    expect(expandedLog, [true, false, true, false]);
  });

  testWidgets('drag never expands; persists to its own keys', (tester) async {
    await tester.pumpWidget(
      _host(
        BackgroundTasksFloatingDock(
          rows: _rows([BackgroundTaskState.start]),
          onDismiss: (_) {},
        ),
      ),
    );
    await tester.pump();
    expect(tester.getTopLeft(_bgIcon), const Offset(10, 456));

    // Drag right across centre: no panel, snaps to the right edge.
    // (tester.drag's slop absorption — see dispatch dock tests — means the
    // delivered drag is a few px short; only the horizontal snap is exact.)
    await tester.drag(_bgIcon, const Offset(500, -100));
    await tester.pump();
    expect(find.byKey(const Key('bg-dock-panel')), findsNothing);
    expect(tester.getTopLeft(_bgIcon).dx, 742);

    final prefs = await SharedPreferences.getInstance();
    expect(prefs.getString('multicc_bg_dock_side'), 'right');
    // The dispatch dock's keys must be untouched — state is per-dock.
    expect(prefs.getString('multicc_dispatch_dock_side'), isNull);
    expect(prefs.getDouble('multicc_dispatch_dock_dy'), isNull);
  });

  testWidgets('yields to the dispatch dock anchor on the same side', (
    tester,
  ) async {
    // Dispatch (higher priority) rests on the LEFT at icon-top 200.
    // The bg dock's restored default is the band bottom (left, top 456) —
    // far from 200, so it stays put.
    await tester.pumpWidget(
      _host(
        BackgroundTasksFloatingDock(
          rows: _rows([BackgroundTaskState.start]),
          onDismiss: (_) {},
          obstacle: const FloatingDockAnchor(sideRight: false, top: 200),
        ),
      ),
    );
    await tester.pump();
    expect(tester.getTopLeft(_bgIcon), const Offset(10, 456));

    // Now restore the bg dock INTO the obstacle's slot (dy chosen so the
    // snapped top lands at 200 — exactly the dispatch icon top). The dock
    // must deterministically yield to the slot above (200 - 48 - 8 = 144).
    SharedPreferences.setMockInitialValues({
      'multicc_bg_dock_side': 'left',
      // span = 600 - 96 - 48 - 10 = 446; (200 - 10) / 446 ≈ 0.4260.
      'multicc_bg_dock_dy': (200 - 10) / 446,
    });
    // The chat screen keys the dock per session, so a "restore" always means
    // a fresh State reading prefs in initState — simulate that with a new key.
    await tester.pumpWidget(
      _host(
        BackgroundTasksFloatingDock(
          key: const ValueKey('dock-restored'),
          rows: _rows([BackgroundTaskState.start]),
          onDismiss: (_) {},
          obstacle: const FloatingDockAnchor(sideRight: false, top: 200),
        ),
      ),
    );
    await tester.pump();
    final topLeft = tester.getTopLeft(_bgIcon);
    expect(topLeft.dx, 10);
    expect(topLeft.dy, 144); // above the obstacle, gap 8
    // No overlap with the obstacle slot [200, 248].
    expect(topLeft.dy + 48, lessThan(200));
  });

  testWidgets('drag settle also yields when landing on the obstacle', (
    tester,
  ) async {
    // Obstacle at left, icon-top 400. Drag the bg icon up the left edge so
    // its landing centre lands inside the obstacle slot → settle must push
    // it above (400 - 56 = 344), then persist the yielded position.
    await tester.pumpWidget(
      _host(
        BackgroundTasksFloatingDock(
          rows: _rows([BackgroundTaskState.start]),
          onDismiss: (_) {},
          obstacle: const FloatingDockAnchor(sideRight: false, top: 400),
        ),
      ),
    );
    await tester.pump();
    expect(tester.getTopLeft(_bgIcon), const Offset(10, 456));
    await tester.drag(_bgIcon, const Offset(20, -70));
    await tester.pump();
    final topLeft = tester.getTopLeft(_bgIcon);
    expect(topLeft.dx, 10);
    // Raw landing would be ~386 (inside [352, 448]) → yielded above 344.
    expect(topLeft.dy, 344);
  });

  testWidgets('both docks together: independent positions, no overlap', (
    tester,
  ) async {
    // The chat screen's wiring in miniature: dispatch reports its anchor,
    // the host rebuilds (post-frame, like chat_screen does) and the bg dock
    // yields to it.
    FloatingDockAnchor? dispatchAnchor;
    const dispatchEntries = [
      DispatchQueueEntry(
        operationId: 'op-1',
        relation: 'owner',
        targetSessionId: 's-worker',
        mode: 'sync',
        queueState: 'running',
      ),
    ];
    Widget tree() => _host(Stack(
          children: [
            BackgroundTasksFloatingDock(
              rows: _rows([BackgroundTaskState.start]),
              onDismiss: (_) {},
              obstacle: dispatchAnchor,
            ),
            DispatchFloatingDock(
              entries: dispatchEntries,
              resolveName: (id) => id,
              onAnchorChanged: (sideRight, top) => dispatchAnchor =
                  FloatingDockAnchor(sideRight: sideRight, top: top),
            ),
          ],
        ));
    await tester.pumpWidget(tree());
    await tester.pump(); // prefs resolve; dispatch reports its anchor here
    // Defaults: dispatch left-bottom (456). The bg dock's restored default
    // (456) lands exactly on that slot → host rebuild hands the obstacle
    // over and bg deterministically takes the slot above (456 - 56 = 400).
    await tester.pumpWidget(tree());
    await tester.pump();
    expect(tester.getTopLeft(_dispatchIcon), const Offset(10, 456));
    expect(tester.getTopLeft(_bgIcon), const Offset(10, 400));

    // Drag bg across to the RIGHT edge: sides differ → no yield, free spot.
    await tester.drag(_bgIcon, const Offset(500, -20));
    await tester.pump();
    expect(tester.getTopLeft(_bgIcon).dx, 742);
    expect(tester.getTopLeft(_dispatchIcon).dx, 10);
  });

  testWidgets('tasks drained while expanded → collapse and hide immediately', (
    tester,
  ) async {
    final expandedLog = <bool>[];
    var rows = _rows([BackgroundTaskState.start, BackgroundTaskState.done]);
    await tester.pumpWidget(
      _host(
        BackgroundTasksFloatingDock(
          key: const ValueKey('dock'),
          rows: rows,
          onDismiss: (_) {},
          onExpandedChanged: expandedLog.add,
        ),
      ),
    );
    await tester.pump();
    await tester.tap(_bgIcon);
    await tester.pump();
    expect(find.byKey(const Key('bg-dock-panel')), findsOneWidget);

    rows = const [];
    await tester.pumpWidget(
      _host(
        BackgroundTasksFloatingDock(
          key: const ValueKey('dock'),
          rows: rows,
          onDismiss: (_) {},
          onExpandedChanged: expandedLog.add,
        ),
      ),
    );
    await tester.pump();
    expect(_bgIcon, findsNothing);
    expect(find.byKey(const Key('bg-dock-panel')), findsNothing);
    expect(expandedLog.last, false);
  });

  testWidgets('Semantics carry the running count and expand state', (
    tester,
  ) async {
    final handle = tester.ensureSemantics();
    await tester.pumpWidget(
      _host(
        BackgroundTasksFloatingDock(
          rows: _rows([BackgroundTaskState.start, BackgroundTaskState.start]),
          onDismiss: (_) {},
        ),
      ),
    );
    await tester.pump();
    expect(
      find.bySemanticsLabel(RegExp('2 个进行中.*点按展开')),
      findsOneWidget,
    );
    await tester.tap(_bgIcon);
    await tester.pump();
    expect(
      find.bySemanticsLabel(RegExp('2 个进行中.*已展开')),
      findsOneWidget,
    );
    handle.dispose();
  });
}
