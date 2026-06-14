import 'dart:async';
import 'dart:convert';
import 'package:web_socket_channel/web_socket_channel.dart';

import 'settings_service.dart';

enum ChatConnectionState { disconnected, connecting, connected }

class ChatEvent {
  final String type;
  final dynamic payload;
  ChatEvent(this.type, this.payload);
}

class ChatService {
  final SettingsService settings;
  final String sessionName;
  final String sessionCwd;

  WebSocketChannel? _channel;
  StreamSubscription? _sub;
  final _controller = StreamController<ChatEvent>.broadcast();

  ChatConnectionState _state = ChatConnectionState.disconnected;
  ChatConnectionState get state => _state;

  String? _sessionId;
  String? get sessionId => _sessionId;

  int _reconnectAttempt = 0;
  Timer? _reconnectTimer;
  bool _disposed = false;
  bool isStreaming = false;

  // ── Heartbeat: detect "half-open" sockets ──
  // When the phone sleeps / network switches, the OS can freeze the socket
  // without ever firing onDone/onError, leaving a dead connection that still
  // looks `connected`. We ping periodically and, if no traffic arrives for a
  // while, treat the socket as dead and reconnect — instead of the user being
  // stuck with a frozen chat that only an app restart could fix.
  Timer? _heartbeatTimer;
  DateTime _lastActivity = DateTime.now();
  static const _pingInterval = Duration(seconds: 15);
  static const _staleThreshold = Duration(seconds: 35);

  Stream<ChatEvent> get events => _controller.stream;

  String? initialSessionId;

  ChatService({
    required this.settings,
    required this.sessionName,
    required this.sessionCwd,
    this.initialSessionId,
  });

  String _buildChatUrl({String? resumeId}) {
    var h = settings.host.replaceAll(RegExp(r'/$'), '');
    final isHttps = h.startsWith('https://');
    final wsScheme = isHttps ? 'wss' : 'ws';
    final bare = h.replaceFirst(RegExp(r'^https?://'), '');

    final params = <String, String>{};
    if (settings.token.isNotEmpty) params['token'] = settings.token;
    if (sessionCwd.isNotEmpty) params['cwd'] = sessionCwd;
    if (sessionName.isNotEmpty) params['session'] = sessionName;
    if (resumeId != null && resumeId.isNotEmpty) params['resume'] = resumeId;

    final query = params.entries
        .map((e) => '${Uri.encodeQueryComponent(e.key)}=${Uri.encodeQueryComponent(e.value)}')
        .join('&');

    return '$wsScheme://$bare/ws/chat${query.isNotEmpty ? '?$query' : ''}';
  }

  void connect() {
    if (_disposed) return;
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    _heartbeatTimer?.cancel();
    _heartbeatTimer = null;

    _state = ChatConnectionState.connecting;
    _emit('state_change', _state);

    final url = _buildChatUrl(resumeId: _sessionId ?? initialSessionId);
    try {
      final channel = WebSocketChannel.connect(Uri.parse(url));
      _channel = channel;
      _sub?.cancel();
      _sub = channel.stream.listen(
        _onMessage,
        onError: (_) => _scheduleReconnect(),
        onDone: _scheduleReconnect,
      );
      // Don't claim "connected" until the WebSocket handshake actually
      // completes — connect() returns immediately and a failed handshake only
      // surfaces asynchronously. Marking connected early would leave a dead
      // socket showing a green dot with no way to manually reconnect.
      channel.ready.then((_) {
        if (_disposed || _channel != channel) return;
        _state = ChatConnectionState.connected;
        _reconnectAttempt = 0;
        _lastActivity = DateTime.now();
        _startHeartbeat();
        _emit('state_change', _state);
      }).catchError((_) {
        if (_disposed || _channel != channel) return;
        _scheduleReconnect();
      });
    } catch (_) {
      _scheduleReconnect();
    }
  }

  void _onMessage(dynamic raw) {
    // Any inbound frame (including `pong`) proves the socket is alive.
    _lastActivity = DateTime.now();
    try {
      final msg = jsonDecode(raw as String) as Map<String, dynamic>;
      if (msg['type'] == 'pong') return;
      _handleMessage(msg);
    } catch (_) {}
  }

  void _startHeartbeat() {
    _heartbeatTimer?.cancel();
    _heartbeatTimer = Timer.periodic(_pingInterval, (_) {
      if (_disposed || _state != ChatConnectionState.connected) return;
      // No traffic since the last ping cycle → the socket is half-open/dead.
      if (DateTime.now().difference(_lastActivity) > _staleThreshold) {
        _scheduleReconnect();
        return;
      }
      try {
        _channel?.sink.add(jsonEncode({'type': 'ping'}));
      } catch (_) {
        _scheduleReconnect();
      }
    });
  }

  void _handleMessage(Map<String, dynamic> msg) {
    final type = msg['type'] as String? ?? '';
    switch (type) {
      case 'system':
        if (msg['subtype'] == 'init') {
          // Only the server's own init carries `is_streaming`. Claude CLI's
          // stream-json emits a `system/init` event too, but without this
          // field — it must not be treated as a (re)connect init, otherwise
          // it fires the "completed while disconnected" warning every turn.
          if (!msg.containsKey('is_streaming')) break;

          _sessionId = (msg['session_id'] ?? msg['session'] ?? _sessionId)?.toString();
          final serverStreaming = msg['is_streaming'] == true;
          if (serverStreaming != isStreaming) {
            isStreaming = serverStreaming;
          }
          _emit('system_init', msg);
        } else if (msg['message'] != null) {
          _emit('system_msg', msg['message'].toString());
        }
        break;

      case 'session_id':
        if (msg['id'] != null) _sessionId = msg['id'].toString();
        break;

      case 'chat_history':
        final messages = msg['messages'];
        if (messages is List) {
          _emit('chat_history', messages);
        }
        break;

      case 'stream_event':
        final evt = msg['event'];
        if (evt is Map<String, dynamic>) {
          _handleStreamEvent(evt);
        }
        break;

      case 'result':
        isStreaming = false;
        _emit('result', msg);
        break;

      case 'error':
        isStreaming = false;
        _emit('error', msg['error']?.toString() ?? 'Unknown error');
        break;

      default:
        break;
    }
  }

  void _handleStreamEvent(Map<String, dynamic> evt) {
    final evtType = evt['type'] as String? ?? '';
    switch (evtType) {
      case 'message_start':
        isStreaming = true;
        _emit('message_start', evt);
        break;
      case 'content_block_start':
        _emit('content_block_start', evt);
        break;
      case 'content_block_delta':
        _emit('content_block_delta', evt);
        break;
      case 'content_block_stop':
        _emit('content_block_stop', evt);
        break;
      case 'message_delta':
        _emit('message_delta', evt);
        break;
      case 'message_stop':
        break;
    }
  }

  /// Returns false if the socket isn't healthy — the caller should not show the
  /// message as sent. Also kicks off a reconnect so the next attempt can work.
  bool send(String text) {
    if (_channel == null || _state != ChatConnectionState.connected) {
      connect();
      return false;
    }
    try {
      _channel!.sink.add(jsonEncode({'type': 'user_message', 'text': text}));
      isStreaming = true;
      return true;
    } catch (_) {
      _scheduleReconnect();
      return false;
    }
  }

  void cancel() {
    try {
      _channel?.sink.add(jsonEncode({'type': 'cancel'}));
    } catch (_) {}
  }

  void clearHistory() {
    try {
      _channel?.sink.add(jsonEncode({'type': 'clear_history'}));
    } catch (_) {}
  }

  void _scheduleReconnect() {
    if (_disposed) return;
    _heartbeatTimer?.cancel();
    _heartbeatTimer = null;
    // Dedup: onError + onDone (or ready failure) can fire for the same dead
    // socket — don't stack timers or double-bump the backoff counter.
    if (_reconnectTimer?.isActive ?? false) return;
    _state = ChatConnectionState.disconnected;
    _emit('state_change', _state);

    final delay = Duration(milliseconds: (_reconnectAttempt < 5)
        ? (1000 * (1 << _reconnectAttempt)).clamp(0, 15000)
        : 15000);
    _reconnectAttempt++;
    _emit('reconnecting', _reconnectAttempt);

    _reconnectTimer = Timer(delay, () {
      if (!_disposed) connect();
    });
  }

  void _emit(String type, dynamic payload) {
    if (!_controller.isClosed) {
      _controller.add(ChatEvent(type, payload));
    }
  }

  void dispose() {
    _disposed = true;
    _reconnectTimer?.cancel();
    _heartbeatTimer?.cancel();
    _sub?.cancel();
    _channel?.sink.close();
    _controller.close();
  }
}
