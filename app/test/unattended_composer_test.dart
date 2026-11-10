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

// v2 契约（docs/unattended-mode.md）：`active` 是唯一武装态，输入区整体锁住；
// 横幅给出轮次/判定中/暂停原因，真人先「暂停并接管」再打字。
class _ComposerProvider extends ChatProvider {
  final sent = <String>[];
  int stopCalls = 0;
  int resumeCalls = 0;
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
  Future<bool> resumeUnattended() async {
    resumeCalls++;
    applyUnattendedEvent(const {'status': 'active'});
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

  testWidgets('active：横幅带轮次与锁定提示，输入/发送全禁用；暂停后恢复发送', (
    tester,
  ) async {
    final settings = await _settings();
    final manager = SessionManager(settings: settings);
    final provider = _ComposerProvider(settings: settings);

    await tester.pumpWidget(
      _host(manager: manager, provider: provider),
    );

    // 先留一份草稿，验证锁住时草稿不丢、解锁后还能发。
    final input = find.byKey(const Key('chat-message-input'));
    await tester.enterText(input, '先写一半');
    await tester.pump();
    expect(_sendTarget(tester).onTap, isNotNull);

    provider.applyUnattendedEvent(const {
      'status': 'active',
      'rounds': 2,
      'maxRounds': 30,
      'evaluating': true,
    });
    await tester.pump();

    // 横幅：轮次 + 判定中，主按钮是「暂停并接管」。
    expect(find.byKey(const ValueKey('unattended-banner')), findsOneWidget);
    expect(
      tester
          .widget<Text>(find.byKey(const ValueKey('unattended-banner-text')))
          .data,
      '${t('unattendedBannerActive', {'round': '2', 'max': '30'})}'
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

    // 输入区锁住：文本框禁用 + 锁定文案，发送手势没有回调，但草稿还在。
    final field = tester.widget<TextField>(input);
    expect(field.enabled, isFalse);
    expect(field.decoration?.hintText, t('unattendedInputLocked'));
    expect(field.controller!.text, '先写一半');
    expect(_sendTarget(tester).onTap, isNull);
    expect(provider.sent, isEmpty);

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

    // 解锁：文本框恢复可编辑，草稿仍在，发送手势回来了。
    final unlocked = tester.widget<TextField>(input);
    expect(unlocked.enabled, isTrue);
    expect(unlocked.controller!.text, '先写一半');
    expect(_sendTarget(tester).onTap, isNotNull);

    await tester.tap(find.byIcon(Icons.send_rounded));
    await tester.pump();
    expect(provider.sent, ['先写一半']);

    // 「继续无人值守」再武装回去：横幅回到 active，输入重新锁住。
    await tester.ensureVisible(
      find.byKey(const ValueKey('unattended-resume-banner')),
    );
    await tester.tap(find.byKey(const ValueKey('unattended-resume-banner')));
    await tester.pump();
    expect(provider.resumeCalls, 1);
    expect(find.byKey(const ValueKey('unattended-pause')), findsOneWidget);
    expect(tester.widget<TextField>(input).enabled, isFalse);

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
