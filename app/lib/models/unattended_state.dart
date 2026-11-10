// 无人值守（unattended mode）的持久状态模型，契约见 docs/unattended-mode.md。
//
// 会话上只有一份 `record.unattended`；never-used 时服务端给 null。`active` 是唯一
// 「武装中」的状态，其余都是终态，要 resume/start 才回到 active。
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

class UnattendedState {
  static const statusActive = 'active';
  static const statusAchieved = 'achieved';
  static const statusNeedsHuman = 'needs_human';
  static const statusExhausted = 'exhausted';
  static const statusStopped = 'stopped';
  static const statusError = 'error';

  static const maxCriteria = 12;
  static const maxGoalLength = 2000;
  static const maxCriterionLength = 300;

  final String status;
  final String goal;
  final List<String> criteria;
  final int maxRounds;
  final int rounds;
  final int startedAt;
  final int updatedAt;
  final UnattendedVerdict? lastVerdict;
  final List<UnattendedHistoryEntry> history;
  final UnattendedStall? stall;

  const UnattendedState({
    this.status = statusStopped,
    this.goal = '',
    this.criteria = const [],
    this.maxRounds = 30,
    this.rounds = 0,
    this.startedAt = 0,
    this.updatedAt = 0,
    this.lastVerdict,
    this.history = const [],
    this.stall,
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
    return UnattendedState(
      status: (map['status'] ?? statusStopped).toString(),
      goal: (map['goal'] ?? '').toString(),
      criteria: criteria,
      maxRounds: (map['maxRounds'] as num?)?.toInt() ?? 30,
      rounds: (map['rounds'] as num?)?.toInt() ?? 0,
      startedAt: (map['startedAt'] as num?)?.toInt() ?? 0,
      updatedAt: (map['updatedAt'] as num?)?.toInt() ?? 0,
      lastVerdict: UnattendedVerdict.fromJson(map['lastVerdict']),
      history: history,
      stall: UnattendedStall.fromJson(map['stall']),
    );
  }

  Map<String, dynamic> toJson() => {
    'status': status,
    'goal': goal,
    'criteria': criteria,
    'maxRounds': maxRounds,
    'rounds': rounds,
    'startedAt': startedAt,
    'updatedAt': updatedAt,
    if (lastVerdict != null) 'lastVerdict': lastVerdict!.toJson(),
    'history': history.map((entry) => entry.toJson()).toList(),
    if (stall != null) 'stall': stall!.toJson(),
  };
}

/// GET/POST `/api/sessions/:id/unattended` 的 `limits`：轮次默认值 / 硬上限。
class UnattendedLimits {
  final int maxRoundsDefault;
  final int maxRoundsMax;

  const UnattendedLimits({
    this.maxRoundsDefault = 30,
    this.maxRoundsMax = 200,
  });

  static UnattendedLimits fromJson(dynamic raw) {
    if (raw is! Map) return const UnattendedLimits();
    final def = (raw['maxRoundsDefault'] as num?)?.toInt() ?? 30;
    final max = (raw['maxRoundsMax'] as num?)?.toInt() ?? 200;
    return UnattendedLimits(
      maxRoundsDefault: def > 0 ? def : 30,
      maxRoundsMax: max > 0 ? max : 200,
    );
  }

  Map<String, dynamic> toJson() => {
    'maxRoundsDefault': maxRoundsDefault,
    'maxRoundsMax': maxRoundsMax,
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
