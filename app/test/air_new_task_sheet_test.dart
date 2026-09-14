import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:multicc_app/services/air_service.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/widgets/air/air_new_task_sheet.dart';
import 'package:multicc_app/widgets/air/air_panels.dart';
import 'package:multicc_app/widgets/air/air_task_config.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// 侧栏那颗「＋ 新任务」开的那一层（Web `air.html` 的 `#quick-task-dialog`）。
///
/// 这里盯的是「它装的到底是什么」：不是又一张自建表单，而是**目录首页那一个**
/// 统一输入框模块 —— 同一套胶囊（AI 配置 / 角色）、同一颗「创建并执行 ↑」。
/// 另外两件容易悄悄坏掉的事：这一层自己管「正在创建」（宿主的 setState 传不进来），
/// 以及收不收它取决于「人有没有被带进新任务」。
Future<SettingsService> _settings() async {
  SharedPreferences.setMockInitialValues({
    'multicc_host': 'http://localhost:3000',
  });
  return SettingsService.getInstance();
}

/// 线路面板要拉 Provider 池，角色面板要拉角色库 —— 这里一个都不打开，给个空壳
/// 就够（面板那边本来就用 try/catch 兜着）。
MockClient _client() => MockClient(
  (request) async => http.Response(
    jsonEncode({'ok': true, 'providers': <Object>[], 'presets': <Object>[]}),
    200,
    headers: {'content-type': 'application/json; charset=utf-8'},
  ),
);

Widget _host({
  required SettingsService settings,
  required AirComposerSubmit onSubmit,
  List<String> clis = const ['claude', 'codex'],
}) => MaterialApp(
  home: Builder(
    builder: (context) => Scaffold(
      body: Center(
        child: ElevatedButton(
          key: const ValueKey('open'),
          onPressed: () => showAirNewTaskSheet(
            context,
            directoryPath: '/project/a',
            settings: settings,
            httpClient: _client(),
            clis: clis,
            onSubmit: onSubmit,
          ),
          child: const Text('打开'),
        ),
      ),
    ),
  ),
);

/// 什么都不做、直接说「成了」的提交口，返回上次交出去的正文与线路。
AirComposerSubmit _recorder(
  List<String> texts, {
  bool landed = true,
  Future<void>? gate,
}) => ({
  required String text,
  required String cli,
  required AirTaskRuntime runtime,
  required List<AirRoleBinding> roles,
  required bool goal,
  int? goalRounds,
  int? goalBudget,
}) async {
  texts.add(text);
  if (gate != null) await gate;
  return landed;
};

Future<void> _open(WidgetTester tester) async {
  await tester.pumpAndSettle();
  await tester.tap(find.byKey(const ValueKey('open')));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('开的是统一输入框模块，不是另一张表单', (tester) async {
    final settings = await _settings();
    await tester.pumpWidget(
      _host(settings: settings, onSubmit: _recorder(<String>[])),
    );
    await _open(tester);

    expect(find.text('新任务'), findsOneWidget);
    expect(find.text('NEW TASK'), findsOneWidget);
    // 建在哪个目录：Web 的 `#quick-task-dialog-directory`。它只是一句话。
    expect(find.byKey(const ValueKey('air-new-task-directory')), findsOneWidget);
    expect(find.text('/project/a'), findsOneWidget);

    // 关键：装的就是目录首页那一个模块，三颗胶囊一个不少。
    expect(find.byType(AirQuickComposer), findsOneWidget);
    expect(find.byKey(const ValueKey('air-quick-input')), findsOneWidget);
    expect(find.byKey(const ValueKey('air-quick-cli')), findsOneWidget);
    expect(find.byKey(const ValueKey('air-quick-ai')), findsOneWidget);
    expect(find.byKey(const ValueKey('air-quick-role')), findsOneWidget);
    expect(find.byKey(const ValueKey('air-quick-goal')), findsOneWidget);
    // 提交还是那一颗「创建并执行」——不是「创建任务」。这一段话会被执行。
    expect(find.text('创建并执行 ↑'), findsOneWidget);
    // 旧表单那几样都不该再出现。
    expect(find.text('任务名称'), findsNothing);
    expect(find.text('模型（可选）'), findsNothing);
    expect(find.text('角色上下文（可选）'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('点开就能直接写字：弹层里那一份抢焦点', (tester) async {
    final settings = await _settings();
    await tester.pumpWidget(
      _host(settings: settings, onSubmit: _recorder(<String>[])),
    );
    await _open(tester);
    expect(
      tester
          .widget<TextField>(find.byKey(const ValueKey('air-quick-input')))
          .autofocus,
      isTrue,
    );
  });

  /// 同一份模块在目录首页是常驻的：页面一进来就弹键盘会顶掉滚动位置，而它本来
  /// 就在最上面 —— 够不着才需要打字。焦点这一点是两处唯一的差别，单独盯住。
  testWidgets('目录首页那一份不抢焦点', (tester) async {
    final settings = await _settings();
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: AirQuickComposer(
            settings: settings,
            clis: const ['claude'],
            busy: false,
            onSubmit: _recorder(<String>[]),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(
      tester
          .widget<TextField>(find.byKey(const ValueKey('air-quick-input')))
          .autofocus,
      isFalse,
    );
  });

  testWidgets('交出去的是那段话和当前线路，成了这一层自己收掉', (tester) async {
    final settings = await _settings();
    final texts = <String>[];
    await tester.pumpWidget(
      _host(settings: settings, onSubmit: _recorder(texts)),
    );
    await _open(tester);

    await tester.enterText(
      find.byKey(const ValueKey('air-quick-input')),
      '把登录页的错误提示改清楚',
    );
    await tester.tap(find.byKey(const ValueKey('air-quick-submit')));
    await tester.pumpAndSettle();

    expect(texts, ['把登录页的错误提示改清楚']);
    // 人已经被带进新任务了：这一层收起来，别压在聊天页上面。
    expect(find.byKey(const ValueKey('air-quick-input')), findsNothing);
  });

  testWidgets('创建过程中整层自己进「正在创建…」—— 宿主管不到这一层', (tester) async {
    final settings = await _settings();
    // 提交卡在半路，好让「正在创建」这一帧留得住。
    final gate = Completer<void>();
    await tester.pumpWidget(
      _host(
        settings: settings,
        onSubmit: _recorder(<String>[], gate: gate.future),
      ),
    );
    await _open(tester);
    await tester.enterText(
      find.byKey(const ValueKey('air-quick-input')),
      '跑一遍全量测试',
    );
    await tester.tap(find.byKey(const ValueKey('air-quick-submit')));
    // 不能用 pumpAndSettle：那个 future 还挂着，而这里要看的就是挂着的这一帧。
    await tester.pump();

    expect(find.text('正在创建…'), findsOneWidget);
    expect(
      tester
          .widget<TextField>(find.byKey(const ValueKey('air-quick-input')))
          .enabled,
      isFalse,
      reason: '创建中不该还能改正文',
    );

    gate.complete();
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('air-quick-input')), findsNothing);
  });

  testWidgets('没建起来就留着这一层，草稿还在——重试是原样再点一次', (tester) async {
    final settings = await _settings();
    await tester.pumpWidget(
      _host(settings: settings, onSubmit: _recorder(<String>[], landed: false)),
    );
    await _open(tester);
    await tester.enterText(
      find.byKey(const ValueKey('air-quick-input')),
      '这段还没交出去',
    );
    await tester.tap(find.byKey(const ValueKey('air-quick-submit')));
    await tester.pumpAndSettle();

    expect(find.byKey(const ValueKey('air-quick-input')), findsOneWidget);
    expect(
      tester
          .widget<TextField>(find.byKey(const ValueKey('air-quick-input')))
          .controller
          ?.text,
      '这段还没交出去',
    );
    // 按钮回到能再点的样子，不是一直卡在「正在创建…」。
    expect(find.text('创建并执行 ↑'), findsOneWidget);
    expect(find.byKey(const ValueKey('air-quick-submit')), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('关掉就收回去，什么都不提交', (tester) async {
    final settings = await _settings();
    final texts = <String>[];
    await tester.pumpWidget(
      _host(settings: settings, onSubmit: _recorder(texts)),
    );
    await _open(tester);
    await tester.enterText(
      find.byKey(const ValueKey('air-quick-input')),
      '写了一半又不想建了',
    );
    await tester.tap(find.byKey(const ValueKey('air-new-task-close')));
    await tester.pumpAndSettle();

    expect(find.byKey(const ValueKey('air-quick-input')), findsNothing);
    expect(texts, isEmpty);
  });
}
