import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/models/chat_runtime_state.dart';
import 'package:multicc_app/models/vendor_quota.dart';
import 'package:multicc_app/widgets/chat_runtime_panels.dart';

Widget _host(Widget child) => MaterialApp(
  home: Scaffold(
    body: SizedBox(width: 360, child: SingleChildScrollView(child: child)),
  ),
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(() => I18n.init('zh'));

  testWidgets(
    'multiple-choice pending input submits in canonical option order',
    (tester) async {
      String? answer;
      await tester.pumpWidget(
        _host(
          PendingUserInputPanel(
            input: const PendingUserInput(
              requestId: 'r-1',
              question: '选择检查项',
              options: ['模型', '队列', '缓存'],
              allowMultiple: true,
            ),
            enabled: true,
            onAnswer: (value) => answer = value,
          ),
        ),
      );

      await tester.tap(find.byKey(const Key('pending-option-缓存')));
      await tester.pump();
      await tester.tap(find.byKey(const Key('pending-option-模型')));
      await tester.pump();
      await tester.tap(find.byKey(const Key('pending-submit-multiple')));
      expect(answer, '模型, 缓存');
    },
  );

  testWidgets('pending input supports a free-text answer in the top card', (
    tester,
  ) async {
    String? answer;
    await tester.pumpWidget(
      _host(
        PendingUserInputPanel(
          input: const PendingUserInput(requestId: 'r-text', question: '请输入说明'),
          enabled: true,
          onAnswer: (value) => answer = value,
        ),
      ),
    );

    await tester.enterText(
      find.byKey(const Key('pending-free-text')),
      '  自定义回答  ',
    );
    await tester.pump();
    await tester.tap(find.byKey(const Key('pending-submit-text')));
    expect(answer, '自定义回答');
  });

  testWidgets('frozen queue exposes server actions and per-entry cancel', (
    tester,
  ) async {
    final actions = <String>[];
    final cancelled = <String>[];
    final queue = SessionQueueState.fromEvent({
      'state': 'frozen',
      'freezeReason': 'unknown_interruption',
      'active': {'entryId': 'active'},
      'items': [
        {
          'entryId': 'queued-1',
          'state': 'pending',
          'position': 1,
          'text': 'next',
        },
      ],
    });
    await tester.pumpWidget(
      _host(
        SessionQueuePanel(
          queue: queue,
          enabled: true,
          onAction: (value) async => actions.add(value),
          onCancelQueued: (value) async => cancelled.add(value),
        ),
      ),
    );

    expect(find.byKey(const Key('queue-action-retry')), findsOneWidget);
    expect(find.byKey(const Key('queue-action-resume')), findsOneWidget);
    await tester.tap(find.byKey(const Key('queue-action-retry')));
    await tester.pump();
    expect(actions, ['retry']);

    await tester.tap(find.byType(InkWell).first);
    await tester.pump();
    await tester.tap(find.byKey(const Key('cancel-queued-queued-1')));
    await tester.pump();
    expect(cancelled, ['queued-1']);
  });

  testWidgets('queued entries offer insert; the prioritised one shows running', (
    tester,
  ) async {
    final inserted = <String>[];
    final queue = SessionQueueState.fromEvent({
      'state': 'queued',
      'items': [
        {
          'entryId': 'queued-1',
          'state': 'pending',
          'position': 1,
          'text': 'first',
        },
        {
          'entryId': 'queued-2',
          'state': 'pending',
          'position': 2,
          'text': 'second',
          'priority': true,
        },
      ],
    });
    await tester.pumpWidget(
      _host(
        SessionQueuePanel(
          queue: queue,
          enabled: true,
          onAction: (_) async {},
          onCancelQueued: (_) async {},
          onInsertQueued: (value) async => inserted.add(value),
        ),
      ),
    );

    await tester.tap(find.byType(InkWell).first);
    await tester.pump();

    expect(find.byKey(const Key('insert-queued-queued-2')), findsNothing);
    expect(find.byKey(const Key('queued-running-queued-2')), findsOneWidget);

    await tester.tap(find.byKey(const Key('insert-queued-queued-1')));
    await tester.pump();
    expect(inserted, ['queued-1']);
  });

  testWidgets('without an insert callback the queue keeps the cancel-only row', (
    tester,
  ) async {
    final queue = SessionQueueState.fromEvent({
      'state': 'queued',
      'items': [
        {
          'entryId': 'queued-1',
          'state': 'pending',
          'position': 1,
          'text': 'first',
        },
      ],
    });
    await tester.pumpWidget(
      _host(
        SessionQueuePanel(
          queue: queue,
          enabled: true,
          onAction: (_) async {},
          onCancelQueued: (_) async {},
        ),
      ),
    );

    await tester.tap(find.byType(InkWell).first);
    await tester.pump();
    expect(find.byKey(const Key('insert-queued-queued-1')), findsNothing);
    expect(find.byKey(const Key('cancel-queued-queued-1')), findsOneWidget);
  });

  testWidgets('GLM/Codex window bar paints the server-resolved view verbatim', (
    tester,
  ) async {
    // The provider resolves the server-rendered bar to a VendorQuotaView; the
    // panel paints it as-is (no local formatting). The bar's words/countdown
    // are pinned deterministically by the golden parity tests.
    await tester.pumpWidget(
      _host(
        ChatRuntimeNoticePanel(
          limit: const VendorQuotaView(
            '5h 50% 1h',
            VendorQuotaColor.blue,
            'GLM Coding Plan 五小时窗口用量',
          ),
        ),
      ),
    );
    expect(find.textContaining('5h 50%'), findsOneWidget);
  });

  testWidgets('OpenCode / Codex bars render and tap fires their handlers', (
    tester,
  ) async {
    var openTaps = 0;
    var codexTaps = 0;
    await tester.pumpWidget(
      _host(
        ChatRuntimeNoticePanel(
          opencodeUsage: const VendorQuotaView(
            'OpenCode Go · 5h 92% 39m',
            VendorQuotaColor.blue,
          ),
          codexUsage: const VendorQuotaView('1wk 75%', VendorQuotaColor.blue),
          onOpenCodeQuotaTap: () => openTaps++,
          onCodexQuotaTap: () => codexTaps++,
        ),
      ),
    );
    expect(find.textContaining('OpenCode Go'), findsOneWidget);
    expect(find.text('1wk 75%'), findsOneWidget);
    await tester.tap(find.byKey(const Key('opencode-quota-bar')));
    await tester.pump();
    await tester.tap(find.byKey(const Key('codex-quota-bar')));
    await tester.pump();
    expect(openTaps, 1);
    expect(codexTaps, 1);
  });

  testWidgets('Claude usage bar renders and tapping it fires the refresh tap', (
    tester,
  ) async {
    var taps = 0;
    await tester.pumpWidget(
      _host(
        ChatRuntimeNoticePanel(
          claudeUsage: const VendorQuotaView(
            '5h 50% · 1wk 70%',
            VendorQuotaColor.blue,
            'Claude 订阅窗口用量 tooltip',
          ),
          onClaudeQuotaTap: () => taps++,
        ),
      ),
    );
    expect(find.text('5h 50% · 1wk 70%'), findsOneWidget);
    await tester.tap(find.byKey(const Key('claude-quota-bar')));
    await tester.pump();
    expect(taps, 1);
  });

  testWidgets('Qoder usage bar renders and tapping it fires the refresh tap', (
    tester,
  ) async {
    var taps = 0;
    await tester.pumpWidget(
      _host(
        ChatRuntimeNoticePanel(
          qoderUsage: const VendorQuotaView(
            '1m 40% 13d 8h · 刚刚 ⟳',
            VendorQuotaColor.blue,
            'Qoder CN 用量 tooltip\n重置: 2026/8/22 00:00（13d 8h 后）',
          ),
          onQoderQuotaTap: () => taps++,
        ),
      ),
    );
    expect(find.text('1m 40% 13d 8h · 刚刚 ⟳'), findsOneWidget);
    await tester.tap(find.byKey(const Key('qoder-quota-bar')));
    await tester.pump();
    expect(taps, 1);
  });

  testWidgets('Ark / Zhipu / Kimi bars render as tappable slots in web order', (
    tester,
  ) async {
    var arkTaps = 0;
    var zhipuTaps = 0;
    var kimiTaps = 0;
    await tester.pumpWidget(
      _host(
        ChatRuntimeNoticePanel(
          opencodeUsage: const VendorQuotaView('OpenCode Go · 5h 92%', VendorQuotaColor.blue),
          qoderUsage: const VendorQuotaView('1m 40%', VendorQuotaColor.blue),
          codexUsage: const VendorQuotaView('1wk 75%', VendorQuotaColor.blue),
          claudeUsage: const VendorQuotaView('5h 50% · 1wk 70%', VendorQuotaColor.blue),
          limit: const VendorQuotaView('5h 50% 1h', VendorQuotaColor.blue),
          balance: const VendorQuotaView('DeepSeek 余额 ¥1.2', VendorQuotaColor.blue),
          arkUsage: const VendorQuotaView('Coding 5h 30%', VendorQuotaColor.blue),
          zhipuUsage: const VendorQuotaView('GLM 用量 60%', VendorQuotaColor.blue),
          kimiUsage: const VendorQuotaView('Kimi 1wk 20%', VendorQuotaColor.blue),
          onOpenCodeQuotaTap: () {},
          onQoderQuotaTap: () {},
          onCodexQuotaTap: () {},
          onClaudeQuotaTap: () {},
          onArkQuotaTap: () => arkTaps++,
          onZhipuQuotaTap: () => zhipuTaps++,
          onKimiQuotaTap: () => kimiTaps++,
        ),
      ),
    );
    // Slot order matches the web chat.html bar row.
    final order = tester
        .widgetList<Wrap>(
          find.descendant(
            of: find.byKey(const Key('chat-runtime-notice-panel')),
            matching: find.byType(Wrap),
          ),
        )
        .first
        .children
        .whereType<Widget>()
        .toList();
    final keys = [
      'opencode-quota-bar',
      'qoder-quota-bar',
      'codex-quota-bar',
      'claude-quota-bar',
      'ark-quota-bar',
      'zhipu-quota-bar',
      'kimi-quota-bar',
    ];
    final seen = [
      for (final w in order)
        if (w is InkWell && w.key is ValueKey<String>)
          (w.key as ValueKey<String>).value,
    ].where((k) => keys.contains(k)).toList();
    expect(seen, keys);

    await tester.tap(find.byKey(const Key('ark-quota-bar')));
    await tester.pump();
    await tester.tap(find.byKey(const Key('zhipu-quota-bar')));
    await tester.pump();
    await tester.tap(find.byKey(const Key('kimi-quota-bar')));
    await tester.pump();
    expect(arkTaps, 1);
    expect(zhipuTaps, 1);
    expect(kimiTaps, 1);
  });

  testWidgets('API error only offers manual retry when policy says safe', (
    tester,
  ) async {
    var retries = 0;
    ApiErrorPolicyState state(bool partial) => ApiErrorPolicyState.fromJson({
      'state': 'failed',
      'provider': 'claude',
      'category': 'transport',
      'safeToRetry': true,
      'partialOutput': partial,
    })!;

    await tester.pumpWidget(
      _host(
        ChatRuntimeNoticePanel(apiError: state(true), onRetry: () => retries++),
      ),
    );
    expect(find.byKey(const Key('api-error-manual-retry')), findsNothing);

    await tester.pumpWidget(
      _host(
        ChatRuntimeNoticePanel(
          apiError: state(false),
          onRetry: () => retries++,
        ),
      ),
    );
    await tester.tap(find.byKey(const Key('api-error-manual-retry')));
    expect(retries, 1);
  });
}
