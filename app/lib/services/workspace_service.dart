import 'dart:async';
import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import 'settings_service.dart';

/// Live status of one agent/session in the workspace status board.
class SessionStatus {
  /// idle | thinking | editing | running | waiting
  final String status;
  final String? currentFile;
  final int lastActivity;

  const SessionStatus({
    required this.status,
    this.currentFile,
    this.lastActivity = 0,
  });
}

/// Subscribes to the server's per-directory `/ws/workspace` socket and exposes
/// a live map of session id → [SessionStatus]. Notifies listeners on change.
class WorkspaceService extends ChangeNotifier {
  final SettingsService settings;
  final String dirId;

  WebSocketChannel? _channel;
  StreamSubscription? _sub;
  Timer? _reconnectTimer;
  int _reconnectAttempt = 0;
  bool _disposed = false;

  final Map<String, SessionStatus> statuses = {};

  WorkspaceService({required this.settings, required this.dirId});

  void connect() {
    if (_disposed) return;
    _reconnectTimer?.cancel();
    final url = _buildUrl();
    try {
      final channel = WebSocketChannel.connect(Uri.parse(url));
      _channel = channel;
      _sub?.cancel();
      _sub = channel.stream.listen(
        _onMessage,
        onError: (_) => _scheduleReconnect(),
        onDone: _scheduleReconnect,
      );
      channel.ready.then((_) {
        _reconnectAttempt = 0;
      }).catchError((_) {
        _scheduleReconnect();
      });
    } catch (_) {
      _scheduleReconnect();
    }
  }

  String _buildUrl() {
    var h = settings.host.replaceAll(RegExp(r'/$'), '');
    final isHttps = h.startsWith('https://');
    final wsScheme = isHttps ? 'wss' : 'ws';
    final bare = h.replaceFirst(RegExp(r'^https?://'), '');
    final params = <String, String>{'dirId': dirId};
    if (settings.token.isNotEmpty) params['token'] = settings.token;
    final query = params.entries
        .map((e) =>
            '${Uri.encodeQueryComponent(e.key)}=${Uri.encodeQueryComponent(e.value)}')
        .join('&');
    return '$wsScheme://$bare/ws/workspace?$query';
  }

  SessionStatus _parse(Map m) => SessionStatus(
        status: (m['status'] ?? 'idle') as String,
        currentFile: m['currentFile'] as String?,
        lastActivity: (m['lastActivity'] ?? 0) as int,
      );

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
      return;
    }
    if (msg is! Map) return;

    if (msg['type'] == 'snapshot') {
      statuses.clear();
      for (final s in (msg['sessions'] as List? ?? const [])) {
        if (s is Map && s['id'] is String) {
          statuses[s['id'] as String] = _parse(s);
        }
      }
      notifyListeners();
    } else if (msg['type'] == 'status') {
      final id = msg['sessionId'];
      if (id is String) {
        statuses[id] = _parse(msg);
        notifyListeners();
      }
    }
  }

  void _scheduleReconnect() {
    if (_disposed) return;
    final ms = _reconnectAttempt < 5
        ? (1000 * (1 << _reconnectAttempt))
        : 15000;
    _reconnectAttempt++;
    _reconnectTimer = Timer(Duration(milliseconds: ms.clamp(0, 15000)), () {
      if (!_disposed) connect();
    });
  }

  @override
  void dispose() {
    _disposed = true;
    _reconnectTimer?.cancel();
    _sub?.cancel();
    _channel?.sink.close();
    super.dispose();
  }
}
