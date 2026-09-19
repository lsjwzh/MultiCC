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

  // secret 模式：密码框收值，提交走 onSecretSubmit（直存保险箱），绝不落入
  // onAnswer/聊天文本——与 web chat-user-input-card 的 secret 测试同一条红线。
  testWidgets('secret mode masks the field and routes to onSecretSubmit', (
    tester,
  ) async {
    String? secret;
    String? answer;
    await tester.pumpWidget(
      _host(
        PendingUserInputPanel(
          input: const PendingUserInput(
            requestId: 'r-secret',
            question: '请填写 API Key',
            isSecret: true,
            secretName: 'OPENAI_API_KEY',
          ),
          enabled: true,
          onAnswer: (value) => answer = value,
          onSecretSubmit: (value) => secret = value,
        ),
      ),
    );

    final field = tester.widget<TextField>(
      find.byKey(const Key('pending-secret-text')),
    );
    expect(field.obscureText, isTrue, reason: 'secret values must be masked');
    await tester.enterText(
      find.byKey(const Key('pending-secret-text')),
      '  sk-live-123  ',
    );
    await tester.pump();
    await tester.tap(find.byKey(const Key('pending-submit-text')));
    expect(secret, 'sk-live-123');
    expect(answer, isNull, reason: 'secret values must never become chat text');
  });

  // 「已解决 / 忽略」：与「收起」不同，它真的改变服务端的等待态
  // （web 的 #pending-user-input-dismiss）。
  testWidgets('pending input offers 已解决 / 忽略 and reports the tap', (
    tester,
  ) async {
    var dismissed = 0;
    await tester.pumpWidget(
      _host(
        PendingUserInputPanel(
          input: const PendingUserInput(requestId: 'r-dismiss', question: '继续吗'),
          enabled: true,
          onAnswer: (_) {},
          onDismiss: () => dismissed++,
        ),
      ),
    );

    expect(find.text('已解决 / 忽略'), findsOneWidget);
    await tester.tap(find.byKey(const Key('pending-dismiss')));
    await tester.pump();
    expect(dismissed, 1);
  });

  testWidgets('without a dismiss callback the pending card has no such button', (
    tester,
  ) async {
    await tester.pumpWidget(
      _host(
        PendingUserInputPanel(
          input: const PendingUserInput(requestId: 'r-no-dismiss', question: '继续吗'),
          enabled: true,
          onAnswer: (_) {},
        ),
      ),
    );

    expect(find.byKey(const Key('pending-dismiss')), findsNothing);
    expect(find.text('已解决 / 忽略'), findsNothing);
  });

  testWidgets('an offline session cannot dismiss the pending question', (
    tester,
  ) async {
    var dismissed = 0;
    await tester.pumpWidget(
      _host(
        PendingUserInputPanel(
          input: const PendingUserInput(requestId: 'r-offline', question: '继续吗'),
          enabled: false,
          onAnswer: (_) {},
          onDismiss: () => dismissed++,
        ),
      ),
    );

    final button = tester.widget<TextButton>(
      find.byKey(const Key('pending-dismiss')),
    );
    expect(button.onPressed, isNull);
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

  testWidgets('dragging a staged row reports the index it was dropped on', (
    tester,
  ) async {
    final moves = <List<Object>>[];
    await tester.pumpWidget(
      _host(
        SessionQueuePanel(
          queue: _pendingQueue(3),
          enabled: true,
          onAction: (_) async {},
          onCancelQueued: (_) async {},
          onReorderQueued: (entryId, toIndex) async =>
              moves.add([entryId, toIndex]),
        ),
      ),
    );
    await tester.tap(find.byType(InkWell).first);
    await tester.pumpAndSettle();

    await _dragRowDown(tester, 'queued-1', rows: 2);
    // 往下拖两行就是第二格（0 起算的下标 2），和服务端 position 同一语义。
    expect(moves, [
      ['queued-1', 2],
    ]);
  });

  testWidgets('dragging a staged row up by one lands it one slot earlier', (
    tester,
  ) async {
    final moves = <List<Object>>[];
    await tester.pumpWidget(
      _host(
        SessionQueuePanel(
          queue: _pendingQueue(3),
          enabled: true,
          onAction: (_) async {},
          onCancelQueued: (_) async {},
          onReorderQueued: (entryId, toIndex) async =>
              moves.add([entryId, toIndex]),
        ),
      ),
    );
    await tester.tap(find.byType(InkWell).first);
    await tester.pumpAndSettle();

    await _dragRowDown(tester, 'queued-3', rows: -1);
    expect(moves, [
      ['queued-3', 1],
    ]);
  });

  testWidgets('a claimed entry has no drag handle, and one message has none', (
    tester,
  ) async {
    final queue = SessionQueueState.fromEvent({
      'state': 'queued',
      'items': [
        {
          'entryId': 'leased',
          'state': 'leased',
          'position': 1,
          'text': '执行中',
        },
        {'entryId': 'pending', 'state': 'pending', 'position': 2, 'text': '可移动'},
      ],
    });
    await tester.pumpWidget(
      _host(
        SessionQueuePanel(
          queue: queue,
          enabled: true,
          onAction: (_) async {},
          onCancelQueued: (_) async {},
          onReorderQueued: (_, _) async {},
        ),
      ),
    );
    await tester.tap(find.byType(InkWell).first);
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('reorder-queued-leased')), findsNothing);
    expect(find.byKey(const Key('reorder-queued-pending')), findsOneWidget);

    // 只有一条时没有顺序可调，手柄不该出现。
    await tester.pumpWidget(
      _host(
        SessionQueuePanel(
          queue: _pendingQueue(1),
          enabled: true,
          onAction: (_) async {},
          onCancelQueued: (_) async {},
          onReorderQueued: (_, _) async {},
        ),
      ),
    );
    await tester.tap(find.byType(InkWell).first);
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('reorder-queued-queued-1')), findsNothing);
  });

  testWidgets('without a reorder callback the rows stay a static list', (
    tester,
  ) async {
    await tester.pumpWidget(
      _host(
        SessionQueuePanel(
          queue: _pendingQueue(3),
          enabled: true,
          onAction: (_) async {},
          onCancelQueued: (_) async {},
        ),
      ),
    );
    await tester.tap(find.byType(InkWell).first);
    await tester.pumpAndSettle();
    expect(find.byType(ReorderableListView), findsNothing);
    expect(find.byKey(const Key('reorder-queued-queued-1')), findsNothing);
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

  testWidgets('Ark / Kimi bars render as tappable slots in web order', (
    tester,
  ) async {
    var arkTaps = 0;
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
          kimiUsage: const VendorQuotaView('Kimi 1wk 20%', VendorQuotaColor.blue),
          onOpenCodeQuotaTap: () {},
          onQoderQuotaTap: () {},
          onCodexQuotaTap: () {},
          onClaudeQuotaTap: () {},
          onArkQuotaTap: () => arkTaps++,
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
    await tester.tap(find.byKey(const Key('kimi-quota-bar')));
    await tester.pump();
    expect(arkTaps, 1);
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

  testWidgets('API error panel exposes the sanitized root cause', (
    tester,
  ) async {
    final state = ApiErrorPolicyState.fromJson({
      'state': 'failed',
      'provider': 'claude',
      'category': 'network',
      'httpStatus': 502,
      'message': '上游 API 请求失败，未自动重试。根因：getaddrinfo ENOTFOUND open.bigmodel.cn。',
      'rootCause': 'getaddrinfo ENOTFOUND open.bigmodel.cn',
      'userAction': '稍后手动继续',
    })!;
    await tester.pumpWidget(_host(ChatRuntimeNoticePanel(apiError: state)));
    expect(find.textContaining('ENOTFOUND open.bigmodel.cn'), findsOneWidget);
  });
}

/// n 条 pending 暂存消息，下标 1..n 与 entryId 一一对应。
SessionQueueState _pendingQueue(int n) => SessionQueueState.fromEvent({
  'state': 'queued',
  'items': [
    for (var i = 1; i <= n; i++)
      {
        'entryId': 'queued-$i',
        'state': 'pending',
        'position': i,
        'text': '第 $i 条',
      },
  ],
});

/// 按住 [entryId] 那行的拖动手柄，纵向挪 [rows] 行高后松手。ReorderableDrag-
/// StartListener 是立刻起拖的识别器，所以按下就能走；位移要分小步发，因为
/// ReorderableListView 每收到一次位移都按「当前已经让开的位置」重算落点，
/// 一次跳到位只会算出一格。
Future<void> _dragRowDown(
  WidgetTester tester,
  String entryId, {
  required double rows,
}) async {
  final rowKey = ValueKey('queue-row-$entryId');
  final handle = find.byKey(Key('reorder-queued-$entryId'));
  final total = tester.getSize(find.byKey(rowKey)).height * rows;
  final gesture = await tester.startGesture(tester.getCenter(handle));
  await tester.pump(const Duration(milliseconds: 20));
  var moved = 0.0;
  while (moved.abs() < total.abs()) {
    final delta = (total - moved).clamp(-8.0, 8.0);
    await gesture.moveBy(Offset(0, delta));
    moved += delta;
    await tester.pump(const Duration(milliseconds: 16));
  }
  await gesture.up();
  await tester.pumpAndSettle();
}
