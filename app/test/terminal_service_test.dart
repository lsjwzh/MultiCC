// 终端传输层的纯单测：只喂消息，不碰网络。
//
// 守的是「attach 快照 = 替换而不是追加」：服务端在 (重)连接时会先补一份当前屏幕
// （含回看），客户端必须先清屏再写 —— 否则每断一次线/切一次后台回来，屏上就多一份
// 重复内容。这条在手机上尤其要紧：切后台再回来就是一次重连。
//
// 用普通 test 而不是 widget 测试跑：这里要等的是真的 Future（换票、连接就绪），
// 而 widget 测试那套 FakeAsync 只有 pump 才推进时钟，直接 await 会原地死锁。

import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/services/terminal_service.dart';
import 'package:multicc_app/services/ws_ticket_service.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:stream_channel/stream_channel.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

class _FakeChannel extends StreamChannelMixin implements WebSocketChannel {
  _FakeChannel(this.incoming, this.sent);
  final StreamController<dynamic> incoming;
  final List<Map<String, dynamic>> sent;
  @override
  String? get protocol => null;
  @override
  int? get closeCode => null;
  @override
  String? get closeReason => null;
  @override
  Future<void> get ready => Future.value();
  @override
  WebSocketSink get sink => _FakeSink(sent);
  @override
  Stream get stream => incoming.stream;
}

class _FakeSink implements WebSocketSink {
  _FakeSink(this.sent);
  final List<Map<String, dynamic>> sent;
  @override
  void add(dynamic data) {
    try {
      sent.add(jsonDecode('$data') as Map<String, dynamic>);
    } catch (_) {}
  }

  @override
  void addError(Object error, [StackTrace? stackTrace]) {}
  @override
  Future<void> addStream(Stream stream) => Future.value();
  @override
  Future<void> close([int? closeCode, String? closeReason]) => Future.value();
  @override
  Future<void> get done => Future.value();
}

/// 连上一个假 socket：ticket 接口和 channel 都是本地桩，不发一个真请求。
Future<TerminalService> _connect(
  StreamController<dynamic> incoming,
  List<Map<String, dynamic>> sent,
) async {
  SharedPreferences.setMockInitialValues({
    'multicc_host': 'http://localhost:3000',
    'multicc_token': '',
  });
  final settings = await SettingsService.getInstance();
  final service = TerminalService(
    settings: settings,
    sessionId: 'term-1',
    wsTicketClient: WsTicketClient(
      // gate 会校验票据是「按路径签发」的：响应里必须回带请求的那个 path，
      // 少了它就判 invalid_ticket_response，然后一头扎进无限重连。
      post: (endpoint, {required headers, required body}) async {
        final requested = (jsonDecode(body) as Map<String, dynamic>)['path'];
        return http.Response(
          jsonEncode({'ok': true, 'ticket': 'fixture', 'path': requested}),
          200,
        );
      },
    ),
    channelFactory: (_) => _FakeChannel(incoming, sent),
  );
  service.connect();
  // 换票 → 建连 → ready 各是一轮微任务，给真时钟一点时间走完。
  await Future<void>.delayed(const Duration(milliseconds: 20));
  return service;
}

String _screen(TerminalService service) {
  // buffer.lines 是 IndexAwareCircularBuffer：可按下标取，但不是 Iterable。
  final lines = service.terminal.buffer.lines;
  return [
    for (var i = 0; i < lines.length; i++) lines[i].toString(),
  ].join('\n');
}

Future<void> _settle() =>
    Future<void>.delayed(const Duration(milliseconds: 20));

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('快照是替换、output 是追加：重连不会多一份重复内容', () async {
    final incoming = StreamController<dynamic>();
    final sent = <Map<String, dynamic>>[];
    addTearDown(incoming.close);
    final service = await _connect(incoming, sent);
    addTearDown(service.dispose);

    incoming.add(jsonEncode({'type': 'output', 'data': 'older line\r\n'}));
    await _settle();
    expect(_screen(service), contains('older line'), reason: 'output 要写进屏上');

    incoming.add(jsonEncode({'type': 'snapshot', 'data': 'server screen\r\n'}));
    await _settle();
    final screen = _screen(service);
    expect(screen, contains('server screen'), reason: '快照内容要在');
    expect(
      screen,
      isNot(contains('older line')),
      reason: '快照是替换：旧内容不该留着（否则每重连一次多一份）',
    );

    incoming.add(jsonEncode({'type': 'output', 'data': 'after snapshot\r\n'}));
    await _settle();
    final after = _screen(service);
    expect(after, contains('server screen'), reason: '快照内容要还在');
    expect(after, contains('after snapshot'), reason: '快照之后的实时输出是追加');
  });

  test('服务端消息不会被当成输入回发（快照尤其不能倒灌进 PTY）', () async {
    final incoming = StreamController<dynamic>();
    final sent = <Map<String, dynamic>>[];
    addTearDown(incoming.close);
    final service = await _connect(incoming, sent);
    addTearDown(service.dispose);

    expect(
      sent.where((m) => m['type'] == 'resize'),
      isNotEmpty,
      reason: '连上之后要报一次自己的尺寸，服务端才会把 pane 调过来',
    );

    sent.clear();
    final bigScreen = List.filled(
      200,
      'a line of the captured screen',
    ).join('\r\n');
    incoming.add(
      jsonEncode({'type': 'session_id', 'id': 'term-1', 'cli': 'codex'}),
    );
    incoming.add(jsonEncode({'type': 'snapshot', 'data': bigScreen}));
    incoming.add(jsonEncode({'type': 'output', 'data': 'more output\r\n'}));
    await _settle();
    expect(
      sent.where((m) => m['type'] == 'input'),
      isEmpty,
      reason: '服务端发来的东西只能上屏，回发就等于把整屏敲进 shell',
    );
    expect(_screen(service), contains('a line of the captured screen'));
  });
}
