import 'dart:async';
import 'dart:convert';
import 'package:web_socket_channel/web_socket_channel.dart';
import 'package:http/http.dart' as http;

import '../models/message.dart';
import 'settings_service.dart';
import 'ws_ticket_service.dart';

enum ChatConnectionState { disconnected, connecting, connected }

class ChatEvent {
  final String type;
  final dynamic payload;
  ChatEvent(this.type, this.payload);
}

class QueueActionException implements Exception {
  final int statusCode;
  final String code;
  const QueueActionException(this.statusCode, this.code);

  @override
  String toString() => code;
}

class ChatService {
  final SettingsService settings;
  final String sessionName;
  final String sessionCwd;
  final WsTicketConnectionGate _wsAuth;
  final WebSocketChannel Function(Uri) _connectChannel;
  final http.Client _httpClient;
  final bool _ownsHttpClient;

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
  // Cancel requested while WS was disconnected — resend on reconnect, matching
  // the web client's _pendingCancel. Without this, a cancel tapped during a
  // brief disconnect is silently dropped and the user is stuck streaming.
  bool _pendingCancel = false;
  // User tapped cancel (connected case). Set so that late stream_event frames
  // from the dying CLI process can't flip isStreaming back on. Cleared when a
  // new turn begins (send) or the stream truly ends (stream_end/result/error).
  bool _cancelRequested = false;
  String? _pendingUserInputRequestId;
  int _messageSequence = 0;

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
    WsTicketClient? wsTicketClient,
    WebSocketChannel Function(Uri)? channelFactory,
    http.Client? httpClient,
  }) : _wsAuth = WsTicketConnectionGate(wsTicketClient ?? WsTicketClient()),
       _connectChannel = channelFactory ?? WebSocketChannel.connect,
       _httpClient = httpClient ?? http.Client(),
       _ownsHttpClient = httpClient == null;

  Uri _buildChatUri({String? resumeId}) {
    final params = <String, String>{};
    if (sessionCwd.isNotEmpty) params['cwd'] = sessionCwd;
    if (sessionName.isNotEmpty) params['session'] = sessionName;
    if (resumeId != null && resumeId.isNotEmpty) params['resume'] = resumeId;
    return buildMulticcWebSocketUri(
      host: settings.host,
      path: MulticcWsPath.chat,
      query: params,
    );
  }

  void connect() {
    if (_disposed) return;
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    _heartbeatTimer?.cancel();
    _heartbeatTimer = null;

    _state = ChatConnectionState.connecting;
    _emit('state_change', _state);

    late WsTicketAttempt attempt;
    try {
      attempt = _wsAuth.begin(
        socketUri: _buildChatUri(resumeId: _sessionId ?? initialSessionId),
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
    Uri url;
    try {
      url = await attempt.authorizedUri;
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
      // Don't claim "connected" until the WebSocket handshake actually
      // completes — connect() returns immediately and a failed handshake only
      // surfaces asynchronously. Marking connected early would leave a dead
      // socket showing a green dot with no way to manually reconnect.
      channel.ready
          .then((_) {
            if (_disposed || !attempt.isCurrent || _channel != channel) return;
            _state = ChatConnectionState.connected;
            _reconnectAttempt = 0;
            _lastActivity = DateTime.now();
            _startHeartbeat();
            // Flush a cancel that was requested while disconnected — the server
            // never saw it, so the CLI process is still running.
            if (_pendingCancel) {
              _pendingCancel = false;
              try {
                channel.sink.add(jsonEncode({'type': 'cancel'}));
              } catch (_) {}
            }
            _emit('state_change', _state);
          })
          .catchError((_) {
            if (_disposed || !attempt.isCurrent || _channel != channel) return;
            _scheduleReconnect();
          });
    } catch (_) {
      if (!_disposed && attempt.isCurrent) _scheduleReconnect();
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

  /// Lightweight "is this socket still good?" probe, used when the app comes
  /// back from a SHORT background (lock-screen glance, app switch). Unlike
  /// [connect]/reconnect it does NOT tear down a healthy socket — so the user
  /// sees no "Connecting…" flash or history reload on every unlock.
  ///
  ///  • Not connected (already dropped / mid-backoff) → reconnect immediately,
  ///    skipping the backoff wait.
  ///  • Connected but silent past the stale window (socket likely frozen across
  ///    the background) → treat as dead and reconnect now.
  ///  • Connected and recently active → just ping and restart the heartbeat
  ///    cadence. A truly-dead socket yields no pong and the heartbeat reconnects
  ///    within one cycle; a live one keeps serving with zero interruption.
  void ensureAlive() {
    if (_disposed) return;
    // Already mid-handshake — let it finish rather than restarting it.
    if (_state == ChatConnectionState.connecting) return;
    if (_state == ChatConnectionState.disconnected) {
      _reconnectAttempt = 0;
      _reconnectTimer?.cancel();
      _reconnectTimer = null;
      connect();
      return;
    }
    if (DateTime.now().difference(_lastActivity) > _staleThreshold) {
      _scheduleReconnect();
      return;
    }
    try {
      _channel?.sink.add(jsonEncode({'type': 'ping'}));
      _startHeartbeat();
    } catch (_) {
      _scheduleReconnect();
    }
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

          _sessionId = (msg['session_id'] ?? msg['session'] ?? _sessionId)
              ?.toString();
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

      case 'cli_switched':
        _emit('cli_switched', msg);
        break;

      case 'chat_history':
        final messages = msg['messages'];
        if (messages is List) {
          // Carry hasMore so the provider knows whether older history can be
          // fetched on scroll-up (paginated /history endpoint).
          _emit('chat_history', {
            'messages': messages,
            'hasMore': msg['hasMore'] == true,
          });
        }
        break;

      case 'stream_event':
        final evt = msg['event'];
        if (evt is Map<String, dynamic>) {
          _handleStreamEvent(evt);
        }
        break;

      case 'assistant':
        final assistant = msg['message'];
        if (assistant is Map) {
          _emit('assistant', Map<String, dynamic>.from(assistant));
        }
        break;

      case 'part_delta':
        _emit('part_delta', msg);
        break;

      case 'result':
        isStreaming = false;
        _cancelRequested = false;
        _emit('result', msg);
        break;

      case 'error':
        isStreaming = false;
        _cancelRequested = false;
        _emit('error', msg['error']?.toString() ?? 'Unknown error');
        break;

      case 'notify':
        // Server-side aux-AI verdict that a turn finished / is waiting. The
        // client never judges this itself — it just renders the verdict.
        _emit('notify', {
          'state': (msg['state'] ?? 'completed').toString(),
          'message': (msg['message'] ?? '').toString(),
          'classifyState': msg['classifyState']?.toString(),
        });
        break;

      case 'stream_end':
        // Safety net: server confirms process exited — ensure isStreaming is
        // cleared. Without this, a cancel followed by a late-arriving
        // message_start (emitted by the CLI before it actually dies) can
        // re-set isStreaming=true, leaving the app stuck showing the stop
        // button + thinking bubble while the web client has already ended.
        isStreaming = false;
        _cancelRequested = false;
        _emit('stream_end', msg);
        break;

      case 'chat_msg_meta':
        // Server saved a message and assigned its history id. The provider
        // tags the newest still-un-id'd bubble of that role so its delete
        // button goes live without waiting for a reload.
        _emit('chat_msg_meta', msg);
        break;

      case 'chat_msg_deleted':
        // Broadcast after a successful delete from any client; drop the
        // matching bubble. Idempotent — the initiator already removed it.
        _emit('chat_msg_deleted', msg);
        break;

      case 'task_state':
        // aux classify result: what the assistant thinks this session's
        // goal/phase is. Carries {goal, phase, classifyState}. Rendered into the
        // classify bar at the top of the chat (mirrors web renderAuxClassify).
        _emit('task_state', msg);
        break;

      case 'user_input_required':
        _pendingUserInputRequestId = msg['requestId']?.toString();
        _emit('user_input_required', msg);
        break;

      case 'user_input_resolved':
        // 另一个窗口消费了 wait_user；清掉本地待决状态，让所有窗口同步关框。
        // 幂等：requestId 不匹配（本窗口已先消费）则 _emit 仍转发但 provider 侧 no-op。
        if (msg['requestId']?.toString() == _pendingUserInputRequestId) {
          _pendingUserInputRequestId = null;
        }
        _emit('user_input_resolved', msg);
        break;

      case 'session_queue':
        _emit('session_queue', msg);
        break;

      case 'api_error_policy':
        _emit('api_error_policy', msg);
        break;

      case 'rate_limit_event':
        final info = msg['rate_limit_info'];
        if (info is Map) {
          _emit('rate_limit_event', Map<String, dynamic>.from(info));
        }
        break;

      case 'usage_balance_event':
        final info = msg['balance_info'];
        if (info is Map) {
          _emit('usage_balance_event', Map<String, dynamic>.from(info));
        }
        break;

      default:
        break;
    }
  }

  void _handleStreamEvent(Map<String, dynamic> evt) {
    final evtType = evt['type'] as String? ?? '';
    switch (evtType) {
      case 'message_start':
        // Guard: if the user already tapped cancel, a late message_start from
        // the dying CLI must not flip isStreaming back on — otherwise the
        // stop button and thinking bubble reappear for a turn the user aborted.
        if (!_cancelRequested) {
          isStreaming = true;
        }
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

  /// Returns the generated correlation id, or null if the socket isn't healthy.
  /// The caller must not show a message as sent on null. The id is persisted
  /// through the server FIFO and echoed by chat_msg_meta for exact reconciliation.
  ///
  /// When [goal] is true the message is flagged as a Goal-mode send and the
  /// server applies the per-send execution limits in [goalLimits] (maxRounds →
  /// claude --max-turns; maxBudget → advisory token budget). There is no global
  /// limit config — blank/0 means unlimited for that dimension.
  String? send(
    String text, {
    bool goal = false,
    Map<String, dynamic>? goalLimits,
  }) {
    if (_channel == null || _state != ChatConnectionState.connected) {
      connect();
      return null;
    }
    try {
      final clientMsgId =
          'app-${DateTime.now().microsecondsSinceEpoch}-${_messageSequence++}';
      final payload = <String, dynamic>{
        'type': 'user_message',
        'text': text,
        'clientMsgId': clientMsgId,
      };
      final pendingRequestId = _pendingUserInputRequestId;
      if (pendingRequestId != null && pendingRequestId.isNotEmpty) {
        payload['userInputRequestId'] = pendingRequestId;
      }
      if (goal) {
        payload['goal'] = true;
        payload['goalLimits'] = goalLimits ?? <String, dynamic>{};
      }
      _channel!.sink.add(jsonEncode(payload));
      if (pendingRequestId != null) _pendingUserInputRequestId = null;
      _cancelRequested = false; // New turn — clear any stale cancel guard
      return clientMsgId;
    } catch (_) {
      _scheduleReconnect();
      return null;
    }
  }

  /// Cancel the in-flight CLI turn. Mirrors the web client's cancelStreaming():
  ///   • If connected, send `{type:'cancel'}` immediately (idempotent on the
  ///     server — safe even if the turn already ended).
  ///   • If disconnected, set `_pendingCancel` so the cancel is flushed on the
  ///     next successful reconnect — the CLI process keeps running until then.
  ///   • Always flip `isStreaming = false` locally so the UI (stop → send
  ///     button) reacts instantly, instead of waiting for a server `result`
  ///     that may never come if the socket died mid-stream.
  void cancel() {
    if (_channel != null && _state == ChatConnectionState.connected) {
      try {
        _channel!.sink.add(jsonEncode({'type': 'cancel'}));
      } catch (_) {}
      _pendingCancel = false;
      _cancelRequested = true; // Guard against late events from the dying CLI
    } else {
      _pendingCancel = true;
    }
    isStreaming = false;
  }

  /// Request native CLI context rotation (compact/restart native session).
  /// This triggers a handoff where the native CLI session is rotated
  /// while preserving the multicc chat transcript.
  void rotateNativeContext() {
    try {
      _channel?.sink.add(
        jsonEncode({"type": "clear_history", "preserveHistory": true}),
      );
    } catch (_) {}
  }

  void clearHistory({int keep = 0}) {
    try {
      _channel?.sink.add(jsonEncode({'type': 'clear_history', 'keep': keep}));
    } catch (_) {}
  }

  void _scheduleReconnect() {
    if (_disposed) return;
    _wsAuth.invalidate();
    _heartbeatTimer?.cancel();
    _heartbeatTimer = null;
    // Dedup: onError + onDone (or ready failure) can fire for the same dead
    // socket — don't stack timers or double-bump the backoff counter.
    if (_reconnectTimer?.isActive ?? false) return;
    _state = ChatConnectionState.disconnected;
    _emit('state_change', _state);

    final delay = Duration(
      milliseconds: (_reconnectAttempt < 5)
          ? (1000 * (1 << _reconnectAttempt)).clamp(0, 15000)
          : 15000,
    );
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

  // ── HTTP helpers (paginated history) ──────────────────────────────────────
  Map<String, String> get _headers {
    final h = <String, String>{'Content-Type': 'application/json'};
    if (settings.token.isNotEmpty) {
      h['X-Access-Token'] = settings.token;
    }
    return h;
  }

  String _url(String path) => settings.buildHttpUrl(path);

  /// Execute one explicit scheduler action. The endpoint itself requires
  /// confirm:true because retry/resume/skip/cancel may advance the FIFO.
  /// Nothing here changes local queue state optimistically; the authoritative
  /// REST response/WS snapshot remains the only state source.
  Future<Map<String, dynamic>> queueAction(
    String action, {
    String? entryId,
    String? text,
  }) async {
    final body = <String, dynamic>{
      'action': action,
      'confirm': true,
      if (entryId != null && entryId.isNotEmpty) 'entryId': entryId,
      if (text != null && text.trim().isNotEmpty) 'text': text.trim(),
      'reason': 'requested from Flutter app',
    };
    final res = await _httpClient
        .post(
          Uri.parse(
            _url(
              '/api/sessions/${Uri.encodeComponent(sessionName)}/queue/action',
            ),
          ),
          headers: _headers,
          body: jsonEncode(body),
        )
        .timeout(const Duration(seconds: 20));
    Map<String, dynamic> data = const {};
    try {
      final decoded = jsonDecode(utf8.decode(res.bodyBytes));
      if (decoded is Map) data = Map<String, dynamic>.from(decoded);
    } catch (_) {}
    if (res.statusCode < 200 || res.statusCode >= 300 || data['ok'] != true) {
      throw QueueActionException(
        res.statusCode,
        (data['code'] ?? data['error'] ?? 'queue_action_failed').toString(),
      );
    }
    return data;
  }

  /// Fetch one page of older history (strictly older than [beforeId]) from
  /// GET /api/sessions/:id/history?before={id}&limit={n}. Returns the parsed
  /// messages and whether even older history exists. Mirrors the web client's
  /// scroll-back pagination.
  Future<({List<ChatMessage> messages, bool hasMore})> fetchHistoryPage({
    required String? beforeId,
    int limit = 30,
  }) async {
    final qs = <String, String>{'limit': limit.toString()};
    if (beforeId != null && beforeId.isNotEmpty) qs['before'] = beforeId;
    final query = qs.entries
        .map(
          (e) =>
              '${Uri.encodeQueryComponent(e.key)}=${Uri.encodeQueryComponent(e.value)}',
        )
        .join('&');
    final res = await _httpClient
        .get(
          Uri.parse(
            _url(
              '/api/sessions/${Uri.encodeComponent(sessionName)}/history?$query',
            ),
          ),
          headers: _headers,
        )
        .timeout(const Duration(seconds: 15));
    if (res.statusCode != 200) {
      throw Exception('history fetch failed: ${res.statusCode}');
    }
    final data = jsonDecode(res.body) as Map<String, dynamic>;
    final list = data['messages'];
    final parsed = (list is List)
        ? list
              .map((m) {
                try {
                  return ChatMessage.fromHistory(m as Map<String, dynamic>);
                } catch (_) {
                  return null;
                }
              })
              .whereType<ChatMessage>()
              .toList()
        : <ChatMessage>[];
    return (messages: parsed, hasMore: data['hasMore'] == true);
  }

  void dispose() {
    _disposed = true;
    _wsAuth.invalidate();
    _reconnectTimer?.cancel();
    _heartbeatTimer?.cancel();
    _sub?.cancel();
    _channel?.sink.close();
    _controller.close();
    if (_ownsHttpClient) _httpClient.close();
  }
}
