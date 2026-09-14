part of 'chat_provider.dart';

// ── 服务端历史 → 消息列表 ───────────────────────────────────────────────────
//
// 这一层只回答一件事：服务端给的一页历史，怎么变成屏幕上的消息列表 —— 装进去
// （回放 / 替换 / 合并任务壳的分页）、往回翻页（懒加载）、跳到某一条（深链窗口）、
// 翻页过程中的未读与钉底，以及按身份找到那条气泡（归属事件后到时用）。
//
// 为什么是「同库 + 宿主类型上的扩展」：这一层动的是 ChatProvider 的私有状态
// （_messages、翻页游标、暂存裁决器…）。Dart 的私有性是**库级**的，只有同库才
// 碰得到；独立库拿不到，而 `mixin on ChatProvider` 是循环继承（宿主不能 mixin 一个
// 要求宿主做超类的 mixin）。扩展不能声明实例字段，所以状态字段仍留在
// chat_provider.dart 的类体里，只有行为搬到了这儿。扩展必须**公开命名**：私有扩展
// 的成员在别的库里不可见，而聊天页要读 historyHasMore / historyApplied。

extension ChatHistoryLayer on ChatProvider {
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
    if (liveTail != null && _folder.currentMsg != null) {
      _messages.remove(_folder.currentMsg);
      _folder.currentMsg = null;
    }
    final insertIdx = _folder.currentMsg != null
        ? _messages.length - 1
        : _messages.length;
    _messages.insertAll(insertIdx, parsed);
    if (liveTail != null) {
      _folder.currentMsg = liveTail;
      _folder.activeTools.clear();
    }
    _seedUsageFromHistory();
    _notifyHistoryChanged();
  }

  void _mergeShellPage(List history, {String? sourceSessionId}) {
    final parsed = history.map((m) => ChatMessage.fromHistory(
        Map<String, dynamic>.from(m as Map))).toList();
    final merged = mergeShellHistory(_messages, parsed, sourceSessionId: sourceSessionId);
    _messages..clear()..addAll(merged);
    final current = _folder.currentMsg;
    final tail = sourceSessionId != null && _messages.contains(current)
        ? current : streamingAssistantTail(_messages);
    if (!identical(_folder.currentMsg, tail)) _folder.activeTools.clear();
    _folder.currentMsg = tail;
    _seedUsageFromHistory();
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
    _folder.currentMsg = streamingAssistantTail(parsed);
    _folder.activeTools.clear();
    _seedUsageFromHistory();
    // 历史已是权威：未裁决的暂存失去意义（已落盘的在历史里，未落盘的队列消息靠
    // 队列面板展示），取消它们的兜底定时器。
    _stagedTracker.clear();
    _notifyHistoryChanged();
  }

  /// Re-derive the usage bar from the transcript we now hold.
  ///
  /// History records each turn's totals but no per-request block, so the exact
  /// context reading cannot survive a reload — it is dropped rather than shown
  /// against a turn it did not measure. A live streaming tail is the exception:
  /// its `message_start` describes the turn still on screen.
  void _seedUsageFromHistory() {
    if (_folder.currentMsg == null) _requestUsage = null;
    var input = 0;
    var output = 0;
    for (final m in _messages) {
      if (m.role != MessageRole.assistant || m.usage == null) continue;
      input += m.usage!.inputTokens;
      output += m.usage!.outputTokens;
    }
    _sessionInputTokens = input;
    _sessionOutputTokens = output;
    _turnUsage = null;
    _contextTrace = null;
    _turnDurationText = '';
    _turnCount = 0;
    for (var i = _messages.length - 1; i >= 0; i -= 1) {
      final m = _messages[i];
      if (m.role != MessageRole.assistant) continue;
      _turnUsage = m.usage;
      _contextTrace = m.contextTrace;
      // Round count is a result-frame fact and is not persisted; the timing is.
      if (m.durationMs != null) _turnDurationText = ChatProvider._fmtDuration(m.durationMs!);
      break;
    }
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

  /// Called by the chat screen's scroll listener. [atBottom] is whether the
  /// viewport is currently parked at the latest message. Only notifies when the
  /// pinned/unread state actually changes (scroll fires every frame).
  void onUserScroll({required bool atBottom}) {
    if (atBottom) {
      if (_userPinnedAway || _unreadCount != 0) {
        _userPinnedAway = false;
        _unreadCount = 0;
        _notifyHistoryChanged();
      }
    } else {
      if (!_userPinnedAway) {
        _userPinnedAway = true;
        _notifyHistoryChanged();
      }
    }
  }

  /// Mark one new message as arrived while the user is pinned away (bumps the
  /// unread count so the pill shows "↓ N new"). Called from the streaming
  /// paths when a new assistant/user/system message lands.
  void bumpUnread() {
    if (!_userPinnedAway) return;
    _unreadCount++;
    _notifyHistoryChanged();
  }

  /// Reset pinned/unread state and signal the screen to scroll to bottom.
  void jumpToBottom() {
    _userPinnedAway = false;
    _unreadCount = 0;
    _notifyHistoryChanged();
  }

  /// Fetch the next older page of history and prepend it. Returns the count
  /// inserted (0 if nothing more to load or fetch failed). The screen is
  /// responsible for preserving scroll offset across the prepend.
  Future<int> loadOlderHistory({int limit = 30}) async {
    if (_historyLoading || _historyExhausted) return 0;
    final cursor = _oldestLoadedMsgId;
    if (cursor == null) return 0;
    _historyLoading = true;
    final generation = _historyGeneration;
    _notifyHistoryChanged();
    try {
      final page = await _service.fetchHistoryPage(
        beforeId: cursor,
        limit: limit,
      );
      if (generation != _historyGeneration) return 0;
      if (page.messages.isEmpty) {
        _historyExhausted = true;
        _historyHasMore = false;
        return 0;
      }
      // Prepend in chronological order (server returns oldest-first within page).
      final loaded = _messages.map((m) => m.id).whereType<String>().toSet();
      final fresh = page.messages.where((m) => m.id == null || !loaded.contains(m.id)).toList();
      _messages.insertAll(0, fresh);
      _oldestLoadedMsgId = page.messages.first.id ?? cursor;
      _historyHasMore = page.hasMore;
      _historyExhausted = !page.hasMore;
      return fresh.length;
    } catch (e) {
      // Transient error: leave exhausted=false so the user can retry by scrolling.
      // Web 的 `dbg('history', 'loadOlderHistory failed: …')` —— 这里返回 0 是
      // 静默的（屏幕上什么都不发生），不记一笔就没法解释「往上翻没反应」。
      dbg('history', 'loadOlderHistory failed: $e');
      return 0;
    } finally {
      _historyLoading = false;
      _notifyHistoryChanged();
    }
  }

  /// Deep-link focus: fetch the history window centered on [messageId] and
  /// replace the visible transcript with it. Returns true when the target
  /// message was found and is now in the transcript; false if the server
  /// reports it not found (e.g. trimmed) or the fetch failed - in which case
  /// the existing transcript is left untouched. Resets the lazy-pagination
  /// cursor so scroll-up can still fetch older pages adjacent to the window.
  Future<bool> loadHistoryAround(String messageId) async {
    final generation = _historyGeneration;
    try {
      final page = await _service.fetchHistoryPage(beforeId: null, aroundId: messageId, limit: 31);
      if (generation != _historyGeneration) return false;
      final parsed = page.messages;
      if (!parsed.any((m) => m.id == messageId ||
          shellMessageOwner(sessionName, m.id ?? '').messageId == messageId)) {
        return false;
      }
      _messages
        ..clear()
        ..addAll(parsed);
      _folder.resetTail();
      _oldestLoadedMsgId = _firstLoadedMsgId();
      _historyHasMore = page.hasMore;
      _historyExhausted = !page.hasMore;
      _historyApplied = true;
      _notifyHistoryChanged();
      return true;
    } catch (_) {
      return false;
    }
  }

  /// 按本地 id 找气泡。
  ///
  /// 两边本就该相等：`annotateTurn` 按**执行会话自己的**消息 id 指认，而壳在
  /// `chat_shell_view.dart` 里已经把同一批记录复合成了本地 id
  /// （`<sourceSessionId>:<messageId>`，与气泡的 id 同一套规则）。
  ///
  /// 认不出来就什么都不做 —— 不要退回去按裸 id 猜。裸 id 只在它自己那个执行
  /// 会话的编号空间里有意义，拿它去跨会话找气泡只会把 A 任务的归属写到 B 任务的
  /// 消息头上（消息 id 是 `m<base36 时间>-<全局序号>`，见 server.js 的
  /// newChatMsgId，跨会话撞号在生产里不会发生，所以那条兜底只会误伤）。
  /// 漏一次也不是永久的：服务端的历史投影里本来就带 taskId/taskName/turnId，
  /// 下一次读历史页就会补上。
  ChatMessage? _messageByIdentity(String id) {
    if (id.isEmpty) return null;
    for (final message in _messages) {
      if (message.id == id) return message;
    }
    return null;
  }
}
