import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:multicc_app/services/manage_service.dart';
import 'package:multicc_app/services/settings_service.dart';

// 服务与文档 registry wire contract — mirrors src/docs-registry.js routes:
// GET/POST /api/docs-registry, PATCH/DELETE /api/docs-registry/:id,
// POST :id/start|stop, GET :id/log (text/plain).

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  Future<SettingsService> mockSettings() async {
    SharedPreferences.setMockInitialValues({
      'multicc_host': 'http://server.example',
      'multicc_token': 'secret',
    });
    return SettingsService.getInstance();
  }

  http.Response jsonResponse(int status, Object body) => http.Response(
    jsonEncode(body),
    status,
    headers: {'content-type': 'application/json'},
  );

  test('fetchDocsRegistry GETs the list and parses entries', () async {
    final settings = await mockSettings();
    late http.Request captured;
    final svc = ManageService(
      settings: settings,
      httpClient: MockClient((request) async {
        captured = request;
        return jsonResponse(200, [
          {
            'id': 'doc_1',
            'kind': 'service',
            'title': 'vite',
            'url': 'http://127.0.0.1:5173/',
            'status': 'up',
            'startCmd': 'npm run dev',
            'createdAt': '2026-09-01T00:00:00.000Z',
          },
          'not-an-object',
          {
            'id': 'doc_2',
            'kind': 'page',
            'title': '报告',
            'url': '/artifacts/x/r.html',
            'createdAt': '2026-08-31T00:00:00.000Z',
          },
        ]);
      }),
    );

    final entries = await svc.fetchDocsRegistry();

    expect(captured.method, 'GET');
    expect(captured.url.path, '/api/docs-registry');
    expect(captured.headers['x-access-token'], 'secret');
    // Non-object rows are skipped instead of blowing up the whole list.
    expect(entries.length, 2);
    expect(entries.first.status, 'up');
    expect(entries.last.kind, 'page');
  });

  test('registerDocsService posts kind=service source=user, drops blank fields',
      () async {
    final settings = await mockSettings();
    late http.Request captured;
    final svc = ManageService(
      settings: settings,
      httpClient: MockClient((request) async {
        captured = request;
        return jsonResponse(201, {
          'id': 'doc_new',
          'kind': 'service',
          'title': 'dev',
          'url': 'http://127.0.0.1:8770/',
          'source': 'user',
        });
      }),
    );

    final e = await svc.registerDocsService(
      title: 'dev',
      url: 'http://127.0.0.1:8770/',
      startCmd: '  python3 server.py  ',
      cwd: '   ',
    );

    expect(captured.method, 'POST');
    expect(captured.url.path, '/api/docs-registry');
    final body = jsonDecode(captured.body) as Map<String, dynamic>;
    expect(body['kind'], 'service');
    expect(body['source'], 'user');
    expect(body['startCmd'], 'python3 server.py'); // trimmed
    expect(body.containsKey('cwd'), isFalse); // blank → omitted
    expect(e.id, 'doc_new');
  });

  test('updateDocsEntry PATCHes only the provided fields', () async {
    final settings = await mockSettings();
    late http.Request captured;
    final svc = ManageService(
      settings: settings,
      httpClient: MockClient((request) async {
        captured = request;
        return jsonResponse(200, {
          'id': 'doc_1',
          'kind': 'page',
          'title': 't',
          'url': '/artifacts/x/r.html',
          'pinned': false,
        });
      }),
    );

    await svc.updateDocsEntry('doc/1', pinned: false);

    expect(captured.method, 'PATCH');
    expect(captured.url.path, '/api/docs-registry/doc%2F1'); // id encoded
    final body = jsonDecode(captured.body) as Map<String, dynamic>;
    expect(body.keys, ['pinned']);
  });

  test('deleteDocsEntry sends DELETE to the encoded id', () async {
    final settings = await mockSettings();
    late http.Request captured;
    final svc = ManageService(
      settings: settings,
      httpClient: MockClient((request) async {
        captured = request;
        return jsonResponse(200, {'ok': true});
      }),
    );

    await svc.deleteDocsEntry('doc_1');

    expect(captured.method, 'DELETE');
    expect(captured.url.path, '/api/docs-registry/doc_1');
  });

  test('start/stopDocsService POST the lifecycle routes', () async {
    final settings = await mockSettings();
    final calls = <String>[];
    final svc = ManageService(
      settings: settings,
      httpClient: MockClient((request) async {
        calls.add('${request.method} ${request.url.path}');
        return jsonResponse(200, {
          'id': 'doc_1',
          'kind': 'service',
          'title': 't',
          'url': 'http://127.0.0.1:9/',
          'status': 'starting',
        });
      }),
    );

    final started = await svc.startDocsService('doc_1');
    final stopped = await svc.stopDocsService('doc_1');

    expect(calls, [
      'POST /api/docs-registry/doc_1/start',
      'POST /api/docs-registry/doc_1/stop',
    ]);
    expect(started.status, 'starting');
    expect(stopped.status, 'starting');
  });

  test('server error messages surface through the exception', () async {
    final settings = await mockSettings();
    final svc = ManageService(
      settings: settings,
      httpClient: MockClient(
        (_) async => jsonResponse(400, {'error': 'no startCmd registered — cannot start'}),
      ),
    );

    await expectLater(
      svc.startDocsService('doc_1'),
      throwsA(
        isA<Exception>().having(
          (e) => e.toString(),
          'message',
          contains('no startCmd registered'),
        ),
      ),
    );
  });

  test('fetchDocsServiceLog decodes utf-8 text bodies', () async {
    final settings = await mockSettings();
    final svc = ManageService(
      settings: settings,
      httpClient: MockClient((request) async {
        expect(request.url.path, '/api/docs-registry/doc_1/log');
        return http.Response(
          '服务已启动 ✓ listening on 8770',
          200,
          headers: {'content-type': 'text/plain; charset=utf-8'},
        );
      }),
    );

    final log = await svc.fetchDocsServiceLog('doc_1');
    expect(log, contains('listening on 8770'));
    expect(log, contains('✓'));
  });
}
