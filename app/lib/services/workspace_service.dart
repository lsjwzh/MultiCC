import 'dart:async';
import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import 'settings_service.dart';
import 'ws_ticket_service.dart';

/// Live status of one agent/session in the workspace status board.
class SessionStatus {
  /// idle | thinking | editing | running | waiting | succeeded | error
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

  /// Live classify/task state from the aux-AI intent classifier, broadcast by
  /// the server over /ws/workspace (snapshot fields + `task_state` events).
  /// classifyState ∈ D=succeeded · W=wait-user · B=wait-bg · E=error · P=processing.
  /// Legacy C may still arrive from old servers and is displayed as W.
  final String? classifyState;

  /// The aux-AI's current guess at this session's task goal (一句话目标).
  final String? goal;

  /// Coarse phase key (planning/coding/testing/…) — server-normalised.
  final String? phase;

  /// Task run-time window (ms epoch, 0 = none). [runStartedAt] is stamped when a
  /// turn begins (user sent a message); [runEndedAt] freezes when it ends. While
  /// the agent is mid-run [runEndedAt] is 0 and the elapsed time keeps growing.
  final int runStartedAt;
  final int runEndedAt;

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
    this.classifyState,
    this.goal,
    this.phase,
    this.runStartedAt = 0,
    this.runEndedAt = 0,
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
    String? classifyState,
    String? goal,
    String? phase,
    int? runStartedAt,
    int? runEndedAt,
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
      classifyState: classifyState ?? this.classifyState,
      goal: goal ?? this.goal,
      phase: phase ?? this.phase,
      runStartedAt: runStartedAt ?? this.runStartedAt,
      runEndedAt: runEndedAt ?? this.runEndedAt,
    );
  }
}

/// Subscribes to the server's per-directory `/ws/workspace` socket and exposes
/// a live map of session id → [SessionStatus]. Notifies listeners on change.
class WorkspaceService extends ChangeNotifier {
  final SettingsService settings;
  final String dirId;
  final WsTicketConnectionGate _wsAuth;
  final WebSocketChannel Function(Uri) _connectChannel;

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

  /// Fired when a session's CLI is switched (server `session_cli_changed`).
  /// Lets the dashboard reload its session list immediately so the fleet
  /// grouping updates without waiting for the 5s REST poll.
  void Function()? onSessionCliChanged;

  WorkspaceService({
    required this.settings,
    required this.dirId,
    WsTicketClient? wsTicketClient,
    WebSocketChannel Function(Uri)? channelFactory,
  }) : _wsAuth = WsTicketConnectionGate(wsTicketClient ?? WsTicketClient()),
       _connectChannel = channelFactory ?? WebSocketChannel.connect;

  void connect() {
    if (_disposed) return;
    _reconnectTimer?.cancel();
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
            _reconnectAttempt = 0;
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
    final params = <String, String>{'dirId': dirId};
    return buildMulticcWebSocketUri(
      host: settings.host,
      path: MulticcWsPath.workspace,
      query: params,
    );
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
      // Classify fields: `status`/`merge_status` ticks don't re-send these, so
      // carry the previous value forward (same reason as summary above) — else
      // the classify badge would blink off on every status update.
      classifyState: (m['classifyState'] as String?) ?? prev?.classifyState,
      goal: (m['goal'] is String && (m['goal'] as String).isNotEmpty)
          ? m['goal'] as String
          : prev?.goal,
      phase: (m['phase'] as String?) ?? prev?.phase,
      runStartedAt:
          (m['runStartedAt'] as num?)?.toInt() ?? prev?.runStartedAt ?? 0,
      runEndedAt: (m['runEndedAt'] as num?)?.toInt() ?? prev?.runEndedAt ?? 0,
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
    } else if (type == 'task_state') {
      // Live classify-state update (aux-AI intent classifier). Carries only
      // {sessionId, classifyState, goal, phase} — no status/currentFile — so
      // patch the existing entry via copyWith rather than _parse() (which would
      // reset it to an idle stub).
      final id = msg['sessionId'];
      if (id is String) {
        final prev = statuses[id] ?? const SessionStatus(status: 'idle');
        final g = msg['goal']?.toString();
        statuses[id] = prev.copyWith(
          classifyState: msg['classifyState']?.toString(),
          goal: (g != null && g.isNotEmpty) ? g : prev.goal,
          phase: msg['phase']?.toString(),
        );
        notifyListeners();
      }
    } else if (type == 'session_cli_changed') {
      // A session's CLI was switched. The grouping (chat/terminal buckets, CLI
      // chips) comes from the REST session list, not this socket - so ask the
      // host to reload it immediately instead of waiting for the 5s poll.
      onSessionCliChanged?.call();
    } else if (type == 'notify') {
      final id = msg['sessionId'];
      if (id is String) {
        // notify now carries the terminal classify letter (D on completion,
        // W/B/E on wait) — reflect it on the card immediately.
        final cls = msg['classifyState']?.toString();
        if (cls != null && cls.isNotEmpty) {
          final prev = statuses[id] ?? const SessionStatus(status: 'idle');
          statuses[id] = prev.copyWith(classifyState: cls);
          notifyListeners();
        }
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
    _wsAuth.invalidate();
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
    _wsAuth.invalidate();
    _reconnectTimer?.cancel();
    _sub?.cancel();
    _channel?.sink.close();
    super.dispose();
  }
}
