// 派发队列模型：消费 GET /api/sessions/:id/dispatches（durable operation +
// target FIFO 的权威投影，orchestration.js projectDispatch）。该契约没有 WS
// 推送，App 侧靠事件触发 + 非空时定时轮询对账（见 ChatProvider.refreshDispatchQueue）。
//
// 隐私：DTO 不携带任务 prompt 文本，UI 只展示方向/目标会话/模式/队列状态，
// 与「不泄露完整敏感任务 prompt」的约束天然对齐。
//
// 语义边界：这是「双向派发 FIFO」，与 SessionQueueState（暂存消息队列）、
// TaskBoard/后台任务（background_tasks）是三回事，不合并展示。

/// One dispatch operation as projected by the server for this session.
/// All timing fields are epoch millis (nullable server-side).
class DispatchQueueEntry {
  final String operationId;
  final String status; // server operation status (registered/admitted/running/completed/…)
  final bool terminal;
  final String relation; // 'self' | 'owner' | 'target'
  final String? ownerSessionId;
  final String? targetSessionId;
  final String? executionSessionId;
  final String? taskId;
  final String? mode; // 'sync' | 'async' | 'one_way' | null
  final String queueState; // 'queued' | 'started' | 'running' | 'unknown' | 'terminal'
  final int? queuePosition;
  final int? queueLength; // present only while queued (queue depth)
  final int? createdAt;
  final int? startedAt;
  final int? completedAt;
  final int? updatedAt;

  const DispatchQueueEntry({
    required this.operationId,
    this.status = 'unknown',
    this.terminal = false,
    this.relation = 'owner',
    this.ownerSessionId,
    this.targetSessionId,
    this.executionSessionId,
    this.taskId,
    this.mode,
    this.queueState = 'unknown',
    this.queuePosition,
    this.queueLength,
    this.createdAt,
    this.startedAt,
    this.completedAt,
    this.updatedAt,
  });

  /// The session on the other end of this dispatch: the worker we sent to
  /// (owner/self) or the commander who sent to us (target).
  String get counterpartId =>
      relation == 'target' ? (ownerSessionId ?? '') : (targetSessionId ?? '');

  bool get isQueued => queueState == 'queued';

  static DispatchQueueEntry? fromJson(Map<String, dynamic> j) {
    final id = j['operationId']?.toString();
    if (id == null || id.isEmpty) return null;
    int? asInt(Object? v) => v is num ? v.toInt() : v is String ? int.tryParse(v) : null;
    return DispatchQueueEntry(
      operationId: id,
      status: j['status']?.toString() ?? 'unknown',
      terminal: j['terminal'] == true,
      relation: j['relation']?.toString() ?? 'owner',
      ownerSessionId: j['ownerSessionId']?.toString(),
      targetSessionId: j['targetSessionId']?.toString(),
      executionSessionId: j['executionSessionId']?.toString(),
      taskId: j['taskId']?.toString(),
      mode: j['mode']?.toString(),
      queueState: j['queueState']?.toString() ?? 'unknown',
      queuePosition: asInt(j['queuePosition']),
      queueLength: asInt(j['queueLength']),
      createdAt: asInt(j['createdAt']),
      startedAt: asInt(j['startedAt']),
      completedAt: asInt(j['completedAt']),
      updatedAt: asInt(j['updatedAt']),
    );
  }
}

/// Pure merge for polled snapshots: dedup by operationId, order by createdAt
/// (oldest first — position in the FIFO is what the user reads), active
/// (non-terminal) entries only so finished dispatches converge away. The poll
/// response is authoritative: nothing survives that the server didn't re-send
/// (reconnect reconcile is the same path, so a stale queue never persists).
List<DispatchQueueEntry> mergeDispatchQueue(
  List<Map<String, dynamic>> snapshotJson,
) {
  final parsed = <DispatchQueueEntry>[];
  final seen = <String>{};
  for (final j in snapshotJson) {
    final e = DispatchQueueEntry.fromJson(j);
    // Duplicate operationIds (relation=both can't overlap owner/target by
    // construction, but a flaky proxy replay must not double-render a row).
    if (e == null || !seen.add(e.operationId)) continue;
    parsed.add(e);
  }
  parsed.sort((a, b) => (a.createdAt ?? 0).compareTo(b.createdAt ?? 0));
  // Terminal rows converge away immediately: 排队 → 运行 → 终态即消失。
  // activeOnly=true already filters server-side; the client-side guard covers
  // a server that still includes terminal rows in the active list (so a done
  // dispatch can never wedge the panel forever).
  return parsed.where((e) => !e.terminal).toList(growable: false);
}
