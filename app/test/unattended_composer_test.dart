import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/models/chat_runtime_state.dart';
import 'package:multicc_app/models/message.dart';
import 'package:multicc_app/providers/chat_provider.dart';
import 'package:multicc_app/providers/session_manager.dart';
import 'package:multicc_app/services/chat_service.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/widgets/chat_runtime_panels.dart';
import 'package:multicc_app/widgets/input_bar.dart';
import 'package:multicc_app/widgets/unattended_sheet.dart';

// v2 契约（docs/unattended-mode.md）：`active` 是唯一武装态；输入区不再锁死，
// 用户消息进入 FIFO，本轮正常结束后由无人值守优先提交。横幅给出轮次/判定中/
// 暂停原因。
class _ComposerProvider extends ChatProvider {
  final sent = <String>[];
  int stopCalls = 0;
  int resumeCalls = 0;
  int clearCalls = 0;
  final ChatConnectionState _connectionState = ChatConnectionState.connected;

  _ComposerProvider({required super.settings})
    : super(sessionName: 'unattended-composer-test', sessionCwd: '/tmp');

  @override
  ChatConnectionState get connectionState => _connectionState;

  @override
  bool get isStreaming => false;

  @override
  String? sendMessage(
    String text, {
    String? clientMsgId,
    String? voiceRaw,
  }) {
    sent.add(text);
    return 'test-msg';
  }

  // 动作走 POST；这里只钉 UI 行为：按下去确实调用动作，并按契约回一个状态。
  @override
  Future<bool> stopUnattended() async {
    stopCalls++;
    applyUnattendedEvent(const {'status': 'stopped', 'pausedBy': 'user'});
    return true;
  }

  @override
  Future<bool> resumeUnattended({int? maxDurationMinutes}) async {
    resumeCalls++;
    applyUnattendedEvent(const {'status': 'active'});
    return true;
  }

  @override
  Future<bool> clearUnattended() async {
    clearCalls++;
    applyUnattendedEvent(null);
    return true;
  }
}

Future<SettingsService> _settings() async {
  SharedPreferences.setMockInitialValues({
    'multicc_host': 'http://127.0.0.1:1',
    'multicc_token': '',
  });
  return SettingsService.getInstance();
}

Widget _host({
  required SessionManager manager,
  required ChatProvider provider,
}) {
  return MultiProvider(
    providers: [
      ChangeNotifierProvider<SessionManager>.value(value: manager),
      ChangeNotifierProvider<ChatProvider>.value(value: provider),
    ],
    child: MaterialApp(
      home: Scaffold(
        body: Column(
          children: [
            Expanded(
              child: ColoredBox(
                key: const Key('chat-outside-surface'),
                color: Colors.black,
              ),
            ),
            const InputBar(),
          ],
        ),
      ),
    ),
  );
}

GestureDetector _sendTarget(WidgetTester tester) => tester.widget<GestureDetector>(
  find.ancestor(
    of: find.byIcon(Icons.send_rounded),
    matching: find.byType(GestureDetector),
  ),
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(() => I18n.init('zh'));

  testWidgets('active：横幅带剩余时间，输入区保持可用并提示消息会排队', (
    tester,
  ) async {
    final settings = await _settings();
    final manager = SessionManager(settings: settings);
    final provider = _ComposerProvider(settings: settings);

    await tester.pumpWidget(
      _host(manager: manager, provider: provider),
    );

    // 先留一份草稿，验证 active 下草稿不丢、照常能发。
    final input = find.byKey(const Key('chat-message-input'));
    await tester.enterText(input, '先写一半');
    await tester.pump();
    expect(_sendTarget(tester).onTap, isNotNull);

    // 45 分钟余量：多留 15 秒，避免测试执行到 build 时刚好跨过分钟边界。
    final deadline =
        DateTime.now().millisecondsSinceEpoch + 45 * 60000 + 15000;
    provider.applyUnattendedEvent({
      'status': 'active',
      'rounds': 2,
      'maxDurationMinutes': 120,
      'deadlineAt': deadline,
      'evaluating': true,
    });
    await tester.pump();

    // 横幅：剩余时间 + 判定中，主按钮是「暂停并接管」。
    expect(find.byKey(const ValueKey('unattended-banner')), findsOneWidget);
    expect(
      tester
          .widget<Text>(find.byKey(const ValueKey('unattended-banner-text')))
          .data,
      '${t('unattendedBannerActive', {'remaining': '45分'})}'
      ' · ${t('unattendedJudging')}',
    );
    expect(
      find.descendant(
        of: find.byKey(const ValueKey('unattended-banner')),
        matching: find.byType(CircularProgressIndicator),
      ),
      findsOneWidget,
    );
    expect(find.byKey(const ValueKey('unattended-pause')), findsOneWidget);

    // 输入区不锁：文本框可编辑，占位提示改成「发送会排队」，草稿还在。
    final field = tester.widget<TextField>(input);
    expect(field.enabled, isNot(false), reason: 'enabled 未显式设置时 Flutter 返回 null，语义仍是可编辑');
    expect(field.decoration?.hintText, t('unattendedInputQueued'));
    expect(field.controller!.text, '先写一半');
    expect(_sendTarget(tester).onTap, isNotNull);

    await tester.tap(find.byIcon(Icons.send_rounded));
    await tester.pump();
    expect(provider.sent, ['先写一半']);
    expect(provider.unattendedActive, isTrue);
    await tester.enterText(input, '接着补充');
    await tester.pump();

    // 「暂停并接管」真的调用 stop；返回 stopped 后横幅换成继续 + 原因。
    await tester.ensureVisible(find.byKey(const ValueKey('unattended-pause')));
    await tester.tap(find.byKey(const ValueKey('unattended-pause')));
    await tester.pump();
    expect(provider.stopCalls, 1);
    expect(find.byKey(const ValueKey('unattended-resume-banner')), findsOneWidget);
    expect(
      tester
          .widget<Text>(find.byKey(const ValueKey('unattended-banner-reason')))
          .data,
      t('unattendedPausedByUser'),
    );

    // 暂停后：草稿仍在，发送手势照旧可用。
    final unlocked = tester.widget<TextField>(input);
    expect(unlocked.enabled, isNot(false));
    expect(unlocked.controller!.text, '接着补充');
    expect(_sendTarget(tester).onTap, isNotNull);

    await tester.tap(find.byIcon(Icons.send_rounded));
    await tester.pump();
    expect(provider.sent, ['先写一半', '接着补充']);

    // 「继续无人值守」再武装回去：横幅回到 active，输入仍然可用。
    await tester.ensureVisible(
      find.byKey(const ValueKey('unattended-resume-banner')),
    );
    await tester.tap(find.byKey(const ValueKey('unattended-resume-banner')));
    await tester.pump();
    expect(provider.resumeCalls, 1);
    expect(find.byKey(const ValueKey('unattended-pause')), findsOneWidget);
    expect(tester.widget<TextField>(input).enabled, isNot(false));
    expect(
      tester.widget<TextField>(input).decoration?.hintText,
      t('unattendedInputQueued'),
    );

    await tester.pumpWidget(const SizedBox.shrink());
    provider.dispose();
    manager.dispose();
  });

  testWidgets('终态横幅：次要按钮结束无人值守 -> 横幅消失、输入解锁；active 不出现', (
    tester,
  ) async {
    final settings = await _settings();
    final manager = SessionManager(settings: settings);
    final provider = _ComposerProvider(settings: settings);

    await tester.pumpWidget(_host(manager: manager, provider: provider));

    provider.applyUnattendedEvent(const {
      'status': 'stopped',
      'pausedBy': 'user',
    });
    await tester.pump();

    // 终态：主按钮「继续无人值守」+ 次要按钮「结束无人值守」并存。
    expect(
      find.byKey(const ValueKey('unattended-resume-banner')),
      findsOneWidget,
    );
    expect(
      find.byKey(const ValueKey('unattended-clear-banner')),
      findsOneWidget,
    );
    expect(
      tester
          .widget<Tooltip>(
            find
                .ancestor(
                  of: find.byKey(const ValueKey('unattended-clear-banner')),
                  matching: find.byType(Tooltip),
                )
                .first,
          )
          .message,
      t('unattendedClearHint'),
    );

    await tester.ensureVisible(
      find.byKey(const ValueKey('unattended-clear-banner')),
    );
    await tester.tap(find.byKey(const ValueKey('unattended-clear-banner')));
    await tester.pump();

    // 结束后本地状态落空：横幅消失，输入不再被无人值守锁住。
    expect(provider.clearCalls, 1);
    expect(find.byKey(const ValueKey('unattended-banner')), findsNothing);
    final unlocked = tester.widget<TextField>(
      find.byKey(const Key('chat-message-input')),
    );
    expect(unlocked.enabled, isNot(false));

    // active 只有「暂停并接管」，不出现结束按钮。
    provider.applyUnattendedEvent(const {'status': 'active'});
    await tester.pump();
    expect(find.byKey(const ValueKey('unattended-pause')), findsOneWidget);
    expect(
      find.byKey(const ValueKey('unattended-clear-banner')),
      findsNothing,
    );

    await tester.pumpWidget(const SizedBox.shrink());
    provider.dispose();
    manager.dispose();
  });

  testWidgets('终态各按 pausedBy 给原因，无原因的不会凭空造一句', (tester) async {
    final settings = await _settings();
    final manager = SessionManager(settings: settings);
    final provider = _ComposerProvider(settings: settings);

    await tester.pumpWidget(
      _host(manager: manager, provider: provider),
    );

    for (final (pausedBy, key) in const [
      ('user', 'unattendedPausedByUser'),
      ('input', 'unattendedPausedByInput'),
      ('cancel', 'unattendedPausedByCancel'),
    ]) {
      provider.applyUnattendedEvent({
        'status': 'stopped',
        'pausedBy': pausedBy,
      });
      await tester.pump();
      expect(
        tester
            .widget<Text>(find.byKey(const ValueKey('unattended-banner-reason')))
            .data,
        t(key),
        reason: pausedBy,
      );
      expect(
        find.byKey(const ValueKey('unattended-resume-banner')),
        findsOneWidget,
      );
    }

    // 没有 pausedBy 的终态只给状态文案，不画原因。
    provider.applyUnattendedEvent(const {'status': 'exhausted'});
    await tester.pump();
    expect(find.byKey(const ValueKey('unattended-banner-reason')), findsNothing);
    expect(
      tester
          .widget<Text>(find.byKey(const ValueKey('unattended-banner-text')))
          .data,
      t('unattendedStatusExhausted'),
    );

    // achieved 是终态但不能 resume：横幅整个不出现（面板入口另有状态）。
    provider.applyUnattendedEvent(const {'status': 'achieved'});
    await tester.pump();
    expect(find.byKey(const ValueKey('unattended-banner')), findsNothing);

    await tester.pumpWidget(const SizedBox.shrink());
    provider.dispose();
    manager.dispose();
  });

  testWidgets('故障恢复重试：容量/故障/即将重试三种文案，到点回落普通横幅', (tester) async {
    final settings = await _settings();
    final manager = SessionManager(settings: settings);
    final provider = _ComposerProvider(settings: settings);
    var now = DateTime(2026, 11, 11, 10, 0).millisecondsSinceEpoch;

    await tester.pumpWidget(
      MultiProvider(
        providers: [
          ChangeNotifierProvider<SessionManager>.value(value: manager),
          ChangeNotifierProvider<ChatProvider>.value(value: provider),
        ],
        child: MaterialApp(
          home: Scaffold(
            body: AnimatedBuilder(
              animation: provider,
              builder: (context, _) => UnattendedComposerBanner(
                provider: provider,
                now: () => now,
              ),
            ),
          ),
        ),
      ),
    );

    String bannerText() => tester
        .widget<Text>(find.byKey(const ValueKey('unattended-banner-text')))
        .data!;

    // 上游额度/线路暂不可用：HH:MM 自动重试（第 n 次）· 剩余 X。
    provider.applyUnattendedEvent({
      'status': 'active',
      'maxDurationMinutes': 120,
      'deadlineAt': now + 45 * 60000 + 6000,
      'retryAt': now + 5 * 60000,
      'retryCategory': 'capacity',
      'stall': {'consecutiveFaults': 2},
    });
    await tester.pump();
    expect(
      bannerText(),
      '${t('unattendedRetryCapacity', {'time': '10:05', 'n': '2'})}'
      ' · ${t('unattendedRemaining', {'remaining': '45分'})}',
    );
    // 「暂停并接管」仍在（输入锁由 InputBar 层测试覆盖）。
    expect(find.byKey(const ValueKey('unattended-pause')), findsOneWidget);

    // 普通故障：换成「故障恢复中」。
    provider.applyUnattendedEvent({
      'status': 'active',
      'maxDurationMinutes': 120,
      'deadlineAt': now + 45 * 60000 + 6000,
      'retryAt': now + 6 * 60000,
      'retryCategory': 'fault',
      'stall': {'consecutiveFaults': 4},
    });
    await tester.pump();
    expect(
      bannerText(),
      '${t('unattendedRetryFault', {'time': '10:06', 'n': '4'})}'
      ' · ${t('unattendedRemaining', {'remaining': '45分'})}',
    );

    // 60 秒内只给「即将自动重试」，不再报钟点。
    provider.applyUnattendedEvent({
      'status': 'active',
      'maxDurationMinutes': 120,
      'deadlineAt': now + 45 * 60000 + 6000,
      'retryAt': now + 5000,
      'retryCategory': 'capacity',
      'stall': {'consecutiveFaults': 5},
    });
    await tester.pump();
    expect(
      bannerText(),
      '${t('unattended')} · ${t('unattendedRetrySoon')}'
      ' · ${t('unattendedRemaining', {'remaining': '45分'})}',
    );

    // 到点（注入时钟推进 + 一次性定时器触发）后回落普通 active 横幅。
    now += 6000;
    await tester.pump(const Duration(seconds: 6));
    expect(
      bannerText(),
      t('unattendedBannerActive', {'remaining': '45分'}),
    );
    expect(find.byKey(const ValueKey('unattended-pause')), findsOneWidget);

    await tester.pumpWidget(const SizedBox.shrink());
    provider.dispose();
    manager.dispose();
  });

  testWidgets('重试等待中：输入仍可用（排队提示），暂停并接管仍在', (tester) async {
    final settings = await _settings();
    final manager = SessionManager(settings: settings);
    final provider = _ComposerProvider(settings: settings);
    await tester.pumpWidget(_host(manager: manager, provider: provider));

    final retryAt = DateTime.now().millisecondsSinceEpoch + 5 * 60000;
    final at = DateTime.fromMillisecondsSinceEpoch(retryAt);
    final time =
        '${at.hour.toString().padLeft(2, '0')}:'
        '${at.minute.toString().padLeft(2, '0')}';
    provider.applyUnattendedEvent({
      'status': 'active',
      'retryAt': retryAt,
      'retryCategory': 'capacity',
      'stall': {'consecutiveFaults': 1},
    });
    await tester.pump();

    expect(
      tester
          .widget<Text>(find.byKey(const ValueKey('unattended-banner-text')))
          .data,
      t('unattendedRetryCapacity', {'time': time, 'n': '1'}),
    );
    final field = tester.widget<TextField>(
      find.byKey(const Key('chat-message-input')),
    );
    expect(field.enabled, isNot(false), reason: 'enabled 未显式设置时 Flutter 返回 null，语义仍是可编辑');
    expect(field.decoration?.hintText, t('unattendedInputQueued'));
    expect(find.byKey(const ValueKey('unattended-pause')), findsOneWidget);

    await tester.pumpWidget(const SizedBox.shrink());
    provider.dispose();
    manager.dispose();
  });

  test('实时轨迹帧按 entry.id 去重：重连重放不会同一条画两遍', () async {
    final settings = await _settings();
    final provider = _ComposerProvider(settings: settings);
    final frame = <String, dynamic>{
      'type': 'unattended_trace',
      'kind': 'unattended_trace',
      'message': '$kUnattendedTag 判定：继续',
      'entry': {
        'id': 'trace-9',
        'role': 'system',
        'kind': 'unattended_trace',
        'content': '$kUnattendedTag 判定：继续',
        'ts': 1724000000000,
      },
    };

    provider.applyUnattendedTraceEvent(frame);
    provider.applyUnattendedTraceEvent(frame);

    final traces = provider.messages.where((m) => m.unattendedTrace).toList();
    expect(traces, hasLength(1));
    expect(traces.single.role, MessageRole.system);
    expect(traces.single.content, '判定：继续');

    provider.dispose();
  });

  testWidgets('待答卡在无人值守时锁住选项并提示 AI 代答', (tester) async {
    var answers = <String>[];
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: PendingUserInputPanel(
            input: const PendingUserInput(
              requestId: 'req-1',
              question: '用哪种风格？',
              options: ['简洁', '详细'],
            ),
            enabled: true,
            unattendedLocked: true,
            onAnswer: answers.add,
          ),
        ),
      ),
    );

    expect(find.byKey(const Key('pending-unattended-hint')), findsOneWidget);
    final option = tester.widget<OutlinedButton>(
      find.byKey(const Key('pending-option-简洁')),
    );
    expect(option.onPressed, isNull);

    await tester.tap(find.byKey(const Key('pending-option-简洁')));
    await tester.pump();
    expect(answers, isEmpty);

    // 锁解除后选项恢复作答。
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: PendingUserInputPanel(
            input: const PendingUserInput(
              requestId: 'req-1',
              question: '用哪种风格？',
              options: ['简洁', '详细'],
            ),
            enabled: true,
            onAnswer: answers.add,
          ),
        ),
      ),
    );
    expect(find.byKey(const Key('pending-unattended-hint')), findsNothing);
    await tester.tap(find.byKey(const Key('pending-option-简洁')));
    await tester.pump();
    expect(answers, ['简洁']);
  });
}
