// RemoteScreenService 的传输接线单测：换票 → /ws/remote-screen → RFB 握手 →
// live；握手失败 → 自动回退 JPEG 轮询。channel / 票据接口 / HTTP 全是本地桩，
// 与 terminal_service_test.dart 同一套 fake 范式（binary 版：RFB 走字节）。
import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:multicc_app/services/remote_screen_service.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/services/ws_ticket_service.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:stream_channel/stream_channel.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

class _FakeChannel extends StreamChannelMixin implements WebSocketChannel {
  _FakeChannel(this.incoming, this.sent);
  final StreamController<dynamic> incoming;
  final List<Uint8List> sent;
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
  final List<Uint8List> sent;
  @override
  void add(dynamic data) {
    if (data is Uint8List) sent.add(data);
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

/// 假 Agent：握手 + 一个矩形，与 MultiCCAgent.swift RFB 段同一序列。
final Uint8List _rfbHello = Uint8List.fromList([
  ...'RFB 003.008\n'.codeUnits,
  0x01, 0x01,
  0x00, 0x00, 0x00, 0x00,
  0x00, 0x04, 0x00, 0x02, // 4×2
  32, 24, 0, 1,
  0x00, 0xFF, 0x00, 0xFF, 0x00, 0xFF,
  16, 8, 0, 0, 0, 0,
  0x00, 0x00, 0x00, 0x07, ...'MultiCC'.codeUnits,
  0x00, 0x00, 0x00, 0x01,
  0x00, 0x01, 0x00, 0x01, 0x00, 0x02, 0x00, 0x01,
  0x00, 0x00, 0x00, 0x00,
  0x11, 0x22, 0x33, 0xFF, 0xAA, 0xBB, 0xCC, 0xDD,
]);

Future<RemoteScreenService> _make({
  required StreamController<dynamic> incoming,
  required List<Uint8List> sent,
  http.Client? httpStub,
}) async {
  SharedPreferences.setMockInitialValues({
    'multicc_host': 'http://localhost:3000',
    'multicc_token': '',
  });
  final settings = await SettingsService.getInstance();
  return RemoteScreenService(
    settings: settings,
    wsTicketClient: WsTicketClient(
      post: (endpoint, {required headers, required body}) async {
        final requested = (jsonDecode(body) as Map<String, dynamic>)['path'];
        return http.Response(
          jsonEncode({'ok': true, 'ticket': 'fixture', 'path': requested}),
          200,
        );
      },
    ),
    channelFactory: (_) => _FakeChannel(incoming, sent),
    httpClient: httpStub,
  );
}

Future<void> _pumpUntil(
  bool Function() test, [
  Duration limit = const Duration(seconds: 2),
]) async {
  final deadline = DateTime.now().add(limit);
  while (!test()) {
    if (DateTime.now().isAfter(deadline)) fail('condition not met in time');
    await Future<void>.delayed(const Duration(milliseconds: 5));
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('换票 → RFB 握手 → live，帧应用进 framebuffer', () async {
    final incoming = StreamController<dynamic>();
    final sent = <Uint8List>[];
    addTearDown(incoming.close);
    final service = await _make(incoming: incoming, sent: sent);
    addTearDown(service.dispose);

    service.connectLive();
    incoming.add(_rfbHello);
    await _pumpUntil(() => service.mode == RemoteScreenMode.live);

    expect(service.rfb!.width, 4);
    expect(service.rfb!.height, 2);
    expect(service.rfb!.framebuffer![(1 * 4 + 1) * 4], 0x11);
    // 客户端发出过握手与请求（版本串在第一条）。
    final flat = Uint8List.fromList(sent.expand((b) => b).toList());
    expect(
      String.fromCharCodes(flat, 0, 12),
      'RFB 003.008\n',
      reason: '第一条必须是 RFB 版本串',
    );
  });

  test('握手失败（非 RFB 流）→ 自动回退 JPEG 轮询', () async {
    final incoming = StreamController<dynamic>();
    final sent = <Uint8List>[];
    addTearDown(incoming.close);
    final jpeg = Uint8List.fromList([0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3]);
    final service = await _make(
      incoming: incoming,
      sent: sent,
      httpStub: MockClient((request) async {
        if (request.url.path.endsWith('/api/remote-screen/frame')) {
          // 故意保留服务端的原始大小写：查表必须大小写不敏感。
          return http.Response.bytes(
            jpeg,
            200,
            headers: {'X-Screen-Width': '4', 'X-Screen-Height': '2'},
          );
        }
        return http.Response(jsonEncode({'ok': true}), 200);
      }),
    );
    addTearDown(service.dispose);

    service.connectLive();
    // Agent 不讲 RFB（比如旧 Agent 上的 HTTP 错误页）。
    incoming.add(Uint8List.fromList('HTTP/1.1 502'.codeUnits));
    await _pumpUntil(() => service.mode == RemoteScreenMode.fallback);

    expect(service.rfb, isNull, reason: '降级后不该再持有 RFB 会话');
    await _pumpUntil(() => service.fallbackJpeg != null);
    expect(service.fallbackJpeg, jpeg);
    expect(service.fallbackWidth, 4);
    expect(service.fallbackHeight, 2);
  });

  test('live 中途断流 → 回退轮询（旧 Agent 升级窗口期的行为）', () async {
    final incoming = StreamController<dynamic>();
    final sent = <Uint8List>[];
    addTearDown(incoming.close);
    final service = await _make(
      incoming: incoming,
      sent: sent,
      httpStub: MockClient((request) async => http.Response.bytes(
        Uint8List.fromList([1, 2, 3]),
        200,
        headers: const {'X-Screen-Width': '4', 'X-Screen-Height': '2'},
      )),
    );
    addTearDown(service.dispose);

    service.connectLive();
    incoming.add(_rfbHello);
    await _pumpUntil(() => service.mode == RemoteScreenMode.live);
    expect(service.rfb, isNotNull);

    await incoming.close(); // 传输断开
    await _pumpUntil(() => service.mode == RemoteScreenMode.fallback);
    expect(service.fallbackJpeg, isNotNull);
  });
}
