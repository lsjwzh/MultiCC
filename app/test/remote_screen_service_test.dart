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
import 'package:multicc_app/services/remote_lan_resolver.dart';
import 'package:multicc_app/services/remote_link.dart';
import 'package:multicc_app/services/remote_screen_h264.dart';
import 'package:multicc_app/services/remote_screen_p2p.dart';
import 'package:multicc_app/services/remote_screen_service.dart';
import 'package:multicc_app/services/remote_screen_region.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/services/ws_ticket_service.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:stream_channel/stream_channel.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

class _FakeChannel extends StreamChannelMixin implements WebSocketChannel {
  _FakeChannel(this.incoming, this.sent, [List<String>? texts])
    : texts = texts ?? <String>[];
  final StreamController<dynamic> incoming;
  final List<Uint8List> sent;
  final List<String> texts;
  @override
  String? get protocol => null;
  @override
  int? get closeCode => null;
  @override
  String? get closeReason => null;
  @override
  Future<void> get ready => Future.value();
  @override
  WebSocketSink get sink => _FakeSink(sent, texts);
  @override
  Stream get stream => incoming.stream;
}

class _FakeSink implements WebSocketSink {
  _FakeSink(this.sent, this.texts);
  final List<Uint8List> sent;
  final List<String> texts;
  @override
  void add(dynamic data) {
    if (data is Uint8List) {
      sent.add(data);
    } else if (data is String) {
      texts.add(data);
    }
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

class _RecordingH264Decoder implements H264Decoder {
  final StreamController<H264Frame> _frames =
      StreamController<H264Frame>.broadcast();
  final StreamController<String> _errors = StreamController<String>.broadcast();
  final List<Uint8List> decoded = <Uint8List>[];

  @override
  Stream<H264Frame> get frames => _frames.stream;

  @override
  Stream<String> get errors => _errors.stream;

  @override
  Future<bool> open() async => true;

  @override
  void decode(
    Uint8List annexB, {
    required int timestampUs,
    required bool key,
    required int width,
    required int height,
  }) {
    decoded.add(annexB);
  }

  @override
  Future<void> close() async {}

  void emit(int w, int h) {
    _frames.add(
      H264Frame(bytes: Uint8List(w * h * 4), width: w, height: h, key: true),
    );
  }
}

Uint8List _h264Frame(int type, List<int> payload) {
  final out = Uint8List(5 + payload.length);
  out[0] = type;
  out[4] = payload.length & 0xFF;
  out.setRange(5, out.length, payload);
  return out;
}

Uint8List _h264Config(int w, int h) =>
    _h264Frame(h264Config, utf8.encode(jsonEncode({'width': w, 'height': h})));

Uint8List _h264Key() {
  final pts = ByteData(8)..setUint64(0, 7, Endian.big);
  return _h264Frame(h264Key, [...pts.buffer.asUint8List(), 0, 0, 0, 1, 0x65]);
}

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

/// 每次建连都给一条新的假 WS（channels[i] 推数据、sent[i] 收客户端字节），
/// 每次要 H.264 解码器都给一个新的，方便断线重连的用例逐条驱动。
class _LiveRig {
  late final RemoteScreenService service;
  final urls = <Uri>[];
  final channels = <StreamController<dynamic>>[];
  final sent = <List<Uint8List>>[];
  final texts = <List<String>>[];
  final decoders = <_RecordingH264Decoder>[];
  final httpUrls = <Uri>[];
  final httpHeaders = <Map<String, String>>[];
  List<Uri> ticketEndpoints = <Uri>[];

  /// 第 [i] 条连接送上 config + 关键帧，并让对应解码器吐出一帧。
  Future<void> serveH264(int i) async {
    channels[i].add(_h264Config(4, 2));
    channels[i].add(_h264Key());
    await _pumpUntil(() => decoders.last.decoded.isNotEmpty);
    decoders.last.emit(4, 2);
  }

  Future<void> close() async {
    service.dispose();
    for (final c in channels) {
      if (!c.isClosed) await c.close();
    }
  }
}

Future<_LiveRig> _liveRig({
  required bool h264,
  List<Duration> retryDelays = const [Duration.zero],
  Duration recoverWindow = const Duration(seconds: 30),
  RtcPeerFactory? rtcPeerFactory,
}) async {
  SharedPreferences.setMockInitialValues({
    'multicc_host': 'http://localhost:3000',
    'multicc_token': '',
  });
  final settings = await SettingsService.getInstance();
  final rig = _LiveRig();
  rig.service = RemoteScreenService(
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
    channelFactory: (uri) {
      rig.urls.add(uri);
      final c = StreamController<dynamic>();
      final out = <Uint8List>[];
      final textOut = <String>[];
      rig.channels.add(c);
      rig.sent.add(out);
      rig.texts.add(textOut);
      return _FakeChannel(c, out, textOut);
    },
    httpClient: MockClient((request) async {
      if (request.url.path == '/api/remote-screen/capabilities') {
        return http.Response(
          jsonEncode({
            'ok': true,
            'supported': true,
            'streams': {'h264': h264, 'rfb': true},
          }),
          200,
        );
      }
      return http.Response.bytes(
        Uint8List.fromList([1, 2, 3]),
        200,
        headers: const {'X-Screen-Width': '4', 'X-Screen-Height': '2'},
      );
    }),
    h264DecoderFactory: () {
      final d = _RecordingH264Decoder();
      rig.decoders.add(d);
      return d;
    },
    rtcPeerFactory: rtcPeerFactory,
    liveRetryDelays: retryDelays,
    liveRecoverWindow: recoverWindow,
  );
  return rig;
}

/// 局域网直连的测试台：配置地址是**公网**域名，服务端自报一个局域网地址，
/// 走真实的 [RemoteLanResolver]（只把 HTTP 客户端和网卡地址换成桩）。
Future<_LiveRig> _lanRig({
  required bool h264,
  required http.Client resolverClient,
  required List<String> localAddresses,
  List<Duration> retryDelays = const [Duration(seconds: 5)],
  RtcPeerFactory? rtcPeerFactory,
  Duration probeTimeout = const Duration(seconds: 1),
  Duration totalBudget = const Duration(milliseconds: 1200),
}) async {
  final settings = await SettingsService.getInstance();
  await settings.save(
    host: 'https://vps.example.com',
    token: 'runner-token',
  );
  addTearDown(() => settings.save(host: 'http://localhost:3000', token: ''));

  final rig = _LiveRig();
  final ticketEndpoints = <Uri>[];
  rig.service = RemoteScreenService(
    settings: settings,
    wsTicketClient: WsTicketClient(
      post: (endpoint, {required headers, required body}) async {
        ticketEndpoints.add(endpoint);
        final requested = (jsonDecode(body) as Map<String, dynamic>)['path'];
        return http.Response(
          jsonEncode({'ok': true, 'ticket': 'fixture', 'path': requested}),
          200,
        );
      },
    ),
    channelFactory: (uri) {
      rig.urls.add(uri);
      final c = StreamController<dynamic>();
      final out = <Uint8List>[];
      final textOut = <String>[];
      rig.channels.add(c);
      rig.sent.add(out);
      rig.texts.add(textOut);
      return _FakeChannel(c, out, textOut);
    },
    httpClient: MockClient((request) async {
      rig.httpUrls.add(request.url);
      rig.httpHeaders.add(request.headers);
      if (request.url.path == '/api/remote-screen/capabilities') {
        return http.Response(
          jsonEncode({
            'ok': true,
            'supported': true,
            'streams': {'h264': h264, 'rfb': true},
          }),
          200,
        );
      }
      if (request.method == 'HEAD') {
        return http.Response.bytes(
          const [],
          200,
          headers: const {'X-Screen-Width': '4', 'X-Screen-Height': '2'},
        );
      }
      if (request.url.path == '/api/remote-screen/input') {
        return http.Response(jsonEncode({'ok': true}), 200);
      }
      if (request.url.path == '/api/system/agent-permissions') {
        return http.Response(
          jsonEncode({
            'ok': true,
            'applicable': true,
            'accessibility': true,
            'screenRecording': true,
          }),
          200,
        );
      }
      return http.Response.bytes(
        Uint8List.fromList([1, 2, 3]),
        200,
        headers: const {'X-Screen-Width': '4', 'X-Screen-Height': '2'},
      );
    }),
    h264DecoderFactory: () {
      final d = _RecordingH264Decoder();
      rig.decoders.add(d);
      return d;
    },
    lanResolver: RemoteLanResolver(
      client: resolverClient,
      localAddresses: () async => localAddresses,
      probeTimeout: probeTimeout,
      totalBudget: totalBudget,
    ),
    rtcPeerFactory: rtcPeerFactory,
    liveRetryDelays: retryDelays,
  );
  rig.ticketEndpoints = ticketEndpoints;
  return rig;
}

/// http 包的头部映射大小写不敏感，但测试桩里按名取值统一走这一条。
String? _headerOf(Map<String, String> headers, String name) {
  for (final entry in headers.entries) {
    if (entry.key.toLowerCase() == name) return entry.value;
  }
  return null;
}

/// 服务层的假 WebRTC 对端：只验证“信令接上了、帧和输入改走 DataChannel”。
class _ServiceFakePeer implements RtcPeer {
  final _opened = StreamController<void>.broadcast();
  final _closed = StreamController<void>.broadcast();
  final _incoming = StreamController<Uint8List>.broadcast();
  final _candidates = StreamController<Map<String, dynamic>>.broadcast();
  bool _open = false;
  final List<String> answers = <String>[];
  final List<Uint8List> sent = <Uint8List>[];

  @override
  Stream<void> get opened => _opened.stream;
  @override
  Stream<void> get closed => _closed.stream;
  @override
  Stream<Uint8List> get incoming => _incoming.stream;
  @override
  Stream<Map<String, dynamic>> get candidates => _candidates.stream;
  @override
  bool get isOpen => _open;
  @override
  Future<String> createOffer() async => 'fake-offer';
  @override
  Future<void> acceptAnswer(String sdp) async => answers.add(sdp);
  @override
  Future<void> addCandidate({
    required String candidate,
    String? sdpMid,
    int? sdpMLineIndex,
  }) async {}
  @override
  void send(Uint8List bytes) => sent.add(bytes);
  @override
  Future<void> close() async {
    _open = false;
    await _opened.close();
    await _closed.close();
    await _incoming.close();
    await _candidates.close();
  }

  void openChannel() {
    _open = true;
    _opened.add(null);
  }

  void emit(Uint8List bytes) => _incoming.add(bytes);
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
      await probe(
        await json({'ok': true, 'platform': 'darwin', 'supported': true}),
      ),
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

  test('live 中途断流 → 先自动重连；重连也起不来才回退轮询（旧 Agent 升级窗口期）', () async {
    final rig = await _liveRig(
      h264: false,
      retryDelays: const [Duration.zero],
      recoverWindow: Duration.zero,
    );
    addTearDown(rig.close);
    final service = rig.service;

    service.connectLive();
    await _pumpUntil(() => rig.channels.isNotEmpty);
    rig.channels[0].add(_rfbHello);
    await _pumpUntil(() => service.mode == RemoteScreenMode.live);
    expect(service.rfb, isNotNull);

    await rig.channels[0].close(); // 传输断开
    await _pumpUntil(() => rig.channels.length >= 2);
    expect(
      service.mode,
      RemoteScreenMode.connecting,
      reason: '跑起来过的流断了先重连，不直接降级',
    );
    // 重连上的不是 RFB（比如 Agent 正在升级）：这才回退轮询。
    rig.channels[1].add(Uint8List.fromList('HTTP/1.1 502'.codeUnits));
    await _pumpUntil(() => service.mode == RemoteScreenMode.fallback);
    await _pumpUntil(() => service.fallbackJpeg != null);
  });

  test('h264 可用时先连高清模式；跑起来后断流 → 重连的仍是高清，不降级到 RFB', () async {
    final rig = await _liveRig(h264: true);
    addTearDown(rig.close);
    final service = rig.service;

    service.connectLive();
    await _pumpUntil(() => rig.urls.isNotEmpty);
    expect(rig.urls.first.queryParameters['mode'], 'h264');
    await _pumpUntil(() => rig.sent[0].isNotEmpty); // 建连后先要关键帧
    expect(rig.sent[0].first, [h264ReqKey]);
    await rig.serveH264(0);
    await _pumpUntil(() => service.mode == RemoteScreenMode.live);
    expect(service.h264Active, isTrue);
    expect(service.source, isNotNull);

    // 切后台 / 移动网络抖动：连接没了。
    await rig.channels[0].close();
    await _pumpUntil(() => service.mode == RemoteScreenMode.connecting);
    await _pumpUntil(() => rig.urls.length >= 2);
    expect(
      rig.urls[1].queryParameters['mode'],
      'h264',
      reason: '重连仍走高清，不是一断就永久降到流畅模式',
    );
    await _pumpUntil(() => rig.sent[1].isNotEmpty);
    await rig.serveH264(1);
    await _pumpUntil(() => service.mode == RemoteScreenMode.live);
    expect(service.h264Active, isTrue);
    expect(rig.decoders.length, 2, reason: '每次重连换一个新解码器');
  });

  test('高清流反复重连都起不来（超过恢复窗口）→ 交给降级链退 RFB', () async {
    final rig = await _liveRig(
      h264: true,
      retryDelays: const [Duration.zero],
      recoverWindow: Duration.zero,
    );
    addTearDown(rig.close);
    final service = rig.service;

    service.connectLive();
    await _pumpUntil(() => rig.sent.isNotEmpty && rig.sent[0].isNotEmpty);
    await rig.serveH264(0);
    await _pumpUntil(() => service.mode == RemoteScreenMode.live);

    await rig.channels[0].close();
    await _pumpUntil(() => rig.urls.length >= 2);
    expect(rig.urls[1].queryParameters['mode'], 'h264');
    await rig.channels[1].close(); // 重连上就断、一帧没出
    await _pumpUntil(() => rig.urls.length >= 3);
    expect(rig.urls[2].queryParameters.containsKey('mode'), isFalse);
    rig.channels[2].add(_rfbHello);
    await _pumpUntil(
      () => service.mode == RemoteScreenMode.live && service.rfb != null,
    );
    expect(service.h264Active, isFalse);
  });

  test('回到前台 resumeLive：重新按高清优先建连；框选裁剪（HTTP 轮询）不打断', () async {
    final rig = await _liveRig(h264: true);
    addTearDown(rig.close);
    final service = rig.service;

    service.connectLive();
    await _pumpUntil(() => rig.sent.isNotEmpty && rig.sent[0].isNotEmpty);
    await rig.serveH264(0);
    await _pumpUntil(() => service.mode == RemoteScreenMode.live);

    service.resumeLive();
    await _pumpUntil(() => rig.urls.length >= 2);
    expect(rig.urls[1].queryParameters['mode'], 'h264');

    service.region = const ScreenRegion(0, 0, 10, 10);
    final before = rig.urls.length;
    service.resumeLive();
    await Future<void>.delayed(const Duration(milliseconds: 50));
    expect(rig.urls.length, before);
    expect(service.region, isNotNull);
  });

  // —— ⑤ WebRTC P2P 直连：信令接在远控 WS 上，画面按 rtc-active 切来源 ——

  test('P2P：rtc-active 之后 linkPath=p2p，帧与输入走 DataChannel，退回后回局域网', () async {
    final peers = <_ServiceFakePeer>[];
    final rig = await _liveRig(
      h264: true,
      rtcPeerFactory: (_) async {
        final peer = _ServiceFakePeer();
        peers.add(peer);
        return peer;
      },
    );
    addTearDown(rig.close);
    final service = rig.service;

    service.connectLive();
    await _pumpUntil(() => rig.sent.isNotEmpty && rig.sent[0].isNotEmpty);
    await rig.serveH264(0);
    await _pumpUntil(() => service.mode == RemoteScreenMode.live);
    // 配置地址是 localhost（模拟器/同机联调）：本来就算局域网。
    expect(service.linkPath.value, RemoteLinkPath.lan);

    rig.channels[0].add(
      jsonEncode({
        't': 'rtc-hello',
        'iceServers': [
          {
            'urls': ['stun:stun.l.google.com:19302'],
          },
        ],
      }),
    );
    await _pumpUntil(() => peers.isNotEmpty);
    await _pumpUntil(
      () => rig.texts[0].any((text) => text.contains('rtc-offer')),
    );
    final offer =
        jsonDecode(rig.texts[0].last) as Map;
    expect(offer['t'], 'rtc-offer');
    expect(offer['sdp'], 'fake-offer');

    rig.channels[0].add(jsonEncode({'t': 'rtc-answer', 'sdp': 'answer-sdp'}));
    await _pumpUntil(() => peers.single.answers.isNotEmpty);
    expect(peers.single.answers.single, 'answer-sdp');

    peers.single.openChannel();
    rig.channels[0].add(jsonEncode({'t': 'rtc-active', 'on': true}));
    await _pumpUntil(() => service.linkPath.value == RemoteLinkPath.p2p);

    // DataChannel 的完整帧进解码器。
    final before = rig.decoders.last.decoded.length;
    peers.single.emit(_h264Key());
    await _pumpUntil(() => rig.decoders.last.decoded.length > before);

    // 直连期间 WS 上的残余帧被丢掉（切换前已经在路上的那几帧）。
    rig.channels[0].add(_h264Key());
    await Future<void>.delayed(const Duration(milliseconds: 60));
    expect(rig.decoders.last.decoded.length, before + 1);

    // 输入改走 DataChannel，WS 上不再出现输入字节。
    final wsBytes = rig.sent[0].length;
    service.source!.pointerEvent(1, 10, 20);
    await _pumpUntil(() => peers.single.sent.isNotEmpty);
    expect(rig.sent[0].length, wsBytes);
    expect(peers.single.sent.single[0], 5);

    // 服务端说直连没了：回局域网，WS 帧重新生效（服务端会补关键帧）。
    rig.channels[0].add(jsonEncode({'t': 'rtc-active', 'on': false}));
    await _pumpUntil(() => service.linkPath.value == RemoteLinkPath.lan);
    final afterDirect = rig.decoders.last.decoded.length;
    rig.channels[0].add(_h264Key());
    await _pumpUntil(
      () => rig.decoders.last.decoded.length > afterDirect,
    );
    expect(service.mode, RemoteScreenMode.live);

    // 退回中继后输入不再进 DataChannel。
    final peerBytes = peers.single.sent.length;
    service.source!.pointerEvent(1, 11, 21);
    await _pumpUntil(() => rig.sent[0].length > wsBytes);
    expect(peers.single.sent.length, peerBytes);
  });

  // —— ④ 同一 Wi‑Fi：采用服务端自报的局域网地址 ——

  test('同一 Wi‑Fi：换票 / WS / 输入 / 尺寸探测 / 轮询帧全走局域网地址', () async {
    final resolverCalls = <String>[];
    final resolverClient = MockClient((request) async {
      resolverCalls.add('${request.url.host}:${request.url.port}');
      if (request.url.host == 'vps.example.com') {
        return http.Response(
          jsonEncode({
            'ok': true,
            'startedAt': '2026-10-25T10:00:00.000Z',
            'lanUrls': ['http://192.168.1.50:3000'],
          }),
          200,
        );
      }
      if (request.url.host == '192.168.1.50') {
        return http.Response(
          jsonEncode({'startedAt': '2026-10-25T10:00:00.000Z'}),
          200,
        );
      }
      return http.Response('', 404);
    });
    final rig = await _lanRig(
      h264: false,
      resolverClient: resolverClient,
      localAddresses: const ['192.168.1.10'],
    );
    addTearDown(rig.close);
    final service = rig.service;

    service.connectLive();
    await _pumpUntil(() => rig.urls.isNotEmpty);
    rig.channels[0].add(_rfbHello);
    await _pumpUntil(() => service.mode == RemoteScreenMode.live);

    expect(service.linkPath.value, RemoteLinkPath.lan);
    expect(rig.urls.single.host, '192.168.1.50');
    expect(rig.urls.single.port, 3000);
    expect(rig.ticketEndpoints.single.host, '192.168.1.50');
    // 能力查询与选路并行发出（首次开屏少等一个隧道往返），所以走配置地址；
    // 同一服务进程，答案一样。
    expect(
      rig.httpUrls
          .where((url) => url.path == '/api/remote-screen/capabilities')
          .single
          .host,
      'vps.example.com',
    );
    final capabilitiesHeaders = rig.httpHeaders[
        rig.httpUrls.indexWhere(
          (url) => url.path == '/api/remote-screen/capabilities',
        )];
    expect(_headerOf(capabilitiesHeaders, 'x-access-token'), 'runner-token');

    await service.inputOp({'op': 'status'});
    expect(
      rig.httpUrls
          .where((url) => url.path == '/api/remote-screen/input')
          .single
          .host,
      '192.168.1.50',
    );

    expect(await service.ensureScreenSize(), isTrue);
    final head = rig.httpUrls.last;
    expect(head.host, '192.168.1.50');
    expect(head.path, '/api/remote-screen/frame');

    await service.agentPermissions();
    expect(
      rig.httpUrls
          .where((url) => url.path == '/api/system/agent-permissions')
          .single
          .host,
      '192.168.1.50',
    );

    // JPEG 轮询（框选裁剪）也走局域网地址。
    service.selectRegion(null);
    await _pumpUntil(
      () => rig.httpUrls.any(
        (url) =>
            url.path == '/api/remote-screen/frame' &&
            url.host == '192.168.1.50' &&
            url.queryParameters.isEmpty,
      ),
    );
    expect(
      rig.httpUrls.any(
        (url) =>
            url.host == 'vps.example.com' &&
            url.path != '/api/remote-screen/capabilities',
      ),
      isFalse,
      reason: '采用局域网后不该再有请求打隧道（选路前并行发出的能力查询除外）',
    );
    // 探测只问了配置地址和那个局域网地址各一次。
    expect(resolverCalls, ['vps.example.com:443', '192.168.1.50:3000']);
  });

  test('startedAt 不一致（陌生设备占用了同 IP）→ 不采用，继续走配置地址', () async {
    final resolverClient = MockClient((request) async {
      if (request.url.host == 'vps.example.com') {
        return http.Response(
          jsonEncode({
            'startedAt': 'T1',
            'lanUrls': ['http://192.168.1.50:3000'],
          }),
          200,
        );
      }
      return http.Response(jsonEncode({'startedAt': 'T2'}), 200);
    });
    final rig = await _lanRig(
      h264: false,
      resolverClient: resolverClient,
      localAddresses: const ['192.168.1.10'],
    );
    addTearDown(rig.close);
    final service = rig.service;

    service.connectLive();
    await _pumpUntil(() => rig.urls.isNotEmpty);
    rig.channels[0].add(_rfbHello);
    await _pumpUntil(() => service.mode == RemoteScreenMode.live);

    expect(service.linkPath.value, RemoteLinkPath.relay);
    expect(rig.urls.single.host, 'vps.example.com');
    expect(rig.ticketEndpoints.single.host, 'vps.example.com');
    expect(
      rig.httpUrls.every((url) => url.host == 'vps.example.com'),
      isTrue,
    );
  });

  test('局域网探测超时（总预算 1.2 秒）→ 立刻回落配置地址', () async {
    final resolverClient = MockClient((request) async {
      if (request.url.host == 'vps.example.com') {
        return http.Response(
          jsonEncode({
            'startedAt': 'T1',
            'lanUrls': ['http://192.168.1.50:3000'],
          }),
          200,
        );
      }
      await Future<void>.delayed(const Duration(milliseconds: 400));
      return http.Response(jsonEncode({'startedAt': 'T1'}), 200);
    });
    final rig = await _lanRig(
      h264: false,
      resolverClient: resolverClient,
      localAddresses: const ['192.168.1.10'],
      probeTimeout: const Duration(milliseconds: 60),
      totalBudget: const Duration(milliseconds: 90),
    );
    addTearDown(rig.close);
    final service = rig.service;

    final watch = Stopwatch()..start();
    service.connectLive();
    await _pumpUntil(() => rig.urls.isNotEmpty, const Duration(seconds: 2));
    watch.stop();

    expect(watch.elapsedMilliseconds, lessThan(800));
    expect(rig.urls.single.host, 'vps.example.com');
    expect(service.linkPath.value, RemoteLinkPath.relay);
  });

  test('局域网断了立刻改回配置地址重连（不等退避、不降级）；下一次重连再探测', () async {
    var resolverConfiguredCalls = 0;
    var resolverLanCalls = 0;
    final resolverClient = MockClient((request) async {
      if (request.url.host == 'vps.example.com') {
        resolverConfiguredCalls += 1;
        return http.Response(
          jsonEncode({
            'startedAt': 'T1',
            'lanUrls': ['http://192.168.1.50:3000'],
          }),
          200,
        );
      }
      resolverLanCalls += 1;
      return http.Response(jsonEncode({'startedAt': 'T1'}), 200);
    });
    final rig = await _lanRig(
      h264: false,
      resolverClient: resolverClient,
      localAddresses: const ['192.168.1.10'],
      // 常规重连退避 5 秒：局域网 failover 要绕过它，否则用户会白等 5 秒。
      retryDelays: const [Duration(seconds: 5)],
    );
    addTearDown(rig.close);
    final service = rig.service;

    service.connectLive();
    await _pumpUntil(() => rig.urls.isNotEmpty);
    rig.channels[0].add(_rfbHello);
    await _pumpUntil(() => service.mode == RemoteScreenMode.live);
    expect(service.linkPath.value, RemoteLinkPath.lan);
    expect(resolverConfiguredCalls, 1);
    expect(resolverLanCalls, 1);

    // 手机离开 Wi‑Fi：局域网这条流断了。
    final watch = Stopwatch()..start();
    await rig.channels[0].close();
    await _pumpUntil(
      () => rig.urls.length >= 2,
      const Duration(seconds: 2),
    );
    watch.stop();

    expect(
      watch.elapsedMilliseconds,
      lessThan(1000),
      reason: '局域网失败要立刻换回配置地址，不走 5 秒退避',
    );
    expect(rig.urls[1].host, 'vps.example.com');
    expect(
      service.mode,
      isNot(RemoteScreenMode.fallback),
      reason: '换网不是链路质量差，不能一路降级到 JPEG 轮询',
    );
    expect(rig.ticketEndpoints[1].host, 'vps.example.com');
    expect(
      resolverConfiguredCalls,
      1,
      reason: '这一次直接用配置地址，不再等探测',
    );

    rig.channels[1].add(_rfbHello);
    await _pumpUntil(() => service.mode == RemoteScreenMode.live);
    expect(service.linkPath.value, RemoteLinkPath.relay);

    // 下一次重连（回到前台 / 再断一次）重新探测局域网。
    service.resumeLive();
    await _pumpUntil(
      () => rig.urls.length >= 3,
      const Duration(seconds: 2),
    );
    expect(resolverConfiguredCalls, 2);
    expect(resolverLanCalls, 2);
    expect(rig.urls[2].host, '192.168.1.50');
    expect(service.linkPath.value, RemoteLinkPath.lan);
  });
}
