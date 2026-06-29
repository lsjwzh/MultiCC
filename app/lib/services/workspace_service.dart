import 'dart:async';
import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import 'settings_service.dart';

/// Live status of one agent/session in the workspace status board.
class SessionStatus {
  /// idle | thinking | editing | running | waiting | completed
  final String status;
  final String? currentFile;
  final int lastActivity;
  final bool mergeReady;
  final bool dirty;
  final int ahead;
  final int behind;
  final String? baseBranch;

  /// aux-AI one-line summary of what the session last worked on ("最近任务").
  final String? summary;
  final int summaryTs;

  const SessionStatus({
    required this.status,
    this.currentFile,
    this.lastActivity = 0,
    this.mergeReady = false,
    this.dirty = false,
    this.ahead = 0,
    this.behind = 0,
    this.baseBranch,
    this.summary,
    this.summaryTs = 0,
  });

  SessionStatus copyWith({
    String? status,
    String? currentFile,
    int? lastActivity,
    bool? mergeReady,
    bool? dirty,
    int? ahead,
    int? behind,
    String? baseBranch,
    String? summary,
    int? summaryTs,
  }) {
    return SessionStatus(
      status: status ?? this.status,
      currentFile: currentFile ?? this.currentFile,
      lastActivity: lastActivity ?? this.lastActivity,
      mergeReady: mergeReady ?? this.mergeReady,
      dirty: dirty ?? this.dirty,
      ahead: ahead ?? this.ahead,
      behind: behind ?? this.behind,
      baseBranch: baseBranch ?? this.baseBranch,
      summary: summary ?? this.summary,
      summaryTs: summaryTs ?? this.summaryTs,
    );
  }
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
  final Map<String, int> pendingNotes = {}; // sessionId → pending note count
  final List<Map<String, dynamic>> events = []; // newest last, capped at 200

  /// Fired when the server's aux-AI decides a session's turn finished / is
  /// waiting. Lets the dashboard raise a local notification for sessions the
  /// user never opened (which have no chat socket of their own). Whether to
  /// actually notify is decided by [SessionManager].
  void Function(String sessionId, String state, String message)? onNotify;

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
      channel.ready
          .then((_) {
            _reconnectAttempt = 0;
          })
          .catchError((_) {
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
        .map(
          (e) =>
              '${Uri.encodeQueryComponent(e.key)}=${Uri.encodeQueryComponent(e.value)}',
        )
        .join('&');
    return '$wsScheme://$bare/ws/workspace?$query';
  }

  SessionStatus _parse(Map m, {SessionStatus? prev}) {
    final merge = m['mergeState'];
    final mergeMap = merge is Map ? merge : const {};
    final rawSummary = m['summary']?.toString();
    return SessionStatus(
      status: (m['status'] ?? 'idle') as String,
      currentFile: m['currentFile'] as String?,
      lastActivity: (m['lastActivity'] ?? 0) as int,
      mergeReady: mergeMap['mergeReady'] == true,
      dirty: mergeMap['dirty'] == true,
      ahead: (mergeMap['ahead'] as num?)?.toInt() ?? 0,
      behind: (mergeMap['behind'] as num?)?.toInt() ?? 0,
      baseBranch: mergeMap['baseBranch']?.toString(),
      // Status/snapshot payloads don't always re-send the summary — keep the
      // last one we had so it doesn't blink off the card on a status tick.
      summary: (rawSummary != null && rawSummary.isNotEmpty)
          ? rawSummary
          : prev?.summary,
      summaryTs: (m['summaryTs'] as num?)?.toInt() ?? prev?.summaryTs ?? 0,
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
      return;
    }
    if (msg is! Map) return;

    final type = msg['type'];
    if (type == 'snapshot') {
      statuses.clear();
      pendingNotes.clear();
      for (final s in (msg['sessions'] as List? ?? const [])) {
        if (s is Map && s['id'] is String) {
          final id = s['id'] as String;
          statuses[id] = _parse(s);
          pendingNotes[id] = (s['pendingNotes'] ?? 0) as int;
        }
      }
      events
        ..clear()
        ..addAll(
          (msg['events'] as List? ?? const []).whereType<Map>().map(
            (e) => e.cast<String, dynamic>(),
          ),
        );
      notifyListeners();
    } else if (type == 'status') {
      final id = msg['sessionId'];
      if (id is String) {
        statuses[id] = _parse(msg, prev: statuses[id]);
        notifyListeners();
      }
    } else if (type == 'merge_status') {
      final id = msg['sessionId'];
      if (id is String) {
        final prev = statuses[id] ?? const SessionStatus(status: 'idle');
        final merge = msg['mergeState'];
        final mergeMap = merge is Map ? merge : const {};
        statuses[id] = prev.copyWith(
          mergeReady: mergeMap['mergeReady'] == true,
          dirty: mergeMap['dirty'] == true,
          ahead: (mergeMap['ahead'] as num?)?.toInt() ?? 0,
          behind: (mergeMap['behind'] as num?)?.toInt() ?? 0,
          baseBranch: mergeMap['baseBranch']?.toString(),
        );
        notifyListeners();
      }
    } else if (type == 'summary') {
      final id = msg['sessionId'];
      final summary = msg['summary']?.toString();
      if (id is String && summary != null && summary.isNotEmpty) {
        final prev = statuses[id] ?? const SessionStatus(status: 'idle');
        statuses[id] = prev.copyWith(
          summary: summary,
          summaryTs: (msg['ts'] as num?)?.toInt() ?? prev.summaryTs,
        );
        notifyListeners();
      }
    } else if (type == 'event') {
      final e = msg['event'];
      if (e is Map) {
        events.add(e.cast<String, dynamic>());
        if (events.length > 200) events.removeAt(0);
        notifyListeners();
      }
    } else if (type == 'note_pending') {
      final id = msg['sessionId'];
      if (id is String) {
        pendingNotes[id] = (msg['count'] ?? 0) as int;
        notifyListeners();
      }
    } else if (type == 'notify') {
      final id = msg['sessionId'];
      if (id is String) {
        onNotify?.call(
          id,
          (msg['state'] ?? 'completed').toString(),
          (msg['message'] ?? '').toString(),
        );
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
