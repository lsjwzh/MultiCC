import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:multicc_app/models/task_board.dart';
import 'package:multicc_app/theme.dart';
import 'package:multicc_app/widgets/task_run_summary_list.dart';

TaskRunSummary _observed(String id, int startedAt) => TaskRunSummary(
  runId: id,
  executionStatus: 'succeeded',
  usageStatus: 'sealed',
  cleanupState: 'done',
  startedAt: startedAt,
  usage: const TaskRunUsage(
    coverage: 'observed',
    hasKnownUsage: true,
    freshInput: 10,
    cacheRead: 20,
    cacheWrite: 3,
    output: 4,
    reasoning: 2,
    totalTokens: 37,
    dimensions: [
      TaskRunUsageDimension(
        providerId: 'provider-a',
        providerName: 'Provider A',
        model: 'model-a',
        observedEvents: 1,
        freshInput: 10,
        cacheRead: 20,
        cacheWrite: 3,
        output: 4,
        reasoning: 2,
      ),
      TaskRunUsageDimension(
        providerId: 'provider-main-unknown',
        providerName: 'Main Provider',
        model: 'main-model',
        unobservableEvents: 1,
      ),
    ],
  ),
);

void main() {
  testWidgets('TaskRun list shows exact usage, unknown, and pending cleanup', (
    tester,
  ) async {
    final unknown = TaskRunSummary.fromJson({
      'runId': 'run-unknown',
      'startedAt': 2,
      'executionStatus': 'failed',
      'usageStatus': 'unobservable',
      'cleanupState': 'done',
      'taskExecutionSlot': 'internal-slot-must-not-render',
      'usage': {
        'coverage': 'unobservable',
        'hasKnownUsage': false,
        'tokens': null,
        'dimensions': const [
          {
            'providerId': 'provider-unknown',
            'providerName': 'Provider Unknown',
            'model': 'opaque-model',
          },
        ],
      },
    });
    final cleanupError = TaskRunSummary(
      runId: 'run-cleanup',
      executionStatus: 'succeeded',
      usageStatus: 'sealed',
      cleanupState: 'error',
      startedAt: 1,
      usage: const TaskRunUsage(
        coverage: 'observed',
        hasKnownUsage: true,
        freshInput: 1,
        output: 1,
        totalTokens: 2,
      ),
    );

    await tester.pumpWidget(
      MaterialApp(
        theme: buildAppTheme(),
        home: Scaffold(
          body: TaskRunSummaryList(
            runs: [_observed('run-observed', 3), unknown, cleanupError],
          ),
        ),
      ),
    );

    expect(find.text('最近执行'), findsOneWidget);
    expect(find.text('37 tokens'), findsOneWidget);
    expect(find.text('Provider A · model-a'), findsOneWidget);
    expect(find.textContaining('输入 10'), findsOneWidget);
    expect(find.text('Main Provider · main-model'), findsOneWidget);
    expect(find.text('Provider Unknown · opaque-model'), findsOneWidget);
    expect(find.text('未观测'), findsNWidgets(3));
    expect(find.textContaining('输入 0'), findsNothing);
    expect(find.text('待清理'), findsOneWidget);
    expect(find.textContaining('internal-slot-must-not-render'), findsNothing);
    expect(
      find.byType(TextButton),
      findsNothing,
      reason: 'internal TaskRun slots must not expose a chat jump action',
    );
  });

  testWidgets('TaskRun list sorts newest first and renders at most five', (
    tester,
  ) async {
    final runs = [for (var i = 1; i <= 7; i++) _observed('run-$i', i)];
    await tester.pumpWidget(
      MaterialApp(
        theme: buildAppTheme(),
        home: Scaffold(body: TaskRunSummaryList(runs: runs)),
      ),
    );

    expect(
      find.byKey(const ValueKey('task-run-summary-run-7')),
      findsOneWidget,
    );
    expect(
      find.byKey(const ValueKey('task-run-summary-run-3')),
      findsOneWidget,
    );
    expect(find.byKey(const ValueKey('task-run-summary-run-2')), findsNothing);
    expect(find.byKey(const ValueKey('task-run-summary-run-1')), findsNothing);
  });

  testWidgets('TaskRun waiting question answers in place without a chat jump', (
    tester,
  ) async {
    final waiting = TaskRunSummary.fromJson({
      'runId': 'run-waiting',
      'startedAt': 10,
      'executionStatus': 'running',
      'usageStatus': 'collecting',
      'cleanupState': 'blocked',
      'slotId': 'internal-slot-must-not-render',
      'pendingQuestion': {
        'requestId': 'usrq-widget-1',
        'question': '请选择部署环境',
        'reason': '决定发布目标',
        'options': ['生产', '预发'],
        'allowMultiple': false,
        'createdAt': 11,
      },
    });
    final answers = <Map<String, String>>[];
    await tester.pumpWidget(
      MaterialApp(
        theme: buildAppTheme(),
        home: Scaffold(
          body: TaskRunSummaryList(
            runs: [waiting],
            onAnswer: (run, question, text, clientMsgId) async {
              answers.add({
                'runId': run.runId,
                'requestId': question.requestId,
                'text': text,
                'clientMsgId': clientMsgId,
              });
            },
          ),
        ),
      ),
    );

    expect(find.text('请选择部署环境'), findsOneWidget);
    expect(find.text('决定发布目标'), findsOneWidget);
    expect(find.textContaining('internal-slot-must-not-render'), findsNothing);
    expect(find.byType(TextButton), findsNothing);
    await tester.tap(find.byKey(const Key('task-run-answer-option-生产')));
    await tester.pumpAndSettle();
    expect(answers, hasLength(1));
    expect(answers.single['runId'], 'run-waiting');
    expect(answers.single['requestId'], 'usrq-widget-1');
    expect(answers.single['text'], '生产');
    expect(answers.single['clientMsgId'], startsWith('tb-answer-'));
    expect(find.text('回答已发送'), findsOneWidget);
  });
}
