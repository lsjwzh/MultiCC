import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../i18n.dart';
import '../utils/status_presentation.dart';
import '../models/dispatch_queue.dart';
import '../models/message.dart';
import '../models/usage_readout.dart';
import '../providers/chat_provider.dart';
import '../providers/session_manager.dart';
import '../services/chat_service.dart';
import '../services/manage_service.dart';
import '../services/session_service.dart';
import '../services/settings_service.dart';
import '../utils/session_status_helpers.dart';
import '../widgets/ai_config_sheet.dart';
import '../widgets/background_task_panel.dart';
import '../widgets/chat_header.dart';
import '../widgets/chat_runtime_panels.dart';
import '../widgets/conflict_diff_dialog.dart';
import '../widgets/session_diff_dialog.dart';
import '../widgets/input_bar.dart';
import '../widgets/message_bubble.dart';
import '../widgets/thinking_indicator.dart';
import 'memo_screen.dart';
import 'memory_screen.dart';
import 'terminal_screen.dart';

const double _chatDesktopBreakpoint = 760;
const double _chatMaxContentWidth = 980;
const double _chatMobileSidePadding = 12;
const double _chatDesktopSidePadding = 16;

/// Reusable chat view — expects a ChatProvider in the widget tree
/// (provided by MainShell via ChangeNotifierProvider.value).
class ChatView extends StatefulWidget {
  final SettingsService settings;
  final VoidCallback? onCollapse;

  /// Optional deep-link target: when non-null, the chat scrolls to + highlights
  /// this message once history loads (task-board "jump to message" flow). Null
  /// = normal open with zero behaviour change - the focus code paths are all
  /// guarded on this being non-null.
  final String? focusMessageId;
  const ChatView({
    super.key,
    required this.settings,
    this.onCollapse,
    this.focusMessageId,
  });

  @override
  State<ChatView> createState() => _ChatViewState();
}

class _ChatViewState extends State<ChatView> {
  final _scrollCtrl = ScrollController();
  Timer? _mergeTimer;
  String? _polledSession;
  Map<String, dynamic>? _mergeStatus;
  Timer? _livenessTimer;
  Map<String, dynamic>? _liveness;
  // Track the last-warned behind count per session so the SnackBar fires when a
  // worktree first falls behind main (or falls further), not on every 5s poll.
  int _lastWarnedBehind = 0;
  bool _syncing = false;
  bool _dispatchExpanded = false;

  // ── Deep-link focus (task-board "jump to message") ───────────────────────
  // Resolved at most once, after the initial history page is applied. The fade
  // is owned by _FocusHighlight; _highlightId only tells _MessageList which
  // bubble to wrap + hand the focus GlobalKey to. When focusMessageId is null
  // none of this ever arms (see the guard in build).
  bool _focusAttempted = false;
  String? _highlightId;
  final GlobalKey _focusKey = GlobalKey();

  int _behindCount() => (_mergeStatus?['behind'] as num?)?.toInt() ?? 0;
  String _baseBranchName() => _mergeStatus?['baseBranch']?.toString() ?? 'main';

  /// Mark a waiting turn as execution-succeeded from the classify bar.
  /// This does not complete the TaskBoard task lifecycle.
  /// Mirrors the web's ac-mark-done button (POST /api/sessions/:id/mark-task-done).
  Future<void> _markTurnSucceeded(ChatProvider provider) async {
    try {
      await ManageService(
        settings: widget.settings,
      ).markTurnSucceeded(provider.sessionName);
      if (!mounted) return;
      // The server will push a task_state update via WS; no manual refresh needed.
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
    }
  }

  Future<void> _retryApiError(ChatProvider provider) async {
    try {
      await provider.queueAction('retry');
    } catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(t('queueActionFailed', {'error': '$error'}))),
      );
    }
  }

  // One-click sync: pull the base branch into this session's worktree.
  Future<void> _syncWorktree(String sessionId) async {
    if (sessionId.isEmpty || _syncing) return;
    setState(() => _syncing = true);
    final messenger = ScaffoldMessenger.of(context);
    try {
      final res = await SessionService(
        settings: widget.settings,
      ).syncSession(sessionId);
      messenger.hideCurrentSnackBar();
      if (res['ok'] == true) {
        final merged = res['merged'] == true;
        messenger.showSnackBar(
          SnackBar(
            content: Text(
              merged
                  ? t('syncSuccess', {
                      'base': '${res['baseBranch'] ?? t('baseBranch')}',
                      'n': '${res['commits'] ?? 0}',
                    })
                  : t('syncAlreadyLatest'),
            ),
          ),
        );
      } else if ((res['conflicts'] as List?)?.isNotEmpty == true) {
        messenger.showSnackBar(
          SnackBar(
            backgroundColor: const Color(0xFF3a1414),
            content: Text(
              t('syncConflict', {
                'files': (res['conflicts'] as List).join(', '),
              }),
              style: const TextStyle(color: Color(0xFFff9b9b)),
            ),
            duration: const Duration(seconds: 6),
          ),
        );
      } else {
        messenger.showSnackBar(
          SnackBar(
            content: Text(
              t('syncFailed', {
                'error': '${res['error'] ?? t('unknownError')}',
              }),
            ),
          ),
        );
      }
      _lastWarnedBehind = 0; // allow a fresh warning if it falls behind again
      await _refreshMergeStatus(sessionId);
    } catch (e) {
      messenger.showSnackBar(
        SnackBar(content: Text(t('syncRequestFailed', {'error': '$e'}))),
      );
    } finally {
      if (mounted) setState(() => _syncing = false);
    }
  }

  @override
  void dispose() {
    _scrollCtrl.dispose();
    _mergeTimer?.cancel();
    _livenessTimer?.cancel();
    super.dispose();
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final provider = context.watch<ChatProvider>();
    final session = provider.sessionName;
    if (session == _polledSession) return;
    _polledSession = session;
    _lastWarnedBehind = 0; // reset warning state when switching sessions
    _mergeTimer?.cancel();
    _refreshMergeStatus(session);
    _mergeTimer = Timer.periodic(
      const Duration(seconds: 5),
      (_) => _refreshMergeStatus(session),
    );
    _liveness = null;
    _livenessTimer?.cancel();
    _refreshLiveness(session);
    _livenessTimer = Timer.periodic(
      const Duration(seconds: 4),
      (_) => _refreshLiveness(session),
    );
  }

  Future<void> _refreshLiveness(String sessionId) async {
    if (sessionId.isEmpty) return;
    try {
      final v = await SessionService(
        settings: widget.settings,
      ).fetchLiveness(sessionId);
      if (!mounted || _polledSession != sessionId) return;
      setState(() => _liveness = v);
    } catch (_) {}
  }

  Future<void> _refreshMergeStatus(String sessionId) async {
    if (sessionId.isEmpty) return;
    try {
      final status = await SessionService(
        settings: widget.settings,
      ).fetchMergeStatus(sessionId);
      if (!mounted || _polledSession != sessionId) return;
      setState(() => _mergeStatus = status);
      _maybeWarnBehind();
    } catch (_) {}
  }

  // Fire a SnackBar the moment this worktree is detected as behind its base
  // branch (and again only if it falls further behind), so the user sees it
  // without having to scan the header.
  void _maybeWarnBehind() {
    final behind = _behindCount();
    if (behind > _lastWarnedBehind) {
      final base = _baseBranchName();
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(
          SnackBar(
            backgroundColor: const Color(0xFF2d2108),
            content: Text(
              t('behindWarning', {'base': base, 'n': '$behind'}),
              style: const TextStyle(color: Color(0xFFf2cc60)),
            ),
            duration: const Duration(seconds: 5),
          ),
        );
    }
    _lastWarnedBehind = behind;
  }

  Future<void> _mergeCurrent(BuildContext context, String sessionId) async {
    await confirmMergeWorktree(context, widget.settings, sessionId);
    await _refreshMergeStatus(sessionId);
  }

  // ── Deep-link focus resolution ────────────────────────────────────────────
  // Called once (post-frame) after the initial history page is applied. If the
  // target is already in the loaded transcript we just scroll+highlight;
  // otherwise we fetch the around-window and replace the transcript, then
  // scroll+highlight. Not-found / fetch-failure falls back to the normal bottom
  // - the existing _scrollToBottom / streaming-append / _userScrolled logic in
  // _MessageList is untouched and keeps working in every branch.
  Future<void> _resolveFocus(ChatProvider provider) async {
    final focusId = widget.focusMessageId;
    if (focusId == null || focusId.isEmpty) return;
    final alreadyPresent = provider.messages.any((m) => m.id == focusId);
    if (!alreadyPresent) {
      bool found = false;
      try {
        found = await provider.loadHistoryAround(focusId);
      } catch (_) {
        found = false;
      }
      if (!found) {
        if (!mounted) return;
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(t('messageNotFound'))));
        return; // fall back to normal bottom
      }
    }
    if (!mounted) return;
    setState(() => _highlightId = focusId);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final ctx = _focusKey.currentContext;
      if (ctx != null) {
        Scrollable.ensureVisible(
          ctx,
          alignment: 0.4,
          duration: const Duration(milliseconds: 300),
        );
      }
    });
  }

  void _clearHighlight() {
    if (_highlightId != null) {
      setState(() => _highlightId = null);
    }
  }

  Future<void> _openDispatchSession(DispatchQueueEntry entry) async {
    if (entry.navigationSessionIds.isEmpty) return;
    final mgr = context.read<SessionManager>();

    Session? resolveTarget() {
      for (final id in entry.navigationSessionIds) {
        for (final session in mgr.sessions) {
          if (session.id == id) return session;
        }
      }
      return null;
    }

    // A gateway execution chat can be created just before the dashboard's
    // five-second refresh. Refresh once, then fall back to the stable target.
    var target = resolveTarget();
    if (target == null) {
      await mgr.loadDashboard();
      if (!mounted) return;
      target = resolveTarget();
    }
    if (target == null) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(t('dispatchSessionNotFound'))));
      return;
    }
    final resolvedTarget = target;
    if (_dispatchExpanded) setState(() => _dispatchExpanded = false);
    if (resolvedTarget.isChat) {
      mgr.openSession(resolvedTarget);
      mgr.switchToSession(resolvedTarget.id);
      return;
    }
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) =>
            TerminalScreen(settings: widget.settings, session: resolvedTarget),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final provider = context.watch<ChatProvider>();
    final mergeReady = _mergeStatus?['mergeReady'] == true;
    final dispatchExpanded =
        _dispatchExpanded && provider.dispatchQueue.isNotEmpty;
    // Deep-link focus: resolve once, after the initial history page is applied.
    // Scheduled in a post-frame callback so the (async, setState-bearing)
    // resolution never runs during build. focusMessageId==null -> the guard
    // never arms, so the normal chat path is byte-for-byte unchanged.
    if (widget.focusMessageId != null &&
        !_focusAttempted &&
        provider.historyApplied) {
      _focusAttempted = true;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _resolveFocus(provider);
      });
    }
    return Scaffold(
      backgroundColor: const Color(0xFF070809),
      body: SafeArea(
        child: Stack(
          children: [
            Column(
              children: [
                ChatHeader(
                  settings: widget.settings,
                  onCollapse: widget.onCollapse,
                  mergeReady: mergeReady,
                  cwd: provider.cwd,
                  branch: _mergeStatus?['branch']?.toString(),
                  behind: (_mergeStatus?['behind'] as num?)?.toInt() ?? 0,
                  onCwd: () => _showCwdDialog(context, provider),
                  onMerge: () => _mergeCurrent(context, provider.sessionName),
                  onRole: () =>
                      _editRoleFromSession(context, provider.sessionName),
                  onMemory: () =>
                      _editMemoryFromSession(context, provider.sessionName),
                  onMemo: () =>
                      _openMemoFromSession(context, provider.sessionName),
                  onShare: () => _shareFromSession(
                    context,
                    provider.sessionName,
                    widget.settings,
                  ),
                ),
                if (provider.pendingUserInput != null &&
                    !provider.pendingUserInputCollapsed)
                  _CenteredChatLane(
                    child: ConstrainedBox(
                      constraints: BoxConstraints(
                        maxHeight: MediaQuery.sizeOf(context).height * 0.38,
                      ),
                      child: SingleChildScrollView(
                        padding: const EdgeInsets.fromLTRB(10, 7, 10, 0),
                        child: PendingUserInputPanel(
                          input: provider.pendingUserInput!,
                          enabled:
                              provider.connectionState ==
                              ChatConnectionState.connected,
                          onAnswer: provider.sendMessage,
                          onCollapse: provider.collapsePendingUserInput,
                        ),
                      ),
                    ),
                  ),
                // Liveness pill: only working (🟢) and stalled (🔴) earn a
                // dedicated line — they say "a turn is running / stuck".
                // idle (🟡) and unknown (⚪) are the resting states; a
                // permanent "空闲" row under the header is pure noise.
                if (chatLivenessDeservesLine(_liveness?['state'] as String?))
                  Align(
                    alignment: Alignment.centerLeft,
                    child: Padding(
                      padding: const EdgeInsets.only(
                        left: 12,
                        right: 12,
                        bottom: 2,
                      ),
                      child: livenessChip(_liveness),
                    ),
                  ),
                if (provider.hasClassify)
                  _AuxClassifyBar(
                    goal: provider.classifyGoal,
                    phase: provider.classifyPhase,
                    classifyState: provider.classifyState,
                    onMarkTurnSucceeded: provider.classifyState.toUpperCase() == 'W'
                        ? () => _markTurnSucceeded(provider)
                        : null,
                  ),
                _CenteredChatLane(
                  child: ChatRuntimeNoticePanel(
                    apiError: provider.apiErrorPolicy,
                    limit: provider.limitView,
                    balance: provider.balanceView,
                    arkUsage: provider.arkQuotaView,
                    zhipuUsage: provider.zhipuQuotaView,
                    kimiUsage: provider.kimiQuotaView,
                    claudeUsage: provider.claudeLimitView,
                    qoderUsage: provider.qoderQuotaView,
                    opencodeUsage: provider.opencodeQuotaView,
                    codexUsage: provider.codexQuotaView,
                    onClaudeQuotaTap: () => provider.handleClaudeQuotaTap(),
                    onQoderQuotaTap: () => provider.handleQoderQuotaTap(),
                    onOpenCodeQuotaTap: () => provider.handleOpenCodeQuotaTap(),
                    onCodexQuotaTap: () => provider.handleCodexQuotaTap(),
                    onArkQuotaTap: () => provider.handleArkQuotaTap(),
                    onZhipuQuotaTap: () => provider.handleZhipuQuotaTap(),
                    onKimiQuotaTap: () => provider.handleKimiQuotaTap(),
                    onRetry: provider.apiErrorPolicy?.canManualRetry == true
                        ? () => _retryApiError(provider)
                        : null,
                  ),
                ),
                if (_behindCount() > 0)
                  _BehindMainBanner(
                    behind: _behindCount(),
                    baseBranch: _baseBranchName(),
                    syncing: _syncing,
                    onSync: () => _syncWorktree(provider.sessionName),
                  ),
                Expanded(
                  child: _MessageList(
                    scrollCtrl: _scrollCtrl,
                    highlightId: _highlightId,
                    focusKey: _focusKey,
                    onHighlightDone: _clearHighlight,
                  ),
                ),
                const _CenteredChatLane(child: _ContextUsageBar()),
                if (mergeReady)
                  _MergeReadyBanner(
                    text: _mergeStatusText(_mergeStatus),
                    onMerge: () => _mergeCurrent(context, provider.sessionName),
                    onDiff: () => showSessionDiffDialog(
                      context,
                      settings: widget.settings,
                      sessionId: provider.sessionName,
                    ),
                  ),
                _CenteredChatLane(
                  child: InputBar(
                    onPickSubagent: () => openAIConfigSheet(
                      context,
                      settings: widget.settings,
                      sessionId: provider.sessionName,
                    ),
                  ),
                ),
              ],
            ),
            if (!dispatchExpanded &&
                provider.pendingUserInput != null &&
                provider.pendingUserInputCollapsed)
              Positioned(
                right: 14,
                bottom: 100,
                child: _PendingInputFab(onTap: provider.expandPendingUserInput),
              ),
            // Background-task danmaku (mobile): floats above the input bar on
            // the right, stacked above the pending-input FAB when both show.
            if (!dispatchExpanded && provider.hasBackgroundTaskRows)
              Positioned(
                right: 14,
                bottom: provider.pendingUserInput != null &&
                        provider.pendingUserInputCollapsed
                    ? 160
                    : 96,
                child: BackgroundTaskPanel(
                  rows: provider.backgroundTaskRows(),
                  onDismiss: provider.dismissBackgroundTask,
                ),
              ),
            if (provider.dispatchQueue.isNotEmpty)
              Positioned(
                left: 14,
                bottom: 96,
                child: DispatchQueuePanel(
                  key: ValueKey('dispatch-${provider.sessionName}'),
                  entries: provider.dispatchQueue,
                  resolveName: context
                      .read<SessionManager>()
                      .sessionDisplayName,
                  onRefresh: provider.refreshDispatchQueue,
                  onOpenSession: _openDispatchSession,
                  initiallyExpanded: dispatchExpanded,
                  onExpandedChanged: (expanded) {
                    if (mounted) setState(() => _dispatchExpanded = expanded);
                  },
                ),
              ),
          ],
        ),
      ),
    );
  }
}

/// 问题卡收起后显示的漂浮球：点击重新展开问题卡作答。纯本地 UI，
/// 不改变「等待回答」的服务端语义。Badge 红点 = 仍有未答问题。
class _PendingInputFab extends StatelessWidget {
  final VoidCallback onTap;
  const _PendingInputFab({required this.onTap});

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      label: t('pendingInputExpand'),
      child: Badge(
        backgroundColor: const Color(0xFFe5534b),
        smallSize: 10,
        alignment: const Alignment(0.4, -0.4),
        child: FloatingActionButton.small(
          heroTag: const Object(),
          onPressed: onTap,
          backgroundColor: const Color(0xFF211a08),
          foregroundColor: const Color(0xFFf2cc60),
          tooltip: t('pendingInputExpand'),
          child: const Icon(Icons.help_outline_rounded),
        ),
      ),
    );
  }
}

class _CenteredChatLane extends StatelessWidget {
  final Widget child;
  const _CenteredChatLane({required this.child});

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final viewportWidth = constraints.maxWidth.isFinite
            ? constraints.maxWidth
            : MediaQuery.of(context).size.width;
        final laneWidth =
            viewportWidth >= _chatDesktopBreakpoint &&
                viewportWidth > _chatMaxContentWidth
            ? _chatMaxContentWidth
            : viewportWidth;
        return Align(
          alignment: Alignment.center,
          child: SizedBox(width: laneWidth, child: child),
        );
      },
    );
  }
}

// Edit the per-session role prompt (system-prompt override) from the chat
// header overflow menu. Empty = clear → inherits the directory default.
Future<void> _editRoleFromSession(
  BuildContext context,
  String sessionId,
) async {
  final mgr = Provider.of<SessionManager>(context, listen: false);
  final messenger = ScaffoldMessenger.of(context);
  Session? s;
  for (final x in mgr.sessions) {
    if (x.id == sessionId) {
      s = x;
      break;
    }
  }
  if (s == null) {
    messenger.showSnackBar(
      SnackBar(content: Text(t('sessionInfoUnavailable'))),
    );
    return;
  }
  final picked = await showRolePromptEditor(
    context,
    current: s.rolePrompt ?? '',
    settings: mgr.settings,
  );
  if (picked == null) return; // cancelled
  try {
    await mgr.updateSessionRolePrompt(s.id, picked);
    messenger.showSnackBar(
      SnackBar(
        content: Text(
          picked.trim().isEmpty ? t('rolePromptSaved') : t('rolePromptUpdated'),
        ),
      ),
    );
  } catch (e) {
    messenger.showSnackBar(
      SnackBar(content: Text(t('rolePromptFailed', {'error': '$e'}))),
    );
  }
}

// View/edit the session's distilled memory (key problems + how they were
// solved). The aux AI maintains it on history clear/trim; here the user can read
// and tweak it. Fetched fresh since the AI may have updated it.
Future<void> _editMemoryFromSession(
  BuildContext context,
  String sessionId,
) async {
  final mgr = Provider.of<SessionManager>(context, listen: false);
  Navigator.of(context).push(
    MaterialPageRoute<void>(
      builder: (_) =>
          MemoryScreen(settings: mgr.settings, sessionId: sessionId),
    ),
  );
}

// Share a session externally. Mirrors the web share dialog: create link with
// access type + optional password + expiry, list existing shares with type
// badges and revoke buttons, copy link to clipboard.
Future<void> _shareFromSession(
  BuildContext context,
  String sessionId,
  SettingsService settings,
) async {
  final svc = SessionService(settings: settings);
  String access = 'view';
  final pwCtrl = TextEditingController();
  int expiryHrs = 0;
  String? url;
  String? error;
  bool busy = false;
  List<Map<String, dynamic>> shares = [];
  bool loadingShares = true;

  Future<void> refreshShares(StateSetter setState) async {
    try {
      shares = await svc.listShares(sessionId);
    } catch (_) {
      shares = [];
    }
    setState(() => loadingShares = false);
  }

  await showDialog<void>(
    context: context,
    builder: (ctx) => StatefulBuilder(
      builder: (ctx, setState) {
        // Load shares on first build
        if (loadingShares) {
          refreshShares(setState);
        }
        return AlertDialog(
          backgroundColor: const Color(0xFF14171c),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(12),
            side: const BorderSide(color: Color(0xFF20242b)),
          ),
          title: Text(
            t('shareSession'),
            style: const TextStyle(color: Color(0xFFe7eaee), fontSize: 16),
          ),
          content: SizedBox(
            width: 380,
            child: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    t('shareDesc'),
                    style: const TextStyle(
                      color: Color(0xFF8b949e),
                      fontSize: 12,
                    ),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    t('shareOperateWarn'),
                    style: const TextStyle(
                      color: Color(0xFFe3853f),
                      fontSize: 12,
                    ),
                  ),
                  const SizedBox(height: 14),
                  // ── Access type ──
                  Row(
                    children: [
                      _expandedChoice(
                        'view',
                        t('shareViewOnly'),
                        access,
                        (v) => setState(() => access = v),
                      ),
                      const SizedBox(width: 8),
                      _expandedChoice(
                        'operate',
                        t('shareOperate'),
                        access,
                        (v) => setState(() => access = v),
                      ),
                    ],
                  ),
                  const SizedBox(height: 10),
                  // ── Password ──
                  TextField(
                    controller: pwCtrl,
                    style: const TextStyle(
                      color: Color(0xFFe7eaee),
                      fontSize: 14,
                    ),
                    decoration: InputDecoration(
                      hintText: t('sharePassword'),
                      hintStyle: const TextStyle(
                        color: Color(0xFF6e7681),
                        fontSize: 13,
                      ),
                      filled: true,
                      fillColor: const Color(0xFF1c2128),
                      contentPadding: const EdgeInsets.symmetric(
                        horizontal: 12,
                        vertical: 10,
                      ),
                      border: const OutlineInputBorder(
                        borderRadius: BorderRadius.all(Radius.circular(8)),
                        borderSide: BorderSide(color: Color(0xFF20242b)),
                      ),
                    ),
                  ),
                  const SizedBox(height: 10),
                  // ── Expiry ──
                  Text(
                    t('shareExpiry'),
                    style: const TextStyle(
                      color: Color(0xFF8b949e),
                      fontSize: 11,
                    ),
                  ),
                  const SizedBox(height: 4),
                  Row(
                    children: [
                      _expiryChip(
                        t('neverExpires'),
                        0,
                        expiryHrs,
                        (v) => setState(() => expiryHrs = v),
                      ),
                      _expiryChip(
                        t('oneHour'),
                        1,
                        expiryHrs,
                        (v) => setState(() => expiryHrs = v),
                      ),
                      _expiryChip(
                        t('oneDay'),
                        24,
                        expiryHrs,
                        (v) => setState(() => expiryHrs = v),
                      ),
                      _expiryChip(
                        t('sevenDays'),
                        168,
                        expiryHrs,
                        (v) => setState(() => expiryHrs = v),
                      ),
                    ],
                  ),
                  const SizedBox(height: 14),
                  // ── Generate button ──
                  SizedBox(
                    width: double.infinity,
                    height: 42,
                    child: ElevatedButton(
                      onPressed: busy
                          ? null
                          : () async {
                              final pw = pwCtrl.text.trim();
                              if (access == 'operate' && pw.isEmpty) {
                                setState(
                                  () => error = t('sharePasswordRequired'),
                                );
                                return;
                              }
                              setState(() {
                                busy = true;
                                error = null;
                              });
                              try {
                                final r = await svc.createShare(
                                  sessionId,
                                  access: access,
                                  password: pw.isEmpty ? null : pw,
                                  expiresAt: expiryHrs > 0
                                      ? (DateTime.now().millisecondsSinceEpoch +
                                            expiryHrs * 3600 * 1000)
                                      : null,
                                );
                                setState(() {
                                  url = r['url'] as String?;
                                  busy = false;
                                });
                                pwCtrl.clear();
                                refreshShares(setState);
                              } catch (e) {
                                setState(() {
                                  error = '$e';
                                  busy = false;
                                });
                              }
                            },
                      style: ElevatedButton.styleFrom(
                        backgroundColor: const Color(0xFF238636),
                        foregroundColor: Colors.white,
                      ),
                      child: busy
                          ? const SizedBox(
                              width: 18,
                              height: 18,
                              child: CircularProgressIndicator(
                                strokeWidth: 2,
                                color: Colors.white,
                              ),
                            )
                          : Text(
                              url == null
                                  ? t('shareGenerate')
                                  : t('shareRegenerate'),
                            ),
                    ),
                  ),
                  if (error != null) ...[
                    const SizedBox(height: 8),
                    Text(
                      error!,
                      style: const TextStyle(
                        color: Color(0xFFff6b63),
                        fontSize: 12,
                      ),
                    ),
                  ],
                  if (url != null) ...[
                    const SizedBox(height: 10),
                    Container(
                      padding: const EdgeInsets.all(10),
                      decoration: BoxDecoration(
                        color: const Color(0xFF1c2128),
                        borderRadius: BorderRadius.circular(8),
                        border: Border.all(color: const Color(0xFF20242b)),
                      ),
                      child: Row(
                        children: [
                          Expanded(
                            child: SelectableText(
                              url!,
                              style: const TextStyle(
                                color: Color(0xFF79c0ff),
                                fontSize: 12,
                              ),
                            ),
                          ),
                          const SizedBox(width: 8),
                          GestureDetector(
                            onTap: () {
                              Clipboard.setData(ClipboardData(text: url!));
                              ScaffoldMessenger.of(context).showSnackBar(
                                SnackBar(content: Text(t('shareCopied'))),
                              );
                            },
                            child: const Icon(
                              Icons.copy,
                              size: 18,
                              color: Color(0xFF8b949e),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ],
                  // ── Existing shares ──
                  const SizedBox(height: 18),
                  Text(
                    t('existingShares'),
                    style: const TextStyle(
                      color: Color(0xFF8b949e),
                      fontSize: 12,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(height: 6),
                  if (loadingShares)
                    const Padding(
                      padding: EdgeInsets.symmetric(vertical: 12),
                      child: Center(
                        child: SizedBox(
                          width: 18,
                          height: 18,
                          child: CircularProgressIndicator(
                            strokeWidth: 2,
                            color: Color(0xFF8b949e),
                          ),
                        ),
                      ),
                    )
                  else if (shares.isEmpty)
                    Text(
                      t('none'),
                      style: const TextStyle(
                        color: Color(0xFF6e7681),
                        fontSize: 13,
                      ),
                    )
                  else
                    ...shares.map(
                      (s) => _shareCard(s, () async {
                        final token = s['token'] as String;
                        try {
                          await svc.deleteShare(sessionId, token);
                          setState(
                            () =>
                                shares.removeWhere((x) => x['token'] == token),
                          );
                        } catch (e) {
                          if (ctx.mounted) {
                            ScaffoldMessenger.of(context).showSnackBar(
                              SnackBar(
                                content: Text(
                                  t('shareRevokeFailed', {'error': '$e'}),
                                ),
                              ),
                            );
                          }
                        }
                      }),
                    ),
                ],
              ),
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(ctx).pop(),
              child: Text(
                t('close'),
                style: const TextStyle(color: Color(0xFF8b949e)),
              ),
            ),
          ],
        );
      },
    ),
  );
}

Widget _expandedChoice(
  String value,
  String label,
  String current,
  ValueChanged<String> onChanged,
) {
  final sel = current == value;
  return Expanded(
    child: GestureDetector(
      onTap: () => onChanged(value),
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 9),
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: sel ? const Color(0xFF1a3a5c) : const Color(0xFF1c2128),
          borderRadius: BorderRadius.circular(8),
          border: Border.all(
            color: sel ? const Color(0xFF58a6ff) : const Color(0xFF20242b),
          ),
        ),
        child: Text(
          label,
          style: TextStyle(
            color: sel ? const Color(0xFF79c0ff) : const Color(0xFF8b949e),
            fontWeight: sel ? FontWeight.w600 : FontWeight.w400,
            fontSize: 13,
          ),
        ),
      ),
    ),
  );
}

Widget _expiryChip(
  String label,
  int value,
  int current,
  ValueChanged<int> onChanged,
) {
  final sel = current == value;
  return Padding(
    padding: const EdgeInsets.only(right: 8),
    child: GestureDetector(
      onTap: () => onChanged(value),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
        decoration: BoxDecoration(
          color: sel ? const Color(0xFF1a3a5c) : const Color(0xFF1c2128),
          borderRadius: BorderRadius.circular(6),
          border: Border.all(
            color: sel ? const Color(0xFF58a6ff) : const Color(0xFF20242b),
          ),
        ),
        child: Text(
          label,
          style: TextStyle(
            color: sel ? const Color(0xFF79c0ff) : const Color(0xFF8b949e),
            fontWeight: sel ? FontWeight.w500 : FontWeight.w400,
            fontSize: 12,
          ),
        ),
      ),
    ),
  );
}

String _shareTypeLabel(Map<String, dynamic> s) {
  if (s['type'] == 'messages') {
    return '📎 ${t('shareSnapshotSummary', {'n': '${s['messageCount'] ?? 0}', 'password': s['hasPassword'] == true ? t('sharePasswordSuffix') : ''})}';
  }
  if (s['access'] == 'operate') return '🔌 ${t('shareOperateBadge')}';
  if (s['hasPassword'] == true) return '🔒 ${t('sharePasswordBadge')}';
  return '🌐 ${t('sharePublicBadge')}';
}

Widget _shareCard(Map<String, dynamic> s, VoidCallback onRevoke) {
  final exp = s['expiresAt'] as int?;
  final expStr = exp != null && exp > 0
      ? ' · ${t('expiresAt', {'time': DateTime.fromMillisecondsSinceEpoch(exp).toLocal().toString().substring(0, 16)})}'
      : '';
  final url = (s['url'] as String?) ?? '';
  return Container(
    margin: const EdgeInsets.only(bottom: 8),
    padding: const EdgeInsets.all(10),
    decoration: BoxDecoration(
      color: const Color(0xFF1c2128),
      borderRadius: BorderRadius.circular(8),
      border: Border.all(color: const Color(0xFF20242b)),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Expanded(
              child: Text(
                '${_shareTypeLabel(s)}$expStr',
                style: const TextStyle(color: Color(0xFF79c0ff), fontSize: 12),
                overflow: TextOverflow.ellipsis,
              ),
            ),
            const SizedBox(width: 8),
            GestureDetector(
              onTap: () {
                Clipboard.setData(ClipboardData(text: url));
                if (s['url'] != null) {
                  // Access via mounted context — just use a simple approach
                  try {
                    Clipboard.setData(ClipboardData(text: url));
                  } catch (_) {}
                }
              },
              child: const Icon(Icons.copy, size: 16, color: Color(0xFF6e7681)),
            ),
            const SizedBox(width: 6),
            GestureDetector(
              onTap: onRevoke,
              child: const Icon(
                Icons.close_rounded,
                size: 18,
                color: Color(0xFFf85149),
              ),
            ),
          ],
        ),
        const SizedBox(height: 4),
        Text(
          url,
          style: const TextStyle(
            color: Color(0xFF6e7681),
            fontSize: 11,
            fontFamily: 'monospace',
          ),
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
        ),
      ],
    ),
  );
}

// Open the directory-memo screen for the given session's directory. Used by the
// chat AppBar to expose the project memo without leaving the chat view.
void _openMemoFromSession(BuildContext context, String sessionId) {
  final mgr = Provider.of<SessionManager>(context, listen: false);
  Session? s;
  for (final x in mgr.sessions) {
    if (x.id == sessionId) {
      s = x;
      break;
    }
  }
  if (s == null) {
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(SnackBar(content: Text(t('sessionInfoUnavailable'))));
    return;
  }
  Directory? d;
  for (final x in mgr.directories) {
    if (x.id == s.dirId) {
      d = x;
      break;
    }
  }
  if (d == null) {
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(SnackBar(content: Text(t('fleetNotFound'))));
    return;
  }
  Navigator.push(
    context,
    MaterialPageRoute<void>(
      builder: (_) => MemoScreen(directory: d!, mgr: mgr),
    ),
  );
}

Future<void> confirmMergeWorktree(
  BuildContext context,
  SettingsService settings,
  String sessionId,
) async {
  final ok = await showDialog<bool>(
    context: context,
    builder: (_) => AlertDialog(
      backgroundColor: const Color(0xFF0f1115),
      title: Text(
        t('mergeTitle'),
        style: const TextStyle(fontSize: 15, color: Color(0xFFf2f4f7)),
      ),
      content: Text(
        t('mergeBody'),
        style: const TextStyle(color: Color(0xFFe7eaee)),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context, false),
          child: Text(
            t('cancel'),
            style: const TextStyle(color: Color(0xFF8a909b)),
          ),
        ),
        TextButton(
          onPressed: () => Navigator.pop(context, true),
          child: Text(
            t('merge'),
            style: const TextStyle(
              color: Color(0xFF6aa3ff),
              fontWeight: FontWeight.w600,
            ),
          ),
        ),
      ],
    ),
  );
  if (ok != true || !context.mounted) return;
  final messenger = ScaffoldMessenger.of(context);
  messenger.showSnackBar(SnackBar(content: Text(t('merging'))));
  try {
    final result = await SessionService(
      settings: settings,
    ).mergeSession(sessionId);
    final hasConflict =
        result['conflicts'] is List && (result['conflicts'] as List).isNotEmpty;
    String msg;
    if (result['ok'] == true) {
      msg = result['merged'] == true
          ? t('merged', {'n': '${result['commits'] ?? 0}'})
          : t('mergedNothing', {'msg': t('mergeNoNewCommits')});
    } else if (result['conflicts'] != null) {
      msg = t('mergeConflict', {
        'files': (result['conflicts'] as List).join(', '),
      });
    } else {
      msg = t('mergeFailed', {'error': '${result['error'] ?? ''}'});
    }
    messenger.hideCurrentSnackBar();
    messenger.showSnackBar(SnackBar(content: Text(msg)));
    if (hasConflict && context.mounted) {
      await showConflictDiffDialog(
        context,
        sessionId: sessionId,
        result: result,
      );
    }
  } catch (e) {
    messenger.hideCurrentSnackBar();
    messenger.showSnackBar(
      SnackBar(content: Text(t('mergeRequestFailed', {'error': '$e'}))),
    );
  }
}

String _mergeStatusText(Map<String, dynamic>? status) {
  if (status?['mergeReady'] != true) return t('mergeNotReady');
  final bits = <String>[];
  if (status?['dirty'] == true) bits.add(t('uncommittedChanges'));
  final ahead = (status?['ahead'] as num?)?.toInt() ?? 0;
  if (ahead > 0) bits.add(t('commitsAhead', {'n': '$ahead'}));
  final detail = bits.isEmpty ? t('mergeContentReady') : bits.join(', ');
  return t('mergeReadyDetail', {
    'detail': detail,
    'base': '${status?['baseBranch'] ?? t('baseBranch')}',
  });
}

class _MergeReadyBanner extends StatelessWidget {
  final String text;
  final VoidCallback onMerge;
  final VoidCallback onDiff;
  const _MergeReadyBanner({
    required this.text,
    required this.onMerge,
    required this.onDiff,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.fromLTRB(10, 0, 10, 6),
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      decoration: BoxDecoration(
        color: const Color(0xFF2d2108),
        border: Border.all(color: const Color(0xFFe3b341)),
        borderRadius: BorderRadius.circular(8),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withValues(alpha: 0.28),
            blurRadius: 16,
            offset: const Offset(0, 8),
          ),
        ],
      ),
      child: Row(
        children: [
          const Icon(
            Icons.merge_type_rounded,
            size: 16,
            color: Color(0xFFf2cc60),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              text,
              style: const TextStyle(color: Color(0xFFf2cc60), fontSize: 12),
            ),
          ),
          TextButton(
            onPressed: onDiff,
            style: TextButton.styleFrom(
              foregroundColor: const Color(0xFFf2cc60),
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
              minimumSize: Size.zero,
              side: const BorderSide(color: Color(0xFFe3b341)),
            ),
            child: Text(
              t('viewDiff'),
              style: const TextStyle(fontWeight: FontWeight.w600),
            ),
          ),
          const SizedBox(width: 6),
          TextButton(
            onPressed: onMerge,
            style: TextButton.styleFrom(
              foregroundColor: const Color(0xFF070809),
              backgroundColor: const Color(0xFFe3b341),
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
              minimumSize: Size.zero,
            ),
            child: Text(
              t('merge'),
              style: const TextStyle(fontWeight: FontWeight.w700),
            ),
          ),
        ],
      ),
    );
  }
}

// Persistent top banner shown while the session's worktree is behind its base
// branch — complements the transient SnackBar with an always-visible reminder.
class _BehindMainBanner extends StatelessWidget {
  final int behind;
  final String baseBranch;
  final VoidCallback onSync;
  final bool syncing;
  const _BehindMainBanner({
    required this.behind,
    required this.baseBranch,
    required this.onSync,
    this.syncing = false,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.fromLTRB(10, 6, 10, 0),
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      decoration: BoxDecoration(
        color: const Color(0xFF2d2108),
        border: Border.all(color: const Color(0xFFe3b341)),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(
        children: [
          const Icon(Icons.history_rounded, size: 16, color: Color(0xFFf2cc60)),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              t('behindBanner', {'base': baseBranch, 'n': '$behind'}),
              style: const TextStyle(color: Color(0xFFf2cc60), fontSize: 12),
            ),
          ),
          TextButton(
            onPressed: syncing ? null : onSync,
            style: TextButton.styleFrom(
              foregroundColor: const Color(0xFF070809),
              backgroundColor: const Color(0xFFe3b341),
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
              minimumSize: Size.zero,
            ),
            child: Text(
              syncing ? t('syncing') : t('syncNow'),
              style: const TextStyle(fontWeight: FontWeight.w700),
            ),
          ),
        ],
      ),
    );
  }
}

class _AuxClassifyBar extends StatelessWidget {
  final String goal;
  final String phase;

  /// Live classify-state letter (D/W/B/E/P). Drives the pill tint, aligned
  /// with main_shell _classifyBadge and the web CLASSIFY_DISPLAY barTint.
  final String classifyState;

  /// Non-null when state is W: shows the localized turn-success button.
  /// The compatibility endpoint changes only turn outcome, never task lifecycle.
  final VoidCallback? onMarkTurnSucceeded;

  const _AuxClassifyBar({
    required this.goal,
    required this.phase,
    required this.classifyState,
    this.onMarkTurnSucceeded,
  });

  String _phaseLabel(String value) => switch (value) {
    'idle' => t('activityIdle'),
    'planning' => t('phasePlanning'),
    'running' => t('phaseRunning'),
    'editing' => t('activityEditing'),
    'verifying' => t('phaseVerifying'),
    'waiting' => t('phaseWaiting'),
    'blocked' => t('phaseBlocked'),
    'reviewing' => t('phaseReviewing'),
    'completed' || 'done' => t('phaseDone'),
    'interrupted' => t('phaseInterrupted'),
    _ => value,
  };

  @override
  Widget build(BuildContext context) {
    // classify 字母 → canonical 状态 → 图标/色彩，全部走中心 registry：这条
    // bar 曾自带一套色表（E 是 ⚠、卡片却是 ❌），现在与会话卡、任务面板同源。
    final spec = statusPresentation[classifyStatusOf(classifyState)]!;
    final phaseColor = spec.color;
    final phaseBg = phaseColor.withValues(alpha: 0.12);
    final phaseBorder = phaseColor.withValues(alpha: 0.34);
    final stateEmoji = spec.icon;
    final phaseLabel = _phaseLabel(phase);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      decoration: const BoxDecoration(
        color: Color(0xFF0a0c0f),
        border: Border(bottom: BorderSide(color: Color(0xFF14171c))),
      ),
      child: Row(
        children: [
          const Icon(
            Icons.auto_awesome_outlined,
            size: 14,
            color: Color(0xFF5b616c),
          ),
          const SizedBox(width: 6),
          Expanded(
            child: Tooltip(
              message: goal,
              child: Text(
                goal,
                style: const TextStyle(
                  color: Color(0xFFc9ced6),
                  fontSize: 12,
                  height: 1.3,
                ),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
            ),
          ),
          const SizedBox(width: 8),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
            decoration: BoxDecoration(
              color: phaseBg,
              borderRadius: BorderRadius.circular(6),
              border: Border.all(color: phaseBorder),
            ),
            child: Text(
              '$stateEmoji $phaseLabel',
              style: TextStyle(
                color: phaseColor,
                fontSize: 11,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
          // Turn-success button: visible only when state is W (waiting-for-user)
          if (onMarkTurnSucceeded != null) ...[
            const SizedBox(width: 6),
            GestureDetector(
              onTap: onMarkTurnSucceeded,
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                decoration: BoxDecoration(
                  color: const Color(0xFF1c4529),
                  borderRadius: BorderRadius.circular(6),
                  border: Border.all(color: const Color(0x882ea043)),
                ),
                child: Text(
                  t('markTurnSucceeded'),
                  style: const TextStyle(
                    color: Color(0xFF56d364),
                    fontSize: 11,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }
}

/// Change-working-directory dialog. Used to hang off the full-width cwd bar
/// under the header; the bar is gone (the cwd now lives in the header ⋯ menu),
/// so this stands alone, opened from the menu's 「更换目录」 item.
void _showCwdDialog(BuildContext context, ChatProvider provider) {
  final ctrl = TextEditingController(text: provider.cwd);
  showDialog(
    context: context,
    builder: (_) => AlertDialog(
      title: Text(t('changeCwdTitle'), style: const TextStyle(fontSize: 15)),
      content: TextField(
        controller: ctrl,
        autofocus: true,
        style: const TextStyle(
          color: Color(0xFFe7eaee),
          fontFamily: 'monospace',
          fontSize: 13,
        ),
        decoration: InputDecoration(
          hintText: '/path/to/project',
          hintStyle: const TextStyle(color: Color(0xFF454b54)),
          filled: true,
          fillColor: const Color(0xFF070809),
          border: OutlineInputBorder(borderRadius: BorderRadius.circular(6)),
          enabledBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(6),
            borderSide: const BorderSide(color: Color(0xFF20242b)),
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: Text(
            t('cancel'),
            style: const TextStyle(color: Color(0xFF8a909b)),
          ),
        ),
        TextButton(
          onPressed: () {
            final newCwd = ctrl.text.trim();
            Navigator.pop(context);
            if (newCwd.isNotEmpty && newCwd != provider.cwd) {
              provider.changeCwd(newCwd);
            }
          },
          child: Text(
            t('apply'),
            style: const TextStyle(
              color: Color(0xFF6aa3ff),
              fontWeight: FontWeight.w600,
            ),
          ),
        ),
      ],
    ),
  );
}

/// Minimum gap (minutes) between two consecutive messages before a time
/// separator is drawn between them.
const int _timeSeparatorGapMinutes = 5;

/// Human-friendly time label for a chat separator, relative to now:
/// today → "HH:mm", yesterday → "昨天 HH:mm", within a week → "周X HH:mm",
/// same year → "M月d日 HH:mm", otherwise "yyyy年M月d日 HH:mm".
String formatChatTime(DateTime value) {
  final now = DateTime.now();
  final today = DateTime(now.year, now.month, now.day);
  final day = DateTime(value.year, value.month, value.day);
  final hm =
      '${value.hour.toString().padLeft(2, '0')}:${value.minute.toString().padLeft(2, '0')}';
  final diffDays = today.difference(day).inDays;
  if (diffDays == 0) return hm;
  if (diffDays == 1) return t('yesterdayAt', {'time': hm});
  if (diffDays > 1 && diffDays < 7) {
    final week = [
      t('weekdayMon'),
      t('weekdayTue'),
      t('weekdayWed'),
      t('weekdayThu'),
      t('weekdayFri'),
      t('weekdaySat'),
      t('weekdaySun'),
    ];
    return t('weekdayAt', {'day': week[value.weekday - 1], 'time': hm});
  }
  if (value.year == now.year) {
    return t('monthDayAt', {
      'month': '${value.month}',
      'day': '${value.day}',
      'time': hm,
    });
  }
  return t('yearMonthDayAt', {
    'year': '${value.year}',
    'month': '${value.month}',
    'day': '${value.day}',
    'time': hm,
  });
}

/// Centered, pill-shaped time label inserted between distant messages.
class _TimeSeparator extends StatelessWidget {
  final DateTime time;
  const _TimeSeparator({required this.time});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Center(
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 3),
          decoration: BoxDecoration(
            color: const Color(0xFF14171c),
            borderRadius: BorderRadius.circular(10),
          ),
          child: Text(
            formatChatTime(time),
            style: const TextStyle(color: Color(0xFF8a909b), fontSize: 11),
          ),
        ),
      ),
    );
  }
}

class _MessageList extends StatefulWidget {
  final ScrollController scrollCtrl;

  /// Message id to deep-link highlight (null = no highlight). Drives
  /// _maybeHighlight in the itemBuilder.
  final String? highlightId;

  /// GlobalKey attached to the highlighted bubble so the host can
  /// Scrollable.ensureVisible it.
  final GlobalKey? focusKey;

  /// Fired when the highlight fade finishes so the host clears highlightId
  /// (the wrapper then unmounts, returning the bubble to its normal state).
  final VoidCallback? onHighlightDone;

  const _MessageList({
    required this.scrollCtrl,
    this.highlightId,
    this.focusKey,
    this.onHighlightDone,
  });

  @override
  State<_MessageList> createState() => _MessageListState();
}

class _MessageListState extends State<_MessageList> {
  bool _userScrolled = false;
  bool _loadingOlder = false;

  @override
  void initState() {
    super.initState();
    widget.scrollCtrl.addListener(_onScroll);
  }

  void _onScroll() {
    if (!widget.scrollCtrl.hasClients) return;
    final pos = widget.scrollCtrl.position;
    final atBottom = pos.pixels >= pos.maxScrollExtent - 60;
    final settling =
        _scrollSettlingUntil != null &&
        DateTime.now().isBefore(_scrollSettlingUntil!);
    if (atBottom && _userScrolled) {
      setState(() => _userScrolled = false);
    } else if (!atBottom && !_userScrolled && !settling) {
      // Ignore "scrolled away" during a programmatic scroll-to-bottom.
      setState(() => _userScrolled = true);
    }
    // Sync pinned/unread state to the provider (drives the "↓ N new" pill),
    // but skip while settling so initial positioning doesn't arm the pill.
    if (!settling) {
      final provider = context.read<ChatProvider>();
      provider.onUserScroll(atBottom: atBottom);
    }
    // Scroll near the top -> fetch one older page of history.
    if (pos.pixels <= 80) {
      _maybeLoadOlder();
    }
  }

  Future<void> _maybeLoadOlder() async {
    if (_loadingOlder) return;
    final provider = context.read<ChatProvider>();
    if (provider.historyExhausted || provider.historyLoading) return;
    setState(() => _loadingOlder = true);
    // Capture scroll geometry BEFORE the prepend so we can re-anchor.
    double? beforePixels;
    double? beforeMax;
    if (widget.scrollCtrl.hasClients) {
      beforePixels = widget.scrollCtrl.position.pixels;
      beforeMax = widget.scrollCtrl.position.maxScrollExtent;
    }
    final inserted = await provider.loadOlderHistory();
    if (inserted > 0 && beforePixels != null && beforeMax != null) {
      // Re-anchor: keep the message that was at the top of the viewport in place.
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!widget.scrollCtrl.hasClients) return;
        final newMax = widget.scrollCtrl.position.maxScrollExtent;
        final delta = newMax - beforeMax!;
        widget.scrollCtrl.jumpTo(beforePixels! + delta);
      });
    }
    if (mounted) setState(() => _loadingOlder = false);
  }

  // Brief window after a programmatic scroll-to-bottom during which _onScroll
  // should NOT mark the user as scrolled-away (the animateTo fires intermediate
  // scroll positions that would otherwise falsely arm the unread pill).
  DateTime? _scrollSettlingUntil;

  void _scrollToBottom() {
    // While a deep-link focus highlight is active, the focus owns the scroll
    // position (Scrollable.ensureVisible on the target message) - don't fight
    // it by yanking back to the bottom. No-op for the normal path, where
    // highlightId is always null.
    if (widget.highlightId != null) return;
    if (!widget.scrollCtrl.hasClients || _userScrolled) return;
    _scrollSettlingUntil = DateTime.now().add(
      const Duration(milliseconds: 350),
    );
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (widget.scrollCtrl.hasClients) {
        widget.scrollCtrl.animateTo(
          widget.scrollCtrl.position.maxScrollExtent,
          duration: const Duration(milliseconds: 150),
          curve: Curves.easeOut,
        );
      }
    });
  }

  /// Wrap a bubble with the focus highlight (yellow, fading out over ~3.2s) and
  /// the focus GlobalKey when it is the deep-link target. Non-target bubbles
  /// pass through unchanged - so with no focus active (highlightId null) every
  /// row is identical to the pre-focus code path.
  Widget _maybeHighlight(Widget child, String? id) {
    final hid = widget.highlightId;
    if (id == null || id.isEmpty || hid == null || id != hid) return child;
    return KeyedSubtree(
      key: widget.focusKey,
      child: _FocusHighlight(
        onFadeComplete: widget.onHighlightDone,
        child: child,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final provider = context.watch<ChatProvider>();
    final messages = provider.messages;
    final showThinking =
        provider.isStreaming &&
        (messages.isEmpty ||
            messages.last.role != MessageRole.assistant ||
            messages.last.content.isEmpty && messages.last.toolCalls.isEmpty);

    _scrollToBottom();

    return LayoutBuilder(
      builder: (context, constraints) {
        final viewportWidth = constraints.maxWidth.isFinite
            ? constraints.maxWidth
            : MediaQuery.of(context).size.width;
        final desktop = viewportWidth >= _chatDesktopBreakpoint;
        final contentWidth = desktop && viewportWidth > _chatMaxContentWidth
            ? _chatMaxContentWidth
            : viewportWidth;
        final sidePadding =
            ((viewportWidth - contentWidth) / 2) +
            (desktop ? _chatDesktopSidePadding : _chatMobileSidePadding);

        return Stack(
          children: [
            ListView.builder(
              controller: widget.scrollCtrl,
              padding: EdgeInsets.fromLTRB(sidePadding, 12, sidePadding, 12),
              itemCount: messages.length + (showThinking ? 1 : 0),
              itemBuilder: (_, i) {
                if (i == messages.length) return const ThinkingIndicator();
                final msg = messages[i];
                // WeChat-style time separator: show a centered time label only when
                // this message is the first, or its gap from the previous message
                // exceeds the threshold — so back-to-back turns stay uncluttered.
                final prev = i > 0 ? messages[i - 1] : null;
                final showTime =
                    prev == null ||
                    msg.timestamp.difference(prev.timestamp).inMinutes.abs() >=
                        _timeSeparatorGapMinutes;
                final bubble = _maybeHighlight(
                  MessageBubble(message: msg),
                  msg.id,
                );
                if (!showTime) return bubble;
                return Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    _TimeSeparator(time: msg.timestamp),
                    bubble,
                  ],
                );
              },
            ),
            // Lazy-history top hint: "loading older…" while fetching, or a
            // persistent "- earliest -" marker once everything is loaded.
            if (provider.historyExhausted && messages.length > 3)
              Positioned(
                top: 6,
                left: 0,
                right: 0,
                child: Center(
                  child: Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 12,
                      vertical: 4,
                    ),
                    decoration: BoxDecoration(
                      color: const Color(0xFF161b22),
                      border: Border.all(color: const Color(0xFF21262d)),
                      borderRadius: BorderRadius.circular(999),
                    ),
                    child: Text(
                      t('historyStart'),
                      style: const TextStyle(
                        color: Color(0xFF8b949e),
                        fontSize: 12,
                      ),
                    ),
                  ),
                ),
              )
            else if (_loadingOlder || provider.historyLoading)
              Positioned(
                top: 6,
                left: 0,
                right: 0,
                child: Center(
                  child: Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 12,
                      vertical: 4,
                    ),
                    decoration: BoxDecoration(
                      color: const Color(0xFF161b22),
                      border: Border.all(color: const Color(0xFF21262d)),
                      borderRadius: BorderRadius.circular(999),
                    ),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        const SizedBox(
                          width: 12,
                          height: 12,
                          child: CircularProgressIndicator(
                            strokeWidth: 2,
                            color: Color(0xFF8b949e),
                          ),
                        ),
                        const SizedBox(width: 6),
                        Text(
                          t('loadingEarlierMessages'),
                          style: const TextStyle(
                            color: Color(0xFF8b949e),
                            fontSize: 12,
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            if (_userScrolled)
              Positioned(
                bottom: 10,
                left: 0,
                right: 0,
                child: Center(
                  child: GestureDetector(
                    onTap: () {
                      provider.jumpToBottom();
                      setState(() => _userScrolled = false);
                      _scrollToBottom();
                    },
                    child: Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 14,
                        vertical: 7,
                      ),
                      decoration: BoxDecoration(
                        color: const Color(0xFF1f6feb),
                        border: Border.all(color: const Color(0xFF388bfd)),
                        borderRadius: BorderRadius.circular(999),
                        boxShadow: const [
                          BoxShadow(
                            color: Color(0x66000000),
                            blurRadius: 12,
                            offset: Offset(0, 3),
                          ),
                        ],
                      ),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          const Icon(
                            Icons.keyboard_arrow_down,
                            color: Colors.white,
                            size: 18,
                          ),
                          const SizedBox(width: 4),
                          Text(
                            provider.unreadCount > 0
                                ? t('newMessagesCount', {
                                    'n': '${provider.unreadCount}',
                                  })
                                : t('backToBottom'),
                            style: const TextStyle(
                              color: Colors.white,
                              fontSize: 13,
                              fontWeight: FontWeight.w500,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
          ],
        );
      },
    );
  }
}

/// The strip under the transcript. It answers one question — how full is the
/// context — and hands everything else to a dialog on tap or long-press.
///
/// It used to print `$2.0314 | 248038ms | 13 turn(s)`. The money came from the
/// CLI's own `result` frame, which prices with Anthropic's table no matter
/// which provider actually served the request, so it was removed rather than
/// relabelled. The web bar (public/chat-usage-readout.js) shows the same line
/// and opens the same set of rows on hover.
class _ContextUsageBar extends StatelessWidget {
  const _ContextUsageBar();

  static String _amount(int tokens) => formatCompactTokens(tokens);

  static String _summary(ContextReadout ctx) {
    final label = t('contextUsage');
    // An aggregate that overflows even after de-duplication cannot honestly
    // become a number, so it says so instead of clamping to 100%.
    if (!ctx.usable) return '$label —';
    final approx = ctx.exact ? '' : '≈';
    if (ctx.window <= 0) return '$label $approx${_amount(ctx.tokens)}';
    return '$label $approx${_amount(ctx.tokens)} / ${_amount(ctx.window)}'
        ' · $approx${ctx.percent.toStringAsFixed(1)}%';
  }

  static List<List<String>> _detailRows(ChatProvider p) {
    final rows = <List<String>>[];
    final turn = p.turnUsage;
    if (turn != null && !turn.isEmpty) {
      rows.add([
        t('usageTurnBilled'),
        '${t('usageIn')} ${_amount(turn.inputTokens)}'
            ' · ${t('usageCacheRead')} ${_amount(turn.cacheReadTokens)}'
            ' · ${t('usageCacheWrite')} ${_amount(turn.cacheCreationTokens)}'
            ' · ${t('usageOut')} ${_amount(turn.outputTokens)}',
      ]);
    }
    if (p.turnDurationText.isNotEmpty || p.turnCount > 0) {
      final parts = <String>[
        if (p.turnDurationText.isNotEmpty) p.turnDurationText,
        if (p.turnCount > 0) t('usageRounds', {'n': '${p.turnCount}'}),
      ];
      rows.add([t('usageTurnDuration'), parts.join(' · ')]);
    }
    if (p.sessionInputTokens > 0 || p.sessionOutputTokens > 0) {
      rows.add([
        t('usageSessionTotal'),
        '${t('usageIn')} ${_amount(p.sessionInputTokens)}'
            ' · ${t('usageOut')} ${_amount(p.sessionOutputTokens)}',
      ]);
    }
    return rows;
  }

  void _showDetail(BuildContext context, ChatProvider p) {
    final rows = _detailRows(p);
    if (rows.isEmpty) return;
    showDialog<void>(
      context: context,
      builder: (_) => AlertDialog(
        title: Text(t('usageDetailTitle'), style: const TextStyle(fontSize: 15)),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            for (final row in rows)
              Padding(
                padding: const EdgeInsets.only(bottom: 10),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      row[0],
                      style: const TextStyle(
                        color: Color(0xFF7a828e),
                        fontSize: 11,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      row[1],
                      style: const TextStyle(
                        color: Color(0xFFc6ccd4),
                        fontSize: 12,
                      ),
                    ),
                  ],
                ),
              ),
            Text(
              t('usageSessionHint'),
              style: const TextStyle(color: Color(0xFF5b616c), fontSize: 11),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: Text(t('close')),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final provider = context.watch<ChatProvider>();
    final ctx = provider.contextReadout;
    final hasDetail = _detailRows(provider).isNotEmpty;
    // Nothing measured yet: show no strip at all rather than an empty one.
    if (ctx.isEmpty && !hasDetail) return const SizedBox.shrink();

    return GestureDetector(
      onTap: hasDetail ? () => _showDetail(context, provider) : null,
      onLongPress: hasDetail ? () => _showDetail(context, provider) : null,
      behavior: HitTestBehavior.opaque,
      child: Container(
        color: const Color(0xFF070809),
        padding: const EdgeInsets.symmetric(vertical: 4, horizontal: 8),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            if (ctx.hasMeter) ...[
              Container(
                width: 56,
                height: 4,
                decoration: BoxDecoration(
                  color: const Color(0xFF1b1f26),
                  borderRadius: BorderRadius.circular(2),
                ),
                alignment: Alignment.centerLeft,
                child: FractionallySizedBox(
                  widthFactor: ctx.fraction,
                  child: Container(
                    decoration: BoxDecoration(
                      color: ctx.fraction >= 0.9
                          ? const Color(0xFFd9822b)
                          : const Color(0xFF3d7a5f),
                      borderRadius: BorderRadius.circular(2),
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 8),
            ],
            Flexible(
              child: Text(
                ctx.isEmpty ? t('contextUsage') : _summary(ctx),
                textAlign: TextAlign.center,
                style: const TextStyle(color: Color(0xFF5b616c), fontSize: 11),
              ),
            ),
            if (hasDetail) ...[
              const SizedBox(width: 6),
              Text(
                t('usageDetail'),
                style: const TextStyle(color: Color(0xFF454b54), fontSize: 11),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// Yellow highlight that fades out over ~3.2s, used by the deep-link focus to
/// draw the eye to the target message. Owns its own animation; calls
/// [onFadeComplete] when the fade finishes so the host can drop the highlight
/// id (the _maybeHighlight wrapper then unmounts, leaving the bubble in its
/// normal state - by then the opacity has already reached 0, so there is no
/// visible jump).
class _FocusHighlight extends StatefulWidget {
  final Widget child;
  final VoidCallback? onFadeComplete;
  const _FocusHighlight({required this.child, this.onFadeComplete});

  @override
  State<_FocusHighlight> createState() => _FocusHighlightState();
}

class _FocusHighlightState extends State<_FocusHighlight>
    with SingleTickerProviderStateMixin {
  late final AnimationController _ctrl;
  late final Animation<double> _opacity;

  @override
  void initState() {
    super.initState();
    _ctrl = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 3200),
    );
    _opacity = Tween<double>(
      begin: 0.45,
      end: 0.0,
    ).animate(CurvedAnimation(parent: _ctrl, curve: Curves.easeOut));
    _ctrl.forward().then((_) {
      if (mounted) widget.onFadeComplete?.call();
    });
  }

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _opacity,
      builder: (_, child) => DecoratedBox(
        decoration: BoxDecoration(
          color: const Color(0xFFE3B341).withValues(alpha: _opacity.value),
          borderRadius: BorderRadius.circular(8),
        ),
        child: child,
      ),
      child: widget.child,
    );
  }
}
