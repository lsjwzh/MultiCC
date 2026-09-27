import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:url_launcher/url_launcher.dart';

import '../providers/chat_provider.dart';
import '../providers/session_manager.dart';
import '../services/settings_service.dart';
import '../services/dashboard_workspace_coordinator.dart';
import '../services/dashboard_workspace_store.dart';
import '../services/voice_launch_service.dart';
import '../i18n.dart';
import '../theme.dart';
import '../utils/overlay_geometry.dart';
import '../widgets/directory_card.dart';
import '../widgets/air_tasks_view.dart';
import '../widgets/workspace_navigation_drawer.dart';
import 'agent_resources_screen.dart';
import 'bridge_settings_screen.dart';
import 'chat_screen.dart';
import '../widgets/chat_loading_view.dart';
import 'provider_screen.dart';
import 'push_settings_screen.dart';
import 'settings_screen.dart';
import 'cron_screen.dart';
import 'docs_registry_screen.dart';
import 'terminal_screen.dart';
import 'tunnel_settings_screen.dart';
import 'voice_settings_screen.dart';

class MainShell extends StatefulWidget {
  final SettingsService settings;
  const MainShell({super.key, required this.settings});

  @override
  State<MainShell> createState() => _MainShellState();
}

class _MainShellState extends State<MainShell> {
  late final DashboardWorkspaceStore _workspaceStore;
  late final DashboardWorkspaceCoordinator _workspaceCoordinator;
  SessionManager? _workspaceManager;

  @override
  void initState() {
    super.initState();
    _workspaceStore = DashboardWorkspaceStore(settings: widget.settings);
    _workspaceCoordinator = DashboardWorkspaceCoordinator(
      store: _workspaceStore,
    );
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final mgr = context.read<SessionManager>();
    if (identical(_workspaceManager, mgr)) return;
    _workspaceManager = mgr;
    _workspaceCoordinator.attach(
      source: mgr,
      readDirectoryIds: () => mgr.directories.map((dir) => dir.id),
      onNotify: mgr.handleWorkspaceNotify,
      onSessionCliChanged: () => mgr.loadDashboard(),
      onSessionUpdated: mgr.applySessionLabel,
      onDirectorySnapshot: (dirId, snapshot) {
        mgr.applyWorkspaceSnapshot(dirId, snapshot.statuses);
      },
    );
  }

  @override
  void dispose() {
    _workspaceCoordinator.dispose();
    _workspaceStore.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final mgr = context.watch<SessionManager>();
    final active = mgr.activeProvider;

    // A notification tap resolved to a terminal session — push its screen once
    // this frame is done (can't navigate during build).
    final pendingTerm = mgr.pendingTerminalSession;
    if (pendingTerm != null) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted || mgr.pendingTerminalSession != pendingTerm) return;
        mgr.clearPendingTerminal();
        Navigator.of(context).push(
          MaterialPageRoute(
            builder: (_) =>
                TerminalScreen(settings: widget.settings, session: pendingTerm),
          ),
        );
      });
    }

    // Home (multi-session dashboard) is ALWAYS mounted underneath. Opening a
    // session slides a draggable bottom sheet up over it (3/4 height, draggable
    // to fullscreen, draggable down to collapse back home). No page swap.
    return PopScope(
      // Only let the OS pop (exit) when nothing is layered on the dashboard.
      canPop: active == null && mgr.pendingChatOpen == null,
      onPopInvokedWithResult: (didPop, _) {
        if (didPop) return;
        // Back priority: close the pending chat request, then the open chat.
        if (mgr.pendingChatOpen != null) {
          mgr.cancelPendingChatOpen();
        } else if (active != null) {
          unawaited(mgr.requestCloseChat());
        }
      },
      child: Scaffold(
        backgroundColor: const Color(0xFFf4f8fd),
        // Keep the Stack full-height; the inner ChatView Scaffold handles the
        // keyboard inset (lifts the InputBar). If the outer Scaffold also
        // resized, the absolutely-positioned sheet would be pushed off-screen.
        resizeToAvoidBottomInset: false,
        body: Stack(
          children: [
            _DirectoryListBody(
              settings: widget.settings,
              workspaceStore: _workspaceStore,
            ),
            if (active != null)
              _ChatSheet(
                key: ValueKey(mgr.activeSessionId),
                settings: widget.settings,
                provider: active,
              ),
            if (mgr.pendingChatOpen case final pending?)
              Positioned.fill(
                child: ChatLoadingView(
                  title: pending.title,
                  error: pending.error,
                  onRetry: mgr.retryPendingChatOpen,
                  onClose: mgr.cancelPendingChatOpen,
                ),
              ),
          ],
        ),
      ),
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  CHAT SHEET — a draggable sheet hosting an open session over the home.
//
//  默认态盖满内容区（100%）：首页那根 AppBar 留在外面，它还是活的 —— ☰ 开抽屉、
//  状态徽章、⋯ 菜单都点得到，换下一个任务不用先把对话关掉。展开态才连页头（以及
//  状态栏）一起盖，控制条上那颗「收起」把它放回默认态。往下拖过一半就落回首页。
//
//  This mirrors the web console's `#chat-layer` (`public/air.js`): the directory
//  page underneath is never unmounted, the conversation is just a layer over it.
//  The chat's own message ListView keeps its scroll controller — only the bar
//  drives the sheet, so the two never fight.
// ═══════════════════════════════════════════════════════════════════════════════

// 停位与内容区顶端的定义与「为什么」在 utils/overlay_geometry.dart —— 对话浮层的
// 进场目标、拖动落点、遮罩边界都从这两个量来，写死一个比例就会和别处对不上。
double _overlaySnapFraction(BuildContext context) =>
    overlaySnapFraction(MediaQuery.of(context));
double _overlayContentTop(BuildContext context) =>
    overlayContentTop(MediaQuery.of(context));

class _ChatSheet extends StatefulWidget {
  final SettingsService settings;
  final ChatProvider provider;
  const _ChatSheet({super.key, required this.settings, required this.provider});

  @override
  State<_ChatSheet> createState() => _ChatSheetState();
}

class _ChatSheetState extends State<_ChatSheet>
    with SingleTickerProviderStateMixin {
  // _anim.value == visible fraction of the screen the sheet covers (0 → 1).
  late final AnimationController _anim;
  bool _collapsing = false;

  // 展开态：连页头一起盖（真满屏）。默认态停在内容区顶端，页头留在外面 —— 所以
  // 只有展开之后页头才是点不到的，控制条上的「收起」是那会儿的出口。
  bool _expanded = false;

  // 收起时要用的 manager（`dispose` 里不能读 context，摘注册只能靠它）。
  SessionManager? _mgr;

  // Deep-link focus captured once from the SessionManager when this sheet
  // mounts (task-board "jump to message"). Forwarded to ChatView; null for a
  // normal open -> ChatView's focus path stays dormant.
  bool _focusCaptured = false;
  String? _focusMessageId;

  static const double _dismissBelow = 0.5; // drag below this → collapse home

  @override
  void initState() {
    super.initState();
    _anim = AnimationController(
      vsync: this,
      lowerBound: 0,
      upperBound: 1,
      duration: const Duration(milliseconds: 260),
    );
    // Entrance: 从屏幕下沿升到默认位（盖满内容区）。
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) {
        _anim.animateTo(
          _overlaySnapFraction(context),
          curve: Curves.easeOutCubic,
        );
      }
    });
    // 返回键、以及首页的 ☰ 要「先收对话再干下一件事」时走这条路（见
    // SessionManager.requestCloseChat）：直接把 activeSession 清掉，这一层会被
    // 从树上抽走 —— 它是「啪」地消失，不是滑下去。
    final mgr = context.read<SessionManager>();
    _mgr = mgr;
    mgr.chatCollapseHandler = _collapse;
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    // Capture the pending deep-link focus once (the SessionManager stashed it
    // just before activating this session). didChangeDependencies is the safe
    // place to read providers; the guard makes it a one-shot so a later
    // dependency change never re-consumes a (now empty) stash.
    if (!_focusCaptured) {
      _focusCaptured = true;
      _focusMessageId = context.read<SessionManager>().consumeFocusMessage(
        widget.provider.sessionName,
      );
    }
  }

  @override
  void dispose() {
    // 只摘掉自己注册的那一个：换会话会把这一层换成新的 key，而新 State 的
    // initState 先跑、旧 State 的 dispose 后跑 —— 无条件清会把新注册的那份抹掉。
    if (_mgr?.chatCollapseHandler == _collapse) {
      _mgr!.chatCollapseHandler = null;
    }
    _anim.dispose();
    super.dispose();
  }

  void _onDrag(double dy, double height) {
    _anim.stop();
    _anim.value = (_anim.value - dy / height).clamp(0.0, 1.0);
  }

  void _onDragEnd(double velocity, double height, double snapDefault) {
    final v = velocity / height; // fraction/sec; +down, -up
    double target;
    if (v > 1.3) {
      // 往下甩：默认位以上就停在默认位，否则一路落回首页。
      target = _anim.value < snapDefault ? 0.0 : snapDefault;
    } else if (v < -1.3) {
      target = 1.0; // 往上甩 = 展开
    } else if (_anim.value < _dismissBelow) {
      target = 0.0;
    } else if (_anim.value < (snapDefault + 1.0) / 2) {
      target = snapDefault;
    } else {
      target = 1.0;
    }
    if (target == 0.0) {
      _collapse();
      return;
    }
    // 拖出来的落点也要让控制条上的按钮跟着换（拖到底 ≠ 只在按钮上点过）。
    if (_expanded != (target == 1.0)) setState(() => _expanded = target == 1.0);
    _anim.animateTo(target, curve: Curves.easeOutCubic);
  }

  /// 展开 / 收起：默认位（盖满内容区，页头留着）与满屏（连页头一起盖）之间走一趟。
  void _toggleExpanded() {
    final next = !_expanded;
    setState(() => _expanded = next);
    _anim.animateTo(
      next ? 1.0 : _overlaySnapFraction(context),
      curve: Curves.easeOutCubic,
    );
  }

  // Animate the sheet down, then drop the active session → back to the home.
  void _collapse() {
    if (_collapsing) return;
    _collapsing = true;
    // manager 先取好：动画结束时这一层可能已经被换掉（换会话），那时再
    // context.read 就不合法了，而等着开抽屉的人还要被叫醒。
    final mgr = _mgr;
    _anim.animateTo(0.0, curve: Curves.easeInCubic).then((_) {
      if (mounted) mgr?.goToSessionList();
      mgr?.notifyLayerCollapsed();
    });
  }

  @override
  Widget build(BuildContext context) {
    final mq = MediaQuery.of(context);
    final h = mq.size.height;
    final statusBar = mq.padding.top;
    final contentTop = _overlayContentTop(context);
    final snapDefault = _overlaySnapFraction(context);

    return AnimatedBuilder(
      animation: _anim,
      builder: (context, _) {
        final frac = _anim.value;
        // 默认位往上到满屏这一段：展开态头一件事是把让出去的状态栏补回来（页头
        // 被盖住了，聊天内容得退到状态栏下面，不然第一行顶到刘海里去）。
        final fullProg = ((frac - snapDefault) / (1 - snapDefault)).clamp(
          0.0,
          1.0,
        );
        final topInset = statusBar * fullProg;
        final top = h * (1 - frac);
        // 遮罩跟着升起来淡入，默认位时整块都在浮层底下（看不见），只在升降过程里
        // 露一下。它永远不越过内容区顶端 —— 页头留着给人点，就不能被压暗、更不能
        // 被它吃掉点击。点它 = 收起对话。
        final scrimOp = (frac / snapDefault).clamp(0.0, 1.0) * 0.5;

        return Stack(
          children: [
            Positioned(
              top: contentTop,
              left: 0,
              right: 0,
              bottom: 0,
              child: IgnorePointer(
                ignoring: scrimOp < 0.02,
                child: GestureDetector(
                  onTap: _collapse,
                  child: ColoredBox(
                    color: Colors.black.withValues(alpha: scrimOp),
                  ),
                ),
              ),
            ),
            Positioned(
              left: 0,
              right: 0,
              top: top,
              height: h - top,
              child: Container(
                // 齐平的一条边压在页头下面（对齐 Web `#chat-layer` 的 border-top），
                // 不再是「浮在半空的圆角卡片」—— 这一层现在盖满整个内容区。
                decoration: const BoxDecoration(
                  color: Color(0xFFffffff),
                  border: Border(top: BorderSide(color: AppColors.line)),
                ),
                child: Column(
                  children: [
                    SizedBox(height: topInset),
                    _ChatSheetBar(
                      expanded: _expanded,
                      onToggleExpand: _toggleExpanded,
                      onDrag: (dy) => _onDrag(dy, h),
                      onDragEnd: (v) => _onDragEnd(v, h, snapDefault),
                    ),
                    Expanded(
                      // Top inset is already handled by the bar above, so
                      // neutralise ChatView's own SafeArea top (keep bottom
                      // for the keyboard).
                      child: MediaQuery(
                        data: mq.copyWith(padding: mq.padding.copyWith(top: 0)),
                        child: ChangeNotifierProvider<ChatProvider>.value(
                          value: widget.provider,
                          child: ChatView(
                            settings: widget.settings,
                            onCollapse: _collapse,
                            focusMessageId: _focusMessageId,
                          ),
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ],
        );
      },
    );
  }
}

// 浮层顶上的控制条：中间那条拖柄（整条都能拖，往下甩 = 关掉对话），右边一颗
// 「展开 / 收起」。默认态页头还在外面，所以这一条不需要「关闭」—— 收起是聊天页
// 自己那颗 ⌄、这条拖柄、以及 Android 返回键的事。
class _ChatSheetBar extends StatelessWidget {
  final void Function(double dy) onDrag;
  final void Function(double velocity) onDragEnd;
  final bool expanded;
  final VoidCallback onToggleExpand;
  const _ChatSheetBar({
    required this.onDrag,
    required this.onDragEnd,
    required this.expanded,
    required this.onToggleExpand,
  });

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onVerticalDragUpdate: (d) => onDrag(d.delta.dy),
      onVerticalDragEnd: (d) => onDragEnd(d.velocity.pixelsPerSecond.dy),
      child: Container(
        // 满宽要写明：这一条挂在 Column 底下（crossAxisAlignment 默认 center），
        // 不给宽度它就缩成里面那条拖柄的 42px —— 白底和那条细线也跟着缩水。
        width: double.infinity,
        height: 36,
        decoration: const BoxDecoration(
          color: AppColors.panel,
          border: Border(bottom: BorderSide(color: AppColors.line)),
        ),
        child: Stack(
          alignment: Alignment.center,
          children: [
            // 拖柄真居中（两边摆什么按钮都不影响它）。
            Container(
              width: 42,
              height: 4,
              decoration: BoxDecoration(
                color: const Color(0xFF8b9cae),
                borderRadius: BorderRadius.circular(2),
              ),
            ),
            Positioned(
              right: 6,
              child: TextButton.icon(
                key: const ValueKey('chat-sheet-expand'),
                onPressed: onToggleExpand,
                icon: Icon(
                  expanded
                      ? Icons.close_fullscreen_rounded
                      : Icons.open_in_full_rounded,
                  size: 15,
                ),
                label: Text(
                  expanded ? '收起' : '展开',
                  style: const TextStyle(fontSize: 12),
                ),
                style: TextButton.styleFrom(
                  foregroundColor: expanded
                      ? AppColors.blue
                      : const Color(0xFF47617c),
                  backgroundColor: expanded ? const Color(0xFFe6f1fc) : null,
                  minimumSize: const Size(0, 28),
                  padding: const EdgeInsets.symmetric(horizontal: 10),
                  tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  DASHBOARD — full view when no chat is active
// ═══════════════════════════════════════════════════════════════════════════════

class _DirectoryListBody extends StatefulWidget {
  final SettingsService settings;
  final DashboardWorkspaceStore workspaceStore;
  const _DirectoryListBody({
    required this.settings,
    required this.workspaceStore,
  });

  @override
  State<_DirectoryListBody> createState() => _DirectoryListBodyState();
}

class _DirectoryListBodyState extends State<_DirectoryListBody> {
  // Machine-wide voice entry. No sourceSessionId is sent, which is exactly what
  // tells the Host to route through the global voice router instead of a chat.
  Future<void> _openGlobalVoice() async {
    final result = await VoiceLaunchService(settings: widget.settings).launch();
    if (!mounted || result.ok) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          result.message ?? VoiceLaunchService.describe(result.errorCode),
        ),
        backgroundColor: const Color(0xFFb64e43),
      ),
    );
  }

  // Shared route builders: keep each switch case a two-liner (3k line budget).
  MaterialPageRoute<void> _routeTo(WidgetBuilder builder) =>
      MaterialPageRoute<void>(builder: builder);

  MaterialPageRoute<void> _agentResourcesRoute(
    AgentResourcesInitialSection section,
  ) => _routeTo(
    (_) => AgentResourcesScreen(
      settings: widget.settings,
      initialSection: section,
    ),
  );

  void _openNavigationDestination(WorkspaceDestination destination) {
    final route = switch (destination) {
      WorkspaceDestination.cron => _routeTo(
        (_) => CronScreen(settings: widget.settings),
      ),
      WorkspaceDestination.docs => _routeTo(
        (_) => DocsRegistryScreen(settings: widget.settings),
      ),
      WorkspaceDestination.voice => _routeTo(
        (_) => VoiceSettingsScreen(settings: widget.settings),
      ),
      WorkspaceDestination.goal => _routeTo(
        (_) => SettingsScreen(
          settings: widget.settings,
          initialSection: SettingsInitialSection.goal,
        ),
      ),
      WorkspaceDestination.provider => _routeTo(
        (_) => ProviderScreen(settings: widget.settings),
      ),
      WorkspaceDestination.global => _routeTo(
        (_) => SettingsScreen(settings: widget.settings),
      ),
      WorkspaceDestination.push => _routeTo(
        (_) => PushSettingsScreen(settings: widget.settings),
      ),
      WorkspaceDestination.tunnel => _routeTo(
        (_) => TunnelSettingsScreen(settings: widget.settings),
      ),
      WorkspaceDestination.bridges => _routeTo(
        (_) => BridgeSettingsScreen(settings: widget.settings),
      ),
      WorkspaceDestination.resources => _agentResourcesRoute(
        AgentResourcesInitialSection.resources,
      ),
      WorkspaceDestination.skillSync => _agentResourcesRoute(
        AgentResourcesInitialSection.skillSync,
      ),
      WorkspaceDestination.storage => _agentResourcesRoute(
        AgentResourcesInitialSection.storage,
      ),
      WorkspaceDestination.overview || WorkspaceDestination.memory => null,
    };

    if (destination == WorkspaceDestination.memory) {
      unawaited(_openWebMemoryGraph());
    } else if (route != null) {
      Navigator.of(context).push(route);
    }
  }

  Future<void> _openWebMemoryGraph() async {
    final token = widget.settings.token.trim();
    final uri = Uri.parse(widget.settings.buildHttpUrl('/manage')).replace(
      queryParameters: {'view': 'memory', if (token.isNotEmpty) 'token': token},
    );
    final opened = await launchUrl(uri, mode: LaunchMode.externalApplication);
    if (!opened && mounted) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(t('openBrowserFailed'))));
    }
  }

  @override
  Widget build(BuildContext context) {
    // Air 自带完整的壳（侧栏、任务头部、主区），这里不再给它套一层 Scaffold：
    // 两层 AppBar 会并排出现，两个抽屉也会互相盖住。
    // ☰ 要开的是内层 Scaffold 自己的抽屉，而对话浮层挂在它上面 —— 先让浮层滑落，
    // 抽屉才不会被压在底下（屏幕上什么也看不到）。
    final mgr = context.read<SessionManager>();
    return AirTasksView(
      settings: widget.settings,
      onOpenDestination: _openNavigationDestination,
      // 语音通话是原生独占的（麦克风要 HTTPS），老首页那一版入口随整块首页
      // 一起下线了，这里把它接回 Air 侧栏。
      onOpenVoiceCall: _openGlobalVoice,
      beforeOpenNavigation: () async {
        if (mgr.activeSessionId != null) {
          await mgr.requestCloseChat();
        }
      },
    );
  }
}

// Compact per-directory event timeline for the status board.
// Collapsed by default (a "🕔 活动 (N) ▾" bar); tap to expand the recent events.
// Keeps the project card compact — the timeline used to always show 8 rows.
class EventTimeline extends StatefulWidget {
  final List<Map<String, dynamic>> events;
  final bool initiallyOpen;
  final int? maxEvents;
  final double? maxExpandedHeight;
  const EventTimeline({
    super.key,
    required this.events,
    this.initiallyOpen = false,
    this.maxEvents = 8,
    this.maxExpandedHeight,
  });

  @override
  State<EventTimeline> createState() => _EventTimelineState();
}

class _EventTimelineState extends State<EventTimeline> {
  late bool _open = widget.initiallyOpen;

  @override
  Widget build(BuildContext context) {
    if (widget.events.isEmpty) return const SizedBox.shrink();
    final source = widget.events.reversed;
    final recent = widget.maxEvents == null
        ? source.toList()
        : source.take(widget.maxEvents!).toList();
    return Container(
      margin: const EdgeInsets.fromLTRB(14, 10, 14, 0),
      decoration: BoxDecoration(
        color: const Color(0xFFf4f8fd),
        border: Border.all(color: const Color(0xFFf8fbff)),
        borderRadius: BorderRadius.circular(6),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          InkWell(
            onTap: () => setState(() => _open = !_open),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
              child: Row(
                children: [
                  const Text('🕔 ', style: TextStyle(fontSize: 11)),
                  Text(
                    '活动 (${widget.events.length})',
                    style: const TextStyle(
                      color: Color(0xFF8a9aab),
                      fontSize: 11,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const Spacer(),
                  Icon(
                    _open
                        ? Icons.expand_less_rounded
                        : Icons.expand_more_rounded,
                    size: 16,
                    color: const Color(0xFF8a9aab),
                  ),
                ],
              ),
            ),
          ),
          if (_open) _buildOpenEvents(recent),
        ],
      ),
    );
  }

  Widget _buildOpenEvents(List<Map<String, dynamic>> recent) {
    final content = Padding(
      padding: const EdgeInsets.fromLTRB(10, 0, 10, 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          for (final e in recent)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 1),
              child: Text(
                directoryEventLabel(e),
                style: const TextStyle(color: Color(0xFF6f8096), fontSize: 11),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
            ),
        ],
      ),
    );
    final maxHeight = widget.maxExpandedHeight;
    if (maxHeight == null) return content;
    return ConstrainedBox(
      constraints: BoxConstraints(maxHeight: maxHeight),
      child: SingleChildScrollView(child: content),
    );
  }
}
