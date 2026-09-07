import 'dart:convert';
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:multicc_app/models/message.dart';
import 'package:multicc_app/providers/chat_provider.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/services/quota_service.dart';

class FixtureQuota extends QuotaService {
  FixtureQuota(SettingsService settings) : super(settings: settings);
  @override
  Future<Map<String, dynamic>?> fetchCodexQuota() async => null;
  @override
  Future<Map<String, dynamic>?> fetchIdleBars() async => null;
}

Future<void> until(bool Function() ready) async {
  for (var i = 0; i < 200; i++) {
    if (ready()) return;
    await Future<void>.delayed(const Duration(milliseconds: 10));
  }
  fail('chat state did not settle');
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  test(
    'App keeps loaded shell history across execution switch and cold reopen',
    () async {
      final previousHttpOverrides = HttpOverrides.current;
      HttpOverrides.global = null;
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      final sockets = <WebSocket>[];
      final requests = <Uri>[];
      var active = 'source';
      var switched = false;
      Map<String, dynamic> message(String source, String id, int ts) => {
        'id': '$source:$id',
        'sourceSessionId': source,
        'sourceMessageId': id,
        'role': 'assistant',
        'content': id,
        'ts': ts,
      };
      final old = message('source', 'old', 1),
          original = message('source', 'original', 2);
      final next = message('task-next', 'next', 3);
      server.listen((request) async {
        requests.add(request.uri);
        if (WebSocketTransformer.isUpgradeRequest(request)) {
          expect(request.uri.queryParameters['shell'], 'shell');
          expect(request.uri.queryParameters['session'], active);
          final socket = await WebSocketTransformer.upgrade(request);
          sockets.add(socket);
          socket.listen((_) {});
          socket.add(
            jsonEncode({
              'type': 'system',
              'subtype': 'init',
              'is_streaming': false,
              'taskShell': true,
              'cli': 'codex',
            }),
          );
          socket.add(
            jsonEncode({
              'type': 'chat_history',
              'messages': switched ? [next] : [original],
              'hasMore': true,
            }),
          );
          return;
        }
        await request.drain<void>();
        final Object data;
        if (request.uri.path == '/api/task-shells') {
          data = {'id': 'shell'};
        } else if (request.uri.path.endsWith('/chat')) {
          data = {'activeSessionId': active};
        } else if (request.uri.path.endsWith('/ws-ticket')) {
          data = {'ticket': 'local-fixture', 'path': '/ws/chat'};
        } else if (request.uri.path == '/api/task-shells/shell/history') {
          data = {
            'messages': switched ? [old, original] : [old],
            'hasMore': false,
          };
        } else {
          data = <String, dynamic>{};
        }
        request.response.headers.contentType = ContentType.json;
        request.response.write(jsonEncode(data));
        await request.response.close();
      });
      SharedPreferences.setMockInitialValues({});
      final settings = await SettingsService.getInstance();
      await settings.save(host: 'http://127.0.0.1:${server.port}', token: '');
      ChatProvider makeProvider() => ChatProvider(
        settings: settings,
        sessionName: 'source',
        sessionCwd: '/fixture',
        initialCli: SessionCli.codex,
        quotaService: FixtureQuota(settings),
      );
      final provider = makeProvider();
      ChatProvider? reopened;
      var disposed = false;
      try {
        await until(() => provider.historyApplied);
        expect(await provider.loadOlderHistory(), 1);
        expect(provider.messages.map((m) => m.id), [
          'source:old',
          'source:original',
        ]);
        switched = true;
        active = 'task-next';
        sockets.last.add(
          jsonEncode({'type': 'task_shell_routed', 'sessionId': active}),
        );
        await until(
          () =>
              sockets.length == 2 &&
              provider.messages.any((m) => m.id == 'task-next:next'),
        );
        expect(provider.messages.map((m) => m.id), [
          'source:old',
          'source:original',
          'task-next:next',
        ]);
        expect(provider.historyExhausted, isTrue);
        provider.dispose();
        disposed = true;
        reopened = makeProvider();
        await until(() => reopened!.historyApplied);
        expect(await reopened.loadOlderHistory(), 2);
        expect(reopened.messages.map((m) => m.id), [
          'source:old',
          'source:original',
          'task-next:next',
        ]);
        expect(
          requests.where(
            (u) =>
                u.path.contains('/api/sessions/') &&
                u.path.endsWith('/history'),
          ),
          isEmpty,
        );
      } finally {
        if (!disposed) provider.dispose();
        reopened?.dispose();
        for (final socket in sockets) {
          await socket.close();
        }
        await server.close(force: true);
        HttpOverrides.global = previousHttpOverrides;
      }
    },
  );
}
