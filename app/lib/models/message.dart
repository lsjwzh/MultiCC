enum MessageRole { user, assistant, system }

/// Token usage information for a message (mirrors Anthropic's usage shape)
class MessageUsage {
  final int inputTokens;
  final int outputTokens;
  final int cacheReadTokens;
  final int cacheCreationTokens;

  const MessageUsage({
    this.inputTokens = 0,
    this.outputTokens = 0,
    this.cacheReadTokens = 0,
    this.cacheCreationTokens = 0,
  });

  int get total => inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens;
  bool get isEmpty => total == 0;

  factory MessageUsage.fromJson(Map<String, dynamic> json) {
    return MessageUsage(
      inputTokens: (json['input_tokens'] as num?)?.toInt() ?? 0,
      outputTokens: (json['output_tokens'] as num?)?.toInt() ?? 0,
      cacheReadTokens: (json['cache_read_input_tokens'] as num?)?.toInt() ?? 0,
      cacheCreationTokens: (json['cache_creation_input_tokens'] as num?)?.toInt() ?? 0,
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

  ToolCall({
    required this.id,
    required this.name,
    this.inputJson = '',
    this.result,
    this.isError = false,
    this.isDone = false,
  });

  Map<String, dynamic>? get parsedInput {
    try {
      if (inputJson.isEmpty) return null;
      return _jsonDecode(inputJson);
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

Map<String, dynamic> _jsonDecode(String s) {
  // Simple wrapper — dart:convert is imported at use site
  return {};
}

class ChatMessage {
  final MessageRole role;
  String content;
  final List<ToolCall> toolCalls;
  final DateTime timestamp;
  bool isStreaming;
  double? cost;
  MessageUsage? usage;
  /// Wall-clock time from user submit to AI reply completion (ms).
  /// Stamped by the server (cs.turnStartedAt → result) and persisted in
  /// chat_history; shown under each assistant bubble as "任务耗时".
  int? durationMs;

  ChatMessage({
    required this.role,
    this.content = '',
    List<ToolCall>? toolCalls,
    DateTime? timestamp,
    this.isStreaming = false,
    this.cost,
    this.usage,
    this.durationMs,
  }) : toolCalls = toolCalls ?? [],
       timestamp = timestamp ?? DateTime.now();

  ChatMessage.fromHistory(Map<String, dynamic> json)
    : role = json['role'] == 'user' ? MessageRole.user : MessageRole.assistant,
      content = (json['content'] ?? '').toString(),
      toolCalls = _parseHistoryTools(json['tools']),
      timestamp = json['ts'] != null
          ? DateTime.fromMillisecondsSinceEpoch((json['ts'] as num).toInt())
          : DateTime.now(),
      isStreaming = false,
      cost = (json['cost'] as num?)?.toDouble(),
      usage = json['usage'] is Map
          ? MessageUsage.fromJson(json['usage'] as Map<String, dynamic>)
          : null,
      durationMs = (json['durationMs'] as num?)?.toInt();

  static List<ToolCall> _parseHistoryTools(dynamic tools) {
    if (tools is! List) return [];
    return tools.map((t) {
      final tc = ToolCall(
        id: (t['id'] ?? '').toString(),
        name: (t['name'] ?? '').toString(),
        inputJson: t['input'] != null ? t['input'].toString() : '',
        result: t['result']?.toString(),
        isError: t['is_error'] == true,
        isDone: true,
      );
      return tc;
    }).toList();
  }
}

/// Which CLI binary this session drives. Claude Code or OpenAI Codex.
enum SessionCli { claude, codex }

/// Interactive TUI terminal, or stream-json chat.
enum SessionKind { terminal, chat }

SessionCli _parseCli(String? s) =>
    s == 'codex' ? SessionCli.codex : SessionCli.claude;
SessionKind _parseKind(String? s) =>
    s == 'chat' ? SessionKind.chat : SessionKind.terminal;

extension SessionCliX on SessionCli {
  String get name => this == SessionCli.codex ? 'codex' : 'claude';
}

extension SessionKindX on SessionKind {
  String get name => this == SessionKind.chat ? 'chat' : 'terminal';
}

/// Claude model choices for new sessions / live switching.
/// Empty value = follow the user's /model default on the server machine.
const kClaudeModelOptions = <MapEntry<String, String>>[
  MapEntry('', '默认（跟随 Claude 设置）'),
  MapEntry('claude-fable-5', 'Fable 5'),
  MapEntry('claude-fable-5[1m]', 'Fable 5 (1M context)'),
  MapEntry('claude-opus-4-8', 'Opus 4.8'),
  MapEntry('claude-sonnet-4-6', 'Sonnet 4.6'),
  MapEntry('claude-haiku-4-5-20251001', 'Haiku 4.5'),
];

String claudeModelShortName(String? model) {
  if (model == null || model.isEmpty) return '默认';
  for (final e in kClaudeModelOptions) {
    if (e.key == model) return e.value;
  }
  return model;
}

class Session {
  final String id;
  final String? dirId;
  final SessionCli cli;
  final SessionKind kind;
  final String? cliSessionId;
  final String? label;
  final String? model;
  final String? effectiveModel; // model actually used at spawn time (override > provider > /model default)
  final String? rolePrompt;
  final String? provider; // cc-switch provider id; null = default login
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
    this.rolePrompt,
    this.provider,
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
      cli: _parseCli(json['cli']?.toString()),
      kind: _parseKind(json['kind']?.toString()),
      cliSessionId: json['cliSessionId']?.toString(),
      label: json['label']?.toString(),
      model: json['model']?.toString(),
      effectiveModel: json['effectiveModel']?.toString(),
      rolePrompt: json['rolePrompt']?.toString(),
      provider: json['provider']?.toString(),
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
      codexChatCount;
}

class DirectoryPushState {
  final bool available;
  final bool hasRemote;
  final int ahead;
  final int behind;
  final String? remote;
  final String? remoteBranch;

  const DirectoryPushState({
    this.available = true,
    this.hasRemote = false,
    this.ahead = 0,
    this.behind = 0,
    this.remote,
    this.remoteBranch,
  });

  factory DirectoryPushState.fromJson(Map<String, dynamic> json) {
    return DirectoryPushState(
      available: json['available'] != false,
      hasRemote: json['hasRemote'] == true,
      ahead: (json['ahead'] as num?)?.toInt() ?? 0,
      behind: (json['behind'] as num?)?.toInt() ?? 0,
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
