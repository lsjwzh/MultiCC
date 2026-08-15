import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:multicc_app/utils/dispatch_hint.dart';
import 'package:multicc_app/widgets/dispatch_mode_selector.dart';

/// i18n 未 init 时 `t(key)` 回落成 key 本身，所以这里直接用 key 当可见文本断言，
/// 既验证了「渲染的是那一档」，又不必在测试里装一整套语料。
Widget _host({
  required DispatchMode mode,
  required ValueChanged<DispatchMode> onChanged,
}) {
  return MaterialApp(
    home: Scaffold(
      body: Center(child: DispatchModePill(mode: mode, onChanged: onChanged)),
    ),
  );
}

void main() {
  test('每一档都有自己的图标与三条文案 key', () {
    final all = DispatchMode.values.map(dispatchModeUi).toList();
    expect(all.map((u) => u.icon).toSet().length, 4);
    expect(all.map((u) => u.shortKey).toSet().length, 4);
    expect(all.map((u) => u.labelKey).toSet().length, 4);
    expect(all.map((u) => u.descKey).toSet().length, 4);
    // 「不派发」是唯一一档不往外发的，配色也得和三档派发区分开。
    final none = dispatchModeUi(DispatchMode.none).accent;
    expect(none, isNot(dispatchModeUi(DispatchMode.dispatchMasterSync).accent));
    expect(none, isNot(dispatchModeUi(DispatchMode.dispatchMasterAsync).accent));
    expect(none, isNot(dispatchModeUi(DispatchMode.routeTask).accent));
  });

  testWidgets('胶囊只显示当前档位，不平铺四个选项', (tester) async {
    await tester.pumpWidget(
      _host(mode: DispatchMode.routeTask, onChanged: (_) {}),
    );
    expect(find.text('dispatchModeRouteShort'), findsOneWidget);
    // 另外三档在收起状态下不该占位置。
    expect(find.text('dispatchModeMasterSyncShort'), findsNothing);
    expect(find.text('dispatchModeMasterAsyncShort'), findsNothing);
    expect(find.text('dispatchModeNoneShort'), findsNothing);
  });

  testWidgets('点胶囊弹出 BottomSheet，四档齐全且当前档打勾', (tester) async {
    await tester.pumpWidget(
      _host(mode: DispatchMode.none, onChanged: (_) {}),
    );
    await tester.tap(find.byType(DispatchModePill));
    await tester.pumpAndSettle();

    for (final mode in DispatchMode.values) {
      expect(
        find.byKey(Key('dispatch-mode-sheet-${mode.wireName}')),
        findsOneWidget,
      );
    }
    expect(find.text('dispatchModeMasterSyncLabel'), findsOneWidget);
    expect(find.text('dispatchModeMasterAsyncLabel'), findsOneWidget);
    expect(find.text('dispatchModeRouteDesc'), findsOneWidget);
    // 勾只给当前那一档。
    expect(find.byIcon(Icons.check), findsOneWidget);
  });

  testWidgets('选中一档后回调新值并关掉 sheet', (tester) async {
    final picked = <DispatchMode>[];
    await tester.pumpWidget(
      _host(mode: DispatchMode.dispatchMasterAsync, onChanged: picked.add),
    );
    await tester.tap(find.byType(DispatchModePill));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('dispatch-mode-sheet-none')));
    await tester.pumpAndSettle();

    expect(picked, [DispatchMode.none]);
    expect(find.byKey(const Key('dispatch-mode-sheet-none')), findsNothing);
  });

  testWidgets('重选当前档位不触发回调', (tester) async {
    final picked = <DispatchMode>[];
    await tester.pumpWidget(
      _host(mode: DispatchMode.routeTask, onChanged: picked.add),
    );
    await tester.tap(find.byType(DispatchModePill));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('dispatch-mode-sheet-route_task')));
    await tester.pumpAndSettle();

    expect(picked, isEmpty);
  });

  testWidgets('空手关掉 sheet 不改档位', (tester) async {
    final picked = <DispatchMode>[];
    await tester.pumpWidget(
      _host(mode: DispatchMode.dispatchMasterAsync, onChanged: picked.add),
    );
    await tester.tap(find.byType(DispatchModePill));
    await tester.pumpAndSettle();
    // 点 sheet 之外的遮罩关闭。
    await tester.tapAt(const Offset(10, 10));
    await tester.pumpAndSettle();

    expect(picked, isEmpty);
    expect(find.byKey(const Key('dispatch-mode-sheet-none')), findsNothing);
  });

  testWidgets('sheet 每行的可点高度不低于 44px', (tester) async {
    await tester.pumpWidget(
      _host(mode: DispatchMode.dispatchMasterAsync, onChanged: (_) {}),
    );
    await tester.tap(find.byType(DispatchModePill));
    await tester.pumpAndSettle();

    for (final mode in DispatchMode.values) {
      final size = tester.getSize(
        find.byKey(Key('dispatch-mode-sheet-${mode.wireName}')),
      );
      expect(size.height, greaterThanOrEqualTo(44.0));
    }
  });
}
