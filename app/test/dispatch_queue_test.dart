import 'package:flutter_test/flutter_test.dart';

import 'package:multicc_app/models/dispatch_queue.dart';

void main() {
  test('fromJson parses the full dispatch projection, ints coerced from num/string', () {
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
      'queueLength': '3', // server sends int, but string must not break parsing
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
  });

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

  test('entries without operationId are rejected (never render an anon row)', () {
    expect(DispatchQueueEntry.fromJson(const {'status': 'running'}), isNull);
    expect(DispatchQueueEntry.fromJson(const {'operationId': ''}), isNull);
  });

  test('merge dedups by operationId, orders by createdAt, drops terminal rows', () {
    final merged = mergeDispatchQueue([
      {
        'operationId': 'op-late',
        'createdAt': 30,
        'queueState': 'queued',
        'queuePosition': 2,
        'queueLength': 2,
      },
      {
        'operationId': 'op-early',
        'createdAt': 10,
        'queueState': 'started',
      },
      // Duplicate row from a flaky proxy replay — must not double-render.
      {
        'operationId': 'op-late',
        'createdAt': 30,
        'queueState': 'queued',
      },
      // Finished dispatch still present in the server's active list:
      // must converge away client-side so the panel can't wedge forever.
      {
        'operationId': 'op-done',
        'createdAt': 5,
        'terminal': true,
        'queueState': 'terminal',
      },
    ]);
    expect(merged.map((e) => e.operationId).toList(), ['op-early', 'op-late']);
    expect(merged.last.queueLength, 2);
  });

  test('empty snapshot converges to an empty queue (panel hides)', () {
    expect(mergeDispatchQueue(const []), isEmpty);
    // Junk rows only — still empty, never throws.
    expect(mergeDispatchQueue(const [{'status': 'x'}]), isEmpty);
  });
}
