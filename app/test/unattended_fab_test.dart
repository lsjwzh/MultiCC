import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/models/unattended_state.dart';
import 'package:multicc_app/widgets/unattended_sheet.dart';

UnattendedState _state(String status, {int rounds = 0, int maxRounds = 30}) =>
    UnattendedState(
      status: status,
      goal: '把登录页错误提示改清楚',
      rounds: rounds,
      maxRounds: maxRounds,
    );

Widget _host(Widget child) => MaterialApp(home: Scaffold(body: child));

void main() {
  setUpAll(() => I18n.init('zh'));

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

  testWidgets('未启用：灰色机器人图标，没有轮次徽标', (tester) async {
    await tester.pumpWidget(_host(UnattendedFab(state: null, onTap: () {})));

    expect(
      tester.widget<Icon>(find.byIcon(Icons.smart_toy_outlined)).icon,
      Icons.smart_toy_outlined,
    );
    expect(find.text('0/0'), findsNothing);
  });

  testWidgets('active：绿色循环图标 + 轮次徽标，点击能打开面板入口', (tester) async {
    var taps = 0;
    await tester.pumpWidget(
      _host(
        UnattendedFab(
          state: _state('active', rounds: 2, maxRounds: 30),
          onTap: () => taps++,
        ),
      ),
    );
    await tester.pump();

    expect(find.byIcon(Icons.autorenew_rounded), findsOneWidget);
    expect(find.text('2/30'), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('unattended-fab')));
    expect(taps, 1);

    // 呼吸动画是 repeat 的，收掉才能让 ticker 干净退出。
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('active 判定中：图标让位给 spinner，轮次徽标还在', (tester) async {
    await tester.pumpWidget(
      _host(
        UnattendedFab(
          state: UnattendedState(
            status: 'active',
            rounds: 1,
            maxRounds: 30,
            evaluating: true,
          ),
          onTap: () {},
        ),
      ),
    );
    await tester.pump();

    expect(find.byType(CircularProgressIndicator), findsOneWidget);
    expect(find.byIcon(Icons.autorenew_rounded), findsNothing);
    expect(find.text('1/30'), findsOneWidget);

    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('active 但不在判定中：照旧显示循环图标，没有 spinner', (tester) async {
    await tester.pumpWidget(
      _host(
        UnattendedFab(
          state: _state('active', rounds: 1, maxRounds: 30),
          onTap: () {},
        ),
      ),
    );
    await tester.pump();

    expect(find.byType(CircularProgressIndicator), findsNothing);
    expect(find.byIcon(Icons.autorenew_rounded), findsOneWidget);

    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('needs_human / achieved / exhausted 各自的图标', (tester) async {
    for (final (status, icon) in const [
      ('needs_human', Icons.front_hand_rounded),
      ('achieved', Icons.check_circle_rounded),
      ('exhausted', Icons.hourglass_bottom_rounded),
      ('error', Icons.error_outline_rounded),
    ]) {
      await tester.pumpWidget(
        _host(UnattendedFab(state: _state(status), onTap: () {})),
      );
      await tester.pump();
      expect(find.byIcon(icon), findsOneWidget, reason: status);
    }
    await tester.pumpWidget(const SizedBox.shrink());
  });
}
