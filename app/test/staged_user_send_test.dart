import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:multicc_app/providers/chat_provider.dart';

StagedUserSend _send(String id, {String? entryId}) {
  final s = StagedUserSend(id, 'text-$id');
  s.entryId = entryId;
  return s;
}

void main() {
  group('resolveStagedQueueEvent', () {
    test(
      'immediate admit (queued=false) commits the oldest unbound staged send',
      () {
        final staged = [_send('app-1'), _send('app-2')];
        final verdict = resolveStagedQueueEvent(staged, 'queued', {
          'event': 'queued',
          'queued': false,
          'entryId': 'entry-1',
        });

        expect(verdict.target?.clientMsgId, 'app-1');
        expect(verdict.resolution, StagedResolution.commit);
        expect(verdict.bindEntryId, 'entry-1');
      },
    );

    test(
      'a queued admit (queued=true) keeps the bubble staged and binds its entryId',
      () {
        // 这正是 App-4 的核心：进了 FIFO 的消息不显示气泡，只在队列面板出现。
        final staged = [_send('app-1')];
        final verdict = resolveStagedQueueEvent(staged, 'queued', {
          'event': 'queued',
          'queued': true,
          'entryId': 'entry-1',
          'queuePosition': 2,
        });

        expect(verdict.target?.clientMsgId, 'app-1');
        expect(verdict.resolution, StagedResolution.keep);
        expect(verdict.bindEntryId, 'entry-1');
      },
    );

    test('admit verdicts bind to staged sends in FIFO send order', () {
      // 两条消息先后发送、先后进队列：第一个 admit 绑第一条，第二个绑第二条。
      final staged = [_send('app-1'), _send('app-2')];
      var v = resolveStagedQueueEvent(staged, 'queued', {
        'queued': true,
        'entryId': 'entry-a',
      });
      expect(v.target?.clientMsgId, 'app-1');
      expect(v.bindEntryId, 'entry-a');

      // 模拟 provider 回填 entryId 后，第二条仍未绑定。
      staged[0].entryId = 'entry-a';
      v = resolveStagedQueueEvent(staged, 'queued', {
        'queued': true,
        'entryId': 'entry-b',
      });
      expect(v.target?.clientMsgId, 'app-2');
      expect(v.bindEntryId, 'entry-b');
    });

    test('started commits the staged send whose entryId matches', () {
      final staged = [
        _send('app-1', entryId: 'entry-a'),
        _send('app-2', entryId: 'entry-b'),
      ];
      final verdict = resolveStagedQueueEvent(staged, 'started', {
        'entryId': 'entry-b',
      });

      expect(verdict.target?.clientMsgId, 'app-2');
      expect(verdict.resolution, StagedResolution.commit);
      expect(verdict.bindEntryId, isNull);
    });

    test('queued_cancelled discards the matching staged send', () {
      // 用户在队列面板取消：这条消息既不执行也不显示，直接丢弃暂存。
      final staged = [_send('app-1', entryId: 'entry-a')];
      final verdict = resolveStagedQueueEvent(staged, 'queued_cancelled', {
        'entryId': 'entry-a',
      });

      expect(verdict.target?.clientMsgId, 'app-1');
      expect(verdict.resolution, StagedResolution.discard);
    });

    test(
      'started / cancelled with an unknown entryId leave staged sends untouched',
      () {
        final staged = [_send('app-1', entryId: 'entry-a')];

        var verdict = resolveStagedQueueEvent(staged, 'started', {
          'entryId': 'entry-other',
        });
        expect(verdict.target, isNull);
        expect(verdict.resolution, StagedResolution.keep);

        verdict = resolveStagedQueueEvent(staged, 'queued_cancelled', {
          'entryId': 'entry-other',
        });
        expect(verdict.target, isNull);
        expect(verdict.resolution, StagedResolution.keep);
      },
    );

    test('snapshot and other events never touch staged sends', () {
      final staged = [_send('app-1')];
      for (final event in ['snapshot', 'frozen', 'assessing', 'weird']) {
        final verdict = resolveStagedQueueEvent(staged, event, {
          'entryId': 'x',
        });
        expect(verdict.resolution, StagedResolution.keep);
        expect(verdict.target, isNull);
      }
    });

    test(
      'a replayed queued event (same entryId) never re-binds another staged send',
      () {
        // 重放幂等：entry-a 已绑 app-1，重复的 queued 事件不能绑到 app-2 上。
        final staged = [_send('app-1', entryId: 'entry-a'), _send('app-2')];
        final verdict = resolveStagedQueueEvent(staged, 'queued', {
          'queued': true,
          'entryId': 'entry-a',
        });
        expect(verdict.target, isNull);
        expect(verdict.resolution, StagedResolution.keep);
      },
    );
  });

  group('StagedSendTracker (FIFO verdict timing semantics)', () {
    // 每个用例都跑在 FakeAsync 里：真实 Timer 被接管，可以精确推过 4 秒兜底。
    StagedSendTracker _tracker(List<String> committed) =>
        StagedSendTracker(onCommit: (s) => committed.add(s.clientMsgId));

    test(
      'queued:true cancels the fallback — no bubble even after 10s (the bug)',
      () {
        fakeAsync((async) {
          final committed = <String>[];
          final t = _tracker(committed);
          t.stage('app-1', 'hello');
          t.reconcile('queued', {'queued': true, 'entryId': 'entry-a'});
          async.elapse(const Duration(seconds: 10));
          // 修复点：权威 queued 裁决后，兜底定时器绝不能把队列消息画进对话区。
          expect(committed, isEmpty);
          // 仍在等 started，且已封死。
          expect(t.pending.single.clientMsgId, 'app-1');
          expect(t.pending.single.entryId, 'entry-a');
          expect(t.pending.single.queuedVerdict, isTrue);
          expect(t.pending.single.fallbackTimer, isNull);
        });
      },
    );

    test(
      'queued:false commits immediately, without waiting for the fallback',
      () {
        fakeAsync((async) {
          final committed = <String>[];
          final t = _tracker(committed);
          t.stage('app-1', 'run now');
          t.reconcile('queued', {'queued': false, 'entryId': 'entry-1'});
          expect(committed, ['app-1']);
          expect(t.pending, isEmpty);
          async.elapse(const Duration(seconds: 10));
          expect(committed, ['app-1']); // 不重复
        });
      },
    );

    test(
      'pre-FIFO admission progress commits the exact client message once',
      () {
        fakeAsync((async) {
          final committed = <String>[];
          final t = _tracker(committed);
          t.stage('app-1', 'first');
          t.stage('app-2', 'second');
          expect(t.commitByClientMsgId('app-2'), isTrue);
          expect(t.commitByClientMsgId('app-2'), isFalse);
          expect(committed, ['app-2']);
          expect(t.pending.single.clientMsgId, 'app-1');
          async.elapse(const Duration(seconds: 10));
          expect(committed, ['app-2', 'app-1']);
        });
      },
    );

    test(
      'a later scheduler event cannot cross-bind after early progress commit',
      () {
        fakeAsync((async) {
          final committed = <String>[];
          final t = _tracker(committed);
          t.stage('app-1', 'first');
          t.stage('app-2', 'second');
          expect(t.commitByClientMsgId('app-1'), isTrue);
          t.reconcile('queued', {
            'queued': true,
            'entryId': 'entry-a',
            'clientMsgId': 'app-1',
          });
          expect(t.pending.single.clientMsgId, 'app-2');
          expect(t.pending.single.entryId, isNull);
          t.reconcile('queued', {
            'queued': true,
            'entryId': 'entry-b',
            'clientMsgId': 'app-2',
          });
          expect(t.pending.single.entryId, 'entry-b');
        });
      },
    );

    test(
      'queued:true → started commits exactly once; duplicate started is a no-op',
      () {
        fakeAsync((async) {
          final committed = <String>[];
          final t = _tracker(committed);
          t.stage('app-1', 'queued msg');
          t.reconcile('queued', {'queued': true, 'entryId': 'entry-a'});
          async.elapse(const Duration(seconds: 10)); // 兜底窗口早已超时
          expect(committed, isEmpty);
          t.reconcile('started', {'entryId': 'entry-a'});
          expect(committed, ['app-1']); // 此时且仅此时回填
          t.reconcile('started', {'entryId': 'entry-a'}); // WS 重放
          t.reconcile('claimed', {'entryId': 'entry-a'});
          expect(committed, ['app-1']);
          expect(t.pending, isEmpty);
        });
      },
    );

    test('queued:true → queued_cancelled never enters the transcript', () {
      fakeAsync((async) {
        final committed = <String>[];
        final t = _tracker(committed);
        t.stage('app-1', 'cancelled msg');
        t.reconcile('queued', {'queued': true, 'entryId': 'entry-a'});
        t.reconcile('queued_cancelled', {'entryId': 'entry-a'});
        expect(t.pending, isEmpty);
        async.elapse(const Duration(seconds: 10));
        expect(committed, isEmpty);
      });
    });

    test(
      'with no verdict at all, the original disconnect fallback still commits',
      () {
        fakeAsync((async) {
          final committed = <String>[];
          final t = _tracker(committed);
          t.stage('app-1', 'lost socket');
          async.elapse(const Duration(milliseconds: 3900));
          expect(committed, isEmpty); // 兜底窗口内
          async.elapse(const Duration(milliseconds: 200));
          expect(committed, ['app-1']); // 4s 到点乐观显示
        });
      },
    );

    test('two sends — first queued, second immediate — never cross-bind', () {
      fakeAsync((async) {
        final committed = <String>[];
        final t = _tracker(committed);
        t.stage('app-1', 'first (will queue)');
        t.stage('app-2', 'second (immediate)');
        t.reconcile('queued', {
          'queued': true,
          'entryId': 'entry-a',
        }); // → app-1 隐藏
        t.reconcile('queued', {
          'queued': false,
          'entryId': 'entry-b',
        }); // → app-2 立即
        expect(committed, ['app-2']);
        t.reconcile('started', {'entryId': 'entry-a'}); // app-1 开始执行
        expect(committed, ['app-2', 'app-1']);
        expect(t.pending, isEmpty);
        async.elapse(const Duration(seconds: 10));
        expect(committed, ['app-2', 'app-1']); // 无兜底复画
      });
    });

    test(
      'a replayed queued verdict for a bound entryId never binds the next staged send',
      () {
        fakeAsync((async) {
          final committed = <String>[];
          final t = _tracker(committed);
          t.stage('app-1', 'one');
          t.stage('app-2', 'two');
          t.reconcile('queued', {
            'queued': true,
            'entryId': 'entry-a',
          }); // 绑 app-1
          t.reconcile('queued', {'queued': true, 'entryId': 'entry-a'}); // 重放
          expect(t.pending[1].entryId, isNull); // app-2 未被串绑
          t.reconcile('queued', {'queued': true, 'entryId': 'entry-b'}); // 真裁决
          expect(t.pending[1].entryId, 'entry-b');
          t.reconcile('started', {'entryId': 'entry-b'});
          expect(committed, ['app-2']);
        });
      },
    );

    test(
      'clear() cancels every fallback timer (dispose / authoritative rebuild)',
      () {
        fakeAsync((async) {
          final committed = <String>[];
          final t = _tracker(committed);
          t.stage('app-1', 'a');
          t.stage('app-2', 'b');
          t.clear();
          expect(t.pending, isEmpty);
          async.elapse(const Duration(seconds: 10));
          expect(committed, isEmpty);
        });
      },
    );
  });

  test(
    'admission progress maps every server state to a stable localized key',
    () {
      expect(
        admissionProgressI18nKey({'state': 'waiting'}),
        'admissionMemoryWaiting',
      );
      expect(
        admissionProgressI18nKey({'state': 'ready'}),
        'admissionMemoryReady',
      );
      expect(
        admissionProgressI18nKey({
          'state': 'skipped',
          'reason': 'memory_distill_failed',
        }),
        'admissionMemoryFailed',
      );
      expect(
        admissionProgressI18nKey({'state': 'skipped'}),
        'admissionMemorySkipped',
      );
      expect(admissionProgressI18nKey({'state': 'failed'}), isNull);
    },
  );

  test('admission progress exposes only a bounded single-line safe detail', () {
    expect(
      admissionProgressDetail({'rootCause': 'HTTP 502\nBad Gateway'}),
      'HTTP 502 Bad Gateway',
    );
    expect(
      admissionProgressDetail({'code': 'scheduler_not_ready'}),
      'scheduler_not_ready',
    );
    expect(admissionProgressDetail({'rootCause': '   '}), isNull);
    expect(
      admissionProgressDetail({
        'rootCause': List.filled(300, 'x').join(),
      })!.length,
      240,
    );
  });
}
