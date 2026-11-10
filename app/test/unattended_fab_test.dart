import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/models/unattended_state.dart';
import 'package:multicc_app/widgets/unattended_sheet.dart';

UnattendedState _state(
  String status, {
  int rounds = 0,
  int maxDurationMinutes = 120,
  int deadlineAt = 0,
}) => UnattendedState(
  status: status,
  goal: '把登录页错误提示改清楚',
  rounds: rounds,
  maxDurationMinutes: maxDurationMinutes,
  deadlineAt: deadlineAt,
);

Widget _host(Widget child) => MaterialApp(home: Scaffold(body: child));

void main() {
  setUpAll(() => I18n.init('zh'));

  test('剩余时间文案：1小时20分 / 45分 / <1分 / 已超时', () {
    expect(
      unattendedRemainingText(
        const Duration(hours: 1, minutes: 20, seconds: 30),
      ),
      '1小时20分',
    );
    expect(unattendedRemainingText(const Duration(hours: 2)), '2小时');
    expect(unattendedRemainingText(const Duration(minutes: 45)), '45分');
    expect(unattendedRemainingText(const Duration(seconds: 30)), '<1分');
    expect(unattendedRemainingText(Duration.zero), '已超时');
    expect(unattendedRemainingText(const Duration(seconds: -5)), '已超时');
  });

  test('unattendedRemainingLabel 只在 active 且有时限时给值', () {
    expect(unattendedRemainingLabel(null, 0), isNull);
    expect(
      unattendedRemainingLabel(_state('active', deadlineAt: 0), 0),
      isNull,
    );
    expect(
      unattendedRemainingLabel(_state('stopped', deadlineAt: 60000), 0),
      isNull,
    );
    expect(
      unattendedRemainingLabel(_state('active', deadlineAt: 60000), 0),
      '1分',
    );
  });

  test('面板按钮组按状态切换：active -> 停止/保存，终态 -> 继续，其余 -> 启动', () {
    expect(
      unattendedSheetActionMode(null),
      UnattendedSheetActionMode.start,
    );
    expect(
      unattendedSheetActionMode(_state('active')),
      UnattendedSheetActionMode.active,
    );
    for (final status in const [
      'needs_human',
      'exhausted',
      'stopped',
      'error',
    ]) {
      expect(
        unattendedSheetActionMode(_state(status)),
        UnattendedSheetActionMode.resume,
        reason: status,
      );
    }
    // 已达成是终态但不能 resume，只能重新 start。
    expect(
      unattendedSheetActionMode(_state('achieved')),
      UnattendedSheetActionMode.start,
    );
  });

  testWidgets('未启用：灰色机器人图标，没有剩余徽标', (tester) async {
    await tester.pumpWidget(_host(UnattendedFab(state: null, onTap: () {})));

    expect(
      tester.widget<Icon>(find.byIcon(Icons.smart_toy_outlined)).icon,
      Icons.smart_toy_outlined,
    );
    expect(find.text('0/0'), findsNothing);
    expect(
      find.byKey(const ValueKey('unattended-fab-remaining')),
      findsNothing,
    );
  });

  testWidgets('active：绿色循环图标 + 剩余徽标，点击能打开面板入口', (tester) async {
    var taps = 0;
    var now = 1000000;
    await tester.pumpWidget(
      _host(
        UnattendedFab(
          state: _state('active', rounds: 2, deadlineAt: now + 30 * 60000),
          now: () => now,
          onTap: () => taps++,
        ),
      ),
    );
    await tester.pump();

    expect(find.byIcon(Icons.autorenew_rounded), findsOneWidget);
    expect(find.text('30分'), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('unattended-fab')));
    expect(taps, 1);

    // 呼吸动画是 repeat 的，收掉才能让 ticker 干净退出。
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('active：30 秒定时器只刷新剩余，不重画成固定文案', (tester) async {
    var now = 1000000;
    Widget build() => _host(
      UnattendedFab(
        state: _state('active', deadlineAt: 1000000 + 40 * 60000),
        now: () => now,
        onTap: () {},
      ),
    );

    await tester.pumpWidget(build());
    await tester.pump();
    expect(find.text('40分'), findsOneWidget);

    // 时间推进 10 分钟，pump 到 30 秒定时器那一下。
    now += 10 * 60000;
    await tester.pump(const Duration(seconds: 30));
    expect(find.text('30分'), findsOneWidget);

    // 失活后定时器必须取消：再推进也不会抛「setState after dispose」。
    await tester.pumpWidget(
      _host(
        UnattendedFab(
          state: _state('stopped', deadlineAt: 1000000 + 40 * 60000),
          now: () => now,
          onTap: () {},
        ),
      ),
    );
    await tester.pump(const Duration(minutes: 5));
    expect(
      find.byKey(const ValueKey('unattended-fab-remaining')),
      findsNothing,
    );

    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('active 判定中：图标让位给 spinner，剩余徽标还在', (tester) async {
    var now = 1000000;
    await tester.pumpWidget(
      _host(
        UnattendedFab(
          state: UnattendedState(
            status: 'active',
            rounds: 1,
            deadlineAt: now + 60000,
            evaluating: true,
          ),
          now: () => now,
          onTap: () {},
        ),
      ),
    );
    await tester.pump();

    expect(find.byType(CircularProgressIndicator), findsOneWidget);
    expect(find.byIcon(Icons.autorenew_rounded), findsNothing);
    expect(find.text('1分'), findsOneWidget);

    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('active 但不在判定中：照旧显示循环图标，没有 spinner', (tester) async {
    var now = 1000000;
    await tester.pumpWidget(
      _host(
        UnattendedFab(
          state: _state('active', rounds: 1, deadlineAt: now + 60000),
          now: () => now,
          onTap: () {},
        ),
      ),
    );
    await tester.pump();

    expect(find.byType(CircularProgressIndicator), findsNothing);
    expect(find.byIcon(Icons.autorenew_rounded), findsOneWidget);

    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('终态各自图标；非 active 不画剩余徽标', (tester) async {
    for (final (status, icon) in const [
      ('needs_human', Icons.front_hand_rounded),
      ('achieved', Icons.check_circle_rounded),
      ('exhausted', Icons.hourglass_bottom_rounded),
      ('error', Icons.error_outline_rounded),
    ]) {
      await tester.pumpWidget(
        _host(
          UnattendedFab(
            state: _state(status, deadlineAt: 2000000),
            now: () => 1000000,
            onTap: () {},
          ),
        ),
      );
      await tester.pump();
      expect(find.byIcon(icon), findsOneWidget, reason: status);
      expect(
        find.byKey(const ValueKey('unattended-fab-remaining')),
        findsNothing,
        reason: status,
      );
    }
    await tester.pumpWidget(const SizedBox.shrink());
  });
}
