import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:multicc_app/models/message.dart';
import 'package:multicc_app/services/session_service.dart';
import 'package:multicc_app/services/settings_service.dart';

// P3 · task chat = ordinary chat. The fail-soft port behind the handoff:
// SessionService.fetchTaskBoundSession (resolve a fleet-hidden session by its
// server marker). It must never throw — any error means the caller keeps its
// legacy behaviour (ledger projection / not-found snackbar).

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  Future<SettingsService> mockSettings() async {
    SharedPreferences.setMockInitialValues({
      'multicc_host': 'http://server.example',
      'multicc_token': 'secret',
    });
    return SettingsService.getInstance();
  }

  group('SessionService.fetchTaskBoundSession', () {
    test('resolves a marked record into a chat Session shell', () async {
      final settings = await mockSettings();
      final svc = SessionService(
        settings: settings,
        httpClient: MockClient((request) async {
          expect(request.url.path, '/api/sessions/sess-bound-1');
          // Response.bytes: the body has non-latin1 chars (task titles are
          // Chinese), which the plain Response(body) constructor cannot encode.
          return http.Response.bytes(
            utf8.encode(
              jsonEncode({
                'id': 'sess-bound-1',
                'dirId': 'dir-1',
                'label': '任务 · 修 bug',
                'cli': 'codex',
                'cwd': '/repo',
                'createdAt': '2026-08-20T10:00:00.000Z',
                'taskBoundTaskId': 'tsk-1',
              }),
            ),
            200,
          );
        }),
      );

      final session = await svc.fetchTaskBoundSession('sess-bound-1');

      expect(session, isNotNull);
      expect(session!.id, 'sess-bound-1');
      expect(session.dirId, 'dir-1');
      expect(session.label, '任务 · 修 bug');
      expect(session.cli, SessionCli.codex);
      expect(session.kind, SessionKind.chat);
      expect(session.cwd, '/repo');
      expect(session.taskBoundTaskId, 'tsk-1');
    });

    test(
      'records WITHOUT the marker never open through the fleet-miss path',
      () async {
        final settings = await mockSettings();
        // An ordinary session (or aux/gateway) resolving here would let stale
        // refs and internal records open as chats — the marker is the gate.
        final svc = SessionService(
          settings: settings,
          httpClient: MockClient((request) async {
            return http.Response(
              jsonEncode({
                'id': 'aux-1',
                'cli': 'claude',
                'taskBoundTaskId': null,
              }),
              200,
            );
          }),
        );
        expect(await svc.fetchTaskBoundSession('aux-1'), isNull);
      },
    );

    test(
      'fails soft on 404 (execution slots stay 404-grade) and offline',
      () async {
        final settings = await mockSettings();
        final gone = SessionService(
          settings: settings,
          httpClient: MockClient((request) async => http.Response('{}', 404)),
        );
        expect(await gone.fetchTaskBoundSession('slot-1'), isNull);
        final down = SessionService(
          settings: settings,
          httpClient: MockClient((request) async => throw Exception('down')),
        );
        expect(await down.fetchTaskBoundSession('x'), isNull);
      },
    );
  });
}
