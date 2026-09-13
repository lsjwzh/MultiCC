import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/screens/chat_screen.dart';
import 'package:multicc_app/utils/session_status_helpers.dart';

/// 分类条右侧的两个动作药丸，对齐 web 的 `#aux-classify-bar`：
/// W → 「✓ 执行成功」，P → 「✕ 取消」，其余状态一个都不给。
///
/// 显隐规则抽在 [classifyBarActions] 里，这里既钉纯函数（规则本身），也钉
/// widget 的接线（回调传了才渲染、点了真的回调）。
Widget _host(Widget child) => MaterialApp(
  home: Scaffold(
    body: SizedBox(width: 360, child: child),
  ),
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(() => I18n.init('zh'));

  group('classifyBarActions', () {
    test('W 只给执行成功，P 只给取消', () {
      expect(classifyBarActions('W'), (
        canMarkDone: true,
        canCancelTask: false,
      ));
      expect(classifyBarActions('P'), (
        canMarkDone: false,
        canCancelTask: true,
      ));
    });

    test('大小写不敏感', () {
      expect(classifyBarActions('w').canMarkDone, isTrue);
      expect(classifyBarActions('p').canCancelTask, isTrue);
    });

    test('其余状态两个都不给', () {
      for (final state in ['D', 'C', 'B', 'E']) {
        final actions = classifyBarActions(state);
        expect(actions.canMarkDone, isFalse, reason: state);
        expect(actions.canCancelTask, isFalse, reason: state);
      }
    });

    test('缺省按 web 的 || P 兜底：能给的是「能叫停」而不是「已完成」', () {
      for (final state in [null, '', '  ']) {
        final actions = classifyBarActions(state);
        expect(actions.canCancelTask, isTrue, reason: '$state');
        expect(actions.canMarkDone, isFalse, reason: '$state');
      }
    });
  });

  testWidgets('P 状态渲染 ✕ 取消，点击触发回调', (tester) async {
    var cancels = 0;
    await tester.pumpWidget(
      _host(
        AuxClassifyBar(
          goal: '修好登录流程',
          phase: 'running',
          classifyState: 'P',
          onCancelTurn: () => cancels++,
        ),
      ),
    );

    expect(find.text('✕ 取消'), findsOneWidget);
    expect(find.byKey(const Key('classify-cancel-turn')), findsOneWidget);
    expect(find.text('✓ 执行成功'), findsNothing);

    await tester.tap(find.byKey(const Key('classify-cancel-turn')));
    await tester.pump();
    expect(cancels, 1);
  });

  testWidgets('W 状态渲染 ✓ 执行成功，且不出现取消药丸', (tester) async {
    var marks = 0;
    await tester.pumpWidget(
      _host(
        AuxClassifyBar(
          goal: '修好登录流程',
          phase: 'waiting',
          classifyState: 'W',
          onMarkTurnSucceeded: () => marks++,
        ),
      ),
    );

    expect(find.text('✓ 执行成功'), findsOneWidget);
    expect(find.byKey(const Key('classify-cancel-turn')), findsNothing);
    expect(find.text('✕ 取消'), findsNothing);

    await tester.tap(find.text('✓ 执行成功'));
    await tester.pump();
    expect(marks, 1);
  });

  testWidgets('D 状态（完成）两个药丸都不渲染', (tester) async {
    await tester.pumpWidget(
      _host(
        const AuxClassifyBar(
          goal: '修好登录流程',
          phase: 'done',
          classifyState: 'D',
        ),
      ),
    );

    // 目标与状态徽章仍在，只是没有可点的动作。
    expect(find.text('修好登录流程'), findsOneWidget);
    expect(find.byKey(const Key('classify-cancel-turn')), findsNothing);
    expect(find.text('✓ 执行成功'), findsNothing);
  });
}
