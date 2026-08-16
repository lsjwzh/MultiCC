import 'package:flutter_test/flutter_test.dart';

import 'package:multicc_app/models/chat_runtime_state.dart';
import 'package:multicc_app/providers/chat_provider.dart';

/// 回归：insert_queued 的 HTTP 响应曾把 pre-tick 旧 schedule 无条件套在
/// WS 新状态之上，「立刻插入」点击成功后 App 仍显示旧 FIFO 条目、刷新才消失。
/// 服务端已改为 post-tick 刷新响应 schedule；App 侧再用本地因果序守卫
/// （applyActionSchedule）兜住整个动作族（cancel_queued / resolve 同类时序）。
void main() {
  group('applyActionSchedule', () {
    test('stale pre-tick response must not resurrect a WS-removed entry', () {
      // WS started 事件先落地：e1 已离开 FIFO（items 空、active 指向它）。
      final current = SessionQueueState.fromEvent({
        'event': 'started',
        'state': 'running',
        'items': <dynamic>[],
        'active': <String, dynamic>{'entryId': 'e1'},
      });
      // HTTP 响应携带 mutate 时的旧快照：e1 仍列为 queued/pending。
      final stale = <String, dynamic>{
        'state': 'queued',
        'queued': <dynamic>[
          <String, dynamic>{
            'entryId': 'e1',
            'state': 'pending',
            'position': 1,
            'text': 'hello',
            'priority': true,
          },
        ],
      };
      // 请求期间 WS 事件计数 0→1：旧 schedule 不得覆盖。
      expect(
        applyActionSchedule(current, stale, 0, 1),
        isNull,
        reason: 'a WS event that landed during the request supersedes the '
            'HTTP schedule; applying it would resurrect the FIFO entry',
      );
    });

    test('no WS interleaving: response applies and the claimed entry vanishes immediately', () {
      // 点击前：e1 在 FIFO 里 pending（queued_inserted 后的 WS 状态）。
      final current = SessionQueueState.fromEvent({
        'event': 'queued_inserted',
        'state': 'queued',
        'items': <dynamic>[
          <String, dynamic>{
            'entryId': 'e1',
            'state': 'pending',
            'position': 1,
            'text': 'hello',
            'priority': true,
          },
        ],
      });
      // 服务端 post-tick 刷新后的权威 schedule：e1 已认领 → active，FIFO 空。
      final fresh = <String, dynamic>{
        'state': 'running',
        'queued': <dynamic>[],
        'active': <String, dynamic>{'entryId': 'e1'},
      };
      final next = applyActionSchedule(current, fresh, 0, 0);
      expect(next, isNotNull, reason: 'offline/no-WS fallback must still apply');
      expect(
        next!.items.where((item) => item.entryId == 'e1'),
        isEmpty,
        reason: 'the inserted entry must leave the FIFO without a refresh',
      );
      expect(next.active?['entryId'], 'e1');
      expect(next.state, 'running');
    });

    test('a second action response still applies after an earlier unrelated WS event', () {
      // 计数在“本次请求发起前”就已是 1（老事件），请求期间无新事件 → 照常应用。
      final current = SessionQueueState.fromEvent({
        'event': 'queued_inserted',
        'state': 'queued',
        'items': <dynamic>[],
      });
      final fresh = <String, dynamic>{
        'state': 'idle',
        'queued': <dynamic>[],
        'active': null,
      };
      expect(applyActionSchedule(current, fresh, 1, 1), isNotNull);
    });
  });
}
