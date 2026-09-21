import 'dart:convert';

import 'role_tokens.dart';

enum MessageRole { user, assistant, system }

/// Token usage information for a message (mirrors Anthropic's usage shape)
class MessageUsage {
  final int inputTokens;
  final int outputTokens;
  final int cacheReadTokens;
  final int cacheCreationTokens;

  /// Main-model tokens saved by offloading work to sub-roles (Task/Agent/Workflow).
  /// Not carried in the server `usage` payload — computed by the provider from
  /// the `role_token_stats` WS event and injected into the message after the
  /// result arrives. Null until injected; absent when the turn had no sub-role work.
  int? savedMainTokens;

  /// Main/sub-agent token split from the same `role_token_stats` event — the
  /// mobile counterpart of the web usage-line tooltip (chat-live-ui.js
  /// buildUsageLine roleBreakdown branch). Live-updated while a turn streams
  /// and re-attached to the final usage on result. History replay rebuilds
  /// messages without it (the server does not persist the split), which is
  /// the same "totals only" shape history always had.
  RoleTokenBreakdown? roleBreakdown;

  MessageUsage({
    this.inputTokens = 0,
    this.outputTokens = 0,
    this.cacheReadTokens = 0,
    this.cacheCreationTokens = 0,
    this.savedMainTokens,
    this.roleBreakdown,
  });

  int get total =>
      inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens;
  bool get isEmpty => total == 0;

  factory MessageUsage.fromJson(Map<String, dynamic> json) {
    return MessageUsage(
      inputTokens: (json['input_tokens'] as num?)?.toInt() ?? 0,
      outputTokens: (json['output_tokens'] as num?)?.toInt() ?? 0,
      cacheReadTokens: (json['cache_read_input_tokens'] as num?)?.toInt() ?? 0,
      cacheCreationTokens:
          (json['cache_creation_input_tokens'] as num?)?.toInt() ?? 0,
    );
  }
}

class ToolCall {
  final String id;
  final String name;
  String inputJson;
  String? result;
  bool isError;
  bool isDone;

  /// Wall-clock epoch ms stamped by the live event handlers (mirror of the
  /// web's chat-event-controller): startedAt at content_block_start, endedAt
  /// at the matching tool_result. New history persists both stamps; legacy
  /// messages have neither, so [durationMs] stays null there — unknown, never
  /// fabricated.
  int? startedAt;
  int? endedAt;

  ToolCall({
    required this.id,
    required this.name,
    this.inputJson = '',
    this.result,
    this.isError = false,
    this.isDone = false,
    this.startedAt,
    this.endedAt,
  });

  /// Measured wall-clock span when both stamps exist; null (unknown) otherwise,
  /// including a clock skew where endedAt lands before startedAt.
  int? get durationMs {
    final a = startedAt, b = endedAt;
    if (a == null || b == null || b < a) return null;
    return b - a;
  }

  Map<String, dynamic>? get parsedInput {
    try {
      if (inputJson.isEmpty) return null;
      final decoded = jsonDecode(inputJson);
      return decoded is Map<String, dynamic>
          ? decoded
          : Map<String, dynamic>.from(decoded as Map);
    } catch (_) {
      return null;
    }
  }

  String get description {
    final p = parsedInput;
    if (p == null) return '';
    return (p['description'] ??
            p['command'] ??
            p['pattern'] ??
            p['file_path'] ??
            '')
        .toString();
  }
}

class ChatMessage {
  final MessageRole role;
  String content;
  final List<ToolCall> toolCalls;
  final DateTime timestamp;
  bool isStreaming;
  double? cost;
  MessageUsage? usage;

  /// Server-authored manifest of MultiCC-managed context references for this
  /// turn. It intentionally contains source metadata only; message bodies are
  /// fetched from the authenticated context endpoint when the user opens them.
  Map<String, dynamic>? contextTrace;

  /// Stable history id assigned by the server (e.g. "mxxxxxx-n"). null while
  /// the message is still streaming / not yet persisted. Used for per-message
  /// delete and for tagging live bubbles via the chat_msg_meta WS event.
  String? id;

  /// Wall-clock time from user submit to AI reply completion (ms).
  /// Stamped by the server (cs.turnStartedAt → result) and persisted in
  /// chat_history; shown under each assistant bubble as "任务耗时".
  int? durationMs;

  /// Client-generated correlation id carried through the durable FIFO. Unlike
  /// [id] this exists before persistence, so delayed chat_msg_meta events can
  /// tag the exact optimistic bubble instead of whichever user bubble is last.
  final String? clientMsgId;

  /// Durable interrupted-draft marker (server: `partial` in the unified
  /// history DTO — a mid-turn checkpoint that was never finalized, e.g. the
  /// host shut down or the run was cancelled). Distinct from [isStreaming]:
  /// streaming is computed live and means "still producing"; partial is
  /// persisted and means "stopped, will never continue".
  bool isPartial;

  /// Which task this message came from, plus the turn/execution that produced
  /// it. A task shell shows one timeline built out of several executions, so a
  /// message's meaning depends on its origin — the same sentence from 「修登录页」
  /// and from 「迁移数据库」 is two different pieces of evidence. Quoting carries
  /// this along (see services/message_quote.dart).
  ///
  /// Who the source session and message are is not always known at render time:
  /// the server decides a turn's task attribution when the turn **ends**, so
  /// these are filled by the `chat_history_annotation` event after the bubble is
  /// already on screen (web does the same via chat-history-view's
  /// stampProvenance / annotateAttribution).
  String? taskId;
  String? taskName;
  String? taskShortCode;
  String? turnId;
  String? auxRunId;

  /// Source session + message id for a shell bubble. A shell bubble's [id] is
  /// the composite `<sourceSessionId>:<sourceMessageId>`; both halves are kept
  /// so the quote can name the message the way the task-context reader does.
  String? sourceSessionId;
  String? sourceMessageId;

  ChatMessage({
    required this.role,
    this.content = '',
    List<ToolCall>? toolCalls,
    DateTime? timestamp,
    this.isStreaming = false,
    this.isPartial = false,
    this.cost,
    this.usage,
    this.contextTrace,
    this.id,
    this.durationMs,
    this.clientMsgId,
    this.taskId,
    this.taskName,
    this.taskShortCode,
    this.turnId,
    this.auxRunId,
    this.sourceSessionId,
    this.sourceMessageId,
  }) : toolCalls = toolCalls ?? [],
       timestamp = timestamp ?? DateTime.now();

  ChatMessage.fromHistory(Map<String, dynamic> json)
    : role = json['role'] == 'user' ? MessageRole.user : MessageRole.assistant,
      content = (json['content'] ?? '').toString(),
      toolCalls = _parseHistoryTools(json['tools']),
      timestamp = json['ts'] != null
          ? DateTime.fromMillisecondsSinceEpoch((json['ts'] as num).toInt())
          : DateTime.now(),
      isStreaming = json['streaming'] == true,
      isPartial = json['partial'] == true,
      cost = (json['cost'] as num?)?.toDouble(),
      usage = json['usage'] is Map
          ? MessageUsage.fromJson(json['usage'] as Map<String, dynamic>)
          : null,
      contextTrace = json['contextTrace'] is Map
          ? Map<String, dynamic>.from(json['contextTrace'] as Map)
          : null,
      id = (json['id']?.toString().isNotEmpty ?? false)
          ? json['id'].toString()
          : null,
      durationMs = (json['durationMs'] as num?)?.toInt(),
      clientMsgId = (json['clientMsgId']?.toString().isNotEmpty ?? false)
          ? json['clientMsgId'].toString()
          : null,
      taskId = _nonEmpty(json['taskId']),
      taskName = _nonEmpty(json['taskName']),
      taskShortCode = _nonEmpty(json['taskShortCode']),
      turnId = _nonEmpty(json['turnId']),
      auxRunId = _nonEmpty(json['auxRunId']),
      sourceSessionId = _nonEmpty(json['sourceSessionId']),
      sourceMessageId = _nonEmpty(json['sourceMessageId']);

  /// Absent and empty mean the same thing to every reader of these fields:
  /// unknown. Normalising here keeps "no task" a single representation.
  static String? _nonEmpty(dynamic value) {
    final text = value?.toString();
    return (text == null || text.isEmpty) ? null : text;
  }

  /// Apply a `chat_history_annotation` record in place — the fields the server
  /// only knows once the turn has ended. Absent keys leave the current value
  /// alone: an annotation about a task must not wipe a known source session.
  void applyAttribution(Map<String, dynamic> record) {
    taskId = _nonEmpty(record['taskId']) ?? taskId;
    taskName = _nonEmpty(record['taskName']) ?? taskName;
    taskShortCode = _nonEmpty(record['taskShortCode']) ?? taskShortCode;
    turnId = _nonEmpty(record['turnId']) ?? turnId;
    auxRunId = _nonEmpty(record['auxRunId']) ?? auxRunId;
    // The two source halves are **client-derived addressing hints**, not facts
    // from the server: ChatShellView composites the event with whichever
    // execution session is currently active, and a message can well belong to an
    // earlier one (that is precisely why the fallback match exists). So they may
    // only fill a hole — overwriting a known session would make the quote's
    // `sessionId:messageId` handle resolve to a different conversation.
    sourceSessionId ??= _nonEmpty(record['sourceSessionId']);
    sourceMessageId ??= _nonEmpty(record['sourceMessageId']);
  }

  static List<ToolCall> _parseHistoryTools(dynamic tools) {
    if (tools is! List) return [];
    return tools.map((t) {
      final tc = ToolCall(
        id: (t['id'] ?? '').toString(),
        name: (t['name'] ?? '').toString(),
        // jsonEncode, not toString(): parsedInput feeds jsonDecode, and a Dart
        // map's "{command: pwd}" toString is not JSON.
        inputJson: t['input'] != null ? jsonEncode(t['input']) : '',
        result: t['result']?.toString(),
        isError: t['is_error'] == true,
        isDone: true,
        // Server-stamped timing (turns persisted after the tool-stamp change)
        // makes replay durations measured; older sessions have neither.
        startedAt: (t['startedAt'] as num?)?.toInt(),
        endedAt: (t['endedAt'] as num?)?.toInt(),
      );
      return tc;
    }).toList();
  }
}

/// Returns the one authoritative live tail carried by a reconnect history
/// page. The server marks only the final assistant entry as `streaming:true`.
ChatMessage? streamingAssistantTail(List<ChatMessage> messages) {
  if (messages.isEmpty) return null;
  final tail = messages.last;
  return tail.role == MessageRole.assistant && tail.isStreaming ? tail : null;
}

/// Which CLI binary this session drives.
enum SessionCli {
  claude,
  claudeExp,
  codex,
  codexExp,
  opencode,
  zcode,
  qoder,
  codebuddy,
  dsh,
}

/// Interactive TUI terminal, or stream-json chat.
enum SessionKind { terminal, chat }

SessionCli? tryParseCli(String? s) {
  switch (s) {
    case 'claude':
      return SessionCli.claude;
    case 'claude-exp':
      return SessionCli.claudeExp;
    case 'codex':
      return SessionCli.codex;
    case 'codex-exp':
      return SessionCli.codexExp;
    case 'opencode':
      return SessionCli.opencode;
    case 'zcode':
      return SessionCli.zcode;
    case 'qoder':
      return SessionCli.qoder;
    case 'codebuddy':
      return SessionCli.codebuddy;
    case 'dsh':
      return SessionCli.dsh;
    default:
      return null;
  }
}

SessionCli parseCli(String? s) {
  return tryParseCli(s) ?? SessionCli.claude;
}

SessionKind _parseKind(String? s) =>
    s == 'chat' ? SessionKind.chat : SessionKind.terminal;

extension SessionCliX on SessionCli {
  String get name => switch (this) {
    SessionCli.claudeExp => 'claude-exp',
    SessionCli.codex => 'codex',
    SessionCli.codexExp => 'codex-exp',
    SessionCli.opencode => 'opencode',
    SessionCli.zcode => 'zcode',
    SessionCli.qoder => 'qoder',
    SessionCli.codebuddy => 'codebuddy',
    SessionCli.dsh => 'dsh',
    SessionCli.claude => 'claude',
  };

  /// Provider pool this CLI maps to. codex has its own pool;
  /// claude/opencode/zcode share the Anthropic-compatible 'claude' pool.
  /// Qoder CN owns its account/BYOK settings and does not expose a MultiCC pool.
  bool get isCodexFamily =>
      this == SessionCli.codex || this == SessionCli.codexExp;
  bool get isClaudeFamily =>
      this == SessionCli.claude || this == SessionCli.claudeExp;

  String get appType => isCodexFamily ? 'codex' : 'claude';
  String get poolKey => isCodexFamily
      ? 'codex'
      : isClaudeFamily
      ? 'claude'
      : name;

  /// Human-readable label for UI display.
  String get displayName => switch (this) {
    SessionCli.claude => 'Claude',
    SessionCli.claudeExp => 'Claude Exp',
    SessionCli.codex => 'Codex',
    SessionCli.codexExp => 'Codex Exp',
    SessionCli.opencode => 'OpenCode',
    SessionCli.zcode => 'ZCode',
    SessionCli.qoder => 'Qoder CN',
    SessionCli.codebuddy => 'WorkBuddy',
    SessionCli.dsh => 'DSH',
  };

  /// Vendor-auth CLIs (qoder / WorkBuddy / DSH) own their account and model
  /// config; they expose no multicc provider pool.
  bool get supportsProvider =>
      this != SessionCli.qoder &&
      this != SessionCli.codebuddy &&
      this != SessionCli.dsh;
  bool get supportsAgent =>
      isClaudeFamily ||
      this == SessionCli.opencode ||
      this == SessionCli.qoder ||
      this == SessionCli.codebuddy;
  bool get supportsSubagent => isClaudeFamily || isCodexFamily;
  bool get supportsEffort => this != SessionCli.zcode && this != SessionCli.dsh;

  String get effortFieldLabel => switch (this) {
    SessionCli.claude => 'Effort',
    SessionCli.claudeExp => 'Effort',
    SessionCli.codex => 'Reasoning Level',
    SessionCli.codexExp => 'Reasoning Level',
    SessionCli.opencode => 'Variant',
    SessionCli.zcode => '',
    SessionCli.qoder => 'Reasoning Effort',
    SessionCli.codebuddy => 'Reasoning Effort',
    SessionCli.dsh => '',
  };

  String get defaultEffort => switch (this) {
    SessionCli.claude => 'medium',
    SessionCli.claudeExp => 'medium',
    SessionCli.codex => 'xhigh',
    SessionCli.codexExp => 'xhigh',
    SessionCli.opencode => '',
    SessionCli.zcode => '',
    SessionCli.qoder => '',
    SessionCli.codebuddy => '',
    SessionCli.dsh => '',
  };

  List<String> get effortOptions => switch (this) {
    SessionCli.claude => const [
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultracode',
    ],
    SessionCli.claudeExp => const [
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultracode',
    ],
    SessionCli.codex => const [
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultra',
    ],
    SessionCli.codexExp => const [
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultra',
    ],
    SessionCli.opencode => const [
      '',
      'minimal',
      'low',
      'medium',
      'high',
      'max',
    ],
    SessionCli.zcode => const [],
    SessionCli.qoder => const ['', 'low', 'medium', 'high', 'xhigh', 'max'],
    SessionCli.codebuddy => const [
      '',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ],
    SessionCli.dsh => const [],
  };
}

extension SessionKindX on SessionKind {
  String get name => this == SessionKind.chat ? 'chat' : 'terminal';
}

/// Claude model choices for new sessions / live switching.
/// Empty value = follow the user's /model default on the server machine.
/// Offline fallback only — the live list comes from ClaudeModelsService
/// (GET /api/claude/models, extracted from the installed CLI's bundle).
/// Keep in sync with CLAUDE_MODEL_OPTIONS in public/shared/models.js.
const kClaudeModelOptions = <MapEntry<String, String>>[
  MapEntry('', '默认（跟随 Claude 设置）'),
  MapEntry('claude-opus-5', 'Opus 5'),
  MapEntry('claude-opus-5[1m]', 'Opus 5 (1M context)'),
  MapEntry('claude-opus-4-8', 'Opus 4.8'),
  MapEntry('claude-sonnet-5', 'Sonnet 5'),
  MapEntry('claude-sonnet-4-6', 'Sonnet 4.6'),
  MapEntry('claude-fable-5', 'Fable 5'),
  MapEntry('claude-fable-5[1m]', 'Fable 5 (1M context)'),
  MapEntry('claude-haiku-4-5-20251001', 'Haiku 4.5'),
];

/// Stable Qoder CN routing tiers. Concrete model availability remains owned by
/// the signed-in Qoder account and can still be entered through “Custom”.
const kQoderModelOptions = <MapEntry<String, String>>[
  MapEntry('', '默认（跟随 Qoder CN 设置）'),
  MapEntry('auto', 'Auto（智能路由）'),
  MapEntry('ultimate', 'Ultimate（极致）'),
  MapEntry('performance', 'Performance（性能）'),
  MapEntry('efficient', 'Efficient（经济）'),
  MapEntry('lite', 'Lite（轻量）'),
];

/// Static WorkBuddy (codebuddy) catalog: tier aliases plus concrete vendor
/// model ids. The CLI has no --list-models and entitlements vary per account,
/// so unknown ids simply fall back to the CLI's own default. Mirrors
/// CODEBUDDY_MODEL_OPTIONS in public/chat-ai-config.js.
const kCodebuddyModelOptions = <MapEntry<String, String>>[
  MapEntry('', '默认（跟随 WorkBuddy 设置）'),
  MapEntry('default-model', 'default（默认档）'),
  MapEntry('fast-model', 'fast（快速档）'),
  MapEntry('balanced-model', 'balanced（均衡档）'),
  MapEntry('primary-model', 'primary（主力档）'),
  MapEntry('deep-model', 'deep（深度档）'),
  MapEntry('gpt-5.6-sol', 'gpt-5.6-sol'),
  MapEntry('gpt-5.6-terra', 'gpt-5.6-terra'),
  MapEntry('gpt-5.6-luna', 'gpt-5.6-luna'),
  MapEntry('gpt-5.5', 'gpt-5.5'),
  MapEntry('gpt-5.4', 'gpt-5.4'),
  MapEntry('gpt-5.3-codex', 'gpt-5.3-codex'),
  MapEntry('gemini-3.5-flash', 'gemini-3.5-flash'),
  MapEntry('glm-5.3', 'glm-5.3'),
  MapEntry('glm-5.2', 'glm-5.2'),
  MapEntry('kimi-k3', 'kimi-k3'),
  MapEntry('kimi-k2.6', 'kimi-k2.6'),
  MapEntry('minimax-m3', 'minimax-m3'),
];

/// DeepSeek Harness (dsh) model whitelist; mirrors DSH_MODELS on the server.
const kDshModelOptions = <MapEntry<String, String>>[
  MapEntry('', '默认（跟随 DSH 配置）'),
  MapEntry('deepseek-v4-flash', 'deepseek-v4-flash'),
  MapEntry('deepseek-v4-pro', 'deepseek-v4-pro'),
];

String claudeModelShortName(String? model) {
  if (model == null || model.isEmpty) return '默认';
  for (final e in kClaudeModelOptions) {
    if (e.key == model) return e.value;
  }
  return model;
}

String modelShortNameForCli(SessionCli cli, String? model) {
  if (cli.isClaudeFamily) return claudeModelShortName(model);
  if (cli == SessionCli.qoder) {
    for (final option in kQoderModelOptions) {
      if (option.key == (model ?? '')) return option.value;
    }
  }
  if (cli == SessionCli.codebuddy) {
    for (final option in kCodebuddyModelOptions) {
      if (option.key == (model ?? '')) return option.value;
    }
  }
  if (cli == SessionCli.dsh) {
    for (final option in kDshModelOptions) {
      if (option.key == (model ?? '')) return option.value;
    }
  }
  return model ?? '';
}

/// Display name for a session's model. For an alias-mapped relay, prefer the
/// provider's real model name (e.g. GLM5.2) over the claude-* alias: [aliasMap]
/// is the picked provider's `aliasMap` (tier → {model, name}); [model] may be a
/// tier key ('opus') or a wire model id a tier maps to ('claude-opus-4-8').
/// Falls back to [modelShortNameForCli] when no alias name applies.
String modelDisplayName(SessionCli cli, String? model, {Map? aliasMap}) {
  if (model == null || model.isEmpty) return modelShortNameForCli(cli, model);
  if (aliasMap != null) {
    final direct = aliasMap[model];
    if (direct is Map) {
      final n = direct['name']?.toString();
      if (n != null && n.isNotEmpty) return n;
    }
    for (final v in aliasMap.values) {
      if (v is Map && v['model']?.toString() == model) {
        final n = v['name']?.toString();
        if (n != null && n.isNotEmpty) return n;
      }
    }
  }
  return modelShortNameForCli(cli, model);
}

String effortShortNameForCli(SessionCli cli, String? effort) {
  if (!cli.supportsEffort) return '';
  final v = (effort == null || effort.isEmpty) ? cli.defaultEffort : effort;
  if ((cli == SessionCli.opencode || cli == SessionCli.codebuddy) &&
      v.isEmpty) {
    return 'Default';
  }
  if (cli.isCodexFamily ||
      cli == SessionCli.opencode ||
      cli == SessionCli.qoder ||
      cli == SessionCli.codebuddy) {
    switch (v) {
      case 'minimal':
        return 'Minimal';
      case 'low':
        return 'Low';
      case 'medium':
        return 'Medium';
      case 'high':
        return 'High';
      case 'xhigh':
        return 'Extra high';
      case 'max':
        return 'Max';
      case 'ultra':
        return 'Ultra';
    }
  }
  return v;
}

/// Per-session Task-tool subagent override (claude-proxy routing).
/// {providerId, model} routes subagent requests to a different provider+model;
/// null/empty = 随主 (follow the main provider). Mirrors server `session.subagent`.
class SessionSubagent {
  final String? providerId;
  final String? model;
  // Real wire model id the proxy forwards upstream (tier alias resolved, e.g.
  // opus → glm-5.2). Server-computed; display-only, so not sent back on save.
  final String? effectiveModel;
  const SessionSubagent({this.providerId, this.model, this.effectiveModel});

  factory SessionSubagent.fromJson(dynamic j) => j is Map
      ? SessionSubagent(
          providerId: j['providerId']?.toString(),
          model: j['model']?.toString(),
          effectiveModel: j['effectiveModel']?.toString(),
        )
      : const SessionSubagent();

  Map<String, dynamic> toJson() => {
    'providerId': providerId ?? '',
    'model': model ?? '',
  };

  bool get isEmpty =>
      (providerId == null || providerId == '') &&
      (model == null || model == '');
}

/// One concrete route in an Auto Provider pool. The virtual Auto selection is
/// never used as a provider id; each turn resolves to one of these routes.
class SessionProviderCandidate {
  final String providerId;
  final String? model;
  final int priority;
  final bool enabled;

  const SessionProviderCandidate({
    required this.providerId,
    this.model,
    required this.priority,
    this.enabled = true,
  });

  factory SessionProviderCandidate.fromJson(Map<dynamic, dynamic> json) =>
      SessionProviderCandidate(
        providerId: json['providerId']?.toString() ?? '',
        model: json['model']?.toString(),
        priority: (json['priority'] as num?)?.toInt() ?? 1,
        enabled: json['enabled'] != false,
      );

  Map<String, dynamic> toJson() => {
    'providerId': providerId,
    'model': model == null || model!.isEmpty ? null : model,
    'priority': priority,
    'enabled': enabled,
  };
}

/// Additive session-level Auto Provider contract. `Session.provider` remains
/// the concrete manual fallback for backwards compatibility.
class SessionProviderSelection {
  final int version;
  final String mode;
  final String protocol;
  final List<SessionProviderCandidate> candidates;
  final int maxAttempts;
  final bool sticky;
  final bool allowCrossTrust;

  const SessionProviderSelection({
    this.version = 1,
    this.mode = 'auto',
    required this.protocol,
    required this.candidates,
    required this.maxAttempts,
    this.sticky = true,
    this.allowCrossTrust = false,
  });

  Map<String, dynamic> toJson() => {
    'version': version,
    'mode': mode,
    'protocol': protocol,
    'candidates': candidates.map((candidate) => candidate.toJson()).toList(),
    'maxAttempts': maxAttempts,
    'sticky': sticky,
    'allowCrossTrust': allowCrossTrust,
  };
}

SessionProviderSelection? parseProviderSelection(dynamic json) {
  if (json is! Map || json['mode'] != 'auto') return null;
  final protocol = json['protocol']?.toString() ?? '';
  final rawCandidates = json['candidates'];
  if (protocol.isEmpty || rawCandidates is! List) return null;
  final candidates = rawCandidates
      .whereType<Map>()
      .map(SessionProviderCandidate.fromJson)
      .where((candidate) => candidate.providerId.isNotEmpty)
      .toList(growable: false);
  if (candidates.length < 2) return null;
  return SessionProviderSelection(
    version: (json['version'] as num?)?.toInt() ?? 1,
    protocol: protocol,
    candidates: candidates,
    maxAttempts: (json['maxAttempts'] as num?)?.toInt() ?? 2,
    sticky: json['sticky'] != false,
    allowCrossTrust: json['allowCrossTrust'] == true,
  );
}

class SessionCliState {
  final bool hasNativeSession;
  final int? lastActivatedAt;
  final int? updatedAt;
  final String? model;
  final String? provider;
  final SessionProviderSelection? providerSelection;
  final String? effort;
  final String? agent;

  const SessionCliState({
    this.hasNativeSession = false,
    this.lastActivatedAt,
    this.updatedAt,
    this.model,
    this.provider,
    this.providerSelection,
    this.effort,
    this.agent,
  });

  factory SessionCliState.fromJson(dynamic json) {
    final map = json is Map ? json : const {};
    return SessionCliState(
      hasNativeSession: map['hasNativeSession'] == true,
      lastActivatedAt: (map['lastActivatedAt'] as num?)?.toInt(),
      updatedAt: (map['updatedAt'] as num?)?.toInt(),
      model: map['model']?.toString(),
      provider: map['provider']?.toString(),
      providerSelection: parseProviderSelection(map['providerSelection']),
      effort: map['effort']?.toString(),
      agent: map['agent']?.toString(),
    );
  }
}

class CliHandoff {
  final String? id;
  final SessionCli fromCli;
  final SessionCli toCli;
  final String status;
  final String? reason;
  final bool reusedTarget;

  const CliHandoff({
    this.id,
    required this.fromCli,
    required this.toCli,
    required this.status,
    this.reason,
    this.reusedTarget = false,
  });

  factory CliHandoff.fromJson(Map<dynamic, dynamic> json) => CliHandoff(
    id: json['id']?.toString(),
    fromCli: parseCli(json['fromCli']?.toString()),
    toCli: parseCli(json['toCli']?.toString()),
    status: json['status']?.toString() ?? '',
    reason: json['reason']?.toString(),
    reusedTarget: json['reusedTarget'] == true,
  );
}

Map<SessionCli, SessionCliState> parseCliStates(dynamic json) {
  if (json is! Map) return const {};
  final result = <SessionCli, SessionCliState>{};
  for (final entry in json.entries) {
    final cli = tryParseCli(entry.key.toString());
    if (cli != null) result[cli] = SessionCliState.fromJson(entry.value);
  }
  return result;
}

Map<SessionCli, bool> parseCliAvailability(dynamic json) {
  if (json is! Map) return const {};
  final result = <SessionCli, bool>{};
  for (final entry in json.entries) {
    final cli = tryParseCli(entry.key.toString());
    if (cli == null) continue;
    final value = entry.value;
    result[cli] = value is Map ? value['available'] == true : value == true;
  }
  return result;
}

/// Runtime settings returned by GET /api/sessions/:id and switch-cli.
class SessionCliConfig {
  final SessionCli cli;
  final Map<SessionCli, SessionCliState> cliStates;
  final Map<SessionCli, bool> cliAvailability;
  final CliHandoff? pendingCliHandoff;
  final String? provider;
  final SessionProviderSelection? providerSelection;
  final String? providerName;
  final String? providerBaseUrl;
  final String? model;
  final String? effectiveModel;
  final String? effort;
  final String? effectiveEffort;
  final String? agent;
  final SessionSubagent? subagent;
  final bool deferred;
  final SessionCli? pendingCli;
  final bool changed;
  final bool reusedTarget;

  const SessionCliConfig({
    required this.cli,
    this.cliStates = const {},
    this.cliAvailability = const {},
    this.pendingCliHandoff,
    this.provider,
    this.providerSelection,
    this.providerName,
    this.providerBaseUrl,
    this.model,
    this.effectiveModel,
    this.effort,
    this.effectiveEffort,
    this.agent,
    this.subagent,
    this.deferred = false,
    this.pendingCli,
    this.changed = false,
    this.reusedTarget = false,
  });

  factory SessionCliConfig.fromJson(Map<String, dynamic> json) {
    final handoff = json['pendingCliHandoff'];
    return SessionCliConfig(
      cli: parseCli(json['cli']?.toString()),
      cliStates: parseCliStates(json['cliStates']),
      cliAvailability: parseCliAvailability(json['cliAvailability']),
      pendingCliHandoff: handoff is Map ? CliHandoff.fromJson(handoff) : null,
      provider: json['provider']?.toString(),
      providerSelection: parseProviderSelection(json['providerSelection']),
      providerName: json['providerName']?.toString(),
      providerBaseUrl: json['providerBaseUrl']?.toString(),
      model: json['model']?.toString(),
      effectiveModel: json['effectiveModel']?.toString(),
      effort: json['effort']?.toString(),
      effectiveEffort: json['effectiveEffort']?.toString(),
      agent: json['agent']?.toString(),
      subagent: json['subagent'] == null
          ? null
          : SessionSubagent.fromJson(json['subagent']),
      deferred: json['deferred'] == true || json['pendingConfiguration'] is Map,
      pendingCli: json['pendingConfiguration'] is Map
          ? parseCli(json['pendingConfiguration']['cli']?.toString())
          : null,
      changed: json['changed'] == true,
      reusedTarget: json['reusedTarget'] == true,
    );
  }
}

class Session {
  final String id;
  final String? dirId;
  final SessionCli cli;
  final SessionKind kind;
  final String? cliSessionId;
  final String? label;
  final String? model;
  final String?
  effectiveModel; // model actually used at spawn time (override > provider > /model default)
  final String? effort; // Claude effort / Codex reasoning level override
  final String?
  effectiveEffort; // concrete effort / reasoning level used for display
  final String? rolePrompt;
  final String? provider; // cc-switch provider id; null = default login
  final SessionProviderSelection? providerSelection;
  final SessionSubagent?
  subagent; // Task-tool subagent provider+model override (claude-proxy)
  final String? agent; // Native --agent for Claude/OpenCode.
  final Map<SessionCli, SessionCliState> cliStates;
  final CliHandoff? pendingCliHandoff;
  final bool?
  streaming; // per-session stream mode (claude chat defaults true; server 2ad82ec)
  final String cwd;
  final DateTime createdAt;
  final bool active;
  final int clients;
  final DateTime? lastActivity;
  final String? type; // 'aux' for the special AuxQueue session
  final String? auxLabel;
  final String? taskBoundTaskId;

  /// 会话级「自动提交」（对齐 web 的 `#auto-commit-btn`）：每轮成功后若该轮
  /// 的勾选仍为真、且工作树确实有事可合，就自动 merge 回基分支。
  ///
  /// 服务端缺省是「开」（`create-record.js` 里 `autoCommit !== false`），
  /// 所以这里也把「字段缺失」当成 true，而不是 false。
  final bool autoCommit;

  Session({
    required this.id,
    this.dirId,
    this.cli = SessionCli.claude,
    this.kind = SessionKind.terminal,
    this.cliSessionId,
    this.label,
    this.model,
    this.effectiveModel,
    this.effort,
    this.effectiveEffort,
    this.rolePrompt,
    this.provider,
    this.providerSelection,
    this.subagent,
    this.agent,
    this.cliStates = const {},
    this.pendingCliHandoff,
    this.streaming,
    this.cwd = '',
    required this.createdAt,
    this.active = false,
    this.clients = 0,
    this.lastActivity,
    this.type,
    this.auxLabel,
    this.taskBoundTaskId,
    this.autoCommit = true,
  });

  factory Session.fromJson(Map<String, dynamic> json) {
    return Session(
      id: (json['id'] ?? '').toString(),
      dirId: json['dirId']?.toString(),
      cli: parseCli(json['cli']?.toString()),
      kind: _parseKind(json['kind']?.toString()),
      cliSessionId: json['cliSessionId']?.toString(),
      label: json['label']?.toString(),
      model: json['model']?.toString(),
      effectiveModel: json['effectiveModel']?.toString(),
      effort: json['effort']?.toString(),
      effectiveEffort: json['effectiveEffort']?.toString(),
      rolePrompt: json['rolePrompt']?.toString(),
      provider: json['provider']?.toString(),
      providerSelection: parseProviderSelection(json['providerSelection']),
      subagent: json['subagent'] == null
          ? null
          : SessionSubagent.fromJson(json['subagent']),
      agent: json['agent']?.toString(),
      cliStates: parseCliStates(json['cliStates']),
      pendingCliHandoff: json['pendingCliHandoff'] is Map
          ? CliHandoff.fromJson(json['pendingCliHandoff'] as Map)
          : null,
      streaming: json['streaming'] == null ? null : json['streaming'] == true,
      cwd: (json['cwd'] ?? '').toString(),
      createdAt: json['createdAt'] != null
          ? DateTime.tryParse(json['createdAt'].toString()) ?? DateTime.now()
          : DateTime.now(),
      active: json['active'] == true,
      clients: (json['clients'] as num?)?.toInt() ?? 0,
      lastActivity: json['lastActivity'] != null
          ? DateTime.tryParse(json['lastActivity'].toString())
          : null,
      type: json['type']?.toString(),
      auxLabel: json['label']?.toString(),
      taskBoundTaskId: json['taskBoundTaskId']?.toString(),
      autoCommit: json['autoCommit'] != false,
    );
  }

  bool get isAux => type == 'aux';

  /// Standard copyWith. Today used for live label updates (session_updated
  /// pushes a new label for a session already rendered in the fleet lists) —
  /// the model is immutable so a rename replaces the list entry instead of
  /// mutating it.
  Session copyWith({
    String? label,
    String? dirId,
    String? model,
    String? effort,
    String? provider,
    String? agent,
    bool? autoCommit,
  }) {
    return Session(
      id: id,
      dirId: dirId ?? this.dirId,
      cli: cli,
      kind: kind,
      cliSessionId: cliSessionId,
      label: label ?? this.label,
      model: model ?? this.model,
      effectiveModel: effectiveModel,
      effort: effort ?? this.effort,
      effectiveEffort: effectiveEffort,
      rolePrompt: rolePrompt,
      provider: provider ?? this.provider,
      providerSelection: providerSelection,
      subagent: subagent,
      agent: agent ?? this.agent,
      cliStates: cliStates,
      pendingCliHandoff: pendingCliHandoff,
      streaming: streaming,
      cwd: cwd,
      createdAt: createdAt,
      active: active,
      clients: clients,
      lastActivity: lastActivity,
      type: type,
      auxLabel: label ?? this.label,
      taskBoundTaskId: taskBoundTaskId,
      autoCommit: autoCommit ?? this.autoCommit,
    );
  }

  bool get isCommander => type == 'commander';
  bool get isChat => kind == SessionKind.chat;
  bool get isTerminal => kind == SessionKind.terminal;

  String get displayName => id.length > 12 ? id.substring(0, 12) : id;
  String get shortCwd {
    if (cwd.isEmpty) return '/';
    final parts = cwd.split('/');
    return parts.last.isEmpty ? '/' : parts.last;
  }
}

/// A working directory (workspace). Holds multiple sessions of any cli/kind.
class Directory {
  final String id;
  final String name;
  final String path;
  final DateTime createdAt;
  final int claudeTerminalCount;
  final int claudeChatCount;
  final int codexTerminalCount;
  final int codexChatCount;
  final int opencodeTerminalCount;
  final int opencodeChatCount;
  final int zcodeTerminalCount;
  final int zcodeChatCount;
  final int qoderTerminalCount;
  final int qoderChatCount;
  final DirectoryPushState? pushState;

  Directory({
    required this.id,
    required this.name,
    required this.path,
    required this.createdAt,
    this.claudeTerminalCount = 0,
    this.claudeChatCount = 0,
    this.codexTerminalCount = 0,
    this.codexChatCount = 0,
    this.opencodeTerminalCount = 0,
    this.opencodeChatCount = 0,
    this.zcodeTerminalCount = 0,
    this.zcodeChatCount = 0,
    this.qoderTerminalCount = 0,
    this.qoderChatCount = 0,
    this.pushState,
  });

  factory Directory.fromJson(Map<String, dynamic> json) {
    final counts = (json['counts'] as Map<String, dynamic>?) ?? const {};
    return Directory(
      id: (json['id'] ?? '').toString(),
      name: (json['name'] ?? '').toString(),
      path: (json['path'] ?? '').toString(),
      createdAt: json['createdAt'] != null
          ? DateTime.tryParse(json['createdAt'].toString()) ?? DateTime.now()
          : DateTime.now(),
      claudeTerminalCount: (counts['claude_terminal'] as num?)?.toInt() ?? 0,
      claudeChatCount: (counts['claude_chat'] as num?)?.toInt() ?? 0,
      codexTerminalCount: (counts['codex_terminal'] as num?)?.toInt() ?? 0,
      codexChatCount: (counts['codex_chat'] as num?)?.toInt() ?? 0,
      opencodeTerminalCount:
          (counts['opencode_terminal'] as num?)?.toInt() ?? 0,
      opencodeChatCount: (counts['opencode_chat'] as num?)?.toInt() ?? 0,
      zcodeTerminalCount: (counts['zcode_terminal'] as num?)?.toInt() ?? 0,
      zcodeChatCount: (counts['zcode_chat'] as num?)?.toInt() ?? 0,
      qoderTerminalCount: (counts['qoder_terminal'] as num?)?.toInt() ?? 0,
      qoderChatCount: (counts['qoder_chat'] as num?)?.toInt() ?? 0,
      pushState: json['pushState'] is Map
          ? DirectoryPushState.fromJson(
              (json['pushState'] as Map).cast<String, dynamic>(),
            )
          : null,
    );
  }

  int get totalSessions =>
      claudeTerminalCount +
      claudeChatCount +
      codexTerminalCount +
      codexChatCount +
      opencodeTerminalCount +
      opencodeChatCount +
      zcodeTerminalCount +
      zcodeChatCount +
      qoderTerminalCount +
      qoderChatCount;
}

class DirectoryPushState {
  final bool available;
  final bool hasRemote;
  final int ahead;
  final int behind;
  final int dirty;
  final String? remote;
  final String? remoteBranch;

  const DirectoryPushState({
    this.available = true,
    this.hasRemote = false,
    this.ahead = 0,
    this.behind = 0,
    this.dirty = 0,
    this.remote,
    this.remoteBranch,
  });

  factory DirectoryPushState.fromJson(Map<String, dynamic> json) {
    return DirectoryPushState(
      available: json['available'] != false,
      hasRemote: json['hasRemote'] == true,
      ahead: (json['ahead'] as num?)?.toInt() ?? 0,
      behind: (json['behind'] as num?)?.toInt() ?? 0,
      dirty: (json['dirty'] as num?)?.toInt() ?? 0,
      remote: json['remote']?.toString(),
      remoteBranch: json['remoteBranch']?.toString(),
    );
  }
}

/// A multicc-native scheduled (cron) task. Mirrors the `toView` shape returned
/// by the server's /api/cron endpoints (see cron-tasks.js).
///
/// Since the Air rework a rule is not a lone timer: every rule owns exactly one
/// fixed Air task, and the runs are delivered into that task. [taskId] is that
/// binding; [taskBindingError] says why it is broken when it is. The runtime
/// fields ([provider] / [model] / [effort]) come from the fixed task, not from
/// the rule — hence they can be null before the binding exists.
class CronTask {
  final String id;
  final String name;
  final String dirId;
  final String dirName;
  final String cli; // 'claude' | 'codex'
  final String? provider;
  final String? model;
  final String? effort;
  final String prompt;
  final String
  cron; // 5-field expression: minute hour day-of-month month day-of-week
  final bool enabled;
  final String createdBy;
  final int? lastRunAt; // epoch ms
  final String? lastStatus; // 'ok' | 'queued' | 'error' | null
  final String lastError;
  final int runCount;
  final int? nextRunAt; // epoch ms

  /// 这条规则的固定 Air 任务。null 表示绑定还没建立起来。
  final String? taskId;

  /// Fixed task's title (falls back to the rule name server-side).
  final String taskTitle;
  final String taskStatus;
  final bool taskReadOnly;
  final String taskBindingError;

  CronTask({
    required this.id,
    required this.name,
    required this.dirId,
    required this.dirName,
    required this.cli,
    required this.prompt,
    required this.cron,
    required this.enabled,
    this.provider,
    this.model,
    this.effort,
    this.createdBy = 'user',
    this.lastRunAt,
    this.lastStatus,
    this.lastError = '',
    this.runCount = 0,
    this.nextRunAt,
    this.taskId,
    this.taskTitle = '',
    this.taskStatus = '',
    this.taskReadOnly = false,
    this.taskBindingError = '',
  });

  factory CronTask.fromJson(Map<String, dynamic> json) => CronTask(
    id: (json['id'] ?? '').toString(),
    name: (json['name'] ?? '').toString(),
    dirId: (json['dirId'] ?? '').toString(),
    dirName: (json['dirName'] ?? '').toString(),
    cli: (json['cli'] ?? 'claude').toString(),
    provider: json['provider']?.toString(),
    model: json['model']?.toString(),
    effort: json['effort']?.toString(),
    prompt: (json['prompt'] ?? '').toString(),
    cron: (json['cron'] ?? '').toString(),
    enabled: json['enabled'] == true,
    createdBy: (json['createdBy'] ?? 'user').toString(),
    lastRunAt: (json['lastRunAt'] as num?)?.toInt(),
    lastStatus: json['lastStatus']?.toString(),
    lastError: (json['lastError'] ?? '').toString(),
    runCount: (json['runCount'] as num?)?.toInt() ?? 0,
    nextRunAt: (json['nextRunAt'] as num?)?.toInt(),
    taskId: json['taskId']?.toString(),
    taskTitle: (json['taskTitle'] ?? '').toString(),
    taskStatus: (json['taskStatus'] ?? '').toString(),
    taskReadOnly: json['taskReadOnly'] == true,
    taskBindingError: (json['taskBindingError'] ?? '').toString(),
  );
}
