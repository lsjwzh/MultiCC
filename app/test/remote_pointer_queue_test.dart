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
    'rapid consecutive drags retain both press origins and releases',
    () async {
      final sent = <Map<String, dynamic>>[];
      final first = Completer<void>();
      final queue = RemotePointerQueue((body) async {
        sent.add(body);
        if (sent.length == 1) await first.future;
        return {'ok': true};
      });
      queue.add(0, 0, 0);
      queue.add(1, 10, 0);
      queue.add(1, 20, 0);
      queue.add(0, 20, 0);
      queue.add(1, 30, 0);
      queue.add(1, 40, 0);
      queue.add(0, 40, 0);
      first.complete();
      await queue.drained;
      expect(sent.map((e) => [e['mask'], e['x']]), [
        [0, 0],
        [1, 10],
        [1, 20],
        [0, 20],
        [1, 30],
        [1, 40],
        [0, 40],
      ]);
    },
  );
}
