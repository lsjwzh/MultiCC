import 'dart:async';
import 'package:flutter/widgets.dart';

import '../i18n.dart';
import '../models/chat_runtime_state.dart';
import '../models/message.dart';
import '../services/chat_service.dart';
import '../services/notification_service.dart';
import '../services/session_service.dart';
import '../services/settings_service.dart';

bool _isRecoverableCodexReconnectErrorText(String text) {
  return RegExp(
        r'^Codex 出错：Reconnecting\.\.\.\s*\d+/\d+\s*\(',
      ).hasMatch(text) &&
      (text.contains('stream disconnected before completion') ||
          text.contains('response.completed'));
}

// ── Staged user sends: a sent message waiting for the server's FIFO verdict ─
//
// 对齐 web 的 stagedUserBubbles：sendMessage 不再立刻把用户气泡画进对话区，而是
// 先暂存，等服务端的 session_queue 事件裁决这条是「立即执行」还是「进 FIFO 队列」。
// 进队列的不在对话区占位（只在队列面板出现），等它真正开始执行（event=started）再
// 回填气泡；被取消（event=queued_cancelled）则丢弃。一个兜底定时器保证服务端迟迟
// 不回裁决（断连/丢事件）时消息也不会凭空消失。

/// 一条已发送、等待 FIFO 裁决的用户消息。
@visibleForTesting
class StagedUserSend {
  final String clientMsgId;
  final String text;

  /// 服务端 admit 后回填；started / queued_cancelled 用它精确匹配暂存条目。
  String? entryId;

  bool resolved = false;

  /// 兜底：服务端没在合理时间内裁决时，回退乐观显示，避免消息消失。
  Timer? fallbackTimer;

  StagedUserSend(this.clientMsgId, this.text);
}

/// [resolveStagedQueueEvent] 对一条暂存给出的动作。
enum StagedResolution { keep, commit, discard }

/// [resolveStagedQueueEvent] 的裁决结果：对哪条暂存做什么动作，以及是否给它绑定
/// 服务端 entryId。
@visibleForTesting
class StagedVerdict {
  final StagedUserSend? target;
  final StagedResolution resolution;
  final String? bindEntryId;

  const StagedVerdict(this.target, this.resolution, {this.bindEntryId});
  static const keep = StagedVerdict(null, StagedResolution.keep);
}

/// 纯裁决器：给定暂存列表与一个 session_queue 事件，决定要 commit / discard / keep
/// 哪条（及是否绑定 entryId）。无副作用，可单测。
///
/// 关联依赖「发送顺序 = admit 裁决顺序」：同会话的 scheduler 串行 admit，所以把每个
/// `event='queued'` 依次绑到最早一条未绑定的暂存是可靠的。
@visibleForTesting
StagedVerdict resolveStagedQueueEvent(
  List<StagedUserSend> staged,
  String event,
  Map<String, dynamic> payload,
) {
  StagedUserSend? firstUnbound() {
    for (final s in staged) {
      if (s.entryId == null && !s.resolved) return s;
    }
    return null;
  }

  StagedUserSend? byEntryId(String id) {
    for (final s in staged) {
      if (s.entryId == id && !s.resolved) return s;
    }
    return null;
  }

  final rawEntry = payload['entryId']?.toString();
  final entryId = (rawEntry != null && rawEntry.isNotEmpty) ? rawEntry : null;

  switch (event) {
    case 'queued':
      // admit 裁决按发送顺序到达：绑到最早一条还没绑 entryId 的暂存。
      final target = firstUnbound();
      // queued:false = 立即执行 → 显示气泡；queued:true = 进队列 → 暂存等 started。
      final resolution = payload['queued'] == false
          ? StagedResolution.commit
          : StagedResolution.keep;
      return StagedVerdict(target, resolution, bindEntryId: entryId);
    case 'started':
    case 'claimed':
      // 这条队列消息开始执行：回填它的用户气泡。
      final target = entryId == null ? null : byEntryId(entryId);
      return StagedVerdict(
        target,
        target == null ? StagedResolution.keep : StagedResolution.commit,
      );
    case 'queued_cancelled':
      // 用户在队列面板取消了这条：丢弃暂存，不显示气泡。
      final target = entryId == null ? null : byEntryId(entryId);
      return StagedVerdict(
        target,
        target == null ? StagedResolution.keep : StagedResolution.discard,
      );
    default:
      return StagedVerdict.keep;
  }
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

  SessionQueueState _sessionQueue = const SessionQueueState();
  SessionQueueState get sessionQueue => _sessionQueue;
  List<SessionQueueItem> get sessionQueueItems => _sessionQueue.items;
  String? get sessionQueueFreezeReason => _sessionQueue.freezeReason;

  PendingUserInput? _pendingUserInput;
  PendingUserInput? get pendingUserInput => _pendingUserInput;

  ApiErrorPolicyState? _apiErrorPolicy;
  ApiErrorPolicyState? get apiErrorPolicy => _apiErrorPolicy;

  UsageWindowLimit? _usageWindowLimit;
  UsageWindowLimit? get usageWindowLimit {
    final value = _usageWindowLimit;
    if (value == null ||
        !value.isActiveAt(DateTime.now()) ||
        !value.matchesCli(_cli.name)) {
      return null;
    }
    return value;
  }

  UsageBalance? _usageBalance;
  UsageBalance? get usageBalance => _usageBalance;
  Timer? _usageExpiryTimer;

  String _costText = '';
  String get costText => _costText;

  ChatMessage? _currentMsg;
  final Map<int, ToolCall> _activeTools = {};
  int _reconnectAttempt = 0;

  /// 已发送、等服务端 FIFO 裁决的用户消息。空 = 没有占位暂存（对齐 web
  /// stagedUserBubbles：进队列的不在对话区占位）。
  final List<StagedUserSend> _stagedUserSends = [];
  static const Duration _stagedFallbackTimeout = Duration(seconds: 4);
  bool _historyApplied = false;

  // Lazy history pagination state. The initial WS chat_history push carries
  // only the newest page; older messages are fetched on scroll-up via
  // ChatService.fetchHistoryPage (GET /history?before=<id>&limit=<n>).
  bool _historyHasMore = false;
  bool _historyLoading = false;
  bool _historyExhausted = false;
  String? _oldestLoadedMsgId;

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

  /// Live classify-state letter (D/W/B/E/P) - drives the bar's tint.
  /// Legacy C is normalized to W because the server retired the ambiguous
  /// continue state and now requires explicit user/scheduler progression.
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
  }) : displayName = displayName ?? sessionName,
       dirName = dirName ?? '' {
    _cwd = sessionCwd;
    _cli = initialCli;
    _restoreRuntimeCache();
    _initService();
  }

  void _restoreRuntimeCache() {
    final cached = settings.readChatRuntimeCache(sessionName);
    if (cached == null) return;
    final limit = cached['limit'];
    if (limit is Map) {
      final parsed = UsageWindowLimit.fromCache(
        Map<String, dynamic>.from(limit),
      );
      if (parsed?.isActiveAt(DateTime.now()) == true) {
        _usageWindowLimit = parsed;
        _armUsageExpiry();
      }
    }
    final balance = cached['balance'];
    if (balance is Map) {
      _usageBalance = UsageBalance.fromJson(Map<String, dynamic>.from(balance));
    }
  }

  void _persistRuntimeCache() {
    unawaited(
      settings.saveChatRuntimeCache(sessionName, {
        if (_usageWindowLimit != null) 'limit': _usageWindowLimit!.toJson(),
        if (_usageBalance != null) 'balance': _usageBalance!.toJson(),
      }),
    );
  }

  void _armUsageExpiry() {
    _usageExpiryTimer?.cancel();
    final reset = _usageWindowLimit?.resetsAtMs;
    if (reset == null) return;
    final delayMs = reset - DateTime.now().millisecondsSinceEpoch + 50;
    if (delayMs <= 0) {
      _usageWindowLimit = null;
      _persistRuntimeCache();
      return;
    }
    _usageExpiryTimer = Timer(
      Duration(milliseconds: delayMs.clamp(1, 2147000000).toInt()),
      () {
        _usageWindowLimit = null;
        _persistRuntimeCache();
        notifyListeners();
      },
    );
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
          _cli = parseCli(msg['cli']?.toString());
        }

        final model = msg['model']?.toString();
        _statusText = model != null
            ? t('connectedModel', {'model': model})
            : t('connectedCli', {'cli': _cli.name});

        final serverStreaming = msg['is_streaming'] == true;
        if (serverStreaming && _currentMsg == null) {
          _ensureAssistantMsg();
        } else if (!serverStreaming && _currentMsg != null) {
          _finishStreaming();
          _addSystemMsg(t('responseCompletedDisconnected'));
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
            ? t('connectedModel', {'model': model})
            : t('connectedCli', {'cli': next.name});
        final handoffId = msg['handoffId']?.toString();
        if (handoffId == null || handoffId != _lastCliSwitchHandoffId) {
          _lastCliSwitchHandoffId = handoffId;
          final resumed = msg['reusedTarget'] == true
              ? t('cliSessionResumedSuffix')
              : '';
          _addSystemMsg(
            t('cliSwitched', {
              'from': from.displayName,
              'to': next.displayName,
              'resumed': resumed,
            }),
          );
        } else {
          notifyListeners();
        }
        onSessionConfigChanged?.call();
        break;

      case 'chat_history':
        final p = evt.payload as Map;
        final history = p['messages'] as List;
        final hasMore = p['hasMore'] == true;
        // Every socket receives one authoritative page. Process it even when
        // it races ahead of the async `connected` callback: first connect
        // appends into an empty view, every later page atomically reconciles.
        final replace = _historyApplied || _replaceHistoryOnReconnect;
        _historyApplied = true;
        _replaceHistoryOnReconnect = false;
        if (replace) {
          _replaceHistory(history);
        } else {
          _replayHistory(history);
        }
        // Seed lazy-pagination cursor + hasMore from this initial page.
        _historyHasMore = hasMore;
        _historyExhausted = !hasMore;
        _oldestLoadedMsgId = _firstLoadedMsgId();
        notifyListeners();
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

      case 'assistant':
        _onAssistantSnapshot(evt.payload as Map<String, dynamic>);
        break;

      case 'part_delta':
        _onPartDelta(evt.payload as Map<String, dynamic>);
        break;

      case 'content_block_stop':
        break;

      case 'message_delta':
        break;

      case 'result':
        _onResult(evt.payload as Map<String, dynamic>);
        break;

      case 'stream_end':
        _finishStreaming();
        notifyListeners();
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
            _statusText = notifyMsg.isNotEmpty
                ? notifyMsg
                : t('taskInProgress');
            notifyListeners();
          }
        } else {
          // Prefer the precise classifyState letter (D/W/B/E/P) when the
          // server provides it; fall back to the coarse notify state.
          final cls = (p['classifyState'] ?? '').toString().toUpperCase();
          String outcome;
          switch (cls) {
            case 'D':
              outcome = t('taskCompleted');
              break;
            case 'E':
              outcome = t('apiError');
              break;
            case 'C': // Legacy server: retired C is safest as wait-for-user.
            case 'W':
              outcome = t('waitingAction');
              break;
            case 'B':
              outcome = t('waitingBackground');
              break;
            default:
              outcome = notifyState == 'waiting'
                  ? t('waitingInteraction')
                  : notifyState == 'error'
                  ? t('errorOccurred')
                  : t('taskCompleted');
          }
          _maybeNotify(outcome, notifyMsg);
        }
        break;

      case 'error':
        final errorText = evt.payload.toString();
        if (_isRecoverableCodexReconnectErrorText(errorText)) break;
        _addSystemMsg('Error: $errorText');
        _finishStreaming();
        _maybeNotify(t('notificationErrorTitle'), errorText);
        notifyListeners();
        break;

      case 'chat_msg_meta':
        {
          // Server saved a message and assigned its history id. Tag the newest
          // still-un-id'd bubble of that role so its delete button goes live
          // (matches web: tag last bubble of role that has no msgId yet).
          final p = evt.payload as Map<String, dynamic>;
          final id = p['id']?.toString();
          final role = p['role']?.toString();
          if (id != null && id.isNotEmpty && role != null) {
            final wantUser = role == 'user';
            final clientMsgId = p['clientMsgId']?.toString();
            if (clientMsgId != null && clientMsgId.isNotEmpty) {
              ChatMessage? exact;
              for (final message in _messages) {
                if (message.clientMsgId == clientMsgId &&
                    message.role ==
                        (wantUser ? MessageRole.user : MessageRole.assistant)) {
                  exact = message;
                  break;
                }
              }
              if (exact != null) {
                exact.id = id;
                notifyListeners();
                break;
              }
            }
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

      case 'chat_msg_deleted':
        {
          // Broadcast after a successful delete from any client. Idempotent:
          // the initiator already removed it locally; this just syncs other
          // clients (and is a no-op if the id is already gone).
          final p = evt.payload as Map<String, dynamic>;
          final id = p['id']?.toString();
          if (id != null && id.isNotEmpty) removeMessageById(id);
          break;
        }

      case 'task_state':
        {
          // aux classify verdict for this session: {goal, phase, classifyState}.
          // Empty goal ⇒ not classified ⇒ hide the bar. Mirrors web
          // renderAuxClassify.
          final p = evt.payload as Map<String, dynamic>;
          _classifyGoal = (p['goal'] ?? '').toString().trim();
          _classifyPhase = (p['phase'] ?? 'idle').toString().toLowerCase();
          final next = (p['classifyState'] ?? '').toString().toUpperCase();
          _classifyState = next == 'C' ? 'W' : next;
          notifyListeners();
          break;
        }

      case 'user_input_required':
        {
          final p = evt.payload as Map<String, dynamic>;
          _pendingUserInput = PendingUserInput.fromJson(p);
          notifyListeners();
          break;
        }

      case 'session_queue':
        {
          final p = evt.payload as Map<String, dynamic>;
          final event = (p['event'] ?? '').toString();
          _sessionQueue = SessionQueueState.fromEvent(
            p,
            previous: _sessionQueue,
          );
          // 裁决暂存消息：立即执行则显示气泡，进队列则继续暂存，取消则丢弃。
          _reconcileStaged(event, p);
          if (event == 'queued') {
            final position = p['queuePosition'];
            _statusText = position == null ? '消息已持久排队' : '消息已排队（第 $position 位）';
          } else if (event == 'frozen') {
            _statusText = '队列已冻结：${(p['freezeReason'] ?? '当前任务尚未成功完成')}';
          } else if (event == 'started') {
            _statusText = '正在执行队首任务';
          }
          notifyListeners();
          break;
        }

      case 'api_error_policy':
        _apiErrorPolicy = ApiErrorPolicyState.fromJson(
          evt.payload as Map<String, dynamic>,
        );
        notifyListeners();
        break;

      case 'rate_limit_event':
        {
          final parsed = UsageWindowLimit.fromEvent(
            evt.payload as Map<String, dynamic>,
          );
          if (parsed == null) break;
          _usageWindowLimit = parsed;
          _armUsageExpiry();
          _persistRuntimeCache();
          notifyListeners();
          break;
        }

      case 'usage_balance_event':
        {
          final parsed = UsageBalance.fromJson(
            evt.payload as Map<String, dynamic>,
          );
          if (parsed == null) break;
          _usageBalance = parsed;
          _persistRuntimeCache();
          notifyListeners();
          break;
        }

      case 'role_token_stats':
        // Server pushes per-role token accounting after each turn:
        // payload.role = { main: {…}, sub: {…}|null, subByProvider: […] }
        _lastRoleTokens =
            (evt.payload as Map<String, dynamic>)['role']
                as Map<String, dynamic>?;
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

  void _onAssistantSnapshot(Map<String, dynamic> message) {
    final blocks = message['content'];
    if (blocks is! List) return;
    var changed = false;
    for (final raw in blocks) {
      if (raw is! Map || raw['type'] != 'text') continue;
      final text = raw['text']?.toString() ?? '';
      if (text.isEmpty) continue;
      _ensureAssistantMsg();
      if (message['textSnapshot'] == true) {
        _currentMsg!.content = text;
      } else if (_cli == SessionCli.codex) {
        _currentMsg!.content += text;
      } else if (_currentMsg!.content.isEmpty) {
        _currentMsg!.content = text;
      }
      changed = true;
    }
    if (changed) notifyListeners();
  }

  void _onPartDelta(Map<String, dynamic> message) {
    if (_cli == SessionCli.claude) return;
    final delta = message['delta'];
    if (delta is! Map || delta['type'] != 'text') return;
    final text = delta['text']?.toString() ?? '';
    if (text.isEmpty) return;
    _ensureAssistantMsg();
    _currentMsg!.content += text;
    notifyListeners();
  }

  void _onResult(Map<String, dynamic> msg) {
    // Attach token usage + durationMs to the current assistant message BEFORE
    // finishing streaming (because _finishStreaming() sets _currentMsg to null)
    if (_currentMsg != null) {
      if (msg['usage'] != null) {
        _currentMsg!.usage = MessageUsage.fromJson(
          msg['usage'] as Map<String, dynamic>,
        );
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
    if (msg['is_error'] != true) _apiErrorPolicy = null;

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
    final liveTail = streamingAssistantTail(parsed);
    // system_init may have created an empty local streaming bubble before the
    // ordered chat_history frame arrives. Replace that placeholder with the
    // authoritative cumulative tail instead of keeping both bubbles alive.
    if (liveTail != null && _currentMsg != null) {
      _messages.remove(_currentMsg);
      _currentMsg = null;
    }
    final insertIdx = _currentMsg != null
        ? _messages.length - 1
        : _messages.length;
    _messages.insertAll(insertIdx, parsed);
    if (liveTail != null) {
      _currentMsg = liveTail;
      _activeTools.clear();
    }
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
    _currentMsg = streamingAssistantTail(parsed);
    _activeTools.clear();
    // 历史已是权威：未裁决的暂存失去意义（已落盘的在历史里，未落盘的队列消息靠
    // 队列面板展示），取消它们的兜底定时器。
    _clearStaged();
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

  /// True once the initial `chat_history` page has been applied (or a focus
  /// load has replaced the transcript). The chat screen waits on this before
  /// resolving a deep-link focus so it knows the message list is populated.
  bool get historyApplied => _historyApplied;

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
      final page = await _service.fetchHistoryPage(
        beforeId: cursor,
        limit: limit,
      );
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

  /// Deep-link focus: fetch the history window centered on [messageId] and
  /// replace the visible transcript with it. Returns true when the target
  /// message was found and is now in the transcript; false if the server
  /// reports it not found (e.g. trimmed) or the fetch failed - in which case
  /// the existing transcript is left untouched. Resets the lazy-pagination
  /// cursor so scroll-up can still fetch older pages adjacent to the window.
  Future<bool> loadHistoryAround(String messageId) async {
    try {
      final page = await SessionService(
        settings: settings,
      ).fetchHistoryAround(sessionName, messageId);
      if (!page.found) return false;
      final parsed = page.messages
          .map((m) {
            try {
              return ChatMessage.fromHistory(m);
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
      _oldestLoadedMsgId = _firstLoadedMsgId();
      _historyHasMore = page.hasMore;
      _historyExhausted = !page.hasMore;
      _historyApplied = true;
      notifyListeners();
      return parsed.any((m) => m.id == messageId);
    } catch (_) {
      return false;
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

  void sendMessage(
    String text, {
    bool goal = false,
    Map<String, dynamic>? goalLimits,
  }) {
    final message = text.trim();
    if (message.isEmpty) return;
    final clientMsgId = _service.send(
      message,
      goal: goal,
      goalLimits: goalLimits,
    );
    if (clientMsgId == null) {
      // Half-open / dead socket — don't pretend the message was sent.
      _addSystemMsg(t('connectionLostRetry'));
      notifyListeners();
      return;
    }
    // 不立刻把气泡画进对话区：先暂存，等服务端 session_queue 裁决这条是立即执行
    // 还是进 FIFO。进队列的只在队列面板出现，不在这里占位（对齐 web
    // stagedUserBubbles）。_commitStaged 在收到裁决（或兜底超时）时才真正加气泡。
    _stageUserSend(clientMsgId, message);
    _pendingUserInput = null;
    _apiErrorPolicy = null;
    // User just sent a message -> resume auto-follow at the bottom, clear any
    // unread pill (mirrors the web client's forceScrollToBottom on send).
    _userPinnedAway = false;
    _unreadCount = 0;
    notifyListeners();
  }

  // ── Staged user sends: 等服务端 FIFO 裁决的暂存消息 ──────────────────────────

  void _stageUserSend(String clientMsgId, String text) {
    final staged = StagedUserSend(clientMsgId, text);
    _stagedUserSends.add(staged);
    // 兜底：服务端没在合理时间内裁决（断连 / 丢事件）→ 回退乐观显示，绝不让用户
    // 消息凭空消失。正常路径下 session_queue 事件会先到并取消这个定时器。
    staged.fallbackTimer = Timer(_stagedFallbackTimeout, () {
      if (!staged.resolved) _commitStaged(staged);
    });
  }

  /// 把一条暂存消息落成对话区里的用户气泡。
  void _commitStaged(StagedUserSend staged) {
    if (staged.resolved) return;
    staged.resolved = true;
    staged.fallbackTimer?.cancel();
    _stagedUserSends.remove(staged);
    _messages.add(
      ChatMessage(
        role: MessageRole.user,
        content: staged.text,
        clientMsgId: staged.clientMsgId,
      ),
    );
    notifyListeners();
  }

  /// 用户在队列面板取消了这条暂存消息：丢弃，不显示气泡。
  void _discardStaged(StagedUserSend staged) {
    if (staged.resolved) return;
    staged.resolved = true;
    staged.fallbackTimer?.cancel();
    _stagedUserSends.remove(staged);
  }

  /// 放弃所有未裁决的暂存（重连用权威历史重建、清空对话、dispose 时调用）。
  void _clearStaged() {
    for (final s in _stagedUserSends) {
      s.fallbackTimer?.cancel();
      s.resolved = true;
    }
    _stagedUserSends.clear();
  }

  /// 用一个 session_queue 事件裁决暂存消息：绑 entryId、按需 commit / discard。
  void _reconcileStaged(String event, Map<String, dynamic> payload) {
    final verdict = resolveStagedQueueEvent(_stagedUserSends, event, payload);
    if (verdict.target != null && verdict.bindEntryId != null) {
      verdict.target!.entryId = verdict.bindEntryId;
    }
    if (verdict.target == null) return;
    switch (verdict.resolution) {
      case StagedResolution.commit:
        _commitStaged(verdict.target!);
      case StagedResolution.discard:
        _discardStaged(verdict.target!);
      case StagedResolution.keep:
        break;
    }
  }

  /// Explicit scheduler control. The APP never mutates or advances the queue
  /// itself; even after a successful POST it only applies the returned server
  /// schedule (and the following WS event will reconcile it again).
  Future<void> queueAction(String action, {String? entryId}) async {
    final result = await _service.queueAction(action, entryId: entryId);
    final schedule = result['schedule'];
    if (schedule is Map) {
      final snapshot = Map<String, dynamic>.from(schedule);
      snapshot['event'] = 'action';
      snapshot['items'] = snapshot['queued'];
      _sessionQueue = SessionQueueState.fromEvent(
        snapshot,
        previous: _sessionQueue,
      );
      notifyListeners();
    }
  }

  /// Cancel the in-flight response. Matches the web client's cancelStreaming():
  /// sends the cancel signal (or queues it for reconnect) AND finalizes the
  /// streaming bubble locally + shows a "已取消" system message, so the user
  /// gets instant feedback instead of waiting for a server `result` that may
  /// never arrive if the socket died mid-stream.
  void cancel() {
    _service.cancel();
    _finishStreaming();
    _addSystemMsg(t('cancelled'));
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
  /// Request native CLI context rotation via service.
  void rotateNativeContext() {
    _service.rotateNativeContext();
  }

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
    _clearStaged();
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
      _clearStaged();
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
    _usageExpiryTimer?.cancel();
    _clearStaged();
    _eventSub?.cancel();
    _service.dispose();
    super.dispose();
  }
}
