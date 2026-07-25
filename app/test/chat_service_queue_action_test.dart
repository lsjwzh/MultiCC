import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:multicc_app/services/chat_service.dart';
import 'package:multicc_app/services/settings_service.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('queue action sends confirmed canonical request with auth', () async {
    SharedPreferences.setMockInitialValues({
      'multicc_host': 'http://server.example',
      'multicc_token': 'secret',
    });
    final settings = await SettingsService.getInstance();
    late http.Request captured;
    final client = MockClient((request) async {
      captured = request;
      return http.Response(
        jsonEncode({
          'ok': true,
          'schedule': {'state': 'idle', 'queued': []},
        }),
        200,
      );
    });
    final service = ChatService(
      settings: settings,
      sessionName: 'session/a',
      sessionCwd: '/tmp',
      httpClient: client,
    );

    final result = await service.queueAction(
      'cancel_queued',
      entryId: 'entry-1',
    );

    expect(result['ok'], isTrue);
    expect(captured.method, 'POST');
    expect(captured.url.path, '/api/sessions/session%2Fa/queue/action');
    expect(captured.headers['x-access-token'], 'secret');
    final body = jsonDecode(captured.body) as Map<String, dynamic>;
    expect(body['action'], 'cancel_queued');
    expect(body['entryId'], 'entry-1');
    expect(body['confirm'], isTrue);
    service.dispose();
  });

  test('queue action surfaces structured server rejection', () async {
    SharedPreferences.setMockInitialValues({
      'multicc_host': 'http://server.example',
    });
    final settings = await SettingsService.getInstance();
    final service = ChatService(
      settings: settings,
      sessionName: 'session',
      sessionCwd: '/tmp',
      httpClient: MockClient(
        (_) async => http.Response(
          jsonEncode({'ok': false, 'code': 'active_task_not_frozen'}),
          409,
        ),
      ),
    );

    await expectLater(
      service.queueAction('resume'),
      throwsA(
        isA<QueueActionException>().having(
          (error) => error.code,
          'code',
          'active_task_not_frozen',
        ),
      ),
    );
    service.dispose();
  });
}
