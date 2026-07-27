import 'package:flutter_test/flutter_test.dart';

import 'package:multicc_app/models/chat_runtime_state.dart';
import 'package:multicc_app/utils/status_presentation.dart';

void main() {
  test(
    'queue snapshot preserves FIFO order and cancellable pending entries',
    () {
      final state = SessionQueueState.fromEvent({
        'event': 'snapshot',
        'state': 'queued',
        'items': [
          {
            'entryId': 'e-1',
            'state': 'pending',
            'position': 1,
            'text': 'first',
          },
          {
            'entryId': 'e-2',
            'state': 'leased',
            'position': 2,
            'text': 'second',
          },
        ],
      });

      expect(state.runState, CanonicalStatus.queued);
      expect(state.items.map((item) => item.text), ['first', 'second']);
      expect(state.items.first.canCancel, isTrue);
      expect(state.items.last.canCancel, isFalse);
      // 没有 priority 字段的旧快照一律当普通条目，插队按钮照常可用。
      expect(state.items.first.priority, isFalse);
      expect(state.items.first.canInsert, isTrue);
      expect(state.items.last.canInsert, isFalse);
    },
  );

  test('the entry the scheduler already prioritised cannot be inserted again', () {
    final state = SessionQueueState.fromEvent({
      'state': 'queued',
      'items': [
        {
          'entryId': 'e-hot',
          'state': 'pending',
          'position': 1,
          'text': 'jump the line',
          'priority': true,
        },
      ],
    });

    final item = state.items.single;
    expect(item.priority, isTrue);
    // 仍然可以取消，只是不必再插一次队。
    expect(item.canCancel, isTrue);
    expect(item.canInsert, isFalse);
  });

  test('partial queue events retain previous items and map freeze reasons', () {
    final queued = SessionQueueState.fromEvent({
      'state': 'queued',
      'items': [
        {'entryId': 'e-1', 'state': 'pending', 'text': 'keep me'},
      ],
    });
    final waiting = SessionQueueState.fromEvent({
      'event': 'frozen',
      'state': 'frozen',
      'freezeReason': 'awaiting_user_input',
      'active': {'entryId': 'active-1'},
    }, previous: queued);

    expect(waiting.items.single.text, 'keep me');
    expect(waiting.runState, CanonicalStatus.waiting);
    expect(waiting.canResume, isFalse);
    expect(waiting.canSkip, isTrue);
    expect(waiting.canCancelActive, isTrue);

    final interrupted = SessionQueueState.fromEvent({
      'state': 'frozen',
      'freezeReason': 'unknown_interruption',
    }, previous: waiting);
    expect(interrupted.runState, CanonicalStatus.error);
    expect(interrupted.canRetry, isTrue);
    expect(interrupted.canResume, isTrue);
  });

  test('duplicate queue snapshot is idempotent', () {
    final event = {
      'event': 'snapshot',
      'state': 'queued',
      'items': [
        {'entryId': 'e-1', 'state': 'pending', 'position': 1, 'text': 'once'},
      ],
    };
    final first = SessionQueueState.fromEvent(event);
    final duplicate = SessionQueueState.fromEvent(event, previous: first);

    expect(duplicate.items, hasLength(1));
    expect(duplicate.items.single.entryId, 'e-1');
  });

  test('pending input accepts old missing fields without crashing', () {
    final input = PendingUserInput.fromJson({
      'requestId': 'r-1',
      'question': 'Pick',
      'options': ['A', '', 2],
    });

    expect(input, isNotNull);
    expect(input!.options, ['A', '2']);
    expect(input.allowMultiple, isFalse);
    expect(PendingUserInput.fromJson({'question': 'missing id'}), isNull);
  });

  test('structured API error prevents unsafe manual retry', () {
    final partial = ApiErrorPolicyState.fromJson({
      'state': 'failed',
      'category': 'rate_limit',
      'provider': 'claude',
      'safeToRetry': true,
      'partialOutput': true,
    });
    final safe = ApiErrorPolicyState.fromJson({
      'state': 'failed',
      'category': 'transport',
      'provider': 'codex',
      'safeToRetry': true,
      'partialOutput': false,
    });
    final automatic = ApiErrorPolicyState.fromJson({
      'state': 'retry_wait',
      'action': 'retry',
      'retryAt': 2000000000,
    });

    expect(partial?.canManualRetry, isFalse);
    expect(safe?.canManualRetry, isTrue);
    expect(automatic?.isRetryScheduled, isTrue);
    expect(automatic?.retryAtMs, 2000000000000);
  });

  test(
    'usage events normalize seconds, clamp utilization and reject old junk',
    () {
      final value = UsageWindowLimit.fromEvent({
        'rateLimitType': 'weekly',
        'status': 'allowed_warning',
        'utilization': 1.4,
        'resetsAt': 2000000000,
        'provider': 'codex',
      });

      expect(value?.usedPercentage, 100);
      expect(value?.resetsAtMs, 2000000000000);
      expect(value?.matchesCli('codex'), isTrue);
      expect(value?.matchesCli('claude'), isFalse);
      expect(
        UsageWindowLimit.fromEvent({
          'rateLimitType': 'daily',
          'status': 'allowed',
        }),
        isNull,
      );
      expect(
        UsageBalance.fromJson({
          'kind': 'balance',
          'available': false,
        })?.available,
        isFalse,
      );
    },
  );
}
