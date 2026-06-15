enum MessageRole { user, assistant, system }

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
    return (p['description'] ?? p['command'] ?? p['pattern'] ?? p['file_path'] ?? '').toString();
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

  ChatMessage({
    required this.role,
    this.content = '',
    List<ToolCall>? toolCalls,
    DateTime? timestamp,
    this.isStreaming = false,
    this.cost,
  })  : toolCalls = toolCalls ?? [],
        timestamp = timestamp ?? DateTime.now();

  ChatMessage.fromHistory(Map<String, dynamic> json)
      : role = json['role'] == 'user' ? MessageRole.user : MessageRole.assistant,
        content = (json['content'] ?? '').toString(),
        toolCalls = _parseHistoryTools(json['tools']),
        timestamp = json['ts'] != null
            ? DateTime.fromMillisecondsSinceEpoch((json['ts'] as num).toInt() * 1000)
            : DateTime.now(),
        isStreaming = false,
        cost = (json['cost'] as num?)?.toDouble();

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

SessionCli _parseCli(String? s) => s == 'codex' ? SessionCli.codex : SessionCli.claude;
SessionKind _parseKind(String? s) => s == 'chat' ? SessionKind.chat : SessionKind.terminal;

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
  final String? rolePrompt;
  final String cwd;
  final DateTime createdAt;
  final bool active;
  final int clients;
  final DateTime? lastActivity;
  final String? type;   // 'aux' for the special AuxQueue session
  final String? auxLabel;

  Session({
    required this.id,
    this.dirId,
    this.cli = SessionCli.claude,
    this.kind = SessionKind.terminal,
    this.cliSessionId,
    this.label,
    this.model,
    this.rolePrompt,
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
      rolePrompt: json['rolePrompt']?.toString(),
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

  Directory({
    required this.id,
    required this.name,
    required this.path,
    required this.createdAt,
    this.claudeTerminalCount = 0,
    this.claudeChatCount = 0,
    this.codexTerminalCount = 0,
    this.codexChatCount = 0,
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
    );
  }

  int get totalSessions =>
      claudeTerminalCount + claudeChatCount + codexTerminalCount + codexChatCount;
}
