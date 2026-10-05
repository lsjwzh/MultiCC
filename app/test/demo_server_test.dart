import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:multicc_app/services/air_service.dart';
import 'package:multicc_app/services/connection_probe_service.dart';
import 'package:multicc_app/services/demo/demo_data.dart';
import 'package:multicc_app/services/demo/demo_mode.dart';
import 'package:multicc_app/services/demo/demo_server.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/widgets/air/air_ops_store.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// 演示服务器必须让 App 的真实连接链路（探测 → 首页快照 → 聊天 WebSocket）
/// 一路走通 —— App Store 审核员手里没有任何服务器，演示就是唯一的入口。
void main() {
  late DemoServer server;
  var lang = 'en';

  setUp(() async {
    lang = 'en';
    server = await DemoServer.start(lang: () => lang);
  });

  tearDown(() => server.close());

  test('passes the same connection probe as a real host', () async {
    final probe = ConnectionProbeService();
    addTearDown(probe.close);
    final result = await probe.probe(
      host: server.host,
      token: DemoServer.accessToken,
    );
    expect(result.ok, isTrue, reason: '${result.failure}');
  });

  test('air snapshot parses into the demo tasks', () async {
    final res = await http.get(Uri.parse('${server.host}/api/air'));
    expect(res.statusCode, 200);
    final snapshot = AirSnapshot.fromJson(
      (jsonDecode(res.body) as Map).cast<String, dynamic>(),
    );
    expect(snapshot.tasks.map((t) => t.id), [for (final t in demoTasks) t.id]);
    expect(snapshot.directories.single.id, demoDirId);
  });

  test('demo content follows the app language', () async {
    lang = 'zh';
    final res = await http.get(Uri.parse('${server.host}/api/air'));
    final tasks = (jsonDecode(res.body) as Map)['tasks'] as List;
    expect((tasks.first as Map)['title'], demoTasks.first.title['zh']);
  });

  test('unknown endpoints answer 404 instead of hanging', () async {
    final res = await http.get(Uri.parse('${server.host}/api/providers'));
    expect(res.statusCode, 404);
  });

  test('chat socket replays history and streams a reply', () async {
    final task = demoTasks.first;
    final ticket = await http.post(
      Uri.parse('${server.host}/api/auth/ws-ticket'),
      body: jsonEncode({'path': '/ws/chat'}),
    );
    expect((jsonDecode(ticket.body) as Map)['path'], '/ws/chat');

    final socket = await WebSocket.connect(
      '${server.host.replaceFirst('http', 'ws')}/ws/chat'
      '?session=${task.sessionId}&ticket=x',
    );
    final frames = <Map<String, dynamic>>[];
    final done = Completer<void>();
    socket.listen((raw) {
      final msg = (jsonDecode(raw as String) as Map).cast<String, dynamic>();
      frames.add(msg);
      if (msg['type'] == 'chat_history') {
        socket.add(
          jsonEncode({
            'type': 'user_message',
            'text': 'Add a logout button',
            'clientMsgId': 'c1',
          }),
        );
      }
      if (msg['type'] == 'stream_end') done.complete();
    });
    await done.future.timeout(const Duration(seconds: 20));
    await socket.close();

    final history = frames.firstWhere((f) => f['type'] == 'chat_history');
    expect((history['messages'] as List).length, task.turns.length * 2);

    final types = frames.map((f) => f['type']).toList();
    expect(types.indexOf('stream_start'), lessThan(types.indexOf('assistant')));
    expect(types.indexOf('assistant'), lessThan(types.indexOf('result')));
    final streamed = frames
        .where(
          (f) =>
              f['type'] == 'stream_event' &&
              (f['event'] as Map)['type'] == 'content_block_delta',
        )
        .map((f) => ((f['event'] as Map)['delta'] as Map)['text'])
        .join();
    final assistant = frames.firstWhere((f) => f['type'] == 'assistant');
    final text =
        (((assistant['message'] as Map)['content'] as List).first
            as Map)['text'];
    expect(streamed, text);
    expect(text, contains('Add a logout button'));
    expect(
      frames.where((f) => f['type'] == 'chat_msg_meta').map((f) => f['role']),
      ['user', 'assistant'],
    );

    // 发过的消息进了会话记录，重新打开还能看到。
    final reopened = await http.get(
      Uri.parse('${server.host}/api/sessions/${task.sessionId}/history'),
    );
    final messages = (jsonDecode(reopened.body) as Map)['messages'] as List;
    expect(messages.length, task.turns.length * 2 + 2);
  });

  group('demo mode leaves the real connection alone', () {
    late SettingsService settings;

    setUp(() async {
      SharedPreferences.setMockInitialValues({
        'multicc_host': 'http://192.168.1.20:3000',
        'multicc_token': 'real-token',
      });
      settings = await SettingsService.getInstance();
      await settings.save(
        host: 'http://192.168.1.20:3000',
        token: 'real-token',
      );
      await settings.rememberServer('http://192.168.1.20:3000', 'real-token');
    });

    tearDown(() => DemoMode.exit(settings));

    test('entering points at the demo host without writing prefs', () async {
      await DemoMode.enter(settings);
      expect(settings.isDemo, isTrue);
      expect(settings.host, startsWith('http://127.0.0.1:'));
      expect(settings.token, DemoServer.accessToken);
      final prefs = await SharedPreferences.getInstance();
      expect(prefs.getString('multicc_host'), 'http://192.168.1.20:3000');
      expect(prefs.getString('multicc_token'), 'real-token');
    });

    test('logging out of the demo restores the saved server', () async {
      await DemoMode.enter(settings);
      final store = AirOpsStore(settings: settings);
      addTearDown(store.dispose);
      await store.logout();
      expect(settings.isDemo, isFalse);
      expect(settings.host, 'http://192.168.1.20:3000');
      expect(settings.token, 'real-token');
      expect(settings.serverHistory.map((e) => e.host), [
        'http://192.168.1.20:3000',
      ]);
    });

    test('saving a real connection leaves the demo', () async {
      await DemoMode.enter(settings);
      await settings.save(host: 'http://10.0.0.5:3000', token: 't2');
      expect(settings.isDemo, isFalse);
      expect(settings.host, 'http://10.0.0.5:3000');
    });
  });
}
