import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:multicc_app/services/air_service.dart';
import 'package:multicc_app/widgets/air/air_panels.dart';

/// Web `air.html` 的 `#directory-worktrees`（内容在 `air-worktrees.js`）在 App 里
/// 的对位件：目录下 worktree 的生命周期拆解 + 「现在回收」。
///
/// 这一组钉的是三句必须说准的话：
/// * 三个数分开摆（本地 / 休眠 / 计划）—— 只报总数看不出这个数是怎么长的；
/// * 本地一个都没有时按钮就变灰，而不是点下去再说「没有可回收的」；
/// * 自动回收关掉时照实说「已关闭」，不假装它一直在后台收东西。
Future<void> _pump(WidgetTester tester, Widget child) async {
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(body: SingleChildScrollView(child: child)),
    ),
  );
  await tester.pumpAndSettle();
}

const _life = AirWorktreeLifecycle(
  resident: 2,
  retained: 1,
  hibernated: 8,
  planned: 1,
  leased: 3,
  onDisk: 3,
  total: 12,
);

void main() {
  testWidgets('生命周期三个数分开摆，占用单独报', (tester) async {
    await _pump(
      tester,
      const AirWorktreePanel(lifecycle: _life, idleMs: 24 * 3600 * 1000),
    );

    expect(find.text('Worktree 生命周期'), findsOneWidget);
    expect(
      find.text('12 个 Worktree · 本地 3 · 休眠 8 · 计划 1 · 占用中 3'),
      findsOneWidget,
    );
    expect(find.text('闲置超过 24 小时会自动回收'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('「现在回收」点了就回调；忙的时候换成「回收中…」并禁用', (tester) async {
    var fired = 0;
    await _pump(
      tester,
      AirWorktreePanel(
        lifecycle: _life,
        idleMs: 3600000,
        onReclaim: () => fired++,
      ),
    );

    expect(find.text('闲置超过 1 小时会自动回收'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('air-worktree-reclaim')));
    expect(fired, 1);

    await _pump(
      tester,
      AirWorktreePanel(lifecycle: _life, busy: true, onReclaim: () => fired++),
    );
    expect(find.text('回收中…'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('air-worktree-reclaim')));
    expect(fired, 1, reason: '回收中不能再点出一批');
  });

  testWidgets('本地一个都没有时按钮变灰：不是点了再说「没有可回收的」', (tester) async {
    await _pump(
      tester,
      AirWorktreePanel(
        lifecycle: const AirWorktreeLifecycle(hibernated: 4, total: 4),
        onReclaim: () {},
      ),
    );

    final button = tester.widget<OutlinedButton>(
      find.byKey(const ValueKey('air-worktree-reclaim')),
    );
    expect(button.onPressed, isNull);
    expect(find.text('4 个 Worktree · 本地 0 · 休眠 4 · 计划 0'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('自动回收关掉时照实说已关闭，不编一个默认阈值出来', (tester) async {
    await _pump(tester, const AirWorktreePanel(lifecycle: _life));

    expect(find.text('自动回收已关闭'), findsOneWidget);
    expect(find.textContaining('闲置超过'), findsNothing);
  });

  testWidgets('只读（远端工作区）时没有回收按钮', (tester) async {
    await _pump(
      tester,
      const AirWorktreePanel(lifecycle: _life, idleMs: 3600000),
    );

    expect(find.byKey(const ValueKey('air-worktree-reclaim')), findsNothing);
  });
}
