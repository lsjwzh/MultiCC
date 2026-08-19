import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:multicc_app/models/message.dart';
import 'package:multicc_app/services/manage_service.dart';
import 'package:multicc_app/services/session_service.dart';
import 'package:multicc_app/services/settings_service.dart';

// P3 · task chat = ordinary chat. The two fail-soft ports behind the handoff:
// ManageService.ensureTaskChatSession (get-or-create the 1:1 bound session)
// and SessionService.fetchTaskBoundSession (resolve a fleet-hidden session by
// its server marker). Both must never throw — any error means the caller
// keeps its legacy behaviour (ledger projection / not-found snackbar).

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  Future<SettingsService> mockSettings() async {
    SharedPreferences.setMockInitialValues({
      'multicc_host': 'http://server.example',
      'multicc_token': 'secret',
    });
    return SettingsService.getInstance();
  }

  group('ManageService.ensureTaskChatSession', () {
    test(
      'posts to the chat-session endpoint and returns the session id',
      () async {
        final settings = await mockSettings();
        late http.Request captured;
        final svc = ManageService(
          settings: settings,
          httpClient: MockClient((request) async {
            captured = request;
            return http.Response(
              jsonEncode({
                'ok': true,
                'sessionId': 'sess-bound-1',
                'created': true,
              }),
              200,
            );
          }),
        );

        final sid = await svc.ensureTaskChatSession('tsk-1');

        expect(sid, 'sess-bound-1');
        expect(captured.method, 'POST');
        expect(captured.url.path, '/api/task-board/tasks/tsk-1/chat-session');
        expect(captured.headers['x-access-token'], 'secret');
      },
    );

    test('fails soft on server errors, offline and malformed bodies', () async {
      final settings = await mockSettings();
      for (final status in [501, 404, 409, 502]) {
        final svc = ManageService(
          settings: settings,
          httpClient: MockClient(
            (request) async => http.Response('{}', status),
          ),
        );
        expect(
          await svc.ensureTaskChatSession('tsk-1'),
          isNull,
          reason: 'status $status',
        );
      }
      final down = ManageService(
        settings: settings,
        httpClient: MockClient((request) async => throw Exception('down')),
      );
      expect(await down.ensureTaskChatSession('tsk-1'), isNull);
      final malformed = ManageService(
        settings: settings,
        httpClient: MockClient(
          (request) async => http.Response(jsonEncode({'ok': true}), 200),
        ),
      );
      expect(await malformed.ensureTaskChatSession('tsk-1'), isNull);
    });
  });

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
