import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:url_launcher/url_launcher.dart';

import '../models/message.dart';
import '../providers/chat_provider.dart';
import '../providers/session_manager.dart';
import '../services/settings_service.dart';
import '../services/manage_service.dart';
import '../services/session_service.dart';
import '../services/dashboard_workspace_coordinator.dart';
import '../services/dashboard_workspace_store.dart';
import '../services/workspace_service.dart';
import '../services/voice_launch_service.dart';
import '../i18n.dart';
import '../theme.dart';
import '../utils/manual_order.dart';
import '../utils/session_status_helpers.dart';
import '../utils/status_presentation.dart';
import '../widgets/directory_card.dart';
import '../widgets/session_card.dart';
import '../widgets/session_badges.dart';
import '../widgets/kpi_tile.dart';
import '../widgets/task_board_view.dart';
import '../widgets/create_session_dialog.dart';
import '../widgets/uncommitted_files_dialog.dart';
import '../widgets/workspace_navigation_drawer.dart';
import 'agent_resources_screen.dart';
import 'bridge_settings_screen.dart';
import 'chat_screen.dart';
import 'provider_screen.dart';
import 'push_settings_screen.dart';
import 'memo_screen.dart';
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
    final fleetOpen = mgr.activeFleetDirId != null;
    return PopScope(
      // Only let the OS pop (exit) when nothing is layered on the dashboard.
      canPop: active == null && !fleetOpen,
      onPopInvokedWithResult: (didPop, _) {
        if (didPop) return;
        // Back priority: close the active chat first, then the fleet panel.
        if (active != null) {
          mgr.goToSessionList();
        } else if (fleetOpen) {
          // Routes through the panel's own collapse animation when it is
          // mounted, so back exits the same way a drag-down does.
          mgr.requestCloseFleetDir();
        }
      },
      child: Scaffold(
        backgroundColor: const Color(0xFF070809),
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
            // Fleet (directory) detail panel - lives in the Stack UNDER the chat
            // sheet. Opening a session from it overlays the chat on top; closing
            // the chat returns here (not to the bare dashboard).
            if (mgr.activeFleetDirId != null)
              _FleetDetailSheet(
                key: ValueKey('fleet-${mgr.activeFleetDirId}'),
                settings: widget.settings,
                mgr: mgr,
                dirId: mgr.activeFleetDirId!,
                workspaceStore: _workspaceStore,
              ),
            if (active != null)
              _ChatSheet(
                key: ValueKey(mgr.activeSessionId),
                settings: widget.settings,
                provider: active,
              ),
          ],
        ),
      ),
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  CHAT SHEET — a draggable bottom sheet hosting an open session over the home.
//  Default height 3/4; drag the handle up to go fullscreen, down to collapse
//  back to the dashboard. The chat's own message ListView keeps its scroll
//  controller — only the handle drives the sheet, so the two never fight.
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

  // Deep-link focus captured once from the SessionManager when this sheet
  // mounts (task-board "jump to message"). Forwarded to ChatView; null for a
  // normal open -> ChatView's focus path stays dormant.
  bool _focusCaptured = false;
  String? _focusMessageId;

  static const double _snapHalf =
      0.9; // default opened height (matches fleet panel)
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
    // Entrance: slide up from the bottom to the 3/4 snap.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _anim.animateTo(_snapHalf, curve: Curves.easeOutCubic);
    });
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
      _focusMessageId = context
          .read<SessionManager>()
          .consumeFocusMessage(widget.provider.sessionName);
    }
  }

  @override
  void dispose() {
    _anim.dispose();
    super.dispose();
  }

  void _onDrag(double dy, double height) {
    _anim.stop();
    _anim.value = (_anim.value - dy / height).clamp(0.0, 1.0);
  }

  void _onDragEnd(double velocity, double height) {
    final v = velocity / height; // fraction/sec; +down, -up
    double target;
    if (v > 1.3) {
      target = _anim.value < _snapHalf ? 0.0 : _snapHalf;
    } else if (v < -1.3) {
      target = 1.0;
    } else if (_anim.value < _dismissBelow) {
      target = 0.0;
    } else if (_anim.value < (_snapHalf + 1.0) / 2) {
      target = _snapHalf;
    } else {
      target = 1.0;
    }
    if (target == 0.0) {
      _collapse();
    } else {
      _anim.animateTo(target, curve: Curves.easeOutCubic);
    }
  }

  // Animate the sheet down, then drop the active session → back to the home.
  void _collapse() {
    if (_collapsing) return;
    _collapsing = true;
    _anim.animateTo(0.0, curve: Curves.easeInCubic).then((_) {
      if (mounted) context.read<SessionManager>().goToSessionList();
    });
  }

  @override
  Widget build(BuildContext context) {
    final mq = MediaQuery.of(context);
    final h = mq.size.height;

    return AnimatedBuilder(
      animation: _anim,
      builder: (context, _) {
        final frac = _anim.value;
        final scrimOp = (frac.clamp(0.0, _snapHalf) / _snapHalf) * 0.5;
        final fullProg = ((frac - _snapHalf) / (1 - _snapHalf)).clamp(0.0, 1.0);
        final topInset = mq.padding.top * fullProg; // status-bar gap near full
        final radius = (1 - fullProg) * 18;
        final top = h * (1 - frac);

        return Stack(
          children: [
            // Dim scrim over the home; tap to collapse.
            Positioned.fill(
              child: IgnorePointer(
                ignoring: scrimOp < 0.02,
                child: GestureDetector(
                  onTap: _collapse,
                  child: Container(
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
              child: ClipRRect(
                borderRadius: BorderRadius.vertical(
                  top: Radius.circular(radius),
                ),
                child: Container(
                  color: const Color(0xFF0f1115),
                  child: Column(
                    children: [
                      SizedBox(height: topInset),
                      _SheetHandle(
                        onDrag: (dy) => _onDrag(dy, h),
                        onDragEnd: (v) => _onDragEnd(v, h),
                      ),
                      Expanded(
                        // Top inset is already handled by the handle above, so
                        // neutralise ChatView's own SafeArea top (keep bottom
                        // for the keyboard).
                        child: MediaQuery(
                          data: mq.copyWith(
                            padding: mq.padding.copyWith(top: 0),
                          ),
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
            ),
          ],
        );
      },
    );
  }
}

// Grabber bar at the top of the chat sheet. Vertical drags resize/dismiss the
// sheet; it never touches the message list's own scrolling.
class _SheetHandle extends StatelessWidget {
  final void Function(double dy) onDrag;
  final void Function(double velocity) onDragEnd;
  const _SheetHandle({required this.onDrag, required this.onDragEnd});

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onVerticalDragUpdate: (d) => onDrag(d.delta.dy),
      onVerticalDragEnd: (d) => onDragEnd(d.velocity.pixelsPerSecond.dy),
      child: Container(
        width: double.infinity,
        color: const Color(0xFF0f1115),
        padding: const EdgeInsets.symmetric(vertical: 9),
        alignment: Alignment.center,
        child: Container(
          width: 42,
          height: 4,
          decoration: BoxDecoration(
            color: const Color(0xFF454b54),
            borderRadius: BorderRadius.circular(2),
          ),
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
  // Cached provider list (with aliasMap) so session model labels in the KPI
  // sheet can show an alias-mapped relay's real name (e.g. GLM5.2).
  List<Map<String, dynamic>> _providers = [];

  // Number of scheduled tasks behind the workspace-bar cron tile. Stays null
  // when the fetch fails or hasn't landed, which keeps the tile a plain link
  // rather than claiming there are zero tasks.
  int? _cronCount;

  Future<void> _loadProviders() async {
    try {
      final d = await ManageService(settings: widget.settings).fetchProviders();
      if (!mounted) return;
      setState(() {
        _providers = (d['providers'] as List? ?? [])
            .map((e) => (e as Map).cast<String, dynamic>())
            .toList();
      });
    } catch (_) {}
  }

  Future<void> _loadCronCount() async {
    try {
      final tasks = await ManageService(
        settings: widget.settings,
      ).fetchCronTasks();
      if (!mounted) return;
      setState(() => _cronCount = tasks.length);
    } catch (_) {
      // Drop back to unknown rather than leaving the last good number on the
      // tile — a refetch that fails after a delete would otherwise keep
      // claiming tasks that are gone.
      if (mounted) setState(() => _cronCount = null);
    }
  }

  @override
  void initState() {
    super.initState();
    _loadProviders();
    _loadCronCount();
    widget.settings.advancedMode.addListener(_handleExperienceModeChanged);
  }

  void _handleExperienceModeChanged() {
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    widget.settings.advancedMode.removeListener(_handleExperienceModeChanged);
    super.dispose();
  }

  // Machine-wide voice entry. No sourceSessionId is sent, which is exactly what
  // tells the Host to route through the global voice router instead of a chat.
  Future<void> _openGlobalVoice() async {
    final result = await VoiceLaunchService(settings: widget.settings).launch();
    if (!mounted || result.ok) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(result.message ?? VoiceLaunchService.describe(result.errorCode)),
        backgroundColor: const Color(0xFFff6b63),
      ),
    );
  }

  void _openNavigationDestination(WorkspaceDestination destination) {
    final route = switch (destination) {
      WorkspaceDestination.cron => MaterialPageRoute<void>(
          builder: (_) => CronScreen(settings: widget.settings),
        ),
      WorkspaceDestination.docs => MaterialPageRoute<void>(
          builder: (_) => DocsRegistryScreen(settings: widget.settings),
        ),
      WorkspaceDestination.voice => MaterialPageRoute<void>(
          builder: (_) => VoiceSettingsScreen(settings: widget.settings),
        ),
      WorkspaceDestination.goal => MaterialPageRoute<void>(
          builder: (_) => SettingsScreen(
            settings: widget.settings,
            initialSection: SettingsInitialSection.goal,
          ),
        ),
      WorkspaceDestination.provider => MaterialPageRoute<void>(
          builder: (_) => ProviderScreen(settings: widget.settings),
        ),
      WorkspaceDestination.global => MaterialPageRoute<void>(
          builder: (_) => SettingsScreen(settings: widget.settings),
        ),
      WorkspaceDestination.push => MaterialPageRoute<void>(
          builder: (_) => PushSettingsScreen(settings: widget.settings),
        ),
      WorkspaceDestination.tunnel => MaterialPageRoute<void>(
          builder: (_) => TunnelSettingsScreen(settings: widget.settings),
        ),
      WorkspaceDestination.bridges => MaterialPageRoute<void>(
          builder: (_) => BridgeSettingsScreen(settings: widget.settings),
        ),
      WorkspaceDestination.resources => MaterialPageRoute<void>(
          builder: (_) => AgentResourcesScreen(
            settings: widget.settings,
            initialSection: AgentResourcesInitialSection.resources,
          ),
        ),
      WorkspaceDestination.skillSync => MaterialPageRoute<void>(
          builder: (_) => AgentResourcesScreen(
            settings: widget.settings,
            initialSection: AgentResourcesInitialSection.skillSync,
          ),
        ),
      WorkspaceDestination.storage => MaterialPageRoute<void>(
          builder: (_) => AgentResourcesScreen(
            settings: widget.settings,
            initialSection: AgentResourcesInitialSection.storage,
          ),
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
      queryParameters: {
        'view': 'memory',
        if (token.isNotEmpty) 'token': token,
      },
    );
    final opened = await launchUrl(uri, mode: LaunchMode.externalApplication);
    if (!opened && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(t('openBrowserFailed'))),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final mgr = context.watch<SessionManager>();

    return Scaffold(
      backgroundColor: const Color(0xFF070809),
      drawer: WorkspaceNavigationDrawer(
        selected: WorkspaceDestination.overview,
        serverLabel: widget.settings.host,
        workspaceCount: mgr.directories.length,
        cronCount: _cronCount,
        advancedMode: widget.settings.advancedMode.value,
        onAdvancedModeChanged: widget.settings.setAdvancedMode,
        onSelected: _openNavigationDestination,
      ),
      // AppBar
      appBar: AppBar(
        backgroundColor: const Color(0xFF0f1115),
        foregroundColor: const Color(0xFFe7eaee),
        elevation: 0,
        centerTitle: false,
        leading: Builder(
          builder: (drawerContext) => IconButton(
            key: const ValueKey('workspace-menu-button'),
            icon: const Icon(Icons.menu_rounded),
            tooltip: t('menu'),
            onPressed: () => Scaffold.of(drawerContext).openDrawer(),
          ),
        ),
        title: Row(
          children: [
            RichText(
              text: const TextSpan(
                style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold),
                children: [
                  TextSpan(
                    text: 'Multi',
                    style: TextStyle(color: Color(0xFF3ad6c5)),
                  ),
                  TextSpan(
                    text: 'CC',
                    style: TextStyle(color: Color(0xFF6aa3ff)),
                  ),
                ],
              ),
            ),
            if (MediaQuery.sizeOf(context).width >= 430) ...[
              const SizedBox(width: 8),
              Flexible(
                child: Text(
                  t('dirs_sessions', {
                    'dirs': '${mgr.directories.length}',
                    'sessions': '${mgr.sessions.where((s) => !s.isAux).length}',
                  }),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    color: Color(0xFF8a909b),
                    fontSize: 12,
                    fontWeight: FontWeight.normal,
                  ),
                ),
              ),
            ],
          ],
        ),
        actions: [
          IconButton(
            icon: const Icon(Icons.add_rounded, size: 22),
            tooltip: t('newDirectory'),
            onPressed: () => _showNewDirectoryDialog(context, mgr),
          ),
          IconButton(
            icon: const Icon(Icons.refresh_rounded, size: 20),
            tooltip: t('refresh'),
            onPressed: () {
              mgr.loadDashboard();
              _loadCronCount();
            },
          ),
        ],
        bottom: PreferredSize(
          preferredSize: Size.fromHeight(
            widget.settings.advancedMode.value ? 104 : 53,
          ),
          child: Column(
            children: [
              _KpiRow(
                settings: widget.settings,
                providers: _providers,
                cronCount: _cronCount,
                onCronChanged: _loadCronCount,
              ),
              if (widget.settings.advancedMode.value)
                _VoiceBetaEntry(onTap: _openGlobalVoice),
              const Divider(height: 1, color: Color(0xFF20242b)),
            ],
          ),
        ),
      ),
      body: _buildBody(context, mgr),
    );
  }

  Widget _buildBody(BuildContext context, SessionManager mgr) {
    if (mgr.loadingSessions &&
        mgr.directories.isEmpty &&
        mgr.sessions.isEmpty) {
      return const Center(
        child: CircularProgressIndicator(color: Color(0xFF6aa3ff)),
      );
    }

    if (mgr.sessionsError != null && mgr.directories.isEmpty) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.error_outline, color: Color(0xFFff6b63), size: 48),
            const SizedBox(height: 12),
            Text(
              mgr.sessionsError!,
              style: const TextStyle(color: Color(0xFF8a909b)),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 16),
            ElevatedButton(
              onPressed: mgr.loadDashboard,
              style: ElevatedButton.styleFrom(
                backgroundColor: const Color(0xFF14171c),
              ),
              child: Text(t('retry')),
            ),
          ],
        ),
      );
    }

    if (mgr.directories.isEmpty) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(
              Icons.folder_open_outlined,
              color: Color(0xFF5b616c),
              size: 48,
            ),
            const SizedBox(height: 12),
            Text(
              t('noWorkspaces'),
              style: TextStyle(color: Color(0xFF5b616c), fontSize: 15),
            ),
            const SizedBox(height: 6),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 28),
              child: Text(
                t('noWorkspacesHint'),
                textAlign: TextAlign.center,
                style: const TextStyle(
                  color: Color(0xFF8a909b),
                  fontSize: 12,
                  height: 1.4,
                ),
              ),
            ),
            const SizedBox(height: 16),
            ElevatedButton.icon(
              onPressed: () => _showNewDirectoryDialog(context, mgr),
              icon: const Icon(Icons.add, size: 18),
              label: Text(t('addWorkspace')),
              style: ElevatedButton.styleFrom(
                backgroundColor: const Color(0xFF22ab9c),
                foregroundColor: Colors.white,
              ),
            ),
          ],
        ),
      );
    }

    // 目录顺序来自服务端（mgr.uiLayout，与 loadDashboard 一起取），不再是本机的
    // SharedPreferences —— 换台设备、换个浏览器不用重排一遍。没排过的目录按服务端
    // 返回的顺序缀在后面。
    final orderedDirectories = applyManualOrder(
      mgr.directories,
      mgr.uiLayout.dirOrder,
      (d) => d.id,
    );

    return Column(
      children: [
        Expanded(
          child: RefreshIndicator(
                // reload() 排在 loadDashboard() 前面：loadDashboard 内部 await 的
                // 是同一个 future，这样它的 notifyListeners 落在新排布之后，下拉
                // 刷新才会真的把顺序画出来。
                onRefresh: () => Future.wait([
                  mgr.uiLayout.reload(),
                  mgr.loadDashboard(),
                  _loadCronCount(),
                ]),
                color: const Color(0xFF6aa3ff),
                backgroundColor: const Color(0xFF0f1115),
                child: ListView.builder(
                  padding: const EdgeInsets.fromLTRB(12, 2, 12, 12),
                  itemCount: orderedDirectories.length,
                  itemBuilder: (_, i) {
                    final dir = orderedDirectories[i];
                    final showInsertIndicator = _dragHoverDirId == dir.id;
                    return Column(
                      key: ValueKey(dir.id),
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        // 虚拟插入指示器：拖拽悬停时在目标卡片上方显示
                        if (showInsertIndicator)
                          Container(
                            margin: const EdgeInsets.only(bottom: 6),
                            height: 4,
                            decoration: BoxDecoration(
                              color: AppColors.accent,
                              borderRadius: BorderRadius.circular(2),
                              boxShadow: [
                                BoxShadow(
                                  color: AppColors.accent.withValues(
                                    alpha: 0.5,
                                  ),
                                  blurRadius: 8,
                                  spreadRadius: 1,
                                ),
                              ],
                            ),
                          ),
                        _DirectoryCardHost(
                          key: ValueKey('directory-card-host-${dir.id}'),
                          directory: dir,
                          settings: widget.settings,
                          mgr: mgr,
                          workspaceStore: widget.workspaceStore,
                          onDragHover: (dirId) {
                            if (_dragHoverDirId != dirId) {
                              setState(() => _dragHoverDirId = dirId);
                            }
                          },
                          onDragLeave: (dirId) {
                            if (_dragHoverDirId == dirId) {
                              setState(() => _dragHoverDirId = null);
                            }
                          },
                          onDrop: _handleDragEnd,
                          onDragEnd: () {
                            if (_dragHoverDirId != null) {
                              setState(() => _dragHoverDirId = null);
                            }
                          },
                        ),
                      ],
                    );
                  },
                ),
              ),
            ),
          ],
        );
  }

  /// 当前被拖拽悬停的目录 ID（用于显示插入指示器）
  String? _dragHoverDirId;

  /// 屏幕上当前看到的目录顺序。写回服务端时存的是**完整**顺序而不只是被拖的那张
  /// 卡：服务端第一次收到记录之前列表是空的，只存一个 id 会让它排第一、其余全部
  /// 变成未排项挤在后面，用户看到的是整列洗牌而不是移动一张卡。
  List<String> _buildVisualOrder(SessionManager mgr) => applyManualOrder(
    mgr.directories,
    mgr.uiLayout.dirOrder,
    (d) => d.id,
  ).map((d) => d.id).toList();

  Future<void> _handleDragEnd(String fromDirId, String toDirId) async {
    final mgr = context.read<SessionManager>();

    // 基于视觉顺序（而非 mgr.directories 服务端顺序）来重排
    final next = reorderAround(_buildVisualOrder(mgr), fromDirId, toDirId);

    // 乐观写：先重绘再等请求落地，卡片才跟手；服务端的应答（已剔掉不存在的目录）
    // 回来后覆盖内存值。
    final write = mgr.uiLayout.saveDirOrder(next);
    if (mounted) setState(() => _dragHoverDirId = null);
    await write;
    if (mounted) setState(() {});
  }

  void _showNewDirectoryDialog(BuildContext context, SessionManager mgr) async {
    final nameCtrl = TextEditingController();
    final pathCtrl = TextEditingController();
    String? error;
    List<Map<String, String>> suggestions = [];
    Timer? debounce;
    final basicMode = !widget.settings.advancedMode.value;
    var initialBrowseRequested = false;
    var dialogOpen = true;

    Future<void> browse(String value, StateSetter update) async {
      final res = await mgr.service.fetchFsList(value);
      if (!dialogOpen) return;
      update(() => suggestions = res);
    }

    await showDialog<void>(
      context: context,
      builder: (dialogCtx) => StatefulBuilder(
        builder: (context, setState) {
          if (!initialBrowseRequested && pathCtrl.text.isEmpty) {
            initialBrowseRequested = true;
            debounce?.cancel();
            debounce = Timer(Duration.zero, () => browse('', setState));
          }
          return AlertDialog(
            backgroundColor: const Color(0xFF0f1115),
            title: Text(
              t('addWorkspace'),
              style: const TextStyle(color: Color(0xFFf2f4f7)),
            ),
            content: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  t('workspaceSafetyHint'),
                  style: const TextStyle(
                    color: Color(0xFF8a909b),
                    fontSize: 12,
                    height: 1.4,
                  ),
                ),
                const SizedBox(height: 14),
                if (!basicMode) ...[
                  Text(
                    t('workspaceName'),
                    style: const TextStyle(
                      color: Color(0xFF8a909b),
                      fontSize: 11,
                    ),
                  ),
                  const SizedBox(height: 4),
                  TextField(
                    controller: nameCtrl,
                    autofocus: true,
                    style: const TextStyle(
                      color: Color(0xFFe7eaee),
                      fontSize: 13,
                    ),
                    decoration: sheetInputDecoration(
                      hint: t('workspaceNameHint'),
                    ),
                  ),
                  const SizedBox(height: 10),
                ],
                Text(
                  t('computerFolder'),
                  style: const TextStyle(
                    color: Color(0xFF8a909b),
                    fontSize: 11,
                  ),
                ),
                const SizedBox(height: 4),
                TextField(
                  controller: pathCtrl,
                  autofocus: basicMode,
                  style: const TextStyle(
                    color: Color(0xFFe7eaee),
                    fontSize: 13,
                    fontFamily: 'monospace',
                  ),
                  decoration: sheetInputDecoration(
                    hint: '/Users/you/code/my-project',
                  ),
                  onChanged: (value) {
                    debounce?.cancel();
                    debounce = Timer(
                      const Duration(milliseconds: 200),
                      () => browse(value, setState),
                    );
                  },
                ),
                if (suggestions.isNotEmpty)
                  Container(
                    margin: const EdgeInsets.only(top: 6),
                    constraints: const BoxConstraints(maxHeight: 180),
                    decoration: BoxDecoration(
                      border: Border.all(color: const Color(0xFF20242b)),
                      borderRadius: BorderRadius.circular(6),
                    ),
                    child: ListView.builder(
                      shrinkWrap: true,
                      padding: EdgeInsets.zero,
                      itemCount: suggestions.length,
                      itemBuilder: (_, i) {
                        final e = suggestions[i];
                        return InkWell(
                          onTap: () {
                            pathCtrl.text = '${e['path']}/';
                            if (nameCtrl.text.trim().isEmpty) {
                              nameCtrl.text = e['name'] ?? '';
                            }
                            debounce?.cancel();
                            debounce = Timer(
                              const Duration(milliseconds: 200),
                              () => browse(pathCtrl.text, setState),
                            );
                          },
                          child: Padding(
                            padding: const EdgeInsets.symmetric(
                              horizontal: 10,
                              vertical: 7,
                            ),
                            child: Text(
                              '📁 ${e['name']}',
                              style: const TextStyle(
                                color: Color(0xFFe7eaee),
                                fontSize: 12,
                                fontFamily: 'monospace',
                              ),
                            ),
                          ),
                        );
                      },
                    ),
                  ),
                if (error != null) ...[
                  const SizedBox(height: 10),
                  Text(
                    error!,
                    style: const TextStyle(
                      color: Color(0xFFff6b63),
                      fontSize: 12,
                    ),
                  ),
                ],
              ],
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(dialogCtx),
                child: Text(
                  t('cancel'),
                  style: const TextStyle(color: Color(0xFF8a909b)),
                ),
              ),
              ElevatedButton(
                style: ElevatedButton.styleFrom(
                  backgroundColor: const Color(0xFF22ab9c),
                  foregroundColor: Colors.white,
                ),
                onPressed: () async {
                  final p = pathCtrl.text.trim();
                  final parts = p
                      .split(RegExp(r'[/\\]'))
                      .where((part) => part.trim().isNotEmpty)
                      .toList();
                  final name = nameCtrl.text.trim().isNotEmpty
                      ? nameCtrl.text.trim()
                      : (parts.isEmpty ? '' : parts.last);
                  if (p.isEmpty) {
                    setState(() => error = t('folderRequired'));
                    return;
                  }
                  try {
                    await mgr.createDirectory(name: name, path: p);
                    if (dialogCtx.mounted) Navigator.pop(dialogCtx);
                  } catch (e) {
                    setState(
                      () => error = e
                          .toString()
                          .replaceFirst('Exception: ', ''),
                    );
                  }
                },
                child: Text(t('add')),
              ),
            ],
          );
        },
      ),
    );
    dialogOpen = false;
    debounce?.cancel();
    nameCtrl.dispose();
    pathCtrl.dispose();
  }
}

/// Global product action between the home health summary and the Fleet list.
/// This is easier to discover than another unlabeled AppBar icon, without
/// competing with the primary create action.
class _VoiceBetaEntry extends StatelessWidget {
  final VoidCallback onTap;
  const _VoiceBetaEntry({required this.onTap});

  @override
  Widget build(BuildContext context) {
    return Container(
      color: const Color(0xFF0f1115),
      padding: const EdgeInsets.fromLTRB(10, 0, 10, 8),
      child: Semantics(
        button: true,
        label: '${t('globalVoiceCall')}, BETA',
        child: Material(
          color: Colors.transparent,
          child: InkWell(
            onTap: onTap,
            borderRadius: BorderRadius.circular(10),
            child: Ink(
              height: 43,
              padding: const EdgeInsets.symmetric(horizontal: 11),
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(10),
                border: Border.all(
                  color: const Color(0xFF6aa3ff).withValues(alpha: 0.38),
                ),
                gradient: LinearGradient(colors: [
                  const Color(0xFF3ad6c5).withValues(alpha: 0.11),
                  const Color(0xFF6aa3ff).withValues(alpha: 0.06),
                ]),
              ),
              child: Row(children: [
                const Icon(
                  Icons.graphic_eq_rounded,
                  size: 20,
                  color: Color(0xFF3ad6c5),
                ),
                const SizedBox(width: 9),
                Expanded(
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(children: [
                        Flexible(
                          child: Text(
                            t('globalVoiceCall'),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                              color: Color(0xFFe7eaee),
                              fontSize: 12.5,
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                        ),
                        const SizedBox(width: 7),
                        Container(
                          padding: const EdgeInsets.symmetric(
                            horizontal: 5,
                            vertical: 1,
                          ),
                          decoration: BoxDecoration(
                            color: const Color(0xFF6aa3ff)
                                .withValues(alpha: 0.14),
                            borderRadius: BorderRadius.circular(999),
                            border: Border.all(
                              color: const Color(0xFF6aa3ff)
                                  .withValues(alpha: 0.42),
                            ),
                          ),
                          child: const Text(
                            'BETA',
                            style: TextStyle(
                              color: Color(0xFFcfe1ff),
                              fontSize: 8,
                              fontWeight: FontWeight.w800,
                              letterSpacing: 0.5,
                            ),
                          ),
                        ),
                      ]),
                      Text(
                        t('globalVoiceBetaHint'),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          color: Color(0xFF8a909b),
                          fontSize: 9.5,
                          height: 1.2,
                        ),
                      ),
                    ],
                  ),
                ),
                const Icon(
                  Icons.chevron_right_rounded,
                  size: 19,
                  color: Color(0xFF6aa3ff),
                ),
              ]),
            ),
          ),
        ),
      ),
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  KPI ROW — tappable summary tiles (active / waiting / cron), mirror of web
// ═══════════════════════════════════════════════════════════════════════════════

class _KpiRow extends StatelessWidget {
  final SettingsService settings;
  final List<Map<String, dynamic>> providers;
  // null while the first fetch is in flight — KpiTile then shows its chevron,
  // so the tile still reads as a link instead of flashing a placeholder 0.
  final int? cronCount;
  final VoidCallback onCronChanged;
  const _KpiRow({
    required this.settings,
    required this.onCronChanged,
    this.providers = const [],
    this.cronCount,
  });

  @override
  Widget build(BuildContext context) {
    final mgr = context.watch<SessionManager>();
    final active = mgr.activeSessions.length;
    final waiting = mgr.waitingSessions.length;
    return Container(
      color: const Color(0xFF0f1115),
      padding: const EdgeInsets.fromLTRB(10, 2, 10, 8),
      child: Row(
        children: [
          KpiTile(
            label: t('activeSessions'),
            value: '$active',
            color: const Color(0xFF3ad6c5),
            onTap: () => _showSessionSheet(
              context,
              mgr,
              t('activeSessions'),
              mgr.activeSessions,
              '🟢',
              emptyText: '最近 12 小时没有使用过的会话',
              providers: providers,
            ),
          ),
          const SizedBox(width: 8),
          KpiTile(
            label: t('waitingSessions'),
            value: '$waiting',
            color: const Color(0xFFe3b341),
            onTap: () => _showSessionSheet(
              context,
              mgr,
              t('waitingSessions'),
              mgr.waitingSessions,
              '⏳',
              emptyText: '没有等待输入的会话',
              providers: providers,
            ),
          ),
          const SizedBox(width: 8),
          KpiTile(
            label: t('cronTasks'),
            value: cronCount?.toString(),
            color: const Color(0xFF6aa3ff),
            onTap: () async {
              await Navigator.of(context).push(
                MaterialPageRoute(
                  builder: (_) => CronScreen(settings: settings),
                ),
              );
              // Tasks may have been created or deleted in there — refetch
              // rather than leave a stale number on the bar.
              onCronChanged();
            },
          ),
        ],
      ),
    );
  }
}

// Bottom-sheet list of sessions ("dir / alias"); tap an entry to jump to it.
void _showSessionSheet(
  BuildContext context,
  SessionManager mgr,
  String title,
  List<Session> sessions,
  String prefix, {
  String emptyText = '没有符合的会话',
  List<Map<String, dynamic>> providers = const [],
}) {
  String dirName(String? dirId) {
    for (final d in mgr.directories) {
      if (d.id == dirId) return d.name;
    }
    return '';
  }

  /// 会话状态 → 统一展示 spec。live 状态优先，其次是 manager 的聚合集合；两者
  /// 都没有时才用 s.active 区分 idle/offline —— 进程活着不等于「运行中」，那是
  /// 把 liveness 当业务状态。色/图标/文案全部出自同一个 registry。
  StatusSpec statusInfo(Session s, SessionStatus? live) {
    final aggregate = mgr.runningSessionIds.contains(s.id)
        ? 'running'
        : (mgr.waitingSessionIds.contains(s.id) ? 'waiting' : null);
    return statusPresentation[sessionCardStatusOf(
      monitorStatus: live?.status,
      workspaceStatus: aggregate,
      active: s.active,
    )]!;
  }

  showModalBottomSheet<void>(
    context: context,
    backgroundColor: const Color(0xFF0f1115),
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
    ),
    // Re-render once a second so the run-time of in-progress tasks visibly ticks
    // and live status / summary changes surface while the sheet is open.
    builder: (sheetCtx) => SafeArea(
      child: StreamBuilder<int>(
        stream: Stream<int>.periodic(const Duration(seconds: 1), (i) => i),
        builder: (streamCtx, _) => Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(18, 14, 18, 8),
              child: Row(
                children: [
                  Text(
                    '$prefix $title',
                    style: const TextStyle(
                      color: Color(0xFFe7eaee),
                      fontSize: 15,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const Spacer(),
                  Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 8,
                      vertical: 3,
                    ),
                    decoration: BoxDecoration(
                      color: const Color(0xFF21262d),
                      borderRadius: BorderRadius.circular(10),
                    ),
                    child: Text(
                      '${sessions.length}',
                      style: const TextStyle(
                        color: Color(0xFF8a909b),
                        fontSize: 13,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  const Text(
                    '↕ 点击打开',
                    style: TextStyle(color: Color(0xFF5b616c), fontSize: 11),
                  ),
                ],
              ),
            ),
            const Divider(height: 1, color: Color(0xFF21262d)),
            if (sessions.isEmpty)
              Padding(
                padding: const EdgeInsets.fromLTRB(18, 24, 18, 24),
                child: Text(
                  emptyText,
                  style: const TextStyle(
                    color: Color(0xFF5b616c),
                    fontSize: 13,
                  ),
                ),
              )
            else
              Flexible(
                child: ListView.builder(
                  shrinkWrap: true,
                  itemCount: sessions.length,
                  itemBuilder: (_, i) {
                    final s = sessions[i];
                    final alias = (s.label?.isNotEmpty == true)
                        ? s.label!
                        : s.id;
                    final dir = dirName(s.dirId);
                    final live = mgr.liveStatus(s.id);
                    final st = statusInfo(s, live);
                    final cliColor = cliBrandColor(s.cli);
                    final lastInteraction = sessionLastInteractionAt(s, live);
                    final ago = formatRelativeTime(lastInteraction);
                    final modelRaw = s.effectiveModel?.isNotEmpty == true
                        ? s.effectiveModel
                        : (s.model?.isNotEmpty == true ? s.model : null);
                    Map? modelAlias;
                    if (modelRaw != null && s.provider?.isNotEmpty == true) {
                      final m = providers.firstWhere(
                        (p) => p['id'] == s.provider,
                        orElse: () => {},
                      )['aliasMap'];
                      if (m is Map) modelAlias = m;
                    }
                    final model = modelRaw == null
                        ? ''
                        : modelDisplayName(
                            s.cli,
                            modelRaw,
                            aliasMap: modelAlias,
                          );
                    final effort = effortShortNameForCli(
                      s.cli,
                      s.effectiveEffort ?? s.effort,
                    );
                    final provider = s.provider?.isNotEmpty == true
                        ? s.provider!
                        : '';
                    final summary = live?.summary ?? '';
                    final runtime = runTimeText(live);

                    return InkWell(
                      onTap: () {
                        Navigator.of(sheetCtx).pop();
                        mgr.openSession(s);
                        mgr.switchToSession(s.id);
                      },
                      child: Container(
                        padding: const EdgeInsets.fromLTRB(16, 10, 16, 10),
                        decoration: const BoxDecoration(
                          border: Border(
                            bottom: BorderSide(
                              color: Color(0xFF1c2128),
                              width: 0.5,
                            ),
                          ),
                        ),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            // Row 1: status dot + cli/kind badges + status label + time
                            Row(
                              children: [
                                Semantics(
                                  label: st.semanticLabel,
                                  child: Text(
                                    st.icon,
                                    style: const TextStyle(fontSize: 11),
                                  ),
                                ),
                                const SizedBox(width: 6),
                                MiniBadge(label: s.cli.name, color: cliColor),
                                const SizedBox(width: 5),
                                MiniBadge(
                                  label: s.kind.name,
                                  color: const Color(0xFF8a909b),
                                  icon: s.isChat
                                      ? Icons.chat_bubble_outline_rounded
                                      : Icons.terminal_rounded,
                                ),
                                const SizedBox(width: 6),
                                Text(
                                  st.label,
                                  style: TextStyle(
                                    color: st.color,
                                    fontSize: 10,
                                    fontWeight: FontWeight.w700,
                                  ),
                                ),
                                if (classifyBadge(live?.classifyState) !=
                                    null) ...[
                                  const SizedBox(width: 6),
                                  classifyChip(live),
                                ],
                                const Spacer(),
                                if (runtime.isNotEmpty) ...[
                                  Text(
                                    runtime,
                                    style: const TextStyle(
                                      color: Color(0xFF7a818c),
                                      fontSize: 10,
                                      fontFamily: 'monospace',
                                    ),
                                  ),
                                  const SizedBox(width: 8),
                                ],
                                Text(
                                  ago,
                                  style: const TextStyle(
                                    color: Color(0xFF5b616c),
                                    fontSize: 10,
                                  ),
                                ),
                                const SizedBox(width: 4),
                                const Icon(
                                  Icons.arrow_forward_ios,
                                  size: 11,
                                  color: Color(0xFF5b616c),
                                ),
                              ],
                            ),
                            const SizedBox(height: 5),
                            // Row 2: session name
                            Text(
                              dir.isNotEmpty ? '$dir / $alias' : alias,
                              style: const TextStyle(
                                color: Color(0xFFe7eaee),
                                fontSize: 13,
                                fontFamily: 'monospace',
                                fontWeight: FontWeight.w600,
                              ),
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                            ),
                            // Row 3: id + model + provider (muted line)
                            if (s.label?.isNotEmpty == true ||
                                model.isNotEmpty ||
                                provider.isNotEmpty ||
                                effort.isNotEmpty) ...[
                              const SizedBox(height: 3),
                              Row(
                                children: [
                                  if (s.label?.isNotEmpty == true) ...[
                                    Text(
                                      s.id,
                                      style: const TextStyle(
                                        color: Color(0xFF5b616c),
                                        fontSize: 10,
                                        fontFamily: 'monospace',
                                      ),
                                      maxLines: 1,
                                      overflow: TextOverflow.ellipsis,
                                    ),
                                  ],
                                  if (model.isNotEmpty) ...[
                                    if (s.label?.isNotEmpty == true) ...[
                                      const SizedBox(width: 6),
                                      Text(
                                        '·',
                                        style: TextStyle(
                                          color: const Color(
                                            0xFF5b616c,
                                          ).withValues(alpha: 0.5),
                                        ),
                                      ),
                                      const SizedBox(width: 6),
                                    ],
                                    Text(
                                      model,
                                      style: const TextStyle(
                                        color: Color(0xFF5b616c),
                                        fontSize: 10,
                                      ),
                                      maxLines: 1,
                                      overflow: TextOverflow.ellipsis,
                                    ),
                                  ],
                                  if (provider.isNotEmpty) ...[
                                    const SizedBox(width: 6),
                                    Text(
                                      '·',
                                      style: TextStyle(
                                        color: const Color(
                                          0xFF5b616c,
                                        ).withValues(alpha: 0.5),
                                      ),
                                    ),
                                    const SizedBox(width: 6),
                                    Expanded(
                                      child: Text(
                                        provider,
                                        style: const TextStyle(
                                          color: Color(0xFF5b616c),
                                          fontSize: 10,
                                        ),
                                        maxLines: 1,
                                        overflow: TextOverflow.ellipsis,
                                      ),
                                    ),
                                  ],
                                  if (effort.isNotEmpty) ...[
                                    const SizedBox(width: 6),
                                    Text(
                                      '·',
                                      style: TextStyle(
                                        color: const Color(
                                          0xFF5b616c,
                                        ).withValues(alpha: 0.5),
                                      ),
                                    ),
                                    const SizedBox(width: 6),
                                    Text(
                                      effort,
                                      style: const TextStyle(
                                        color: Color(0xFF5b616c),
                                        fontSize: 10,
                                      ),
                                      maxLines: 1,
                                      overflow: TextOverflow.ellipsis,
                                    ),
                                  ],
                                ],
                              ),
                            ],
                            // Row 4: aux-AI 最近任务简介 (align to web popup)
                            if (summary.isNotEmpty) ...[
                              const SizedBox(height: 3),
                              Text(
                                '🗒 $summary',
                                style: const TextStyle(
                                  color: Color(0xFF8a909b),
                                  fontSize: 10,
                                ),
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                              ),
                            ],
                          ],
                        ),
                      ),
                    );
                  },
                ),
              ),
            const SizedBox(height: 8),
          ],
        ),
      ),
    ),
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
//  PROJECT CARD — one per directory, expanded by default
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════

/// Fleet (directory) detail panel rendered as a Stack layer over the dashboard,
/// UNDER the chat sheet. Opening a session from here overlays the chat on top;
/// closing the chat returns here instead of the bare dashboard. Replaces the
/// old showModalBottomSheet version (which popped itself on open, losing the
/// panel).
class _FleetDetailSheet extends StatefulWidget {
  final SettingsService settings;
  final SessionManager mgr;
  final String dirId;
  final DashboardWorkspaceStore workspaceStore;
  const _FleetDetailSheet({
    super.key,
    required this.settings,
    required this.mgr,
    required this.dirId,
    required this.workspaceStore,
  });

  @override
  State<_FleetDetailSheet> createState() => _FleetDetailSheetState();
}

class _FleetDetailSheetState extends State<_FleetDetailSheet>
    with SingleTickerProviderStateMixin {
  late final ValueListenable<DirectoryWorkspaceSnapshot> _workspace;
  List<Map<String, dynamic>> _providers = const [];

  // Sheet geometry, mirroring _ChatSheetState so the two layers of this Stack
  // move identically. _anim.value == the fraction of the screen height the
  // sheet covers, measured from the bottom edge (0 = fully off-screen).
  late final AnimationController _anim;
  bool _collapsing = false;

  static const double _snapDefault = 0.9; // opened height (matches chat sheet)
  static const double _dismissBelow = 0.5; // released below this → fall away

  // Tab selection for the fleet detail sheet: 0 = 会话 (sessions), 1 = 任务板
  // (task board). Kept across setState / WS-driven rebuilds so a status tick
  // never kicks the user off the board tab.
  int _tab = 0;
  // Filtered task count for the dir, reported by TaskBoardView after each
  // refresh, so the tab badge can show "任务板(N)". Null until first report.
  int? _taskCount;

  Directory get _dir {
    for (final d in widget.mgr.directories) {
      if (d.id == widget.dirId) return d;
    }
    // Fall back to whatever was captured at open time.
    return widget.mgr.directories.firstWhere(
      (d) => d.id == widget.dirId,
      orElse: () => widget.mgr.directories.first,
    );
  }

  @override
  void initState() {
    super.initState();
    widget.workspaceStore.ensureDirectory(widget.dirId);
    _workspace = widget.workspaceStore.listenableFor(widget.dirId)!;
    _loadProviders();
    _anim = AnimationController(
      vsync: this,
      lowerBound: 0,
      upperBound: 1,
      duration: const Duration(milliseconds: 260),
    );
    // Entrance: slide up from the bottom edge to the default snap.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _anim.animateTo(_snapDefault, curve: Curves.easeOutCubic);
    });
    // Let the Android back button animate this panel out instead of yanking it
    // out of the Stack (see SessionManager.requestCloseFleetDir).
    widget.mgr.fleetCollapseHandler = _collapse;
  }

  @override
  void dispose() {
    // Only clear our own registration: switching directories rebuilds this
    // widget under a new ValueKey, and the outgoing State is disposed AFTER the
    // incoming one's initState, so an unconditional clear would drop the new
    // panel's handler.
    if (widget.mgr.fleetCollapseHandler == _collapse) {
      widget.mgr.fleetCollapseHandler = null;
    }
    _anim.dispose();
    super.dispose();
  }

  void _onDrag(double dy, double height) {
    // Re-grabbing the sheet cancels a dismissal already in flight. Without this
    // the latch would stay set and every later close — drag, X, back — would be
    // swallowed by the `if (_collapsing) return` guard below.
    _collapsing = false;
    _anim.stop();
    _anim.value = (_anim.value - dy / height).clamp(0.0, 1.0);
  }

  void _onDragEnd(double velocity, double height) {
    final v = velocity / height; // fraction/sec; +down, -up
    double target;
    if (v > 1.3) {
      // Flung down: from above the snap it settles there, otherwise it falls.
      target = _anim.value < _snapDefault ? 0.0 : _snapDefault;
    } else if (v < -1.3) {
      target = 1.0;
    } else if (_anim.value < _dismissBelow) {
      target = 0.0;
    } else if (_anim.value < (_snapDefault + 1.0) / 2) {
      target = _snapDefault;
    } else {
      target = 1.0;
    }
    if (target == 0.0) {
      _collapse();
    } else {
      _anim.animateTo(target, curve: Curves.easeOutCubic);
    }
  }

  // Drop the sheet off the bottom, THEN clear the manager. Clearing first would
  // unmount this widget mid-animation and the panel would vanish instantly.
  void _collapse() {
    if (_collapsing) return;
    _collapsing = true;
    _anim.animateTo(0.0, curve: Curves.easeInCubic).then((_) {
      // A TickerFuture also completes when the animation is *cancelled* (the
      // user grabbed the sheet again on its way down), so re-check that it
      // really landed at the bottom before tearing the panel out of the Stack.
      if (mounted && _anim.value == 0.0) widget.mgr.closeFleetDir();
    });
  }

  Future<void> _loadProviders() async {
    try {
      final data = await ManageService(
        settings: widget.settings,
      ).fetchProviders();
      if (!mounted) return;
      setState(() {
        _providers = (data['providers'] as List? ?? [])
            .map((e) => (e as Map).cast<String, dynamic>())
            .toList();
      });
    } catch (_) {}
  }

  void _openSession(Session session) {
    if (session.isChat) {
      widget.mgr.openSession(session);
      widget.mgr.switchToSession(session.id);
    } else {
      Navigator.of(context).push(
        MaterialPageRoute(
          builder: (_) =>
              TerminalScreen(settings: widget.settings, session: session),
        ),
      );
    }
  }

  /// Open a session by id (called from the task-board detail sheet when a
  /// session chip is tapped, or when a message is tapped to deep-link into the
  /// chat). Task entries read full history, including messages hidden in the
  /// ordinary session view. A session referenced by a task but no
  /// longer loaded surfaces a SnackBar. The detail sheet pops itself before
  /// calling this, so the fleet panel is the top layer and its context/mgr are
  /// still live.
  void _openSessionById(String sessionId, {String? focusMessageId}) {
    Session? match;
    for (final s in widget.mgr.sessions) {
      if (s.id == sessionId) {
        match = s;
        break;
      }
    }
    if (match == null) {
      // P3: a fleet miss may be a task-bound hidden chat session (fleet-hidden
      // by design, directly addressable). Resolve it by marker; anything else
      // (aux/gateway, execution slots, dead ids) keeps the not-found surface.
      unawaited(_openTaskBoundSession(sessionId));
      return;
    }
    if (focusMessageId != null &&
        focusMessageId.isNotEmpty &&
        match.isChat) {
      widget.mgr.openSessionWithFocus(match, focusMessageId: focusMessageId, historyArchive: true);
    } else if (match.isChat) {
      widget.mgr.openSession(match, historyArchive: true);
      widget.mgr.switchToSession(match.id);
    } else {
      _openSession(match);
    }
  }

  Future<void> _openTaskBoundSession(String sessionId) async {
    final session = await SessionService(
      settings: widget.settings,
    ).fetchTaskBoundSession(sessionId);
    if (!mounted) return;
    if (session == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(t('tbSessionNotFound'))),
      );
      return;
    }
    widget.mgr.openSession(session, historyArchive: true);
    widget.mgr.switchToSession(session.id);
  }

  Future<void> _createSession(SessionKind kind, {SessionCli? defaultCli}) async {
    final navigator = Navigator.of(context);
    final messenger = ScaffoldMessenger.of(context);
    final initialCli = defaultCli ?? SessionCli.claude;
    List<Map<String, dynamic>> providers = [];
    String? defaultProviderId;
    try {
      if (initialCli.supportsProvider) {
        final d = await ManageService(
          settings: widget.settings,
        ).fetchProviders(initialCli.appType);
        providers = (d['providers'] as List? ?? [])
            .map((e) => (e as Map).cast<String, dynamic>())
            .toList();
        final defaults = d['defaults'];
        if (defaults is Map && defaults[initialCli.name] != null) {
          defaultProviderId = defaults[initialCli.name].toString();
        }
      }
    } catch (_) {}

    // Ask the host which CLIs are installed before showing the first-session
    // recommendation. Older servers do not return this summary, so keep the
    // existing-session config as a compatibility fallback.
    Map<SessionCli, bool> cliAvailability = const {};
    try {
      final installInfo = await SessionService(
        settings: widget.settings,
      ).fetchCliInstallSpecs();
      final availability = installInfo['availability'];
      if (availability is Map) {
        cliAvailability = {
          for (final cli in SessionCli.values)
            cli: availability[cli.name] is Map
                ? availability[cli.name]['available'] == true
                : false,
        };
      }
      final sessions = widget.mgr.sessions;
      if (cliAvailability.isEmpty && sessions.isNotEmpty) {
        final config = await widget.mgr.fetchSessionCliConfig(
          sessions.first.id,
        );
        cliAvailability = config.cliAvailability;
      }
    } catch (_) {}
    if (!mounted) return;
    final basicMode = !widget.settings.advancedMode.value;
    if (basicMode &&
        cliAvailability.isNotEmpty &&
        !SessionCli.values.any((cli) => cliAvailability[cli] == true)) {
      messenger.showSnackBar(
        SnackBar(
          content: Text(t('noCompatibleAi')),
          backgroundColor: AppColors.danger,
        ),
      );
      return;
    }

    final result = await showDialog<CreateSessionResult>(
      context: context,
      builder: (ctx) => CreateSessionDialog(
        defaultCli: initialCli,
        kind: kind,
        providers: providers,
        defaultProviderId: defaultProviderId,
        cliAvailability: cliAvailability,
        settings: widget.settings,
        basicMode: basicMode,
      ),
    );
    if (result == null || !mounted) return;

    try {
      final s = await widget.mgr.createSessionInDir(
        dirId: widget.dirId,
        cli: result.cli,
        kind: kind,
        label: result.label,
        model: result.model,
        provider: result.provider,
        effort: result.effort,
        agent: result.agent,
        rolePrompt: result.rolePrompt,
      );
      if (!mounted) return;
      if (s.isChat) {
        widget.mgr.openSession(s);
        widget.mgr.switchToSession(s.id);
      } else {
        navigator.push(
          MaterialPageRoute(
            builder: (_) =>
                TerminalScreen(settings: widget.settings, session: s),
          ),
        );
      }
    } catch (e) {
      if (!mounted) return;
      messenger.showSnackBar(
        SnackBar(
          content: Text('Failed: $e'),
          backgroundColor: const Color(0xFFff6b63),
        ),
      );
    }
  }

  Future<void> _pushDirectory(BuildContext context) async {
    final messenger = ScaffoldMessenger.of(context);
    messenger.showSnackBar(
      SnackBar(
        content: Text(t('pushing')),
        duration: const Duration(seconds: 30),
      ),
    );
    try {
      final r = await widget.mgr.service.pushDirectory(widget.dirId);
      if (!mounted) return;
      messenger.hideCurrentSnackBar();
      if (r['ok'] == true) {
        final before = (r['before'] as Map?) ?? const {};
        final ahead = before['ahead'] ?? 0;
        final remote = before['remote'] ?? 'origin';
        final branch = before['remoteBranch'] ?? '';
        final msg = r['pushed'] == true
            ? t('pushed', {
                'n': '$ahead',
                'remote': '$remote',
                'branch': '$branch',
              })
            : t('nothingToPush');
        messenger.showSnackBar(SnackBar(content: Text(msg)));
        await widget.mgr.loadDashboard();
      } else {
        messenger.showSnackBar(
          SnackBar(
            content: Text(
              t('pushFailed', {'error': '${r['error'] ?? 'unknown'}'}),
            ),
            backgroundColor: AppColors.danger,
          ),
        );
      }
    } catch (e) {
      if (!mounted) return;
      messenger.hideCurrentSnackBar();
      messenger.showSnackBar(
        SnackBar(
          content: Text(t('pushFailed', {'error': '$e'})),
          backgroundColor: AppColors.danger,
        ),
      );
    }
  }

  /// Segmented tab bar for the fleet detail sheet: 会话 / 任务板(N).
  /// The task-board count is reported by [TaskBoardView] after each refresh
  /// (null until the first board load), so the badge pops in lazily rather
  /// than blocking the sheet on an extra fetch.
  Widget _buildTabBar() {
    final taskLabel = _taskCount == null
        ? t('taskBoard')
        : '${t('taskBoard')}($_taskCount)';
    return Container(
      decoration: const BoxDecoration(
        color: AppColors.panel,
        border: Border(
          bottom: BorderSide(color: AppColors.line, width: 1),
        ),
      ),
      padding: const EdgeInsets.fromLTRB(14, 6, 14, 0),
      child: Row(
        children: [
          _FleetTabButton(
            // Match Web's “🖥 会话” cue. `dns_outlined` becomes another
            // three-row list at this 14px size and is nearly indistinguishable
            // from the task-board checklist beside it.
            icon: Icons.desktop_windows_outlined,
            label: t('sessions'),
            selected: _tab == 0,
            onTap: () => setState(() => _tab = 0),
          ),
          const SizedBox(width: 6),
          _FleetTabButton(
            icon: Icons.checklist_rounded,
            label: taskLabel,
            selected: _tab == 1,
            onTap: () => setState(() => _tab = 1),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final mq = MediaQuery.of(context);
    final h = mq.size.height;

    return AnimatedBuilder(
      animation: _anim,
      builder: (context, sheet) {
        final frac = _anim.value;
        // Scrim tracks the entrance and fades back out as the sheet falls away.
        // 0.5 at rest, same as the chat sheet stacked above it.
        final scrimOp = (frac.clamp(0.0, _snapDefault) / _snapDefault) * 0.5;
        final fullProg =
            ((frac - _snapDefault) / (1 - _snapDefault)).clamp(0.0, 1.0);
        final topInset = mq.padding.top * fullProg; // status-bar gap near full
        final radius = (1 - fullProg) * 18;
        final top = h * (1 - frac);
        // Below the snap the sheet SLIDES off the bottom rather than shrinking:
        // its box stays a full snap tall and simply hangs past the screen edge
        // (the Stack clips it). Resizing instead would relayout the session list
        // on every drag frame — visible reflow — and squeeze the Column past its
        // handle height near zero, tripping a RenderFlex overflow on the way out.
        final boxFrac = frac < _snapDefault ? _snapDefault : frac;

        return Stack(
          children: [
            // Dim the dashboard behind; tap outside the sheet to dismiss it.
            Positioned.fill(
              child: IgnorePointer(
                ignoring: scrimOp < 0.02,
                child: GestureDetector(
                  onTap: _collapse,
                  child: Container(
                    color: Colors.black.withValues(alpha: scrimOp),
                  ),
                ),
              ),
            ),
            // At rest the sheet reaches the physical bottom edge of the screen
            // (top = 0.1·h, height = 0.9·h). The previous version was an
            // unpositioned Stack child, which pins to the TOP — which is what
            // left a strip of dashboard showing through beneath it.
            Positioned(
              left: 0,
              right: 0,
              top: top,
              height: h * boxFrac,
              child: ClipRRect(
                borderRadius: BorderRadius.vertical(
                  top: Radius.circular(radius),
                ),
                child: Container(
                  color: AppColors.panel,
                  padding: EdgeInsets.only(top: topInset),
                  child: sheet,
                ),
              ),
            ),
          ],
        );
      },
      // Built once and passed through as `sheet`: the body does not depend on
      // the drag position, so it must not rebuild on every animation frame.
      child: Column(
        children: [
          _SheetHandle(
            onDrag: (dy) => _onDrag(dy, mq.size.height),
            onDragEnd: (v) => _onDragEnd(v, mq.size.height),
          ),
          Expanded(child: _buildBody(mq)),
        ],
      ),
    );
  }

  Widget _buildBody(MediaQueryData mq) {
    return Padding(
      padding: EdgeInsets.only(bottom: mq.padding.bottom),
      child: AnimatedBuilder(
        animation: Listenable.merge([_workspace, widget.mgr]),
        builder: (context, _) {
          final workspace = _workspace.value;
          final dir = _dir;
          final groups = widget.mgr.sessionsByKind(dir.id);
          final hasSessions = dir.totalSessions > 0;
          return Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(18, 2, 8, 12),
                  child: Row(
                    children: [
                      // The title block doubles as a drag surface so most of the
                      // header width pulls the sheet — the handle alone is a thin
                      // target. It must NOT wrap the buttons: a vertical drag
                      // recognizer beats a child tap in the gesture arena as soon
                      // as the pointer drifts past touch slop, which would eat
                      // the memo / push / close taps.
                      Expanded(
                        child: GestureDetector(
                          behavior: HitTestBehavior.opaque,
                          onVerticalDragUpdate: (d) =>
                              _onDrag(d.delta.dy, mq.size.height),
                          onVerticalDragEnd: (d) => _onDragEnd(
                            d.velocity.pixelsPerSecond.dy,
                            mq.size.height,
                          ),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                dir.name,
                                style: const TextStyle(
                                  color: AppColors.textBright,
                                  fontSize: 16,
                                  fontWeight: FontWeight.w700,
                                ),
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                              ),
                              const SizedBox(height: 3),
                              Text(
                                dir.path,
                                style: const TextStyle(
                                  color: AppColors.blue,
                                  fontSize: 11,
                                  fontFamily: 'monospace',
                                ),
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                              ),
                            ],
                          ),
                        ),
                      ),
                      IconButton(
                        tooltip: t('projectMemo'),
                        onPressed: () {
                          Navigator.of(context).push(
                            MaterialPageRoute<void>(
                              builder: (_) =>
                                  MemoScreen(directory: dir, mgr: widget.mgr),
                            ),
                          );
                        },
                        icon: const Icon(
                          Icons.sticky_note_2_outlined,
                          size: 20,
                          color: AppColors.muted,
                        ),
                        constraints: const BoxConstraints(
                          minWidth: 40,
                          minHeight: 44,
                        ),
                      ),
                      _DirectoryPushButton(
                        directory: dir,
                        onPressed: () => _pushDirectory(context),
                      ),
                      IconButton(
                        tooltip: t('close'),
                        // Animate down like a drag-dismiss instead of blinking
                        // out — same exit for both ways of closing.
                        onPressed: _collapse,
                        icon: const Icon(
                          Icons.close_rounded,
                          color: AppColors.muted,
                        ),
                        constraints: const BoxConstraints(
                          minWidth: 44,
                          minHeight: 44,
                        ),
                      ),
                    ],
                  ),
                ),
                const Divider(height: 1, color: AppColors.line),
                _buildTabBar(),
                Expanded(
                  child: IndexedStack(
                    index: _tab,
                    children: [
                      ListView(
                    padding: const EdgeInsets.fromLTRB(14, 12, 14, 18),
                    children: [
                      // Two kind buttons drive the create-session dialog; the
                      // CLI itself is picked inside the dialog via a dropdown
                      // (so all 5 CLIs × 2 kinds are reachable from 2 buttons).
                      if (!widget.settings.advancedMode.value)
                        FilledButton.icon(
                          key: const ValueKey('start-conversation-button'),
                          onPressed: () => _createSession(SessionKind.chat),
                          icon: const Icon(
                            Icons.chat_bubble_outline_rounded,
                            size: 17,
                          ),
                          label: Text(t('startConversation')),
                          style: FilledButton.styleFrom(
                            backgroundColor: AppColors.accent,
                            foregroundColor: const Color(0xFF04110F),
                            minimumSize: const Size.fromHeight(46),
                            shape: RoundedRectangleBorder(
                              borderRadius: BorderRadius.circular(9),
                            ),
                          ),
                        )
                      else ...[
                        Row(
                          children: [
                            Expanded(
                              child: FilledButton.icon(
                                onPressed: () =>
                                    _createSession(SessionKind.chat),
                                icon: const Icon(
                                  Icons.chat_bubble_outline_rounded,
                                  size: 16,
                                ),
                                label: Text(t('newChatSession')),
                                style: FilledButton.styleFrom(
                                  backgroundColor: AppColors.claude
                                      .withValues(alpha: 0.16),
                                  foregroundColor: AppColors.claude,
                                  padding: const EdgeInsets.symmetric(
                                    vertical: 10,
                                  ),
                                  shape: RoundedRectangleBorder(
                                    borderRadius: BorderRadius.circular(8),
                                  ),
                                ),
                              ),
                            ),
                            const SizedBox(width: 8),
                            Expanded(
                              child: FilledButton.icon(
                                onPressed: () =>
                                    _createSession(SessionKind.terminal),
                                icon: const Icon(
                                  Icons.terminal_rounded,
                                  size: 16,
                                ),
                                label: Text(t('newTerminalSession')),
                                style: FilledButton.styleFrom(
                                  backgroundColor: AppColors.accent
                                      .withValues(alpha: 0.16),
                                  foregroundColor: AppColors.accent,
                                  padding: const EdgeInsets.symmetric(
                                    vertical: 10,
                                  ),
                                  shape: RoundedRectangleBorder(
                                    borderRadius: BorderRadius.circular(8),
                                  ),
                                ),
                              ),
                            ),
                          ],
                        ),
                        EventTimeline(
                          events: workspace.events,
                          initiallyOpen: false,
                          maxEvents: 3,
                          maxExpandedHeight: 120,
                        ),
                      ],
                      if (!hasSessions)
                        Container(
                          width: double.infinity,
                          margin: const EdgeInsets.fromLTRB(0, 12, 0, 14),
                          padding: const EdgeInsets.symmetric(
                            horizontal: 12,
                            vertical: 16,
                          ),
                          decoration: BoxDecoration(
                            color: AppColors.bg.withValues(alpha: 0.65),
                            border: Border.all(color: AppColors.line),
                            borderRadius: BorderRadius.circular(8),
                          ),
                          child: Text(
                            t('noSessions'),
                            textAlign: TextAlign.center,
                            style: const TextStyle(
                              color: AppColors.faint,
                              fontSize: 12,
                            ),
                          ),
                        )
                      else ...[
                        _SessionGroup(
                          title: t('chats'),
                          color: AppColors.muted,
                          sessions: groups['chat']!,
                          mgr: widget.mgr,
                          settings: widget.settings,
                          dirId: dir.id,
                          statuses: workspace.statuses,
                          pendingNotes: workspace.pendingNotes,
                          providers: _providers,
                          onOpen: _openSession,
                        ),
                        _SessionGroup(
                          title: t('terminals'),
                          color: AppColors.muted,
                          sessions: groups['terminal']!,
                          mgr: widget.mgr,
                          settings: widget.settings,
                          dirId: dir.id,
                          statuses: workspace.statuses,
                          pendingNotes: workspace.pendingNotes,
                          providers: _providers,
                          onOpen: _openSession,
                        ),
                      ],
                    ],
                  ),
                      TaskBoardView(
                        settings: widget.settings,
                        dirId: widget.dirId,
                        mgr: widget.mgr,
                        // M4-T3: live TaskRun activity for this dir — the
                        // store entry is ensured in initState above.
                        taskRunEvents: widget.workspaceStore.taskRunEventsFor(
                          widget.dirId,
                        ),
                        onTaskCount: (n) {
                          if (_taskCount != n) {
                            setState(() => _taskCount = n);
                          }
                        },
                        onOpenSession: _openSessionById,
                      ),
                    ],
                  ),
                ),
              ],
            );
          },
        ),
    );
  }
}

class _FleetTabButton extends StatelessWidget {
  final IconData icon;
  final String label;
  final bool selected;
  final VoidCallback onTap;

  const _FleetTabButton({
    required this.icon,
    required this.label,
    required this.selected,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final color = selected ? AppColors.accent : AppColors.muted;
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
        decoration: BoxDecoration(
          color: selected ? AppColors.accent.withValues(alpha: 0.12) : null,
          border: Border(
            bottom: BorderSide(
              color: selected ? AppColors.accent : Colors.transparent,
              width: 2,
            ),
          ),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 14, color: color),
            const SizedBox(width: 5),
            Text(
              label,
              style: TextStyle(
                color: color,
                fontSize: 12.5,
                fontWeight: FontWeight.w700,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _DirectoryCardHost extends StatefulWidget {
  final Directory directory;
  final SettingsService settings;
  final SessionManager mgr;
  final DashboardWorkspaceStore workspaceStore;
  final void Function(String dirId)? onDragHover;
  final void Function(String dirId)? onDragLeave;
  final void Function(String sourceId, String targetId)? onDrop;
  final VoidCallback? onDragEnd;

  const _DirectoryCardHost({
    super.key,
    required this.directory,
    required this.settings,
    required this.mgr,
    required this.workspaceStore,
    this.onDragHover,
    this.onDragLeave,
    this.onDrop,
    this.onDragEnd,
  });

  @override
  State<_DirectoryCardHost> createState() => _DirectoryCardHostState();
}

class _DirectoryCardHostState extends State<_DirectoryCardHost> {
  late final ValueListenable<DirectoryWorkspaceSnapshot> _workspace;

  @override
  void initState() {
    super.initState();
    widget.workspaceStore.ensureDirectory(widget.directory.id);
    _workspace = widget.workspaceStore.listenableFor(widget.directory.id)!;
  }

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<DirectoryWorkspaceSnapshot>(
      valueListenable: _workspace,
      builder: (context, workspace, _) {
        final view = DirectoryCardViewModel.fromModels(
          directory: widget.directory,
          sessions: widget.mgr.sessions,
          statuses: workspace.statuses,
          events: workspace.events,
        );
        return DirectoryCard(
          key: ValueKey('directory-card-${widget.directory.id}'),
          view: view,
          callbacks: DirectoryCardCallbacks(
            onOpen: () => widget.mgr.openFleetDir(widget.directory.id),
            onOpenMemo: () => Navigator.push(
              context,
              MaterialPageRoute<void>(
                builder: (_) =>
                    MemoScreen(directory: widget.directory, mgr: widget.mgr),
              ),
            ),
            onShowUncommitted: () => _showUncommittedFiles(context),
            onRename: () => _confirmRenameDirectory(context),
            onDelete: () => _confirmDeleteDirectory(context),
            onDragHover: widget.onDragHover,
            onDragLeave: widget.onDragLeave,
            onDrop: widget.onDrop,
            onDragEnd: widget.onDragEnd,
          ),
        );
      },
    );
  }

  Future<void> _confirmRenameDirectory(BuildContext context) async {
    final messenger = ScaffoldMessenger.of(context);
    final ctrl = TextEditingController(text: widget.directory.name);
    final next = await showDialog<String>(
      context: context,
      builder: (_) => AlertDialog(
        backgroundColor: const Color(0xFF0f1115),
        title: const Text(
          'Rename directory',
          style: TextStyle(color: Color(0xFFf2f4f7)),
        ),
        content: TextField(
          controller: ctrl,
          autofocus: true,
          style: const TextStyle(color: Color(0xFFe7eaee), fontSize: 14),
          decoration: sheetInputDecoration(hint: 'Directory name'),
          onSubmitted: (v) => Navigator.pop(context, v),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, null),
            child: const Text(
              'Cancel',
              style: TextStyle(color: Color(0xFF8a909b)),
            ),
          ),
          TextButton(
            onPressed: () => Navigator.pop(context, ctrl.text),
            child: const Text(
              'Rename',
              style: TextStyle(color: Color(0xFF6aa3ff)),
            ),
          ),
        ],
      ),
    );
    if (next == null) return;
    final name = next.trim();
    if (name.isEmpty) return;
    try {
      await widget.mgr.renameDirectory(widget.directory.id, name);
      if (!mounted) return;
      messenger.showSnackBar(
        const SnackBar(content: Text('Directory renamed')),
      );
    } catch (e) {
      if (!mounted) return;
      messenger.showSnackBar(
        SnackBar(
          content: Text('Rename failed: $e'),
          backgroundColor: const Color(0xFFff6b63),
        ),
      );
    }
  }

  Future<void> _showUncommittedFiles(BuildContext context) async {
    final messenger = ScaffoldMessenger.of(context);
    final svc = widget.mgr.service;
    final dir = widget.directory;
    List<Map<String, dynamic>> files = [];
    String? loadError;

    Future<void> load() async {
      try {
        final r = await svc.fetchUncommitted(dir.id);
        final list = r['files'];
        files = list is List
            ? list
                  .whereType<Map>()
                  .map((m) => Map<String, dynamic>.from(m))
                  .toList()
            : [];
        loadError = r['error']?.toString();
      } catch (e) {
        loadError = '$e';
      }
    }

    await load();
    if (!context.mounted) return;

    await showDialog<void>(
      context: context,
      builder: (dialogCtx) => UncommittedFilesDialog(
        dirName: dir.name,
        dirPath: dir.path,
        files: files,
        loadError: loadError,
        onCommit: () async {
          final msg = await showDialog<String>(
            context: dialogCtx,
            builder: (bctx) {
              final c = TextEditingController();
              return AlertDialog(
                backgroundColor: const Color(0xFF0f1115),
                title: const Text(
                  '提交信息',
                  style: TextStyle(color: Color(0xFFf2f4f7)),
                ),
                content: TextField(
                  controller: c,
                  autofocus: true,
                  style: const TextStyle(
                    color: Color(0xFFe7eaee),
                    fontSize: 14,
                  ),
                  decoration: sheetInputDecoration(hint: '留空使用自动信息'),
                  onSubmitted: (v) => Navigator.pop(bctx, v),
                ),
                actions: [
                  TextButton(
                    onPressed: () => Navigator.pop(bctx, null),
                    child: const Text(
                      '取消',
                      style: TextStyle(color: Color(0xFF8a909b)),
                    ),
                  ),
                  TextButton(
                    onPressed: () => Navigator.pop(bctx, c.text),
                    child: const Text(
                      '提交',
                      style: TextStyle(color: Color(0xFF6aa3ff)),
                    ),
                  ),
                ],
              );
            },
          );
          if (msg == null) return false;
          final r = await svc.commitAll(dir.id, message: msg);
          if (!dialogCtx.mounted) return false;
          if (r['ok'] == true && r['committed'] == true) {
            messenger.showSnackBar(const SnackBar(content: Text('已提交所有未提交改动')));
            return true;
          } else if (r['ok'] == true) {
            messenger.showSnackBar(const SnackBar(content: Text('没有需要提交的改动')));
            return true;
          } else {
            messenger.showSnackBar(
              SnackBar(
                content: Text('提交失败：${r['error'] ?? 'unknown'}'),
                backgroundColor: AppColors.danger,
              ),
            );
            return false;
          }
        },
      ),
    );
    await widget.mgr.loadDashboard();
  }

  Future<void> _confirmDeleteDirectory(BuildContext context) async {
    final messenger = ScaffoldMessenger.of(context);
    final hasSessions = widget.directory.totalSessions > 0;
    final confirm = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        backgroundColor: const Color(0xFF0f1115),
        title: Text(
          'Delete directory',
          style: const TextStyle(color: Color(0xFFf2f4f7)),
        ),
        content: Text(
          hasSessions
              ? 'Delete "${widget.directory.name}" and ALL ${widget.directory.totalSessions} session(s)? This cannot be undone.'
              : 'Delete empty directory "${widget.directory.name}"?',
          style: const TextStyle(color: Color(0xFFe7eaee)),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text(
              'Cancel',
              style: TextStyle(color: Color(0xFF8a909b)),
            ),
          ),
          TextButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text(
              'Delete',
              style: TextStyle(color: Color(0xFFff6b63)),
            ),
          ),
        ],
      ),
    );
    if (confirm != true) return;
    try {
      await widget.mgr.deleteDirectory(widget.directory.id);
    } catch (e) {
      if (!mounted) return;
      messenger.showSnackBar(
        SnackBar(
          content: Text('Failed: $e'),
          backgroundColor: const Color(0xFFff6b63),
        ),
      );
    }
  }
}

class _DirectoryPushButton extends StatelessWidget {
  final Directory directory;
  final VoidCallback onPressed;

  const _DirectoryPushButton({
    required this.directory,
    required this.onPressed,
  });

  @override
  Widget build(BuildContext context) {
    final ps = directory.pushState;
    if (ps == null || ps.available == false || !ps.hasRemote) {
      return const SizedBox.shrink();
    }

    late final String label;
    late final Color color;
    late final IconData icon;
    if (ps.ahead > 0) {
      label = t('pushAhead', {'n': '${ps.ahead}'});
      color = AppColors.amber;
      icon = Icons.cloud_upload_outlined;
    } else if (ps.behind > 0) {
      label = t('pushBehind', {'n': '${ps.behind}'});
      color = AppColors.muted;
      icon = Icons.cloud_download_outlined;
    } else {
      label = t('pushSynced');
      color = AppColors.codex;
      icon = Icons.check_circle_outline_rounded;
    }

    return Padding(
      padding: const EdgeInsets.only(left: 8),
      child: TextButton.icon(
        onPressed: onPressed,
        icon: Icon(icon, size: 16, color: color),
        label: Text(
          label,
          style: TextStyle(
            color: color,
            fontSize: 12,
            fontWeight: FontWeight.w700,
          ),
        ),
        style: TextButton.styleFrom(
          minimumSize: const Size(44, 36),
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
          side: BorderSide(color: color.withValues(alpha: 0.45)),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(9)),
        ),
      ),
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
        color: const Color(0xFF070809),
        border: Border.all(color: const Color(0xFF14171c)),
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
                      color: Color(0xFF5b616c),
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
                    color: const Color(0xFF5b616c),
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
                style: const TextStyle(color: Color(0xFF8a909b), fontSize: 11),
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

// ═══════════════════════════════════════════════════════════════════════════════
//  SESSION GROUP + CARD
// ═══════════════════════════════════════════════════════════════════════════════

class _SessionGroup extends StatefulWidget {
  final String title;
  final Color color;
  final List<Session> sessions;
  final SessionManager mgr;
  final SettingsService settings;
  final String dirId;
  final Map<String, SessionStatus> statuses;
  final Map<String, int> pendingNotes;
  final List<Map<String, dynamic>> providers;
  final ValueChanged<Session>? onOpen;

  const _SessionGroup({
    required this.title,
    required this.color,
    required this.sessions,
    required this.mgr,
    required this.settings,
    required this.dirId,
    required this.statuses,
    required this.pendingNotes,
    this.providers = const [],
    this.onOpen,
  });

  @override
  State<_SessionGroup> createState() => _SessionGroupState();
}

class _SessionGroupState extends State<_SessionGroup> {
  // 长按拖起来的会话 id，以及当前悬停的目标。只在拖拽期间有值。
  String? _draggingId;

  /// 把这一组拖后的顺序写回服务端。
  ///
  /// 存的是**整组**的可见顺序（不是只存被拖的那一张），并用 [mergeGroupOrder] 把
  /// 同一 fleet 里另一组（terminals / chats）已存的 id 原样带上——一个 fleet 只存
  /// 一份平铺列表，不带就等于「排完聊天，终端的排布没了」。
  Future<void> _handleDrop(List<Session> ordered, String targetId) async {
    final draggedId = _draggingId;
    setState(() => _draggingId = null);
    if (draggedId == null || draggedId == targetId) return;
    final visible = ordered.map((s) => s.id).toList();
    if (!visible.contains(draggedId) || !visible.contains(targetId)) return;
    await widget.mgr.saveFleetSessionOrder(
      widget.dirId,
      mergeGroupOrder(
        widget.mgr.uiLayout.sessionOrderOf(widget.dirId),
        reorderAround(visible, draggedId, targetId),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    if (widget.sessions.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.fromLTRB(14, 10, 14, 0),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.only(bottom: 8, left: 2),
            child: Text(
              '${widget.title.toUpperCase()} · ${widget.sessions.length}',
              style: TextStyle(
                color: widget.color,
                fontSize: 9,
                fontWeight: FontWeight.w700,
                letterSpacing: 0.6,
              ),
            ),
          ),
          LayoutBuilder(
            builder: (context, constraints) {
              const gap = 8.0;
              final columns = constraints.maxWidth >= 520 ? 2 : 1;
              final cardWidth =
                  (constraints.maxWidth - gap * (columns - 1)) / columns;
              // 默认按创建时间，绝不按活跃度：`statuses` 每来一个流式 token 就变，
              // 拿它当排序键会让卡片在用户手指底下互换位置。用户拖出来的手动顺序
              // 盖在上面。SessionManager 交过来的列表已经是这个顺序（同一个函数），
              // 这里再调一次是幂等的——只是不让 widget 默默依赖调用方排好了。
              final sortedSessions = orderFleetSessions(
                widget.sessions,
                manualOrder: widget.mgr.uiLayout.sessionOrderOf(widget.dirId),
              );
              return Wrap(
                spacing: gap,
                runSpacing: gap,
                children: [
                  for (final s in sortedSessions)
                    SizedBox(
                      width: cardWidth,
                      child: _DraggableSessionCard(
                        key: ValueKey('draggable-session-${s.id}'),
                        sessionId: s.id,
                        dragging: _draggingId == s.id,
                        onDragStarted: () =>
                            setState(() => _draggingId = s.id),
                        onDragEnded: () {
                          if (_draggingId != null) {
                            setState(() => _draggingId = null);
                          }
                        },
                        onDropped: (targetId) =>
                            _handleDrop(sortedSessions, targetId),
                        child: SessionCard(
                          session: s,
                          mgr: widget.mgr,
                          settings: widget.settings,
                          liveStatus: widget.statuses[s.id],
                          pendingNotes: widget.pendingNotes[s.id] ?? 0,
                          providers: widget.providers,
                          onOpen: widget.onOpen,
                        ),
                      ),
                    ),
                ],
              );
            },
          ),
        ],
      ),
    );
  }
}

/// 会话卡的拖拽外壳：长按拖起、拖到另一张卡上放下。
///
/// 与首页目录卡同一套手势（[LongPressDraggable] + [DragTarget]），因为这两处对
/// 用户是同一个动作。长按而不是直接拖：卡片本身要能点开会话，也在可滚动的
/// fleet 面板里，短按/竖划都得留给它们。
///
/// 拖拽载荷是 `sessionId`，且 [DragTarget] 只接受同一组里的 id（组外拖进来的
/// 会话不在 visible 里，[_SessionGroupState._handleDrop] 会直接丢弃）——跨组拖
/// 意味着改 kind，那不是排序该做的事。
class _DraggableSessionCard extends StatelessWidget {
  final String sessionId;
  final bool dragging;
  final Widget child;
  final VoidCallback onDragStarted;
  final VoidCallback onDragEnded;
  final ValueChanged<String> onDropped;

  const _DraggableSessionCard({
    super.key,
    required this.sessionId,
    required this.dragging,
    required this.child,
    required this.onDragStarted,
    required this.onDragEnded,
    required this.onDropped,
  });

  @override
  Widget build(BuildContext context) {
    return LongPressDraggable<String>(
      data: sessionId,
      onDragStarted: onDragStarted,
      onDraggableCanceled: (_, __) => onDragEnded(),
      onDragEnd: (_) => onDragEnded(),
      feedback: Material(
        elevation: 6,
        color: Colors.transparent,
        child: Opacity(
          opacity: 0.9,
          child: SizedBox(
            width: MediaQuery.of(context).size.width - 56,
            child: child,
          ),
        ),
      ),
      childWhenDragging: Opacity(opacity: 0.35, child: child),
      child: DragTarget<String>(
        onWillAcceptWithDetails: (details) => details.data != sessionId,
        onAcceptWithDetails: (_) => onDropped(sessionId),
        builder: (context, candidateData, __) {
          final hovering = candidateData.isNotEmpty;
          return AnimatedContainer(
            duration: const Duration(milliseconds: 160),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(8),
              border: Border.all(
                color: hovering ? AppColors.accent : Colors.transparent,
                width: 2,
              ),
            ),
            child: Opacity(opacity: dragging ? 0.35 : 1, child: child),
          );
        },
      ),
    );
  }
}
