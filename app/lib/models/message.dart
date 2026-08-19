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

  ChatMessage({
    required this.role,
    this.content = '',
    List<ToolCall>? toolCalls,
    DateTime? timestamp,
    this.isStreaming = false,
    this.isPartial = false,
    this.cost,
    this.usage,
    this.id,
    this.durationMs,
    this.clientMsgId,
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
      id = (json['id']?.toString().isNotEmpty ?? false)
          ? json['id'].toString()
          : null,
      durationMs = (json['durationMs'] as num?)?.toInt(),
      clientMsgId = (json['clientMsgId']?.toString().isNotEmpty ?? false)
          ? json['clientMsgId'].toString()
          : null;

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
enum SessionCli { claude, codex, opencode, zcode, qoder }

/// Interactive TUI terminal, or stream-json chat.
enum SessionKind { terminal, chat }

SessionCli? tryParseCli(String? s) {
  switch (s) {
    case 'claude':
      return SessionCli.claude;
    case 'codex':
      return SessionCli.codex;
    case 'opencode':
      return SessionCli.opencode;
    case 'zcode':
      return SessionCli.zcode;
    case 'qoder':
      return SessionCli.qoder;
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
    SessionCli.codex => 'codex',
    SessionCli.opencode => 'opencode',
    SessionCli.zcode => 'zcode',
    SessionCli.qoder => 'qoder',
    SessionCli.claude => 'claude',
  };

  /// Provider pool this CLI maps to. codex has its own pool;
  /// claude/opencode/zcode share the Anthropic-compatible 'claude' pool.
  /// Qoder CN owns its account/BYOK settings and does not expose a MultiCC pool.
  String get appType => this == SessionCli.codex ? 'codex' : 'claude';

  /// Human-readable label for UI display.
  String get displayName => switch (this) {
    SessionCli.claude => 'Claude',
    SessionCli.codex => 'Codex',
    SessionCli.opencode => 'OpenCode',
    SessionCli.zcode => 'ZCode',
    SessionCli.qoder => 'Qoder CN',
  };

  bool get supportsProvider => this != SessionCli.qoder;
  bool get supportsAgent =>
      this == SessionCli.claude ||
      this == SessionCli.opencode ||
      this == SessionCli.qoder;
  bool get supportsSubagent =>
      this == SessionCli.claude || this == SessionCli.codex;
  bool get supportsEffort => this != SessionCli.zcode;

  String get effortFieldLabel => switch (this) {
    SessionCli.claude => 'Effort',
    SessionCli.codex => 'Reasoning Level',
    SessionCli.opencode => 'Variant',
    SessionCli.zcode => '',
    SessionCli.qoder => 'Reasoning Effort',
  };

  String get defaultEffort => switch (this) {
    SessionCli.claude => 'medium',
    SessionCli.codex => 'xhigh',
    SessionCli.opencode => '',
    SessionCli.zcode => '',
    SessionCli.qoder => '',
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
    SessionCli.codex => const [
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

String claudeModelShortName(String? model) {
  if (model == null || model.isEmpty) return '默认';
  for (final e in kClaudeModelOptions) {
    if (e.key == model) return e.value;
  }
  return model;
}

String modelShortNameForCli(SessionCli cli, String? model) {
  if (cli == SessionCli.claude) return claudeModelShortName(model);
  if (cli == SessionCli.qoder) {
    for (final option in kQoderModelOptions) {
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
  if (cli == SessionCli.opencode && v.isEmpty) return 'Default';
  if (cli == SessionCli.codex ||
      cli == SessionCli.opencode ||
      cli == SessionCli.qoder) {
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

class SessionCliState {
  final bool hasNativeSession;
  final int? lastActivatedAt;
  final int? updatedAt;
  final String? model;
  final String? provider;
  final String? effort;
  final String? agent;

  const SessionCliState({
    this.hasNativeSession = false,
    this.lastActivatedAt,
    this.updatedAt,
    this.model,
    this.provider,
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
  final String? providerName;
  final String? providerBaseUrl;
  final String? model;
  final String? effectiveModel;
  final String? effort;
  final String? effectiveEffort;
  final String? agent;
  final SessionSubagent? subagent;
  final bool changed;
  final bool reusedTarget;

  const SessionCliConfig({
    required this.cli,
    this.cliStates = const {},
    this.cliAvailability = const {},
    this.pendingCliHandoff,
    this.provider,
    this.providerName,
    this.providerBaseUrl,
    this.model,
    this.effectiveModel,
    this.effort,
    this.effectiveEffort,
    this.agent,
    this.subagent,
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
class CronTask {
  final String id;
  final String name;
  final String dirId;
  final String dirName;
  final String cli; // 'claude' | 'codex'
  final String prompt;
  final String
  cron; // 5-field expression: minute hour day-of-month month day-of-week
  final bool enabled;
  final String createdBy;
  final int? lastRunAt; // epoch ms
  final String? lastStatus; // 'ok' | 'error' | 'spawn-failed' | null
  final String lastError;
  final int runCount;
  final int? nextRunAt; // epoch ms

  CronTask({
    required this.id,
    required this.name,
    required this.dirId,
    required this.dirName,
    required this.cli,
    required this.prompt,
    required this.cron,
    required this.enabled,
    this.createdBy = 'user',
    this.lastRunAt,
    this.lastStatus,
    this.lastError = '',
    this.runCount = 0,
    this.nextRunAt,
  });

  factory CronTask.fromJson(Map<String, dynamic> json) => CronTask(
    id: (json['id'] ?? '').toString(),
    name: (json['name'] ?? '').toString(),
    dirId: (json['dirId'] ?? '').toString(),
    dirName: (json['dirName'] ?? '').toString(),
    cli: (json['cli'] ?? 'claude').toString(),
    prompt: (json['prompt'] ?? '').toString(),
    cron: (json['cron'] ?? '').toString(),
    enabled: json['enabled'] == true,
    createdBy: (json['createdBy'] ?? 'user').toString(),
    lastRunAt: (json['lastRunAt'] as num?)?.toInt(),
    lastStatus: json['lastStatus']?.toString(),
    lastError: (json['lastError'] ?? '').toString(),
    runCount: (json['runCount'] as num?)?.toInt() ?? 0,
    nextRunAt: (json['nextRunAt'] as num?)?.toInt(),
  );
}
