import '../utils/status_presentation.dart';

// 队列的运行状态不再自带枚举：它就是 canonical 状态域里的会话状态，词表、别名和
// freezeReason 映射统一由 utils/status_presentation.dart 提供。

class SessionQueueItem {
  final String entryId;
  final String? taskId;
  final String state;
  final int position;
  final String text;

  /// The scheduler已把这条标为「插队优先」(schedule.priorityEntryId)。服务端在
  /// insert_queued 成功后回填；UI 据此把插入按钮换成不可再点的「执行中」。
  final bool priority;

  const SessionQueueItem({
    required this.entryId,
    this.taskId,
    required this.state,
    required this.position,
    required this.text,
    this.priority = false,
  });

  bool get canCancel => entryId.isNotEmpty && state == 'pending';

  /// 只有还没被调度器领取的 pending 条目能插队；已经是 priority 的不必再插一次。
  bool get canInsert => canCancel && !priority;

  factory SessionQueueItem.fromJson(
    Map<String, dynamic> json, {
    required int fallbackPosition,
  }) {
    return SessionQueueItem(
      entryId: (json['entryId'] ?? '').toString(),
      taskId: _optionalString(json['taskId']),
      state: (json['state'] ?? 'pending').toString().toLowerCase(),
      position: _positiveInt(json['position']) ?? fallbackPosition,
      text: (json['text'] ?? '').toString(),
      priority: json['priority'] == true,
    );
  }
}

class SessionQueueState {
  final String event;
  final String state;
  final String? freezeReason;
  final Map<String, dynamic>? active;
  final List<SessionQueueItem> items;

  const SessionQueueState({
    this.event = '',
    this.state = 'idle',
    this.freezeReason,
    this.active,
    this.items = const [],
  });

  bool get isFrozen => state == 'frozen';

  /// 队列状态 → canonical 会话状态。冻结时由 freezeReason 决定（整表在 registry
  /// 里，认不出来的原因落 waiting 并记诊断——不再用 `reason.contains('error')`
  /// 这类字符串嗅探去猜，那既会把 unknown_interruption 之外的新原因误判成故障，
  /// 也会漏掉不含 "error" 字样的故障原因）。
  CanonicalStatus get runState {
    if (isFrozen) return freezeReasonStatusOf(freezeReason);
    if (state == 'starting' || state == 'running' || state == 'assessing') {
      return CanonicalStatus.running;
    }
    if (state == 'queued' || items.isNotEmpty) return CanonicalStatus.queued;
    return CanonicalStatus.idle;
  }

  bool get canRetry => isFrozen && runState == CanonicalStatus.error;

  bool get canResume =>
      isFrozen &&
      const {
        'waiting',
        'unknown_interruption',
        'legacy_unresolved',
        'continuation_ready',
        'incomplete_requires_resume',
        'delivery_recovery',
      }.contains(freezeReason);

  bool get canSkip => isFrozen;
  bool get canCancelActive => isFrozen && active != null;

  factory SessionQueueState.fromEvent(
    Map<String, dynamic> json, {
    SessionQueueState previous = const SessionQueueState(),
  }) {
    final nextState = (json['state'] ?? previous.state)
        .toString()
        .toLowerCase();
    final rawItems = json['items'];
    final items = rawItems is List
        ? rawItems.indexed
              .map((entry) {
                final raw = entry.$2;
                if (raw is! Map) return null;
                return SessionQueueItem.fromJson(
                  Map<String, dynamic>.from(raw),
                  fallbackPosition: entry.$1 + 1,
                );
              })
              .whereType<SessionQueueItem>()
              .toList(growable: false)
        : previous.items;
    return SessionQueueState(
      event: (json['event'] ?? previous.event).toString(),
      state: nextState,
      freezeReason: nextState == 'frozen'
          ? _optionalString(json['freezeReason']) ?? previous.freezeReason
          : null,
      active: json.containsKey('active')
          ? _optionalMap(json['active'])
          : previous.active,
      items: items,
    );
  }
}

class PendingUserInput {
  final String requestId;
  final String? taskId;
  final String question;
  final String reason;
  final List<String> options;
  final bool allowMultiple;

  const PendingUserInput({
    required this.requestId,
    this.taskId,
    required this.question,
    this.reason = '',
    this.options = const [],
    this.allowMultiple = false,
  });

  static PendingUserInput? fromJson(Map<String, dynamic> json) {
    final requestId = (json['requestId'] ?? '').toString().trim();
    if (requestId.isEmpty) return null;
    final rawOptions = json['options'];
    return PendingUserInput(
      requestId: requestId,
      taskId: _optionalString(json['taskId']),
      question: (json['question'] ?? '').toString().trim(),
      reason: (json['reason'] ?? '').toString().trim(),
      options: rawOptions is List
          ? rawOptions
                .map((value) => value.toString().trim())
                .where((value) => value.isNotEmpty)
                .toList(growable: false)
          : const [],
      allowMultiple: json['allowMultiple'] == true,
    );
  }
}

class ApiErrorPolicyState {
  final String state;
  final String message;
  final String category;
  final String provider;
  final String? code;
  final int? httpStatus;
  final bool retryable;
  final bool safeToRetry;
  final bool partialOutput;
  final int attempt;
  final int maxAttempts;
  final String action;
  final String reason;
  final int? retryAtMs;
  final String userAction;
  final String rootCause;

  const ApiErrorPolicyState({
    required this.state,
    required this.message,
    required this.category,
    required this.provider,
    this.code,
    this.httpStatus,
    required this.retryable,
    required this.safeToRetry,
    required this.partialOutput,
    required this.attempt,
    required this.maxAttempts,
    required this.action,
    required this.reason,
    this.retryAtMs,
    required this.userAction,
    required this.rootCause,
  });

  bool get isRetryScheduled => state == 'retry_wait' || action == 'retry';

  bool get canManualRetry => state == 'failed' && safeToRetry && !partialOutput;

  static ApiErrorPolicyState? fromJson(Map<String, dynamic> json) {
    final state = (json['state'] ?? '').toString();
    if (state != 'retry_wait' && state != 'failed') return null;
    return ApiErrorPolicyState(
      state: state,
      message: (json['message'] ?? '').toString(),
      category: (json['category'] ?? 'unknown').toString(),
      provider: (json['provider'] ?? 'unknown').toString(),
      code: _optionalString(json['code']),
      httpStatus: _int(json['httpStatus']),
      retryable: json['retryable'] == true,
      safeToRetry: json['safeToRetry'] == true,
      partialOutput: json['partialOutput'] == true,
      attempt: _int(json['attempt']) ?? 0,
      maxAttempts: _int(json['maxAttempts']) ?? 0,
      action: (json['action'] ?? '').toString(),
      reason: (json['reason'] ?? '').toString(),
      retryAtMs: _epochMs(json['retryAt']),
      userAction: (json['userAction'] ?? '').toString(),
      rootCause: (json['rootCause'] ?? '').toString(),
    );
  }
}

class UsageWindowLimit {
  final String rateLimitType;
  final String status;
  final double? usedPercentage;
  final int? resetsAtMs;
  final String provider;
  final int? observedAtMs;

  const UsageWindowLimit({
    required this.rateLimitType,
    required this.status,
    required this.usedPercentage,
    required this.resetsAtMs,
    required this.provider,
    this.observedAtMs,
  });

  bool isActiveAt(DateTime now) =>
      resetsAtMs == null || resetsAtMs! > now.millisecondsSinceEpoch;

  bool matchesCli(String cli) {
    if (provider == 'opencode') return cli == 'opencode';
    if (provider == 'glm' || provider == 'codex') {
      return cli == 'codex' || cli == 'opencode';
    }
    return cli == 'claude' || cli == 'opencode';
  }

  Map<String, dynamic> toJson() => {
    'rateLimitType': rateLimitType,
    'status': status,
    'usedPercentage': usedPercentage,
    'resetsAtMs': resetsAtMs,
    'provider': provider,
    'observedAtMs': observedAtMs,
  };

  static UsageWindowLimit? fromEvent(Map<String, dynamic> json) {
    final rateLimitType = (json['rateLimitType'] ?? '').toString();
    final status = (json['status'] ?? '').toString();
    if (!const {'five_hour', 'weekly'}.contains(rateLimitType) ||
        !const {'allowed', 'allowed_warning', 'rejected'}.contains(status)) {
      return null;
    }
    final utilization = _double(json['utilization']);
    final usedPercentage = utilization == null
        ? null
        : (utilization.clamp(0, 1).toDouble() * 100);
    final rawProvider = (json['provider'] ?? 'claude').toString();
    final provider = const {'glm', 'codex', 'opencode'}.contains(rawProvider)
        ? rawProvider
        : 'claude';
    return UsageWindowLimit(
      rateLimitType: rateLimitType,
      status: status,
      usedPercentage: usedPercentage,
      resetsAtMs: _epochMs(json['resetsAt']),
      provider: provider,
      observedAtMs: DateTime.now().millisecondsSinceEpoch,
    );
  }

  static UsageWindowLimit? fromCache(Map<String, dynamic> json) {
    final percentage = _double(json['usedPercentage']);
    final rateLimitType = (json['rateLimitType'] ?? '').toString();
    final status = (json['status'] ?? '').toString();
    final provider = (json['provider'] ?? '').toString();
    if (!const {'five_hour', 'weekly'}.contains(rateLimitType) ||
        !const {'allowed', 'allowed_warning', 'rejected'}.contains(status) ||
        !const {'claude', 'glm', 'codex', 'opencode'}.contains(provider) ||
        (percentage != null && (percentage < 0 || percentage > 100))) {
      return null;
    }
    return UsageWindowLimit(
      rateLimitType: rateLimitType,
      status: status,
      usedPercentage: percentage,
      resetsAtMs: _int(json['resetsAtMs']),
      provider: provider,
      observedAtMs: _int(json['observedAtMs']),
    );
  }
}

class UsageBalance {
  final bool available;
  final String? currency;
  final double? total;

  const UsageBalance({
    required this.available,
    required this.currency,
    required this.total,
  });

  Map<String, dynamic> toJson() => {
    'kind': 'balance',
    'provider': 'deepseek',
    'available': available,
    'currency': currency,
    'total': total,
  };

  static UsageBalance? fromJson(Map<String, dynamic> json) {
    if (json['kind'] != 'balance') return null;
    final total = _double(json['total']);
    if (total == null && json['available'] != false) return null;
    return UsageBalance(
      available: json['available'] != false,
      currency: _optionalString(json['currency']),
      total: total,
    );
  }
}

String? _optionalString(dynamic value) {
  if (value == null) return null;
  final text = value.toString().trim();
  return text.isEmpty ? null : text;
}

Map<String, dynamic>? _optionalMap(dynamic value) =>
    value is Map ? Map<String, dynamic>.from(value) : null;

int? _int(dynamic value) {
  if (value is int) return value;
  if (value is num) return value.toInt();
  return int.tryParse(value?.toString() ?? '');
}

int? _positiveInt(dynamic value) {
  final parsed = _int(value);
  return parsed != null && parsed > 0 ? parsed : null;
}

double? _double(dynamic value) {
  if (value is num) return value.toDouble();
  return double.tryParse(value?.toString() ?? '');
}

int? _epochMs(dynamic value) {
  final parsed = _int(value);
  if (parsed == null || parsed <= 0) return null;
  return parsed < 10000000000 ? parsed * 1000 : parsed;
}
