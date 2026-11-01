import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:multicc_app/services/remote_pointer_queue.dart';

void main() {
  test(
    'older Agents retain click and drag controls through the legacy API',
    () async {
      final sent = <Map<String, dynamic>>[];
      final queue = RemotePointerQueue((body) async {
        sent.add(body);
        return body['op'] == 'pointer'
            ? {'ok': false, 'error': 'unknown op: pointer'}
            : {'ok': true};
      });
      queue.add(0, 10, 20);
      queue.add(1, 10, 20);
      queue.add(1, 50, 20);
      queue.add(0, 50, 20);
      await queue.drained;
      expect(sent.map((b) => b['op']), ['pointer', 'drag']);
      expect(sent.last['x'], 10);
      expect(sent.last['x2'], 50);
      queue.add(1, 60, 20);
      queue.add(0, 60, 20);
      await queue.drained;
      expect(sent.last['op'], 'click');
    },
  );

  test(
    'moves arrive before lift; slow HTTP preserves edges and latest motion',
    () async {
      final sent = <Map<String, dynamic>>[];
      final first = Completer<void>();
      final queue = RemotePointerQueue((body) async {
        sent.add(body);
        if (sent.length == 1) await first.future;
        return {'ok': true};
      }, viewer: 'test-viewer');
      queue.add(1, 10, 20);
      expect(
        sent.single['mask'],
        1,
      ); // Still holding: the press is already sent.
      queue.add(1, 30, 20);
      queue.add(1, 40, 20);
      queue.add(1, 50, 20);
      queue.add(0, 50, 20);
      first.complete();
      await queue.drained;
      expect(sent.map((e) => [e['mask'], e['x']]), [
        [1, 10],
        [1, 50],
        [0, 50],
      ]);
      expect(sent.every((e) => e['viewer'] == 'test-viewer'), isTrue);
    },
  );

  test(
    'mods ride on the pointer request and on the legacy click / drag',
    () async {
      final sent = <Map<String, dynamic>>[];
      var rejectPointer = false;
      final queue = RemotePointerQueue((body) async {
        sent.add(body);
        return rejectPointer && body['op'] == 'pointer'
            ? {'ok': false, 'error': 'unknown op: pointer'}
            : {'ok': true};
      });
      queue.add(1, 10, 20, mods: const ['shift', 'cmd']);
      queue.add(0, 10, 20, mods: const ['shift', 'cmd']);
      await queue.drained;
      expect(sent.first['mods'], ['shift', 'cmd']);
      expect(sent.last['mods'], ['shift', 'cmd']);

      // 老 Agent 不认 pointer：退回 click/drag 时修饰键也得带过去。
      rejectPointer = true;
      queue.add(1, 30, 20, mods: const ['ctrl']);
      queue.add(1, 60, 20);
      queue.add(0, 60, 20);
      await queue.drained;
      expect(sent.last['op'], 'drag');
      expect(sent.last['mods'], ['ctrl']);
    },
  );
}
