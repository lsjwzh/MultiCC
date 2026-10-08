// RemoteScreenService 的传输接线单测：换票 → /ws/remote-screen → RFB 握手 →
// live；握手失败 → 自动回退 JPEG 轮询。channel / 票据接口 / HTTP 全是本地桩，
// 与 terminal_service_test.dart 同一套 fake 范式（binary 版：RFB 走字节）。
import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';
import 'dart:ui';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:multicc_app/services/remote_screen_service.dart';
import 'package:multicc_app/services/remote_screen_region.dart';
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

  test(
    'native crop geometry adds the source origin and clips nested selections',
    () {
      const area = ScreenRegion(100, 80, 400, 240);
      expect(
        area.point(const Offset(200, 100), 800, 480),
        const Offset(200, 130),
      );
      expect(
        area.select(const Rect.fromLTWH(200, 100, 400, 200), 800, 480)!.toMap(),
        {'x': 200.0, 'y': 130.0, 'width': 200.0, 'height': 100.0},
      );
      expect(
        area.select(const Rect.fromLTWH(-20, -20, 220, 120), 800, 480)!.toMap(),
        {'x': 100.0, 'y': 80.0, 'width': 100.0, 'height': 50.0},
      );
      expect(
        area.select(const Rect.fromLTWH(900, 500, 20, 20), 800, 480),
        isNull,
      );
    },
  );

  test(
    'source-region polling discards late crops and reset returns full-screen geometry',
    () async {
      final incoming = StreamController<dynamic>.broadcast();
      addTearDown(incoming.close);
      final first = Completer<http.Response>();
      final requests = <Uri>[];
      final service = await _make(
        incoming: incoming,
        sent: [],
        httpStub: MockClient((req) async {
          requests.add(req.url);
          if (requests.length == 1) return first.future;
          final cropped = req.url.queryParameters.containsKey('x');
          return http.Response.bytes(
            [cropped ? 2 : 3],
            200,
            headers: {
              'X-Screen-Width': '1000',
              'X-Screen-Height': '500',
              if (cropped) ...{
                'X-Region-X': '200',
                'X-Region-Y': '100',
                'X-Region-Width': '400',
                'X-Region-Height': '200',
              },
            },
          );
        }),
      );
      addTearDown(service.dispose);
      service.selectRegion(const ScreenRegion(100, 50, 200, 100));
      await _pumpUntil(() => requests.length == 1);
      service.selectRegion(const ScreenRegion(200, 100, 400, 200));
      expect(
        service.fallbackJpeg,
        isNull,
        reason: 'no input against the previous geometry',
      );
      first.complete(
        http.Response.bytes(
          [1],
          200,
          headers: {'X-Screen-Width': '1000', 'X-Screen-Height': '500'},
        ),
      );
      await _pumpUntil(() => service.fallbackJpeg != null);
      expect(service.fallbackJpeg, [2]);
      expect(requests.last.queryParameters['x'], '200.0');
      expect(
        service.viewRegion!.point(const Offset(400, 200), 800, 400),
        const Offset(400, 200),
      );
      service.selectRegion(null);
      expect(service.fallbackJpeg, isNull);
      await _pumpUntil(() => service.fallbackJpeg != null);
      expect(service.fallbackJpeg, [3]);
      expect(service.viewRegion, isNull);
      expect(requests.last.queryParameters, isEmpty);
    },
  );

  // 「这台机器能不能做远程屏幕」：只有服务端**明确**说不支持才收敛入口。
  // 老 server 没有这条路由、或这一次请求失败，都必须返回 null（= 不拦），
  // 否则一次网络抖动就会把 macOS 上的功能藏掉。
  test('能力探测：supported=false 明确返回，其余一律 null 不拦', () async {
    final incoming = StreamController<dynamic>();
    incoming.stream.listen((_) {});
    addTearDown(incoming.close);

    Future<bool?> probe(http.Client stub) async {
      final s = await _make(incoming: incoming, sent: [], httpStub: stub);
      addTearDown(s.dispose);
      return s.supportsRemoteScreen();
    }

    Future<http.Client> json(Object body, [int code = 200]) async =>
        MockClient((_) async => http.Response(jsonEncode(body), code));

    expect(
      await probe(
        await json({
          'ok': true,
          'platform': 'win32',
          'supported': false,
          'reason': 'platform-unsupported',
        }),
      ),
      isFalse,
    );
    expect(
      await probe(await json({'ok': true, 'platform': 'darwin', 'supported': true})),
      isTrue,
    );
    // 老 server：404 → 不拦。
    expect(await probe(await json({'error': 'not found'}, 404)), isNull);
    // 200 但没有 supported 字段（结构变了）→ 不拦。
    expect(await probe(await json({'ok': true})), isNull);
    // 网络层直接抛 → 不拦。
    expect(
      await probe(
        MockClient((_) async => throw http.ClientException('unreachable')),
      ),
      isNull,
    );
  });

  test('唤起状态只读，点击才提交；服务端拒绝不能当成功', () async {
    final incoming = StreamController<dynamic>();
    incoming.stream.listen((_) {});
    addTearDown(incoming.close);
    final methods = <String>[];
    final service = await _make(
      incoming: incoming,
      sent: [],
      httpStub: MockClient((request) async {
        expect(request.url.path, '/api/remote-screen/wake');
        methods.add(request.method);
        return http.Response(
          jsonEncode({'ok': true, 'canWake': false, 'message': '请先开启自动解锁'}),
          request.method == 'POST' ? 409 : 200,
          headers: {'content-type': 'application/json; charset=utf-8'},
        );
      }),
    );
    addTearDown(service.dispose);
    expect((await service.wakeScreen())['canWake'], false);
    expect(methods, ['GET']);
    expect((await service.wakeScreen(request: true))['ok'], false);
    expect(methods, ['GET', 'POST']);
  });

  test('权限门只依赖屏幕录制 + 辅助功能；输入监控/Esc 状态不影响就绪', () {
    final base = <String, dynamic>{
      'ok': true,
      'applicable': true,
      'accessibility': true,
      'screenRecording': true,
    };
    for (final esc in [false, true, null]) {
      final perms = {...base, 'listenAccess': esc, 'escMonitorEnabled': esc};
      expect(RemoteScreenService.desktopPermissionsReady(perms), isTrue);
      expect(
        RemoteScreenService.allPermissionsReady(perms),
        isTrue,
        reason: '听监控/Esc 急停不再是必需权限',
      );
    }
    expect(
      RemoteScreenService.desktopPermissionsReady({
        ...base,
        'screenRecording': false,
      }),
      isFalse,
    );
    expect(
      RemoteScreenService.allPermissionsReady({
        ...base,
        'accessibility': false,
      }),
      isFalse,
    );
    expect(RemoteScreenService.allPermissionsReady({'ok': false}), isFalse);
  });

  test('复查不重启；手动重启保留真实监听状态和失败回执', () async {
    final incoming = StreamController<dynamic>.broadcast();
    addTearDown(incoming.close);
    final calls = <String>[];
    var failRestart = false;
    final payload = {
      'ok': true,
      'applicable': true,
      'accessibility': true,
      'screenRecording': true,
      'listenAccess': true,
      'escMonitorEnabled': false,
    };
    final service = await _make(
      incoming: incoming,
      sent: [],
      httpStub: MockClient((req) async {
        calls.add('${req.method} ${req.url.path}');
        if (req.url.path.endsWith('/open')) {
          expect(jsonDecode(req.body)['permission'], 'listenAccess');
          return http.Response('{"ok":true}', 200);
        }
        if (req.method == 'POST' && failRestart) {
          return http.Response('{"ok":false,"error":"fixture"}', 503);
        }
        return http.Response(jsonEncode(payload), 200);
      }),
    );
    addTearDown(service.dispose);
    final before = await service.agentPermissions();
    expect(before['escMonitorEnabled'], isFalse);
    expect(calls, ['GET /api/system/agent-permissions']);
    await service.openPermission('listenAccess');
    final after = await service.restartAgentPermissions();
    expect(after['escMonitorEnabled'], isFalse, reason: '重启成功不等于监听已启用');
    expect(calls.last, 'POST /api/system/agent-permissions/restart');
    failRestart = true;
    expect(await service.restartAgentPermissions(), {
      'ok': false,
      'error': 'fixture',
    });
  });

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
      httpStub: MockClient(
        (request) async => http.Response.bytes(
          Uint8List.fromList([1, 2, 3]),
          200,
          headers: const {'X-Screen-Width': '4', 'X-Screen-Height': '2'},
        ),
      ),
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
