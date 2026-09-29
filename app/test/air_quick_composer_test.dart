import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/services/air_service.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/widgets/air/air_panels.dart';
import 'package:multicc_app/widgets/air/air_task_config.dart';

/// 目录首页贴底那条创建输入条（[AirQuickComposer] 的 `docked` 形态）。
///
/// 它默认只是**一行**：一颗回形针、一句灰字占位、一颗发送键。整块面板（CLI /
/// 线路 / 角色三颗药丸 + 多行输入 + Goal）只在「用户要写东西」的时候才铺开 ——
/// 一进目录页就铺着一大块空输入框，等于把清单挤掉三分之一，而九成的时间里用户
/// 是来看任务的。
///
/// 收回去的条件只有一条：**草稿是空的**。写了字或挂了附件还收，就是把用户刚写
/// 的东西从眼前拿走。
Future<SettingsService> _settings() async {
  SharedPreferences.setMockInitialValues({
    'multicc_host': 'http://localhost:3000',
  });
  return SettingsService.getInstance();
}

/// 造一份贴底输入条。`onSubmit` 由每条用例自己给答案（建成了没有）。
Future<void> _pump(
  WidgetTester tester, {
  required Future<bool> Function() onSubmit,
  bool busy = false,
}) async {
  final settings = await _settings();
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: Align(
          alignment: Alignment.bottomCenter,
          child: Padding(
            padding: const EdgeInsets.all(12),
            child: AirQuickComposer(
              settings: settings,
              clis: const ['claude-exp'],
              busy: busy,
              docked: true,
              onSubmit:
                  ({
                    required String text,
                    required String cli,
                    required AirTaskRuntime runtime,
                    required List<AirRoleBinding> roles,
                    required bool goal,
                    int? goalRounds,
                    int? goalBudget,
                  }) => onSubmit(),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

/// 展开态的标志：一颗真的多行输入框 + 那颗写着「创建并执行」的主按钮。
Finder get _realInput => find.byType(TextField);

void main() {
  setUpAll(() => I18n.init('zh'));

  testWidgets('默认就是一条：只剩占位那行字，整块面板不铺开', (tester) async {
    await _pump(tester, onSubmit: () async => true);

    // 收起态读的是占位文案，不是真输入框。
    expect(find.text('描述要完成的任务…'), findsOneWidget);
    expect(_realInput, findsNothing, reason: '真输入框只在展开态才挂');
    expect(find.text('创建并执行 ↑'), findsNothing);
    // 三颗药丸（CLI / 线路 / 角色）也不在这一行里。
    expect(find.byKey(const ValueKey('air-quick-cli')), findsNothing);
    expect(find.byKey(const ValueKey('air-quick-ai')), findsNothing);
    expect(find.byKey(const ValueKey('air-quick-role')), findsNothing);
    // 一颗回形针和一颗发送键仍在（写东西的入口一个没少）。
    expect(find.byKey(const ValueKey('air-quick-attach')), findsOneWidget);
    expect(find.byKey(const ValueKey('air-quick-submit')), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('点一下那行字就铺开整块面板', (tester) async {
    await _pump(tester, onSubmit: () async => true);

    await tester.tap(find.byKey(const ValueKey('air-quick-input')));
    await tester.pumpAndSettle();

    expect(_realInput, findsOneWidget);
    expect(find.text('创建并执行 ↑'), findsOneWidget);
    expect(find.byKey(const ValueKey('air-quick-cli')), findsOneWidget);
    expect(find.byKey(const ValueKey('air-quick-ai')), findsOneWidget);
    expect(find.byKey(const ValueKey('air-quick-role')), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('空草稿收键盘就收回一条，板子不占着地方', (tester) async {
    await _pump(tester, onSubmit: () async => true);
    await tester.tap(find.byKey(const ValueKey('air-quick-input')));
    await tester.pumpAndSettle();
    expect(_realInput, findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('air-quick-hide-keyboard')));
    await tester.pumpAndSettle();

    expect(_realInput, findsNothing);
    expect(find.text('描述要完成的任务…'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('有草稿时收键盘也不收面板：写了的东西不能被收走', (tester) async {
    await _pump(tester, onSubmit: () async => true);
    await tester.tap(find.byKey(const ValueKey('air-quick-input')));
    await tester.pumpAndSettle();

    await tester.enterText(_realInput, '把登录页的错误提示改清楚');
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('air-quick-hide-keyboard')));
    await tester.pumpAndSettle();

    expect(_realInput, findsOneWidget, reason: '草稿还在，面板就得留着');
    expect(
      tester.widget<TextField>(_realInput).controller!.text,
      '把登录页的错误提示改清楚',
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('创建成功之后收成一条，草稿清干净', (tester) async {
    var fired = 0;
    await _pump(
      tester,
      onSubmit: () async {
        fired++;
        return true;
      },
    );
    await tester.tap(find.byKey(const ValueKey('air-quick-input')));
    await tester.pumpAndSettle();
    await tester.enterText(_realInput, '把登录页的错误提示改清楚');
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const ValueKey('air-quick-submit')));
    await tester.pumpAndSettle();

    expect(fired, 1);
    expect(_realInput, findsNothing, reason: '交出去之后这一层就收掉');
    expect(find.text('描述要完成的任务…'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('创建失败时草稿留着，重试就是原样再点一次', (tester) async {
    await _pump(tester, onSubmit: () async => false);
    await tester.tap(find.byKey(const ValueKey('air-quick-input')));
    await tester.pumpAndSettle();
    await tester.enterText(_realInput, '这条会失败');
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const ValueKey('air-quick-submit')));
    await tester.pumpAndSettle();

    expect(_realInput, findsOneWidget);
    expect(tester.widget<TextField>(_realInput).controller!.text, '这条会失败');
    expect(tester.takeException(), isNull);
  });
}
