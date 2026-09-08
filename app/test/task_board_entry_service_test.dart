import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:multicc_app/services/manage_service.dart';
import 'package:multicc_app/services/settings_service.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  Future<SettingsService> settings() async {
    SharedPreferences.setMockInitialValues({
      'multicc_host': 'http://server.example', 'multicc_token': 'test-token',
    });
    return SettingsService.getInstance();
  }
  test('cached conversation binding cannot bypass board read-only permission', () async {
    final calls = <http.Request>[];
    final service = ManageService(settings: await settings(), httpClient: MockClient((r) async {
      calls.add(r);
      return http.Response(jsonEncode({'ok': true, 'readOnly': true, 'sessionId': null}), 200);
    }));
    expect(await service.resolveTaskChatSession('task', boundSessionId: 'old-binding'), isNull);
    expect(calls.length, 1);
    expect(calls.single.url.path, '/api/task-board/tasks/task/chat-session');
  });
  test('preview reads only and explicit fork preserves the retry key and errors', () async {
    final calls = <http.Request>[];
    final service = ManageService(settings: await settings(), httpClient: MockClient((r) async {
      calls.add(r);
      if (r.method == 'GET') return http.Response(jsonEncode({'ok': true, 'readOnly': true}), 200);
      return http.Response(jsonEncode({'ok': false, 'code': 'fork_source_dirty', 'message': 'Commit source changes'}), 409);
    }));
    expect((await service.taskShellEntry('task'))['readOnly'], true);
    for (var i = 0; i < 2; i++) {
      await expectLater(service.taskShellEntry('task', forkKey: 'stable-key'),
        throwsA(isA<BoardRouteException>().having((e) => e.code, 'code', 'fork_source_dirty')));
    }
    expect(calls.first.method, 'GET');
    expect(calls[1].url.path, '/api/task-shell-tasks/task/fork');
    expect(jsonDecode(calls[1].body), {'clientMsgId': 'stable-key'});
    expect(calls[1].body, calls[2].body);
    expect(calls[1].headers['x-access-token'], 'test-token');
  });
}
