import 'dart:async';
import 'package:flutter/widgets.dart';

import '../models/message.dart';
import '../services/chat_service.dart';
import '../services/notification_service.dart';
import '../services/settings_service.dart';

bool _isRecoverableCodexReconnectErrorText(String text) {
  return RegExp(r'^Codex 出错：Reconnecting\.\.\.\s*\d+/\d+\s*\(').hasMatch(text) &&
      (text.contains('stream disconnected before completion') || text.contains('response.completed'));
}

class ChatProvider extends ChangeNotifier {
  final SettingsService settings;
  final String sessionName;
  String displayName;
  String dirName;
  String sessionCwd;
  final VoidCallback? onSessionConfigChanged;

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

  /// Raw chat event stream (broadcast) — exposed so the voice call-mode
  /// service can monitor task progress (content_block_delta / result / notify)
  /// without going through the message-rendering layer. Safe to add listeners:
  /// ChatService uses a broadcast StreamController.
  Stream<ChatEvent> get chatEvents => _service.events;

  String? _sessionId;
  String get sessionId => _sessionId ?? '';

  String _cwd = '';
  String get cwd => _cwd;

  /// CLI driving this chat — learned from the server's `system init` event.
  SessionCli _cli = SessionCli.claude;
  SessionCli get cli => _cli;
  String? _lastCliSwitchHandoffId;

  String _statusText = 'Disconnected';
  String get statusText => _statusText;

  String _costText = '';
  String get costText => _costText;

  ChatMessage? _currentMsg;
  final Map<int, ToolCall> _activeTools = {};
  int _reconnectAttempt = 0;
  bool _historyApplied = false;

  // Lazy history pagination state. The initial WS chat_history push carries
  // only the newest page; older messages are fetched on scroll-up via
  // ChatService.fetchHistoryPage (GET /history?before=<id>&limit=<n>).
  bool _historyHasMore = false;
  bool _historyLoading = false;
  bool _historyExhausted = false;
  String? _oldestLoadedMsgId;

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

  /// Latest `role_token_stats` payload from the server (keyed by `role`).
  /// Cached so `_onResult` can compute savedMainTokens even if this event
  /// arrived before the result. See the WS timing note in `_onResult`.
  Map<String, dynamic>? _lastRoleTokens;

  /// aux classify verdict for THIS session — what the helper AI thinks the
  /// current goal/phase is. Updated by the `task_state` WS event; rendered as
  /// a status bar at the top of the chat (mirrors web #aux-classify-bar).
  /// `goal` empty => not classified yet => bar hidden.
  String _classifyGoal = '';
  String get classifyGoal => _classifyGoal;
  String _classifyPhase = '';
  String get classifyPhase => _classifyPhase;
  /// Live classify-state letter (D/C/W/B/E/P) - drives the bar's tint.
  /// Server sends this as `classifyState` in the task_state event (the old
  /// `lifecycle` field was removed in 98c2674 / unified in 38bb6ce).
  String _classifyState = '';
  String get classifyState => _classifyState;
  bool get hasClassify => _classifyGoal.trim().isNotEmpty;

  ChatProvider({
    required this.settings,
    required this.sessionName,
    String? displayName,
    String? dirName,
    required this.sessionCwd,
    SessionCli initialCli = SessionCli.claude,
    this.onSessionConfigChanged,
  })  : displayName = displayName ?? sessionName,
        dirName = dirName ?? '' {
    _cwd = sessionCwd;
    _cli = initialCli;
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
          _cli = parseCli(msg['cli']?.toString());
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

      case 'cli_switched':
        final msg = evt.payload as Map<String, dynamic>;
        final next = parseCli(msg['cli']?.toString());
        final from = parseCli(msg['fromCli']?.toString());
        _cli = next;
        final model = msg['effectiveModel']?.toString();
        _statusText = model != null && model.isNotEmpty
            ? 'Connected · $model'
            : 'Connected · ${next.name}';
        final handoffId = msg['handoffId']?.toString();
        if (handoffId == null || handoffId != _lastCliSwitchHandoffId) {
          _lastCliSwitchHandoffId = handoffId;
          final resumed = msg['reusedTarget'] == true ? '，已恢复该 CLI 的原会话' : '';
          _addSystemMsg(
            'CLI 已从 ${from.displayName} 切换到 ${next.displayName}$resumed；下一条消息会携带上下文交接。',
          );
        } else {
          notifyListeners();
        }
        onSessionConfigChanged?.call();
        break;

      case 'chat_history':
        if (!_historyApplied) {
          _historyApplied = true;
          final p = evt.payload as Map;
          final history = p['messages'] as List;
          final hasMore = p['hasMore'] == true;
          if (_replaceHistoryOnReconnect) {
            _replaceHistoryOnReconnect = false;
            _replaceHistory(history);
          } else {
            _replayHistory(history);
          }
          // Seed lazy-pagination cursor + hasMore from this initial page.
          _historyHasMore = hasMore;
          _historyExhausted = !hasMore;
          _oldestLoadedMsgId = _firstLoadedMsgId();
          notifyListeners();
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
        // The server's aux-AI reports turn status: running / waiting / completed.
        final p = evt.payload as Map<String, dynamic>;
        final notifyState = (p['state'] ?? 'completed').toString();
        final notifyMsg = (p['message'] ?? '').toString();
        if (notifyState == 'running') {
          // In-progress summary: update status text (visible in chat header)
          // but don't fire a push notification — it's a status update, not an
          // alert. Only show if this session is active.
          if (isActive && !isInBackground) {
            _statusText = notifyMsg.isNotEmpty ? notifyMsg : '任务进行中';
            notifyListeners();
          }
        } else {
          // Prefer the precise classifyState letter (D/C/W/B/E/P) when the
          // server provides it; fall back to the coarse notify state.
          final cls = (p['classifyState'] ?? '').toString().toUpperCase();
          String outcome;
          switch (cls) {
            case 'D':
              outcome = '任务完成';
              break;
            case 'E':
              outcome = 'API 异常';
              break;
            case 'W':
              outcome = '等待操作';
              break;
            case 'B':
              outcome = '等待后台';
              break;
            default:
              outcome = notifyState == 'waiting'
                  ? '等待交互'
                  : notifyState == 'error'
                      ? '出现异常'
                      : '任务完成';
          }
          _maybeNotify(outcome, notifyMsg);
        }
        break;

      case 'error':
        final errorText = evt.payload.toString();
        if (_isRecoverableCodexReconnectErrorText(errorText)) break;
        _addSystemMsg('Error: $errorText');
        _finishStreaming();
        _maybeNotify('错误', errorText);
        notifyListeners();
        break;

      case 'chat_msg_meta': {
        // Server saved a message and assigned its history id. Tag the newest
        // still-un-id'd bubble of that role so its delete button goes live
        // (matches web: tag last bubble of role that has no msgId yet).
        final p = evt.payload as Map<String, dynamic>;
        final id = p['id']?.toString();
        final role = p['role']?.toString();
        if (id != null && id.isNotEmpty && role != null) {
          final wantUser = role == 'user';
          for (var i = _messages.length - 1; i >= 0; i--) {
            final m = _messages[i];
            final isUser = m.role == MessageRole.user;
            if (isUser == wantUser) {
              if (m.id == null || m.id!.isEmpty) {
                m.id = id;
                notifyListeners();
              }
              break;
            }
          }
        }
        break;
      }

      case 'chat_msg_deleted': {
        // Broadcast after a successful delete from any client. Idempotent:
        // the initiator already removed it locally; this just syncs other
        // clients (and is a no-op if the id is already gone).
        final p = evt.payload as Map<String, dynamic>;
        final id = p['id']?.toString();
        if (id != null && id.isNotEmpty) removeMessageById(id);
        break;
      }

      case 'task_state': {
        // aux classify verdict for this session: {goal, phase, classifyState}.
        // Empty goal ⇒ not classified ⇒ hide the bar. Mirrors web
        // renderAuxClassify.
        final p = evt.payload as Map<String, dynamic>;
        _classifyGoal = (p['goal'] ?? '').toString().trim();
        _classifyPhase = (p['phase'] ?? 'idle').toString().toLowerCase();
        _classifyState = (p['classifyState'] ?? '').toString().toUpperCase();
        notifyListeners();
        break;
      }

      case 'role_token_stats':
        // Server pushes per-role token accounting after each turn:
        // payload.role = { main: {…}, sub: {…}|null, subByProvider: […] }
        _lastRoleTokens = (evt.payload as Map<String, dynamic>)['role'] as Map<String, dynamic>?;
        notifyListeners();
        break;
    }
  }

  /// Apply the authoritative REST response immediately. The matching WS event
  /// still owns the user-facing handoff notice and is de-duplicated separately.
  void applyCliConfig(SessionCliConfig config) {
    _cli = config.cli;
    final model = config.effectiveModel ?? config.model;
    _statusText = model != null && model.isNotEmpty
        ? 'Connected · $model'
        : 'Connected · ${config.cli.name}';
    notifyListeners();
  }

  /// Remove a message from the local transcript by its server-side history id.
  /// Idempotent — used both by the initiating UI (immediate feedback) and the
  /// chat_msg_deleted WS broadcast (cross-client sync).
  void removeMessageById(String id) {
    final before = _messages.length;
    _messages.removeWhere((m) => m.id == id);
    if (_messages.length != before) notifyListeners();
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
      // A new assistant turn started. If the user is up reading history, count
      // it as one unread new message (drives the "↓ N new" pill). One bump per
      // turn since subsequent steps reuse this same bubble.
      bumpUnread();
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
    // Attach token usage + durationMs to the current assistant message BEFORE
    // finishing streaming (because _finishStreaming() sets _currentMsg to null)
    if (_currentMsg != null) {
      if (msg['usage'] != null) {
        _currentMsg!.usage = MessageUsage.fromJson(msg['usage'] as Map<String, dynamic>);
      }

      // Compute main-model tokens saved by offloading to sub-roles.
      // See the WS timing note above: role_token_stats may arrive before or
      // after result; _lastRoleTokens caches the latest value so we accept a
      // one-turn lag in the rare case that result arrives first.
      final roleTokens = _lastRoleTokens;
      if (roleTokens != null) {
        final sub = roleTokens['sub'];
        if (sub is Map) {
          int saved = 0;
          saved += (sub['inputTokens'] as num?)?.toInt() ?? 0;
          saved += (sub['outputTokens'] as num?)?.toInt() ?? 0;
          saved += (sub['cacheWrite'] as num?)?.toInt() ?? 0;
          saved += (sub['cacheRead'] as num?)?.toInt() ?? 0;
          if (saved > 0) {
            _currentMsg!.usage ??= MessageUsage();
            _currentMsg!.usage!.savedMainTokens = saved;
          }
        }
      }

      // Server-stamped wall-clock duration: user submit → AI reply complete.
      final dur = (msg['durationMs'] as num?)?.toInt();
      if (dur != null) _currentMsg!.durationMs = dur;
    }

    _finishStreaming();

    final cost = (msg['total_cost_usd'] as num?)?.toDouble();
    final ms = (msg['durationMs'] as num?)?.toInt();
    final turns = (msg['num_turns'] as num?)?.toInt();

    if (cost != null) {
      _costText = '\$${cost.toStringAsFixed(4)}';
      if (ms != null) _costText += ' · ${_fmtDuration(ms)}';
      if (turns != null) _costText += ' · $turns turn(s)';
    } else if (ms != null) {
      _costText = _fmtDuration(ms);
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

  /// id of the oldest message currently held in [_messages] (pagination cursor).
  String? _firstLoadedMsgId() {
    for (final m in _messages) {
      if (m.id != null && m.id!.isNotEmpty) return m.id;
    }
    return null;
  }

  // ── Lazy history: public state + scroll-back fetch ────────────────────────
  bool get historyHasMore => _historyHasMore;
  bool get historyLoading => _historyLoading;
  bool get historyExhausted => _historyExhausted;

  /// Number of NEW messages received while the user was scrolled up reading
  /// history (drives the "↓ N new" pill). Reset when the user jumps to bottom.
  int _unreadCount = 0;
  int get unreadCount => _unreadCount;
  bool _userPinnedAway = false;
  bool get userPinnedAway => _userPinnedAway;

  /// Called by the chat screen's scroll listener. [atBottom] is whether the
  /// viewport is currently parked at the latest message. Only notifies when the
  /// pinned/unread state actually changes (scroll fires every frame).
  void onUserScroll({required bool atBottom}) {
    if (atBottom) {
      if (_userPinnedAway || _unreadCount != 0) {
        _userPinnedAway = false;
        _unreadCount = 0;
        notifyListeners();
      }
    } else {
      if (!_userPinnedAway) {
        _userPinnedAway = true;
        notifyListeners();
      }
    }
  }

  /// Mark one new message as arrived while the user is pinned away (bumps the
  /// unread count so the pill shows "↓ N new"). Called from the streaming
  /// paths when a new assistant/user/system message lands.
  void bumpUnread() {
    if (!_userPinnedAway) return;
    _unreadCount++;
    notifyListeners();
  }

  /// Reset pinned/unread state and signal the screen to scroll to bottom.
  void jumpToBottom() {
    _userPinnedAway = false;
    _unreadCount = 0;
    notifyListeners();
  }

  /// Fetch the next older page of history and prepend it. Returns the count
  /// inserted (0 if nothing more to load or fetch failed). The screen is
  /// responsible for preserving scroll offset across the prepend.
  Future<int> loadOlderHistory({int limit = 30}) async {
    if (_historyLoading || _historyExhausted) return 0;
    final cursor = _oldestLoadedMsgId;
    if (cursor == null) return 0;
    _historyLoading = true;
    notifyListeners();
    try {
      final page = await _service.fetchHistoryPage(beforeId: cursor, limit: limit);
      if (page.messages.isEmpty) {
        _historyExhausted = true;
        _historyHasMore = false;
        return 0;
      }
      // Prepend in chronological order (server returns oldest-first within page).
      _messages.insertAll(0, page.messages);
      _oldestLoadedMsgId = page.messages.first.id ?? cursor;
      _historyHasMore = page.hasMore;
      _historyExhausted = !page.hasMore;
      return page.messages.length;
    } catch (e) {
      // Transient error: leave exhausted=false so the user can retry by scrolling.
      return 0;
    } finally {
      _historyLoading = false;
      notifyListeners();
    }
  }

  void _addSystemMsg(String text) {
    _messages.add(ChatMessage(role: MessageRole.system, content: text));
    notifyListeners();
  }

  /// Human-friendly duration: 820ms / 6.2s / 1m3s
  static String _fmtDuration(int ms) {
    if (ms < 1000) return '${ms}ms';
    final s = ms / 1000;
    if (s < 60) return '${s.toStringAsFixed(1)}s';
    final m = (s / 60).floor();
    return '${m}m${(s % 60).round()}s';
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
    // User just sent a message -> resume auto-follow at the bottom, clear any
    // unread pill (mirrors the web client's forceScrollToBottom on send).
    _userPinnedAway = false;
    _unreadCount = 0;
    notifyListeners();
  }

  /// Cancel the in-flight response. Matches the web client's cancelStreaming():
  /// sends the cancel signal (or queues it for reconnect) AND finalizes the
  /// streaming bubble locally + shows a "已取消" system message, so the user
  /// gets instant feedback instead of waiting for a server `result` that may
  /// never arrive if the socket died mid-stream.
  void cancel() {
    _service.cancel();
    _finishStreaming();
    _addSystemMsg('已取消');
    notifyListeners();
  }

  /// Clear chat history. Matches the web client's behaviour:
  ///   1. If a response is streaming, cancel the running CLI process FIRST
  ///      (server's `clear_history` only wipes the history array + resets the
  ///      CLI session id — it does NOT kill the in-flight `claudeProc`, so
  ///      without cancelling the ongoing stream would keep arriving and
  ///      repopulate the chat, making the clear look like a no-op).
  ///   2. When [keep] > 0, only the messages before the last [keep] are
  ///      discarded locally and on the server (keep-last-N mode).
  void clearHistory({int keep = 0}) {
    if (isStreaming) {
      cancel();
      _finishStreaming();
    }
    if (keep > 0 && _messages.length > keep) {
      _messages.removeRange(0, _messages.length - keep);
    } else {
      _messages.clear();
    }
    _currentMsg = null;
    _activeTools.clear();
    _historyApplied = false;
    _service.clearHistory(keep: keep);
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
