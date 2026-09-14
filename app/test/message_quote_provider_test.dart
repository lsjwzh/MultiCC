import 'dart:convert';
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/models/message.dart';
import 'package:multicc_app/providers/chat_provider.dart';
import 'package:multicc_app/services/message_quote.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/services/quota_service.dart';

// 归属是「后到」的那一段：服务端在这一轮结束时才判定一条消息属于哪个子任务，
// 那时气泡早就在屏幕上了。这条链路（WS 帧 → 壳复合 → provider 就地打标 →
// 引用块）正是 App 侧引用功能赖以为生的那一半 —— 只抄正文的引用会把最要紧的
// 上下文丢掉。

class FixtureQuota extends QuotaService {
  FixtureQuota(SettingsService settings) : super(settings: settings);
  @override
  Future<Map<String, dynamic>?> fetchCodexQuota() async => null;
  @override
  Future<Map<String, dynamic>?> fetchIdleBars() async => null;
}

Future<void> until(bool Function() ready, String reason) async {
  for (var i = 0; i < 200; i++) {
    if (ready()) return;
    await Future<void>.delayed(const Duration(milliseconds: 10));
  }
  fail('chat state did not settle: $reason');
}

Map<String, dynamic> row(String source, String id, String content) => {
  'id': '$source:$id',
  'sourceSessionId': source,
  'sourceMessageId': id,
  'role': 'assistant',
  'content': content,
  'ts': DateTime(2026, 9, 14, 9, 30).millisecondsSinceEpoch,
};

/// 一个只有壳时间线的假服务端：`/chat` 报的活动会话是 [active]，而 [page] 里
/// 的消息可以来自别的执行会话 —— 真实的壳就是这样，一条时间线由好几个执行
/// 会话拼成。回调里可以继续往 socket 上推帧。
Future<void> withShellFixture({
  required String active,
  required List<Map<String, dynamic>> page,
  required Future<void> Function(ChatProvider provider, List<WebSocket> sockets)
  body,
}) async {
  final previousHttpOverrides = HttpOverrides.current;
  HttpOverrides.global = null;
  final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
  final sockets = <WebSocket>[];
  server.listen((request) async {
    if (WebSocketTransformer.isUpgradeRequest(request)) {
      final socket = await WebSocketTransformer.upgrade(request);
      sockets.add(socket);
      socket.listen((_) {});
      socket.add(jsonEncode({
        'type': 'system',
        'subtype': 'init',
        'is_streaming': false,
        'session_id': 'native-resume-id',
        'taskShell': true,
        'cli': 'claude',
      }));
      socket.add(
        jsonEncode({'type': 'chat_history', 'messages': page, 'hasMore': false}),
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
      data = {'messages': page, 'hasMore': false};
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
    quotaService: FixtureQuota(settings),
  );
  try {
    await until(() => provider.historyApplied, 'history');
    // 壳的补拉是异步的，等它落地再认下这一刻的气泡实例 —— 之后要断言的就是
    // 这些实例被就地改过，而不是被换成了新的。
    await Future<void>.delayed(const Duration(milliseconds: 200));
    await body(provider, sockets);
  } finally {
    provider.dispose();
    for (final socket in sockets) {
      await socket.close();
    }
    await server.close(force: true);
    HttpOverrides.global = previousHttpOverrides;
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(() => I18n.init('zh'));

  test('迟到的归属就地打在气泡上，并出现在引用块里', () async {
    await withShellFixture(
      active: 'source',
      page: [row('source', 'old', '登录接口已经改成走统一网关。')],
      body: (provider, sockets) async {
        final msg = provider.messages.single;
        expect(msg.id, 'source:old');
        // 还没打标时，引用块只说得出「本会话」—— 不编一个任务名。
        expect(buildMessageQuote(msg), contains('【引用】本会话 ·'));

        // 这一轮结束，服务端广播归属。它按**执行会话**的裸 id 指认消息。
        sockets.last.add(jsonEncode({
          'type': 'chat_history_annotation',
          'messages': [
            {
              'id': 'old',
              'turnId': 'turn_1',
              'taskId': 'tsk_36ec81e8',
              'taskName': '完善登录页面',
              'auxRunId': null,
            },
          ],
        }));
        await until(() => msg.taskId == 'tsk_36ec81e8', 'attribution');

        final quote = buildMessageQuote(msg);
        expect(quote, contains('任务「完善登录页面」（tsk_36ec81e8）'));
        expect(quote, contains(' · 助手 · 09-14 09:30 · '));
        // 句柄仍指向这条消息真正来自的那个会话：归属记录里的 id 是裸的，是壳的
        // 复合（record）补出了 sourceSessionId/sourceMessageId，两者必须自洽。
        expect(quote, contains('source:old'));
        expect(msg.sourceSessionId, 'source');
        expect(msg.sourceMessageId, 'old');
        expect(msg.turnId, 'turn_1');
        expect(msg.auxRunId, isNull);
        // 就地改对象，不换实例 —— 重建列表会打断正在流式的那条。
        expect(provider.messages.single, same(msg));
      },
    );
  });

  test('只认复合后的 id：对不上的记录不许按裸 id 猜是谁', () async {
    // 注解里的 id 是**执行会话自己的**编号空间里的裸 id。气泡的 id 则带着它归属
    // 的那个会话前缀，两者本来就是一回事 —— 壳的 record() 会把注解记录复合成本
    // 地 id 才交给这里。所以一条 id 对不上的记录，就是「这条消息不在本机」，
    // 不该拿裸 id 去别处找一条来打标：那只会把别的执行会话的归属写到这条消息头上。
    await withShellFixture(
      active: 'task-next',
      page: [row('source', 'dup', '这条属于 source')],
      body: (provider, sockets) async {
        expect(provider.messages.map((m) => m.id), ['source:dup']);
        sockets.last.add(jsonEncode({
          'type': 'chat_history_annotation',
          'messages': [
            {'id': 'dup', 'turnId': 'turn_1', 'taskId': 'tsk_1', 'taskName': 'A'},
          ],
        }));
        // 这段帧处理是同步的，没有可等的状态变化 —— 等一个足够长的静默。
        await Future<void>.delayed(const Duration(milliseconds: 300));
        expect(provider.messages.single.taskId, isNull);
        expect(buildMessageQuote(provider.messages.single), contains('本会话'));
      },
    );
  });

  test('复合 id 正好对得上时按 id 认，不看源消息 id', () async {
    // 活动会话就是这条消息的来源：复合出来的 id 与气泡 id 逐字相同。
    await withShellFixture(
      active: 'task-next',
      page: [row('task-next', 'm_9', '改完了')],
      body: (provider, sockets) async {
        sockets.last.add(jsonEncode({
          'type': 'chat_history_annotation',
          'messages': [
            {'id': 'm_9', 'taskId': 'tsk_9', 'taskName': '迁移数据库'},
          ],
        }));
        await until(
          () => provider.messages.single.taskId == 'tsk_9',
          'attribution',
        );
        final quote = buildMessageQuote(provider.messages.single);
        expect(quote, contains('任务「迁移数据库」（tsk_9）'));
        expect(quote, contains('task-next:m_9'));
      },
    );
  });
}
