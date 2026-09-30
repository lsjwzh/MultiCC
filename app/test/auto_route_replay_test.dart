import 'dart:convert';
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/models/message.dart';
import 'package:multicc_app/providers/chat_provider.dart';
import 'package:multicc_app/services/quota_service.dart';
import 'package:multicc_app/services/settings_service.dart';

class _NoQuota extends QuotaService {
  _NoQuota(SettingsService settings) : super(settings: settings);
  @override
  Future<Map<String, dynamic>?> fetchCodexQuota() async => null;
  @override
  Future<Map<String, dynamic>?> fetchIdleBars() async => null;
  @override
  Future<Map<String, dynamic>?> fetchClaudeUsage() async => null;
  @override
  Future<Map<String, dynamic>?> fetchQoderQuota() async => null;
  @override
  Future<Map<String, dynamic>?> fetchOpenCodeQuota() async => null;
}

Future<void> _until(bool Function() ready) async {
  for (var i = 0; i < 200; i++) {
    if (ready()) return;
    await Future<void>.delayed(const Duration(milliseconds: 10));
  }
  fail('chat state did not settle');
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(() => I18n.init('zh'));

  test(
    'a history replay adopts the live Auto route note instead of doubling it',
    () async {
      final previousHttpOverrides = HttpOverrides.current;
      HttpOverrides.global = null;
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      final sockets = <WebSocket>[];
      // The server persists the note when the turn picks its line, and stamps
      // that record's key onto the live event.
      const noteKey = 'auto-route-t1-1';
      final route = {
        'phase': 'selected',
        'protocol': 'openai_responses',
        'providerId': 'p-glm',
        'providerName': '智谱',
        'model': 'glm-4.6',
        'tier': 'strong',
        'preferredTier': 'strong',
        'routing': {
          'source': 'jev',
          'code': 'jev_choice',
          'tierIndex': 1,
          'tierCount': 2,
        },
      };
      final record = {
        'id': 'm0001-1',
        'role': 'system',
        'kind': 'auto_route',
        'content': 'Auto → 智谱 · glm-4.6',
        'ts': 1790000000000,
        'clientMsgId': noteKey,
        'autoRoute': route,
      };
      server.listen((request) async {
        if (WebSocketTransformer.isUpgradeRequest(request)) {
          final socket = await WebSocketTransformer.upgrade(request);
          sockets.add(socket);
          socket.listen((_) {});
          socket.add(
            jsonEncode({
              'type': 'system',
              'subtype': 'init',
              'is_streaming': false,
              'session_id': 'native-resume-id',
            }),
          );
          // The live verdict lands first; the ordered history page follows.
          socket.add(
            jsonEncode({
              'type': 'provider_auto_route',
              ...route,
              'noteClientMsgId': noteKey,
            }),
          );
          socket.add(
            jsonEncode({
              'type': 'chat_history',
              'messages': [record],
              'hasMore': false,
            }),
          );
          return;
        }
        await request.drain<void>();
        final Object data;
        if (request.uri.path == '/api/task-shells') {
          data = {'code': 'unsupported_source'};
        } else if (request.uri.path.endsWith('/ws-ticket')) {
          data = {'ticket': 'local-fixture', 'path': '/ws/chat'};
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
      final provider = ChatProvider(
        settings: settings,
        sessionName: 'source',
        sessionCwd: '/fixture',
        initialCli: SessionCli.claude,
        quotaService: _NoQuota(settings),
      );
      try {
        await _until(() => provider.historyApplied);
        final notes = provider.messages
            .where((m) => m.content.contains('Jev 判定'))
            .toList();
        expect(notes, hasLength(1), reason: 'live note + replay must be one line');
        expect(notes.single.role, MessageRole.system);
        expect(notes.single.content, '🧭 Jev 判定为复杂任务 · 选用 智谱（glm-4.6）');
        expect(notes.single.clientMsgId, noteKey);
        // The note is never mistaken for the assistant bubble.
        expect(
          provider.messages.where((m) => m.role == MessageRole.assistant),
          isEmpty,
        );
      } finally {
        provider.dispose();
        for (final socket in sockets) {
          await socket.close();
        }
        await server.close(force: true);
        HttpOverrides.global = previousHttpOverrides;
      }
    },
  );
}
