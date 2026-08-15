// Mobile counterpart of the web's background-task danmaku
// (public/chat-live-ui.js). Pure state machine — the provider feeds it events
// and a tick, the widget reads the row list — so the dedup / reconcile /
// settle semantics are unit-testable without a live WebSocket.
//
// Semantics mirrored from the web implementation:
//   · monitor_* rows are keyed `t:<task_id>`; the phase heartbeat row is keyed
//     `turn:<turnId>` (one row per turn, refreshed in place).
//   · events carrying `background: false` are foreground (synchronous)
//     commands and are ignored — they must not spawn spinning rows.
//   · `background_tasks` is the authoritative snapshot: on reconnect it
//     confirms which spinning rows are still real (confirmedBg) and settles
//     rows the server no longer tracks.
//   · at turn end, still-unconfirmed 'start' rows settle (either the monitor
//     events were lost or the task finished unobserved).
//   · a WebSocket disconnect marks all spinning rows stale so the panel never
//     spins forever without data.
//   · at most [maxRows] rows are kept (oldest finished drop first), finished
//     rows auto-prune after [autoHideMs], spinning rows go stale after
//     [staleMs] without an update.

enum BackgroundTaskState { start, done, fail, stale }

class BackgroundTaskRow {
  final String key;
  final String taskId;
  final String description;
  final BackgroundTaskState state;

  /// True once this row's task_id appeared in a `background_tasks` snapshot —
  /// the server-confirmed ground truth that the task is really background.
  final bool confirmedBg;

  /// Last time the row changed (epoch ms) — drives stale detection and the
  /// post-finish auto-hide countdown.
  final int updatedAt;

  const BackgroundTaskRow({
    required this.key,
    required this.taskId,
    required this.description,
    required this.state,
    this.confirmedBg = false,
    required this.updatedAt,
  });

  bool get isSpinning => state == BackgroundTaskState.start;

  BackgroundTaskRow copyWith({
    String? description,
    BackgroundTaskState? state,
    bool? confirmedBg,
    int? updatedAt,
  }) =>
      BackgroundTaskRow(
        key: key,
        taskId: taskId,
        description: description ?? this.description,
        state: state ?? this.state,
        confirmedBg: confirmedBg ?? this.confirmedBg,
        updatedAt: updatedAt ?? this.updatedAt,
      );
}

/// Parses a `progress_heartbeat` payload into its danmaku text — same mapping
/// as the web's formatProgressHeartbeat (phase + tool-kind wording).
String heartbeatRowText(Map<String, dynamic> evt) {
  const phases = {
    'starting': '正在启动',
    'thinking': '正在处理',
    'tool': '正在调用工具',
    'recovering': '正在恢复连接',
    'finalizing': '正在收尾',
  };
  const tools = {
    'subagent': '子Agent',
    'monitor': '后台监控',
    'process': '命令执行',
    'filesystem': '文件操作',
    'search': '代码检索',
    'network': '网络请求',
  };
  final toolKind = evt['toolKind']?.toString() ?? '';
  final toolLabel = tools[toolKind];
  final phaseLabel =
      phases[evt['phase']?.toString()] ?? evt['phase']?.toString() ?? '';
  final elapsed = (evt['elapsedMs'] as num?)?.toInt() ?? 0;
  final secs = (elapsed / 1000).round();
  final clock = secs >= 60 ? '${secs ~/ 60}m${secs % 60}s' : '${secs}s';
  return toolLabel == null ? '$phaseLabel · $clock' : '$toolLabel · $phaseLabel · $clock';
}

class BackgroundTaskBoard {
  /// Web parity: DANMAKU_MAX_ROWS.
  static const maxRows = 8;

  /// Finished rows disappear after this long (web AUTOHIDE_MS).
  static const autoHideMs = 5000;

  /// A spinning row with no update for this long goes stale (web DANMAKU_STALE_MS).
  static const staleMs = 180000;

  final Map<String, BackgroundTaskRow> _rows = {};
  final Set<String> _dismissed = {};

  /// Most-recent-first snapshot for rendering; pure function of events + now.
  List<BackgroundTaskRow> rows({int now = 0, bool applyAutoHide = true}) {
    final visible = _rows.values.where((r) => !_dismissed.contains(r.key)).toList()
      ..sort((a, b) => b.updatedAt.compareTo(a.updatedAt));
    if (!applyAutoHide || now == 0) return visible.take(maxRows).toList(growable: false);
    return visible
        .where((r) =>
            r.isSpinning || now - r.updatedAt < autoHideMs)
        .take(maxRows)
        .toList(growable: false);
  }

  bool get hasSpinning =>
      _rows.values.any((r) => r.isSpinning && !_dismissed.contains(r.key));

  /// Locally dismissed by the user's ✕ — the row stays hidden even if later
  /// events refresh it (web dismissDanmakuRow parity).
  void dismiss(String key) => _dismissed.add(key);

  void clear() {
    _rows.clear();
    _dismissed.clear();
  }

  void _upsert(BackgroundTaskRow row, {int now = 0}) {
    _rows[row.key] = row;
    _evictOverCap();
    // A refreshed row is no longer stale.
    // (state comes from the row itself)
  }

  void _evictOverCap() {
    while (_rows.length > maxRows) {
      // Drop the oldest *finished* row first; only drop the oldest row
      // outright when everything is still spinning.
      BackgroundTaskRow? victim;
      for (final r in _rows.values) {
        if (r.isSpinning) continue;
        if (victim == null || r.updatedAt < victim.updatedAt) victim = r;
      }
      victim ??= (_rows.values.toList()
            ..sort((a, b) => a.updatedAt.compareTo(b.updatedAt)))
          .first;
      _rows.remove(victim.key);
    }
  }

  /// `monitor_started` — only background tasks; sync foreground commands are
  /// skipped so they don't pollute the panel (web `background !== false` gate).
  void onMonitorStarted(Map<String, dynamic> evt, {int now = 0}) {
    if (evt['background'] == false) return;
    final taskId = evt['task_id']?.toString() ?? '';
    if (taskId.isEmpty) return;
    final key = 't:$taskId';
    if (_dismissed.contains(key)) return;
    _upsert(BackgroundTaskRow(
      key: key,
      taskId: taskId,
      description: evt['description']?.toString() ?? '',
      state: BackgroundTaskState.start,
      updatedAt: now,
    ), now: now);
  }

  /// `monitor_progress` — refresh the description, keep spinning.
  void onMonitorProgress(Map<String, dynamic> evt, {int now = 0}) {
    if (evt['background'] == false) return;
    final row = _rowForTask(evt['task_id']?.toString() ?? '');
    if (row == null || !row.isSpinning) return;
    final desc = evt['description']?.toString();
    _rows[row.key] = row.copyWith(
      description: desc == null || desc.isEmpty ? row.description : desc,
      updatedAt: now,
    );
  }

  /// `monitor_done` — settle into done/fail.
  void onMonitorDone(Map<String, dynamic> evt, {int now = 0}) {
    if (evt['background'] == false) return;
    final row = _rowForTask(evt['task_id']?.toString() ?? '');
    if (row == null) return;
    _rows[row.key] = row.copyWith(
      state: evt['status']?.toString() == 'fail'
          ? BackgroundTaskState.fail
          : BackgroundTaskState.done,
      updatedAt: now,
    );
  }

  /// `progress_heartbeat` — one in-place row per turn.
  void onHeartbeat(Map<String, dynamic> evt, {int now = 0}) {
    final turnId = evt['turnId']?.toString() ?? evt['sessionId']?.toString() ?? '';
    if (turnId.isEmpty) return;
    final key = 'turn:$turnId';
    if (_dismissed.contains(key)) return;
    _upsert(BackgroundTaskRow(
      key: key,
      taskId: '',
      description: heartbeatRowText(evt),
      state: BackgroundTaskState.start,
      updatedAt: now,
    ), now: now);
  }

  /// `background_tasks` — the authoritative snapshot. Confirms spinning rows
  /// whose task is still tracked and settles spinning rows that vanished.
  void onBackgroundTasksSnapshot(Map<String, dynamic> evt, {int now = 0}) {
    final tasks = evt['tasks'];
    final active = <String>{};
    if (tasks is List) {
      for (final t in tasks) {
        if (t is Map) {
          final id = t['task_id']?.toString() ?? t['id']?.toString() ?? '';
          if (id.isNotEmpty) active.add(id);
        }
      }
    }
    for (final row in _rows.values.toList()) {
      if (!row.taskId.isEmpty) {
        if (active.contains(row.taskId)) {
          if (!row.confirmedBg) {
            _rows[row.key] = row.copyWith(confirmedBg: true, updatedAt: now);
          }
        } else if (row.isSpinning) {
          // Server no longer tracks it — settle instead of spinning forever.
          _rows[row.key] = row.copyWith(state: BackgroundTaskState.done, updatedAt: now);
        }
      }
    }
  }

  /// Turn end — any still-unconfirmed spinning row settles (its monitor_done
  /// was lost or the task finished before the first snapshot arrived).
  /// The turn's heartbeat row also ends here (web settleTurnScopedDanmaku).
  void settleAtTurnEnd({int now = 0, String? turnId}) {
    for (final row in _rows.values.toList()) {
      if (row.key == 'turn:$turnId') {
        _rows[row.key] = row.copyWith(state: BackgroundTaskState.done, updatedAt: now);
        continue;
      }
      if (row.isSpinning && !row.confirmedBg) {
        _rows[row.key] = row.copyWith(state: BackgroundTaskState.done, updatedAt: now);
      }
    }
  }

  /// WS disconnected — spinning rows can no longer be trusted to finish.
  void markStaleAll({int now = 0}) {
    for (final row in _rows.values.toList()) {
      if (row.isSpinning) {
        _rows[row.key] = row.copyWith(state: BackgroundTaskState.stale, updatedAt: now);
      }
    }
  }

  /// Periodic sweep: spinning rows past [staleMs] go stale. Returns true when
  /// anything changed (callers use it to schedule a notifyListeners).
  bool sweep({required int now}) {
    var changed = false;
    for (final row in _rows.values.toList()) {
      if (row.isSpinning && now - row.updatedAt > staleMs) {
        _rows[row.key] = row.copyWith(state: BackgroundTaskState.stale);
        changed = true;
      }
    }
    // Auto-hide of finished rows is applied at read time (rows()); nothing
    // else to mutate here.
    return changed;
  }

  BackgroundTaskRow? _rowForTask(String taskId) {
    if (taskId.isEmpty) return null;
    final row = _rows['t:$taskId'];
    if (row != null && !_dismissed.contains(row.key)) return row;
    return null;
  }
}
