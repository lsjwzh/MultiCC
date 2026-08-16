// DispatchFloatingDock：派发队列的可拖动悬浮入口。
//
// 锁定的行为：
//   * 空队列 → 图标/面板完全不渲染（不占布局）；
//   * 图标带 active 数量 badge，tap 展开 / 再 tap 或点空白收起；
//   * 拖动超过手势 slop 不触发展开；松手吸附最近左右边缘；
//   * 位置以 side+归一化高度持久化，只在拖动结束时写一次；
//   * 恢复时按当前约束 clamp（含右侧悬浮带预留），尺寸变化后仍在界内；
//   * 队列清空 → 立即收起并隐藏；
//   * Semantics 携带 active 数量与展开/收起状态。
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/models/dispatch_queue.dart';
import 'package:multicc_app/widgets/dispatch_floating_dock.dart';

String resolve(String id) => switch (id) { _ => id };

const _activeEntries = [
  DispatchQueueEntry(
    operationId: 'op-1',
    relation: 'owner',
    targetSessionId: 's-worker',
    mode: 'sync',
    queueState: 'queued',
    queuePosition: 1,
    queueLength: 2,
  ),
  DispatchQueueEntry(
    operationId: 'op-2',
    relation: 'target',
    ownerSessionId: 'commander-x',
    mode: 'async',
    queueState: 'running',
  ),
];

Widget _host(Widget child) =>
    MaterialApp(home: Scaffold(body: child));

/// The floating icon. A top-level finder is safe: finders are evaluated
/// lazily against the current tree on every use.
final Finder _icon = find.byKey(const Key('dispatch-dock-icon'));

void main() {
  // Default test surface: 800×600 logical px.
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(() => I18n.init('zh'));
  setUp(() {
    SharedPreferences.setMockInitialValues(const {});
  });

  testWidgets('empty queue renders nothing (空态不占位)', (tester) async {
    await tester.pumpWidget(
      _host(DispatchFloatingDock(entries: const [], resolveName: resolve)),
    );
    await tester.pump(); // prefs resolve
    expect(_icon, findsNothing);
    expect(find.byKey(const Key('dispatch-dock-panel')), findsNothing);
  });

  testWidgets('shows active badge; tap expands, tap again / blank collapses', (
    tester,
  ) async {
    final expandedLog = <bool>[];
    await tester.pumpWidget(
      _host(
        DispatchFloatingDock(
          entries: _activeEntries,
          resolveName: resolve,
          onExpandedChanged: expandedLog.add,
        ),
      ),
    );
    // First frame is blank while prefs load (no flash at the default spot).
    expect(_icon, findsNothing);
    await tester.pump();
    expect(_icon, findsOneWidget);
    expect(find.byKey(const Key('dispatch-dock-badge')), findsOneWidget);
    expect(find.text('2'), findsOneWidget);

    await tester.tap(_icon);
    await tester.pump();
    expect(find.byKey(const Key('dispatch-dock-panel')), findsOneWidget);
    expect(expandedLog, [true]);

    // Blank-area tap (the transparent barrier) collapses.
    await tester.tapAt(const Offset(400, 10));
    await tester.pump();
    expect(find.byKey(const Key('dispatch-dock-panel')), findsNothing);
    expect(expandedLog, [true, false]);

    // Re-open, then tapping the icon itself also collapses.
    await tester.tap(_icon);
    await tester.pump();
    await tester.tap(_icon);
    await tester.pump();
    expect(find.byKey(const Key('dispatch-dock-panel')), findsNothing);
    expect(expandedLog, [true, false, true, false]);
  });

  testWidgets('drag never triggers expand; icon snaps to nearest edge', (
    tester,
  ) async {
    await tester.pumpWidget(
      _host(
        DispatchFloatingDock(entries: _activeEntries, resolveName: resolve),
      ),
    );
    await tester.pump();
    // Default resting spot: left edge, bottom band (left:10, bottom ≥96).
    expect(tester.getTopLeft(_icon), const Offset(10, 456));

    // Drag well past the drag slop but stay left of centre → snap LEFT.
    // tester.drag first moves kDragSlopDefault (20px) along the drag to break
    // the touch slop, and DragStartBehavior.start absorbs that leading delta
    // (monodrag _checkDrag folds it into the start position), so the delivered
    // drag is a few px short of the request — assert the side (exact: the
    // horizontal snap is deterministic) and the vertical band, not raw pixels.
    await tester.drag(_icon, const Offset(60, -120));
    await tester.pump();
    expect(find.byKey(const Key('dispatch-dock-panel')), findsNothing);
    expect(tester.getTopLeft(_icon).dx, 10); // left of centre → snapped LEFT
    final dyAfterLeft = tester.getTopLeft(_icon).dy;
    expect(dyAfterLeft, lessThan(456)); // rose with the finger…
    expect(dyAfterLeft, greaterThan(280)); // …by roughly the drag distance

    // Drag across centre → snap RIGHT (left == 800 - 10 - 48).
    await tester.drag(_icon, const Offset(500, -100));
    await tester.pump();
    expect(find.byKey(const Key('dispatch-dock-panel')), findsNothing);
    expect(tester.getTopLeft(_icon).dx, 742);
  });

  testWidgets('drag end persists side + dy exactly once per settle', (
    tester,
  ) async {
    await tester.pumpWidget(
      _host(
        DispatchFloatingDock(entries: _activeEntries, resolveName: resolve),
      ),
    );
    await tester.pump();
    await tester.drag(_icon, const Offset(500, -100));
    await tester.pump();

    final prefs = await SharedPreferences.getInstance();
    expect(prefs.getString('multicc_dispatch_dock_side'), 'right');
    final dy = prefs.getDouble('multicc_dispatch_dock_dy');
    // The stored fraction must reproduce the on-screen snapped top exactly
    // (band on 600px: top = 10 + dy * (600 - 96 - 48 - 10)) — i.e. it is the
    // normalised snapped position, never raw drag px. The landing top itself
    // is read from the widget: the delivered drag is a few px short of the
    // request (touch-slop absorption, see the snap test above).
    final landedTop = tester.getTopLeft(_icon).dy;
    expect(landedTop, moreOrLessEquals(10 + dy! * 446, epsilon: 0.5));
  });

  testWidgets('restored out-of-range dy is clamped into the visible band', (
    tester,
  ) async {
    SharedPreferences.setMockInitialValues({
      'multicc_dispatch_dock_dy': 5.0, // nonsense from an older layout
      'multicc_dispatch_dock_side': 'right',
    });
    await tester.pumpWidget(
      _host(
        DispatchFloatingDock(
          entries: _activeEntries,
          resolveName: resolve,
          rightMinBottom: 160, // right-side floaters visible
        ),
      ),
    );
    await tester.pump();
    final topLeft = tester.getTopLeft(_icon);
    expect(topLeft.dx, 742); // right edge
    // Band bottom = 600 - 160 - 48 = 392; dy clamped to 1.0 → top = 392.
    expect(topLeft.dy, 392);
  });

  testWidgets('shrinking the window re-clamps the restored position', (
    tester,
  ) async {
    await tester.pumpWidget(
      _host(
        DispatchFloatingDock(entries: _activeEntries, resolveName: resolve),
      ),
    );
    await tester.pump();
    expect(tester.getTopLeft(_icon), const Offset(10, 456)); // 600-tall band

    tester.view.physicalSize = const Size(800, 300);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pump();

    // Same stored fraction, re-fitted to the shorter band: still fully
    // visible and clear of the input-bar reserve.
    final topLeft = tester.getTopLeft(_icon);
    expect(topLeft.dx, 10);
    expect(topLeft.dy, lessThanOrEqualTo(300 - 96 - 48));
    expect(topLeft.dy, greaterThanOrEqualTo(10));
  });

  testWidgets('queue drained while expanded → collapse and hide immediately', (
    tester,
  ) async {
    final expandedLog = <bool>[];
    var entries = _activeEntries;
    await tester.pumpWidget(
      _host(
        DispatchFloatingDock(
          key: const ValueKey('dock'),
          entries: entries,
          resolveName: resolve,
          onExpandedChanged: expandedLog.add,
        ),
      ),
    );
    await tester.pump();
    await tester.tap(_icon);
    await tester.pump();
    expect(find.byKey(const Key('dispatch-dock-panel')), findsOneWidget);

    entries = const [];
    await tester.pumpWidget(
      _host(
        DispatchFloatingDock(
          key: const ValueKey('dock'),
          entries: entries,
          resolveName: resolve,
          onExpandedChanged: expandedLog.add,
        ),
      ),
    );
    await tester.pump();
    expect(find.byKey(const Key('dispatch-dock-panel')), findsNothing);
    expect(_icon, findsNothing);
    expect(expandedLog.last, false); // parent state told to collapse
  });

  testWidgets('Semantics carry the active count and expand state', (
    tester,
  ) async {
    final handle = tester.ensureSemantics();
    await tester.pumpWidget(
      _host(
        DispatchFloatingDock(entries: _activeEntries, resolveName: resolve),
      ),
    );
    await tester.pump();
    expect(
      find.bySemanticsLabel(RegExp('2 个进行中.*点按展开')),
      findsOneWidget,
    );

    await tester.tap(_icon);
    await tester.pump();
    expect(
      find.bySemanticsLabel(RegExp('2 个进行中.*已展开')),
      findsOneWidget,
    );
    handle.dispose();
  });

  testWidgets('panel anchors beside the icon and does not overflow', (
    tester,
  ) async {
    await tester.pumpWidget(
      _host(
        DispatchFloatingDock(entries: _activeEntries, resolveName: resolve),
      ),
    );
    await tester.pump();
    await tester.tap(_icon);
    await tester.pump();
    expect(find.byKey(const Key('dispatch-dock-panel')), findsOneWidget);
    // Icon rests at the left edge → panel opens to its right, inside bounds.
    final panelRect = tester.getRect(
      find.byKey(const Key('dispatch-dock-panel')),
    );
    expect(panelRect.left, greaterThan(58)); // icon right edge + gap
    expect(panelRect.right, lessThanOrEqualTo(800 - 8));
  });
}
