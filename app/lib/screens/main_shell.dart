import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../models/message.dart';
import '../providers/chat_provider.dart';
import '../providers/session_manager.dart';
import '../services/settings_service.dart';
import '../services/manage_service.dart';
import '../services/workspace_service.dart';
import '../i18n.dart';
import '../theme.dart';
import '../utils/session_status_helpers.dart';
import '../widgets/session_card.dart';
import '../widgets/rainbow_border.dart';
import '../widgets/session_badges.dart';
import '../widgets/git_status_row.dart';
import '../widgets/home_task_scroller.dart';
import '../widgets/kpi_tile.dart';
import '../widgets/project_stat_pill.dart';
import '../widgets/create_session_dialog.dart';
import 'chat_screen.dart';
import 'memo_screen.dart';
import 'settings_screen.dart';
import 'cron_screen.dart';
import 'terminal_screen.dart';

class MainShell extends StatefulWidget {
  final SettingsService settings;
  const MainShell({super.key, required this.settings});

  @override
  State<MainShell> createState() => _MainShellState();
}

class _MainShellState extends State<MainShell> {
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
          mgr.closeFleetDir();
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
            _DirectoryListBody(settings: widget.settings),
            // Fleet (directory) detail panel - lives in the Stack UNDER the chat
            // sheet. Opening a session from it overlays the chat on top; closing
            // the chat returns here (not to the bare dashboard).
            if (mgr.activeFleetDirId != null)
              _FleetDetailSheet(
                key: ValueKey('fleet-${mgr.activeFleetDirId}'),
                settings: widget.settings,
                mgr: mgr,
                dirId: mgr.activeFleetDirId!,
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
  const _DirectoryListBody({required this.settings});

  @override
  State<_DirectoryListBody> createState() => _DirectoryListBodyState();
}

class _DirectoryListBodyState extends State<_DirectoryListBody> {
  // 从SharedPreferences加载目录顺序
  static const String _dirOrderKey = 'directory_order';

  // Cached provider list (with aliasMap) so session model labels in the KPI
  // sheet can show an alias-mapped relay's real name (e.g. GLM5.2).
  List<Map<String, dynamic>> _providers = [];

  Future<List<String>?> _loadDirOrder() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getStringList(_dirOrderKey);
  }

  Future<void> _saveDirOrder(List<String> order) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setStringList(_dirOrderKey, order);
  }

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

  @override
  void initState() {
    super.initState();
    _loadProviders();
  }

  @override
  Widget build(BuildContext context) {
    final mgr = context.watch<SessionManager>();

    return Scaffold(
      backgroundColor: const Color(0xFF070809),
      // AppBar
      appBar: AppBar(
        backgroundColor: const Color(0xFF0f1115),
        foregroundColor: const Color(0xFFe7eaee),
        elevation: 0,
        centerTitle: false,
        automaticallyImplyLeading: false,
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
            const SizedBox(width: 8),
            Text(
              t('dirs_sessions', {
                'dirs': '${mgr.directories.length}',
                'sessions': '${mgr.sessions.where((s) => !s.isAux).length}',
              }),
              style: const TextStyle(
                color: Color(0xFF8a909b),
                fontSize: 12,
                fontWeight: FontWeight.normal,
              ),
            ),
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
            onPressed: mgr.loadDashboard,
          ),
          IconButton(
            icon: const Icon(Icons.settings_outlined, size: 20),
            tooltip: t('settings'),
            onPressed: () => Navigator.of(context).push(
              MaterialPageRoute(
                builder: (_) => SettingsScreen(settings: widget.settings),
              ),
            ),
          ),
        ],
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(57),
          child: Column(
            children: [
              _KpiRow(settings: widget.settings, providers: _providers),
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
              child: const Text('Retry'),
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
            const Text(
              'No directories yet',
              style: TextStyle(color: Color(0xFF5b616c), fontSize: 15),
            ),
            const SizedBox(height: 16),
            ElevatedButton.icon(
              onPressed: () => _showNewDirectoryDialog(context, mgr),
              icon: const Icon(Icons.add, size: 18),
              label: const Text('New directory'),
              style: ElevatedButton.styleFrom(
                backgroundColor: const Color(0xFF22ab9c),
                foregroundColor: Colors.white,
              ),
            ),
          ],
        ),
      );
    }

    return FutureBuilder<List<String>?>(
      future: _loadDirOrder(),
      builder: (context, snapshot) {
        final savedOrder = snapshot.data;
        // 缓存到 _lastSavedOrder，供 _handleDragEnd → _buildVisualOrder 使用
        _lastSavedOrder = savedOrder;

        final orderedDirectories = <Directory>[];

        if (savedOrder != null && savedOrder.isNotEmpty) {
          // 按保存的顺序排列，未保存的新目录追加到末尾
          final dirMap = {for (var d in mgr.directories) d.id: d};
          for (final id in savedOrder) {
            if (dirMap.containsKey(id)) {
              orderedDirectories.add(dirMap[id]!);
              dirMap.remove(id);
            }
          }
          // 添加新创建的目录
          orderedDirectories.addAll(dirMap.values);
        } else {
          orderedDirectories.addAll(mgr.directories);
        }

        return Column(
          children: [
            // 首页全局任务滚动展示器（当天用过的会话，最近优先）
            HomeTaskScroller(
              sessions: mgr.sessions,
              directories: mgr.directories,
              liveStatusFor: mgr.liveStatus,
              onSessionTap: (s) {
                mgr.openSession(s);
                mgr.switchToSession(s.id);
              },
            ),
            Expanded(
              child: RefreshIndicator(
                onRefresh: mgr.loadDashboard,
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
                        _DirectoryCard(
                          directory: dir,
                          settings: widget.settings,
                          mgr: mgr,
                          index: i,
                          onDragHover: (dirId) {
                            if (_dragHoverDirId != dirId) {
                              setState(() => _dragHoverDirId = dirId);
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
      },
    );
  }

  /// 当前被拖拽悬停的目录 ID（用于显示插入指示器）
  String? _dragHoverDirId;

  /// 构建与用户视觉一致的有序列表（savedOrder 优先，新目录追加末尾）
  List<String> _buildVisualOrder(SessionManager mgr) {
    final saved = _lastSavedOrder ?? [];
    final dirIds = mgr.directories.map((d) => d.id).toSet();
    final visual = <String>[];
    for (final id in saved) {
      if (dirIds.contains(id)) {
        visual.add(id);
        dirIds.remove(id);
      }
    }
    // 新目录追加末尾
    for (final d in mgr.directories) {
      if (dirIds.contains(d.id)) visual.add(d.id);
    }
    return visual;
  }

  List<String>? _lastSavedOrder;

  Future<void> _handleDragEnd(String fromDirId, String toDirId) async {
    final mgr = context.read<SessionManager>();

    // 基于视觉顺序（而非 mgr.directories 服务端顺序）来重排
    final visualOrder = _buildVisualOrder(mgr);

    final fromIdx = visualOrder.indexOf(fromDirId);
    final toIdx = visualOrder.indexOf(toDirId);

    if (fromIdx == -1 || toIdx == -1 || fromIdx == toIdx) {
      if (mounted) setState(() => _dragHoverDirId = null);
      return;
    }

    // 从原位置移除，插入到目标位置之前
    visualOrder.removeAt(fromIdx);
    final insertIdx = visualOrder.indexOf(toDirId);
    visualOrder.insert(insertIdx, fromDirId);

    _lastSavedOrder = visualOrder;
    await _saveDirOrder(visualOrder);

    // 清除拖拽状态 + 刷新UI
    if (mounted) {
      setState(() => _dragHoverDirId = null);
    }
  }

  void _showNewDirectoryDialog(BuildContext context, SessionManager mgr) async {
    final nameCtrl = TextEditingController();
    final pathCtrl = TextEditingController();
    String? error;
    List<Map<String, String>> suggestions = [];
    Timer? debounce;

    await showDialog<void>(
      context: context,
      builder: (dialogCtx) => StatefulBuilder(
        builder: (context, setState) => AlertDialog(
          backgroundColor: const Color(0xFF0f1115),
          title: const Text(
            'New directory',
            style: TextStyle(color: Color(0xFFf2f4f7)),
          ),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text(
                'Name',
                style: TextStyle(color: Color(0xFF8a909b), fontSize: 11),
              ),
              const SizedBox(height: 4),
              TextField(
                controller: nameCtrl,
                autofocus: true,
                style: const TextStyle(color: Color(0xFFe7eaee), fontSize: 13),
                decoration: sheetInputDecoration(hint: 'My project'),
              ),
              const SizedBox(height: 10),
              const Text(
                'Path',
                style: TextStyle(color: Color(0xFF8a909b), fontSize: 11),
              ),
              const SizedBox(height: 4),
              TextField(
                controller: pathCtrl,
                style: const TextStyle(
                  color: Color(0xFFe7eaee),
                  fontSize: 13,
                  fontFamily: 'monospace',
                ),
                decoration: sheetInputDecoration(
                  hint: '/Users/you/code/my-project',
                ),
                onChanged: (_) {
                  debounce?.cancel();
                  debounce = Timer(const Duration(milliseconds: 200), () async {
                    final res = await mgr.service.fetchFsList(pathCtrl.text);
                    setState(() => suggestions = res);
                  });
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
                            () async {
                              final res = await mgr.service.fetchFsList(
                                pathCtrl.text,
                              );
                              setState(() => suggestions = res);
                            },
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
              if (error != null) const SizedBox(height: 10),
            ],
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(dialogCtx),
              child: const Text(
                'Cancel',
                style: TextStyle(color: Color(0xFF8a909b)),
              ),
            ),
            ElevatedButton(
              style: ElevatedButton.styleFrom(
                backgroundColor: const Color(0xFF22ab9c),
                foregroundColor: Colors.white,
              ),
              onPressed: () async {
                final name = nameCtrl.text.trim();
                final p = pathCtrl.text.trim();
                if (name.isEmpty || p.isEmpty) {
                  setState(() => error = 'Name and path are required');
                  return;
                }
                try {
                  await mgr.createDirectory(name: name, path: p);
                  if (dialogCtx.mounted) Navigator.pop(dialogCtx);
                } catch (e) {
                  setState(
                    () => error = e.toString().replaceFirst('Exception: ', ''),
                  );
                }
              },
              child: const Text('Create'),
            ),
          ],
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
  const _KpiRow({required this.settings, this.providers = const []});

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
            value: null,
            color: const Color(0xFF6aa3ff),
            onTap: () => Navigator.of(context).push(
              MaterialPageRoute(builder: (_) => CronScreen(settings: settings)),
            ),
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

  /// Derive a status colour + text from the live workspace status (full 7-state
  /// mapping, aligned to web), falling back to the aggregate id sets / s.active.
  ({Color color, String text}) statusInfo(Session s, SessionStatus? live) {
    if (live != null) {
      return (
        color: wbStatusColor(live.status),
        text: wbStatusLabel(live.status),
      );
    }
    if (mgr.runningSessionIds.contains(s.id)) {
      return (color: const Color(0xFF7fd49a), text: t('running'));
    }
    if (mgr.waitingSessionIds.contains(s.id)) {
      return (color: const Color(0xFFf0936b), text: t('waiting'));
    }
    if (s.active) {
      return (color: const Color(0xFF3ad6c5), text: t('active'));
    }
    return (color: const Color(0xFF5b616c), text: t('idle'));
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
                                Container(
                                  width: 7,
                                  height: 7,
                                  decoration: BoxDecoration(
                                    color: st.color,
                                    shape: BoxShape.circle,
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
                                  st.text,
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
  const _FleetDetailSheet({
    super.key,
    required this.settings,
    required this.mgr,
    required this.dirId,
  });

  @override
  State<_FleetDetailSheet> createState() => _FleetDetailSheetState();
}

class _FleetDetailSheetState extends State<_FleetDetailSheet> {
  late final WorkspaceService _workspace;
  List<Map<String, dynamic>> _providers = const [];

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
    _workspace = WorkspaceService(
      settings: widget.settings,
      dirId: widget.dirId,
    );
    _workspace.onNotify = widget.mgr.handleWorkspaceNotify;
    _workspace.connect();
    _loadProviders();
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

  @override
  void dispose() {
    _workspace.dispose();
    super.dispose();
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

  Future<void> _createSession(SessionCli cli, SessionKind kind) async {
    final navigator = Navigator.of(context);
    final messenger = ScaffoldMessenger.of(context);
    final appType = cli.appType;
    List<Map<String, dynamic>> providers = [];
    String? defaultProviderId;
    try {
      final d = await ManageService(
        settings: widget.settings,
      ).fetchProviders(appType);
      providers = (d['providers'] as List? ?? [])
          .map((e) => (e as Map).cast<String, dynamic>())
          .toList();
      final defaults = d['defaults'];
      if (defaults is Map && defaults[cli.name] != null) {
        defaultProviderId = defaults[cli.name].toString();
      }
    } catch (_) {}
    if (!mounted) return;

    final result = await showDialog<CreateSessionResult>(
      context: context,
      builder: (ctx) => CreateSessionDialog(
        cli: cli,
        kind: kind,
        providers: providers,
        defaultProviderId: defaultProviderId,
        settings: widget.settings,
      ),
    );
    if (result == null || !mounted) return;

    try {
      final s = await widget.mgr.createSessionInDir(
        dirId: widget.dirId,
        cli: cli,
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

  @override
  Widget build(BuildContext context) {
    final mq = MediaQuery.of(context);
    return SafeArea(
      child: Container(
        height: mq.size.height * 0.9,
        decoration: const BoxDecoration(
          color: AppColors.panel,
          borderRadius: BorderRadius.vertical(top: Radius.circular(18)),
        ),
        child: AnimatedBuilder(
          animation: Listenable.merge([_workspace, widget.mgr]),
          builder: (context, _) {
            final dir = _dir;
            final groups = widget.mgr.sessionsByCliKind(dir.id);
            final hasSessions = dir.totalSessions > 0;
            return Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(18, 14, 8, 12),
                  child: Row(
                    children: [
                      Expanded(
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
                        onPressed: () => widget.mgr.closeFleetDir(),
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
                Expanded(
                  child: ListView(
                    padding: const EdgeInsets.fromLTRB(14, 12, 14, 18),
                    children: [
                      Wrap(
                        spacing: 6,
                        runSpacing: 6,
                        children: [
                          AddSessionChip(
                            label: '+ Claude Term',
                            color: AppColors.claude,
                            onTap: () => _createSession(
                              SessionCli.claude,
                              SessionKind.terminal,
                            ),
                          ),
                          AddSessionChip(
                            label: '+ Claude Chat',
                            color: AppColors.claude,
                            onTap: () => _createSession(
                              SessionCli.claude,
                              SessionKind.chat,
                            ),
                          ),
                          AddSessionChip(
                            label: '+ Codex Term',
                            color: AppColors.codex,
                            onTap: () => _createSession(
                              SessionCli.codex,
                              SessionKind.terminal,
                            ),
                          ),
                          AddSessionChip(
                            label: '+ Codex Chat',
                            color: AppColors.codex,
                            onTap: () => _createSession(
                              SessionCli.codex,
                              SessionKind.chat,
                            ),
                          ),
                          AddSessionChip(
                            label: '+ OpenCode Term',
                            color: AppColors.opencode,
                            onTap: () => _createSession(
                              SessionCli.opencode,
                              SessionKind.terminal,
                            ),
                          ),
                          AddSessionChip(
                            label: '+ OpenCode Chat',
                            color: AppColors.opencode,
                            onTap: () => _createSession(
                              SessionCli.opencode,
                              SessionKind.chat,
                            ),
                          ),
                          AddSessionChip(
                            label: '+ ZCode Term',
                            color: AppColors.zcode,
                            onTap: () => _createSession(
                              SessionCli.zcode,
                              SessionKind.terminal,
                            ),
                          ),
                          AddSessionChip(
                            label: '+ ZCode Chat',
                            color: AppColors.zcode,
                            onTap: () => _createSession(
                              SessionCli.zcode,
                              SessionKind.chat,
                            ),
                          ),
                        ],
                      ),
                      EventTimeline(
                        events: _workspace.events,
                        initiallyOpen: false,
                        maxEvents: 3,
                        maxExpandedHeight: 120,
                      ),
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
                          title: t('claudeTerminals'),
                          color: AppColors.claude,
                          sessions: groups['claude_terminal']!,
                          mgr: widget.mgr,
                          settings: widget.settings,
                          statuses: _workspace.statuses,
                          pendingNotes: _workspace.pendingNotes,
                          providers: _providers,
                          onOpen: _openSession,
                        ),
                        _SessionGroup(
                          title: t('claudeChats'),
                          color: AppColors.claude,
                          sessions: groups['claude_chat']!,
                          mgr: widget.mgr,
                          settings: widget.settings,
                          statuses: _workspace.statuses,
                          pendingNotes: _workspace.pendingNotes,
                          providers: _providers,
                          onOpen: _openSession,
                        ),
                        _SessionGroup(
                          title: t('codexTerminals'),
                          color: AppColors.codex,
                          sessions: groups['codex_terminal']!,
                          mgr: widget.mgr,
                          settings: widget.settings,
                          statuses: _workspace.statuses,
                          pendingNotes: _workspace.pendingNotes,
                          providers: _providers,
                          onOpen: _openSession,
                        ),
                        _SessionGroup(
                          title: t('codexChats'),
                          color: AppColors.codex,
                          sessions: groups['codex_chat']!,
                          mgr: widget.mgr,
                          settings: widget.settings,
                          statuses: _workspace.statuses,
                          pendingNotes: _workspace.pendingNotes,
                          providers: _providers,
                          onOpen: _openSession,
                        ),
                        if (groups['opencode_terminal']!.isNotEmpty)
                          _SessionGroup(
                            title: t('openCodeTerminals'),
                            color: AppColors.opencode,
                            sessions: groups['opencode_terminal']!,
                            mgr: widget.mgr,
                            settings: widget.settings,
                            statuses: _workspace.statuses,
                            pendingNotes: _workspace.pendingNotes,
                            providers: _providers,
                            onOpen: _openSession,
                          ),
                        if (groups['opencode_chat']!.isNotEmpty)
                          _SessionGroup(
                            title: t('openCodeChats'),
                            color: AppColors.opencode,
                            sessions: groups['opencode_chat']!,
                            mgr: widget.mgr,
                            settings: widget.settings,
                            statuses: _workspace.statuses,
                            pendingNotes: _workspace.pendingNotes,
                            providers: _providers,
                            onOpen: _openSession,
                          ),
                        if (groups['zcode_terminal']!.isNotEmpty)
                          _SessionGroup(
                            title: t('zCodeTerminals'),
                            color: AppColors.zcode,
                            sessions: groups['zcode_terminal']!,
                            mgr: widget.mgr,
                            settings: widget.settings,
                            statuses: _workspace.statuses,
                            pendingNotes: _workspace.pendingNotes,
                            providers: _providers,
                            onOpen: _openSession,
                          ),
                        if (groups['zcode_chat']!.isNotEmpty)
                          _SessionGroup(
                            title: t('zCodeChats'),
                            color: AppColors.zcode,
                            sessions: groups['zcode_chat']!,
                            mgr: widget.mgr,
                            settings: widget.settings,
                            statuses: _workspace.statuses,
                            pendingNotes: _workspace.pendingNotes,
                            providers: _providers,
                            onOpen: _openSession,
                          ),
                      ],
                    ],
                  ),
                ),
              ],
            );
          },
        ),
      ),
    );
  }
}

class _DirectoryCard extends StatefulWidget {
  final Directory directory;
  final SettingsService settings;
  final SessionManager mgr;
  final int index;
  final void Function(String dirId)? onDragHover;

  const _DirectoryCard({
    required this.directory,
    required this.settings,
    required this.mgr,
    required this.index,
    this.onDragHover,
  });

  @override
  State<_DirectoryCard> createState() => _DirectoryCardState();
}

class _DirectoryCardState extends State<_DirectoryCard> {
  late final WorkspaceService _workspace;

  @override
  void initState() {
    super.initState();
    _workspace = WorkspaceService(
      settings: widget.settings,
      dirId: widget.directory.id,
    );
    _workspace.onNotify = widget.mgr.handleWorkspaceNotify;
    _workspace.addListener(_onStatusChange);
    _workspace.connect();
  }

  @override
  void dispose() {
    _workspace.removeListener(_onStatusChange);
    _workspace.dispose();
    widget.mgr.reportWaiting(
      widget.directory.id,
      const {},
    ); // drop stale entries
    widget.mgr.reportRunning(widget.directory.id, const {});
    widget.mgr.reportStatuses(widget.directory.id, const {});
    super.dispose();
  }

  PopupMenuItem<String> _dirMenuItem(
    String value,
    IconData icon,
    String label, {
    bool danger = false,
  }) {
    final color = danger ? const Color(0xFFff6b63) : const Color(0xFFe7eaee);
    return PopupMenuItem<String>(
      value: value,
      height: 40,
      child: Row(
        children: [
          Icon(icon, size: 16, color: color),
          const SizedBox(width: 10),
          Text(label, style: TextStyle(color: color, fontSize: 14)),
        ],
      ),
    );
  }

  void _onStatusChange() {
    // Report this directory's waiting sessions up to the manager so the global
    // "等待输入" KPI reflects every directory, then repaint the card.
    final waiting = _workspace.statuses.entries
        .where((e) => e.value.status == 'waiting')
        .map((e) => e.key)
        .toSet();
    widget.mgr.reportWaiting(widget.directory.id, waiting);
    // Likewise report sessions that are busy right now (running / thinking /
    // editing) so the 「活跃会话」KPI counts only sessions actually executing.
    const busy = {'running', 'thinking', 'editing'};
    final running = _workspace.statuses.entries
        .where((e) => busy.contains(e.value.status))
        .map((e) => e.key)
        .toSet();
    widget.mgr.reportRunning(widget.directory.id, running);
    // Report the full live status map so the dashboard popups can show each
    // session's real-time status / summary / run-time (mirrors web).
    widget.mgr.reportStatuses(widget.directory.id, _workspace.statuses);
    if (mounted) setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final groups = widget.mgr.sessionsByCliKind(widget.directory.id);
    final claudeCount =
        widget.directory.claudeTerminalCount + widget.directory.claudeChatCount;
    final codexCount =
        widget.directory.codexTerminalCount + widget.directory.codexChatCount;
    final opencodeCount =
        widget.directory.opencodeTerminalCount +
        widget.directory.opencodeChatCount;
    final zcodeCount =
        widget.directory.zcodeTerminalCount + widget.directory.zcodeChatCount;
    final activeCount = groups.values
        .expand((s) => s)
        .where((s) => s.active)
        .length;
    final latestTask = _latestTask(groups);
    // Rainbow border when any session in this directory is running.
    const busy = {'running', 'thinking', 'editing'};
    final dirRunning = _workspace.statuses.values.any(
      (st) => busy.contains(st.status),
    );

    return RainbowBorder(
      running: dirRunning,
      borderRadius: BorderRadius.circular(8),
      child: LongPressDraggable<String>(
        data: widget.directory.id,
        onDragEnd: (_) {
          // 拖拽结束（无论是否成功 drop）都清除悬停指示器
          final parent = context
              .findAncestorStateOfType<_DirectoryListBodyState>();
          if (parent != null && parent._dragHoverDirId != null) {
            parent.setState(() => parent._dragHoverDirId = null);
          }
        },
        feedback: Material(
          elevation: 6,
          color: Colors.transparent,
          child: Container(
            width: MediaQuery.of(context).size.width - 24,
            margin: const EdgeInsets.only(bottom: 14),
            decoration: BoxDecoration(
              color: AppColors.panel,
              border: Border.all(color: AppColors.accent, width: 2),
              borderRadius: BorderRadius.circular(8),
              boxShadow: [
                BoxShadow(
                  color: Colors.black.withValues(alpha: 0.4),
                  blurRadius: 12,
                  offset: const Offset(0, 8),
                ),
              ],
            ),
            child: Padding(
              padding: const EdgeInsets.fromLTRB(14, 14, 10, 12),
              child: Row(
                children: [
                  Icon(Icons.drag_indicator, color: AppColors.accent, size: 20),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      widget.directory.name,
                      style: const TextStyle(
                        color: AppColors.textBright,
                        fontWeight: FontWeight.w700,
                        fontSize: 16,
                      ),
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
        childWhenDragging: Container(
          margin: const EdgeInsets.only(bottom: 14),
          decoration: BoxDecoration(
            color: AppColors.panel.withValues(alpha: 0.5),
            border: Border.all(color: AppColors.line),
            borderRadius: BorderRadius.circular(8),
          ),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(14, 14, 10, 12),
            child: Row(
              children: [
                Icon(Icons.drag_indicator, color: AppColors.faint, size: 20),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    widget.directory.name,
                    style: const TextStyle(
                      color: AppColors.faint,
                      fontWeight: FontWeight.w700,
                      fontSize: 16,
                    ),
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
              ],
            ),
          ),
        ),
        child: DragTarget<String>(
          onWillAcceptWithDetails: (details) {
            if (details.data != widget.directory.id) {
              // 通知父组件：拖拽悬停在此卡片上，显示插入指示器
              widget.onDragHover?.call(widget.directory.id);
              return true;
            }
            return false;
          },
          onLeave: (_) {
            // 拖拽离开时清除悬停状态
            final parent = context
                .findAncestorStateOfType<_DirectoryListBodyState>();
            if (parent != null &&
                parent._dragHoverDirId == widget.directory.id) {
              parent.setState(() => parent._dragHoverDirId = null);
            }
          },
          onAcceptWithDetails: (details) {
            // 通知父组件处理拖拽结束
            final parent = context
                .findAncestorStateOfType<_DirectoryListBodyState>();
            if (parent != null) {
              parent._handleDragEnd(details.data, widget.directory.id);
            }
          },
          builder: (context, candidateData, rejectedData) {
            final isHovering = candidateData.isNotEmpty;
            return AnimatedContainer(
              duration: const Duration(milliseconds: 200),
              margin: const EdgeInsets.only(bottom: 14),
              decoration: BoxDecoration(
                color: isHovering ? AppColors.panel2 : AppColors.panel,
                border: Border.all(
                  color: isHovering ? AppColors.accent : AppColors.line,
                  width: isHovering ? 2 : 1,
                ),
                borderRadius: BorderRadius.circular(8),
                boxShadow: [
                  BoxShadow(
                    color: Colors.black.withValues(alpha: 0.18),
                    blurRadius: 22,
                    offset: const Offset(0, 10),
                  ),
                ],
              ),
              child: InkWell(
                onTap: () => widget.mgr.openFleetDir(widget.directory.id),
                borderRadius: BorderRadius.circular(8),
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(14, 14, 10, 12),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          // 拖拽指示器
                          Icon(
                            Icons.drag_indicator,
                            size: 18,
                            color: AppColors.faint,
                          ),
                          const SizedBox(width: 8),
                          Container(
                            width: 34,
                            height: 34,
                            decoration: BoxDecoration(
                              color: AppColors.bg,
                              border: Border.all(color: AppColors.line),
                              borderRadius: BorderRadius.circular(8),
                            ),
                            child: const Icon(
                              Icons.folder_outlined,
                              color: AppColors.muted,
                              size: 20,
                            ),
                          ),
                          const SizedBox(width: 10),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  widget.directory.name,
                                  style: const TextStyle(
                                    color: AppColors.textBright,
                                    fontWeight: FontWeight.w700,
                                    fontSize: 16,
                                  ),
                                  overflow: TextOverflow.ellipsis,
                                ),
                                const SizedBox(height: 3),
                                Text(
                                  widget.directory.path,
                                  style: const TextStyle(
                                    color: AppColors.blue,
                                    fontSize: 11,
                                    fontFamily: 'monospace',
                                  ),
                                  overflow: TextOverflow.ellipsis,
                                ),
                                if ((widget.directory.pushState?.dirty ?? 0) >
                                    0)
                                  Padding(
                                    padding: const EdgeInsets.only(top: 5),
                                    child: InkWell(
                                      onTap: () =>
                                          _showUncommittedFiles(context),
                                      borderRadius: BorderRadius.circular(999),
                                      child: Container(
                                        padding: const EdgeInsets.symmetric(
                                          horizontal: 8,
                                          vertical: 2,
                                        ),
                                        decoration: BoxDecoration(
                                          color: const Color(0x1AE3B341),
                                          border: Border.all(
                                            color: const Color(0x73E3B341),
                                          ),
                                          borderRadius: BorderRadius.circular(
                                            999,
                                          ),
                                        ),
                                        child: Text(
                                          '⚠ ${widget.directory.pushState!.dirty} 未提交',
                                          style: const TextStyle(
                                            color: Color(0xFFE3B341),
                                            fontSize: 10,
                                            fontFamily: 'monospace',
                                          ),
                                        ),
                                      ),
                                    ),
                                  ),
                                // ── Git 状态行（分支 + ahead/behind）──
                                GitStatusRow(
                                  pushState: widget.directory.pushState,
                                ),
                              ],
                            ),
                          ),
                          IconButton(
                            icon: const Icon(
                              Icons.sticky_note_2_outlined,
                              size: 19,
                              color: AppColors.muted,
                            ),
                            tooltip: t('projectMemo'),
                            onPressed: () => Navigator.push(
                              context,
                              MaterialPageRoute<void>(
                                builder: (_) => MemoScreen(
                                  directory: widget.directory,
                                  mgr: widget.mgr,
                                ),
                              ),
                            ),
                            padding: EdgeInsets.zero,
                            constraints: const BoxConstraints(
                              minWidth: 44,
                              minHeight: 44,
                            ),
                          ),
                          PopupMenuButton<String>(
                            icon: const Icon(
                              Icons.more_horiz_rounded,
                              size: 19,
                              color: AppColors.muted,
                            ),
                            tooltip: t('moreActions'),
                            color: const Color(0xFF161b22),
                            padding: EdgeInsets.zero,
                            constraints: const BoxConstraints(
                              minWidth: 44,
                              minHeight: 44,
                            ),
                            onSelected: (v) {
                              switch (v) {
                                case 'uncommitted':
                                  _showUncommittedFiles(context);
                                  break;
                                case 'rename':
                                  _confirmRenameDirectory(context);
                                  break;
                                case 'delete':
                                  _confirmDeleteDirectory(context);
                                  break;
                              }
                            },
                            itemBuilder: (_) {
                              final items = <PopupMenuEntry<String>>[];
                              final dirty =
                                  widget.directory.pushState?.dirty ?? 0;
                              if (dirty > 0) {
                                items.add(
                                  _dirMenuItem(
                                    'uncommitted',
                                    Icons.warning_amber_rounded,
                                    '⚠ $dirty 个未提交文件',
                                  ),
                                );
                                items.add(const PopupMenuDivider());
                              }
                              items.add(
                                _dirMenuItem(
                                  'rename',
                                  Icons.drive_file_rename_outline_rounded,
                                  t('rename'),
                                ),
                              );
                              items.add(const PopupMenuDivider());
                              items.add(
                                _dirMenuItem(
                                  'delete',
                                  Icons.delete_outline_rounded,
                                  t('deleteDirectory'),
                                  danger: true,
                                ),
                              );
                              return items;
                            },
                          ),
                        ],
                      ),
                      const SizedBox(height: 12),
                      Wrap(
                        spacing: 6,
                        runSpacing: 6,
                        children: [
                          ProjectStatPill(
                            label: t('sessions'),
                            value: widget.directory.totalSessions.toString(),
                          ),
                          ProjectStatPill(
                            label: t('active'),
                            value: activeCount.toString(),
                          ),
                          ProjectStatPill(
                            label: 'Claude',
                            value: claudeCount.toString(),
                            color: AppColors.claude,
                          ),
                          ProjectStatPill(
                            label: 'Codex',
                            value: codexCount.toString(),
                            color: AppColors.codex,
                          ),
                          if (opencodeCount > 0)
                            ProjectStatPill(
                              label: 'OpenCode',
                              value: opencodeCount.toString(),
                              color: AppColors.opencode,
                            ),
                          if (zcodeCount > 0)
                            ProjectStatPill(
                              label: 'ZCode',
                              value: zcodeCount.toString(),
                              color: AppColors.zcode,
                            ),
                        ],
                      ),
                      const SizedBox(height: 12),
                      // 预览区域（最近活动 + 最新任务）— 恢复原始布局
                      _DirectoryPreview(
                        events: _workspace.events,
                        latestTask: latestTask,
                      ),
                      const SizedBox(height: 10),
                      Row(
                        children: [
                          const Icon(
                            Icons.touch_app_outlined,
                            size: 13,
                            color: AppColors.faint,
                          ),
                          const SizedBox(width: 5),
                          Text(
                            t('tapForDetails'),
                            style: const TextStyle(
                              color: AppColors.faint,
                              fontSize: 11,
                            ),
                          ),
                          const Spacer(),
                          const Icon(
                            Icons.keyboard_arrow_up_rounded,
                            size: 18,
                            color: AppColors.faint,
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
              ),
            );
          },
        ),
      ),
    );
  }

  _TaskPreview? _latestTask(Map<String, List<Session>> groups) {
    // 获取该目录下所有会话，按 lastActivity 或 createdAt 排序
    final allSessions = groups.values.expand((x) => x).toList();
    if (allSessions.isEmpty) return null;

    // 按 lastActivity 或 createdAt 降序排序
    allSessions.sort((a, b) {
      final ta = sessionLastInteractionAt(a, _workspace.statuses[a.id]);
      final tb = sessionLastInteractionAt(b, _workspace.statuses[b.id]);
      return tb.compareTo(ta);
    });

    // 找到最新的有 summary 的会话
    for (final s in allSessions) {
      final live = _workspace.statuses[s.id];
      final summary = live?.summary;
      if (summary == null || summary.isEmpty) continue;
      final ts = live?.summaryTs != null && live!.summaryTs > 0
          ? live.summaryTs
          : sessionLastInteractionAt(s, live).millisecondsSinceEpoch;
      return _TaskPreview(
        who: s.label?.isNotEmpty == true ? s.label! : s.id,
        summary: summary,
        ts: ts,
      );
    }

    // 如果没有活跃的 summary，返回最近活跃的会话信息
    final latest = allSessions.first;
    final live = _workspace.statuses[latest.id];
    final ts = live?.summaryTs != null && live!.summaryTs > 0
        ? live.summaryTs
        : sessionLastInteractionAt(latest, live).millisecondsSinceEpoch;

    // 生成一个基本的任务描述
    String summary;
    if (live?.currentFile != null && live!.currentFile!.isNotEmpty) {
      summary = '正在编辑 ${live.currentFile!.split('/').last}';
    } else if (latest.active) {
      summary = '正在运行';
    } else {
      final ago = DateTime.now().millisecondsSinceEpoch ~/ 1000 - ts ~/ 1000;
      if (ago < 3600) {
        summary = '最近 ${ago ~/ 60} 分钟前活跃';
      } else if (ago < 86400) {
        summary = '最近 ${ago ~/ 3600} 小时前活跃';
      } else {
        summary = '最近 ${ago ~/ 86400} 天前活跃';
      }
    }

    return _TaskPreview(
      who: latest.label?.isNotEmpty == true ? latest.label! : latest.id,
      summary: summary,
      ts: ts,
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
      builder: (dialogCtx) => _UncommittedFilesDialog(
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

class _TaskPreview {
  final String who;
  final String summary;
  final int ts;

  const _TaskPreview({
    required this.who,
    required this.summary,
    required this.ts,
  });
}

class _DirectoryPreview extends StatelessWidget {
  final List<Map<String, dynamic>> events;
  final _TaskPreview? latestTask;

  const _DirectoryPreview({required this.events, required this.latestTask});

  @override
  Widget build(BuildContext context) {
    final recent = events.reversed.take(2).toList();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        // 固定高度的最近活动区域
        SizedBox(
          height: 39,
          child: recent.isEmpty
              ? Align(
                  alignment: Alignment.centerLeft,
                  child: Text(
                    t('noRecentActivity'),
                    style: const TextStyle(
                      color: AppColors.faint,
                      fontSize: 11,
                    ),
                  ),
                )
              : Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    for (final e in recent)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 3),
                        child: Text(
                          _eventLabel(e),
                          style: const TextStyle(
                            color: AppColors.muted,
                            fontSize: 11,
                            height: 1.25,
                          ),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                  ],
                ),
        ),
        const SizedBox(height: 6),
        // 固定高度的最新任务区域
        SizedBox(
          height: 34,
          child: latestTask == null
              ? Align(
                  alignment: Alignment.centerLeft,
                  child: Text(
                    t('noRecentTask'),
                    style: const TextStyle(
                      color: AppColors.faint,
                      fontSize: 11,
                    ),
                  ),
                )
              : Container(
                  width: double.infinity,
                  padding: const EdgeInsets.symmetric(
                    horizontal: 8,
                    vertical: 6,
                  ),
                  decoration: BoxDecoration(
                    color: AppColors.accent.withValues(alpha: 0.10),
                    border: Border.all(
                      color: AppColors.accent.withValues(alpha: 0.38),
                    ),
                    borderRadius: BorderRadius.circular(7),
                  ),
                  child: Text(
                    '🗒 ${latestTask!.who}  ${latestTask!.summary}',
                    style: const TextStyle(
                      color: Color(0xFF7fe6da),
                      fontSize: 11,
                      height: 1.2,
                    ),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
        ),
      ],
    );
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
                _eventLabel(e),
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

String _eventLabel(Map<String, dynamic> e) {
  final who = (e['sessionLabel'] ?? e['sessionId'] ?? '') as String;
  final detail = (e['detail'] ?? '') as String;
  switch (e['type']) {
    case 'session_created':
      return '🆕 新建会话 $who（$detail）';
    case 'session_renamed':
      return '✏️ 会话改名为 ${detail.isNotEmpty ? detail : who}';
    case 'session_deleted':
      return '🗑 删除会话 ${detail.isNotEmpty ? detail : who}';
    case 'merged':
      return '🔀 $who 合并：$detail';
    case 'memory_updated':
      return '🧠 $who ${detail.isNotEmpty ? detail : '更新会话记忆'}';
    case 'synced':
      return '🔄 $who 同步：$detail';
    case 'sync_conflict':
      return '⚠️ $who ${detail.isNotEmpty ? detail : '同步冲突'}';
    case 'dispatch':
      return '📤 $who 分发 $detail';
    case 'note':
      return '📨 $who 留言 $detail';
    case 'note_delivered':
      return '📬 $who：$detail';
    default:
      return '· ${e['type']} $who';
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SESSION GROUP + CARD
// ═══════════════════════════════════════════════════════════════════════════════

class _SessionGroup extends StatelessWidget {
  final String title;
  final Color color;
  final List<Session> sessions;
  final SessionManager mgr;
  final SettingsService settings;
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
    required this.statuses,
    required this.pendingNotes,
    this.providers = const [],
    this.onOpen,
  });

  @override
  Widget build(BuildContext context) {
    if (sessions.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.fromLTRB(14, 10, 14, 0),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.only(bottom: 8, left: 2),
            child: Text(
              '${title.toUpperCase()} · ${sessions.length}',
              style: TextStyle(
                color: color,
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
              final sortedSessions = [...sessions]
                ..sort(
                  (a, b) => sessionLastInteractionAt(
                    b,
                    statuses[b.id],
                  ).compareTo(sessionLastInteractionAt(a, statuses[a.id])),
                );
              return Wrap(
                spacing: gap,
                runSpacing: gap,
                children: [
                  for (final s in sortedSessions)
                    SizedBox(
                      width: cardWidth,
                      child: SessionCard(
                        session: s,
                        mgr: mgr,
                        settings: settings,
                        liveStatus: statuses[s.id],
                        pendingNotes: pendingNotes[s.id] ?? 0,
                        providers: providers,
                        onOpen: onOpen,
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

/// Dialog listing a directory's uncommitted files with a "commit all" action.
/// Mirrors the web "⚠ 未提交文件" modal — surfaces dirty main working-tree
/// files so they can be committed before tangling a session worktree merge.
class _UncommittedFilesDialog extends StatefulWidget {
  final String dirName;
  final String dirPath;
  final List<Map<String, dynamic>> files;
  final String? loadError;
  // Returns true if the dialog should close (commit succeeded / nothing to do).
  final Future<bool> Function() onCommit;

  const _UncommittedFilesDialog({
    required this.dirName,
    required this.dirPath,
    required this.files,
    required this.onCommit,
    this.loadError,
  });

  @override
  State<_UncommittedFilesDialog> createState() =>
      _UncommittedFilesDialogState();
}

class _UncommittedFilesDialogState extends State<_UncommittedFilesDialog> {
  bool _committing = false;

  @override
  Widget build(BuildContext context) {
    final hasError = widget.loadError != null && widget.files.isEmpty;
    return AlertDialog(
      backgroundColor: const Color(0xFF0f1115),
      title: Text(
        '⚠ ${widget.dirName} · 未提交文件',
        style: const TextStyle(color: Color(0xFFf2f4f7)),
      ),
      content: SizedBox(
        width: double.maxFinite,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              widget.dirPath,
              style: const TextStyle(
                color: Color(0xFF8a909b),
                fontSize: 12,
                fontFamily: 'monospace',
              ),
            ),
            const SizedBox(height: 12),
            if (hasError)
              Text(
                '加载失败：${widget.loadError}',
                style: const TextStyle(color: Color(0xFFff6b63), fontSize: 13),
              )
            else if (widget.files.isEmpty)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 24),
                child: Center(
                  child: Text(
                    '没有未提交文件 ✓',
                    style: TextStyle(color: Color(0xFF8a909b)),
                  ),
                ),
              )
            else
              Flexible(
                child: ListView.builder(
                  shrinkWrap: true,
                  itemCount: widget.files.length,
                  itemBuilder: (_, i) {
                    final f = widget.files[i];
                    final status = (f['status'] ?? '??').toString().trim();
                    final p = (f['path'] ?? '').toString();
                    return Padding(
                      padding: const EdgeInsets.symmetric(vertical: 2),
                      child: Row(
                        children: [
                          SizedBox(
                            width: 28,
                            child: Text(
                              status.isEmpty ? '??' : status,
                              style: const TextStyle(
                                color: Color(0xFF8a909b),
                                fontSize: 12,
                                fontFamily: 'monospace',
                              ),
                            ),
                          ),
                          const SizedBox(width: 8),
                          Expanded(
                            child: Text(
                              p,
                              style: const TextStyle(
                                color: Color(0xFFe7eaee),
                                fontSize: 13,
                                fontFamily: 'monospace',
                              ),
                              overflow: TextOverflow.ellipsis,
                            ),
                          ),
                        ],
                      ),
                    );
                  },
                ),
              ),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('关闭', style: TextStyle(color: Color(0xFF8a909b))),
        ),
        if (widget.files.isNotEmpty)
          ElevatedButton(
            style: ElevatedButton.styleFrom(
              backgroundColor: const Color(0xFFE3B341),
              foregroundColor: const Color(0xFF0f1115),
            ),
            onPressed: _committing
                ? null
                : () async {
                    setState(() => _committing = true);
                    final close = await widget.onCommit();
                    if (!mounted) return;
                    setState(() => _committing = false);
                    if (close && context.mounted) Navigator.pop(context);
                  },
            child: Text(_committing ? '提交中…' : '全部提交'),
          ),
      ],
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  GIT STATUS ROW — 在舰队卡片上显示分支名 + ahead/behind/脏 状态的紧凑行
// ═══════════════════════════════════════════════════════════════════════════════
