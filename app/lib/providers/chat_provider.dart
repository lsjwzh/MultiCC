import 'dart:async';
import 'dart:convert' show jsonDecode, jsonEncode;
import 'package:flutter/widgets.dart';

import '../i18n.dart';
import '../models/background_task_board.dart';
import '../models/chat_runtime_state.dart';
import '../models/dispatch_queue.dart';
import '../models/message.dart';
import '../models/role_tokens.dart';
import '../models/usage_readout.dart';
import '../models/vendor_quota.dart';
import '../services/chat_service.dart';
import '../services/notification_service.dart';
import '../services/quota_service.dart';
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

  final rawEntry = payload['entryId']?.toString();
  final entryId = (rawEntry != null && rawEntry.isNotEmpty) ? rawEntry : null;

  switch (event) {
    case 'queued':
      // 重放幂等：这个 entryId 已绑过一条暂存（同一事件重复到达 / WS 重放），
      // 不再绑到下一条未绑定的暂存上，避免串条。
      if (entryId != null && byEntryId(entryId) != null) {
        return StagedVerdict.keep;
      }
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

// ── 非 Claude CLI 的 part_delta 边车（web chat-event-controller.js handlePartDelta）──
//
// codex/opencode 没有 Anthropic 式的 content_block_* 流，正文/推理/工具参数都以
// part_delta 增量到达，权威快照则由 `assistant` 帧事后覆盖。三个纯函数只做增量
// 应用，收敛交给 `_onAssistantSnapshot` 的权威覆盖 —— 语义与 web 相同，可脱离
// socket 单测。

/// 找到消息里指定 id 的工具卡（sidecar Thinking 卡也走它）。
@visibleForTesting
ToolCall? toolCallById(ChatMessage msg, String id) {
  for (final tc in msg.toolCalls) {
    if (tc.id == id) return tc;
  }
  return null;
}

/// 应用一帧 reasoning 增量：落到会话唯一的 Thinking 卡（id =
/// `sidecar-reasoning-<sessionId>`，与 web 同键），文本追加进 `{text:…}`。
/// 无 startedAt —— 推理没有真实的工具计时，不伪造时长也不进轨迹条。
/// 返回消息是否变化（调用方据此 notifyListeners）。
@visibleForTesting
bool applyReasoningDelta(ChatMessage msg, String sessionId, String text) {
  if (text.isEmpty) return false;
  final id = 'sidecar-reasoning-$sessionId';
  final existing = toolCallById(msg, id);
  if (existing == null) {
    msg.toolCalls.add(ToolCall(
      id: id,
      name: 'Thinking',
      inputJson: jsonEncode({'text': text}),
    ));
    return true;
  }
  var buffer = text;
  final prev = existing.parsedInput?['text'];
  // 只有当已积累内容确实来自本卡（{text:…} 键齐全）才在其后追加，防畸形 JSON 丢字。
  if (prev is String) {
    buffer = prev + text;
  }
  existing.inputJson = jsonEncode({'text': buffer});
  return true;
}

/// 从卡片当前 inputJson 还原原始参数流缓冲：wrapper 形态
/// `{"arguments":"…"}` 取回内串；已能 parse 的形态本身即原始串。
String _rawToolArgsBuffer(ToolCall tc) {
  final parsed = tc.parsedInput;
  if (parsed != null &&
      parsed.length == 1 &&
      parsed['arguments'] is String) {
    return parsed['arguments'] as String;
  }
  return tc.inputJson;
}

/// 与 web 相同的规范化：能整体 parse 就用规范化 JSON；否则包成
/// `{"arguments": <raw>}`，保证 inputJson 始终是合法 JSON 可被 pretty 渲染。
String _normalizeToolArgs(String raw) {
  try {
    final decoded = jsonDecode(raw);
    return jsonEncode(decoded);
  } catch (_) {
    return jsonEncode({'arguments': raw});
  }
}

/// 应用一帧工具参数增量：按 toolId 找卡追加参数片段；卡片不存在则创建
/// （此刻打真实 startedAt —— 工具参数开始流出的时间就是工具开始时间，
/// 与 web 边车创建时戳一致）。返回消息是否变化。
@visibleForTesting
bool applyToolArgsDelta(
  ChatMessage msg,
  String toolId,
  String toolName,
  String argsFragment, {
  int now = 0,
}) {
  if (toolId.isEmpty || argsFragment.isEmpty) return false;
  final existing = toolCallById(msg, toolId);
  if (existing != null) {
    final raw = _rawToolArgsBuffer(existing) + argsFragment;
    existing.inputJson = _normalizeToolArgs(raw);
    return true;
  }
  msg.toolCalls.add(ToolCall(
    id: toolId,
    name: toolName.isNotEmpty ? toolName : 'Tool',
    inputJson: _normalizeToolArgs(argsFragment),
    startedAt: now,
  ));
  return true;
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
    if (_cli != SessionCli.claude) return null;
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
    final limit = _usageWindowLimit;
    if (limit == null) return null;
    if (!providerMatchesCli(limit.provider, _cli.name, _providerBaseUrl)) {
      return null;
    }
    if (limit.provider == 'claude' &&
        _cli == SessionCli.claude &&
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
    if (_cli != SessionCli.codex) return null;
    final v = vendorViewFromBar(_codexQuota != null ? _barOf(_codexQuota!) : null);
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

  QuotaService? _quotaService;
  QuotaService get _quota => _quotaService ??= QuotaService(settings: settings);

  Map<String, dynamic>? _arkQuota;
  Map<String, dynamic>? _zhipuQuota;
  Map<String, dynamic>? _kimiQuota;
  Map<String, dynamic>? _qoderQuota;
  bool _arkLoading = false;
  bool _arkInstalling = false;
  bool _zhipuLoading = false;
  bool _kimiLoading = false;
  bool _qoderLoading = false;
  bool _arkInFlight = false;
  bool _zhipuInFlight = false;
  bool _kimiInFlight = false;
  bool _qoderInFlight = false;
  int _arkErrorAt = 0;
  int _zhipuErrorAt = 0;
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

  ChatMessage? _currentMsg;
  final Map<int, ToolCall> _activeTools = {};
  int _reconnectAttempt = 0;

  /// 已发送、等服务端 FIFO 裁决的用户消息（对齐 web stagedUserBubbles：进队列的
  /// 不在对话区占位，started 才回填气泡）。pending 为空 = 没有占位暂存。
  late final StagedSendTracker _stagedTracker =
      StagedSendTracker(onCommit: _commitStagedBubble);
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

  /// Parsed view of the same event — feeds the usage detail sheet (main /
  /// sub / per-provider split) instead of re-reading the raw map in widgets.
  RoleTokenBreakdown? _lastRoleBreakdown;

  /// The most recent assistant message, kept alive across _finishStreaming —
  /// a role_token_stats arriving just after `result` (common ordering) still
  /// targets this turn's bubble instead of being dropped on the floor.
  ChatMessage? _lastAssistantMsg;

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
      // Restored unconditionally (the web localStorage limit bar has no
      // staleness filter either): a past 5h reset still leaves the weekly
      // windows on the bar, and paint-time {cd} tokens clamp themselves.
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
  Map<String, void Function(Map<String, dynamic>)> get _vendorQuotaCacheSlots => {
    'arkQuota': (v) => _arkQuota = v,
    'zhipuQuota': (v) => _zhipuQuota = v,
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
      'zhipuQuota' => _zhipuQuota,
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
      // Already past the reset: just re-render (the {cd} tokens clamp), the way
      // the web expiry timer does. The limit is NOT cleared — its bar still
      // shows the windows that have not reset (e.g. weekly).
      notifyListeners();
      return;
    }
    _usageExpiryTimer = Timer(
      Duration(milliseconds: delayMs.clamp(1, 2147000000).toInt()),
      () {
        // Mirrors the web scheduleExpiry: re-render at the 5h reset so a stale
        // countdown refreshes; the bar itself is not cleared (weekly windows
        // have not reset).
        notifyListeners();
      },
    );
  }

  void setDisplayName(String value, {String? dirName}) {
    if (displayName == value &&
        (dirName == null || this.dirName == dirName)) {
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
        final msg = evt.payload as Map<String, dynamic>;
        final sid = (msg['session_id'] ?? msg['session'])?.toString();
        if (sid != null && sid.isNotEmpty) _sessionId = sid;
        if (msg['cwd'] != null) _cwd = msg['cwd'].toString();
        if (msg['cli'] != null) {
          _cli = parseCli(msg['cli']?.toString());
        }
        refreshClaudeUsage();
        refreshQoderQuota();
        refreshOpenCodeQuota();
        refreshCodexQuota();
        _loadProviderBaseUrl();
        _loadIdleBars();

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
        if (next != _cli) _clearCliQuotaBackoff();
        _cli = next;
        refreshClaudeUsage();
        refreshQoderQuota();
        // Parity with system_init / applyCliConfig / the web setCli: switching
        // CLI switches the account whose quota is on screen, so fetch the one
        // bar that just became relevant (no-op off its CLI; in-flight guard
        // dedupes the applyCliConfig that often precedes this broadcast).
        refreshOpenCodeQuota();
        refreshCodexQuota();
        _setProviderBaseUrl(msg['providerBaseUrl']?.toString() ?? '');
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
        _onMessageStart(evt.payload as Map<String, dynamic>?);
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

      case 'user':
        // tool_result frames (the paired completion of each tool call).
        _onUserToolResult(evt.payload as Map<String, dynamic>);
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
          // server provides it; fall back to the coarse notify state.
          final cls = (p['classifyState'] ?? '').toString().toUpperCase();
          String outcome;
          switch (cls) {
            case 'D':
              outcome = t('classifySucceeded');
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
                  : t('classifySucceeded');
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
          if (event == 'queued') {
            final position = p['queuePosition'];
            _statusText = position == null ? '消息已持久排队' : '消息已排队（第 $position 位）';
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
          final breakdown =
              RoleTokenBreakdown.fromEvent(evt.payload as Map<String, dynamic>);
          if (breakdown != null) {
            _lastRoleBreakdown = breakdown;
            // Attach live so the detail chip appears during streaming; a
            // post-result arrival falls back to the kept-alive last bubble.
            final target = _currentMsg ?? _lastAssistantMsg;
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
    refreshClaudeUsage();
    refreshQoderQuota();
    refreshOpenCodeQuota();
    refreshCodexQuota();
    final model = config.effectiveModel ?? config.model;
    _statusText = model != null && model.isNotEmpty
        ? 'Connected · $model'
        : 'Connected · ${config.cli.name}';
    _setProviderBaseUrl(config.providerBaseUrl ?? '');
    notifyListeners();
  }

  /// Update the active provider baseUrl and, when it changed, immediately pull
  /// fresh quota for whichever vendor it points at (mirrors the web
  /// setProviderBaseUrl refresh-on-change behavior).
  void _setProviderBaseUrl(String baseUrl) {
    final next = baseUrl.trim();
    final changed = next != _providerBaseUrl;
    _providerBaseUrl = next;
    if (changed) {
      // An explicit switch means the user is looking at a different vendor —
      // drop any error backoff so the new bar fetches immediately (web
      // setProviderBaseUrl clears backoff the same way).
      _arkErrorAt = 0;
      _zhipuErrorAt = 0;
      _kimiErrorAt = 0;
      refreshVendorQuotas();
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
    final sid = sessionId;
    if (sid.isEmpty) return;
    try {
      final baseUrl = await _quota.fetchProviderBaseUrl(sid);
      _setProviderBaseUrl(baseUrl ?? '');
    } catch (_) {
      // Non-fatal: the bar simply stays hidden until a switch provides a baseUrl.
    }
  }

  /// Fetch quota for every vendor the current provider baseUrl points at.
  /// Each fetcher is a no-op unless the baseUrl matches its vendor, so this is
  /// safe to call on any provider change.
  void refreshVendorQuotas() {
    final baseUrl = _providerBaseUrl;
    if (isArkBaseUrl(baseUrl)) _fetchArkQuota();
    if (isZhipuBaseUrl(baseUrl)) _fetchZhipuQuota();
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

  /// Zhipu quota bar, visible only when the provider baseUrl points at
  /// z.ai / bigmodel.cn. Tappable: force refetch (no login window).
  VendorQuotaView? get zhipuQuotaView {
    if (!isZhipuBaseUrl(_providerBaseUrl)) return null;
    return _vendorOrIdle(_zhipuQuota, 'zhipu', loading: _zhipuLoading);
  }

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

  Future<void> _fetchArkQuota({bool force = false}) async {
    if (_arkInFlight) return;
    if (!force &&
        _arkErrorAt != 0 &&
        _nowMs() - _arkErrorAt < _vendorQuotaBackoffMs) {
      return;
    }
    _arkInFlight = true;
    _arkLoading = true;
    notifyListeners();
    final data = await _quota.fetchArkQuota();
    _arkInFlight = false;
    _arkLoading = false;
    if (data == null) {
      _arkErrorAt = _nowMs();
    } else {
      _arkErrorAt = 0;
      _arkQuota = data;
      if (data['status'] == 'ok') _persistRuntimeCache();
    }
    notifyListeners();
  }

  Future<void> _fetchZhipuQuota({bool force = false}) async {
    if (_zhipuInFlight) return;
    if (!force &&
        _zhipuErrorAt != 0 &&
        _nowMs() - _zhipuErrorAt < _vendorQuotaBackoffMs) {
      return;
    }
    _zhipuInFlight = true;
    _zhipuLoading = true;
    notifyListeners();
    final data = await _quota.fetchZhipuQuota(
      zhipuHostFromBaseUrl(_providerBaseUrl),
    );
    _zhipuInFlight = false;
    _zhipuLoading = false;
    if (data == null) {
      _zhipuErrorAt = _nowMs();
    } else {
      _zhipuErrorAt = 0;
      _zhipuQuota = data;
      if (data['status'] == 'ok') _persistRuntimeCache();
    }
    notifyListeners();
  }

  Future<void> _fetchKimiQuota({bool force = false}) async {
    if (_kimiInFlight) return;
    if (!force &&
        _kimiErrorAt != 0 &&
        _nowMs() - _kimiErrorAt < _vendorQuotaBackoffMs) {
      return;
    }
    _kimiInFlight = true;
    _kimiLoading = true;
    notifyListeners();
    final data = await _quota.fetchKimiQuota(
      kimiHostFromBaseUrl(_providerBaseUrl),
    );
    _kimiInFlight = false;
    _kimiLoading = false;
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
    if (_cli != SessionCli.codex) return;
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
    if (_cli != SessionCli.claude) return;
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

  /// Tap on the Zhipu balance/quota bar: the zhipu route has no login window
  /// (the web slot passes no loginKind), so every tap is a force refetch.
  Future<void> handleZhipuQuotaTap() async {
    await _fetchZhipuQuota(force: true);
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
    final before = _messages.length;
    _messages.removeWhere((m) => m.id == id);
    if (_messages.length != before) notifyListeners();
  }

  void _onMessageStart(Map<String, dynamic>? evt) {
    // One request's own prompt accounting: the only context figure that needs
    // no heuristic, so it supersedes whatever the last turn total implied.
    final usage = (evt?['message'] as Map?)?['usage'];
    if (usage is Map) {
      _requestUsage = MessageUsage.fromJson(Map<String, dynamic>.from(usage));
    }
    _ensureAssistantMsg();
    notifyListeners();
  }

  void _ensureAssistantMsg() {
    if (_currentMsg == null) {
      _currentMsg = ChatMessage(role: MessageRole.assistant, isStreaming: true);
      _messages.add(_currentMsg!);
      _lastAssistantMsg = _currentMsg;
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
        // Live timing stamp (mirror of the web's chat-event-controller): the
        // tool's real wall-clock start, paired with endedAt at tool_result.
        startedAt: DateTime.now().millisecondsSinceEpoch,
      );
      _activeTools[idx] = tc;
      _ensureAssistantMsg();
      _currentMsg!.toolCalls.add(tc);
      notifyListeners();
    }
  }

  /// A `user` role frame carrying tool_result blocks — one per finished tool.
  /// Mirrors the web's handleToolResult: match by tool_use_id, attach the
  /// result text, mark done, and stamp endedAt for the measured duration.
  void _onUserToolResult(Map<String, dynamic> msg) {
    final inner = msg['message'];
    final content = inner is Map ? inner['content'] : msg['content'];
    if (content is! List) return;
    var changed = false;
    for (final raw in content) {
      if (raw is! Map || raw['type'] != 'tool_result') continue;
      final id = raw['tool_use_id']?.toString() ?? '';
      if (id.isEmpty) continue;
      final tools = _currentMsg?.toolCalls ?? const <ToolCall>[];
      for (final tc in tools) {
        if (tc.id != id) continue;
        final c = raw['content'];
        tc.result = c is String
            ? c
            : c is List
            ? c.map((item) => item is Map ? (item['text'] ?? '').toString() : '').join('')
            : c?.toString();
        tc.isError = raw['is_error'] == true;
        tc.isDone = true;
        tc.endedAt = DateTime.now().millisecondsSinceEpoch;
        changed = true;
        break;
      }
    }
    if (changed) notifyListeners();
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
      if (raw is! Map) continue;
      if (raw['type'] == 'text') {
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
      } else if (raw['type'] == 'tool_use') {
        // Codex/OpenCode tools arrive as complete blocks here (no
        // content_block_start), so this is their live creation site — mirror
        // of the web's finalizeAssistantMsg branch. Without it the app showed
        // no tool cards live on non-claude CLIs until a history reload.
        final id = raw['id']?.toString() ?? '';
        if (id.isEmpty) continue;
        final name = raw['name']?.toString() ?? 'Tool';
        final input = raw['input'];
        _ensureAssistantMsg();
        ToolCall? existing;
        for (final tc in _currentMsg!.toolCalls) {
          if (tc.id == id) {
            existing = tc;
            break;
          }
        }
        if (existing == null) {
          _currentMsg!.toolCalls.add(ToolCall(
            id: id,
            name: name,
            inputJson: input != null ? jsonEncode(input) : '',
            startedAt: DateTime.now().millisecondsSinceEpoch,
          ));
          changed = true;
        } else if (input != null && existing.inputJson != jsonEncode(input)) {
          // Authoritative convergence (web finalizeAssistantMsg parity): the
          // snapshot carries the COMPLETE input, so it overwrites whatever
          // the part_delta sidecar streamed so far — never the reverse. The
          // sidecar reasoning card (id `sidecar-reasoning-*`) never matches a
          // snapshot block id, so it is untouched here.
          existing.inputJson = jsonEncode(input);
          changed = true;
        }
      }
    }
    if (changed) notifyListeners();
  }

  void _onPartDelta(Map<String, dynamic> message) {
    if (_cli == SessionCli.claude) return;
    final delta = message['delta'];
    if (delta is! Map) return;
    final dType = delta['type']?.toString() ?? '';

    if (dType == 'text') {
      final text = delta['text']?.toString() ?? '';
      if (text.isEmpty) return;
      _ensureAssistantMsg();
      _currentMsg!.content += text;
      notifyListeners();
    } else if (dType == 'reasoning') {
      // Live reasoning streams into the session's single Thinking sidecar
      // card (web handlePartDelta parity). No startedAt: reasoning has no
      // real tool timing — must not fabricate durations or trajectory rows.
      final text = delta['text']?.toString() ?? '';
      if (text.isEmpty) return;
      _ensureAssistantMsg();
      if (applyReasoningDelta(_currentMsg!, _sessionId ?? '', text)) {
        notifyListeners();
      }
    } else if (dType == 'tool') {
      // Progressive tool-argument fragments: keyed by delta.toolId, args
      // accumulate at delta.tool.arguments. The authoritative `assistant`
      // snapshot later overwrites with the complete input.
      final toolId = delta['toolId']?.toString() ?? '';
      final tool = delta['tool'];
      if (toolId.isEmpty || tool is! Map) return;
      _ensureAssistantMsg();
      if (applyToolArgsDelta(
        _currentMsg!,
        toolId,
        tool['name']?.toString() ?? 'Tool',
        tool['arguments']?.toString() ?? '',
        now: DateTime.now().millisecondsSinceEpoch,
      )) {
        notifyListeners();
      }
    }
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

      // Attach the parsed role split for the detail sheet. Same ordering
      // contract as above: the live event usually set it already, but the
      // result-first race resolves through the cached breakdown.
      final breakdown = _lastRoleBreakdown;
      if (breakdown != null && !breakdown.isEmpty) {
        _currentMsg!.usage ??= MessageUsage();
        _currentMsg!.usage!.roleBreakdown = breakdown;
      }

      // Server-stamped wall-clock duration: user submit → AI reply complete.
      final dur = (msg['durationMs'] as num?)?.toInt();
      if (dur != null) _currentMsg!.durationMs = dur;
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
  List<BackgroundTaskRow> backgroundTaskRows() => _backgroundTasks.rows(
        now: DateTime.now().millisecondsSinceEpoch,
      );

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
    try {
      final rows = await SessionService(
        settings: settings,
      ).fetchDispatchQueue(sessionName);
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

  bool _listEqualsById(
    List<DispatchQueueEntry> a,
    List<DispatchQueueEntry> b,
  ) {
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
    _seedUsageFromHistory();
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
    _seedUsageFromHistory();
    // 历史已是权威：未裁决的暂存失去意义（已落盘的在历史里，未落盘的队列消息靠
    // 队列面板展示），取消它们的兜底定时器。
    _stagedTracker.clear();
    notifyListeners();
  }

  /// Re-derive the usage bar from the transcript we now hold.
  ///
  /// History records each turn's totals but no per-request block, so the exact
  /// context reading cannot survive a reload — it is dropped rather than shown
  /// against a turn it did not measure. A live streaming tail is the exception:
  /// its `message_start` describes the turn still on screen.
  void _seedUsageFromHistory() {
    if (_currentMsg == null) _requestUsage = null;
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
    _turnDurationText = '';
    _turnCount = 0;
    for (var i = _messages.length - 1; i >= 0; i -= 1) {
      final m = _messages[i];
      if (m.role != MessageRole.assistant) continue;
      _turnUsage = m.usage;
      // Round count is a result-frame fact and is not persisted; the timing is.
      if (m.durationMs != null) _turnDurationText = _fmtDuration(m.durationMs!);
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
    _stagedTracker.stage(clientMsgId, message);
    _setPendingUserInput(null);
    _apiErrorPolicy = null;
    // User just sent a message -> resume auto-follow at the bottom, clear any
    // unread pill (mirrors the web client's forceScrollToBottom on send).
    _userPinnedAway = false;
    _unreadCount = 0;
    notifyListeners();
  }

  // ── Staged user sends: 等服务端 FIFO 裁决的暂存消息 ──────────────────────────
  // 生命周期（暂存、兜底定时器、裁决应用）在 [StagedSendTracker]；这里只剩
  // 「把被 commit 的暂存画成气泡」这唯一一个 UI 落点。

  /// StagedSendTracker.onCommit 的落点：把一条暂存消息画成对话区用户气泡。
  void _commitStagedBubble(StagedUserSend staged) {
    _messages.add(
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
  Future<void> queueAction(String action, {String? entryId}) async {
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
    final result = await _service.queueAction(action, entryId: entryId);
    final schedule = result['schedule'];
    if (schedule is Map) {
      final next = applyActionSchedule(
        _sessionQueue,
        Map<String, dynamic>.from(schedule),
        wsSeqAtRequest,
        _sessionQueueEventSeq,
      );
      if (next == null) return;
      _sessionQueue = next;
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
    _seedUsageFromHistory();
    _historyApplied = false;
    _stagedTracker.clear();
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
    _bgSweepTimer?.cancel();
    _dispatchQueueTimer?.cancel();
    _dispatchQueueRetryTimer?.cancel();
    _stagedTracker.clear();
    _eventSub?.cancel();
    _service.dispose();
    super.dispose();
  }
}
