import 'dart:async';
import 'dart:convert';
import 'package:web_socket_channel/web_socket_channel.dart';
import 'package:xterm/xterm.dart';

import 'settings_service.dart';
import 'ws_ticket_service.dart';

enum TerminalConnectionState { disconnected, connecting, connected }

class TerminalService {
  final SettingsService settings;
  final String sessionId;
  final Terminal terminal;
  final WsTicketConnectionGate _wsAuth;
  final WebSocketChannel Function(Uri) _connectChannel;

  WebSocketChannel? _channel;
  StreamSubscription? _sub;

  TerminalConnectionState _state = TerminalConnectionState.disconnected;
  TerminalConnectionState get state => _state;

  final _stateCtrl = StreamController<TerminalConnectionState>.broadcast();
  Stream<TerminalConnectionState> get onStateChange => _stateCtrl.stream;

  int _reconnectAttempt = 0;
  Timer? _reconnectTimer;
  bool _disposed = false;

  // Track last sent size to avoid no-op resizes
  int _lastCols = 0;
  int _lastRows = 0;

  TerminalService({
    required this.settings,
    required this.sessionId,
    WsTicketClient? wsTicketClient,
    WebSocketChannel Function(Uri)? channelFactory,
  }) : terminal = Terminal(maxLines: 5000),
       _wsAuth = WsTicketConnectionGate(wsTicketClient ?? WsTicketClient()),
       _connectChannel = channelFactory ?? WebSocketChannel.connect {
    terminal.onOutput = _onTerminalOutput;
    terminal.onResize = (w, h, pw, ph) => _onTerminalResize(w, h);
  }

  void connect() {
    if (_disposed) return;
    _reconnectTimer?.cancel();
    _state = TerminalConnectionState.connecting;
    _stateCtrl.add(_state);

    late WsTicketAttempt attempt;
    try {
      attempt = _wsAuth.begin(
        socketUri: _buildUri(),
        ticketEndpoint: Uri.parse(settings.buildHttpUrl('/api/auth/ws-ticket')),
        accessToken: settings.token,
      );
    } catch (_) {
      _scheduleReconnect();
      return;
    }
    unawaited(_connectAuthorized(attempt));
  }

  Future<void> _connectAuthorized(WsTicketAttempt attempt) async {
    try {
      final url = await attempt.authorizedUri;
      if (_disposed || !attempt.isCurrent) return;
      final channel = _connectChannel(url);
      if (_disposed || !attempt.isCurrent) {
        await channel.sink.close();
        return;
      }
      _channel = channel;
      _sub?.cancel();
      _sub = channel.stream.listen(
        _onMessage,
        onError: (_) {
          if (attempt.isCurrent && _channel == channel) _scheduleReconnect();
        },
        onDone: () {
          if (attempt.isCurrent && _channel == channel) _scheduleReconnect();
        },
      );
      channel.ready
          .then((_) {
            if (_disposed || !attempt.isCurrent || _channel != channel) return;
            _lastCols = 0;
            _lastRows = 0;
            _state = TerminalConnectionState.connected;
            _reconnectAttempt = 0;
            _stateCtrl.add(_state);
            _sendResize(terminal.viewWidth, terminal.viewHeight);
          })
          .catchError((_) {
            if (!_disposed && attempt.isCurrent && _channel == channel) {
              _scheduleReconnect();
            }
          });
    } catch (_) {
      if (!_disposed && attempt.isCurrent) _scheduleReconnect();
    }
  }

  Uri _buildUri() {
    final params = <String, String>{'id': sessionId};
    return buildMulticcWebSocketUri(
      host: settings.host,
      path: MulticcWsPath.terminal,
      query: params,
    );
  }

  void _onMessage(dynamic raw) {
    String text;
    if (raw is String) {
      text = raw;
    } else if (raw is List<int>) {
      text = utf8.decode(raw, allowMalformed: true);
    } else {
      return;
    }

    dynamic msg;
    try {
      msg = jsonDecode(text);
    } catch (_) {
      terminal.write(text);
      return;
    }
    if (msg is! Map) {
      terminal.write(text);
      return;
    }

    final type = msg['type'];
    switch (type) {
      case 'output':
      case 'error':
      case 'exit':
        final data = msg['data'];
        if (data is String) terminal.write(data);
        break;
      case 'restart':
        terminal.write('\x1b[2J\x1b[H\x1b[33m[Restarting Claude…]\x1b[0m\r\n');
        break;
      case 'relocate':
        final cwd = msg['cwd'] ?? '';
        terminal.write('\x1b[2J\x1b[H\x1b[33m[Switching to: $cwd]\x1b[0m\r\n');
        break;
      case 'session_id':
      case 'file_saved':
        break;
      default:
        final data = msg['data'];
        if (data is String) terminal.write(data);
    }
  }

  void _onTerminalOutput(String data) {
    if (_channel == null) return;
    try {
      _channel!.sink.add(jsonEncode({'type': 'input', 'data': data}));
    } catch (_) {}
  }

  void _onTerminalResize(int width, int height) {
    _sendResize(width, height);
  }

  void _sendResize(int cols, int rows) {
    if (cols == _lastCols && rows == _lastRows) return;
    if (cols <= 0 || rows <= 0) return;
    _lastCols = cols;
    _lastRows = rows;
    try {
      _channel?.sink.add(
        jsonEncode({'type': 'resize', 'cols': cols, 'rows': rows}),
      );
    } catch (_) {}
  }

  void _scheduleReconnect() {
    if (_disposed) return;
    _wsAuth.invalidate();
    _state = TerminalConnectionState.disconnected;
    _stateCtrl.add(_state);

    final delay = Duration(
      milliseconds: (_reconnectAttempt < 5)
          ? (1000 * (1 << _reconnectAttempt)).clamp(0, 15000)
          : 15000,
    );
    _reconnectAttempt++;

    _reconnectTimer = Timer(delay, () {
      if (!_disposed) connect();
    });
  }

  void manualReconnect() {
    _reconnectAttempt = 0;
    _wsAuth.invalidate();
    _sub?.cancel();
    _channel?.sink.close();
    connect();
  }

  void dispose() {
    _disposed = true;
    _wsAuth.invalidate();
    _reconnectTimer?.cancel();
    _sub?.cancel();
    _channel?.sink.close();
    _stateCtrl.close();
  }
}
