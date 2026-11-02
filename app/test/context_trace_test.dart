import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:multicc_app/models/message.dart';
import 'package:multicc_app/services/chat_service.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/widgets/context_source_details.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('history keeps the server-authored context trace manifest', () {
    final message = ChatMessage.fromHistory({
      'role': 'assistant',
      'content': 'done',
      'contextTrace': {
        'traceId': 'sr-1',
        'currentTask': {'taskId': 'tsk-current'},
        'sources': [
          {'taskId': 'tsk-source', 'mode': 'refilled', 'messageCount': 2},
        ],
      },
    });

    expect(message.contextTrace?['traceId'], 'sr-1');
    expect((message.contextTrace?['sources'] as List).first['taskId'], 'tsk-source');
    expect(contextTraceIsSummary(message.contextTrace), isFalse);
    expect(contextTraceCount(message.contextTrace), 2);
  });

  test('history keeps the summary-only context trace and reads its count', () {
    final message = ChatMessage.fromHistory({
      'role': 'assistant',
      'content': 'done',
      'contextTrace': {
        'version': 1,
        'traceId': 'sr-9',
        'currentTask': {
          'taskId': 'tsk-current',
          'taskName': '当前任务',
          'mode': 'native',
        },
        'managedOnly': true,
        'summary': true,
        'count': 12,
        'budget': {'limit': 8000, 'used': 1200, 'managedOnly': true},
        'contextStatus': 'committed',
      },
    });

    final trace = message.contextTrace!;
    expect(trace['traceId'], 'sr-9');
    expect(trace.containsKey('sources'), isFalse);
    expect(contextTraceIsSummary(trace), isTrue);
    expect(contextTraceCount(trace), 12);
    expect(contextTraceNeedsDetail(trace), isTrue);
  });

  test('fetchContextTrace asks for the detail of a summary trace and passes '
      'the expiry fields through', () async {
    SharedPreferences.setMockInitialValues({
      'multicc_host': 'http://server.example',
      'multicc_token': 'secret',
    });
    final settings = await SettingsService.getInstance();
    late http.Request captured;
    final service = ChatService(
      settings: settings,
      sessionName: 'session-a',
      sessionCwd: '/tmp',
      httpClient: MockClient((request) async {
        captured = request;
        return http.Response(
          jsonEncode({
            'version': 1,
            'traceId': 'sr-9',
            'currentTask': {'taskId': 'tsk-current'},
            'sources': [
              {'id': 'memory:old', 'version': 'abc', 'reason': 'retained'},
            ],
            'managedOnly': true,
            'budget': {'limit': 8000, 'used': 1200},
            'contextStatus': 'committed',
            'retained': [],
            'omitted': [],
            'diagnostics': [],
            'detailExpired': true,
            'omittedCounts': {'not_relevant': 12},
          }),
          200,
          headers: {'content-type': 'application/json; charset=utf-8'},
        );
      }),
    );

    final detail = await service.fetchContextTrace('sr-9');

    expect(captured.method, 'GET');
    expect(captured.url.path, '/api/sessions/session-a/context');
    expect(captured.url.queryParameters['traceId'], 'sr-9');
    expect(captured.url.queryParameters['include'], 'messages');
    expect(captured.headers['x-access-token'], 'secret');
    expect(contextTraceIsSummary(detail), isFalse);
    expect(detail['detailExpired'], isTrue);
    expect(contextOmittedCounts(detail), {'not_relevant': 12});
    expect(contextTraceCount(detail), 2);
    service.dispose();
  });
}
