import 'dart:async';
import 'package:flutter/widgets.dart';

import '../i18n.dart';
import '../models/background_task_board.dart';
import '../models/chat_runtime_state.dart';
import '../models/dispatch_queue.dart';
import '../models/message.dart';
import '../models/role_tokens.dart';
import '../models/usage_readout.dart';
import '../models/vendor_quota.dart';
import '../services/chat_debug_log.dart';
import '../services/chat_service.dart';
import '../services/chat_shell_view.dart';
import '../services/shell_history_merge.dart';
import '../services/notification_service.dart';
import '../services/quota_service.dart';
import '../services/session_service.dart';
import '../services/settings_service.dart';
import '../services/transcript_live_folder.dart';
import '../utils/session_status_helpers.dart';
import 'admission_notes.dart';

// Re-exported so existing tests keep importing the sidecar helpers from the
// provider (their pre-extraction home); the implementation now lives with the
// shared folder.
export '../services/transcript_live_folder.dart'
    show toolCallById, applyReasoningDelta, applyToolArgsDelta;
export 'admission_notes.dart';

part 'chat_provider_history.dart';

bool _isRecoverableCodexReconnectErrorText(String text) {
  // 与 public/chat-event-controller.js 的同名判定逐字对齐：前缀是车道展示名，2026-09-24
  // 改名后一次性车道写 "Codex Exec 出错："（原来 "Codex"），三种拼法都收，否则一次
  // 瞬时重连会被当成真错误画进对话。
  return RegExp(
        r'^(?:Codex|Codex Exp|Codex Exec) 出错：Reconnecting\.\.\.\s*\d+/\d+\s*\(',
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
// 不回裁决（断连/丢事件）时消息也不会凭空消失 —— 但它只在「从未收到任何权威裁决」
// 时生效：queued:true 一旦到达，这条已确定进了 durable FIFO，兜底被取消并封死，
// 永远不会把它画进对话区。

/// 一条已发送、等待 FIFO 裁决的用户消息。
@visibleForTesting
class StagedUserSend {
  final String clientMsgId;
  final String text;

  /// 服务端 admit 后回填；started / queued_cancelled 用它精确匹配暂存条目。
  String? entryId;

  bool resolved = false;

  /// 服务端已权威裁决「进 durable FIFO」（event=queued 且 queued!=false）。
  /// 置位后兜底定时器被取消且永久失效 —— 队列消息只属于队列面板。
  bool queuedVerdict = false;

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

  StagedUserSend? byClientMsgId(String id) {
    for (final s in staged) {
      if (s.clientMsgId == id && !s.resolved) return s;
    }
    return null;
  }

  final rawEntry = payload['entryId']?.toString();
  final entryId = (rawEntry != null && rawEntry.isNotEmpty) ? rawEntry : null;
  final rawClient = payload['clientMsgId']?.toString();
  final clientMsgId = (rawClient != null && rawClient.isNotEmpty)
      ? rawClient
      : null;

  switch (event) {
    case 'queued':
      // 重放幂等：这个 entryId 已绑过一条暂存（同一事件重复到达 / WS 重放），
      // 不再绑到下一条未绑定的暂存上，避免串条。
      if (entryId != null && byEntryId(entryId) != null) {
        return StagedVerdict.keep;
      }
      // New servers carry clientMsgId, which remains exact even when an earlier
      // pre-FIFO progress event already committed another bubble. Legacy frames
      // retain the original serial-admission fallback.
      final target = clientMsgId == null
          ? firstUnbound()
          : byClientMsgId(clientMsgId);
      if (target?.entryId != null && target?.entryId != entryId) {
        return StagedVerdict.keep;
      }
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

/// 用户气泡的插入位：永远在「正在流式输出的助手气泡」之前，而不是列表末尾。
///
/// 暂存的 commit 时机（FIFO 裁决、4s 断连兜底、admission 进度回填）都可能
/// 晚于 message_start——那时 ensureAssistantMsg 已把正在回答这条消息的助手
/// 气泡 append 到了列表尾。盲目 add 会把用户消息画到它的回答下面（前端
/// 「助手消息在用户消息上面」的根因）。无流式尾巴或尾巴不在列表里（防御）
/// 时照常 append。
@visibleForTesting
int userBubbleInsertIndex(
  List<ChatMessage> messages,
  ChatMessage? streamingTail,
) {
  if (streamingTail != null) {
    final idx = messages.lastIndexOf(streamingTail);
    if (idx >= 0) return idx;
  }
  return messages.length;
}

/// 纯裁决器：queue-action 的 HTTP 响应 schedule 能否覆盖当前（WS 驱动的）队列
/// 状态。规则是本地因果序而非时间戳——服务器先广播 WS 事件、后写 HTTP 响应，
/// 所以「请求期间有 session_queue 事件到达」⇒ 该事件至少与响应同源同新，响应
/// 里的旧 schedule（例如 insert_queued 的 pre-tick 快照仍把已认领条目列为
/// queued）绝不能再覆盖它；返回 null 表示跳过，交给 WS 流对账。无事件交错
/// （典型：WS 断开）时才应用响应 schedule 作为兜底，条目同样立即消失。
///
/// [wsSeqAtRequest] = 发起 POST 前的事件计数；[wsSeqNow] = 应用响应时的计数。
@visibleForTesting
SessionQueueState? applyActionSchedule(
  SessionQueueState current,
  Map<String, dynamic> schedule,
  int wsSeqAtRequest,
  int wsSeqNow,
) {
  if (wsSeqNow != wsSeqAtRequest) return null;
  final snapshot = Map<String, dynamic>.from(schedule);
  snapshot['event'] = 'action';
  snapshot['items'] = snapshot['queued'];
  return SessionQueueState.fromEvent(snapshot, previous: current);
}

/// Staged send 生命周期持有者：暂存、断连兜底定时器与权威 FIFO 裁决
/// （[resolveStagedQueueEvent]）收在一处，让时序语义可以脱离真实 socket 单测。
///
/// 契约（与 web stagedUserBubbles 一致）：
///   • queued:false   → 立即 commit（画气泡）；
///   • queued:true    → 绑 entryId、取消并封死兜底；保持隐藏，只在队列面板出现；
///   • started/claimed 同 entryId → 此时且仅此时 commit 一次；
///   • queued_cancelled → discard，永不出现；
///   • 一直没有任何裁决 → 兜底定时器到点乐观 commit（断连时不让消息凭空消失）。
@visibleForTesting
class StagedSendTracker {
  StagedSendTracker({
    required this.onCommit,
    Duration fallbackTimeout = const Duration(seconds: 4),
  }) : _fallbackTimeout = fallbackTimeout;

  /// 把一条暂存画成对话区用户气泡 —— 每条被 commit 的暂存恰好回调一次；
  /// 进队列后被取消的永不回调。
  final void Function(StagedUserSend staged) onCommit;
  final Duration _fallbackTimeout;
  final List<StagedUserSend> _staged = [];

  /// 还没走完生命周期的暂存（只读视图，供断言）。
  List<StagedUserSend> get pending => List.unmodifiable(_staged);

  void stage(String clientMsgId, String text) {
    final staged = StagedUserSend(clientMsgId, text);
    _staged.add(staged);
    // 兜底只在「从未收到任何权威 FIFO 裁决」时生效：queuedVerdict 一旦置位
    // （且定时器已被取消）就绝不能再 commit。
    staged.fallbackTimer = Timer(_fallbackTimeout, () {
      if (!staged.resolved && !staged.queuedVerdict) commit(staged);
    });
  }

  /// 用一个 session_queue 事件裁决暂存消息：绑 entryId、按需 commit / discard。
  void reconcile(String event, Map<String, dynamic> payload) {
    final verdict = resolveStagedQueueEvent(_staged, event, payload);
    if (verdict.target != null && verdict.bindEntryId != null) {
      verdict.target!.entryId = verdict.bindEntryId;
    }
    if (verdict.target == null) return;
    switch (verdict.resolution) {
      case StagedResolution.commit:
        commit(verdict.target!);
      case StagedResolution.discard:
        discard(verdict.target!);
      case StagedResolution.keep:
        // keep + 有目标 = queued:true 的权威裁决：这条确实进了 durable FIFO。
        // 取消并封死兜底定时器 —— 气泡保持隐藏，等 started 才回填。
        final s = verdict.target!;
        s.queuedVerdict = true;
        s.fallbackTimer?.cancel();
        s.fallbackTimer = null;
    }
  }

  /// 把一条暂存落成对话区里的用户气泡（幂等）。
  void commit(StagedUserSend staged) {
    if (staged.resolved) return;
    staged.resolved = true;
    staged.fallbackTimer?.cancel();
    staged.fallbackTimer = null;
    _staged.remove(staged);
    onCommit(staged);
  }

  /// Commits the exact client-correlated send when a pre-FIFO admission event
  /// confirms the server received it. Returns false for another window or a
  /// replay whose bubble was already committed.
  bool commitByClientMsgId(String clientMsgId) {
    for (final staged in List<StagedUserSend>.of(_staged)) {
      if (staged.clientMsgId != clientMsgId) continue;
      commit(staged);
      return true;
    }
    return false;
  }

  /// 用户在队列面板取消了这条暂存消息：丢弃，不显示气泡（幂等）。
  void discard(StagedUserSend staged) {
    if (staged.resolved) return;
    staged.resolved = true;
    staged.fallbackTimer?.cancel();
    staged.fallbackTimer = null;
    _staged.remove(staged);
  }

  /// 放弃所有未裁决的暂存（重连用权威历史重建、清空对话、dispose 时调用）。
  void clear() {
    for (final s in _staged) {
      s.fallbackTimer?.cancel();
      s.fallbackTimer = null;
      s.resolved = true;
    }
    _staged.clear();
  }
}

class ChatProvider extends ChangeNotifier {
  final String? taskBoundTaskId;
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

  /// Shared live-fold core (chat-view unification I8): the session event
  /// cases below delegate here; the task detail sheet drives its own
  /// instance from task_run_stream envelopes. cli/sessionId are read through
  /// getters so system_init / cli_switched need no sync point.
  late final TranscriptLiveFolder _folder = TranscriptLiveFolder(
    messages: _messages,
    cliOf: () => _cli,
    sessionIdOf: () => _sessionId ?? '',
    onChanged: notifyListeners,
    onTurnStart: bumpUnread,
  );

  ChatConnectionState _connectionState = ChatConnectionState.disconnected;
  ChatConnectionState get connectionState => _connectionState;

  bool get isStreaming => _service.isStreaming;

  /// Web 的 `!!chatLiveUi.getThinkingElement()`：思考中的指示条此刻是否真的在
  /// 屏幕上。[ChatMessageList] 拿它决定要不要多渲染一行，调试面板拿它算
  /// `stuck` 徽章 —— 同一个判断，两处各写一份迟早会对不上。
  bool get thinkingIndicatorVisible {
    if (_admissionProgressText != null) return true;
    if (!isStreaming) return false;
    final msgs = messages;
    if (msgs.isEmpty) return true;
    final last = msgs.last;
    return last.role != MessageRole.assistant ||
        (last.content.isEmpty && last.toolCalls.isEmpty);
  }

  /// Web 的 `!!currentMsgEl`：本轮直播中的那条助手气泡是否已经挂出来了。
  bool get hasLiveAssistantBubble => _folder.currentMsg != null;

  /// Raw chat event stream (broadcast) — exposed so the voice call-mode
  /// service can monitor task progress (content_block_delta / result / notify)
  /// without going through the message-rendering layer. Safe to add listeners:
  /// ChatService uses a broadcast StreamController.
  Stream<ChatEvent> get chatEvents => _service.events;

  String? _sessionId;
  String get sessionId => _sessionId ?? '';

  /// Stable server record for operations; sessionId above is the native CLI resume ID.
  String get executionSessionName => _service.executionSessionName;

  /// 本会话所属的任务壳 id（连接握手后才拿得到）。产物边栏的 scope。
  String? get shellId => _service.shellId;

  String _cwd = '';
  String get cwd => _cwd;

  /// CLI driving this chat — learned from the server's `system init` event.
  SessionCli _cli = SessionCli.claude;
  SessionCli get cli => _cli;
  String? _lastCliSwitchHandoffId;

  String _statusText = 'Disconnected';
  String get statusText => _statusText;

  String? _admissionProgressText;
  final _autoRouteLine = AutoRouteLine();
  String? _admissionProgressClientMsgId;
  String? get admissionProgressText => _admissionProgressText;

  SessionQueueState _sessionQueue = const SessionQueueState();
  SessionQueueState get sessionQueue => _sessionQueue;
  List<SessionQueueItem> get sessionQueueItems => _sessionQueue.items;
  String? get sessionQueueFreezeReason => _sessionQueue.freezeReason;

  /// Monotonic count of applied `session_queue` WS events. queueAction() uses
  /// it for local causality: an HTTP action response whose schedule predates a
  /// WS event that already landed must not overwrite the newer WS state.
  int _sessionQueueEventSeq = 0;

  PendingUserInput? _pendingUserInput;
  PendingUserInput? get pendingUserInput => _pendingUserInput;
  // 收起状态纯属本地 UI：服务端仍视作「等待回答」，仅本窗口把卡片折成漂浮球。
  bool _pendingUserInputCollapsed = false;
  bool get pendingUserInputCollapsed => _pendingUserInputCollapsed;

  /// 设置/清空 pending 提示的唯一入口：任何一处赋值都同步重置 collapsed，
  /// 保证新提示默认展开、提示消失时漂浮球一并隐藏。
  void _setPendingUserInput(PendingUserInput? value) {
    _pendingUserInput = value;
    _pendingUserInputCollapsed = false;
  }

  /// 把问题卡收起为漂浮球（仅本地 UI；不改变服务端等待语义）。
  void collapsePendingUserInput() {
    if (_pendingUserInput == null || _pendingUserInputCollapsed) return;
    _pendingUserInputCollapsed = true;
    notifyListeners();
  }

  /// 从漂浮球重新展开问题卡作答。
  void expandPendingUserInput() {
    if (!_pendingUserInputCollapsed) return;
    _pendingUserInputCollapsed = false;
    notifyListeners();
  }

  ApiErrorPolicyState? _apiErrorPolicy;
  ApiErrorPolicyState? get apiErrorPolicy => _apiErrorPolicy;

  // The record behind the passive rate_limit_event. It is read by [limitView]
  // (which gates it through providerMatchesCli/balanceBarVisibleFor — the single
  // gate, see models/vendor_quota.dart) and by the expiry timer below; it is
  // persisted to the local runtime cache so a cold start can repaint the bars.
  UsageWindowLimit? _usageWindowLimit;

  // ── Server-rendered quota bars ────────────────────────────────────────────
  // Every bar below is the server's render, resolved here at paint time. The
  // provider holds the raw route responses (for tap-action `status` checks) and
  // the bars carried by WS events; it formats nothing.

  /// The server-rendered `bar` field on a route response (or null).
  Map<String, dynamic>? _barOf(Map<String, dynamic> data) {
    final b = data['bar'];
    return b is Map ? Map<String, dynamic>.from(b) : null;
  }

  /// The idle bar for [key] from the cached /api/quota/bars/idle payload.
  Map<String, dynamic>? _idleBar(String key) {
    final bars = _idleBars?['bars'];
    if (bars is Map) {
      final b = bars[key];
      if (b is Map) return Map<String, dynamic>.from(b);
    }
    return null;
  }

  /// Resolve a vendor's route response to a view, falling back to the server's
  /// idle bar (or its `loading` state) when there is no data yet. The idle bar
  /// is fetched on connect so an unfetched bar shows the server's placeholder
  /// verbatim — the app carries no idle text of its own.
  VendorQuotaView _vendorOrIdle(
    Map<String, dynamic>? data,
    String idleKey, {
    bool loading = false,
    String? state,
  }) {
    if (data != null) {
      final v = vendorViewFromBar(_barOf(data), state: state);
      if (v != null) return v;
    }
    final idle = _idleBar(idleKey);
    final v = vendorViewFromBar(
      idle,
      state: state ?? (loading ? 'loading' : null),
    );
    return v ?? const VendorQuotaView('…', VendorQuotaColor.gray);
  }

  /// Claude subscription bar — the scrape's server-rendered bar (already a
  /// 5h + weekly + monthly merge), with the passive 5h event bar as a live
  /// stand-in before the first scrape lands. Only under the claude CLI AND on
  /// a Claude provider context (empty baseUrl = official login, or an
  /// anthropic/claude host — mirrors the web `isClaudeProvider` gate): on a
  /// non-Claude provider (e.g. Zhipu) the subscription bar hides and the
  /// routed window bar shows instead. Always non-null when gated in, so the
  /// bar stays a visible tap target (mirrors the web fixed-display fallback).
  VendorQuotaView? get claudeLimitView {
    if (!_cli.isClaudeFamily) return null;
    if (!isClaudeProviderBaseUrl(_providerBaseUrl)) return null;
    final usage = _claudeUsage;
    if (usage != null) {
      final v = vendorViewFromBar(_barOf(usage));
      if (v != null) return v;
    }
    if (_rateLimitBar != null) {
      final v = vendorViewFromBar(_rateLimitBar);
      if (v != null) return v;
    }
    final idle = _idleBar('claude');
    final v = vendorViewFromBar(
      idle,
      state: _claudeUsageFetching
          ? 'fetching'
          : _claudeLoginPending
          ? 'login_pending'
          : null,
    );
    return v ?? const VendorQuotaView('…', VendorQuotaColor.gray);
  }

  /// GLM/Codex/Claude window bar from the passive rate_limit_event — the
  /// server's provider-tagged render (`路由供应商 GLM · 5h…` / `1wk…`).
  /// Gated by [providerMatchesCli] (the web `providerMatchesCli` mirror,
  /// baseUrl-aware: a GLM window also shows under the claude CLI when the
  /// provider points at Zhipu, and a Claude window shows under opencode).
  /// Under the claude CLI on a Claude provider the event bar is already the
  /// live stand-in inside [claudeLimitView] — showing it here too would paint
  /// the same window twice.
  VendorQuotaView? get limitView {
    final active = _activeProviderLimit;
    final activeDto = active?['dto'];
    if (activeDto is Map &&
        activeDto['kind'] == 'window' &&
        _activeProviderMatchesCli) {
      // This response belongs to the exact active Provider id. It is more
      // precise than CLI/provider-name heuristics: a Codex session may be backed
      // by Codex Official, GLM, or a borrowed account.
      final view = vendorViewFromBar(_barOf(active!));
      if (view != null) return view;
    }
    final limit = _usageWindowLimit;
    if (limit == null) return null;
    if (!providerMatchesCli(limit.provider, _cli.name, _providerBaseUrl)) {
      return null;
    }
    if (limit.provider == 'claude' &&
        _cli.isClaudeFamily &&
        isClaudeProviderBaseUrl(_providerBaseUrl)) {
      return null;
    }
    return vendorViewFromBar(_rateLimitBar);
  }

  /// DeepSeek balance bar from the passive usage_balance_event. Gated by the
  /// active CLI + provider (mirrors the web balanceMatchesCli) so the bar swaps
  /// instantly on a cli/provider switch instead of lingering from the previous
  /// context.
  VendorQuotaView? get balanceView {
    final active = _activeProviderLimit;
    final activeDto = active?['dto'];
    if (activeDto is Map &&
        activeDto['kind'] == 'balance' &&
        _activeProviderMatchesCli) {
      final view = vendorViewFromBar(_barOf(active!));
      if (view != null) return view;
    }
    if (!balanceBarVisibleFor(_cli.name, _providerBaseUrl)) return null;
    return vendorViewFromBar(_balanceBar);
  }

  /// OpenCode Go subscription bar (5h / weekly / monthly), under the opencode
  /// CLI. Source: GET /api/opencode/quota.
  VendorQuotaView? get opencodeQuotaView {
    if (_cli != SessionCli.opencode) return null;
    return _vendorOrIdle(_opencodeQuota, 'opencode', loading: _opencodeLoading);
  }

  /// Codex weekly subscription bar, under the codex CLI. Source: GET
  /// /api/codex/quota, with the passive rate_limit_event bar as a live
  /// stand-in before the first fetch lands.
  VendorQuotaView? get codexQuotaView {
    // /api/codex/quota is only a legacy fallback when no concrete Provider is
    // known. A known Provider decides whether this Codex session has a Codex
    // window, GLM window, money balance, or no limit surface.
    if (!_cli.isCodexFamily ||
        _activeProviderId != null ||
        _providerSelection != null) {
      return null;
    }
    final v = vendorViewFromBar(
      _codexQuota != null ? _barOf(_codexQuota!) : null,
    );
    if (v != null) return v;
    if (_rateLimitBar != null && _usageWindowLimit?.provider == 'codex') {
      final ev = vendorViewFromBar(_rateLimitBar);
      if (ev != null) return ev;
    }
    final idle = _idleBar('codex');
    final cv = vendorViewFromBar(idle, state: _codexLoading ? 'loading' : null);
    return cv ?? const VendorQuotaView('…', VendorQuotaColor.gray);
  }

  UsageBalance? _usageBalance;
  UsageBalance? get usageBalance => _usageBalance;
  Timer? _usageExpiryTimer;

  // ── Vendor quota bars (ark / zhipu / kimi) ────────────────────────────────
  // Fetch-based bars gated on the active provider's baseUrl host, mirroring the
  // web chat-rate-limit.js bars. The backend does the vendor work; we only read
  // its JSON routes. `_providerBaseUrl` is the gate: it is set on connect
  // (system_init → session detail), on REST switch (applyCliConfig) and on the
  // cli_switched WS broadcast, and a change triggers an immediate refresh so the
  // bar swaps to the new provider's quota right away.
  String _providerBaseUrl = '';
  String get providerBaseUrl => _providerBaseUrl;
  String _providerLimitId = '';
  String _providerLimitAppType = '';
  int _providerLimitRevision = 0;
  bool _providerIdentityKnown = false;
  Map<String, dynamic>? _activeProviderLimit;
  SessionProviderSelection? _providerSelection;
  SessionProviderSelection? get providerSelection => _providerSelection;
  String? _activeProviderId;
  String? get activeProviderId => _activeProviderId;
  String? _activeProviderName;
  String? get activeProviderName => _activeProviderName;
  String? _activeProviderModel;
  String? get activeProviderModel => _activeProviderModel;
  final Map<String, String> _providerCatalogBaseUrls = {};
  final Map<String, String> _providerCatalogAppTypes = {};

  bool get _activeProviderMatchesCli =>
      _cli == SessionCli.opencode || _providerLimitAppType == _cli.appType;

  QuotaService? _quotaService;
  QuotaService get _quota => _quotaService ??= QuotaService(settings: settings);

  Map<String, dynamic>? _arkQuota;
  Map<String, dynamic>? _kimiQuota;
  Map<String, dynamic>? _qoderQuota;
  bool _arkLoading = false;
  bool _arkInstalling = false;
  bool _kimiLoading = false;
  bool _qoderLoading = false;
  // Keyed on the host each query was issued for, for the same reason as
  // _providerLimitInFlightKey: a switch that lands mid-flight must not suppress
  // the new host's query (the old response is dropped by the requestBaseUrl
  // check anyway, so suppressing the new one would blank the bar).
  String? _arkInFlightUrl;
  String? _kimiInFlightUrl;
  bool _qoderInFlight = false;
  int _arkErrorAt = 0;
  int _kimiErrorAt = 0;
  int _qoderErrorAt = 0;
  static const int _vendorQuotaBackoffMs = 60000;

  // Claude subscription usage (GET /api/claude/quota — CDP scrape of
  // claude.ai/settings/usage). Fetched when the claude CLI is (re)connected;
  // a 24h-fresh result is kept (mirrors the web localStorage staleness) so the
  // system_init → applyCliConfig → cli_switched burst doesn't re-scrape.
  Map<String, dynamic>? _claudeUsage;
  bool _claudeUsageFetching = false;
  bool _claudeLoginPending = false;
  int _claudeUsageErrorAt = 0;
  static const int _claudeUsageFreshMs = 24 * 3600 * 1000;

  // OpenCode Go subscription usage (GET /api/opencode/quota — CDP scrape of the
  // opencode.ai Zen console). Fetched when the opencode CLI is (re)connected.
  Map<String, dynamic>? _opencodeQuota;
  bool _opencodeLoading = false;
  bool _opencodeInFlight = false;
  int _opencodeErrorAt = 0;

  // Codex (ChatGPT) weekly subscription quota (GET /api/codex/quota). Fetched
  // when the codex CLI is (re)connected; the passive rate_limit_event also
  // carries a codex bar, so the REST fetch is mainly for an initial value and
  // a manual refresh.
  Map<String, dynamic>? _codexQuota;
  bool _codexLoading = false;
  bool _codexInFlight = false;
  int _codexErrorAt = 0;

  // Server-rendered bars carried by the passive WS events. The structured
  // [UsageWindowLimit] / [_usageWindowLimit] still drives expiry + cli gating
  // + cache; these bars are what the panel actually paints.
  Map<String, dynamic>? _rateLimitBar;
  Map<String, dynamic>? _balanceBar;

  // Idle (no-data-yet) bars for every vendor, rendered once on the server
  // (GET /api/quota/bars/idle → {status:'ok', bars:{ark,zhipu,kimi,...}}).
  // Cached on connect so an unfetched bar shows the server's idle placeholder
  // verbatim — the app holds no hardcoded idle text of its own.
  Map<String, dynamic>? _idleBars;

  // ── What the usage bar under the transcript shows ─────────────────────────
  // The bar itself shows context and nothing else; everything below it reaches
  // the user through the tap/long-press detail sheet. Money is deliberately
  // absent: `total_cost_usd` comes from the CLI, which prices every turn with
  // Anthropic's table even when the request was routed to another provider, so
  // it is not this session's cost and no label here could make it one.

  /// Usage of the newest single API request (stream_event `message_start`).
  /// One request cannot double-count its own cached prefix, so its prompt side
  /// IS the context — see [ContextReadout].
  MessageUsage? _requestUsage;

  /// Usage of the whole turn (the `result` frame). A turn sums every request it
  /// made, so this is only ever a fallback estimate for the context.
  MessageUsage? _turnUsage;
  int _contextWindow = 0;
  int _sessionInputTokens = 0;
  int _sessionOutputTokens = 0;
  String _turnDurationText = '';
  int _turnCount = 0;
  Map<String, dynamic>? _contextTrace;

  ContextReadout get contextReadout => ContextReadout.of(
    request: _requestUsage,
    turn: _turnUsage,
    window: _contextWindow,
  );
  MessageUsage? get turnUsage => _turnUsage;
  String get turnDurationText => _turnDurationText;
  int get turnCount => _turnCount;
  int get sessionInputTokens => _sessionInputTokens;
  int get sessionOutputTokens => _sessionOutputTokens;
  Map<String, dynamic>? get contextTrace => _contextTrace;

  // ── 自动提交（对齐 web 的 `#auto-commit-btn` + 每轮气泡勾选） ─────────────
  //
  // Web 把「这一轮要不要自动提交」存在 DOM 上：勾选框挂在用户气泡里，会话级
  // 开关同步新气泡时跳过 `userTouched` 的那条。这里用两张表把同一套语义搬到
  // Dart —— 聊天页重建消息列表是常态，DOM 那套没法照搬。

  /// 用户亲手改过的那些轮：这些不再跟随会话级开关。
  final Map<String, bool> _turnAutoCommit = {};
  final Set<String> _turnAutoCommitTouched = {};

  /// 已经自动提交过的轮（对应 web 给气泡加的 `.done`）。服务端不记这件事，
  /// 所以它只活在本次会话的内存里。
  final Set<String> _autoCommittedTurns = {};

  /// 每收到一个 `result` 帧自增。它是「这一轮结束了」的唯一信号 —— 自动提交
  /// 要等它，而不是等流式停止（一次多步 agent 运行中间会停好几次）。
  int _turnEndTick = 0;
  int get turnEndTick => _turnEndTick;

  /// 这一轮（这条用户消息开启的那一轮）是否勾了自动提交。
  ///
  /// 没被手工改过就跟随 [fallback]（会话级开关的当前值）—— web 也是这么
  /// initialize 的：`addUserMsg(..., checked = _sessionAutoCommit)`。
  bool turnAutoCommit(String msgId, {required bool fallback}) {
    if (_turnAutoCommitTouched.contains(msgId)) {
      return _turnAutoCommit[msgId] ?? fallback;
    }
    return fallback;
  }

  /// 用户手点这条气泡的勾选框。点过就进 touched 集合，之后会话级开关再变也
  /// 不会覆盖这一轮的选择。
  void setTurnAutoCommit(String msgId, bool value) {
    if (msgId.isEmpty) return;
    _turnAutoCommit[msgId] = value;
    _turnAutoCommitTouched.add(msgId);
    notifyListeners();
  }

  bool isTurnAutoCommitted(String msgId) => _autoCommittedTurns.contains(msgId);

  void markTurnAutoCommitted(String msgId) {
    if (msgId.isEmpty) return;
    _autoCommittedTurns.add(msgId);
    notifyListeners();
  }

  // ── 引用消息的落地通道 ─────────────────────────────────────────────────────
  //
  // 引用块要插进输入框，而输入框（TextEditingController）归聊天页持有 ——
  // provider 连它的影子都没有。所以聊天页在自己的 initState 里把「把这段文字
  // 放进输入框」登记到这儿，气泡那边长按后调它。
  //
  // 可空是刻意的，也是这个通道唯一的语义：没有输入框的宿主（任务详情那种只读
  // 转录）保持为 null，气泡据此**不提供**「引用」—— 摆一个点不动的入口，比
  // 不摆更糟。

  /// 由持有输入框的那一层登记：把 [block] 插进输入框并聚焦。null = 本宿主没有
  /// 输入框，不提供引用。
  void Function(String block)? quoteInserter;

  Future<Map<String, dynamic>> loadContextTrace() {
    final traceId = _contextTrace?['traceId']?.toString() ?? '';
    if (traceId.isEmpty) {
      return Future.error(StateError('context trace unavailable'));
    }
    String? source;
    for (final message in _messages.reversed) {
      if (message.contextTrace?['traceId'] == traceId && message.id != null) {
        source = shellMessageOwner(executionSessionName, message.id!).sessionId;
        break;
      }
    }
    return _service.fetchContextTrace(traceId, sourceSessionId: source);
  }

  int _reconnectAttempt = 0;

  /// 已发送、等服务端 FIFO 裁决的用户消息（对齐 web stagedUserBubbles：进队列的
  /// 不在对话区占位，started 才回填气泡）。pending 为空 = 没有占位暂存。
  late final StagedSendTracker _stagedTracker = StagedSendTracker(
    onCommit: _commitStagedBubble,
  );
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
  int _historyGeneration = 0;
  bool historyArchive;

  /// Whether this session is the one currently viewed by the user.
  bool isActive = true;

  /// Whether the entire app is in the background.
  bool isInBackground = false;

  /// Latest `role_token_stats` payload from the server (keyed by `role`).
  /// Cached so `_onResult` can compute savedMainTokens even if this event
  /// arrived before the result. See the WS timing note in `_onResult`.
  Map<String, dynamic>? _lastRoleTokens;

  /// Parsed view of the same event — feeds the usage detail sheet (main /
  /// sub / per-provider split) instead of re-reading the raw map in widgets.
  RoleTokenBreakdown? _lastRoleBreakdown;

  /// Background-task danmaku state machine (web chat-live-ui.js parity).
  /// Fed by monitor_* / progress_heartbeat / background_tasks events.
  final BackgroundTaskBoard _backgroundTasks = BackgroundTaskBoard();
  Timer? _bgSweepTimer;

  /// Dispatch summary (live operations plus bounded recent terminal history).
  /// The contract has NO WS push — this is event-triggered + bounded polling
  /// over GET /dispatches (refreshDispatchQueue). Distinct from
  /// [_sessionQueue] (staged user messages) and from background tasks.
  List<DispatchQueueEntry> _dispatchQueue = const [];
  List<DispatchQueueEntry> get dispatchQueue =>
      List.unmodifiable(_dispatchQueue);
  Timer? _dispatchQueueTimer;
  Timer? _dispatchQueueRetryTimer;
  int _dispatchQueueFailureCount = 0;
  bool _dispatchQueueInFlight = false;

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

  /// Whether the verdict above is FROZEN because the aux classifier that
  /// produces it is itself unhealthy. The bar keeps rendering the last goal —
  /// it is still the best description available — but marks it as not current.
  bool _classifyStale = false;
  bool get classifyStale => _classifyStale;

  bool get hasClassify => _classifyGoal.trim().isNotEmpty;

  ChatProvider({
    required this.settings,
    required this.sessionName,
    String? displayName,
    String? dirName,
    required this.sessionCwd,
    SessionCli initialCli = SessionCli.claude,
    this.onSessionConfigChanged,
    this.historyArchive = false,
    this.taskBoundTaskId,
    QuotaService? quotaService,
  }) : displayName = displayName ?? sessionName,
       dirName = dirName ?? '' {
    _cwd = sessionCwd;
    _cli = initialCli;
    // Test seam: vendor quota fetches fire real HTTP against the configured
    // host. A test can inject a stub here so those fetches complete without
    // the network; null keeps the lazy on-first-use construction.
    _quotaService = quotaService;
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
      // Restored unconditionally (the web localStorage limit bar has no
      // staleness filter either): a past 5h reset still leaves the weekly
      // windows on the bar, and paint-time {cd} tokens resolve that window to
      // 已重置 rather than to a live-looking countdown.
      if (parsed != null) {
        _usageWindowLimit = parsed;
        _armUsageExpiry();
      }
    }
    final balance = cached['balance'];
    if (balance is Map) {
      _usageBalance = UsageBalance.fromJson(Map<String, dynamic>.from(balance));
    }
    // Server-rendered bars carried by the passive WS events. Restored verbatim
    // so a cold start paints the same bar the user last saw (the tokens are
    // re-expanded at paint time, so an old bar's countdown refreshes itself).
    final limitBar = cached['limitBar'];
    if (limitBar is Map) {
      _rateLimitBar = Map<String, dynamic>.from(limitBar);
    }
    final balanceBar = cached['balanceBar'];
    if (balanceBar is Map) {
      _balanceBar = Map<String, dynamic>.from(balanceBar);
    }
    // Claude usage-page scrape (weekly / monthly windows). Restore a fresh
    // successful scrape like the web localStorage cache — otherwise a cold start
    // whose CDP re-fetch fails shows only the passive 5h window until the user
    // taps the bar. The same 24h freshness governs restore and re-fetch.
    final claudeUsage = cached['claudeUsage'];
    if (claudeUsage is Map) {
      final status = claudeUsage['status']?.toString();
      final fetchedAt = (claudeUsage['fetchedAt'] as num?)?.toInt();
      if (status == 'ok' &&
          fetchedAt != null &&
          _nowMs() - fetchedAt < _claudeUsageFreshMs) {
        _claudeUsage = Map<String, dynamic>.from(claudeUsage);
      }
    }
    // Fetch-based quota slots (ark/zhipu/kimi/qoder/opencode/codex): restore a
    // fresh (<24h) successful response like the web per-slot localStorage
    // caches, so a cold start paints the last bar instead of the idle
    // placeholder. Only ok responses were ever persisted.
    for (final entry in _vendorQuotaCacheSlots.entries) {
      final raw = cached[entry.key];
      if (raw is! Map) continue;
      final fetchedAt = (raw['fetchedAt'] as num?)?.toInt();
      final data = raw['data'];
      if (fetchedAt == null ||
          data is! Map ||
          _nowMs() - fetchedAt >= _claudeUsageFreshMs) {
        continue;
      }
      entry.value(Map<String, dynamic>.from(data));
    }
  }

  // The fetch-based quota slots that participate in the runtime cache, keyed
  // by their cache field. Mirrors the web per-slot localStorage keys.
  Map<String, void Function(Map<String, dynamic>)> get _vendorQuotaCacheSlots =>
      {
        'arkQuota': (v) => _arkQuota = v,
        'kimiQuota': (v) => _kimiQuota = v,
        'qoderQuota': (v) => _qoderQuota = v,
        'opencodeQuota': (v) => _opencodeQuota = v,
        'codexQuota': (v) => _codexQuota = v,
      };

  void _persistRuntimeCache() {
    unawaited(
      settings.saveChatRuntimeCache(sessionName, {
        if (_usageWindowLimit != null) 'limit': _usageWindowLimit!.toJson(),
        if (_usageBalance != null) 'balance': _usageBalance!.toJson(),
        if (_rateLimitBar != null) 'limitBar': _rateLimitBar,
        if (_balanceBar != null) 'balanceBar': _balanceBar,
        // Only a successful scrape is cached (matches the web save-on-ok); the
        // page text is dropped so the stored payload stays small.
        if (_claudeUsage != null && _claudeUsage?['status'] == 'ok')
          'claudeUsage': {
            'status': 'ok',
            if (_claudeUsage?['fetchedAt'] != null)
              'fetchedAt': _claudeUsage!['fetchedAt'],
            if (_claudeUsage?['summary'] is List)
              'summary': _claudeUsage!['summary'],
          },
        // Vendor quota slots: same save-on-ok + 24h freshness contract as the
        // web per-slot localStorage caches. fetchedAt is the SERVER's stamp on
        // the ok response, so an unrelated persist never extends freshness.
        for (final entry in _vendorQuotaCacheSlots.entries)
          if (_quotaDataOf(entry.key) case final Map<String, dynamic> data)
            if ((data['fetchedAt'] as num?)?.toInt() case final fetchedAt?)
              entry.key: {'fetchedAt': fetchedAt, 'data': data},
      }),
    );
  }

  /// The live fetch response behind a vendor quota cache slot, or null when
  /// the slot is empty or its last response was not ok.
  Map<String, dynamic>? _quotaDataOf(String cacheKey) {
    final Map<String, dynamic>? data = switch (cacheKey) {
      'arkQuota' => _arkQuota,
      'kimiQuota' => _kimiQuota,
      'qoderQuota' => _qoderQuota,
      'opencodeQuota' => _opencodeQuota,
      'codexQuota' => _codexQuota,
      _ => null,
    };
    if (data == null || data['status']?.toString() != 'ok') return null;
    return data;
  }

  void _armUsageExpiry() {
    _usageExpiryTimer?.cancel();
    final reset = _usageWindowLimit?.resetsAtMs;
    if (reset == null) return;
    final delayMs = reset - DateTime.now().millisecondsSinceEpoch + 50;
    if (delayMs <= 0) {
      // Already past the reset: just re-render, the way the web expiry timer
      // does — the {cd} token now resolves to 已重置, so the bar stops claiming
      // the old reading is still counting down. The limit is NOT cleared — its
      // bar still shows the windows that have not reset (e.g. weekly).
      notifyListeners();
      return;
    }
    _usageExpiryTimer = Timer(
      Duration(milliseconds: delayMs.clamp(1, 2147000000).toInt()),
      () {
        // Mirrors the web scheduleExpiry: re-render at the 5h reset so a stale
        // countdown becomes 已重置; the bar itself is not cleared (weekly windows
        // have not reset).
        notifyListeners();
      },
    );
  }

  void setDisplayName(String value, {String? dirName}) {
    if (displayName == value && (dirName == null || this.dirName == dirName)) {
      return;
    }
    displayName = value;
    // Directory names arrive with the dashboard load — potentially after this
    // provider was constructed (e.g. opened from a notification before the
    // list resolved, when _dirNameFor could only return '').
    if (dirName != null) this.dirName = dirName;
    notifyListeners();
  }

  // ── Service init ───────────────────────────────────────────────────────────

  void _initService({String? executionSessionName}) {
    _service = ChatService(
      settings: settings,
      sessionName: sessionName,
      sessionCwd: sessionCwd,
      initialSessionId: _sessionId,
      initialExecutionSessionName: executionSessionName,
      historyArchive: historyArchive,
    );
    _eventSub?.cancel();
    _eventSub = _service.events.listen(_onEvent);
    _service.connect();
    // Fresh socket = reconnect reconcile for the polled dispatch snapshot.
    unawaited(refreshDispatchQueue());
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
        // Socket died: any resolve broadcast in the gap was lost. Drop the
        // stale card; the connect-time replay re-sends required/resolved.
        _setPendingUserInput(null);
        // Spinning background rows can no longer be trusted to finish on
        // their own — mark stale now; the background_tasks snapshot after
        // reconnect reconciles what is real.
        if (_backgroundTasks.hasSpinning) {
          _backgroundTasks.markStaleAll(
            now: DateTime.now().millisecondsSinceEpoch,
          );
        }
        final delay = (1 << (_reconnectAttempt - 1)).clamp(1, 15);
        _statusText = 'Reconnecting in ${delay}s…';
        notifyListeners();
        break;

      case 'system_init':
        unawaited(refreshDispatchQueue());
        final msg = evt.payload as Map<String, dynamic>;
        final sid = (msg['session_id'] ?? msg['session'])?.toString();
        if (sid != null && sid.isNotEmpty) _sessionId = sid;
        if (msg['cwd'] != null) _cwd = msg['cwd'].toString();
        if (msg['cli'] != null) {
          _cli = parseCli(msg['cli']?.toString());
        }
        _providerSelection = parseProviderSelection(msg['providerSelection']);
        _clearActualProviderRoute();
        final providerRoute = msg['providerRoute'];
        if (providerRoute is Map) {
          _applyActualProviderRoute(providerRoute);
        } else if (_providerSelection == null) {
          _applyConfiguredProvider(msg);
        }
        refreshClaudeUsage();
        refreshQoderQuota();
        refreshOpenCodeQuota();
        refreshCodexQuota();
        if (_providerSelection == null) {
          _loadProviderBaseUrl();
        } else {
          _syncActualProviderBaseUrl();
        }
        _loadIdleBars();

        final model = _providerSelection == null
            ? msg['model']?.toString()
            : null;
        _statusText = _providerSelection != null
            ? 'Connected · Auto'
            : model != null
            ? t('connectedModel', {'model': model})
            : t('connectedCli', {'cli': _cli.name});

        final serverStreaming = msg['is_streaming'] == true;
        if (serverStreaming && _folder.currentMsg == null) {
          _folder.ensureAssistantMsg();
        } else if (!serverStreaming && _folder.currentMsg != null) {
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
        if (next != _cli) _clearCliQuotaBackoff();
        _cli = next;
        _providerSelection = parseProviderSelection(msg['providerSelection']);
        _clearActualProviderRoute();
        if (_providerSelection == null) _applyConfiguredProvider(msg);
        refreshClaudeUsage();
        refreshQoderQuota();
        // Parity with system_init / applyCliConfig / the web setCli: switching
        // CLI switches the account whose quota is on screen, so fetch the one
        // bar that just became relevant (no-op off its CLI; in-flight guard
        // dedupes the applyCliConfig that often precedes this broadcast).
        refreshOpenCodeQuota();
        refreshCodexQuota();
        if (_providerSelection == null) {
          _setProviderBaseUrl(msg['providerBaseUrl']?.toString() ?? '');
        } else {
          _syncActualProviderBaseUrl();
        }
        final model = _providerSelection == null
            ? msg['effectiveModel']?.toString()
            : null;
        _statusText = _providerSelection != null
            ? 'Connected · Auto'
            : model != null && model.isNotEmpty
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

      case 'provider_route_event':
      case 'provider_auto_route':
        applyProviderRoutingEvent(evt.type, evt.payload as Map);
        break;

      case 'task_shell_routed':
        _finishStreaming();
        _stagedTracker.clear();
        _historyGeneration++;
        // Keep the visible shell transcript until the new execution replays.
        _replaceHistoryOnReconnect = true;
        _pendingUserInput = null;
        notifyListeners();
        break;

      case 'chat_history_reset':
        if (historyArchive) break;
        _historyGeneration++;
        final reset = evt.payload as Map;
        if (reset['shellHistory'] == true) {
          final prefix = '${reset['sourceSessionId']}:';
          _messages.removeWhere((m) => (m.id ?? '').startsWith(prefix));
          _replaceHistoryOnReconnect = true;
          _oldestLoadedMsgId = null;
          notifyListeners();
          break;
        }
        final live = isStreaming ? _folder.currentMsg : null;
        final activeTools = Map.of(_folder.activeTools);
        _replaceHistory(reset['messages'] as List? ?? []);
        if (live != null) {
          final replayTail = streamingAssistantTail(_messages);
          if (replayTail != null) _messages.remove(replayTail);
          _messages.add(live);
          _folder.currentMsg = live;
          _folder.activeTools
            ..clear()
            ..addAll(activeTools);
        }
        _historyApplied = true;
        _historyHasMore = reset['hasMore'] == true;
        _historyExhausted = !_historyHasMore;
        _oldestLoadedMsgId = _firstLoadedMsgId();
        // 清空/保留的反馈，文案与判定都照 web 的 handleHistoryReset 来。历史
        // 在这一刻已经换掉了，这条系统行回答的是「刚才那下操作」——所以它必须
        // 排在 _replaceHistory 之后，否则会被换进来的历史冲掉。
        final keep = int.tryParse('${reset['keep'] ?? ''}') ?? 0;
        if (keep > 0) {
          final removed = int.tryParse('${reset['removedCount'] ?? ''}') ?? 0;
          _addSystemMsg(
            removed > 0
                ? t('contextKept', {
                    'removed': '$removed',
                    'kept':
                        '${int.tryParse('${reset['retainedCount'] ?? ''}') ?? 0}',
                  })
                : t('contextResetKept'),
          );
        } else {
          _addSystemMsg(t('contextCleared'));
        }
        notifyListeners();
        break;

      case 'shell_history_update':
        final update = evt.payload as Map;
        _mergeShellPage(
          update['messages'] as List? ?? [],
          sourceSessionId: update['sourceSessionId']?.toString(),
        );
        notifyListeners();
        break;

      case 'chat_history_annotation':
        {
          // 一条消息属于哪个子任务，是服务端在**这一轮结束时**判定的
          // （annotateTurn 把归属打到该轮所有消息上，再广播本事件）。那时气泡
          // 早就画在屏幕上了，所以这里是就地打标、不重建列表 —— 重建会打断
          // 正在进行的流式输出、丢掉滚动位置。
          final records = (evt.payload as Map)['messages'];
          if (records is List) {
            var applied = 0;
            for (final raw in records) {
              if (raw is! Map) continue;
              final record = Map<String, dynamic>.from(raw);
              final message = _messageByIdentity(
                record['id']?.toString() ?? '',
              );
              if (message == null) continue;
              message.applyAttribution(record);
              applied += 1;
            }
            if (applied > 0) notifyListeners();
          }
          break;
        }

      case 'chat_history':
        final p = evt.payload as Map;
        final history = p['messages'] as List;
        final hasMore = p['hasMore'] == true;
        // Every socket receives one authoritative page. Process it even when
        // it races ahead of the async `connected` callback: first connect
        // appends into an empty view, every later page atomically reconciles.
        final hadCursor = _oldestLoadedMsgId != null;
        final replace = _historyApplied || _replaceHistoryOnReconnect;
        _historyApplied = true;
        _replaceHistoryOnReconnect = false;
        if (replace && _service.hasShellHistory) {
          _historyGeneration++;
          _mergeShellPage(history);
        } else if (replace) {
          _replaceHistory(history);
        } else {
          _replayHistory(history);
        }
        // Seed lazy-pagination cursor + hasMore from this initial page.
        if (!replace || !_service.hasShellHistory || !hadCursor) {
          _historyHasMore = hasMore;
          _historyExhausted = !hasMore;
        }
        _oldestLoadedMsgId = _firstLoadedMsgId();
        notifyListeners();
        break;

      case 'message_start':
        _admissionProgressText = null;
        _admissionProgressClientMsgId = null;
        _onMessageStart(evt.payload as Map<String, dynamic>?);
        break;

      case 'stream_start':
        _admissionProgressText = null;
        _admissionProgressClientMsgId = null;
        notifyListeners();
        break;

      case 'content_block_start':
        _folder.contentBlockStart(evt.payload as Map<String, dynamic>);
        break;

      case 'content_block_delta':
        _folder.contentBlockDelta(evt.payload as Map<String, dynamic>);
        break;

      case 'assistant':
        _folder.assistantSnapshot(evt.payload as Map<String, dynamic>);
        break;

      case 'part_delta':
        _folder.partDelta(evt.payload as Map<String, dynamic>);
        break;

      case 'user':
        // tool_result frames (the paired completion of each tool call).
        _folder.userToolResult(evt.payload as Map<String, dynamic>);
        break;

      case 'content_block_stop':
        break;

      case 'message_delta':
        break;

      case 'result':
        _onResult(evt.payload as Map<String, dynamic>);
        // A finished turn may have admitted the next dispatch out of the
        // target FIFO — re-poll the authoritative projection.
        unawaited(refreshDispatchQueue());
        break;

      case 'stream_end':
        _finishStreaming();
        notifyListeners();
        break;

      case 'notify':
        // The server's aux-AI reports turn outcome: running / waiting / succeeded.
        final p = evt.payload as Map<String, dynamic>;
        final notifyState = (p['state'] ?? 'succeeded').toString();
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
          // server provides it; fall back to the coarse notify state. The
          // wording itself lives in session_status_helpers (one table shared
          // with the task list and the voice call), so notifications, the
          // chat bar and TTS all say the same thing for one outcome.
          final cls = (p['classifyState'] ?? '').toString();
          _maybeNotify(
            classifyNotificationWord(cls.isEmpty ? notifyState : cls),
            notifyMsg,
          );
        }
        break;

      case 'error':
        final errorText = evt.payload.toString();
        if (_isRecoverableCodexReconnectErrorText(errorText)) break;
        _addSystemMsg('Error: $errorText');
        _attachKnownUsageToInterruptedTail();
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
          // A user message that settles a wait_for_user_answer prompt carries
          // the prompt's requestId as answeredQuestionId (inside `message`).
          // Treat it as a teardown signal — the message-carried backup for the
          // fire-and-forget user_input_resolved event, so a client that missed
          // the event (or a fresh foreground) still closes the prompt when the
          // committed answer message reaches it. Idempotent: requestId mismatch
          // means this client already consumed it, no-op.
          final answeredId = (p['message'] as Map?)?['answeredQuestionId']
              ?.toString();
          if (answeredId != null &&
              answeredId.isNotEmpty &&
              _pendingUserInput != null &&
              _pendingUserInput!.requestId == answeredId) {
            _setPendingUserInput(null);
            notifyListeners();
          }
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
        if (historyArchive && (evt.payload as Map)['displayOnly'] == true)
          break;
        _historyGeneration++;
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
          // renderAuxClassify. The verdict's freshness rides on the same tick —
          // absent (an older server) leaves it alone rather than clearing it, so
          // the marker can't blink off on a frame that predates the fact.
          final p = evt.payload as Map<String, dynamic>;
          _classifyGoal = (p['goal'] ?? '').toString().trim();
          _classifyPhase = (p['phase'] ?? 'idle').toString().toLowerCase();
          final next = (p['classifyState'] ?? '').toString().toUpperCase();
          _classifyState = next == 'C' ? 'W' : next;
          if (p['auxUnhealthy'] is bool) {
            _classifyStale = p['auxUnhealthy'] == true;
          }
          notifyListeners();
          break;
        }

      case 'aux_verdict_staleness':
        {
          // The classifier changed health. A frozen classifier sends no further
          // task_state, so this is the only frame that can mark (or unmark) an
          // already-open chat. Fleet-wide fact on a per-session socket: the bar
          // belongs to this session, so it follows verbatim.
          final p = evt.payload as Map<String, dynamic>;
          if (p['auxUnhealthy'] is bool) {
            _classifyStale = p['auxUnhealthy'] == true;
            notifyListeners();
          }
          break;
        }

      case 'user_input_required':
        {
          final p = evt.payload as Map<String, dynamic>;
          _setPendingUserInput(PendingUserInput.fromJson(p));
          notifyListeners();
          break;
        }

      case 'user_input_resolved':
        {
          // 另一窗口消费了 wait_user：清掉本窗口的提示框（幂等：requestId 不匹配
          // 表示本窗口已先消费，no-op）。
          final requestId = (evt.payload as Map<String, dynamic>)['requestId']
              ?.toString();
          if (_pendingUserInput != null &&
              _pendingUserInput!.requestId == requestId) {
            _setPendingUserInput(null);
            notifyListeners();
          }
          break;
        }

      case 'message_admission_progress':
        {
          final p = evt.payload as Map<String, dynamic>;
          final clientMsgId = (p['clientMsgId'] ?? '').toString().trim();
          final text = (p['message'] ?? '').toString();
          if (clientMsgId.isNotEmpty &&
              !_messages.any((message) => message.clientMsgId == clientMsgId)) {
            final committed = _stagedTracker.commitByClientMsgId(clientMsgId);
            if (!committed && text.isNotEmpty) {
              // 回填可能晚于 message_start：插到流式助手气泡之前，别让用户
              // 消息落到它自己的回答下面。
              _messages.insert(
                userBubbleInsertIndex(_messages, _folder.currentMsg),
                ChatMessage(
                  role: MessageRole.user,
                  content: text,
                  clientMsgId: clientMsgId,
                ),
              );
            }
          }
          if (p['state'] == 'failed') {
            if (clientMsgId.isEmpty ||
                clientMsgId == _admissionProgressClientMsgId) {
              _admissionProgressText = null;
              _admissionProgressClientMsgId = null;
            }
            _autoRouteLine.drop(_messages);
            _statusText = t('admissionDeliveryFailedShort');
            final detail = admissionProgressDetail(p);
            _addSystemMsg(
              detail == null
                  ? t('admissionDeliveryFailed')
                  : t('admissionDeliveryFailedWithCause', {'cause': detail}),
            );
            break;
          }
          if (p['stage'] == 'auto_provider_routing' &&
              p['state'] == 'waiting') {
            // A message queued behind a running answer gets its line when its
            // own turn starts, not drawn into the middle of that answer.
            if (isStreaming) {
              notifyListeners();
              break;
            }
            _autoRouteLine.judging(_messages);
          }
          final key = admissionProgressI18nKey(p);
          if (key == null) break;
          _admissionProgressClientMsgId = clientMsgId.isEmpty
              ? null
              : clientMsgId;
          final detail = p['reason'] == 'memory_distill_failed'
              ? admissionProgressDetail(p)
              : null;
          _admissionProgressText = detail == null
              ? t(key)
              : t('admissionMemoryFailedWithCause', {'cause': detail});
          _statusText = _admissionProgressText!;
          if (p['state'] == 'skipped' &&
              p['reason'] == 'memory_distill_failed') {
            _addSystemMsg(_admissionProgressText!);
          } else {
            notifyListeners();
          }
          break;
        }

      case 'session_queue':
        {
          final p = evt.payload as Map<String, dynamic>;
          final event = (p['event'] ?? '').toString();
          _sessionQueueEventSeq++;
          _sessionQueue = SessionQueueState.fromEvent(
            p,
            previous: _sessionQueue,
          );
          // 裁决暂存消息：立即执行则显示气泡，进队列则继续暂存，取消则丢弃。
          _stagedTracker.reconcile(event, p);
          // 已被 claim 但 turn 尚未 started 的输入，此时不在 items 里、历史里
          // 也还没有记录；快照的 active 带着发送方的 clientMsgId/原文，重载或
          // 断线重连后靠它把用户气泡补回来（started 后由历史接管）。
          final active = p['active'];
          if (active is Map<String, dynamic> && active['startedAt'] == null) {
            final activeClientMsgId = (active['clientMsgId'] ?? '')
                .toString()
                .trim();
            final activeText = (active['text'] ?? '').toString();
            if (activeClientMsgId.isNotEmpty &&
                activeText.isNotEmpty &&
                !_messages.any(
                  (message) => message.clientMsgId == activeClientMsgId,
                )) {
              final committed = _stagedTracker.commitByClientMsgId(
                activeClientMsgId,
              );
              if (!committed) {
                _messages.insert(
                  userBubbleInsertIndex(_messages, _folder.currentMsg),
                  ChatMessage(
                    role: MessageRole.user,
                    content: activeText,
                    clientMsgId: activeClientMsgId,
                  ),
                );
              }
            }
          }
          final clientMsgId = p['clientMsgId']?.toString();
          final ownsAdmission =
              clientMsgId != null &&
              clientMsgId == _admissionProgressClientMsgId;
          if (event == 'queued') {
            if (ownsAdmission && p['queued'] == false) {
              _admissionProgressText = t('admissionStarting');
              _statusText = _admissionProgressText!;
            } else {
              if (ownsAdmission) {
                _admissionProgressText = null;
                _admissionProgressClientMsgId = null;
              }
              final position = p['queuePosition'];
              _statusText = position == null
                  ? '消息已持久排队'
                  : '消息已排队（第 $position 位）';
            }
          } else if (event == 'frozen') {
            _statusText = '队列已冻结：${(p['freezeReason'] ?? '当前任务尚未成功完成')}';
          } else if (event == 'started') {
            _statusText = '正在执行队首任务';
          }
          // Queue advanced (something queued/started/frozen) — dispatches
          // waiting on this FIFO may have moved too.
          unawaited(refreshDispatchQueue());
          notifyListeners();
          break;
        }

      case 'session_updated':
        {
          // Live rename (PATCH /api/sessions/:id {label}) pushed by the server
          // on this session's own chat socket. Without it a rename made on the
          // web client never reached an open App chat until a full restart.
          // label == null means cleared → fall back to the session id.
          final p = evt.payload as Map<String, dynamic>;
          final sid = (p['sessionId'] ?? '').toString();
          if (sid == sessionName) {
            final label = p['label']?.toString();
            setDisplayName(
              label != null && label.isNotEmpty ? label : sessionName,
            );
          }
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
          final payload = evt.payload as Map<String, dynamic>;
          final parsed = UsageWindowLimit.fromEvent(payload);
          if (parsed == null) break;
          _usageWindowLimit = parsed;
          final bar = payload['bar'];
          if (bar is Map) _rateLimitBar = Map<String, dynamic>.from(bar);
          _armUsageExpiry();
          _persistRuntimeCache();
          notifyListeners();
          break;
        }

      case 'usage_balance_event':
        {
          final payload = evt.payload as Map<String, dynamic>;
          final parsed = UsageBalance.fromJson(payload);
          if (parsed == null) break;
          _usageBalance = parsed;
          final bar = payload['bar'];
          if (bar is Map) _balanceBar = Map<String, dynamic>.from(bar);
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
        {
          final breakdown = RoleTokenBreakdown.fromEvent(
            evt.payload as Map<String, dynamic>,
          );
          if (breakdown != null) {
            _lastRoleBreakdown = breakdown;
            // Attach live so the detail chip appears during streaming; a
            // post-result arrival falls back to the kept-alive last bubble.
            final target = _folder.currentMsg ?? _folder.lastAssistantMsg;
            if (target != null) {
              target.usage ??= MessageUsage();
              target.usage!.roleBreakdown = breakdown;
            }
          }
        }
        notifyListeners();
        break;

      case 'monitor_started':
        _backgroundTasks.onMonitorStarted(
          evt.payload as Map<String, dynamic>,
          now: DateTime.now().millisecondsSinceEpoch,
        );
        _armBgSweep();
        notifyListeners();
        break;

      case 'monitor_progress':
        _backgroundTasks.onMonitorProgress(
          evt.payload as Map<String, dynamic>,
          now: DateTime.now().millisecondsSinceEpoch,
        );
        notifyListeners();
        break;

      case 'monitor_done':
        _backgroundTasks.onMonitorDone(
          evt.payload as Map<String, dynamic>,
          now: DateTime.now().millisecondsSinceEpoch,
        );
        notifyListeners();
        break;

      case 'progress_heartbeat':
        _backgroundTasks.onHeartbeat(
          evt.payload as Map<String, dynamic>,
          now: DateTime.now().millisecondsSinceEpoch,
        );
        notifyListeners();
        break;

      case 'background_tasks':
        // Authoritative snapshot — reconnect reconcile ground truth.
        _backgroundTasks.onBackgroundTasksSnapshot(
          evt.payload as Map<String, dynamic>,
          now: DateTime.now().millisecondsSinceEpoch,
        );
        notifyListeners();
        break;
    }
  }

  /// Apply the authoritative REST response immediately. The matching WS event
  /// still owns the user-facing handoff notice and is de-duplicated separately.
  void applyCliConfig(SessionCliConfig config) {
    if (config.cli != _cli) _clearCliQuotaBackoff();
    _cli = config.cli;
    _providerSelection = config.providerSelection;
    _clearActualProviderRoute();
    if (_providerSelection == null) {
      _applyConfiguredProvider({
        'providerId': config.provider,
        'providerName': config.providerName,
        'model': config.effectiveModel ?? config.model,
      });
    }
    refreshClaudeUsage();
    refreshQoderQuota();
    refreshOpenCodeQuota();
    refreshCodexQuota();
    final model = _providerSelection == null
        ? config.effectiveModel ?? config.model
        : null;
    _statusText = _providerSelection != null
        ? 'Connected · Auto'
        : model != null && model.isNotEmpty
        ? 'Connected · $model'
        : 'Connected · ${config.cli.name}';
    if (_providerSelection == null) {
      _setProviderBaseUrl(config.providerBaseUrl ?? '');
    } else {
      _syncActualProviderBaseUrl();
    }
    notifyListeners();
  }

  /// Update the active provider baseUrl and, when it changed, immediately pull
  /// fresh quota for whichever vendor it points at (mirrors the web
  /// setProviderBaseUrl refresh-on-change behavior; the first call is a report).
  void _setProviderBaseUrl(String baseUrl) {
    final next = baseUrl.trim();
    final nextProviderId = (_activeProviderId ?? '').trim();
    final nextAppType = nextProviderId.isEmpty
        ? ''
        : (_providerCatalogAppTypes[nextProviderId] ?? _cli.appType);
    final changed =
        _providerIdentityKnown &&
        (next != _providerBaseUrl ||
            nextProviderId != _providerLimitId ||
            nextAppType != _providerLimitAppType);
    _providerBaseUrl = next;
    _providerLimitId = nextProviderId;
    _providerLimitAppType = nextAppType;
    if (changed) {
      _providerLimitRevision += 1;
      _activeProviderLimit = null;
      // The passive window bar belongs to whichever provider produced it. On a
      // switch it must not keep speaking for the new provider — a relay
      // provider's gate is protocol-based, so a stale vendor bar from the
      // previous provider would pass it and linger until the next event. Clear
      // it and let the new provider's first event repaint (web
      // setProviderBaseUrl clears currentLimitInfo/currentLimitBar the same way).
      _usageWindowLimit = null;
      _rateLimitBar = null;
      _usageBalance = null;
      _balanceBar = null;
      // An explicit switch means the user is looking at a different vendor —
      // drop any error backoff so the new bar fetches immediately (web
      // setProviderBaseUrl clears backoff the same way).
      _arkErrorAt = 0;
      _kimiErrorAt = 0;
      // The vendor bars too: they are per-host, and web setProviderBaseUrl
      // resets both slots here. Keeping them showed the previous Volcengine /
      // Moonshot account's quota under the new provider until its own fetch
      // landed (or forever, if that fetch failed).
      _arkQuota = null;
      _kimiQuota = null;
    }
    if (!_providerIdentityKnown || changed) refreshVendorQuotas();
    _providerIdentityKnown = true;
  }

  /// A provider-only switch (PATCH /api/sessions/:id with provider/model while
  /// staying on the same CLI): the server emits no cli_switched broadcast for
  /// that, so nothing else re-learns the provider baseUrl. Re-learn it here so
  /// the quota bars follow the switch immediately - the app mirror of the
  /// web's updateProviderBtn() -> setProviderBaseUrl() call right after
  /// saveSession (chat.js: "without this call the bar kept showing the OLD
  /// provider until the next loadSessionModel()").
  void applyProviderSwitch(SessionCliConfig config) {
    _providerSelection = config.providerSelection;
    _clearActualProviderRoute();
    if (_providerSelection == null) {
      _applyConfiguredProvider({
        'providerId': config.provider,
        'providerName': config.providerName,
        'model': config.effectiveModel ?? config.model,
      });
      _setProviderBaseUrl(config.providerBaseUrl ?? '');
    } else {
      _syncActualProviderBaseUrl();
    }
    final model = _providerSelection == null
        ? config.effectiveModel ?? config.model
        : null;
    if (model != null && model.isNotEmpty) {
      _statusText = 'Connected · $model';
    }
    notifyListeners();
  }

  /// ChatService has already run ProviderRouteGate before emitting these
  /// events. Auto policy events are only plans; only a physical attempt route
  /// event is allowed to establish the displayed actual provider.
  @visibleForTesting
  void applyProviderRoutingEvent(String type, Map<dynamic, dynamic> source) {
    if (type == 'provider_auto_route') {
      if (_autoRouteLine.settle(_messages, source)) notifyListeners();
      return;
    }
    if (type != 'provider_route_event') return;
    _applyActualProviderRoute(source);
    notifyListeners();
  }

  void _applyActualProviderRoute(Map<dynamic, dynamic> source) {
    final providerId = source['providerId']?.toString();
    final providerName = source['providerName']?.toString();
    final model = source['model']?.toString();
    if (providerId != null && providerId.isNotEmpty) {
      _activeProviderId = providerId;
      _activeProviderName = providerName == null || providerName.isEmpty
          ? providerId
          : providerName;
      _activeProviderModel = model == null || model.isEmpty ? null : model;
      _syncActualProviderBaseUrl();
    }
  }

  void _applyConfiguredProvider(Map<dynamic, dynamic> source) {
    final providerId = source['providerId']?.toString();
    final providerName = source['providerName']?.toString();
    final model = source['model']?.toString();
    _activeProviderId = providerId == null || providerId.isEmpty
        ? null
        : providerId;
    _activeProviderName = providerName == null || providerName.isEmpty
        ? _activeProviderId
        : providerName;
    _activeProviderModel = model == null || model.isEmpty ? null : model;
  }

  void _clearActualProviderRoute() {
    _activeProviderId = null;
    _activeProviderName = null;
    _activeProviderModel = null;
  }

  /// Provider summaries contain credential-free base URLs. Once the UI has
  /// loaded that catalog, an accepted physical route can re-gate quota bars to
  /// the actual provider instead of the configured Auto primary.
  void applyProviderCatalog(List<Map<String, dynamic>> catalog) {
    _providerCatalogBaseUrls
      ..clear()
      ..addEntries(
        catalog
            .map((provider) {
              final id = provider['id']?.toString() ?? '';
              final baseUrl = provider['baseUrl']?.toString() ?? '';
              return MapEntry(id, baseUrl);
            })
            .where((entry) => entry.key.isNotEmpty),
      );
    _providerCatalogAppTypes
      ..clear()
      ..addEntries(
        catalog
            .map(
              (provider) => MapEntry(
                provider['id']?.toString() ?? '',
                provider['appType']?.toString() ?? '',
              ),
            )
            .where((entry) => entry.key.isNotEmpty && entry.value.isNotEmpty),
      );
    _syncActualProviderBaseUrl();
    notifyListeners();
  }

  void _syncActualProviderBaseUrl() {
    final providerId = _activeProviderId;
    if (providerId == null) {
      if (_providerSelection != null) _setProviderBaseUrl('');
      return;
    }
    if (_providerCatalogBaseUrls.containsKey(providerId)) {
      _setProviderBaseUrl(_providerCatalogBaseUrls[providerId] ?? '');
    } else if (_providerSelection != null) {
      _setProviderBaseUrl('');
    }
  }

  /// An explicit CLI switch resets the per-CLI fetch backoffs: the account on
  /// screen changed, so its bars should refresh right away instead of waiting
  /// out an error backoff earned by the previous CLI.
  void _clearCliQuotaBackoff() {
    _claudeUsageErrorAt = 0;
    _qoderErrorAt = 0;
    _opencodeErrorAt = 0;
    _codexErrorAt = 0;
  }

  /// Learn the active provider baseUrl on connect (system_init carries no
  /// provider info), so the right vendor bar shows before any CLI switch.
  Future<void> _loadProviderBaseUrl() async {
    final sid = executionSessionName;
    if (sid.isEmpty) return;
    try {
      final baseUrl = await _quota.fetchProviderBaseUrl(sid);
      // A manual-route lookup may race with enabling Auto. Never let its
      // configured-primary URL overwrite the physical route's quota gate.
      if (sid == executionSessionName && _providerSelection == null) {
        _setProviderBaseUrl(baseUrl ?? '');
      }
    } catch (_) {
      // Non-fatal: the bar simply stays hidden until a switch provides a baseUrl.
    }
  }

  /// Fetch quota for every vendor the current provider baseUrl points at.
  /// Each fetcher is a no-op unless the baseUrl matches its vendor, so this is
  /// safe to call on any provider change.
  void refreshVendorQuotas() {
    final baseUrl = _providerBaseUrl;
    if (_providerLimitAppType.isNotEmpty && _providerLimitId.isNotEmpty) {
      unawaited(
        _fetchActiveProviderLimit(
          _providerLimitRevision,
          _providerLimitAppType,
          _providerLimitId,
        ),
      );
    }
    if (isArkBaseUrl(baseUrl)) _fetchArkQuota();
    if (isKimiBaseUrl(baseUrl)) _fetchKimiQuota();
  }

  /// Ark quota bar, visible only when the active provider baseUrl points at
  /// Volcano (volces.com). Tappable: install / auth / refetch (see
  /// [handleArkQuotaTap]); while the arkcli install runs it renders the
  /// server's 'installing' state.
  VendorQuotaView? get arkQuotaView {
    if (!isArkBaseUrl(_providerBaseUrl)) return null;
    return _vendorOrIdle(
      _arkQuota,
      'ark',
      loading: _arkLoading,
      state: _arkInstalling ? 'installing' : null,
    );
  }

  // No zhipu slot: its windows come from the active Provider balance query
  // (_fetchActiveProviderLimit), which polls the same glm-monitor surface the
  // removed /api/zhipu/quota route did — a dedicated slot only duplicated the
  // bar (web removed its slot for the same reason).

  /// Kimi quota bar, visible only when the provider baseUrl points at
  /// moonshot/kimi. Tappable: login (action 'login') or force refetch.
  VendorQuotaView? get kimiQuotaView {
    if (!isKimiBaseUrl(_providerBaseUrl)) return null;
    return _vendorOrIdle(_kimiQuota, 'kimi', loading: _kimiLoading);
  }

  /// Qoder CN credits bar, gated on the CLI (its provider baseUrl is
  /// qoder.com.cn and the session may route via a custom endpoint) — mirrors
  /// the web `currentCli === 'qoder'` guard. Rendered through its own tappable
  /// slot in [ChatRuntimeNoticePanel] (login window / force refresh), the same
  /// way the Claude bar is.
  VendorQuotaView? get qoderQuotaView {
    if (_cli != SessionCli.qoder) return null;
    return _vendorOrIdle(_qoderQuota, 'qoder', loading: _qoderLoading);
  }

  int _nowMs() => DateTime.now().millisecondsSinceEpoch;

  // One provider-balance query at a time per provider identity (the web's
  // providerLimitInFlight): this is fired by every provider change and is
  // click-reachable from the bar's ⟳, so without the guard a burst stacks
  // duplicate in-flight requests. Keyed on the identity rather than a bare
  // boolean: a switch landing while the previous provider's query is still open
  // must not be suppressed by it — that response belongs to the OLD provider and
  // the revision check below drops it, so suppressing the new query left the bar
  // blank until some unrelated event fired one (a bare flag did exactly that on
  // two provider changes in the same microtask, e.g. the CLI config arriving
  // immediately before the provider PATCH's own re-learn).
  String? _providerLimitInFlightKey;

  Future<void> _fetchActiveProviderLimit(
    int revision,
    String appType,
    String providerId,
  ) async {
    final inFlightKey = '$appType:$providerId';
    if (_providerLimitInFlightKey == inFlightKey) return;
    _providerLimitInFlightKey = inFlightKey;
    try {
      final data = await _quota.fetchProviderBalance(appType, providerId);
      if (revision != _providerLimitRevision ||
          appType != _providerLimitAppType ||
          providerId != _providerLimitId) {
        return;
      }
      // A failed query must NOT erase a good bar. The web's refreshProviderLimit
      // returns on failure without touching the bars, and the server answers a
      // transient upstream failure with its cached last-known-good bar for
      // exactly this reason; nulling it here (the old behavior) meant one 20s
      // timeout hid the chip until the user switched provider or CLI again.
      // Nothing is kept across an identity change: that path clears the field.
      if (data == null || data['ok'] != true) return;
      _activeProviderLimit = data;
      notifyListeners();
    } finally {
      if (_providerLimitInFlightKey == inFlightKey) {
        _providerLimitInFlightKey = null;
      }
    }
  }

  Future<void> _fetchArkQuota({bool force = false}) async {
    // Pinned to the baseUrl this query was issued for: a response that lands
    // after the provider moved on belongs to the previous plan/provider, and
    // writing it here used to repaint the old window under the new provider.
    final requestBaseUrl = _providerBaseUrl;
    if (_arkInFlightUrl == requestBaseUrl) return;
    if (!force &&
        _arkErrorAt != 0 &&
        _nowMs() - _arkErrorAt < _vendorQuotaBackoffMs) {
      return;
    }
    _arkInFlightUrl = requestBaseUrl;
    _arkLoading = true;
    notifyListeners();
    final data = await _quota.fetchArkQuota(requestBaseUrl);
    // Only this query's own bookkeeping: if it was superseded by a query for
    // another host, that one owns the loading flag and will clear it.
    if (_arkInFlightUrl == requestBaseUrl) {
      _arkInFlightUrl = null;
      _arkLoading = false;
    }
    if (requestBaseUrl != _providerBaseUrl) { notifyListeners(); return; }
    if (data == null) {
      _arkErrorAt = _nowMs();
    } else {
      _arkErrorAt = 0;
      _arkQuota = data;
      if (data['status'] == 'ok') _persistRuntimeCache();
    }
    notifyListeners();
  }

  Future<void> _fetchKimiQuota({bool force = false}) async {
    final requestBaseUrl = _providerBaseUrl;
    if (_kimiInFlightUrl == requestBaseUrl) return;
    if (!force &&
        _kimiErrorAt != 0 &&
        _nowMs() - _kimiErrorAt < _vendorQuotaBackoffMs) {
      return;
    }
    _kimiInFlightUrl = requestBaseUrl;
    _kimiLoading = true;
    notifyListeners();
    final data = await _quota.fetchKimiQuota(
      kimiHostFromBaseUrl(requestBaseUrl),
    );
    if (_kimiInFlightUrl == requestBaseUrl) {
      _kimiInFlightUrl = null;
      _kimiLoading = false;
    }
    if (requestBaseUrl != _providerBaseUrl) { notifyListeners(); return; }
    if (data == null) {
      _kimiErrorAt = _nowMs();
    } else {
      _kimiErrorAt = 0;
      _kimiQuota = data;
      if (data['status'] == 'ok') _persistRuntimeCache();
    }
    notifyListeners();
  }

  /// Fetch the OpenCode Go subscription usage (5h / weekly / monthly) from
  /// opencode.ai's Zen console via the backend's CDP route. No-op off the
  /// opencode CLI; skips while one is in flight or after a recent error
  /// (vendor backoff) unless [force]. Callers: cli-switch hooks + the bar's
  /// tap handler.
  Future<void> refreshOpenCodeQuota({bool force = false}) async {
    if (_cli != SessionCli.opencode) return;
    if (_opencodeInFlight) return;
    if (!force &&
        _opencodeErrorAt != 0 &&
        _nowMs() - _opencodeErrorAt < _vendorQuotaBackoffMs) {
      return;
    }
    _opencodeInFlight = true;
    _opencodeLoading = true;
    notifyListeners();
    final data = await _quota.fetchOpenCodeQuota();
    _opencodeInFlight = false;
    _opencodeLoading = false;
    if (data == null) {
      _opencodeErrorAt = _nowMs();
    } else {
      _opencodeErrorAt = 0;
      _opencodeQuota = data;
      if (data['status'] == 'ok') _persistRuntimeCache();
    }
    notifyListeners();
  }

  /// Fetch the Codex (ChatGPT) weekly subscription quota. No-op off the codex
  /// CLI; skips while one is in flight or after a recent error (vendor backoff)
  /// unless [force]. Callers: cli-switch hooks + the bar's tap handler.
  Future<void> refreshCodexQuota({bool force = false}) async {
    if (!_cli.isCodexFamily ||
        _activeProviderId != null ||
        _providerSelection != null) {
      return;
    }
    if (_codexInFlight) return;
    if (!force &&
        _codexErrorAt != 0 &&
        _nowMs() - _codexErrorAt < _vendorQuotaBackoffMs) {
      return;
    }
    _codexInFlight = true;
    _codexLoading = true;
    notifyListeners();
    final data = await _quota.fetchCodexQuota();
    _codexInFlight = false;
    _codexLoading = false;
    if (data == null) {
      _codexErrorAt = _nowMs();
    } else {
      _codexErrorAt = 0;
      _codexQuota = data;
      if (data['status'] == 'ok') _persistRuntimeCache();
    }
    notifyListeners();
  }

  /// Cache the server's idle bars once on connect so every unfetched quota bar
  /// shows the server's placeholder verbatim (the app holds no idle text).
  Future<void> _loadIdleBars() async {
    if (_idleBars != null) return;
    final data = await _quota.fetchIdleBars();
    if (data != null) {
      _idleBars = data;
      notifyListeners();
    }
  }

  /// Fetch the Claude subscription usage scrape. No-op off the claude CLI;
  /// skips while one is in flight, after a recent error (vendor backoff) or
  /// when the cached result is under 24h old (mirrors the web localStorage
  /// staleness) unless [force]. Callers: connect / cli-switch hooks and the
  /// bar's tap handler.
  Future<void> refreshClaudeUsage({bool force = false}) async {
    if (!_cli.isClaudeFamily) return;
    if (_claudeUsageFetching) return;
    if (!force) {
      final fetchedAt = (_claudeUsage?['fetchedAt'] as num?)?.toInt();
      if (fetchedAt != null && _nowMs() - fetchedAt < _claudeUsageFreshMs) {
        return;
      }
      if (_claudeUsageErrorAt != 0 &&
          _nowMs() - _claudeUsageErrorAt < _vendorQuotaBackoffMs) {
        return;
      }
    }
    _claudeUsageFetching = true;
    notifyListeners();
    final data = await _quota.fetchClaudeUsage();
    _claudeUsageFetching = false;
    if (data == null) {
      _claudeUsageErrorAt = _nowMs();
    } else {
      _claudeUsageErrorAt = 0;
      _claudeUsage = data;
      // Persist only a successful scrape (web `saveClaudeUsageToStorage` does
      // the same) so a later cold start can show weekly/monthly immediately.
      if (data['status'] == 'ok') _persistRuntimeCache();
    }
    notifyListeners();
  }

  /// Tap on the Claude bar: when the server render carries action 'login' (or
  /// the scrape status is needs_login / chrome_unavailable), POST the login
  /// route, hold a `login_pending` render, then force a fresh scrape 3s later —
  /// mirroring the web `claudeBarClick` + `requestQuotaLogin` pair. Any other
  /// tap is just a force-scrape.
  Future<void> handleClaudeQuotaTap() async {
    final view = claudeLimitView;
    final status = _claudeUsage?['status']?.toString();
    final needsLogin =
        view?.action == 'login' ||
        view?.action == 'login_pending' ||
        status == 'needs_login' ||
        status == 'chrome_unavailable';
    if (needsLogin) {
      _claudeLoginPending = true;
      notifyListeners();
      await _quota.openClaudeLogin();
      // The pending render stays up until the delayed scrape clears it, the
      // same way the web keeps claudeLoginPending until its reFetch callback.
      Future.delayed(const Duration(seconds: 3), () {
        _claudeLoginPending = false;
        refreshClaudeUsage(force: true);
      });
      return;
    }
    await refreshClaudeUsage(force: true);
  }

  /// Fetch the Qoder CN credits bar. No-op off the qoder CLI; skips while one
  /// is in flight or after a recent error (vendor backoff) unless [force].
  /// Callers: connect / cli-switch hooks and the bar's tap handler.
  Future<void> refreshQoderQuota({bool force = false}) async {
    if (_cli != SessionCli.qoder) return;
    if (_qoderInFlight) return;
    if (!force &&
        _qoderErrorAt != 0 &&
        _nowMs() - _qoderErrorAt < _vendorQuotaBackoffMs) {
      return;
    }
    _qoderInFlight = true;
    _qoderLoading = true;
    notifyListeners();
    final data = await _quota.fetchQoderQuota();
    _qoderInFlight = false;
    _qoderLoading = false;
    if (data == null) {
      _qoderErrorAt = _nowMs();
    } else {
      _qoderErrorAt = 0;
      _qoderQuota = data;
      if (data['status'] == 'ok') _persistRuntimeCache();
    }
    notifyListeners();
  }

  /// Tap on the Qoder bar: action 'login' (or needs_login /
  /// chrome_unavailable status) dispatches the login POST and re-fetches 3s
  /// later; any other tap force-refreshes. Mirrors the web `quotaBarClick`.
  Future<void> handleQoderQuotaTap() async {
    final view = qoderQuotaView;
    final status = _qoderQuota?['status']?.toString();
    final needsLogin =
        view?.action == 'login' ||
        status == 'needs_login' ||
        status == 'chrome_unavailable';
    if (needsLogin) {
      await _quota.openQoderLogin();
      Future.delayed(
        const Duration(seconds: 3),
        () => refreshQoderQuota(force: true),
      );
      return;
    }
    await refreshQoderQuota(force: true);
  }

  /// Tap on the OpenCode Go bar: action 'login' (or needs_login /
  /// chrome_unavailable status) dispatches the login POST and re-fetches 3s
  /// later; any other tap force-refreshes. Mirrors the web `quotaBarClick`.
  Future<void> handleOpenCodeQuotaTap() async {
    final view = opencodeQuotaView;
    final status = _opencodeQuota?['status']?.toString();
    final needsLogin =
        view?.action == 'login' ||
        status == 'needs_login' ||
        status == 'chrome_unavailable';
    if (needsLogin) {
      await _quota.openOpenCodeLogin();
      Future.delayed(
        const Duration(seconds: 3),
        () => refreshOpenCodeQuota(force: true),
      );
      return;
    }
    await refreshOpenCodeQuota(force: true);
  }

  /// Tap on the Codex bar: force a fresh fetch (the codex route has no login
  /// window — it reads chatgpt.com/backend-api with the browser's session).
  Future<void> handleCodexQuotaTap() async {
    await refreshCodexQuota(force: true);
  }

  /// Tap on the Kimi bar: action 'login' dispatches the kimi login POST and
  /// re-fetches 3s later; any other tap force-refreshes.
  Future<void> handleKimiQuotaTap() async {
    final view = kimiQuotaView;
    if (view?.action == 'login') {
      await _quota.openKimiLogin();
      Future.delayed(
        const Duration(seconds: 3),
        () => _fetchKimiQuota(force: true),
      );
      return;
    }
    await _fetchKimiQuota(force: true);
  }

  /// Tap on the Ark bar — three destinations, mirroring the web `arkClick`:
  /// needs_install kicks off the server-side arkcli install (with its own
  /// 'installing' render and a failure fallback bar), needs_auth opens the auth
  /// window then re-fetches after 4s, anything else force-refreshes.
  Future<void> handleArkQuotaTap() async {
    final status = _arkQuota?['status']?.toString();
    if (status == 'needs_install' && !_arkInstalling) {
      _arkInstalling = true;
      notifyListeners();
      final res = await _quota.installArk();
      _arkInstalling = false;
      final body = res?['body'];
      if (res != null &&
          res['httpOk'] == true &&
          body is Map &&
          body['status'] == 'ok') {
        await _fetchArkQuota(force: true);
      } else {
        // Same fallback bar the web paints when the install route fails (the
        // one client-held failure string the web arkClick carries).
        final err = body is Map ? body['error']?.toString() : null;
        _arkQuota = {
          'status': 'unavailable',
          'error': err?.isNotEmpty == true
              ? err
              : '自动安装失败，请手动运行 npm install -g @volcengine/ark-cli',
        };
        _arkErrorAt = 0;
        notifyListeners();
      }
      return;
    }
    if (status == 'needs_auth') {
      await _quota.openArkLogin();
      Future.delayed(
        const Duration(seconds: 4),
        () => _fetchArkQuota(force: true),
      );
      return;
    }
    await _fetchArkQuota(force: true);
  }

  /// Remove a message from the local transcript by its server-side history id.
  /// Idempotent — used both by the initiating UI (immediate feedback) and the
  /// chat_msg_deleted WS broadcast (cross-client sync).
  void removeMessageById(String id) {
    _historyGeneration++;
    final before = _messages.length;
    _messages.removeWhere((m) => m.id == id);
    if (_messages.length != before) notifyListeners();
  }

  void _onMessageStart(Map<String, dynamic>? evt) {
    // One request's own prompt accounting: the only context figure that needs
    // no heuristic, so it supersedes whatever the last turn total implied.
    final usage = (evt?['message'] as Map?)?['usage'];
    _requestUsage = null;
    if (usage is Map) {
      _requestUsage = MessageUsage.fromJson(Map<String, dynamic>.from(usage));
    }
    _folder.messageStart();
  }

  void _onResult(Map<String, dynamic> msg) {
    // Attach token usage + durationMs to the current assistant message BEFORE
    // finishing streaming (because _finishStreaming() clears currentMsg).
    _folder.attachResultUsage(msg);
    final resultTarget = _folder.currentMsg;
    if (resultTarget != null) {
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
            resultTarget.usage ??= MessageUsage();
            resultTarget.usage!.savedMainTokens = saved;
          }
        }
      }

      // Attach the parsed role split for the detail sheet. Same ordering
      // contract as above: the live event usually set it already, but the
      // result-first race resolves through the cached breakdown.
      final breakdown = _lastRoleBreakdown;
      if (breakdown != null && !breakdown.isEmpty) {
        resultTarget.usage ??= MessageUsage();
        resultTarget.usage!.roleBreakdown = breakdown;
      }
    }

    _finishStreaming();
    if (msg['is_error'] != true) _apiErrorPolicy = null;

    // `total_cost_usd` is read and dropped on purpose — see the usage-bar state
    // above. What stays is what this turn actually measured.
    if (msg['usage'] is Map) {
      _turnUsage = MessageUsage.fromJson(
        Map<String, dynamic>.from(msg['usage'] as Map),
      );
      _sessionInputTokens += _turnUsage!.inputTokens;
      _sessionOutputTokens += _turnUsage!.outputTokens;
    }
    _contextTrace = msg['contextTrace'] is Map
        ? Map<String, dynamic>.from(msg['contextTrace'] as Map)
        : null;
    final models = msg['modelUsage'];
    if (models is Map) {
      for (final entry in models.values) {
        final window = entry is Map ? (entry['contextWindow'] as num?) : null;
        if (window != null && window > 0) _contextWindow = window.toInt();
      }
    }
    final ms = (msg['durationMs'] as num?)?.toInt();
    final turns = (msg['num_turns'] as num?)?.toInt();
    if (ms != null) _turnDurationText = _fmtDuration(ms);
    if (turns != null) _turnCount = turns;

    // Completion notification is NOT fired here: a `result` only means the
    // stream stopped, which during a multi-step agent run happens between
    // turns too. The server's aux-AI debounces the pause and decides
    // done-vs-waiting, then sends a `notify` event — that is the single judge.
    //
    // 自动提交仍然挂在这个帧上（web 的 `handleResult` → `autoCommitIfNeeded`）：
    // 它要的是「这一轮跑完了」，与上面那条「跑完 ≠ 做完」的判定互不干扰。
    _turnEndTick++;
    notifyListeners();
  }

  /// Send a local notification if this session is not currently visible.
  void _maybeNotify(String title, String detail) {
    final settings = SettingsService.current;
    if (settings?.notificationsEnabled == false) return;
    // 会话级「任务提醒」开关（Web 页头 `#notify-btn` → public/pwa.js
    // getTaskNotifyEnabled）：关掉只静音这一个会话，全局开关不动。
    if (settings?.taskNotifyEnabled(sessionName) == false) return;
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
    _admissionProgressText = null;
    _admissionProgressClientMsgId = null;
    _folder.finishStreaming();
    // Turn end: settle turn-scoped background rows (heartbeat + any
    // still-unconfirmed spinning row). Confirmed background tasks keep
    // spinning — they outlive the turn by design (web parity).
    if (_backgroundTasks.hasSpinning) {
      _backgroundTasks.settleAtTurnEnd(
        now: DateTime.now().millisecondsSinceEpoch,
      );
    }
  }

  // ── Background tasks (mobile danmaku) ───────────────────────────────────────

  /// Rows for the floating background-task panel, newest first. Finished rows
  /// beyond the auto-hide window drop out automatically.
  List<BackgroundTaskRow> backgroundTaskRows() =>
      _backgroundTasks.rows(now: DateTime.now().millisecondsSinceEpoch);

  bool get hasBackgroundTaskRows => _backgroundTasks.rows().isNotEmpty;

  /// User dismissed a row via its ✕ — stays hidden even if refreshed later.
  void dismissBackgroundTask(String key) {
    _backgroundTasks.dismiss(key);
    notifyListeners();
  }

  /// Lazily arm the stale-sweep timer while anything spins; it parks itself
  /// again once the board goes quiet (web's 180s stale watchdog).
  void _armBgSweep() {
    _bgSweepTimer ??= Timer.periodic(const Duration(seconds: 15), (_) {
      if (_backgroundTasks.sweep(now: DateTime.now().millisecondsSinceEpoch)) {
        notifyListeners();
      }
      if (!_backgroundTasks.hasSpinning) {
        _bgSweepTimer?.cancel();
        _bgSweepTimer = null;
      }
    });
  }

  // ── Dispatch activity (polled projection; no WS push in the contract) ─────

  /// Pull the authoritative dispatch snapshot. Callers: connect/reconnect,
  /// session_queue events (queue advanced → dispatches move), turn results.
  /// Failures keep the last snapshot — the next trigger re-polls, so a flaky
  /// network can't blank the panel, and a session that truly emptied just
  /// stops being re-listed by the server.
  Future<void> refreshDispatchQueue() async {
    if (_dispatchQueueInFlight) return;
    _dispatchQueueInFlight = true;
    final target = executionSessionName;
    try {
      final rows = await SessionService(
        settings: settings,
      ).fetchDispatchQueue(target);
      if (target != executionSessionName) return;
      final next = mergeDispatchQueue(rows);
      _dispatchQueueFailureCount = 0;
      _dispatchQueueRetryTimer?.cancel();
      _dispatchQueueRetryTimer = null;
      _armDispatchQueueTimer(next);
      if (_listEqualsById(_dispatchQueue, next)) return;
      _dispatchQueue = next;
      notifyListeners();
    } catch (_) {
      // Transport error: keep the last snapshot, keep the timer armed while
      // live rows exist so it retries on the next tick. An initially empty
      // snapshot gets three bounded retries; otherwise there would be neither
      // a visible refresh button nor a timer to recover after a cold-start blip.
      _armDispatchQueueTimer(_dispatchQueue);
      _dispatchQueueFailureCount += 1;
      _armDispatchQueueRetry();
    } finally {
      _dispatchQueueInFlight = false;
      if (target != executionSessionName) unawaited(refreshDispatchQueue());
    }
  }

  /// Poll while live entries exist (the server has no push for dispatch state);
  /// terminal-only history must not keep a timer alive forever. The tick only
  /// refreshes sessions the user is actually looking at — background providers
  /// ride the event triggers instead of polling forever.
  void _armDispatchQueueTimer(List<DispatchQueueEntry> next) {
    if (!next.any((entry) => !entry.terminal)) {
      _dispatchQueueTimer?.cancel();
      _dispatchQueueTimer = null;
      return;
    }
    _dispatchQueueTimer ??= Timer.periodic(const Duration(seconds: 10), (_) {
      if (isActive) refreshDispatchQueue();
    });
  }

  void _armDispatchQueueRetry() {
    if (_dispatchQueueTimer != null ||
        _dispatchQueueRetryTimer != null ||
        _dispatchQueueFailureCount > 3) {
      return;
    }
    final delaySeconds = switch (_dispatchQueueFailureCount) {
      1 => 2,
      2 => 5,
      _ => 10,
    };
    _dispatchQueueRetryTimer = Timer(Duration(seconds: delaySeconds), () {
      _dispatchQueueRetryTimer = null;
      refreshDispatchQueue();
    });
  }

  bool _listEqualsById(List<DispatchQueueEntry> a, List<DispatchQueueEntry> b) {
    if (a.length != b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (a[i].operationId != b[i].operationId ||
          a[i].queueState != b[i].queueState ||
          a[i].queuePosition != b[i].queuePosition ||
          a[i].queueLength != b[i].queueLength ||
          a[i].status != b[i].status ||
          a[i].terminal != b[i].terminal ||
          a[i].relation != b[i].relation ||
          a[i].ownerSessionId != b[i].ownerSessionId ||
          a[i].targetSessionId != b[i].targetSessionId ||
          a[i].executionSessionId != b[i].executionSessionId ||
          a[i].mode != b[i].mode) {
        return false;
      }
    }
    return true;
  }

  // 历史层（chat_provider_history.dart 的 ChatHistoryLayer）转发通知用的口子。
  // 扩展体不算「ChangeNotifier 子类的实例成员」，在那儿直接喊 notifyListeners()
  // 会被 analyzer 判成 invalid_use_of_protected_member。
  void _notifyHistoryChanged() => notifyListeners();
  // 未读 / 钉底状态。读写它的行为在 chat_provider_history.dart 的 ChatHistoryLayer
  // 里（扩展不能声明实例字段，所以状态必须留在类体）。
  /// Number of NEW messages received while the user was scrolled up reading
  /// history (drives the "↓ N new" pill). Reset when the user jumps to bottom.
  int _unreadCount = 0;
  int get unreadCount => _unreadCount;
  bool _userPinnedAway = false;
  bool get userPinnedAway => _userPinnedAway;

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

  /// 返回本次发送用的 clientMsgId（送不出去时是 null，调用方不能当成已发送）。
  /// [clientMsgId] 用来把这条消息钉在一个调用方选定的幂等键上 —— 强制同步的
  /// 重试要走同一条（服务端按它去重）。
  String? sendMessage(
    String text, {
    bool goal = false,
    Map<String, dynamic>? goalLimits,
    String? clientMsgId,
  }) {
    final message = text.trim();
    if (message.isEmpty) return null;
    final sentMsgId = _service.send(
      message,
      goal: goal,
      goalLimits: goalLimits,
      clientMsgId: clientMsgId,
    );
    if (sentMsgId == null) {
      // Half-open / dead socket — don't pretend the message was sent.
      _addSystemMsg(t('connectionLostRetry'));
      notifyListeners();
      return null;
    }
    // 不立刻把气泡画进对话区：先暂存，等服务端 session_queue 裁决这条是立即执行
    // 还是进 FIFO。进队列的只在队列面板出现，不在这里占位（对齐 web
    // stagedUserBubbles）。_commitStaged 在收到裁决（或兜底超时）时才真正加气泡。
    _stagedTracker.stage(sentMsgId, message);
    _setPendingUserInput(null);
    _apiErrorPolicy = null;
    // User just sent a message -> resume auto-follow at the bottom, clear any
    // unread pill (mirrors the web client's forceScrollToBottom on send).
    _userPinnedAway = false;
    _unreadCount = 0;
    notifyListeners();
    return sentMsgId;
  }

  // ── Staged user sends: 等服务端 FIFO 裁决的暂存消息 ──────────────────────────
  // 生命周期（暂存、兜底定时器、裁决应用）在 [StagedSendTracker]；这里只剩
  // 「把被 commit 的暂存画成气泡」这唯一一个 UI 落点。

  /// StagedSendTracker.onCommit 的落点：把一条暂存消息画成对话区用户气泡。
  void _commitStagedBubble(StagedUserSend staged) {
    // FIFO 裁决 / 4s 兜底可能晚于 message_start（queued:false 帧丢失、断连
    // 重连后靠兜底补画），此时流式助手气泡已在列表尾——插到它之前，保证
    // 用户问题永远画在它的回答上面。
    _messages.insert(
      userBubbleInsertIndex(_messages, _folder.currentMsg),
      ChatMessage(
        role: MessageRole.user,
        content: staged.text,
        clientMsgId: staged.clientMsgId,
      ),
    );
    notifyListeners();
  }

  /// Explicit scheduler control. The APP never mutates or advances the queue
  /// itself; even after a successful POST it only applies the returned server
  /// schedule (and the following WS event will reconcile it again).
  Future<bool> queueAction(
    String action, {
    String? entryId,
    int? toIndex,
  }) async {
    // Causality anchor: any `session_queue` WS event that lands while this
    // request is in flight is at least as authoritative as the action's own
    // effects (the server broadcasts them BEFORE writing the HTTP response).
    // Applying the HTTP schedule after such an event could resurrect a stale
    // FIFO — the insert_queued race: the pre-tick response schedule still
    // listed the just-claimed entry as queued, and overwrote the WS snapshot
    // that had already removed it. The web client avoids this by never
    // applying the HTTP schedule; we keep it as the offline/no-WS fallback,
    // but only when no WS event has superseded it. Skipping is always safe:
    // the skipped state is delivered by the (in-flight or later) WS stream.
    final wsSeqAtRequest = _sessionQueueEventSeq;
    final result = await _service.queueAction(
      action,
      entryId: entryId,
      toIndex: toIndex,
    );
    final schedule = result['schedule'];
    if (schedule is Map) {
      final next = applyActionSchedule(
        _sessionQueue,
        Map<String, dynamic>.from(schedule),
        wsSeqAtRequest,
        _sessionQueueEventSeq,
      );
      if (next != null) {
        _sessionQueue = next;
        notifyListeners();
      }
    }
    return action != 'insert_queued' || result['started'] == true;
  }

  /// Cancel the in-flight response. Matches the web client's cancelStreaming():
  /// sends the cancel signal (or queues it for reconnect) AND finalizes the
  /// streaming bubble locally + shows a "已取消" system message, so the user
  /// gets instant feedback instead of waiting for a server `result` that may
  /// never arrive if the socket died mid-stream.
  void cancel() {
    _service.cancel();
    _attachKnownUsageToInterruptedTail();
    _finishStreaming();
    _addSystemMsg(t('cancelled'));
    notifyListeners();
  }

  /// Error/cancel paths do not always receive a provider `result` frame. The
  /// request's message_start usage is still measured data for this exact turn,
  /// so keep it on the interrupted bubble instead of making token stats vanish.
  /// A later result frame may replace it with the fuller input/output usage.
  void _attachKnownUsageToInterruptedTail() {
    final target = _folder.currentMsg;
    final usage = _requestUsage;
    if (target != null &&
        (target.usage == null || target.usage!.isEmpty) &&
        usage != null &&
        !usage.isEmpty) {
      target.usage = usage;
    }
  }

  void setHistoryArchive(bool value) {
    if (historyArchive == value) return;
    historyArchive = value;
    _historyGeneration++;
    _service.historyArchive = value;
    _historyApplied = false;
    _replaceHistoryOnReconnect = true;
    final execution = executionSessionName;
    _service.dispose();
    _initService(executionSessionName: execution);
    notifyListeners();
  }

  /// Native context rotation is separate from clearing the visible messages.
  void rotateNativeContext() {
    _service.rotateNativeContext();
  }

  /// Keep the current view and running work until the server acknowledges.
  void clearHistory({int keep = 0}) {
    if (historyArchive) return;
    if (!_service.clearHistory(keep: keep)) {
      _addSystemMsg(t('clearChatHistoryOffline'));
      notifyListeners();
    }
  }

  /// 一条只在本机存在的系统行（斜杠命令的回显）。
  ///
  /// 它不进 transcript、不发给模型，也就不会被服务端在下一次 chat_history
  /// 里重放 —— 和 web 组合器里 `addSystemMessage` 的角色一样：命令的反馈
  /// 属于「这一次操作」，不属于会话内容。
  void addLocalSystemMessage(String text) {
    final line = text.trim();
    if (line.isEmpty) return;
    _addSystemMsg(line);
  }

  /// 待答卡的「已解决 / 忽略」：手动了结这条提问，不发回答也不继续原任务
  /// （web 的 `#pending-user-input-dismiss`，同一个接口）。
  ///
  /// 结果原样交回调用方：能不能了结由服务端说话（`code` 是会话还在跑、提问已
  /// 变化还是还有外部任务在等），文案归界面管。成功则这里立刻收起卡片 ——
  /// 服务端随后广播的 user_input_resolved 才是权威，这一步只是让按下的那一下
  /// 有即时反馈。
  Future<Map<String, dynamic>> dismissPendingUserInput() async {
    final pending = _pendingUserInput;
    if (pending == null) {
      return const {'ok': false, 'code': 'no_pending_request'};
    }
    final result = await SessionService(
      settings: settings,
    ).dismissUserInput(executionSessionName, pending.requestId);
    if (result['ok'] == true) {
      _setPendingUserInput(null);
      notifyListeners();
    }
    return result;
  }

  /// 安全弹窗提交：值直存本地保险箱，成功后只发「已保存」确认文案（带
  /// userInputRequestId，由 ChatService 自动附加）——密钥明文不进入对话、
  /// 不经过任何 LLM API。保存失败时卡片保留，报一条系统消息。
  Future<void> submitPendingSecret(String value) async {
    final pending = _pendingUserInput;
    if (pending == null || !pending.isSecret) return;
    final trimmed = value.trim();
    if (trimmed.isEmpty) return;
    Map<String, dynamic> result;
    try {
      result = await SessionService(settings: settings).saveSecret(
        pending.secretName,
        trimmed,
        sessionId: executionSessionName,
      );
    } catch (error) {
      _addSystemMsg(
        t('pendingSecretSaveFailed', {
          'name': pending.secretName,
          'error': '$error',
        }),
      );
      notifyListeners();
      return;
    }
    if (result['ok'] != true) {
      _addSystemMsg(
        t('pendingSecretSaveFailed', {
          'name': pending.secretName,
          'error': (result['error'] ?? 'unknown').toString(),
        }),
      );
      notifyListeners();
      return;
    }
    sendMessage('（敏感信息 ${pending.secretName} 已通过安全弹窗填写并保存到本地保险箱，值不会出现在对话里）');
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
      _folder.resetTail();
      _seedUsageFromHistory();
      _historyApplied = false;
      _stagedTracker.clear();
      notifyListeners();
    } else {
      // Seamless resume: stop feeding a stale streaming bubble, then let the
      // next chat_history replace the transcript in place — no blank flash.
      _finishStreaming();
      _historyApplied = false;
      _replaceHistoryOnReconnect = true;
    }
    // The pending card belongs to the torn-down socket's state; the fresh
    // connection's connect-time replay re-delivers it if still open.
    _setPendingUserInput(null);
    final execution = executionSessionName;
    _service.dispose();
    _initService(executionSessionName: execution);
  }

  void changeCwd(String newCwd) {
    _cwd = newCwd;
    sessionCwd = newCwd;
    _reconnect(hardReset: true);
  }

  @override
  void dispose() {
    _usageExpiryTimer?.cancel();
    _bgSweepTimer?.cancel();
    _dispatchQueueTimer?.cancel();
    _dispatchQueueRetryTimer?.cancel();
    _stagedTracker.clear();
    _eventSub?.cancel();
    _service.dispose();
    super.dispose();
  }
}
