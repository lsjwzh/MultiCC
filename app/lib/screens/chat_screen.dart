import '../widgets/context_source_details.dart';
import '../services/chat_shell_view.dart';
import 'dart:async';
import 'dart:convert';

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
import '../services/auto_commit.dart';
import '../services/chat_debug_log.dart';
import '../services/chat_service.dart';
import '../services/manage_service.dart';
import '../services/message_quote.dart';
import '../services/scheduled_send_service.dart';
import '../services/session_service.dart';
import '../services/settings_service.dart';
import '../utils/session_status_helpers.dart';
import '../widgets/ai_config_sheet.dart';
import '../widgets/task_separation_prompt.dart';
import '../widgets/background_tasks_dock.dart';
import '../widgets/floating_dock.dart';
import '../widgets/chat_composer_fold.dart';
import '../widgets/chat_header.dart';
import '../widgets/chat_runtime_panels.dart';
import '../widgets/chat_side_panels.dart';
import '../widgets/conflict_diff_dialog.dart';
import '../widgets/dispatch_floating_dock.dart';
import '../widgets/scheduled_send_dock.dart';
import '../widgets/scheduled_send_store.dart';
import '../widgets/session_diff_dialog.dart';
import '../widgets/input_bar.dart';
import '../widgets/message_bubble.dart';
import '../widgets/thinking_indicator.dart';
import '../widgets/tour_overlay.dart';
import '../widgets/worktree_status.dart';
import 'chat_width_dialog.dart';
import 'memo_screen.dart';
import 'memory_screen.dart';
import 'terminal_screen.dart';

const double _chatDesktopBreakpoint = 760;
const double _chatMobileSidePadding = 12;
const double _chatDesktopSidePadding = 16;

/// 强制同步发出去的那段话。逐字照抄 Web 的 `syncPrompt()`
/// （public/chat-worktree-sync.js）—— 两端发的是同一条指令，措辞不能各写一份，
/// 否则同一个按钮在两个客户端会让会话做不同的事。
const String _worktreeSyncPrompt =
    '请同步本会话的工作区到所属工作目录的最新本地基分支，并解决同步冲突。\n'
    '只在当前会话自己的 worktree 操作，不修改主工作区。执行时重新确认工作区、基分支、Git 状态及是否已有 merge/rebase；有未完成同步则先检查并解决。\n'
    '保留所有未提交、未跟踪文件和独有提交，必要时先建立可恢复的备份或提交；不要使用 reset --hard、clean、强制覆盖或丢弃无法证明已合入的改动。\n'
    '确认没有其他 Git 操作或写入者并发后，用合适的 fast-forward、rebase 或 merge 同步，结合双方意图解决冲突，不盲选 ours/theirs。无法判断归属或冲突含义时保留现场并说明阻碍。\n'
    '完成后运行与改动相关的检查，核验 git status --short 和 HEAD...基分支 的 ahead/behind，确认 behind 为 0；如仍有 ahead 或保留的改动请说明。报告同步结果后继续原任务。';

/// 聊天区实际占多宽。宽屏上默认收在 [ChatWidthSetting.defaults] 的 980，但用户
/// 可以在「聊天宽度」里把这条限制关掉（铺满）或改大改小 —— 对齐 Web 的
/// `chat-layout.js`，那边是 `--chat-content-max-width` 这一个变量。
///
/// 手机宽度（< 760）永远铺满：那里本来就没有余量可让。
double _chatLaneWidth(double viewportWidth) {
  if (viewportWidth < _chatDesktopBreakpoint) return viewportWidth;
  final setting =
      SettingsService.current?.chatWidth.value ?? ChatWidthSetting.defaults;
  if (!setting.limited) return viewportWidth;
  final max = setting.max.toDouble();
  return viewportWidth > max ? max : viewportWidth;
}

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
  // 手机上空闲时输入区会折成一条胶囊（chat_composer_fold.dart）：草稿要显示在
  // 胶囊上，点开时要把光标放回输入框 —— 两件事都得从折叠那一层够得着输入框
  // 自己的草稿和焦点，所以这两个对象由这里持有再交给 InputBar。
  final _composerCtrl = TextEditingController();
  final _composerFocus = FocusNode();
  Timer? _mergeTimer;
  String? _polledSession;
  Map<String, dynamic>? _mergeStatus;
  Timer? _livenessTimer;
  Map<String, dynamic>? _liveness;
  // Track the last-warned behind count per session so the SnackBar fires when a
  // worktree first falls behind main (or falls further), not on every 5s poll.
  int _lastWarnedBehind = 0;
  bool _syncing = false;
  // 强制同步（把同步指令当消息发出去）的在途状态，以及上一次没送达时要复用的
  // 幂等键 —— 两个容器（worktree 提示条 / 冲突横幅）共用同一份，跟 Web 一样。
  bool _forceSyncing = false;
  String? _forceSyncClientMsgId;
  // 每轮自动提交（Web 的 `autoCommitIfNeeded`）：执行状态（在途互斥 + 轮次
  // 游标）在 controller 上，页面只负责每帧喊一声、并提供「刷新 merge-status」
  // 这个能力。
  late final AutoCommitController _autoCommit = AutoCommitController(
    settings: widget.settings,
    isAlive: () => mounted,
    refreshMergeReady: _refreshMergeReady,
  );
  bool _dispatchExpanded = false;
  // 右侧两个抽屉（调试面板 + 产物边栏）的开关、列表与轮询都在这里。
  late final ChatSidePanels _panels = ChatSidePanels(
    settings: widget.settings,
    isAlive: () => mounted,
    onChanged: () {
      if (mounted) setState(() {});
    },
  );
  // Current anchor of the dispatch floating dock (side + icon top px),
  // reported via onAnchorChanged so the background-tasks dock can yield to
  // it. Plain field, no setState — reading it next build is enough.
  FloatingDockAnchor? _dispatchAnchor;

  // Same, for the background-tasks dock: the scheduled-send dock yields to
  // both, so three floaters can coexist without stacking.
  FloatingDockAnchor? _backgroundAnchor;

  // 定时发送（Web 的 chat-scheduled-send.js）：一份 store 喂两个入口 ——
  // 输入栏的 ⏱ 和待执行时出现的悬浮球。
  ScheduledSendStore? _scheduledSend;
  String? _scheduledSendSession;

  /// 输入框把自己的「草稿读取器」放在这儿。从悬浮球排队时也要能读到输入框里
  /// 已经写好的那句话 —— 面板本身不碰输入框，只拿着这个回调问一次。
  final ValueNotifier<ScheduledSendDraftReader?> _scheduleDraftSink =
      ValueNotifier<ScheduledSendDraftReader?>(null);

  /// 引用消息用的通道：气泡那层（message_bubble 的长按弹层）需要往输入框里塞
  /// 东西，输入框却在这个 State 里。`late final` 是为了拿到一个身份稳定的闭包
  /// —— 登记与摘除靠它比对，见 [_syncQuoteInserter]。
  late final void Function(String) _quoteInserter = _insertQuote;
  ChatProvider? _quoteInserterHost;

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

  /// 还没解决的冲突文件。服务端在 `merge-status` 里带 `conflict` /
  /// `conflictFiles`：worktree 卡在一次冲突的 rebase 上时才非空 —— 这是
  /// 「同步没走完」，不是「有文件改坏了」。
  List<String> _conflictFiles() {
    if (_mergeStatus?['conflict'] != true) return const [];
    final raw = _mergeStatus?['conflictFiles'];
    if (raw is! List) return const [];
    return raw.map((e) => '$e').where((e) => e.isNotEmpty).toList();
  }

  /// Mark a waiting turn as execution-succeeded from the classify bar.
  /// This does not complete the TaskBoard task lifecycle.
  /// Mirrors the web's ac-mark-done button (POST /api/sessions/:id/mark-task-done).
  Future<void> _markTurnSucceeded(ChatProvider provider) async {
    try {
      await ManageService(
        settings: widget.settings,
      ).markTurnSucceeded(provider.executionSessionName);
      if (!mounted) return;
      // The server will push a task_state update via WS; no manual refresh needed.
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
    }
  }

  /// 待答卡的「已解决 / 忽略」：手动了结这条提问，不发回答、不继续原任务
  /// （web 的 `#pending-user-input-dismiss`，同一个接口）。成功时 provider 已经
  /// 把卡片收起，服务端随后广播的 user_input_resolved 才是最终权威；失败要把
  /// 服务端的 code 翻成人话 —— 「会话还在跑 / 提问已变化 / 还有外部任务在等」
  /// 都是有意义的结论，不是传输故障，所以不该当成异常一抛了之。
  Future<void> _dismissPendingUserInput(ChatProvider provider) async {
    final messenger = ScaffoldMessenger.of(context);
    try {
      final result = await provider.dismissPendingUserInput();
      if (!mounted || result['ok'] == true) return;
      messenger.showSnackBar(
        SnackBar(
          content: Text(
            t('pendingInputDismissFailed', {
              'error': _dismissFailureReason(result),
            }),
          ),
        ),
      );
    } catch (error) {
      if (!mounted) return;
      messenger.showSnackBar(
        SnackBar(
          content: Text(
            t('pendingInputDismissFailed', {'error': '$error'}),
          ),
        ),
      );
    }
  }

  /// 服务端 `{ok:false, code}` → 一句中文原因。认不出的 code 原样透出
  /// （与 web 一样回落到通用错误文案），绝不把失败说成成功。
  String _dismissFailureReason(Map<String, dynamic> result) {
    final code = '${result['code'] ?? result['error'] ?? ''}'.trim();
    return switch (code) {
      'turn_still_active' => t('pendingInputDismissTurnActive'),
      'request_id_mismatch' => t('pendingInputDismissStale'),
      'external_wait_pending' => t('pendingInputDismissExternalWait'),
      '' => t('unknownError'),
      _ => code,
    };
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
            backgroundColor: const Color(0xFFfff1ef),
            content: Text(
              t('syncConflict', {
                'files': (res['conflicts'] as List).join(', '),
              }),
              style: const TextStyle(color: Color(0xFFb64e43)),
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

  /// 强制同步（Web 的「强制同步」按钮，public/chat-worktree-sync.js）：不是
  /// `POST /sync`，而是把一段同步指令当作消息发给会话本身，让 agent 在自己的
  /// worktree 里保留改动、解决冲突再同步。所以这里只负责把话送出去 —— 真正干
  /// 活的是对方那一轮。
  ///
  /// 重试用同一个 clientMsgId：服务端按它去重（turn-engine 的 containsDelivery），
  /// 所以「点了没反应，再点一次」不会变成两个同步回合。
  Future<void> _forceSyncWorktree(ChatProvider provider) async {
    if (_forceSyncing) return;
    final session = provider.executionSessionName;
    if (session.isEmpty ||
        provider.connectionState != ChatConnectionState.connected) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(t('worktreeForceSyncNoSession'))));
      return;
    }
    setState(() => _forceSyncing = true);
    final messenger = ScaffoldMessenger.of(context);
    try {
      _forceSyncClientMsgId ??=
          'app-worktree-sync-${DateTime.now().microsecondsSinceEpoch}';
      final id = provider.sendMessage(
        _worktreeSyncPrompt,
        clientMsgId: _forceSyncClientMsgId,
      );
      messenger.hideCurrentSnackBar();
      if (id == null) {
        // sendMessage 自己已经把「连接断了」写进对话区；这里只补一句「可重试」。
        messenger.showSnackBar(
          SnackBar(
            content: Text(
              t('worktreeForceSyncFailed', {
                'error': t('worktreeForceSyncOffline'),
              }),
            ),
          ),
        );
        return;
      }
      _forceSyncClientMsgId = null; // 送达了，下一次是一条新指令
      messenger.showSnackBar(
        SnackBar(content: Text(t('worktreeForceSyncSent'))),
      );
    } catch (error) {
      messenger.showSnackBar(
        SnackBar(
          content: Text(t('worktreeForceSyncFailed', {'error': '$error'})),
        ),
      );
    } finally {
      if (mounted) setState(() => _forceSyncing = false);
    }
  }

  /// 从冲突横幅点「继续 / 放弃」：解掉卡住的那次 rebase（Web 的
  /// `resolveRebase`）。继续时仍可能有没处理完的文件 —— 那就把新的冲突列表
  /// 摆出来，别把「还有冲突」说成成功。
  Future<void> _resolveRebase(String action) async {
    final session = _polledSession ?? '';
    if (session.isEmpty) return;
    final messenger = ScaffoldMessenger.of(context);
    try {
      final res = await SessionService(
        settings: widget.settings,
      ).rebaseSession(session, action: action);
      messenger.hideCurrentSnackBar();
      if (res['ok'] == true) {
        final msg = res['aborted'] == true
            ? t('rebaseAborted')
            : res['done'] == true
            ? t('rebaseDone')
            : t('rebaseContinued');
        messenger.showSnackBar(SnackBar(content: Text(msg)));
      } else if (res['conflicts'] is List &&
          (res['conflicts'] as List).isNotEmpty) {
        messenger.showSnackBar(
          SnackBar(
            backgroundColor: const Color(0xFFfff1ef),
            content: Text(
              t('rebaseStillConflicts', {
                'files': (res['conflicts'] as List).join(', '),
              }),
              style: const TextStyle(color: Color(0xFFb64e43)),
            ),
            duration: const Duration(seconds: 6),
          ),
        );
      } else {
        messenger.showSnackBar(
          SnackBar(
            content: Text(
              t('rebaseFailed', {
                'error': '${res['error'] ?? t('unknownError')}',
              }),
            ),
          ),
        );
      }
      await _refreshMergeStatus(session);
    } catch (error) {
      messenger.showSnackBar(
        SnackBar(content: Text(t('rebaseFailed', {'error': '$error'}))),
      );
    }
  }

  /// 「如何解决」：把三步做法摆出来（Web 的 `showConflictHelp`）。不做成一键
  /// 自动解决 —— 冲突该由人（或会话那轮指令）判断，这里只解释怎么点。
  void _showConflictHelp(List<String> files) {
    showDialog<void>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        backgroundColor: const Color(0xFFffffff),
        title: Text(
          t('worktreeConflictHelpTitle'),
          style: const TextStyle(fontSize: 15, color: Color(0xFF20364d)),
        ),
        content: SingleChildScrollView(
          child: Text(
            t('worktreeConflictHelpBody', {'files': files.join('\n')}),
            style: const TextStyle(
              color: Color(0xFF233249),
              fontSize: 13,
              height: 1.6,
            ),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext),
            child: Text(
              t('close'),
              style: const TextStyle(color: Color(0xFF1267b5)),
            ),
          ),
        ],
      ),
    );
  }

  @override
  void initState() {
    super.initState();
    // 聊天宽度弹窗是边拖边预览的（跟 Web 一样先 apply 草稿、取消再回滚），
    // 所以真正的重排要跟着这个 notifier 走，不能等弹窗关闭。
    widget.settings.chatWidth.addListener(_onChatWidthChanged);
    _panels.start();
    // 调试面板的第一行（Web `chat.js:2802` 的 `dbg('state', 'page loaded…')`）：
    // 有了它，面板里第一行永远是这个会话「什么时候开的」，后面的时间戳才有参照。
    dbg('state', 'page loaded — 开始连接');
  }

  void _onChatWidthChanged() {
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    widget.settings.chatWidth.removeListener(_onChatWidthChanged);
    // 摘掉引用通道：provider 比这个页面活得久，留着就是个能打到已销毁 State 的
    // 回调。只在还挂着我们这一个时才清 —— 换会话后新页面已经登记过自己的了。
    if (_quoteInserterHost?.quoteInserter == _quoteInserter) {
      _quoteInserterHost!.quoteInserter = null;
    }
    _scrollCtrl.dispose();
    _composerCtrl.dispose();
    _composerFocus.dispose();
    _mergeTimer?.cancel();
    _livenessTimer?.cancel();
    _scheduledSend?.dispose();
    _scheduleDraftSink.dispose();
    _panels.dispose();
    super.dispose();
  }

  /// 把「插进输入框」这个能力登记给 provider —— 气泡那层就是这么够到输入框的。
  /// 每次依赖变化都登记一遍是刻意的：换会话会换 provider 实例，通道得跟着走。
  void _syncQuoteInserter(ChatProvider provider) {
    if (identical(_quoteInserterHost, provider) &&
        provider.quoteInserter == _quoteInserter) {
      return;
    }
    if (_quoteInserterHost != null &&
        !identical(_quoteInserterHost, provider) &&
        _quoteInserterHost!.quoteInserter == _quoteInserter) {
      _quoteInserterHost!.quoteInserter = null;
    }
    provider.quoteInserter = _quoteInserter;
    _quoteInserterHost = provider;
  }

  /// 把引用块插在草稿**上面**，然后聚焦。
  ///
  /// 不覆盖草稿：引用是往你已经想说的话里加材料，不是替换它 —— Web 侧同一条
  /// 规矩。光标停在末尾，接着往下写就行。`text` 的 setter 自己会通知监听者，
  /// 折叠态（手机上空闲时输入区收成一条胶囊）因此看得到这次变化；随后的
  /// requestFocus 会把它钉开，引用就看得见了。
  void _insertQuote(String block) {
    if (!mounted || block.isEmpty) return;
    _composerCtrl.text = composerTextWithQuote(_composerCtrl.text, block);
    _composerCtrl.selection =
        TextSelection.collapsed(offset: _composerCtrl.text.length);
    _composerFocus.requestFocus();
  }

  /// 定时发送跟着会话走：换会话就换一份 —— 待执行列表、角标条数、幂等键都是
  /// 这个会话的，串了会把消息排到别的会话去。
  void _syncScheduledSend(String session) {
    if (_scheduledSend != null && _scheduledSendSession == session) return;
    _scheduledSend?.dispose();
    _scheduledSendSession = session;
    _scheduledSend = session.isEmpty
        ? null
        : (ScheduledSendStore(
            service: ScheduledSendService(settings: widget.settings),
            sessionId: session,
          )..start());
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final provider = context.watch<ChatProvider>();
    _syncQuoteInserter(provider);
    // 一轮结束（WS `result` 帧让 turnEndTick 自增）是自动提交唯一的触发点，
    // 所以这一步要排在下面那些「换会话才做」的早退之前。
    _autoCommit.syncTick(
      provider: provider,
      manager: context.read<SessionManager>(),
    );
    // 产物边栏的 scope 是任务壳，握手完成后才拿得到 —— 这里每帧问一次，
    // 拿到就换过去（web 的 `setScope` 也是外部推进来的）。
    _panels.sync(provider.shellId);
    final session = provider.executionSessionName;
    _syncScheduledSend(session);
    if (session == _polledSession) return;
    _polledSession = session;
    _lastWarnedBehind = 0; // reset warning state when switching sessions
    _mergeStatus = null;
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
            backgroundColor: const Color(0xFFfff8eb),
            content: Text(
              t('behindWarning', {'base': base, 'n': '$behind'}),
              style: const TextStyle(color: Color(0xFFa85a25)),
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

  /// 页头 ⋯ 里的「自动提交✓/✕」（Web 的 `#auto-commit-btn` 点击）。
  Future<void> _toggleAutoCommit(ChatProvider provider) => _autoCommit.toggle(
    provider: provider,
    manager: context.read<SessionManager>(),
  );

  /// 刷一次 merge-status，并把「现在有没有可合并的东西」告诉自动提交执行器。
  Future<bool> _refreshMergeReady(String session) async {
    await _refreshMergeStatus(session);
    return _mergeStatus?['mergeReady'] == true;
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
    final alreadyPresent = provider.messages.any((m) => m.id == focusId || shellMessageOwner(provider.executionSessionName, m.id ?? '').messageId == focusId);
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
    setState(() => _highlightId = provider.messages.firstWhere((m) =>
      m.id == focusId || shellMessageOwner(provider.executionSessionName, m.id ?? '').messageId == focusId).id);
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
    final autoCommit = context.select<SessionManager, bool>(
      (m) => sessionAutoCommitOf(m.sessions, provider.sessionName),
    );
    final dispatchExpanded =
        _dispatchExpanded && provider.dispatchQueue.isNotEmpty;
    // 页头的产物入口。null = 这个会话没有任务壳（web 在没有 scope 时连按钮
    // 都不建），拉回来之前只写「产物」，对齐 web 先 `t('Title')` 再补条数。
    final artifactsLabel = _panels.artifactsLabel;
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
    // 新手引导的后两步套在 Scaffold 外面（第 4 步要圈住整块消息区，光圈还得压过
    // 页头，body 里那层盖不住），两个锚点则由下面那两处 [TourAnchor] 挂上去。
    return ChatTourLayer(
      composerController: _composerCtrl,
      composerFocus: _composerFocus,
      child: TaskSeparationPrompt(events: provider.chatEvents, sessionId: provider.executionSessionName, settings: widget.settings,
        child: _buildScaffold(context, provider, mergeReady, autoCommit, dispatchExpanded, artifactsLabel)),
    );
  }

  Widget _buildScaffold(
    BuildContext context,
    ChatProvider provider,
    bool mergeReady,
    bool autoCommit,
    bool dispatchExpanded,
    String? artifactsLabel,
  ) {
    return Scaffold(
      backgroundColor: const Color(0xFFf4f8fd),
      body: SafeArea(
        child: LayoutBuilder(
          builder: (context, constraints) {
            // 产物边栏的宽度与「让位」规则（web task-artifacts.css）：宽屏
            // （≥760）开着时正文让出 310px，窄屏直接盖上去、宽度裁到
            // `min(310px, 100% - 18px)`。
            final metrics = sidePanelMetrics(
              constraints: constraints,
              panelOpen: _panels.artifactsOpen,
            );
            final panelWidth = metrics.width;
            final artifactsPush = metrics.push;
            return Stack(
              children: [
            // 宽屏时给产物边栏让位（web 的 body padding-right），窄屏 push 为 0。
            Padding(
              padding: EdgeInsets.only(right: artifactsPush),
              child: Column(
                children: [
                  ChatHeader(
                    settings: widget.settings,
                    onCollapse: widget.onCollapse,
                    mergeReady: mergeReady,
                    cwd: provider.cwd,
                    branch: _mergeStatus?['branch']?.toString(),
                    behind: (_mergeStatus?['behind'] as num?)?.toInt() ?? 0,
                    onCwd: () => _showCwdDialog(context, provider),
                    onMerge: () => _mergeCurrent(context, provider.executionSessionName),
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
                    // 强制同步与聊天宽度都挂在 ⋯ 菜单里：手机上页头那一排图标
                    // 已经排满，这两个不是每轮都要点的动作。
                    onForceSync: () => _forceSyncWorktree(provider),
                    forceSyncing: _forceSyncing,
                    onChatWidth: () =>
                        showChatWidthDialog(context, widget.settings),
                    autoCommit: autoCommit,
                    onAutoCommit: () => _toggleAutoCommit(provider),
                    onDebug: _panels.toggleDebug,
                    artifactsLabel: artifactsLabel,
                    onArtifacts: _panels.toggleArtifacts,
                    advancedMode: widget.settings.advancedMode.value,
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
                            onDismiss: () => _dismissPendingUserInput(provider),
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
                    Builder(
                      builder: (_) {
                        // 显隐规则集中在 helper 里（web can-mark-done /
                        // can-cancel-task 两个 class 的等价物），这里只负责把动作接上。
                        final actions = classifyBarActions(provider.classifyState);
                        return AuxClassifyBar(
                          goal: provider.classifyGoal,
                          phase: provider.classifyPhase,
                          classifyState: provider.classifyState,
                          onMarkTurnSucceeded: actions.canMarkDone
                              ? () => _markTurnSucceeded(provider)
                              : null,
                          onCancelTurn: actions.canCancelTask
                              ? provider.cancel
                              : null,
                        );
                      },
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
                  // 卡在冲突里的 rebase 优先于「落后基分支」：那种状态下 behind 是 0
                  // （rebase 没走完，没得比），两个条不会同时出现，但顺序说明了
                  // 谁更该先处理 —— 冲突没解决，同步就还没结束。
                  if (_conflictFiles().isNotEmpty)
                    WorktreeConflictBanner(
                      files: _conflictFiles(),
                      onHelp: () => _showConflictHelp(_conflictFiles()),
                      onContinue: () => _resolveRebase('continue'),
                      onAbort: () => _resolveRebase('abort'),
                      onForceSync: () => _forceSyncWorktree(provider),
                      forceSyncing: _forceSyncing,
                    ),
                  if (_behindCount() > 0)
                    WorktreeBehindBanner(
                      behind: _behindCount(),
                      baseBranch: _baseBranchName(),
                      syncing: _syncing,
                      onSync: () => _syncWorktree(provider.executionSessionName),
                      onForceSync: () => _forceSyncWorktree(provider),
                      forceSyncing: _forceSyncing,
                    ),
                  Expanded(
                    // 第 4 步「第一份结果已经完成」圈的整块消息区。
                    child: TourAnchor(
                      step: 4,
                      child: _MessageList(
                        scrollCtrl: _scrollCtrl,
                        highlightId: _highlightId,
                        focusKey: _focusKey,
                        onHighlightDone: _clearHighlight,
                      ),
                    ),
                  ),
                  if (widget.settings.advancedMode.value)
                    const _CenteredChatLane(child: _ContextUsageBar()),
                  if (mergeReady)
                    MergeHintBar(
                      text: _mergeStatusText(_mergeStatus),
                      onMerge: () =>
                          _mergeCurrent(context, provider.executionSessionName),
                      onDiff: () => showSessionDiffDialog(
                        context,
                        settings: widget.settings,
                        sessionId: provider.executionSessionName,
                      ),
                    ),
                  // 手机上往回翻消息时输入区会跟着缩小（Web 的
                  // chat-composer-collapse.js）；桌面宽度下它原样不动。
                  ChatComposerFold(
                    scrollController: _scrollCtrl,
                    inputController: _composerCtrl,
                    inputFocusNode: _composerFocus,
                    child: _CenteredChatLane(
                      // 第 3 步「把要做的事说清楚」圈的输入区。
                      child: TourAnchor(
                        step: 3,
                        child: InputBar(
                          controller: _composerCtrl,
                          focusNode: _composerFocus,
                          scheduledSend: _scheduledSend,
                          draftSink: _scheduleDraftSink,
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            ),
            if (!dispatchExpanded &&
                provider.pendingUserInput != null &&
                provider.pendingUserInputCollapsed)
              Positioned(
                right: 14,
                bottom: 100,
                child: _PendingInputFab(onTap: provider.expandPendingUserInput),
              ),
            // Background tasks (mobile): draggable floating dock — same
            // primitive as the dispatch entry, independent persistence, and
            // it deterministically yields to the dispatch dock's anchor on
            // the same side so the two icons never overlap.
            if (provider.hasBackgroundTaskRows)
              BackgroundTasksFloatingDock(
                key: ValueKey('bg-${provider.sessionName}'),
                rows: provider.backgroundTaskRows(),
                onDismiss: provider.dismissBackgroundTask,
                obstacle: _dispatchAnchor,
                onAnchorChanged: (sideRight, top) {
                  final next = FloatingDockAnchor(sideRight: sideRight, top: top);
                  if (_backgroundAnchor == next) return;
                  _backgroundAnchor = next;
                  // 定时发送那个球排在这两个之后，读的是本帧之前的值 —— 同
                  // 样的 post-frame 提醒，让它下一帧就跟上。
                  WidgetsBinding.instance.addPostFrameCallback((_) {
                    if (mounted) setState(() {});
                  });
                },
                leftMinBottom: 96,
                rightMinBottom: _bgRightReserve(provider),
              ),
            if (provider.dispatchQueue.isNotEmpty)
              DispatchFloatingDock(
                key: ValueKey('dispatch-${provider.sessionName}'),
                entries: provider.dispatchQueue,
                resolveName: context.read<SessionManager>().sessionDisplayName,
                onRefresh: provider.refreshDispatchQueue,
                onOpenSession: _openDispatchSession,
                onExpandedChanged: (expanded) {
                  if (mounted) setState(() => _dispatchExpanded = expanded);
                },
                onAnchorChanged: (sideRight, top) {
                  final next = FloatingDockAnchor(
                    sideRight: sideRight,
                    top: top,
                  );
                  if (_dispatchAnchor == next) return;
                  _dispatchAnchor = next;
                  // The bg dock reads the obstacle on rebuild; nudge the view
                  // post-frame (never setState during a child's build) so the
                  // two icons re-separate promptly instead of waiting for the
                  // next provider notify.
                  WidgetsBinding.instance.addPostFrameCallback((_) {
                    if (mounted) setState(() {});
                  });
                },
                leftMinBottom: 96,
                rightMinBottom: _dispatchRightReserve(provider),
              ),
            // 定时发送的悬浮球：有待执行的消息才出现。排在最后、优先级最低，
            // 同侧要让位给派发和后台任务两个入口 —— 两个 anchor 一起递进去。
            if (_scheduledSend != null)
              ScheduledSendDock(
                key: ValueKey('schedule-${provider.sessionName}'),
                store: _scheduledSend!,
                onDraft: _readComposerDraft,
                obstacle: _dispatchAnchor,
                extraObstacles: [
                  if (_backgroundAnchor != null) _backgroundAnchor!,
                ],
                leftMinBottom: 96,
                rightMinBottom: _dispatchRightReserve(provider),
              ),
            Positioned.fill(
              child: ChatSidePanelStack(
                panels: _panels,
                settings: widget.settings,
                panelWidth: panelWidth,
              ),
            ),
          ],
        );
          },
        ),
      ),
    );
  }

  /// 悬浮球展开的面板要草稿时回头问输入框要。输入框还没挂载（第一帧）就给
  /// 空的 —— 面板会照常报「请先在输入框填写要发送的消息」。
  ScheduledSendDraft _readComposerDraft() =>
      _scheduleDraftSink.value?.call() ?? const ScheduledSendDraft(text: '');

  /// Bottom clearance the dispatch dock must respect when snapped to the
  /// right edge: the input bar always, plus the pending-input FAB when it is
  /// visible. The background-tasks dock is no longer a fixed right-side
  /// floater (it drifts with the user's drag; icon-vs-icon overlap is solved
  /// by the obstacle yield), so it no longer inflates this reserve.
  double _dispatchRightReserve(ChatProvider provider) {
    var reserve = 96.0;
    final pendingFab =
        provider.pendingUserInput != null && provider.pendingUserInputCollapsed;
    if (pendingFab) reserve = reserve < 160.0 ? 160.0 : reserve;
    return reserve;
  }

  /// Same, for the background-tasks dock (pending-input FAB sits right-bottom
  /// at ~160 when collapsed).
  double _bgRightReserve(ChatProvider provider) {
    return provider.pendingUserInput != null &&
            provider.pendingUserInputCollapsed
        ? 160.0
        : 96.0;
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
        backgroundColor: const Color(0xFFb64e43),
        smallSize: 10,
        alignment: const Alignment(0.4, -0.4),
        child: FloatingActionButton.small(
          heroTag: const Object(),
          onPressed: onTap,
          backgroundColor: const Color(0xFFfff8eb),
          foregroundColor: const Color(0xFFa85a25),
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
        final laneWidth = _chatLaneWidth(viewportWidth);
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
          backgroundColor: const Color(0xFFf8fbff),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(12),
            side: const BorderSide(color: Color(0xFFdce6f1)),
          ),
          title: Text(
            t('shareSession'),
            style: const TextStyle(color: Color(0xFF233249), fontSize: 16),
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
                      color: Color(0xFF6f8096),
                      fontSize: 12,
                    ),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    t('shareOperateWarn'),
                    style: const TextStyle(
                      color: Color(0xFFb4701f),
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
                      color: Color(0xFF233249),
                      fontSize: 14,
                    ),
                    decoration: InputDecoration(
                      hintText: t('sharePassword'),
                      hintStyle: const TextStyle(
                        color: Color(0xFF6f8096),
                        fontSize: 13,
                      ),
                      filled: true,
                      fillColor: const Color(0xFFf8fbff),
                      contentPadding: const EdgeInsets.symmetric(
                        horizontal: 12,
                        vertical: 10,
                      ),
                      border: const OutlineInputBorder(
                        borderRadius: BorderRadius.all(Radius.circular(8)),
                        borderSide: BorderSide(color: Color(0xFFdce6f1)),
                      ),
                    ),
                  ),
                  const SizedBox(height: 10),
                  // ── Expiry ──
                  Text(
                    t('shareExpiry'),
                    style: const TextStyle(
                      color: Color(0xFF6f8096),
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
                        backgroundColor: const Color(0xFF2ba67a),
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
                        color: Color(0xFFb64e43),
                        fontSize: 12,
                      ),
                    ),
                  ],
                  if (url != null) ...[
                    const SizedBox(height: 10),
                    Container(
                      padding: const EdgeInsets.all(10),
                      decoration: BoxDecoration(
                        color: const Color(0xFFf8fbff),
                        borderRadius: BorderRadius.circular(8),
                        border: Border.all(color: const Color(0xFFdce6f1)),
                      ),
                      child: Row(
                        children: [
                          Expanded(
                            child: SelectableText(
                              url!,
                              style: const TextStyle(
                                color: Color(0xFF005cc5),
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
                              color: Color(0xFF6f8096),
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
                      color: Color(0xFF6f8096),
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
                            color: Color(0xFF6f8096),
                          ),
                        ),
                      ),
                    )
                  else if (shares.isEmpty)
                    Text(
                      t('none'),
                      style: const TextStyle(
                        color: Color(0xFF6f8096),
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
                style: const TextStyle(color: Color(0xFF6f8096)),
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
          color: sel ? const Color(0xFFeaf4ff) : const Color(0xFFf8fbff),
          borderRadius: BorderRadius.circular(8),
          border: Border.all(
            color: sel ? const Color(0xFF1267b5) : const Color(0xFFdce6f1),
          ),
        ),
        child: Text(
          label,
          style: TextStyle(
            color: sel ? const Color(0xFF005cc5) : const Color(0xFF6f8096),
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
          color: sel ? const Color(0xFFeaf4ff) : const Color(0xFFf8fbff),
          borderRadius: BorderRadius.circular(6),
          border: Border.all(
            color: sel ? const Color(0xFF1267b5) : const Color(0xFFdce6f1),
          ),
        ),
        child: Text(
          label,
          style: TextStyle(
            color: sel ? const Color(0xFF005cc5) : const Color(0xFF6f8096),
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
      color: const Color(0xFFf8fbff),
      borderRadius: BorderRadius.circular(8),
      border: Border.all(color: const Color(0xFFdce6f1)),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Expanded(
              child: Text(
                '${_shareTypeLabel(s)}$expStr',
                style: const TextStyle(color: Color(0xFF005cc5), fontSize: 12),
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
              child: const Icon(Icons.copy, size: 16, color: Color(0xFF6f8096)),
            ),
            const SizedBox(width: 6),
            GestureDetector(
              onTap: onRevoke,
              child: const Icon(
                Icons.close_rounded,
                size: 18,
                color: Color(0xFFb64e43),
              ),
            ),
          ],
        ),
        const SizedBox(height: 4),
        Text(
          url,
          style: const TextStyle(
            color: Color(0xFF6f8096),
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
      backgroundColor: const Color(0xFFffffff),
      title: Text(
        t('mergeTitle'),
        style: const TextStyle(fontSize: 15, color: Color(0xFF20364d)),
      ),
      content: Text(
        t('mergeBody'),
        style: const TextStyle(color: Color(0xFF233249)),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context, false),
          child: Text(
            t('cancel'),
            style: const TextStyle(color: Color(0xFF6f8096)),
          ),
        ),
        TextButton(
          onPressed: () => Navigator.pop(context, true),
          child: Text(
            t('merge'),
            style: const TextStyle(
              color: Color(0xFF1267b5),
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

/// 「当前 worktree 有可合并内容」提示条 + 它的收起态（web 的 `#merge-hint`
/// 与 `chat-merge-hint.js`）。
///
/// 琥珀色横幅正好浮在输入区上方那排按钮上，所以给它一个让开的路：收起后只剩
/// 右边缘一颗贴边药丸，点回来即展开。收起状态由这个 widget 自己持有 —— web 也是
/// 让 controller 自己管（sessionStorage `multicc.mergeHintCollapsed`），调用点不需要
/// 知道「收没收起」。这里是页面存活期内的记忆，不落盘：一次临时让位不该跨启动粘住。
class MergeHintBar extends StatefulWidget {
  final String text;
  final VoidCallback onMerge;
  final VoidCallback onDiff;

  const MergeHintBar({
    super.key,
    required this.text,
    required this.onMerge,
    required this.onDiff,
  });

  @override
  State<MergeHintBar> createState() => _MergeHintBarState();
}

class _MergeHintBarState extends State<MergeHintBar> {
  bool _collapsed = false;

  @override
  Widget build(BuildContext context) {
    if (_collapsed) {
      return Align(
        alignment: Alignment.centerRight,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(10, 0, 10, 6),
          child: Material(
            key: const Key('merge-hint-fab'),
            color: const Color(0xFFa85a25),
            shape: const StadiumBorder(),
            elevation: 6,
            child: InkWell(
              customBorder: const StadiumBorder(),
              onTap: () => setState(() => _collapsed = false),
              child: Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: 12,
                  vertical: 7,
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const Icon(
                      Icons.merge_type_rounded,
                      size: 15,
                      color: Color(0xFFf4f8fd),
                    ),
                    const SizedBox(width: 6),
                    Text(
                      t('mergeContentReady'),
                      style: const TextStyle(
                        color: Color(0xFFf4f8fd),
                        fontSize: 11,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      );
    }
    return Container(
      margin: const EdgeInsets.fromLTRB(10, 0, 10, 6),
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      decoration: BoxDecoration(
        color: const Color(0xFFfff8eb),
        border: Border.all(color: const Color(0xFFa85a25)),
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
            color: Color(0xFFa85a25),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              widget.text,
              style: const TextStyle(color: Color(0xFFa85a25), fontSize: 12),
            ),
          ),
          TextButton(
            onPressed: widget.onDiff,
            style: TextButton.styleFrom(
              foregroundColor: const Color(0xFFa85a25),
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
              minimumSize: Size.zero,
              side: const BorderSide(color: Color(0xFFa85a25)),
            ),
            child: Text(
              t('viewDiff'),
              style: const TextStyle(fontWeight: FontWeight.w600),
            ),
          ),
          const SizedBox(width: 6),
          TextButton(
            onPressed: widget.onMerge,
            style: TextButton.styleFrom(
              foregroundColor: const Color(0xFFf4f8fd),
              backgroundColor: const Color(0xFFa85a25),
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
              minimumSize: Size.zero,
            ),
            child: Text(
              t('merge'),
              style: const TextStyle(fontWeight: FontWeight.w700),
            ),
          ),
          IconButton(
            key: const Key('merge-hint-collapse'),
            onPressed: () => setState(() => _collapsed = true),
            icon: const Icon(Icons.keyboard_arrow_down_rounded, size: 20),
            tooltip: t('mergeHintCollapse'),
            visualDensity: VisualDensity.compact,
            padding: EdgeInsets.zero,
            constraints: const BoxConstraints(minWidth: 26, minHeight: 26),
            color: const Color(0xFFa85a25),
          ),
        ],
      ),
    );
  }
}

// Persistent top banner shown while the session's worktree is behind its base
// branch — complements the transient SnackBar with an always-visible reminder.
/// AI 助手对当前会话的理解条（目标 · 阶段 · 状态），对齐 web 的
/// `#aux-classify-bar`。公开而非私有：两个动作药丸的显隐规则直接照抄 web 的
/// `can-mark-done`(W) / `can-cancel-task`(P) 两个 class，是条容易改坏的规则，
/// 需要能被 widget 测试直接钉住。
class AuxClassifyBar extends StatelessWidget {
  final String goal;
  final String phase;

  /// Live classify-state letter (D/W/B/E/P). Drives the pill tint, aligned
  /// with main_shell _classifyBadge and the web CLASSIFY_DISPLAY barTint.
  final String classifyState;

  /// Non-null when state is W: shows the localized turn-success button.
  /// The compatibility endpoint changes only turn outcome, never task lifecycle.
  final VoidCallback? onMarkTurnSucceeded;

  /// Non-null when state is P (processing): shows 「✕ 取消」. Web gates the same
  /// button on `can-cancel-task` and wires it to cancelStreaming().
  final VoidCallback? onCancelTurn;

  const AuxClassifyBar({
    required this.goal,
    required this.phase,
    required this.classifyState,
    this.onMarkTurnSucceeded,
    this.onCancelTurn,
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
        color: Color(0xFFf4f8fd),
        border: Border(bottom: BorderSide(color: Color(0xFFf8fbff))),
      ),
      child: Row(
        children: [
          const Icon(
            Icons.auto_awesome_outlined,
            size: 14,
            color: Color(0xFF8a9aab),
          ),
          const SizedBox(width: 6),
          Expanded(
            child: Tooltip(
              message: goal,
              child: Text(
                goal,
                style: const TextStyle(
                  color: Color(0xFF4a6076),
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
          // Cancel button: visible only when state is P (processing). Same slot
          // and same red tint as the web's ac-cancel-task pill; the action is
          // the composer's Stop — cancel the in-flight turn.
          if (onCancelTurn != null) ...[
            const SizedBox(width: 6),
            Tooltip(
              message: t('cancelTurnFromBarTitle'),
              child: GestureDetector(
                key: const Key('classify-cancel-turn'),
                onTap: onCancelTurn,
                child: Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 8,
                    vertical: 2,
                  ),
                  decoration: BoxDecoration(
                    color: const Color(0xFFfdf0ef),
                    borderRadius: BorderRadius.circular(6),
                    border: Border.all(color: const Color(0x88b64e43)),
                  ),
                  child: Text(
                    t('cancelTurnFromBar'),
                    style: const TextStyle(
                      color: Color(0xFFb64e43),
                      fontSize: 11,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
              ),
            ),
          ],
          // Turn-success button: visible only when state is W (waiting-for-user)
          if (onMarkTurnSucceeded != null) ...[
            const SizedBox(width: 6),
            GestureDetector(
              onTap: onMarkTurnSucceeded,
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                decoration: BoxDecoration(
                  color: const Color(0xFFedf8f1),
                  borderRadius: BorderRadius.circular(6),
                  border: Border.all(color: const Color(0x882ba67a)),
                ),
                child: Text(
                  t('markTurnSucceeded'),
                  style: const TextStyle(
                    color: Color(0xFF2ba67a),
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
          color: Color(0xFF233249),
          fontFamily: 'monospace',
          fontSize: 13,
        ),
        decoration: InputDecoration(
          hintText: '/path/to/project',
          hintStyle: const TextStyle(color: Color(0xFF8b9cae)),
          filled: true,
          fillColor: const Color(0xFFf4f8fd),
          border: OutlineInputBorder(borderRadius: BorderRadius.circular(6)),
          enabledBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(6),
            borderSide: const BorderSide(color: Color(0xFFdce6f1)),
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: Text(
            t('cancel'),
            style: const TextStyle(color: Color(0xFF6f8096)),
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
              color: Color(0xFF1267b5),
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
            color: const Color(0xFFf8fbff),
            borderRadius: BorderRadius.circular(10),
          ),
          child: Text(
            formatChatTime(time),
            style: const TextStyle(color: Color(0xFF6f8096), fontSize: 11),
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
    // 每轮勾选框挂在最后一条用户消息上（Web 的 `_lastUserBubble`）。没被手动
    // 勾过的那一轮跟随会话级开关，所以这里要读一次会话记录里的值。
    final sessionAutoCommit = context.select<SessionManager, bool>(
      (m) => sessionAutoCommitOf(m.sessions, provider.sessionName),
    );
    final lastUserTurnId = lastUserMessageId(messages);
    final admissionProgress = provider.admissionProgressText;
    // 「思考中」那一行的渲染条件收在 provider 上：调试面板也要问同一件事
    // （`stuck` 徽章 = thinking 还在屏幕上但已经不 streaming），两边各写一份
    // 迟早会漂移，而漂移正好会让这个面板失去意义。
    final showThinking = provider.thinkingIndicatorVisible;

    _scrollToBottom();

    return LayoutBuilder(
      builder: (context, constraints) {
        final viewportWidth = constraints.maxWidth.isFinite
            ? constraints.maxWidth
            : MediaQuery.of(context).size.width;
        final desktop = viewportWidth >= _chatDesktopBreakpoint;
        final contentWidth = _chatLaneWidth(viewportWidth);
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
                if (i == messages.length) {
                  return ThinkingIndicator(
                    label: admissionProgress ?? t('admissionProcessing'),
                  );
                }
                final msg = messages[i];
                // WeChat-style time separator: show a centered time label only when
                // this message is the first, or its gap from the previous message
                // exceeds the threshold — so back-to-back turns stay uncluttered.
                final prev = i > 0 ? messages[i - 1] : null;
                final showTime =
                    prev == null ||
                    msg.timestamp.difference(prev.timestamp).inMinutes.abs() >=
                        _timeSeparatorGapMinutes;
                // 只有最后一条用户消息挂每轮勾选框；其余气泡四个参数全走默认值，
                // 渲染结果跟没有这个功能时逐像素一致。
                final turnId = lastUserTurnId != null &&
                        msg.id == lastUserTurnId
                    ? lastUserTurnId
                    : null;
                final bubble = _maybeHighlight(
                  MessageBubble(
                    message: msg,
                    showAutoCommit: turnId != null,
                    autoCommitChecked: turnId != null &&
                        provider.turnAutoCommit(
                          turnId,
                          fallback: sessionAutoCommit,
                        ),
                    autoCommitDone: turnId != null &&
                        provider.isTurnAutoCommitted(turnId),
                    onAutoCommitChanged: turnId == null
                        ? null
                        : (v) => provider.setTurnAutoCommit(turnId, v),
                  ),
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
                      color: const Color(0xFFffffff),
                      border: Border.all(color: const Color(0xFFeef3f8)),
                      borderRadius: BorderRadius.circular(999),
                    ),
                    child: Text(
                      t('historyStart'),
                      style: const TextStyle(
                        color: Color(0xFF6f8096),
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
                      color: const Color(0xFFffffff),
                      border: Border.all(color: const Color(0xFFeef3f8)),
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
                            color: Color(0xFF6f8096),
                          ),
                        ),
                        const SizedBox(width: 6),
                        Text(
                          t('loadingEarlierMessages'),
                          style: const TextStyle(
                            color: Color(0xFF6f8096),
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
                        color: const Color(0xFF1267b5),
                        border: Border.all(color: const Color(0xFF1267b5)),
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

  static List<Map<String, dynamic>> _traceSources(Map<String, dynamic>? trace) {
    final raw = trace?['sources'];
    if (raw is! List) return const [];
    return raw
        .whereType<Map>()
        .map((value) => Map<String, dynamic>.from(value))
        .toList();
  }

  static int _traceCount(Map<String, dynamic>? trace) =>
      trace == null ? 0 : 1 + _traceSources(trace).length;

  static String _sourceMode(dynamic value) {
    final mode = value?.toString() ?? '';
    if (mode == 'refilled') return t('usageContextRefilled');
    if (RegExp(r'^(memory|context|task):').hasMatch(mode)) return contextSourceLabel(mode);
    // 任务图谱上下文的引用来源：mode 形如 graph:parent / graph:memory。
    final graph = RegExp(r'^graph:(.+)$').firstMatch(mode);
    if (graph != null) {
      final key = 'usageContextGraph${graph.group(1)![0].toUpperCase()}${graph.group(1)!.substring(1)}';
      final labeled = t(key);
      return labeled == key ? t('usageContextGraphTask') : labeled;
    }
    return t('usageContextImported');
  }

  static String _messageText(dynamic value) {
    if (value is String) return value;
    try {
      return jsonEncode(value);
    } catch (_) {
      return value?.toString() ?? '';
    }
  }

  static Widget _traceSection(
    Map<String, dynamic> trace, {
    bool loading = false,
    String error = '',
  }) {
    final current = trace['currentTask'] is Map
        ? Map<String, dynamic>.from(trace['currentTask'] as Map)
        : const <String, dynamic>{};
    final sources = _traceSources(trace);
    final children = <Widget>[
      const Divider(color: Color(0xFFdce6f1), height: 20),
      Row(
        children: [
          const Icon(Icons.link, size: 14, color: Color(0xFF005cc5)),
          const SizedBox(width: 5),
          Text(
            t('usageContextSources', {'n': '${1 + sources.length}'}),
            style: const TextStyle(color: Color(0xFF4a6076), fontSize: 12),
          ),
        ],
      ),
      const SizedBox(height: 7),
      Text(
        '${t('usageContextCurrent')} · ${t('usageContextNative')}',
        style: const TextStyle(color: Color(0xFF6f8096), fontSize: 10),
      ),
      SelectableText(
        (current['taskName'] ?? current['taskId'] ?? '').toString(),
        style: const TextStyle(color: Color(0xFF4a6076), fontSize: 12),
      ),
      SelectableText(
        (current['taskId'] ?? '').toString(),
        style: const TextStyle(color: Color(0xFF8a9aab), fontSize: 10),
      ),
    ];
    if (trace['budget'] is Map) children.add(ContextBudgetDetails(trace: trace));
    for (final source in sources) {
      final messages = source['messages'] is List
          ? (source['messages'] as List).whereType<Map>().toList()
          : const <Map>[];
      final count =
          (source['messageCount'] as num?)?.toInt() ?? messages.length;
      final tokens = (source['estimatedTokens'] as num?)?.toInt() ?? 0;
      final omitted = (source['omittedExchanges'] as num?)?.toInt() ?? 0;
      final isGraph = RegExp(r'^(graph|memory|task|context):').hasMatch('${source['mode']}');
      final subtitle =
          '${_sourceMode(source['mode'])}'
          '${isGraph ? '' : ' · ${t('usageContextMessages', {'n': '$count'})}'}'
          '${tokens > 0 ? ' · ${t('usageContextApproxTokens', {'n': _amount(tokens)})}' : ''}'
          '${omitted > 0 ? ' · ${t('usageContextOmitted', {'n': '$omitted'})}' : ''}${contextSourceMeta(source)}';
      children.add(
        ExpansionTile(
          tilePadding: EdgeInsets.zero,
          childrenPadding: const EdgeInsets.only(left: 8, bottom: 4),
          dense: true,
          title: Text(
            (source['taskName'] ?? source['taskId'] ?? '').toString(),
            style: const TextStyle(color: Color(0xFF4a6076), fontSize: 12),
          ),
          subtitle: Text(
            subtitle,
            style: const TextStyle(color: Color(0xFF6f8096), fontSize: 10),
          ),
          children: <List<String>>[
            ...messages.map((message) => [
                  message['role'] == 'user' ? t('tbRoleUser') : t('tbRoleAssistant'),
                  _messageText(message['content']),
                ]),
            // 图谱上下文来源没有消息，只有实际注入的那一行节选。
            if (source['excerpt'] is String
                && (source['excerpt'] as String).trim().isNotEmpty)
              [t('usageContextExcerpt'), (source['excerpt'] as String).trim()],
            if (source['path'] != null) [t('usageContextPath'), '${source['path']}'],
            if (source['reason'] != null) [t('usageContextReason'), '${source['reason']}'],
          ]
              .map((pair) => Padding(
                    padding: const EdgeInsets.only(bottom: 7),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        SizedBox(
                          width: 34,
                          child: Text(
                            pair[0],
                            style: const TextStyle(
                                color: Color(0xFF8a9aab), fontSize: 10),
                          ),
                        ),
                        Expanded(
                          child: SelectableText(
                            pair[1],
                            style: const TextStyle(
                                color: Color(0xFF6f8096), fontSize: 11),
                          ),
                        ),
                      ],
                    ),
                  ))
              .toList(),
        ),
      );
    }
    if (loading) {
      children.add(
        const Padding(
          padding: EdgeInsets.symmetric(vertical: 6),
          child: LinearProgressIndicator(minHeight: 2),
        ),
      );
    }
    if (error.isNotEmpty) {
      children.add(
        Text(
          error,
          style: const TextStyle(color: Color(0xFFb64e43), fontSize: 11),
        ),
      );
    }
    children.add(
      Padding(
        padding: const EdgeInsets.only(top: 7),
        child: Text(
          t('usageContextManagedScope'),
          style: const TextStyle(color: Color(0xFF8a9aab), fontSize: 10),
        ),
      ),
    );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: children,
    );
  }

  void _showDetail(BuildContext context, ChatProvider p) {
    final rows = _detailRows(p);
    final summaryTrace = p.contextTrace;
    if (rows.isEmpty && summaryTrace == null) return;
    final hasRemoteSources = _traceSources(summaryTrace).isNotEmpty;
    showDialog<void>(
      context: context,
      builder: (_) => AlertDialog(
        title: Text(
          t('usageDetailTitle'),
          style: const TextStyle(fontSize: 15),
        ),
        content: SizedBox(
          width: 520,
          child: SingleChildScrollView(
            child: FutureBuilder<Map<String, dynamic>>(
              initialData: summaryTrace,
              future: hasRemoteSources ? p.loadContextTrace() : null,
              builder: (context, snapshot) => Column(
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
                              color: Color(0xFF6f8096),
                              fontSize: 11,
                            ),
                          ),
                          const SizedBox(height: 2),
                          Text(
                            row[1],
                            style: const TextStyle(
                              color: Color(0xFF4a6076),
                              fontSize: 12,
                            ),
                          ),
                        ],
                      ),
                    ),
                  Text(
                    t('usageSessionHint'),
                    style: const TextStyle(
                      color: Color(0xFF8a9aab),
                      fontSize: 11,
                    ),
                  ),
                  if (snapshot.data != null)
                    _traceSection(
                      snapshot.data!,
                      loading:
                          snapshot.connectionState == ConnectionState.waiting,
                      error: snapshot.hasError
                          ? t('usageContextLoadFailed')
                          : '',
                    ),
                ],
              ),
            ),
          ),
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
    final trace = provider.contextTrace;
    final hasDetail = _detailRows(provider).isNotEmpty || trace != null;
    // Nothing measured yet: show no strip at all rather than an empty one.
    if (ctx.isEmpty && !hasDetail) return const SizedBox.shrink();

    return GestureDetector(
      onTap: hasDetail ? () => _showDetail(context, provider) : null,
      onLongPress: hasDetail ? () => _showDetail(context, provider) : null,
      behavior: HitTestBehavior.opaque,
      child: Container(
        color: const Color(0xFFf4f8fd),
        padding: const EdgeInsets.symmetric(vertical: 4, horizontal: 8),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            if (ctx.hasMeter) ...[
              Container(
                width: 56,
                height: 4,
                decoration: BoxDecoration(
                  color: const Color(0xFFf8fbff),
                  borderRadius: BorderRadius.circular(2),
                ),
                alignment: Alignment.centerLeft,
                child: FractionallySizedBox(
                  widthFactor: ctx.fraction,
                  child: Container(
                    decoration: BoxDecoration(
                      color: ctx.fraction >= 0.9
                          ? const Color(0xFFb4701f)
                          : const Color(0xFF2ba67a),
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
                style: const TextStyle(color: Color(0xFF8a9aab), fontSize: 11),
              ),
            ),
            if (hasDetail) ...[
              const SizedBox(width: 6),
              if (trace != null) ...[
                const Icon(Icons.link, size: 12, color: Color(0xFF8a9aab)),
                const SizedBox(width: 2),
                Text(
                  t('usageContextSources', {'n': '${_traceCount(trace)}'}),
                  style: const TextStyle(
                    color: Color(0xFF8a9aab),
                    fontSize: 11,
                  ),
                ),
              ] else
                Text(
                  t('usageDetail'),
                  style: const TextStyle(
                    color: Color(0xFF8b9cae),
                    fontSize: 11,
                  ),
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
          color: const Color(0xFFa85a25).withValues(alpha: _opacity.value),
          borderRadius: BorderRadius.circular(8),
        ),
        child: child,
      ),
      child: widget.child,
    );
  }
}
