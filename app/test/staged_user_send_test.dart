import 'package:flutter_test/flutter_test.dart';

import 'package:multicc_app/providers/chat_provider.dart';

StagedUserSend _send(String id, {String? entryId}) {
  final s = StagedUserSend(id, 'text-$id');
  s.entryId = entryId;
  return s;
}

void main() {
  group('resolveStagedQueueEvent', () {
    test('immediate admit (queued=false) commits the oldest unbound staged send', () {
      final staged = [_send('app-1'), _send('app-2')];
      final verdict = resolveStagedQueueEvent(staged, 'queued', {
        'event': 'queued',
        'queued': false,
        'entryId': 'entry-1',
      });

      expect(verdict.target?.clientMsgId, 'app-1');
      expect(verdict.resolution, StagedResolution.commit);
      expect(verdict.bindEntryId, 'entry-1');
    });

    test('a queued admit (queued=true) keeps the bubble staged and binds its entryId', () {
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
    });

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
      final staged = [_send('app-1', entryId: 'entry-a'), _send('app-2', entryId: 'entry-b')];
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

    test('started / cancelled with an unknown entryId leave staged sends untouched', () {
      final staged = [_send('app-1', entryId: 'entry-a')];

      var verdict = resolveStagedQueueEvent(staged, 'started', {'entryId': 'entry-other'});
      expect(verdict.target, isNull);
      expect(verdict.resolution, StagedResolution.keep);

      verdict = resolveStagedQueueEvent(staged, 'queued_cancelled', {'entryId': 'entry-other'});
      expect(verdict.target, isNull);
      expect(verdict.resolution, StagedResolution.keep);
    });

    test('snapshot and other events never touch staged sends', () {
      final staged = [_send('app-1')];
      for (final event in ['snapshot', 'frozen', 'assessing', 'weird']) {
        final verdict = resolveStagedQueueEvent(staged, event, {'entryId': 'x'});
        expect(verdict.resolution, StagedResolution.keep);
        expect(verdict.target, isNull);
      }
    });
  });
}
