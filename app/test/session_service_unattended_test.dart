import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:multicc_app/services/session_service.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:shared_preferences/shared_preferences.dart';

Future<SettingsService> _settings() async {
  SharedPreferences.setMockInitialValues({
    'multicc_host': 'http://127.0.0.1:9',
    'multicc_token': '',
  });
  return SettingsService.getInstance();
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('GET /api/sessions/:id/unattended 解析状态与 limits', () async {
    late Uri seen;
    final client = MockClient((request) async {
      seen = request.url;
      return http.Response(
        jsonEncode({
          'ok': true,
          'unattended': {
            'status': 'active',
            'goal': '修好登录流程',
            'criteria': ['测试通过'],
            'maxDurationMinutes': 90,
            'rounds': 4,
            'startedAt': 1,
            'deadlineAt': 5400001,
            'updatedAt': 2,
          },
          'limits': {
            'maxDurationMinutesDefault': 120,
            'maxDurationMinutesMin': 5,
            'maxDurationMinutesMax': 1440,
          },
        }),
        200,
        headers: {'content-type': 'application/json; charset=utf-8'},
      );
    });

    final snapshot = await SessionService(
      settings: await _settings(),
      httpClient: client,
    ).fetchUnattended('s1');

    expect(seen.path, '/api/sessions/s1/unattended');
    expect(snapshot.state!.isActive, isTrue);
    expect(snapshot.state!.goal, '修好登录流程');
    expect(snapshot.state!.rounds, 4);
    expect(snapshot.state!.maxDurationMinutes, 90);
    expect(snapshot.state!.deadlineAt, 5400001);
    expect(snapshot.limits.maxDurationMinutesMax, 1440);
  });

  test('POST 动作把 body 原样发出去（只发 maxDurationMinutes），并回填服务端状态', () async {
    Map<String, dynamic>? sent;
    final client = MockClient((request) async {
      expect(request.method, 'POST');
      expect(request.url.path, '/api/sessions/s1/unattended');
      sent = jsonDecode(request.body) as Map<String, dynamic>;
      return http.Response(
        jsonEncode({
          'ok': true,
          'unattended': {
            'status': 'active',
            'goal': '修好登录流程',
            'maxDurationMinutes': 90,
            'rounds': 0,
            'startedAt': 1000,
            'deadlineAt': 5401000,
          },
          'limits': {
            'maxDurationMinutesDefault': 120,
            'maxDurationMinutesMin': 5,
            'maxDurationMinutesMax': 1440,
          },
        }),
        200,
        headers: {'content-type': 'application/json; charset=utf-8'},
      );
    });

    final snapshot = await SessionService(
      settings: await _settings(),
      httpClient: client,
    ).postUnattended('s1', {
      'action': 'start',
      'goal': '修好登录流程',
      'criteria': ['测试通过'],
      'maxDurationMinutes': 90,
      'evaluateNow': true,
    });

    expect(sent, {
      'action': 'start',
      'goal': '修好登录流程',
      'criteria': ['测试通过'],
      'maxDurationMinutes': 90,
      'evaluateNow': true,
    });
    // 旧的轮次上限键不能再出现。
    expect(sent!.containsKey('maxRounds'), isFalse);
    expect(snapshot.state!.maxDurationMinutes, 90);
    expect(snapshot.state!.deadlineAt, 5401000);
  });

  test('resume 只带可选时限；stop 只带 action', () async {
    final bodies = <Map<String, dynamic>>[];
    final client = MockClient((request) async {
      bodies.add(jsonDecode(request.body) as Map<String, dynamic>);
      return http.Response(
        jsonEncode({
          'ok': true,
          'unattended': {'status': 'active', 'maxDurationMinutes': 60},
          'limits': <String, Object>{},
        }),
        200,
        headers: {'content-type': 'application/json; charset=utf-8'},
      );
    });

    final service = SessionService(
      settings: await _settings(),
      httpClient: client,
    );
    await service.postUnattended('s1', {
      'action': 'resume',
      'maxDurationMinutes': 60,
    });
    await service.postUnattended('s1', {'action': 'stop'});

    expect(bodies, [
      {'action': 'resume', 'maxDurationMinutes': 60},
      {'action': 'stop'},
    ]);
  });

  test('服务端拒绝时抛出它给的原因（goal_required）', () async {
    final client = MockClient(
      (_) async => http.Response(
        jsonEncode({'ok': false, 'error': 'goal_required'}),
        400,
        headers: {'content-type': 'application/json; charset=utf-8'},
      ),
    );

    await expectLater(
      SessionService(
        settings: await _settings(),
        httpClient: client,
      ).postUnattended('s1', {'action': 'start'}),
      throwsA(
        predicate<Object>(
          (error) => error.toString().contains('goal_required'),
        ),
      ),
    );
  });

  test('clearUnattended 只发 {action: clear}，服务端回 unattended: null', () async {
    Map<String, dynamic>? sent;
    final client = MockClient((request) async {
      expect(request.method, 'POST');
      expect(request.url.path, '/api/sessions/s1/unattended');
      sent = jsonDecode(request.body) as Map<String, dynamic>;
      return http.Response(
        jsonEncode({
          'ok': true,
          'unattended': null,
          'limits': <String, Object>{},
        }),
        200,
        headers: {'content-type': 'application/json; charset=utf-8'},
      );
    });

    final snapshot = await SessionService(
      settings: await _settings(),
      httpClient: client,
    ).clearUnattended('s1');

    expect(sent, {'action': 'clear'});
    expect(snapshot.state, isNull);
  });

  test('clearUnattended 把 409 invalid_state 原样抛出', () async {
    final client = MockClient(
      (_) async => http.Response(
        jsonEncode({'ok': false, 'error': 'invalid_state'}),
        409,
        headers: {'content-type': 'application/json; charset=utf-8'},
      ),
    );

    await expectLater(
      SessionService(
        settings: await _settings(),
        httpClient: client,
      ).clearUnattended('s1'),
      throwsA(
        predicate<Object>(
          (error) => error.toString().contains('invalid_state'),
        ),
      ),
    );
  });
}
