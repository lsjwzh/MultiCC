import 'dart:async';
import 'package:flutter/widgets.dart';

import '../models/message.dart';
import '../services/chat_service.dart';
import '../services/notification_service.dart';
import '../services/settings_service.dart';

class ChatProvider extends ChangeNotifier {
  final SettingsService settings;
  final String sessionName;
  String displayName;
  String sessionCwd;

  late ChatService _service;
  StreamSubscription? _eventSub;

  final List<ChatMessage> _messages = [];
  List<ChatMessage> get messages => List.unmodifiable(_messages);

  ChatConnectionState _connectionState = ChatConnectionState.disconnected;
  ChatConnectionState get connectionState => _connectionState;

  bool get isStreaming => _service.isStreaming;

  String? _sessionId;
  String get sessionId => _sessionId ?? '';

  String _cwd = '';
  String get cwd => _cwd;

  /// CLI driving this chat — learned from the server's `system init` event.
  SessionCli _cli = SessionCli.claude;
  SessionCli get cli => _cli;

  String _statusText = 'Disconnected';
  String get statusText => _statusText;

  String _costText = '';
  String get costText => _costText;

  ChatMessage? _currentMsg;
  final Map<int, ToolCall> _activeTools = {};
  int _reconnectAttempt = 0;
  bool _historyApplied = false;

  /// Whether this session is the one currently viewed by the user.
  bool isActive = true;

  /// Whether the entire app is in the background.
  bool isInBackground = false;

  ChatProvider({
    required this.settings,
    required this.sessionName,
    String? displayName,
    required this.sessionCwd,
  }) : displayName = displayName ?? sessionName {
    _cwd = sessionCwd;
    _initService();
  }

  void setDisplayName(String value) {
    if (displayName == value) return;
    displayName = value;
    notifyListeners();
  }

  // ── Service init ───────────────────────────────────────────────────────────

  void _initService() {
    _service = ChatService(
      settings: settings,
      sessionName: sessionName,
      sessionCwd: sessionCwd,
      initialSessionId: _sessionId,
    );
    _eventSub?.cancel();
    _eventSub = _service.events.listen(_onEvent);
    _service.connect();
  }

  // ── Event handling ─────────────────────────────────────────────────────────

  void _onEvent(ChatEvent evt) {
    switch (evt.type) {
      case 'state_change':
        _connectionState = evt.payload as ChatConnectionState;
        if (_connectionState == ChatConnectionState.connected) {
          _reconnectAttempt = 0;
          _statusText = 'Connected';
        }
        notifyListeners();
        break;

      case 'reconnecting':
        _reconnectAttempt = evt.payload as int;
        final delay = (1 << (_reconnectAttempt - 1)).clamp(1, 15);
        _statusText = 'Reconnecting in ${delay}s…';
        notifyListeners();
        break;

      case 'system_init':
        final msg = evt.payload as Map<String, dynamic>;
        final sid = (msg['session_id'] ?? msg['session'])?.toString();
        if (sid != null && sid.isNotEmpty) _sessionId = sid;
        if (msg['cwd'] != null) _cwd = msg['cwd'].toString();
        if (msg['cli'] != null) {
          _cli = msg['cli'].toString() == 'codex'
              ? SessionCli.codex
              : SessionCli.claude;
        }

        final model = msg['model']?.toString();
        _statusText = model != null
            ? 'Connected · $model'
            : 'Connected · ${_cli.name}';

        final serverStreaming = msg['is_streaming'] == true;
        if (serverStreaming && _currentMsg == null) {
          _ensureAssistantMsg();
        } else if (!serverStreaming && _currentMsg != null) {
          _finishStreaming();
          _addSystemMsg('⚠️ Response completed while disconnected.');
        }
        notifyListeners();
        break;

      case 'system_msg':
        _addSystemMsg(evt.payload as String);
        break;

      case 'chat_history':
        if (!_historyApplied) {
          _historyApplied = true;
          _replayHistory(evt.payload as List);
        }
        break;

      case 'message_start':
        _onMessageStart();
        break;

      case 'content_block_start':
        _onContentBlockStart(evt.payload as Map<String, dynamic>);
        break;

      case 'content_block_delta':
        _onContentBlockDelta(evt.payload as Map<String, dynamic>);
        break;

      case 'content_block_stop':
        break;

      case 'message_delta':
        break;

      case 'result':
        _onResult(evt.payload as Map<String, dynamic>);
        break;

      case 'error':
        _addSystemMsg('Error: ${evt.payload}');
        _finishStreaming();
        _maybeNotify('错误', evt.payload.toString());
        notifyListeners();
        break;
    }
  }

  void _onMessageStart() {
    _ensureAssistantMsg();
    notifyListeners();
  }

  void _ensureAssistantMsg() {
    if (_currentMsg == null) {
      _currentMsg = ChatMessage(role: MessageRole.assistant, isStreaming: true);
      _messages.add(_currentMsg!);
      _activeTools.clear();
    }
  }

  void _onContentBlockStart(Map<String, dynamic> evt) {
    final idx = (evt['index'] as num?)?.toInt() ?? 0;
    final block = evt['content_block'] as Map<String, dynamic>?;
    final bType = block?['type'] as String? ?? '';

    if (bType == 'tool_use') {
      final tc = ToolCall(
        id: (block?['id'] ?? '').toString(),
        name: (block?['name'] ?? '').toString(),
      );
      _activeTools[idx] = tc;
      _ensureAssistantMsg();
      _currentMsg!.toolCalls.add(tc);
      notifyListeners();
    }
  }

  void _onContentBlockDelta(Map<String, dynamic> evt) {
    final idx = (evt['index'] as num?)?.toInt() ?? 0;
    final delta = evt['delta'] as Map<String, dynamic>?;
    final dType = delta?['type'] as String? ?? '';

    if (dType == 'text_delta') {
      final text = delta?['text'] as String? ?? '';
      _ensureAssistantMsg();
      _currentMsg!.content += text;
      notifyListeners();
    } else if (dType == 'input_json_delta') {
      final partial = delta?['partial_json'] as String? ?? '';
      final tc = _activeTools[idx];
      if (tc != null) {
        tc.inputJson += partial;
        notifyListeners();
      }
    }
  }

  void _onResult(Map<String, dynamic> msg) {
    _finishStreaming();

    final cost = (msg['total_cost_usd'] as num?)?.toDouble();
    final ms = (msg['duration_ms'] as num?)?.toInt();
    final turns = (msg['num_turns'] as num?)?.toInt();

    if (cost != null) {
      _costText = '\$${cost.toStringAsFixed(4)}';
      if (ms != null) _costText += ' · ${ms}ms';
      if (turns != null) _costText += ' · $turns turn(s)';
    }

    _maybeNotify('任务完成', cost != null ? '\$${cost.toStringAsFixed(4)}' : '');

    notifyListeners();
  }

  /// Send a local notification if this session is not currently visible.
  void _maybeNotify(String title, String detail) {
    if (isInBackground || !isActive) {
      NotificationService.show(
        title: 'MultiCC #$sessionName: $title',
        body: detail.isNotEmpty ? detail : sessionName,
        id: sessionName.hashCode,
      );
    }
  }

  void _finishStreaming() {
    if (_currentMsg != null) {
      _currentMsg!.isStreaming = false;
      for (final tc in _currentMsg!.toolCalls) {
        tc.isDone = true;
      }
      _currentMsg = null;
    }
    _activeTools.clear();
  }

  void _replayHistory(List history) {
    final insertIdx = _currentMsg != null
        ? _messages.length - 1
        : _messages.length;
    final parsed = history
        .map((m) {
          try {
            return ChatMessage.fromHistory(m as Map<String, dynamic>);
          } catch (_) {
            return null;
          }
        })
        .whereType<ChatMessage>()
        .toList();
    _messages.insertAll(insertIdx, parsed);
    notifyListeners();
  }

  void _addSystemMsg(String text) {
    _messages.add(ChatMessage(role: MessageRole.system, content: text));
    notifyListeners();
  }

  // ── Public actions ─────────────────────────────────────────────────────────

  void sendMessage(String text) {
    if (text.trim().isEmpty) return;
    _messages.add(ChatMessage(role: MessageRole.user, content: text.trim()));
    _service.send(text.trim());
    notifyListeners();
  }

  void cancel() => _service.cancel();

  void clearHistory() {
    _messages.clear();
    _currentMsg = null;
    _activeTools.clear();
    _historyApplied = false;
    _service.clearHistory();
    notifyListeners();
  }

  void reconnect() => _reconnect(preserveHistory: true);

  void _reconnect({required bool preserveHistory}) {
    if (!preserveHistory) {
      _messages.clear();
      _currentMsg = null;
      _activeTools.clear();
      _historyApplied = false;
    }
    _service.dispose();
    _initService();
  }

  void changeCwd(String newCwd) {
    _cwd = newCwd;
    sessionCwd = newCwd;
    _reconnect(preserveHistory: false);
  }

  @override
  void dispose() {
    _eventSub?.cancel();
    _service.dispose();
    super.dispose();
  }
}
