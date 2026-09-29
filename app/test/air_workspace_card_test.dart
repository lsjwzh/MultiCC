import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:multicc_app/models/message.dart';
import 'package:multicc_app/services/air_service.dart';
import 'package:multicc_app/widgets/air/air_workspace_card.dart';

/// 目录首页那张合并之后的「工作区」卡：**一张卡、一个抬头**，里面两格 ——
/// 主检出的代码状态（Git）和目录下 worktree 的生命周期。
///
/// 这一组钉的是三句必须说准的话：
/// * 两格在同一张卡里、只有一个抬头（合并之前它们是两张各带抬头的卡）；
/// * 三个数分开摆（本地 / 休眠 / 计划）—— 只报总数看不出这个数是怎么长的；
/// * 本地一个都没有时按钮就变灰，而不是点下去再说「没有可回收的」；
/// * 自动回收关掉时照实说「已关闭」，不假装它一直在后台收东西；
/// * 没有 git 状态时（远端工作区 / 非 git 仓库）那一格不摆，不留一行空标题。
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

const _git = DirectoryPushState(
  available: true,
  hasRemote: true,
  ahead: 2,
  dirty: 3,
  remoteBranch: 'main',
);

void main() {
  testWidgets('一个抬头、两格内容：代码状态与 worktree 生命周期在同一张卡里', (tester) async {
    await _pump(
      tester,
      const AirWorkspaceCard(
        lifecycle: _life,
        pushState: _git,
        idleMs: 24 * 3600 * 1000,
      ),
    );

    expect(
      find.byKey(const ValueKey('air-directory-workspace')),
      findsOneWidget,
    );
    // 抬头只有一处（Web 合并后的那张卡也是「一个 section-heading」）。
    expect(find.byKey(const ValueKey('air-workspace-heading')), findsOneWidget);
    expect(find.text('工作区'), findsOneWidget);
    // 两格的小标题都在这一张卡里。
    expect(find.text('代码状态'), findsOneWidget);
    expect(find.text('Worktree 生命周期'), findsOneWidget);
    // git 那一格就是现成的那一行（分支 + 未推送 + 未提交）。
    expect(find.text('🌿 main  📤2  📝3'), findsOneWidget);
    expect(
      find.descendant(
        of: find.byKey(const ValueKey('air-directory-workspace')),
        matching: find.byKey(const ValueKey('air-worktree-summary')),
      ),
      findsOneWidget,
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('没有 git 状态时那一格整格不摆，不留一行空标题', (tester) async {
    await _pump(
      tester,
      const AirWorkspaceCard(lifecycle: _life, idleMs: 3600000),
    );

    expect(
      find.byKey(const ValueKey('air-directory-workspace')),
      findsOneWidget,
    );
    expect(find.text('代码状态'), findsNothing);
    // worktree 那一格照旧。
    expect(find.text('Worktree 生命周期'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('git 读不到（available:false）时同样不摆那一格', (tester) async {
    await _pump(
      tester,
      const AirWorkspaceCard(
        lifecycle: _life,
        pushState: DirectoryPushState(available: false),
      ),
    );

    expect(find.text('代码状态'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('生命周期三个数分开摆，占用单独报', (tester) async {
    await _pump(
      tester,
      const AirWorkspaceCard(lifecycle: _life, idleMs: 24 * 3600 * 1000),
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
      AirWorkspaceCard(
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
      AirWorkspaceCard(lifecycle: _life, busy: true, onReclaim: () => fired++),
    );
    expect(find.text('回收中…'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('air-worktree-reclaim')));
    expect(fired, 1, reason: '回收中不能再点出一批');
  });

  testWidgets('本地一个都没有时按钮变灰：不是点了再说「没有可回收的」', (tester) async {
    await _pump(
      tester,
      AirWorkspaceCard(
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
    await _pump(tester, const AirWorkspaceCard(lifecycle: _life));

    expect(find.text('自动回收已关闭'), findsOneWidget);
    expect(find.textContaining('闲置超过'), findsNothing);
  });

  testWidgets('只读（远端工作区）时没有回收按钮', (tester) async {
    await _pump(
      tester,
      const AirWorkspaceCard(lifecycle: _life, idleMs: 3600000),
    );

    expect(find.byKey(const ValueKey('air-worktree-reclaim')), findsNothing);
  });
}
