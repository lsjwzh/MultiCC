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
  String dirName;
  String sessionCwd;

  /// Human-facing identity in the form `directory / alias` (falls back to just
  /// the alias, and the alias falls back to the session id). Used in the chat
  /// header and notifications so the user sees the project + session name
  /// instead of a raw id.
  String get titleLabel =>
      dirName.isNotEmpty ? '$dirName / $displayName' : displayName;

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

  /// True once we've successfully connected at least once, so we can tell a
  /// fresh first connect apart from a (service-driven) reconnect.
  bool _hasConnectedOnce = false;

  /// When a resume/half-open reconnect is in flight, the next `chat_history`
  /// is a refresh that should REPLACE the on-screen transcript atomically
  /// (rather than the insert used on the very first load).
  bool _replaceHistoryOnReconnect = false;

  /// Whether this session is the one currently viewed by the user.
  bool isActive = true;

  /// Whether the entire app is in the background.
  bool isInBackground = false;

  ChatProvider({
    required this.settings,
    required this.sessionName,
    String? displayName,
    String? dirName,
    required this.sessionCwd,
  })  : displayName = displayName ?? sessionName,
        dirName = dirName ?? '' {
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
          // ChatService reconnects on its own (heartbeat timeout / onDone /
          // onError) WITHOUT going through our reconnect(), so `_historyApplied`
          // would stay true and the server's authoritative `chat_history` sent
          // on the new socket would be ignored — leaving the chat frozen on a
          // stale, half-streamed bubble until a manual refresh. On any
          // non-first connect, re-arm the history refresh so the next
          // chat_history atomically replaces the transcript, catching up on
          // anything that completed while we were disconnected. Matches the web
          // client, which reloads authoritative history on reconnect.
          if (_hasConnectedOnce) {
            _historyApplied = false;
            _replaceHistoryOnReconnect = true;
          }
          _hasConnectedOnce = true;
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
          final history = evt.payload as List;
          if (_replaceHistoryOnReconnect) {
            _replaceHistoryOnReconnect = false;
            _replaceHistory(history);
          } else {
            _replayHistory(history);
          }
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

      case 'notify':
        // The server's aux-AI decided this turn is done / waiting. This is the
        // single source of truth for completion notifications — the client does
        // not judge completion itself from `result`.
        final p = evt.payload as Map<String, dynamic>;
        final waiting = p['state'] == 'waiting';
        _maybeNotify(
          waiting ? '等待操作' : '任务完成',
          (p['message'] ?? '').toString(),
        );
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
    // Attach token usage to the current assistant message BEFORE finishing streaming
    // (because _finishStreaming() sets _currentMsg to null)
    if (msg['usage'] != null && _currentMsg != null) {
      _currentMsg!.usage = MessageUsage.fromJson(msg['usage'] as Map<String, dynamic>);
    }

    _finishStreaming();

    final cost = (msg['total_cost_usd'] as num?)?.toDouble();
    final ms = (msg['duration_ms'] as num?)?.toInt();
    final turns = (msg['num_turns'] as num?)?.toInt();

    if (cost != null) {
      _costText = '\$${cost.toStringAsFixed(4)}';
      if (ms != null) _costText += ' · ${ms}ms';
      if (turns != null) _costText += ' · $turns turn(s)';
    }

    // Completion notification is NOT fired here: a `result` only means the
    // stream stopped, which during a multi-step agent run happens between
    // turns too. The server's aux-AI debounces the pause and decides
    // done-vs-waiting, then sends a `notify` event — that is the single judge.
    notifyListeners();
  }

  /// Send a local notification if this session is not currently visible.
  void _maybeNotify(String title, String detail) {
    if (SettingsService.current?.notificationsEnabled == false) return;
    if (isInBackground || !isActive) {
      final who = titleLabel;
      NotificationService.show(
        title: 'MultiCC · $who: $title',
        body: detail.isNotEmpty ? detail : who,
        id: sessionName.hashCode,
        payload: sessionName,
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

  /// Resume / half-open reconnect refresh: swap the visible transcript for the
  /// server's authoritative history in a SINGLE rebuild. The old messages stay
  /// on screen until the new list is built, so there's no blank "clear then
  /// refill" flash — the chat reconciles in place, the way the web client does.
  void _replaceHistory(List history) {
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
    _messages
      ..clear()
      ..addAll(parsed);
    _currentMsg = null;
    _activeTools.clear();
    notifyListeners();
  }

  void _addSystemMsg(String text) {
    _messages.add(ChatMessage(role: MessageRole.system, content: text));
    notifyListeners();
  }

  // ── Public actions ─────────────────────────────────────────────────────────

  void sendMessage(String text, {bool goal = false, Map<String, dynamic>? goalLimits}) {
    final t = text.trim();
    if (t.isEmpty) return;
    final ok = _service.send(t, goal: goal, goalLimits: goalLimits);
    if (!ok) {
      // Half-open / dead socket — don't pretend the message was sent.
      _addSystemMsg('⚠️ 连接已断开，正在重连…重连后请重试。');
      notifyListeners();
      return;
    }
    _messages.add(ChatMessage(role: MessageRole.user, content: t));
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

  // Reconnect (app resume / half-open socket recovery). We still reload the
  // authoritative transcript from the server — that's required so an answer
  // that completed while we were disconnected isn't missed (preserving local
  // history was the original bug: after a socket died mid/post-response,
  // `_historyApplied` stayed true and the server's fresh chat_history was
  // ignored, leaving a stuck chat only an app restart could fix). But unlike
  // the old code we no longer wipe `_messages` up front. Clearing first made
  // the chat flash blank and "fully reload" on every resume, because
  // state_change / system_init fire a rebuild before the new history arrives.
  // Now the current transcript stays on screen and is swapped in atomically
  // when chat_history lands (see `_replaceHistory`) — matching the web client.
  void reconnect() => _reconnect();

  /// Resume after a SHORT background: probe the existing socket instead of
  /// tearing it down. Keeps the live connection (and the on-screen transcript)
  /// untouched when it's healthy — no reconnect, no reload. See
  /// [ChatService.ensureAlive].
  void ensureAlive() => _service.ensureAlive();

  void _reconnect({bool hardReset = false}) {
    if (hardReset) {
      // Genuine context switch (e.g. changing the working directory): drop the
      // old transcript immediately and reload from scratch.
      _messages.clear();
      _currentMsg = null;
      _activeTools.clear();
      _historyApplied = false;
      notifyListeners();
    } else {
      // Seamless resume: stop feeding a stale streaming bubble, then let the
      // next chat_history replace the transcript in place — no blank flash.
      _finishStreaming();
      _historyApplied = false;
      _replaceHistoryOnReconnect = true;
    }
    _service.dispose();
    _initService();
  }

  void changeCwd(String newCwd) {
    _cwd = newCwd;
    sessionCwd = newCwd;
    _reconnect(hardReset: true);
  }

  @override
  void dispose() {
    _eventSub?.cancel();
    _service.dispose();
    super.dispose();
  }
}
