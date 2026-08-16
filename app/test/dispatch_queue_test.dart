import 'package:flutter_test/flutter_test.dart';

import 'package:multicc_app/models/dispatch_queue.dart';

void main() {
  test(
    'fromJson parses the full dispatch projection, ints coerced from num/string',
    () {
      final e = DispatchQueueEntry.fromJson(const {
        'operationId': 'op-1',
        'status': 'registered',
        'terminal': false,
        'relation': 'owner',
        'ownerSessionId': 's-owner',
        'targetSessionId': 's-worker',
        'executionSessionId': 's-worker',
        'taskId': 'task-9',
        'mode': 'sync',
        'queueState': 'queued',
        'queuePosition': 2,
        'queueLength':
            '3', // server sends int, but string must not break parsing
        'createdAt': 1000,
        'updatedAt': 1200,
      });
      expect(e, isNotNull);
      expect(e!.operationId, 'op-1');
      expect(e.relation, 'owner');
      expect(e.mode, 'sync');
      expect(e.queueState, 'queued');
      expect(e.queuePosition, 2);
      expect(e.queueLength, 3);
      expect(e.isQueued, isTrue);
      // Owner dispatch: the counterpart is the worker we sent to.
      expect(e.counterpartId, 's-worker');
    },
  );

  test('target-relation dispatch reads its counterpart from the owner', () {
    final e = DispatchQueueEntry.fromJson(const {
      'operationId': 'op-2',
      'relation': 'target',
      'ownerSessionId': 'commander',
      'targetSessionId': 'me',
      'queueState': 'started',
    });
    expect(e!.counterpartId, 'commander');
    expect(e.isQueued, isFalse);
  });

  test(
    'outgoing navigation prefers execution chat and keeps stable fallback',
    () {
      const entry = DispatchQueueEntry(
        operationId: 'op-nav',
        relation: 'owner',
        executionSessionId: 'worker-gw-chat',
        targetSessionId: 'worker-terminal',
      );
      expect(entry.navigationSessionIds, ['worker-gw-chat', 'worker-terminal']);
      expect(entry.counterpartId, 'worker-gw-chat');
    },
  );

  test(
    'entries without operationId are rejected (never render an anon row)',
    () {
      expect(DispatchQueueEntry.fromJson(const {'status': 'running'}), isNull);
      expect(DispatchQueueEntry.fromJson(const {'operationId': ''}), isNull);
    },
  );

  test(
    'merge dedups, keeps active first, and retains recent terminal rows',
    () {
      final merged = mergeDispatchQueue([
        {
          'operationId': 'op-late',
          'createdAt': 30,
          'queueState': 'queued',
          'queuePosition': 2,
          'queueLength': 2,
        },
        {'operationId': 'op-early', 'createdAt': 10, 'queueState': 'started'},
        // Duplicate row from a flaky proxy replay — must not double-render.
        {'operationId': 'op-late', 'createdAt': 30, 'queueState': 'queued'},
        // Finished dispatches are retained as bounded recent history.
        {
          'operationId': 'op-done',
          'createdAt': 5,
          'terminal': true,
          'queueState': 'terminal',
        },
      ]);
      expect(merged.map((e) => e.operationId).toList(), [
        'op-early',
        'op-late',
        'op-done',
      ]);
      expect(merged[1].queueLength, 2);
      expect(merged.last.terminal, isTrue);
    },
  );

  test('terminal history is ordered by completion freshness', () {
    final merged = mergeDispatchQueue(const [
      {
        'operationId': 'old',
        'terminal': true,
        'status': 'completed',
        'createdAt': 1,
        'completedAt': 10,
      },
      {
        'operationId': 'new',
        'terminal': true,
        'status': 'failed',
        'createdAt': 2,
        'completedAt': 20,
      },
      {
        'operationId': 'active',
        'terminal': false,
        'createdAt': 0,
        'updatedAt': 5,
      },
    ]);
    expect(merged.map((e) => e.operationId).toList(), ['active', 'new', 'old']);
  });

  test('empty snapshot converges to an empty queue (panel hides)', () {
    expect(mergeDispatchQueue(const []), isEmpty);
    // Junk rows only — still empty, never throws.
    expect(
      mergeDispatchQueue(const [
        {'status': 'x'},
      ]),
      isEmpty,
    );
  });
}
