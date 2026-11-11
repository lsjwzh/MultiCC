import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/providers/chat_provider.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/widgets/unattended_sheet.dart';

// 启动前自动预检（产品决定 2026-11）：点「启动」先跑 /api/goal/precheck。
//   (a) 判定 ok、无提醒、标准齐备  -> 直接启动，不打扰
//   (b) 目标不清 / 标准缺失或空洞 -> 建议卡（可编辑），确认后才启动
//   (c) 预检失败/超时             -> 「预检暂不可用」+ 仍然启动/取消
// 继续/更新不跑预检；预检期间第二次点启动必须被忽略。

class _SheetProvider extends ChatProvider {
  _SheetProvider({required super.settings})
    : super(sessionName: 'unattended-sheet-test', sessionCwd: '/tmp');

  final starts = <Map<String, dynamic>>[];
  final updates = <Map<String, dynamic>>[];
  int resumes = 0;
  int clears = 0;

  @override
  Future<bool> startUnattended({
    required String goal,
    List<String> criteria = const [],
    int? maxDurationMinutes,
    bool evaluateNow = true,
  }) async {
    starts.add({
      'goal': goal,
      'criteria': criteria,
      'maxDurationMinutes': maxDurationMinutes,
    });
    applyUnattendedEvent({
      'status': 'active',
      'goal': goal,
      'criteria': criteria,
      'maxDurationMinutes': maxDurationMinutes ?? 120,
      'rounds': 0,
      'deadlineAt':
          DateTime.now().millisecondsSinceEpoch +
          (maxDurationMinutes ?? 120) * 60000,
    });
    return true;
  }

  @override
  Future<bool> updateUnattended({
    String? goal,
    List<String>? criteria,
    int? maxDurationMinutes,
  }) async {
    updates.add({
      'goal': goal,
      'criteria': criteria,
      'maxDurationMinutes': maxDurationMinutes,
    });
    applyUnattendedEvent({
      'status': 'active',
      'goal': goal ?? '',
      'criteria': criteria ?? const <String>[],
      'maxDurationMinutes': maxDurationMinutes ?? 120,
    });
    return true;
  }

  @override
  Future<bool> resumeUnattended({int? maxDurationMinutes}) async {
    resumes++;
    applyUnattendedEvent({
      'status': 'active',
      'maxDurationMinutes': maxDurationMinutes ?? 60,
    });
    return true;
  }

  @override
  Future<bool> stopUnattended() async {
    applyUnattendedEvent(const {'status': 'stopped'});
    return true;
  }

  @override
  Future<bool> clearUnattended() async {
    clears++;
    applyUnattendedEvent(null);
    return true;
  }
}

Future<SettingsService> _settings() async {
  SharedPreferences.setMockInitialValues({
    'multicc_host': 'http://127.0.0.1:9',
    'multicc_token': '',
  });
  return SettingsService.getInstance();
}

Map<String, dynamic> _precheckOk({
  List<String> criteria = const ['测试通过'],
}) => {
  'ok': true,
  'verdict': 'ok',
  'score': 90,
  'issues': <String>[],
  'questions': <String>[],
  'criteria': criteria,
  'revised': '',
};

Map<String, dynamic> _precheckNeedsWork() => {
  'ok': true,
  'verdict': 'needs_work',
  'score': 30,
  'issues': ['目标没有说清楚要做到什么'],
  'questions': <String>[],
  'criteria': ['登录页错误提示能说清原因', '相关测试通过'],
  'revised': '修复登录页错误提示并补测试',
};

/// 模拟 /api/settings/goal 与 /api/goal/precheck；[requests] 记录预检入参。
MockClient _client({
  required Map<String, dynamic> precheck,
  int status = 200,
  List<Map<String, dynamic>>? requests,
  Completer<void>? gate,
}) => MockClient((request) async {
  if (request.url.path == '/api/settings/goal') {
    return http.Response(
      jsonEncode({'precheckWaitMs': 5000, 'dimensions': <String, bool>{}}),
      200,
      headers: {'content-type': 'application/json; charset=utf-8'},
    );
  }
  if (request.url.path == '/api/goal/precheck') {
    requests?.add(jsonDecode(request.body) as Map<String, dynamic>);
    if (gate != null) await gate.future;
    return http.Response(
      jsonEncode(precheck),
      status,
      headers: {'content-type': 'application/json; charset=utf-8'},
    );
  }
  return http.Response(
    jsonEncode({'ok': true}),
    200,
    headers: {'content-type': 'application/json; charset=utf-8'},
  );
});

Future<void> _openSheet(
  WidgetTester tester,
  ChatProvider provider, {
  http.Client? client,
  int Function()? now,
}) async {
  await tester.pumpWidget(
    MaterialApp(
      home: Builder(
        builder: (context) => Scaffold(
          body: Center(
            child: ElevatedButton(
              key: const ValueKey('open-sheet'),
              onPressed: () => showUnattendedSheet(
                context,
                provider: provider,
                httpClient: client,
                now: now,
              ),
              child: const Text('open'),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.byKey(const ValueKey('open-sheet')));
  await tester.pumpAndSettle();
}

Future<void> _closeSheet(WidgetTester tester) async {
  // 先拆掉整棵树：active 状态的 30s 定时器必须随 dispose 取消，
  // 否则 flutter_test 会报「Timer is still pending」。
  await tester.pumpWidget(const SizedBox.shrink());
  await tester.pump();
}

Future<void> _type(WidgetTester tester, String key, String text) async {
  final finder = find.byKey(ValueKey(key));
  await tester.ensureVisible(finder);
  await tester.enterText(finder, text);
  await tester.pump();
}

Future<void> _tap(WidgetTester tester, String key) async {
  final finder = find.byKey(ValueKey(key));
  await tester.ensureVisible(finder);
  await tester.tap(finder);
  await tester.pumpAndSettle();
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(() => I18n.init('zh'));

  testWidgets('(a) 预检通过且标准齐备：点启动直接发 start，不弹建议卡', (tester) async {
    final settings = await _settings();
    final provider = _SheetProvider(settings: settings);
    final requests = <Map<String, dynamic>>[];

    await _openSheet(
      tester,
      provider,
      client: _client(precheck: _precheckOk(), requests: requests),
    );
    await _type(tester, 'unattended-goal', '修复登录页的错误提示');
    await _type(tester, 'unattended-criterion-0', '错误提示能说清原因');

    await _tap(tester, 'unattended-start');

    expect(requests, hasLength(1));
    expect(requests.single['task'], contains('修复登录页的错误提示'));
    expect(requests.single['task'], contains('错误提示能说清原因'));
    expect(provider.starts, hasLength(1));
    expect(provider.starts.single['goal'], '修复登录页的错误提示');
    expect(provider.starts.single['criteria'], ['错误提示能说清原因']);
    expect(provider.starts.single['maxDurationMinutes'], 120);
    expect(
      find.byKey(const ValueKey('unattended-precheck-card')),
      findsNothing,
    );

    await _closeSheet(tester);
    provider.dispose();
  });

  testWidgets('(a) 时长按 limits 收口：999 小时 -> 1440 分钟', (tester) async {
    final settings = await _settings();
    final provider = _SheetProvider(settings: settings);

    await _openSheet(tester, provider, client: _client(precheck: _precheckOk()));
    await _type(tester, 'unattended-goal', '做完这件事');
    await _type(tester, 'unattended-criterion-0', '有一个可验证的结果');
    await _type(tester, 'unattended-max-duration', '999');
    await _tap(tester, 'unattended-start');

    expect(provider.starts.single['maxDurationMinutes'], 1440);

    await _closeSheet(tester);
    provider.dispose();
  });

  testWidgets('(b) 目标不清：不启动，展示可编辑建议；采用后按编辑内容启动', (tester) async {
    final settings = await _settings();
    final provider = _SheetProvider(settings: settings);

    await _openSheet(
      tester,
      provider,
      client: _client(precheck: _precheckNeedsWork()),
    );
    await _type(tester, 'unattended-goal', '把登录页弄好');

    await _tap(tester, 'unattended-start');

    // 没启动，先给建议卡。
    expect(provider.starts, isEmpty);
    expect(
      find.byKey(const ValueKey('unattended-precheck-card')),
      findsOneWidget,
    );
    expect(
      tester
          .widget<Text>(find.byKey(const ValueKey('unattended-precheck-headline')))
          .data,
      t('unattendedPrecheckUnclearGoal'),
    );
    expect(find.textContaining('目标没有说清楚要做到什么'), findsOneWidget);
    expect(
      tester
          .widget<TextField>(find.byKey(const ValueKey('unattended-precheck-goal')))
          .controller!
          .text,
      '修复登录页错误提示并补测试',
    );

    // 用户改建议，然后「采用建议并启动」。
    await _type(tester, 'unattended-precheck-goal', '我改过的目标');
    await _tap(tester, 'unattended-precheck-use-start');

    expect(provider.starts, hasLength(1));
    expect(provider.starts.single['goal'], '我改过的目标');
    expect(provider.starts.single['criteria'], [
      '登录页错误提示能说清原因',
      '相关测试通过',
    ]);
    expect(
      find.byKey(const ValueKey('unattended-precheck-card')),
      findsNothing,
    );

    await _closeSheet(tester);
    provider.dispose();
  });

  testWidgets('(b) 标准缺失但判定 ok：标题是「缺少可验证的判断标准」', (tester) async {
    final settings = await _settings();
    final provider = _SheetProvider(settings: settings);

    await _openSheet(tester, provider, client: _client(precheck: _precheckOk()));
    await _type(tester, 'unattended-goal', '把登录页错误提示改清楚');
    // 不填任何判断标准。
    await _tap(tester, 'unattended-start');

    expect(provider.starts, isEmpty);
    expect(
      tester
          .widget<Text>(find.byKey(const ValueKey('unattended-precheck-headline')))
          .data,
      t('unattendedPrecheckMissingCriteria'),
    );

    // 「按我的原样启动」用主表单当前内容（目标 + 空标准）。
    await _tap(tester, 'unattended-precheck-start-as-is');
    expect(provider.starts, hasLength(1));
    expect(provider.starts.single['goal'], '把登录页错误提示改清楚');
    expect(provider.starts.single['criteria'], isEmpty);

    await _closeSheet(tester);
    provider.dispose();
  });

  testWidgets('(c) 预检失败：提示「预检暂不可用」，仍然启动/取消都不死胡同', (tester) async {
    final settings = await _settings();
    final provider = _SheetProvider(settings: settings);

    await _openSheet(
      tester,
      provider,
      client: _client(precheck: {'ok': false, 'error': 'boom'}, status: 500),
    );
    await _type(tester, 'unattended-goal', '修复登录页');
    await _type(tester, 'unattended-criterion-0', '登录页错误提示清楚');

    await _tap(tester, 'unattended-start');

    expect(provider.starts, isEmpty);
    expect(
      find.byKey(const ValueKey('unattended-precheck-unavailable')),
      findsOneWidget,
    );
    expect(find.text(t('unattendedPrecheckUnavailable')), findsOneWidget);
    expect(
      find.byKey(const ValueKey('unattended-precheck-start-anyway')),
      findsOneWidget,
    );
    expect(
      find.byKey(const ValueKey('unattended-precheck-cancel')),
      findsOneWidget,
    );

    await _tap(tester, 'unattended-precheck-start-anyway');
    expect(provider.starts, hasLength(1));
    expect(provider.starts.single['goal'], '修复登录页');

    await _closeSheet(tester);
    provider.dispose();
  });

  testWidgets('(c) 预检失败后点取消：不启动，回到普通表单', (tester) async {
    final settings = await _settings();
    final provider = _SheetProvider(settings: settings);

    await _openSheet(
      tester,
      provider,
      client: _client(precheck: {'ok': false, 'error': 'timeout'}, status: 500),
    );
    await _type(tester, 'unattended-goal', '修复登录页');
    await _tap(tester, 'unattended-start');
    await _tap(tester, 'unattended-precheck-cancel');

    expect(provider.starts, isEmpty);
    expect(
      find.byKey(const ValueKey('unattended-precheck-unavailable')),
      findsNothing,
    );

    await _closeSheet(tester);
    provider.dispose();
  });

  testWidgets('预检中第二次点启动被忽略：只发一次预检', (tester) async {
    final settings = await _settings();
    final provider = _SheetProvider(settings: settings);
    final requests = <Map<String, dynamic>>[];
    final gate = Completer<void>();

    await _openSheet(
      tester,
      provider,
      client: _client(precheck: _precheckOk(), requests: requests, gate: gate),
    );
    await _type(tester, 'unattended-goal', '修复登录页');
    await _type(tester, 'unattended-criterion-0', '错误提示清楚');

    final start = find.byKey(const ValueKey('unattended-start'));
    await tester.ensureVisible(start);
    await tester.tap(start);
    await tester.pump();

    expect(requests, hasLength(1));
    // 检查中按钮被禁用，文案换成「正在检查目标…」。
    final button = tester.widget<FilledButton>(start);
    expect(button.onPressed, isNull);
    expect(find.text(t('unattendedPrecheckChecking')), findsOneWidget);

    await tester.tap(start, warnIfMissed: false);
    await tester.pump();
    expect(requests, hasLength(1));

    gate.complete();
    await tester.pumpAndSettle();
    expect(provider.starts, hasLength(1));

    await _closeSheet(tester);
    provider.dispose();
  });

  testWidgets('手动「AI 补全判断标准」复用同一张卡：只采用建议，不启动', (tester) async {
    final settings = await _settings();
    final provider = _SheetProvider(settings: settings);

    await _openSheet(
      tester,
      provider,
      client: _client(precheck: _precheckNeedsWork()),
    );
    await _type(tester, 'unattended-goal', '把登录页弄好');

    await _tap(tester, 'unattended-draft-criteria');

    expect(provider.starts, isEmpty);
    expect(
      find.byKey(const ValueKey('unattended-precheck-card')),
      findsOneWidget,
    );
    expect(
      find.byKey(const ValueKey('unattended-precheck-adopt')),
      findsOneWidget,
    );
    expect(
      find.byKey(const ValueKey('unattended-precheck-use-start')),
      findsNothing,
    );

    await _tap(tester, 'unattended-precheck-adopt');
    expect(provider.starts, isEmpty);
    expect(
      tester
          .widget<TextField>(find.byKey(const ValueKey('unattended-goal')))
          .controller!
          .text,
      '修复登录页错误提示并补测试',
    );
    expect(
      tester
          .widget<TextField>(find.byKey(const ValueKey('unattended-criterion-0')))
          .controller!
          .text,
      '登录页错误提示能说清原因',
    );
    expect(
      find.byKey(const ValueKey('unattended-precheck-card')),
      findsNothing,
    );

    await _closeSheet(tester);
    provider.dispose();
  });

  testWidgets('继续（resume）不跑预检，只带可选时限', (tester) async {
    final settings = await _settings();
    final provider = _SheetProvider(settings: settings);
    provider.applyUnattendedEvent(const {
      'status': 'stopped',
      'goal': '旧目标',
      'criteria': ['旧标准'],
      'maxDurationMinutes': 60,
    });
    final requests = <Map<String, dynamic>>[];

    await _openSheet(
      tester,
      provider,
      client: _client(precheck: _precheckOk(), requests: requests),
    );

    await _tap(tester, 'unattended-resume');

    expect(provider.resumes, 1);
    expect(requests, isEmpty);
    expect(provider.updates, isEmpty);

    await _closeSheet(tester);
    provider.dispose();
  });

  testWidgets('终态面板可结束无人值守：草稿保留，面板回到启动态', (tester) async {
    final settings = await _settings();
    final provider = _SheetProvider(settings: settings);
    provider.applyUnattendedEvent(const {
      'status': 'stopped',
      'goal': '旧目标',
      'criteria': ['旧标准'],
      'maxDurationMinutes': 60,
    });

    await _openSheet(
      tester,
      provider,
      client: _client(precheck: _precheckOk()),
    );

    // 先在表单里改出一份草稿，结束之后必须原样留着。
    await _type(tester, 'unattended-goal', '我想保留的草稿目标');
    await _type(tester, 'unattended-criterion-0', '我想保留的草稿标准');
    await _type(tester, 'unattended-max-duration', '3');

    expect(find.byKey(const ValueKey('unattended-clear')), findsOneWidget);
    await _tap(tester, 'unattended-clear');

    expect(provider.clears, 1);
    // 状态落空：退场按钮与「继续」都消失，只剩「启动」。
    expect(find.byKey(const ValueKey('unattended-clear')), findsNothing);
    expect(find.byKey(const ValueKey('unattended-resume')), findsNothing);
    expect(find.byKey(const ValueKey('unattended-start')), findsOneWidget);

    // 草稿没有被清空，重启不用重填。
    expect(
      tester
          .widget<TextField>(find.byKey(const ValueKey('unattended-goal')))
          .controller!
          .text,
      '我想保留的草稿目标',
    );
    expect(
      tester
          .widget<TextField>(
            find.byKey(const ValueKey('unattended-criterion-0')),
          )
          .controller!
          .text,
      '我想保留的草稿标准',
    );
    expect(
      tester
          .widget<TextField>(
            find.byKey(const ValueKey('unattended-max-duration')),
          )
          .controller!
          .text,
      '3',
    );

    await _closeSheet(tester);
    provider.dispose();
  });

  testWidgets('已达成（achieved）面板也提供结束入口', (tester) async {
    final settings = await _settings();
    final provider = _SheetProvider(settings: settings);
    provider.applyUnattendedEvent(const {
      'status': 'achieved',
      'goal': '已经完成的目标',
      'criteria': ['已完成'],
    });

    await _openSheet(
      tester,
      provider,
      client: _client(precheck: _precheckOk()),
    );

    // achieved 不能 resume，但同样要给一条退场路。
    expect(find.byKey(const ValueKey('unattended-resume')), findsNothing);
    expect(find.byKey(const ValueKey('unattended-clear')), findsOneWidget);
    expect(find.byKey(const ValueKey('unattended-start')), findsOneWidget);

    await _closeSheet(tester);
    provider.dispose();
  });

  testWidgets('保存（update）不跑预检，只带 maxDurationMinutes', (tester) async {
    final settings = await _settings();
    final provider = _SheetProvider(settings: settings);
    final now = 1000000;
    provider.applyUnattendedEvent({
      'status': 'active',
      'goal': '旧目标',
      'criteria': ['旧标准'],
      'maxDurationMinutes': 60,
      'deadlineAt': now + 60 * 60000,
    });
    final requests = <Map<String, dynamic>>[];

    await _openSheet(
      tester,
      provider,
      client: _client(precheck: _precheckOk(), requests: requests),
      now: () => now,
    );

    await _tap(tester, 'unattended-save');

    expect(provider.updates, hasLength(1));
    expect(provider.updates.single['maxDurationMinutes'], 60);
    expect(requests, isEmpty);

    await _closeSheet(tester);
    provider.dispose();
  });

  testWidgets('面板状态显示「已判定 N 次」与剩余时间', (tester) async {
    final settings = await _settings();
    final provider = _SheetProvider(settings: settings);
    final now = 1000000;
    provider.applyUnattendedEvent({
      'status': 'active',
      'goal': '旧目标',
      'criteria': ['旧标准'],
      'rounds': 3,
      'maxDurationMinutes': 60,
      'deadlineAt': now + 30 * 60000,
    });

    await _openSheet(
      tester,
      provider,
      client: _client(precheck: _precheckOk()),
      now: () => now,
    );

    expect(
      tester
          .widget<Text>(find.byKey(const ValueKey('unattended-progress')))
          .data,
      '${t('unattendedJudgedCount', {'count': '3'})}'
      ' · ${t('unattendedRemaining', {'remaining': '30分'})}',
    );

    await _closeSheet(tester);
    provider.dispose();
  });

  testWidgets('重试等待中：状态块给出 HH:MM 自动重试（第 n 次）· 剩余', (tester) async {
    final settings = await _settings();
    final provider = _SheetProvider(settings: settings);
    final now = 1000000;
    provider.applyUnattendedEvent({
      'status': 'active',
      'rounds': 3,
      'maxDurationMinutes': 60,
      'deadlineAt': now + 30 * 60000,
      'retryAt': now + 5 * 60000,
      'retryCategory': 'capacity',
      'stall': {'consecutiveFaults': 2},
    });

    await _openSheet(
      tester,
      provider,
      client: _client(precheck: _precheckOk()),
      now: () => now,
    );

    final at = DateTime.fromMillisecondsSinceEpoch(now + 5 * 60000);
    final time =
        '${at.hour.toString().padLeft(2, '0')}:'
        '${at.minute.toString().padLeft(2, '0')}';
    expect(
      tester
          .widget<Text>(find.byKey(const ValueKey('unattended-retry')))
          .data,
      '${t('unattendedRetryCapacity', {'time': time, 'n': '2'})}'
      ' · ${t('unattendedRemaining', {'remaining': '30分'})}',
    );

    await _closeSheet(tester);
    provider.dispose();
  });
}
