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
    try {
      final msg = jsonDecode(raw as String) as Map<String, dynamic>;
      _handleMessage(msg);
    } catch (_) {}
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

  void send(String text) {
    if (_channel == null) return;
    try {
      _channel!.sink.add(jsonEncode({'type': 'user_message', 'text': text}));
      isStreaming = true;
    } catch (_) {}
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
    _sub?.cancel();
    _channel?.sink.close();
    _controller.close();
  }
}
