import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;
import 'package:web_socket_channel/web_socket_channel.dart';

import 'remote_screen_rfb.dart';
import 'settings_service.dart';
import 'ws_ticket_service.dart';

/// Transport for the 「🖥 屏幕」 live screen.
///
/// Preferred path is the Agent's RFB stream over /ws/remote-screen (same
/// ws-ticket exchange as every other socket, see MulticcWsPath). When the
/// stream is unavailable — old Agent, macOS < 14, capture denied — the
/// service degrades to the JPEG polling endpoint and keeps serving frames
/// ([fallbackJpeg]); pointer/keyboard input goes through the same guarded
/// /api/remote-screen/input route either way.
enum RemoteScreenMode { connecting, live, fallback }

class RemoteScreenService {
  RemoteScreenService({
    required this.settings,
    WsTicketClient? wsTicketClient,
    WebSocketChannel Function(Uri)? channelFactory,
    http.Client? httpClient,
  }) : _wsAuth = WsTicketConnectionGate(wsTicketClient ?? WsTicketClient()),
       _connectChannel = channelFactory ?? WebSocketChannel.connect,
       _http = httpClient ?? http.Client();

  final SettingsService settings;
  final WsTicketConnectionGate _wsAuth;
  final WebSocketChannel Function(Uri) _connectChannel;
  final http.Client _http;

  WebSocketChannel? _channel;
  RemoteScreenRfb? _rfb;
  Timer? _handshakeTimeout;
  Timer? _pollTimer;
  bool _polling = false;
  bool _disposed = false;

  RemoteScreenMode mode = RemoteScreenMode.connecting;
  String? error;
  RemoteScreenRfb? get rfb => _rfb;

  /// Latest JPEG frame while in fallback mode (null otherwise).
  Uint8List? fallbackJpeg;
  int fallbackWidth = 0;
  int fallbackHeight = 0;

  final _frames = StreamController<void>.broadcast();
  Stream<void> get onFrame => _frames.stream;
  final _modeCtrl = StreamController<void>.broadcast();
  Stream<void> get onModeChange => _modeCtrl.stream;

  Map<String, String> get _headers {
    final h = <String, String>{'Content-Type': 'application/json'};
    if (settings.token.isNotEmpty) h['X-Access-Token'] = settings.token;
    return h;
  }

  /// Connects the live RFB stream; on any failure settles into fallback.
  void connectLive() {
    if (_disposed) return;
    _setMode(RemoteScreenMode.connecting, null);
    _stopFallback();
    _handshakeTimeout?.cancel();
    _handshakeTimeout = Timer(const Duration(seconds: 8), () {
      if (mode == RemoteScreenMode.connecting && !_disposed) _enterFallback();
    });

    late WsTicketAttempt attempt;
    try {
      attempt = _wsAuth.begin(
        socketUri: buildMulticcWebSocketUri(
          host: settings.host,
          path: MulticcWsPath.remoteScreen,
        ),
        ticketEndpoint: Uri.parse(settings.buildHttpUrl('/api/auth/ws-ticket')),
        accessToken: settings.token,
      );
    } catch (_) {
      _enterFallback();
      return;
    }
    unawaited(
      _connectAuthorized(attempt).catchError((Object _) {
        if (!_disposed && attempt.isCurrent) _enterFallback();
      }),
    );
  }

  Future<void> _connectAuthorized(WsTicketAttempt attempt) async {
    final url = await attempt.authorizedUri;
    if (_disposed || !attempt.isCurrent) return;
    final channel = _connectChannel(url);
    if (_disposed || !attempt.isCurrent) {
      await channel.sink.close();
      return;
    }
    _stopRfb();
    _channel = channel;
    _rfb = RemoteScreenRfb(
      incoming: channel.stream.map<Uint8List>(
        (dynamic d) => d is Uint8List ? d : Uint8List.fromList(d as List<int>),
      ),
      send: (Uint8List bytes) {
        if (!attempt.isCurrent) return;
        channel.sink.add(bytes);
      },
      onClosed: () {
        if (!_disposed && attempt.isCurrent) _enterFallback();
      },
      onFrame: _onRfbFrame,
    );
    unawaited(
      _rfb!.run().catchError((Object _) {
        if (!_disposed && attempt.isCurrent) _enterFallback();
      }),
    );
  }

  void _onRfbFrame() {
    final r = _rfb;
    if (r != null && r.width > 0 && mode != RemoteScreenMode.live) {
      _setMode(RemoteScreenMode.live, null);
    }
    _frames.add(null);
  }

  /// 权限门：Agent 的屏幕录制 / 辅助功能授权状态（与 Web Air 全局设置
  /// 「检查授权」同源的 /api/system/agent-permissions）。`applicable=false`
  /// 表示非 macOS 或无法判定，调用方应直接放行。
  Future<Map<String, dynamic>> agentPermissions() async {
    try {
      final headers = <String, String>{};
      if (settings.token.isNotEmpty) {
        headers['X-Access-Token'] = settings.token;
      }
      final res = await _http
          .get(
            Uri.parse(settings.buildHttpUrl('/api/system/agent-permissions')),
            headers: headers,
          )
          .timeout(const Duration(seconds: 10));
      final decoded = jsonDecode(res.body);
      return decoded is Map<String, dynamic>
          ? decoded
          : {'ok': false, 'applicable': false};
    } catch (_) {
      return {'ok': false, 'applicable': false};
    }
  }

  /// 打开系统设置里对应权限的面板（服务端只放行本机请求；远程访客会拿到
  /// 403，UI 据此只显示提示文案不给按钮）。
  Future<void> openPermission(String permission) async {
    try {
      await _http
          .post(
            Uri.parse(
              settings.buildHttpUrl('/api/system/agent-permissions/open'),
            ),
            headers: _headers,
            body: jsonEncode({'permission': permission}),
          )
          .timeout(const Duration(seconds: 10));
    } catch (_) {}
  }

  /// One guarded input op (click / type / press / status / resume / release).
  Future<Map<String, dynamic>> inputOp(Map<String, dynamic> body) async {
    try {
      final res = await _http
          .post(
            Uri.parse(settings.buildHttpUrl('/api/remote-screen/input')),
            headers: _headers,
            body: jsonEncode(body),
          )
          .timeout(const Duration(seconds: 12));
      final decoded = jsonDecode(res.body);
      return decoded is Map<String, dynamic> ? decoded : {'ok': false};
    } catch (_) {
      return {'ok': false, 'error': 'network'};
    }
  }

  void _enterFallback() {
    if (_disposed) return;
    _handshakeTimeout?.cancel();
    _handshakeTimeout = null;
    _stopRfb();
    if (mode != RemoteScreenMode.fallback) {
      _setMode(RemoteScreenMode.fallback, null);
    }
    _pollTimer ??= Timer.periodic(const Duration(milliseconds: 700), (_) {
      unawaited(_pollFrame());
    });
    unawaited(_pollFrame());
  }

  Future<void> _pollFrame() async {
    if (_polling || _disposed) return;
    _polling = true;
    try {
      final headers = <String, String>{};
      if (settings.token.isNotEmpty) {
        headers['X-Access-Token'] = settings.token;
      }
      final res = await _http
          .get(
            Uri.parse(settings.buildHttpUrl('/api/remote-screen/frame')),
            headers: headers,
          )
          .timeout(const Duration(seconds: 10));
      if (res.statusCode == 200 && res.bodyBytes.isNotEmpty) {
        fallbackJpeg = res.bodyBytes;
        // dart:io 与 MockClient 对响应头大小写的保留不一致，按名查找必须
        // 大小写不敏感（X-Screen-Width / x-screen-width 都要能命中）。
        fallbackWidth =
            int.tryParse(_header(res.headers, 'x-screen-width') ?? '') ??
            fallbackWidth;
        fallbackHeight =
            int.tryParse(_header(res.headers, 'x-screen-height') ?? '') ??
            fallbackHeight;
        _frames.add(null);
      }
    } catch (_) {
      // Keep polling; the UI shows the last frame plus a status line.
    } finally {
      _polling = false;
    }
  }

  void _setMode(RemoteScreenMode next, String? err) {
    mode = next;
    error = err;
    _modeCtrl.add(null);
  }

  static String? _header(Map<String, String> headers, String lowerName) {
    for (final entry in headers.entries) {
      if (entry.key.toLowerCase() == lowerName) return entry.value;
    }
    return null;
  }

  void _stopRfb() {
    _channel?.sink.close().catchError((Object _) {});
    _channel = null;
    _rfb = null;
  }

  void _stopFallback() {
    _pollTimer?.cancel();
    _pollTimer = null;
  }

  void dispose() {
    _disposed = true;
    _wsAuth.invalidate();
    _handshakeTimeout?.cancel();
    _stopRfb();
    _stopFallback();
    unawaited(_frames.close());
    unawaited(_modeCtrl.close());
    _http.close();
  }
}
