// 派发记录模型：消费 GET /api/sessions/:id/dispatches（durable operation +
// target FIFO 的权威投影，orchestration.js projectDispatch）。该契约没有 WS
// 推送，App 侧靠事件触发 + 非空时定时轮询对账（见 ChatProvider.refreshDispatchQueue）。
//
// 隐私：DTO 不携带任务 prompt 文本，UI 只展示方向/目标会话/模式/队列状态，
// 与「不泄露完整敏感任务 prompt」的约束天然对齐。
//
// 语义边界：这是「双向派发状态 + 最近记录」，与 SessionQueueState（暂存消息
// 队列）、TaskBoard/后台任务（background_tasks）是三回事，不合并展示。

/// One dispatch operation as projected by the server for this session.
/// All timing fields are epoch millis (nullable server-side).
class DispatchQueueEntry {
  final String operationId;

  /// Server operation status (registered/admitted/running/completed/…).
  final String status;
  final bool terminal;
  final String relation; // 'self' | 'owner' | 'target'
  final String? ownerSessionId;
  final String? targetSessionId;
  final String? executionSessionId;
  final String? taskId;
  final String? mode; // 'sync' | 'async' | 'one_way' | null
  /// Target FIFO projection: queued/started/running/unknown/terminal.
  final String queueState;
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

  /// Ordered navigation candidates. Outgoing terminal dispatches prefer their
  /// execution chat but retain the stable terminal/role target as a fallback;
  /// incoming dispatches jump back to the owner.
  List<String> get navigationSessionIds {
    if (relation == 'self') return const [];
    final candidates = relation == 'target'
        ? [ownerSessionId]
        : [executionSessionId, targetSessionId];
    return candidates
        .whereType<String>()
        .where((id) => id.isNotEmpty)
        .toSet()
        .toList(growable: false);
  }

  /// The session represented by the row and opened on tap.
  String get counterpartId =>
      navigationSessionIds.isEmpty ? '' : navigationSessionIds.first;

  /// The session the UI should open. Outgoing work jumps to the actual chat
  /// that executed it (which may be an ephemeral chat for a terminal target);
  /// incoming work jumps back to its owner. A self-dispatch has nowhere useful
  /// to navigate.
  String get navigationSessionId {
    return counterpartId;
  }

  bool get isQueued => queueState == 'queued';

  static DispatchQueueEntry? fromJson(Map<String, dynamic> j) {
    final id = j['operationId']?.toString();
    if (id == null || id.isEmpty) return null;
    int? asInt(Object? v) => v is num
        ? v.toInt()
        : v is String
        ? int.tryParse(v)
        : null;
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

/// Pure merge for polled snapshots: dedup by operationId, then show every live
/// operation before recent terminal history. Within each group the freshest
/// record wins; the explicit queuePosition remains the only FIFO ordering
/// authority when several targets or insertion operations are involved. The
/// poll response is authoritative: nothing survives that the server did not
/// re-send, so reconnect always converges.
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
  int freshness(DispatchQueueEntry e) =>
      e.completedAt ?? e.updatedAt ?? e.startedAt ?? e.createdAt ?? 0;
  int activePriority(DispatchQueueEntry e) =>
      (e.queueState == 'started' || e.queueState == 'running')
      ? 0
      : e.queueState == 'queued'
      ? 1
      : 2;
  parsed.sort((a, b) {
    if (a.terminal != b.terminal) return a.terminal ? 1 : -1;
    if (!a.terminal && activePriority(a) != activePriority(b)) {
      return activePriority(a).compareTo(activePriority(b));
    }
    return freshness(b).compareTo(freshness(a));
  });
  return parsed.toList(growable: false);
}
