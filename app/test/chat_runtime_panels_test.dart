import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/models/chat_runtime_state.dart';
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
