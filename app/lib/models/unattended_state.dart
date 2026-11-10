// 无人值守（unattended mode）的持久状态模型，契约见 docs/unattended-mode.md。
//
// 会话上只有一份 `record.unattended`；never-used 时服务端给 null。`active` 是唯一
// 「武装中」的状态，其余都是终态，要 resume/start 才回到 active。
//
// 产品决定（2026-11）：不再有「轮次上限」这种说不清的单位，改成**最长值守时间**
// （maxDurationMinutes + deadlineAt）。`rounds` 只剩信息价值（面板显示「已判定 N
// 次」），不再参与任何门控；到点后服务端把状态置为 exhausted。
//
// 和 classify 的 `goalState` 不是一回事：那边的 achieved/interact 是每轮结果的
// 子状态，这里的 status 是跨轮次的监督器状态。

/// 一次判定（aux 模型给出的 verdict）。
class UnattendedVerdict {
  /// achieved | continue | needs_human
  final String verdict;
  final String reason;
  final String nextInstruction;
  final String humanReason;
  final int at;

  const UnattendedVerdict({
    this.verdict = '',
    this.reason = '',
    this.nextInstruction = '',
    this.humanReason = '',
    this.at = 0,
  });

  static UnattendedVerdict? fromJson(dynamic raw) {
    if (raw is! Map) return null;
    return UnattendedVerdict(
      verdict: (raw['verdict'] ?? '').toString(),
      reason: (raw['reason'] ?? '').toString(),
      nextInstruction: (raw['nextInstruction'] ?? '').toString(),
      humanReason: (raw['humanReason'] ?? '').toString(),
      at: (raw['at'] as num?)?.toInt() ?? 0,
    );
  }

  Map<String, dynamic> toJson() => {
    'verdict': verdict,
    'reason': reason,
    'nextInstruction': nextInstruction,
    'humanReason': humanReason,
    'at': at,
  };
}

/// 历史里的一条（服务端只留最近 10 条）。
class UnattendedHistoryEntry {
  final int at;
  final String verdict;
  final String reason;

  const UnattendedHistoryEntry({
    this.at = 0,
    this.verdict = '',
    this.reason = '',
  });

  static UnattendedHistoryEntry? fromJson(dynamic raw) {
    if (raw is! Map) return null;
    return UnattendedHistoryEntry(
      at: (raw['at'] as num?)?.toInt() ?? 0,
      verdict: (raw['verdict'] ?? '').toString(),
      reason: (raw['reason'] ?? '').toString(),
    );
  }

  Map<String, dynamic> toJson() => {
    'at': at,
    'verdict': verdict,
    'reason': reason,
  };
}

/// 连续同指令 / aux 失败的计数（服务端据此判 stalled / error）。
class UnattendedStall {
  final int sameInstruction;
  final int auxFailures;

  const UnattendedStall({this.sameInstruction = 0, this.auxFailures = 0});

  static UnattendedStall? fromJson(dynamic raw) {
    if (raw is! Map) return null;
    return UnattendedStall(
      sameInstruction: (raw['sameInstruction'] as num?)?.toInt() ?? 0,
      auxFailures: (raw['auxFailures'] as num?)?.toInt() ?? 0,
    );
  }

  Map<String, dynamic> toJson() => {
    'sameInstruction': sameInstruction,
    'auxFailures': auxFailures,
  };
}

/// 宽容取整数：数字、数字字符串都收；其余给 [fallback]。
int _intOf(dynamic raw, int fallback) {
  if (raw is num) return raw.toInt();
  if (raw is String) return int.tryParse(raw.trim()) ?? fallback;
  return fallback;
}

class UnattendedState {
  static const statusActive = 'active';
  static const statusAchieved = 'achieved';
  static const statusNeedsHuman = 'needs_human';
  static const statusExhausted = 'exhausted';
  static const statusStopped = 'stopped';
  static const statusError = 'error';

  /// `pausedBy`：谁让监督器停下的（v2，契约 Backend notes）。
  static const pausedByUser = 'user';
  static const pausedByInput = 'input';
  static const pausedByCancel = 'cancel';

  static const maxCriteria = 12;
  static const maxGoalLength = 2000;
  static const maxCriterionLength = 300;

  /// 旧服务端/缺字段时的兜底值守时长（分钟）；limits 会在拿到服务端值后覆盖。
  static const defaultMaxDurationMinutes = 120;

  final String status;
  final String goal;
  final List<String> criteria;

  /// 最长值守时间（分钟）。到点后服务端置 exhausted，客户端按 deadlineAt 显示剩余。
  final int maxDurationMinutes;
  final int rounds;
  final int startedAt;

  /// 起跑时间 + maxDurationMinutes，epoch ms。0 表示服务端没给（旧快照）。
  final int deadlineAt;

  final int updatedAt;
  final UnattendedVerdict? lastVerdict;
  final List<UnattendedHistoryEntry> history;
  final UnattendedStall? stall;

  /// 判定进行中：服务端在 verdict 开始/落地两条边都广播。面板据此转 spinner。
  final bool evaluating;

  /// 暂停原因（user / input / cancel / null）。resume/start 后服务端清掉。
  final String? pausedBy;

  const UnattendedState({
    this.status = statusStopped,
    this.goal = '',
    this.criteria = const [],
    this.maxDurationMinutes = defaultMaxDurationMinutes,
    this.rounds = 0,
    this.startedAt = 0,
    this.deadlineAt = 0,
    this.updatedAt = 0,
    this.lastVerdict,
    this.history = const [],
    this.stall,
    this.evaluating = false,
    this.pausedBy,
  });

  bool get isActive => status == statusActive;
  bool get isAchieved => status == statusAchieved;
  bool get needsHuman => status == statusNeedsHuman;
  bool get isExhausted => status == statusExhausted;
  bool get isStopped => status == statusStopped;
  bool get isError => status == statusError;

  /// `active` 之外都是终态（achieved / needs_human / exhausted / stopped / error）。
  bool get isTerminal => !isActive;

  /// 从 `active` 能 resume 回 `active` 的几种状态（契约）。
  bool get canResume =>
      needsHuman || isExhausted || isStopped || isError;

  /// 距离截止还有多久；没有 deadlineAt（旧服务端 / 从未启动）时返回 null。
  /// 返回值可以是负数（已过期但服务端状态还没落到 exhausted）。
  Duration? remaining(int nowMs) {
    if (deadlineAt <= 0) return null;
    return Duration(milliseconds: deadlineAt - nowMs);
  }

  static UnattendedState? fromJson(dynamic raw) {
    if (raw is! Map) return null;
    final map = Map<String, dynamic>.from(raw);
    final criteria = <String>[
      for (final item in (map['criteria'] as List?) ?? const [])
        if (item.toString().trim().isNotEmpty) item.toString(),
    ];
    final history = <UnattendedHistoryEntry>[
      for (final item in (map['history'] as List?) ?? const [])
        if (UnattendedHistoryEntry.fromJson(item) case final entry?) entry,
    ];
    // 旧快照里的 maxRounds 直接忽略：轮次上限已经不是产品概念了。
    final duration = _intOf(
      map['maxDurationMinutes'],
      defaultMaxDurationMinutes,
    );
    return UnattendedState(
      status: (map['status'] ?? statusStopped).toString(),
      goal: (map['goal'] ?? '').toString(),
      criteria: criteria,
      maxDurationMinutes: duration > 0 ? duration : defaultMaxDurationMinutes,
      rounds: _intOf(map['rounds'], 0),
      startedAt: _intOf(map['startedAt'], 0),
      deadlineAt: _intOf(map['deadlineAt'], 0),
      updatedAt: _intOf(map['updatedAt'], 0),
      lastVerdict: UnattendedVerdict.fromJson(map['lastVerdict']),
      history: history,
      stall: UnattendedStall.fromJson(map['stall']),
      evaluating: _truthy(map['evaluating']),
      pausedBy: _optionalText(map['pausedBy']),
    );
  }

  /// 宽容解析：新老服务端/演示服务可能给 bool、数字或字符串。
  static bool _truthy(dynamic raw) =>
      raw == true || raw == 1 || raw == 'true' || raw == '1';

  /// 空串、字面量 "null" 和 null 一个意思：没有暂停原因。
  static String? _optionalText(dynamic raw) {
    final text = raw?.toString().trim();
    if (text == null || text.isEmpty || text == 'null') return null;
    return text;
  }

  Map<String, dynamic> toJson() => {
    'status': status,
    'goal': goal,
    'criteria': criteria,
    'maxDurationMinutes': maxDurationMinutes,
    'rounds': rounds,
    'startedAt': startedAt,
    'deadlineAt': deadlineAt,
    'updatedAt': updatedAt,
    if (lastVerdict != null) 'lastVerdict': lastVerdict!.toJson(),
    'history': history.map((entry) => entry.toJson()).toList(),
    if (stall != null) 'stall': stall!.toJson(),
    'evaluating': evaluating,
    'pausedBy': pausedBy,
  };
}

/// GET/POST `/api/sessions/:id/unattended` 的 `limits`：最长值守时间的默认值 / 上下限。
class UnattendedLimits {
  final int maxDurationMinutesDefault;
  final int maxDurationMinutesMin;
  final int maxDurationMinutesMax;

  const UnattendedLimits({
    this.maxDurationMinutesDefault = 120,
    this.maxDurationMinutesMin = 5,
    this.maxDurationMinutesMax = 1440,
  });

  static int _positive(dynamic raw, int fallback) {
    final value = _intOf(raw, fallback);
    return value > 0 ? value : fallback;
  }

  static UnattendedLimits fromJson(dynamic raw) {
    if (raw is! Map) return const UnattendedLimits();
    var min = _positive(raw['maxDurationMinutesMin'], 5);
    var max = _positive(raw['maxDurationMinutesMax'], 1440);
    // 服务端给了颠倒的边界也不让界面崩：交换后继续，默认值再夹一次。
    if (max < min) {
      final swap = min;
      min = max;
      max = swap;
    }
    final def = _positive(raw['maxDurationMinutesDefault'], 120);
    return UnattendedLimits(
      maxDurationMinutesDefault: def < min
          ? min
          : (def > max ? max : def),
      maxDurationMinutesMin: min,
      maxDurationMinutesMax: max,
    );
  }

  /// 把界面输入夹到服务端公布的边界内。
  int clampDurationMinutes(int minutes) => minutes < maxDurationMinutesMin
      ? maxDurationMinutesMin
      : (minutes > maxDurationMinutesMax ? maxDurationMinutesMax : minutes);

  Map<String, dynamic> toJson() => {
    'maxDurationMinutesDefault': maxDurationMinutesDefault,
    'maxDurationMinutesMin': maxDurationMinutesMin,
    'maxDurationMinutesMax': maxDurationMinutesMax,
  };
}

/// 一次 GET / 动作 POST 的完整响应：状态 + 上限。
class UnattendedSnapshot {
  final UnattendedState? state;
  final UnattendedLimits limits;

  const UnattendedSnapshot({
    this.state,
    this.limits = const UnattendedLimits(),
  });

  static UnattendedSnapshot fromJson(Map<String, dynamic> raw) =>
      UnattendedSnapshot(
        state: UnattendedState.fromJson(raw['unattended']),
        limits: UnattendedLimits.fromJson(raw['limits']),
      );
}
