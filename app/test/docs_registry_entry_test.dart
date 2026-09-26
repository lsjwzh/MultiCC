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

    // permanent (永久保留 / never reclaimed) and pinned (置顶 / ordering only)
    // are two independent flags: the server's keep-list reads permanent alone,
    // so the model must never derive one from the other.
    test('permanent and dir parse independently of pinned', () {
      final both = DocsRegistryEntry.fromJson({
        'id': 'doc_p',
        'kind': 'page',
        'title': '报告',
        'url': '/artifacts/art_1/report.html',
        'pinned': true,
        'permanent': true,
        'dir': '/Users/me/proj',
      });
      expect(both.pinned, isTrue);
      expect(both.permanent, isTrue);
      expect(both.dir, '/Users/me/proj');
      expect(both.dirName, 'proj');

      // 只有永久保留、没有置顶：反过来也必须成立。
      final permanentOnly = DocsRegistryEntry.fromJson({
        'id': 'doc_q',
        'kind': 'file',
        'title': 'f',
        'url': '/artifacts/art_2/f.csv',
        'permanent': true,
      });
      expect(permanentOnly.permanent, isTrue);
      expect(permanentOnly.pinned, isFalse);
    });

    test('permanent and dir default to off/empty when absent', () {
      final e = DocsRegistryEntry.fromJson({
        'id': 'doc_x',
        'kind': 'page',
        'title': 't',
        'url': '/x',
      });
      expect(e.permanent, isFalse);
      expect(e.dir, '');
      expect(e.dirName, '');
    });

    test('dirName is the basename of an absolute path', () {
      expect(DocsRegistryEntry.basename('/Users/me/proj'), 'proj');
      expect(DocsRegistryEntry.basename('/Users/me/proj/'), 'proj');
      expect(DocsRegistryEntry.basename('proj'), 'proj');
      // 没有名字的边角值（'' 就是「未归属目录」，'/' 是 normalizeDir 的兜底）。
      expect(DocsRegistryEntry.basename(''), '');
      expect(DocsRegistryEntry.basename('/'), '');
    });

    test('toJson carries permanent and dir through a round trip', () {
      final out = DocsRegistryEntry.fromJson({
        'id': 'doc_r',
        'kind': 'page',
        'title': 't',
        'url': '/x',
        'permanent': true,
        'dir': '/Users/me/proj',
      }).toJson();
      expect(out['permanent'], isTrue);
      expect(out['dir'], '/Users/me/proj');
      final back = DocsRegistryEntry.fromJson(out);
      expect(back.permanent, isTrue);
      expect(back.dir, '/Users/me/proj');
      expect(back.dirName, 'proj');
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
