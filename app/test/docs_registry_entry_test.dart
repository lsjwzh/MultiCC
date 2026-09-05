import 'package:flutter_test/flutter_test.dart';

import 'package:multicc_app/models/docs_registry_entry.dart';

void main() {
  group('DocsRegistryEntry.fromJson', () {
    test('parses a full service row', () {
      final e = DocsRegistryEntry.fromJson({
        'id': 'doc_ab12cd34',
        'kind': 'service',
        'title': 'vite dev server',
        'url': 'http://127.0.0.1:5173/',
        'source': 'user',
        'pinned': true,
        'createdAt': '2026-09-01T08:00:00.000Z',
        'port': 5173,
        'startCmd': 'npm run dev',
        'cwd': '/tmp/project',
        'status': 'up',
        'pid': 4242,
      });
      expect(e.id, 'doc_ab12cd34');
      expect(e.kind, 'service');
      expect(e.isService, isTrue);
      expect(e.url, 'http://127.0.0.1:5173/');
      expect(e.pinned, isTrue);
      expect(e.expired, isFalse); // absent → false
      expect(e.port, 5173);
      expect(e.startCmd, 'npm run dev');
      expect(e.status, 'up');
      expect(e.pid, 4242);
    });

    test('parses an agent-published artifact page with lenient defaults', () {
      final e = DocsRegistryEntry.fromJson({
        'id': 'doc_x',
        'kind': 'page',
        'title': '预览报告',
        'url': '/artifacts/art_20260901/report.html',
        'sessionId': 'chat-01',
        'source': 'agent',
        'createdAt': '2026-09-01T08:00:00.000Z',
        'expired': true,
      });
      expect(e.isService, isFalse);
      expect(e.expired, isTrue);
      expect(e.sessionId, 'chat-01');
      expect(e.port, isNull);
      expect(e.status, isNull);
      expect(e.canStop, isFalse);
      expect(e.canStart, isFalse);
    });

    test('service lifecycle predicates follow the manage-panel semantics', () {
      // canStop only while the server reports a live pid (up/starting).
      DocsRegistryEntry svc(String? status, [String? startCmd]) =>
          DocsRegistryEntry.fromJson({
            'id': 's',
            'kind': 'service',
            'title': 's',
            'url': 'http://127.0.0.1:9/',
            'status': status,
            if (startCmd != null) 'startCmd': startCmd,
          });
      expect(svc('up').canStop, isTrue);
      expect(svc('starting').canStop, isTrue);
      expect(svc('down').canStop, isFalse);
      expect(svc(null).canStop, isFalse);
      // canStart needs a registered startCmd.
      expect(svc('down', 'python3 server.py').canStart, isTrue);
      expect(svc('down', '').canStart, isFalse);
      expect(svc('down').canStart, isFalse);
    });

    test('numeric fields tolerate string payloads', () {
      final e = DocsRegistryEntry.fromJson({
        'id': 's',
        'kind': 'service',
        'title': 's',
        'url': 'http://127.0.0.1:9/',
        'port': '8770',
        'pid': 'not-a-number',
      });
      expect(e.port, 8770);
      expect(e.pid, isNull);
    });

    test('toJson round-trips optional fields without nulls', () {
      final src = {
        'id': 'doc_r',
        'kind': 'service',
        'title': 'svc',
        'url': 'http://127.0.0.1:8770/',
        'status': 'down',
        'startCmd': 'python3 server.py',
      };
      final out = DocsRegistryEntry.fromJson(src).toJson();
      expect(out['id'], 'doc_r');
      expect(out['status'], 'down');
      expect(out.containsKey('port'), isFalse);
      expect(out.containsKey('cwd'), isFalse);
      expect(out.containsKey('pid'), isFalse);
      final back = DocsRegistryEntry.fromJson(out);
      expect(back.startCmd, 'python3 server.py');
      expect(back.status, 'down');
    });
  });
}
