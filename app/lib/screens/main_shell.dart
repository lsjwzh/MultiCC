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

  // 手机默认就展开（连页头一起盖）：顶部不留一条可拖的闲置区，把空间都留给聊天。
  // 收起 = 标题左侧那颗 ⌄、标题区域往下拖、或 Android 返回键（见 _collapse）。

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
    // Entrance: 直接从屏幕下沿升到满屏（默认展开，没有「盖内容区」的中间位）。
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) {
        _anim.animateTo(1.0, curve: Curves.easeOutCubic);
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

  void _onDragEnd(double velocity, double height) {
    final v = velocity / height; // fraction/sec; +down, -up
    if (v > 1.3 || _anim.value < _dismissBelow) {
      _collapse();
      return;
    }
    // 默认展开：不缩回中间位，没甩到底就弹回满屏。
    _anim.animateTo(1.0, curve: Curves.easeOutCubic);
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

    return AnimatedBuilder(
      animation: _anim,
      builder: (context, _) {
        final frac = _anim.value;
        // 满屏时把让出的状态栏补回来（聊天内容退到状态栏下面，不顶到刘海）。
        final topInset = statusBar * frac;
        final top = h * (1 - frac);

        return Stack(
          children: [
            // 遮罩只在收起/弹回的过程里露一下：满屏时它整块都在浮层底下。点它 = 收起。
            Positioned.fill(
              child: IgnorePointer(
                ignoring: (frac * 0.4) < 0.02,
                child: GestureDetector(
                  onTap: _collapse,
                  child: ColoredBox(
                    color: Colors.black.withValues(alpha: (1 - frac) * 0.5),
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
                // 齐平的一条边压在页头下面（对齐 Web `#chat-layer` 的 border-top）。
                decoration: const BoxDecoration(
                  color: Color(0xFFffffff),
                  border: Border(top: BorderSide(color: AppColors.line)),
                ),
                child: Column(
                  children: [
                    SizedBox(height: topInset),
                    Expanded(
                      // Top inset is already handled above, so neutralise
                      // ChatView's own SafeArea top (keep bottom for the
                      // keyboard).
                      child: MediaQuery(
                        data: mq.copyWith(padding: mq.padding.copyWith(top: 0)),
                        child: ChangeNotifierProvider<ChatProvider>.value(
                          value: widget.provider,
                          child: ChatView(
                            settings: widget.settings,
                            onCollapse: _collapse,
                            onSheetDragUpdate: (dy) => _onDrag(dy, h),
                            onSheetDragEnd: (v) => _onDragEnd(v, h),
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
