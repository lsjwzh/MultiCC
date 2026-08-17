import 'package:flutter_test/flutter_test.dart';
import 'package:multicc_app/models/task_board.dart';

Map<String, dynamic> _run(int index) => {
  'runId': 'run-$index',
  'startedAt': index,
  'executionStatus': index == 7 ? 'succeeded' : 'failed',
  'usageStatus': index == 6 ? 'unobservable' : 'sealed',
  'cleanupState': index == 5 ? 'error' : 'done',
  'taskExecutionSlot': '/chat.html?session=internal-slot-$index',
  'usage': index == 6
      ? {
          'coverage': 'unobservable',
          'hasKnownUsage': false,
          'tokens': null,
          'dimensions': [
            {'providerId': 'provider-6', 'providerName': 'Provider 6'},
          ],
        }
      : {
          'coverage': 'observed',
          'hasKnownUsage': true,
          'tokens': {
            'freshInput': index,
            'cacheRead': 2,
            'cacheWrite': 1,
            'output': 3,
            'reasoning': 1,
            'total': index + 6,
          },
          'dimensions': [
            {
              'providerId': 'provider-$index',
              'providerName': 'Provider $index',
              'model': 'model-$index',
              'observedEvents': 1,
              'freshInput': index,
              'cacheRead': 2,
              'cacheWrite': 1,
              'output': 3,
              'reasoning': 1,
            },
          ],
        },
};

void main() {
  test(
    'task-run messages without a public session target are not linkable',
    () {
      final message = TaskMessage.fromJson({
        'sessionId': null,
        'sessionLabel': '临时执行',
        'taskRunId': 'run-1',
        'messageId': 'result-1',
        'role': 'assistant',
      });
      expect(message.hasSessionTarget, isFalse);
      expect(
        TaskMessage.fromJson({
          'sessionId': 'chat-1',
          'messageId': 'message-1',
          'role': 'assistant',
        }).hasSessionTarget,
        isTrue,
      );
    },
  );

  test('task detail parses newest five TaskRuns and exact provider usage', () {
    final detail = TaskBoardDetail.fromJson({
      'items': const [],
      'recentRuns': [for (var i = 1; i <= 7; i++) _run(i)],
    });

    expect(detail.recentRuns.map((run) => run.runId), [
      'run-7',
      'run-6',
      'run-5',
      'run-4',
      'run-3',
    ]);
    final observed = detail.recentRuns.first;
    expect(observed.executionStatus, 'succeeded');
    expect(observed.usage.totalTokens, 13);
    expect(observed.usage.dimensions.single.providerId, 'provider-7');
    expect(observed.usage.dimensions.single.model, 'model-7');
    expect(observed.usage.dimensions.single.freshInput, 7);
    expect(observed.usage.dimensions.single.output, 3);

    final unknown = detail.recentRuns[1];
    expect(unknown.usageStatus, 'unobservable');
    expect(unknown.usage.hasKnownUsage, isFalse);
    expect(
      unknown.usage.totalTokens,
      isNull,
      reason: 'unobservable usage must not be converted to zero',
    );
    expect(unknown.usage.dimensions.single.providerId, 'provider-6');
  });

  test(
    'task detail accepts aliases and remains compatible when runs are absent',
    () {
      expect(TaskBoardDetail.fromJson({'items': const []}).recentRuns, isEmpty);
      expect(
        TaskBoardDetail.fromJson({
          'items': const [],
          'taskRuns': [_run(2), _run(1)],
        }).recentRuns.map((run) => run.runId),
        ['run-2', 'run-1'],
      );
      expect(
        TaskBoardDetail.fromJson({
          'items': const [],
          'runs': [_run(1)],
        }).recentRuns.single.runId,
        'run-1',
      );
    },
  );

  test('TaskRun parses only the public pending-question contract', () {
    final run = TaskRunSummary.fromJson({
      'runId': 'run-waiting',
      'pendingQuestion': {
        'requestId': 'usrq-1',
        'question': '请选择部署环境',
        'reason': '需要决定目标',
        'options': ['生产', '预发'],
        'allowMultiple': true,
        'createdAt': 123,
        'slotId': 'internal-slot-must-not-exist-on-model',
        'leaseEpoch': 99,
      },
    });
    final question = run.pendingQuestion!;
    expect(question.requestId, 'usrq-1');
    expect(question.question, '请选择部署环境');
    expect(question.reason, '需要决定目标');
    expect(question.options, ['生产', '预发']);
    expect(question.allowMultiple, isTrue);
    expect(question.createdAt, 123);
    expect(
      question.toString(),
      isNot(contains('internal-slot-must-not-exist-on-model')),
    );
  });
}
