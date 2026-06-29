import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:timeago/timeago.dart' as timeago;
import 'package:shared_preferences/shared_preferences.dart';

import '../models/message.dart';
import '../providers/chat_provider.dart';
import '../providers/session_manager.dart';
import '../services/session_service.dart';
import '../services/settings_service.dart';
import '../services/manage_service.dart';
import '../services/workspace_service.dart';
import '../i18n.dart';
import '../theme.dart';
import '../widgets/conflict_diff_dialog.dart';
import '../widgets/session_diff_dialog.dart';
import '../widgets/model_picker.dart';
import 'chat_screen.dart';
import 'memo_screen.dart';
import 'settings_screen.dart';
import 'cron_screen.dart';
import 'terminal_screen.dart';

// Brand colors used to distinguish Claude vs Codex sessions.
const _kClaudeColor = Color(0xFFf0936b);
const _kCodexColor = Color(0xFF7fd49a);

// Workspace status board: map a live agent status to a colour / label.
Color _wbStatusColor(String? status) {
  switch (status) {
    case 'thinking':
      return const Color(0xFF6aa3ff);
    case 'editing':
      return const Color(0xFFe3b341);
    case 'running':
      return const Color(0xFF7fd49a);
    case 'waiting':
      return const Color(0xFFf0936b);
    default:
      return const Color(0xFF5b616c);
  }
}

String _wbStatusLabel(String? status) {
  switch (status) {
    case 'thinking':
      return t('thinking');
    case 'editing':
      return t('editing');
    case 'running':
      return t('running');
    case 'waiting':
      return t('waiting');
    default:
      return t('idle');
  }
}

String _mergeReadyLabel(SessionStatus status) {
  final ahead = status.ahead;
  final dirty = status.dirty;
  final base = status.baseBranch ?? t('baseBranch');
  if (dirty && ahead > 0) {
    return t('mergeReadyLabelDirtyAhead', {'n': '$ahead', 'base': base});
  }
  if (ahead > 0) {
    return t('mergeReadyLabelAhead', {'n': '$ahead', 'base': base});
  }
  return t('mergeReadyLabel', {'base': base});
}

DateTime _sessionLastInteractionAt(Session session, SessionStatus? live) {
  var best = session.createdAt;
  final saved = session.lastActivity;
  if (saved != null && saved.isAfter(best)) best = saved;
  final liveMs = live?.lastActivity ?? 0;
  if (liveMs > 0) {
    final liveAt = DateTime.fromMillisecondsSinceEpoch(liveMs);
    if (liveAt.isAfter(best)) best = liveAt;
  }
  return best;
}

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
    return PopScope(
      canPop: active == null,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop && active != null) mgr.goToSessionList();
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

  static const double _snapHalf = 0.75; // default opened height
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

  Future<List<String>?> _loadDirOrder() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getStringList(_dirOrderKey);
  }

  Future<void> _saveDirOrder(List<String> order) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setStringList(_dirOrderKey, order);
  }

  @override
  void initState() {
    super.initState();
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
              _KpiRow(settings: widget.settings),
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

    return FutureBuilder<List<String>?>(future: _loadDirOrder(), builder: (context, snapshot) {
      final savedOrder = snapshot.data;
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
          _HomeTaskScroller(
            sessions: mgr.sessions,
            directories: mgr.directories,
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
                itemBuilder: (_, i) => _DirectoryCard(
                  directory: orderedDirectories[i],
                  settings: widget.settings,
                  mgr: mgr,
                  index: i,
                ),
              ),
            ),
          ),
        ],
      );
      },
    );
  }

  Future<void> _handleDragEnd(int fromIndex, int toIndex) async {
    final mgr = context.read<SessionManager>();
    final dirs = List<Directory>.from(mgr.directories);

    if (fromIndex < 0 || fromIndex >= dirs.length || toIndex < 0 || toIndex >= dirs.length) {
      return;
    }

    // 更新列表顺序
    final temp = dirs[fromIndex];
    dirs.removeAt(fromIndex);
    dirs.insert(toIndex, temp);

    // 保存顺序
    final newOrder = dirs.map((d) => d.id).toList();
    await _saveDirOrder(newOrder);

    // 通知 SessionManager 刷新（如果需要）
    // mgr.notifyListeners();

    // 刷新UI
    if (mounted) {
      setState(() {});
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
                decoration: _inputDec(hint: 'My project'),
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
                decoration: _inputDec(hint: '/Users/you/code/my-project'),
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
              if (error != null)
                const SizedBox(height: 10),
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
  const _KpiRow({required this.settings});

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
          _KpiTile(
            label: t('activeSessions'),
            value: '$active',
            color: const Color(0xFF3ad6c5),
            onTap: () => _showSessionSheet(
              context,
              mgr,
              t('activeSessions'),
              mgr.activeSessions,
              '🟢',
            ),
          ),
          const SizedBox(width: 8),
          _KpiTile(
            label: t('waitingSessions'),
            value: '$waiting',
            color: const Color(0xFFe3b341),
            onTap: () => _showSessionSheet(
              context,
              mgr,
              t('waitingSessions'),
              mgr.waitingSessions,
              '⏳',
            ),
          ),
          const SizedBox(width: 8),
          _KpiTile(
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

class _KpiTile extends StatelessWidget {
  final String label;
  final String? value;
  final Color color;
  final VoidCallback onTap;
  const _KpiTile({
    required this.label,
    required this.value,
    required this.color,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return Expanded(
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(10),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
          decoration: BoxDecoration(
            color: const Color(0xFF14171c),
            borderRadius: BorderRadius.circular(10),
            border: Border.all(color: const Color(0xFF20242b)),
          ),
          child: Row(
            children: [
              Container(
                width: 7,
                height: 7,
                decoration: BoxDecoration(color: color, shape: BoxShape.circle),
              ),
              const SizedBox(width: 7),
              Expanded(
                child: Text(
                  label,
                  style: const TextStyle(
                    color: Color(0xFF8a909b),
                    fontSize: 12,
                  ),
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              if (value != null) ...[
                const SizedBox(width: 4),
                Text(
                  value!,
                  style: TextStyle(
                    color: color,
                    fontSize: 15,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ] else
                const Icon(
                  Icons.chevron_right,
                  size: 16,
                  color: Color(0xFF5b616c),
                ),
            ],
          ),
        ),
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
  String prefix,
) {
  String dirName(String? dirId) {
    for (final d in mgr.directories) {
      if (d.id == dirId) return d.name;
    }
    return '';
  }

  showModalBottomSheet<void>(
    context: context,
    backgroundColor: const Color(0xFF0f1115),
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
    ),
    builder: (sheetCtx) => SafeArea(
      child: Column(
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
                Text(
                  '${sessions.length}',
                  style: const TextStyle(
                    color: Color(0xFF8a909b),
                    fontSize: 13,
                  ),
                ),
              ],
            ),
          ),
          if (sessions.isEmpty)
            const Padding(
              padding: EdgeInsets.fromLTRB(18, 8, 18, 24),
              child: Align(
                alignment: Alignment.centerLeft,
                child: Text(
                  '没有符合的会话',
                  style: TextStyle(color: Color(0xFF5b616c), fontSize: 13),
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
                  final alias = (s.label?.isNotEmpty == true) ? s.label! : s.id;
                  final dir = dirName(s.dirId);
                  return ListTile(
                    dense: true,
                    leading: Text(prefix, style: const TextStyle(fontSize: 16)),
                    title: Text(
                      dir.isNotEmpty ? '$dir / $alias' : alias,
                      style: const TextStyle(
                        color: Color(0xFFe7eaee),
                        fontSize: 14,
                      ),
                      overflow: TextOverflow.ellipsis,
                    ),
                    trailing: const Icon(
                      Icons.arrow_forward_ios,
                      size: 13,
                      color: Color(0xFF5b616c),
                    ),
                    onTap: () {
                      Navigator.of(sheetCtx).pop();
                      mgr.openSession(s);
                      mgr.switchToSession(s.id);
                    },
                  );
                },
              ),
            ),
          const SizedBox(height: 8),
        ],
      ),
    ),
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
//  PROJECT CARD — one per directory, expanded by default
// ═══════════════════════════════════════════════════════════════════════════════

class _DirectoryCard extends StatefulWidget {
  final Directory directory;
  final SettingsService settings;
  final SessionManager mgr;
  final int index;

  const _DirectoryCard({
    required this.directory,
    required this.settings,
    required this.mgr,
    required this.index,
  });

  @override
  State<_DirectoryCard> createState() => _DirectoryCardState();
}

class _DirectoryDetailAction {
  final Session? session;
  final SessionCli? cli;
  final SessionKind? kind;

  const _DirectoryDetailAction.open(this.session) : cli = null, kind = null;

  const _DirectoryDetailAction.create(this.cli, this.kind) : session = null;
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
    if (mounted) setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final groups = widget.mgr.sessionsByCliKind(widget.directory.id);
    final claudeCount =
        widget.directory.claudeTerminalCount + widget.directory.claudeChatCount;
    final codexCount =
        widget.directory.codexTerminalCount + widget.directory.codexChatCount;
    final activeCount = groups.values
        .expand((s) => s)
        .where((s) => s.active)
        .length;
    final latestTask = _latestTask(groups);

    return LongPressDraggable<int>(
      data: widget.index,
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
      child: DragTarget<int>(
        onWillAcceptWithDetails: (details) {
          return details.data != widget.index;
        },
        onAcceptWithDetails: (details) {
          // 通知父组件处理拖拽结束
          final parent = context.findAncestorStateOfType<_DirectoryListBodyState>();
          if (parent != null) {
            parent._handleDragEnd(details.data, widget.index);
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
              onTap: () => _showDirectoryDetail(context),
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
                              case 'rename':
                                _confirmRenameDirectory(context);
                                break;
                              case 'delete':
                                _confirmDeleteDirectory(context);
                                break;
                            }
                          },
                          itemBuilder: (_) => [
                            _dirMenuItem(
                              'rename',
                              Icons.drive_file_rename_outline_rounded,
                              t('rename'),
                            ),
                            const PopupMenuDivider(),
                            _dirMenuItem(
                              'delete',
                              Icons.delete_outline_rounded,
                              t('deleteDirectory'),
                              danger: true,
                            ),
                          ],
                        ),
                      ],
                    ),
                    const SizedBox(height: 12),
                    Wrap(
                      spacing: 6,
                      runSpacing: 6,
                      children: [
                        _ProjectStatPill(
                          label: t('sessions'),
                          value: widget.directory.totalSessions.toString(),
                        ),
                        _ProjectStatPill(
                          label: t('active'),
                          value: activeCount.toString(),
                        ),
                        _ProjectStatPill(
                          label: 'Claude',
                          value: claudeCount.toString(),
                          color: _kClaudeColor,
                        ),
                        _ProjectStatPill(
                          label: 'Codex',
                          value: codexCount.toString(),
                          color: _kCodexColor,
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
    );
  }

  _TaskPreview? _latestTask(Map<String, List<Session>> groups) {
    // 获取该目录下所有会话，按 lastActivity 或 createdAt 排序
    final allSessions = groups.values.expand((x) => x).toList();
    if (allSessions.isEmpty) return null;

    // 按 lastActivity 或 createdAt 降序排序
    allSessions.sort((a, b) {
      final ta = _sessionLastInteractionAt(a, _workspace.statuses[a.id]);
      final tb = _sessionLastInteractionAt(b, _workspace.statuses[b.id]);
      return tb.compareTo(ta);
    });

    // 找到最新的有 summary 的会话
    for (final s in allSessions) {
      final live = _workspace.statuses[s.id];
      final summary = live?.summary;
      if (summary == null || summary.isEmpty) continue;
      final ts = live?.summaryTs != null && live!.summaryTs > 0
          ? live.summaryTs
          : _sessionLastInteractionAt(s, live).millisecondsSinceEpoch;
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
        : _sessionLastInteractionAt(latest, live).millisecondsSinceEpoch;

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

  Future<void> _showDirectoryDetail(BuildContext context) async {
    final action = await showModalBottomSheet<_DirectoryDetailAction>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AppColors.panel,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(18)),
      ),
      builder: (sheetCtx) => SafeArea(
        child: SizedBox(
          height: MediaQuery.of(sheetCtx).size.height * 0.88,
          child: AnimatedBuilder(
            animation: Listenable.merge([_workspace, widget.mgr]),
            builder: (context, _) {
              Directory dir = widget.directory;
              for (final d in widget.mgr.directories) {
                if (d.id == widget.directory.id) {
                  dir = d;
                  break;
                }
              }
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
                        _DirectoryPushButton(
                          directory: dir,
                          onPressed: () => _pushDirectory(context),
                        ),
                        IconButton(
                          tooltip: t('close'),
                          onPressed: () => Navigator.of(sheetCtx).pop(),
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
                            _AddSessionChip(
                              label: '+ Claude Term',
                              color: _kClaudeColor,
                              onTap: () => Navigator.of(sheetCtx).pop(
                                const _DirectoryDetailAction.create(
                                  SessionCli.claude,
                                  SessionKind.terminal,
                                ),
                              ),
                            ),
                            _AddSessionChip(
                              label: '+ Claude Chat',
                              color: _kClaudeColor,
                              onTap: () => Navigator.of(sheetCtx).pop(
                                const _DirectoryDetailAction.create(
                                  SessionCli.claude,
                                  SessionKind.chat,
                                ),
                              ),
                            ),
                            _AddSessionChip(
                              label: '+ Codex Term',
                              color: _kCodexColor,
                              onTap: () => Navigator.of(sheetCtx).pop(
                                const _DirectoryDetailAction.create(
                                  SessionCli.codex,
                                  SessionKind.terminal,
                                ),
                              ),
                            ),
                            _AddSessionChip(
                              label: '+ Codex Chat',
                              color: _kCodexColor,
                              onTap: () => Navigator.of(sheetCtx).pop(
                                const _DirectoryDetailAction.create(
                                  SessionCli.codex,
                                  SessionKind.chat,
                                ),
                              ),
                            ),
                          ],
                        ),
                        EventTimeline(
                          events: _workspace.events,
                          initiallyOpen: true,
                          maxEvents: null,
                          maxExpandedHeight: 280,
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
                            color: _kClaudeColor,
                            sessions: groups['claude_terminal']!,
                            mgr: widget.mgr,
                            settings: widget.settings,
                            statuses: _workspace.statuses,
                            pendingNotes: _workspace.pendingNotes,
                            onOpen: (s) => Navigator.of(
                              sheetCtx,
                            ).pop(_DirectoryDetailAction.open(s)),
                          ),
                          _SessionGroup(
                            title: t('claudeChats'),
                            color: _kClaudeColor,
                            sessions: groups['claude_chat']!,
                            mgr: widget.mgr,
                            settings: widget.settings,
                            statuses: _workspace.statuses,
                            pendingNotes: _workspace.pendingNotes,
                            onOpen: (s) => Navigator.of(
                              sheetCtx,
                            ).pop(_DirectoryDetailAction.open(s)),
                          ),
                          _SessionGroup(
                            title: t('codexTerminals'),
                            color: _kCodexColor,
                            sessions: groups['codex_terminal']!,
                            mgr: widget.mgr,
                            settings: widget.settings,
                            statuses: _workspace.statuses,
                            pendingNotes: _workspace.pendingNotes,
                            onOpen: (s) => Navigator.of(
                              sheetCtx,
                            ).pop(_DirectoryDetailAction.open(s)),
                          ),
                          _SessionGroup(
                            title: t('codexChats'),
                            color: _kCodexColor,
                            sessions: groups['codex_chat']!,
                            mgr: widget.mgr,
                            settings: widget.settings,
                            statuses: _workspace.statuses,
                            pendingNotes: _workspace.pendingNotes,
                            onOpen: (s) => Navigator.of(
                              sheetCtx,
                            ).pop(_DirectoryDetailAction.open(s)),
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
      ),
    );
    if (!mounted || action == null) return;
    final session = action.session;
    if (session != null) {
      _openSession(session);
    } else {
      await _createSession(action.cli!, action.kind!);
    }
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

    // Fetch providers for the picker
    final appType = cli == SessionCli.codex ? 'codex' : 'claude';
    List<Map<String, dynamic>> providers = [];
    try {
      final d = await ManageService(
        settings: widget.settings,
      ).fetchProviders(appType);
      providers = (d['providers'] as List? ?? [])
          .map((e) => (e as Map).cast<String, dynamic>())
          .toList();
    } catch (_) {}

    // Single dialog: name + role + provider + model
    String? label;
    String? rolePrompt;
    String? provider;
    String? model;

    final nameCtrl = TextEditingController();
    final roleCtrl = TextEditingController();
    String? pickedProvider;
    String? pickedModel;
    final modelKnown = kClaudeModelOptions.any((e) => e.key == widget.settings.defaultModel);

    final formKey = GlobalKey<FormState>();
    final formResult = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: const Color(0xFF0f1115),
        title: Text(
          '新建 ${cli == SessionCli.codex ? 'Codex' : ''} ${kind == SessionKind.chat ? 'Chat' : 'Terminal'}',
          style: const TextStyle(color: Color(0xFFf2f4f7), fontSize: 16),
        ),
        content: SingleChildScrollView(
          child: Form(
            key: formKey,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                // ── Name ──
                const Text('会话名称', style: TextStyle(color: Color(0xFF8a909b), fontSize: 11)),
                const SizedBox(height: 4),
                TextField(
                  controller: nameCtrl,
                  style: const TextStyle(color: Color(0xFFe7eaee), fontSize: 13),
                  decoration: _inputDec(hint: '可选，留空自动生成'),
                ),
                const SizedBox(height: 12),
                // ── Role prompt ──
                const Text('角色提示词', style: TextStyle(color: Color(0xFF8a909b), fontSize: 11)),
                const SizedBox(height: 4),
                TextField(
                  controller: roleCtrl,
                  maxLines: 3,
                  style: const TextStyle(color: Color(0xFFe7eaee), fontSize: 13),
                  decoration: _inputDec(hint: '可选，留空继承目录默认'),
                ),
                const SizedBox(height: 12),
                // ── Provider ──
                const Text('Provider', style: TextStyle(color: Color(0xFF8a909b), fontSize: 11)),
                const SizedBox(height: 4),
                DropdownButtonFormField<String>(
                  value: pickedProvider,
                  dropdownColor: const Color(0xFF0f1115),
                  style: const TextStyle(color: Color(0xFFe7eaee), fontSize: 13),
                  decoration: _inputDec(),
                  items: [
                    DropdownMenuItem(
                      value: '',
                      child: const Text('默认登录 / 订阅', style: TextStyle(color: Color(0xFFe7eaee))),
                    ),
                    ...providers.map((p) => DropdownMenuItem(
                      value: p['id'] as String,
                      child: Text(
                        '${p['name']}${p['isOfficial'] == true ? ' · 订阅' : ''}',
                        style: const TextStyle(color: Color(0xFFe7eaee)),
                      ),
                    )),
                  ],
                  onChanged: (v) => pickedProvider = v,
                ),
                // ── Model (claude only) ──
                if (cli == SessionCli.claude) ...[
                  const SizedBox(height: 12),
                  const Text('模型', style: TextStyle(color: Color(0xFF8a909b), fontSize: 11)),
                  const SizedBox(height: 4),
                  DropdownButtonFormField<String>(
                    value: widget.settings.defaultModel.isNotEmpty && modelKnown
                        ? widget.settings.defaultModel : null,
                    dropdownColor: const Color(0xFF0f1115),
                    style: const TextStyle(color: Color(0xFFe7eaee), fontSize: 13),
                    decoration: _inputDec(),
                    items: kClaudeModelOptions.map((e) => DropdownMenuItem(
                      value: e.key,
                      child: Text(e.value, style: const TextStyle(color: Color(0xFFe7eaee))),
                    )).toList(),
                    onChanged: (v) => pickedModel = v,
                  ),
                ],
              ],
            ),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('取消', style: TextStyle(color: Color(0xFF8a909b))),
          ),
          ElevatedButton(
            style: ElevatedButton.styleFrom(
              backgroundColor: const Color(0xFF22ab9c),
              foregroundColor: Colors.white,
            ),
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('创建'),
          ),
        ],
      ),
    );
    if (formResult != true) return;
    if (!mounted) return;

    label = nameCtrl.text.trim().isNotEmpty ? nameCtrl.text.trim() : null;
    rolePrompt = roleCtrl.text.trim().isNotEmpty ? roleCtrl.text.trim() : null;
    provider = (pickedProvider != null && pickedProvider!.isNotEmpty) ? pickedProvider : null;
    if (cli == SessionCli.claude) {
      model = (pickedModel != null && pickedModel!.isNotEmpty) ? pickedModel : null;
    }

    try {
      final s = await widget.mgr.createSessionInDir(
        dirId: widget.directory.id,
        cli: cli,
        kind: kind,
        label: label,
        model: model,
        provider: provider,
      );
      if (!mounted) return;
      // Auto-open the freshly created session
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
          decoration: _inputDec(hint: 'Directory name'),
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

  Future<void> _pushDirectory(BuildContext context) async {
    final messenger = ScaffoldMessenger.of(context);
    messenger.showSnackBar(
      SnackBar(
        content: Text(t('pushing')),
        duration: const Duration(seconds: 30),
      ),
    );
    try {
      final r = await widget.mgr.service.pushDirectory(widget.directory.id);
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

/// 首页全局任务滚动展示器（放在目录列表上方，类似大屏监控器）
/// 展示「当天用过的会话」，按最近使用时间倒序，每条停留 15s 自动轮播
class _HomeTaskScroller extends StatefulWidget {
  final List<Session> sessions;
  final List<Directory> directories;
  final void Function(Session session)? onSessionTap;

  const _HomeTaskScroller({
    required this.sessions,
    required this.directories,
    this.onSessionTap,
  });

  @override
  State<_HomeTaskScroller> createState() => _HomeTaskScrollerState();
}

class _HomeTaskScrollerState extends State<_HomeTaskScroller> {
  static const double _rowH = 46; // 每行高度
  static const int _maxVisible = 3; // 同时最多显示几行
  static const Duration _dwell = Duration(seconds: 5); // 轮播时每行停留时长

  final ScrollController _scrollController = ScrollController();
  Timer? _timer;
  int _count = 0; // 当天任务总条数
  int _visible = 1; // 当前同时可见的行数
  int _pos = 0; // 轮播已滚动的行偏移

  @override
  void dispose() {
    _timer?.cancel();
    _scrollController.dispose();
    super.dispose();
  }

  // 行数装得下就停掉轮播；装不下才按 _dwell 逐行滚动
  void _syncTimer() {
    if (!mounted) return;
    if (_count > _visible) {
      _timer ??= Timer.periodic(_dwell, (_) => _tick());
    } else {
      _timer?.cancel();
      _timer = null;
      _pos = 0;
      if (_scrollController.hasClients && _scrollController.offset != 0) {
        _scrollController.jumpTo(0);
      }
    }
  }

  void _tick() {
    if (!mounted || !_scrollController.hasClients || _count <= _visible) return;
    _pos += 1;
    _scrollController
        .animateTo(
      _pos * _rowH,
      duration: const Duration(milliseconds: 500),
      curve: Curves.easeInOut,
    )
        .then((_) {
      // 滚到末尾（尾部副本=头部几行）后无缝跳回起点
      if (!mounted || !_scrollController.hasClients) return;
      if (_pos >= _count) {
        _pos = 0;
        _scrollController.jumpTo(0);
      }
    });
  }

  bool _isToday(DateTime? ts) {
    if (ts == null) return false;
    final n = DateTime.now();
    return ts.year == n.year && ts.month == n.month && ts.day == n.day;
  }

  @override
  Widget build(BuildContext context) {
    // 取「当天用过的会话」（非 aux），按最近使用时间倒序
    final dirNames = {for (final d in widget.directories) d.id: d.name};
    final tasks = <_ActiveTask>[];
    for (final s in widget.sessions) {
      if (s.isAux) continue;
      if (!_isToday(s.lastActivity)) continue;
      tasks.add(_ActiveTask(
        session: s,
        label: s.label?.isNotEmpty == true ? s.label! : s.id,
        dirName: dirNames[s.dirId] ?? '',
        active: s.active,
        lastActivity: s.lastActivity,
      ));
    }
    tasks.sort((a, b) {
      final ta = a.lastActivity?.millisecondsSinceEpoch ?? 0;
      final tb = b.lastActivity?.millisecondsSinceEpoch ?? 0;
      return tb.compareTo(ta);
    });

    _count = tasks.length;
    _visible = _count == 0
        ? 1
        : (_count < _maxVisible ? _count : _maxVisible);
    if (_pos >= _count) _pos = 0;

    // 装不下时尾部接上「头部 _visible 行」的副本，配合 jumpTo 实现无缝轮播
    final bool scrolling = _count > _visible;
    final int itemCount =
        tasks.isEmpty ? 0 : tasks.length + (scrolling ? _visible : 0);

    WidgetsBinding.instance.addPostFrameCallback((_) => _syncTimer());

    return Container(
      margin: const EdgeInsets.fromLTRB(12, 10, 12, 2),
      height: _visible * _rowH,
      child: ClipRRect(
        borderRadius: BorderRadius.circular(9),
        child: Container(
          decoration: BoxDecoration(
            color: const Color(0xFF14171c),
            border: Border.all(color: const Color(0xFF20242b)),
            borderRadius: BorderRadius.circular(9),
          ),
          child: tasks.isEmpty
              ? Center(
                  child: Text(
                    t('noActiveTask'),
                    style: TextStyle(
                      color: AppColors.faint.withValues(alpha: 0.8),
                      fontSize: 12,
                    ),
                  ),
                )
              : ListView.builder(
                  controller: _scrollController,
                  physics: const NeverScrollableScrollPhysics(),
                  itemExtent: _rowH,
                  itemCount: itemCount,
                  itemBuilder: (context, i) {
                    final task = tasks[i % tasks.length];
                    return _TaskProgressCard(
                      task: task,
                      onTap: () => widget.onSessionTap?.call(task.session),
                    );
                  },
                ),
        ),
      ),
    );
  }
}

class _ActiveTask {
  final Session session;
  final String label;
  final String dirName;
  final bool active;
  final DateTime? lastActivity;

  const _ActiveTask({
    required this.session,
    required this.label,
    required this.dirName,
    required this.active,
    required this.lastActivity,
  });
}

class _TaskProgressCard extends StatelessWidget {
  final _ActiveTask task;
  final VoidCallback? onTap;

  const _TaskProgressCard({
    required this.task,
    this.onTap,
  });

  String _relativeTime(DateTime? ts) {
    if (ts == null) return '';
    final diff = DateTime.now().difference(ts);
    if (diff.inMinutes < 1) return '刚刚';
    if (diff.inMinutes < 60) return '${diff.inMinutes} 分钟前';
    if (diff.inHours < 24) return '${diff.inHours} 小时前';
    return '${diff.inDays} 天前';
  }

  @override
  Widget build(BuildContext context) {
    final Color statusColor =
        task.active ? const Color(0xFF6aa3ff) : const Color(0xFF5b616c);
    final String statusLabel = task.active ? '运行中' : '空闲';
    final String activityText =
        task.active ? '⚙️ 正在运行' : '🕘 ${_relativeTime(task.lastActivity)}';

    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(9),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 14),
        child: Row(
          children: [
            // 状态指示灯
            Container(
              width: 8,
              height: 8,
              decoration: BoxDecoration(
                color: statusColor,
                shape: BoxShape.circle,
                boxShadow: [
                  BoxShadow(
                    color: statusColor.withValues(alpha: 0.5),
                    blurRadius: 6,
                    spreadRadius: 1,
                  ),
                ],
              ),
            ),
            const SizedBox(width: 10),
            // 会话标签（+所属目录）
            Flexible(
              child: RichText(
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                text: TextSpan(
                  text: task.label,
                  style: const TextStyle(
                    color: AppColors.textBright,
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                  ),
                  children: [
                    if (task.dirName.isNotEmpty)
                      TextSpan(
                        text: '  ·  ${task.dirName}',
                        style: const TextStyle(
                          color: AppColors.faint,
                          fontSize: 11,
                          fontWeight: FontWeight.normal,
                        ),
                      ),
                  ],
                ),
              ),
            ),
            const SizedBox(width: 10),
            // 状态标签
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
              decoration: BoxDecoration(
                color: statusColor.withValues(alpha: 0.15),
                border: Border.all(color: statusColor.withValues(alpha: 0.3)),
                borderRadius: BorderRadius.circular(4),
              ),
              child: Text(
                statusLabel,
                style: TextStyle(
                  color: statusColor,
                  fontSize: 10,
                  fontWeight: FontWeight.w500,
                ),
              ),
            ),
            const SizedBox(width: 10),
            // 当前活动 / 最近使用
            Text(
              activityText,
              style: const TextStyle(
                color: AppColors.muted,
                fontSize: 11,
              ),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
          ],
        ),
      ),
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

class _ProjectStatPill extends StatelessWidget {
  final String label;
  final String value;
  final Color? color;
  const _ProjectStatPill({
    required this.label,
    required this.value,
    this.color,
  });

  @override
  Widget build(BuildContext context) {
    final c = color ?? const Color(0xFF8a909b);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      decoration: BoxDecoration(
        color: const Color(0xFF070809),
        border: Border.all(
          color: color == null
              ? const Color(0xFF20242b)
              : c.withValues(alpha: 0.45),
        ),
        borderRadius: BorderRadius.circular(999),
      ),
      child: RichText(
        text: TextSpan(
          style: TextStyle(color: c, fontSize: 11),
          children: [
            TextSpan(
              text: value,
              style: const TextStyle(
                color: Color(0xFFf2f4f7),
                fontWeight: FontWeight.w700,
              ),
            ),
            TextSpan(text: ' $label'),
          ],
        ),
      ),
    );
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
  final ValueChanged<Session>? onOpen;

  const _SessionGroup({
    required this.title,
    required this.color,
    required this.sessions,
    required this.mgr,
    required this.settings,
    required this.statuses,
    required this.pendingNotes,
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
                  (a, b) => _sessionLastInteractionAt(
                    b,
                    statuses[b.id],
                  ).compareTo(_sessionLastInteractionAt(a, statuses[a.id])),
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

class SessionCard extends StatelessWidget {
  final Session session;
  final SessionManager mgr;
  final SettingsService settings;
  final SessionStatus? liveStatus;
  final int pendingNotes;
  final ValueChanged<Session>? onOpen;
  const SessionCard({
    super.key,
    required this.session,
    required this.mgr,
    required this.settings,
    this.liveStatus,
    this.pendingNotes = 0,
    this.onOpen,
  });

  @override
  Widget build(BuildContext context) {
    final cliColor = session.cli == SessionCli.codex
        ? _kCodexColor
        : _kClaudeColor;
    final live = liveStatus;
    final lastInteraction = _sessionLastInteractionAt(session, live);
    final ago = timeago.format(lastInteraction, locale: 'en_short');
    final statusColor = live != null
        ? _wbStatusColor(live.status)
        : (session.active ? const Color(0xFF7fd49a) : const Color(0xFF5b616c));
    final mergeReady = live?.mergeReady == true;
    final title = session.label?.isNotEmpty == true
        ? session.label!
        : session.id;
    final subtitle = session.label?.isNotEmpty == true
        ? session.id
        : session.shortCwd;
    final model = session.model?.isNotEmpty == true
        ? claudeModelShortName(session.model)
        : '';

    return Container(
      decoration: BoxDecoration(
        color: const Color(0xFF070809),
        border: Border.all(color: const Color(0xFF20242b)),
        borderRadius: BorderRadius.circular(8),
      ),
      child: InkWell(
        onTap: () {
          final open = onOpen;
          if (open != null) {
            open(session);
          } else {
            _open(context);
          }
        },
        borderRadius: BorderRadius.circular(8),
        child: Padding(
          padding: const EdgeInsets.all(10),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Container(
                    width: 7,
                    height: 7,
                    decoration: BoxDecoration(
                      color: statusColor,
                      shape: BoxShape.circle,
                    ),
                  ),
                  const SizedBox(width: 7),
                  _MiniBadge(label: session.cli.name, color: cliColor),
                  const SizedBox(width: 6),
                  _MiniBadge(
                    label: session.kind.name,
                    color: const Color(0xFF8a909b),
                    icon: session.isChat
                        ? Icons.chat_bubble_outline_rounded
                        : Icons.terminal_rounded,
                  ),
                  if (live != null && live.status != 'idle') ...[
                    const SizedBox(width: 6),
                    Text(
                      _wbStatusLabel(live.status),
                      style: TextStyle(
                        color: statusColor,
                        fontSize: 10,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  ],
                  if (pendingNotes > 0) ...[
                    const SizedBox(width: 6),
                    Text(
                      '📨$pendingNotes',
                      style: const TextStyle(
                        fontSize: 10,
                        color: Color(0xFFe3b341),
                      ),
                    ),
                  ],
                  const Spacer(),
                  if (model.isNotEmpty) ...[
                    Flexible(
                      child: Text(
                        model,
                        style: const TextStyle(
                          color: Color(0xFF5b616c),
                          fontSize: 10,
                        ),
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                    const SizedBox(width: 6),
                  ],
                  Text(
                    ago,
                    style: const TextStyle(
                      color: Color(0xFF5b616c),
                      fontSize: 10,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 9),
              Text(
                title,
                style: const TextStyle(
                  color: Color(0xFFe7eaee),
                  fontSize: 12,
                  fontFamily: 'monospace',
                  fontWeight: FontWeight.w600,
                ),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
              const SizedBox(height: 3),
              Text(
                subtitle,
                style: const TextStyle(
                  color: Color(0xFF5b616c),
                  fontSize: 11,
                  fontFamily: 'monospace',
                ),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
              if (live?.currentFile != null) ...[
                const SizedBox(height: 4),
                Row(
                  children: [
                    const Icon(
                      Icons.edit_outlined,
                      size: 11,
                      color: Color(0xFFe3b341),
                    ),
                    const SizedBox(width: 4),
                    Expanded(
                      child: Text(
                        live!.currentFile!.split('/').last,
                        style: const TextStyle(
                          color: Color(0xFFe3b341),
                          fontSize: 10,
                          fontFamily: 'monospace',
                        ),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                  ],
                ),
              ],
              if (live?.summary?.isNotEmpty == true) ...[
                const SizedBox(height: 6),
                Container(
                  width: double.infinity,
                  padding: const EdgeInsets.symmetric(
                    horizontal: 7,
                    vertical: 5,
                  ),
                  decoration: BoxDecoration(
                    color: const Color(0x243ad6c5),
                    border: Border.all(color: const Color(0x663ad6c5)),
                    borderRadius: BorderRadius.circular(6),
                  ),
                  child: Text(
                    '🗒 ${live!.summary}',
                    style: const TextStyle(
                      color: Color(0xFF7fe6da),
                      fontSize: 10.5,
                      height: 1.35,
                    ),
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
              ],
              if ((live?.behind ?? 0) > 0) ...[
                const SizedBox(height: 6),
                Row(
                  children: [
                    const Icon(
                      Icons.history_rounded,
                      size: 11,
                      color: Color(0xFFf2cc60),
                    ),
                    const SizedBox(width: 4),
                    Text(
                      '落后 ${live!.baseBranch ?? 'base'} ${live.behind} 个提交',
                      style: const TextStyle(
                        color: Color(0xFFf2cc60),
                        fontSize: 10,
                      ),
                    ),
                  ],
                ),
              ],
              const SizedBox(height: 6),
              // Lean action row: the actionable "merge" stays inline only when a
              // merge is ready; everything else lives in a ⋯ menu so the card
              // stays compact (was a row of 6 always-visible icon buttons).
              Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  if (mergeReady)
                    TextButton.icon(
                      icon: const Icon(
                        Icons.merge_type_rounded,
                        size: 15,
                        color: Color(0xFF070809),
                      ),
                      label: Text(
                        _mergeReadyLabel(live!),
                        style: const TextStyle(
                          color: Color(0xFF070809),
                          fontSize: 12,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                      style: TextButton.styleFrom(
                        backgroundColor: const Color(0xFFe3b341),
                        padding: const EdgeInsets.symmetric(
                          horizontal: 10,
                          vertical: 4,
                        ),
                        minimumSize: const Size(0, 28),
                        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                      ),
                      onPressed: () => _mergeSession(context),
                    ),
                  PopupMenuButton<String>(
                    icon: const Icon(
                      Icons.more_horiz_rounded,
                      size: 18,
                      color: Color(0xFF8a909b),
                    ),
                    tooltip: '更多操作',
                    color: const Color(0xFF161b22),
                    padding: EdgeInsets.zero,
                    constraints: const BoxConstraints(minWidth: 160),
                    onSelected: (v) {
                      switch (v) {
                        case 'rename':
                          _rename(context);
                          break;
                        case 'merge':
                          _mergeSession(context);
                          break;
                        case 'diff':
                          showSessionDiffDialog(
                            context,
                            settings: settings,
                            sessionId: session.id,
                          );
                          break;
                        case 'note':
                          _leaveNote(context);
                          break;
                        case 'restart':
                          _restart(context);
                          break;
                        case 'delete':
                          _confirmDelete(context);
                          break;
                      }
                    },
                    itemBuilder: (_) => [
                      _menuItem('rename', Icons.edit_outlined, '改名'),
                      if (!mergeReady)
                        _menuItem(
                          'merge',
                          Icons.merge_type_rounded,
                          '合并 worktree',
                        ),
                      _menuItem('diff', Icons.difference_outlined, '查看 Diff'),
                      _menuItem('note', Icons.mail_outline_rounded, '留言'),
                      if (session.isTerminal)
                        _menuItem(
                          'restart',
                          Icons.restart_alt_rounded,
                          'Restart',
                        ),
                      const PopupMenuDivider(),
                      _menuItem(
                        'delete',
                        Icons.delete_outline_rounded,
                        '删除',
                        danger: true,
                      ),
                    ],
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }

  PopupMenuItem<String> _menuItem(
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

  Future<void> _rename(BuildContext context) async {
    final ctrl = TextEditingController(text: session.label ?? session.id);
    final messenger = ScaffoldMessenger.of(context);
    final next = await showDialog<String>(
      context: context,
      builder: (_) => AlertDialog(
        backgroundColor: const Color(0xFF0f1115),
        title: const Text(
          'Rename Session',
          style: TextStyle(fontSize: 15, color: Color(0xFFf2f4f7)),
        ),
        content: TextField(
          controller: ctrl,
          autofocus: true,
          maxLength: 80,
          style: const TextStyle(color: Color(0xFFe7eaee), fontSize: 13),
          decoration: InputDecoration(
            hintText: session.id,
            hintStyle: const TextStyle(color: Color(0xFF454b54)),
            filled: true,
            fillColor: const Color(0xFF070809),
            border: OutlineInputBorder(borderRadius: BorderRadius.circular(6)),
            counterStyle: const TextStyle(color: Color(0xFF5b616c)),
          ),
          onSubmitted: (v) => Navigator.pop(context, v),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text(
              'Cancel',
              style: TextStyle(color: Color(0xFF8a909b)),
            ),
          ),
          TextButton(
            onPressed: () => Navigator.pop(context, ctrl.text),
            child: const Text(
              'Save',
              style: TextStyle(
                color: Color(0xFF6aa3ff),
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
        ],
      ),
    );
    if (next == null) return;
    try {
      await mgr.renameSession(session.id, next.trim());
      messenger.showSnackBar(const SnackBar(content: Text('Session renamed')));
    } catch (e) {
      messenger.showSnackBar(SnackBar(content: Text('Rename failed: $e')));
    }
  }

  Future<void> _leaveNote(BuildContext context) async {
    final siblings = mgr.sessions
        .where((x) => x.dirId == session.dirId && x.id != session.id)
        .toList();
    if (siblings.isEmpty) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(const SnackBar(content: Text('该目录下没有其他会话可留言')));
      return;
    }
    final messenger = ScaffoldMessenger.of(context);
    var targetId = siblings.first.id;
    final bodyCtrl = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (_) => StatefulBuilder(
        builder: (context, setLocal) => AlertDialog(
          backgroundColor: const Color(0xFF0f1115),
          title: const Text(
            '留言',
            style: TextStyle(fontSize: 15, color: Color(0xFFf2f4f7)),
          ),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text(
                '留言会在对方下一轮对话开始时送达。',
                style: TextStyle(color: Color(0xFF8a909b), fontSize: 11),
              ),
              const SizedBox(height: 10),
              DropdownButton<String>(
                value: targetId,
                isExpanded: true,
                dropdownColor: const Color(0xFF0f1115),
                style: const TextStyle(color: Color(0xFFe7eaee), fontSize: 13),
                items: [
                  for (final s in siblings)
                    DropdownMenuItem(
                      value: s.id,
                      child: Text(
                        '${s.label?.isNotEmpty == true ? s.label : s.id}'
                        ' (${s.cli.name}/${s.kind.name})',
                      ),
                    ),
                ],
                onChanged: (v) => setLocal(() => targetId = v ?? targetId),
              ),
              const SizedBox(height: 8),
              TextField(
                controller: bodyCtrl,
                autofocus: true,
                maxLines: 4,
                style: const TextStyle(color: Color(0xFFe7eaee), fontSize: 13),
                decoration: InputDecoration(
                  hintText: '留言内容…',
                  hintStyle: const TextStyle(color: Color(0xFF454b54)),
                  filled: true,
                  fillColor: const Color(0xFF070809),
                  border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(6),
                  ),
                ),
              ),
            ],
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text(
                '取消',
                style: TextStyle(color: Color(0xFF8a909b)),
              ),
            ),
            TextButton(
              onPressed: () => Navigator.pop(context, true),
              child: const Text(
                '发送',
                style: TextStyle(
                  color: Color(0xFF6aa3ff),
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
          ],
        ),
      ),
    );
    if (ok != true) return;
    final body = bodyCtrl.text.trim();
    if (body.isEmpty) return;
    try {
      await SessionService(
        settings: settings,
      ).postNote(fromSessionId: session.id, toSessionId: targetId, body: body);
      messenger.showSnackBar(const SnackBar(content: Text('留言已发送')));
    } catch (e) {
      messenger.showSnackBar(SnackBar(content: Text('发送失败：$e')));
    }
  }

  Future<void> _mergeSession(BuildContext context) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        backgroundColor: const Color(0xFF0f1115),
        title: const Text(
          '合并 worktree',
          style: TextStyle(fontSize: 15, color: Color(0xFFf2f4f7)),
        ),
        content: const Text(
          '把此会话 worktree 的改动合并回基分支？\n未提交的改动会先自动提交。',
          style: TextStyle(color: Color(0xFFe7eaee)),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('取消', style: TextStyle(color: Color(0xFF8a909b))),
          ),
          TextButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text(
              '合并',
              style: TextStyle(
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
    messenger.showSnackBar(const SnackBar(content: Text('正在合并 worktree...')));
    try {
      final result = await SessionService(
        settings: settings,
      ).mergeSession(session.id);
      final hasConflict =
          result['conflicts'] is List &&
          (result['conflicts'] as List).isNotEmpty;
      final msg = result['ok'] == true
          ? (result['merged'] == true
                ? '✓ 已合并 ${result['commits']} 个提交回基分支'
                : '✓ ${result['message'] ?? '没有新提交需要合并'}')
          : hasConflict
          ? '⚠️ 合并冲突，已 abort：${(result['conflicts'] as List).join(', ')}'
          : '合并失败：${result['error'] ?? ''}';
      messenger.hideCurrentSnackBar();
      messenger.showSnackBar(SnackBar(content: Text(msg)));
      if (hasConflict && context.mounted) {
        await showConflictDiffDialog(
          context,
          sessionId: session.id,
          result: result,
        );
      }
    } catch (e) {
      messenger.hideCurrentSnackBar();
      messenger.showSnackBar(SnackBar(content: Text('合并请求失败：$e')));
    }
  }

  void _open(BuildContext context) {
    if (session.isChat) {
      mgr.openSession(session);
      mgr.switchToSession(session.id);
    } else {
      Navigator.of(context).push(
        MaterialPageRoute(
          builder: (_) => TerminalScreen(settings: settings, session: session),
        ),
      );
    }
  }

  Future<void> _restart(BuildContext context) async {
    try {
      await mgr.restartSession(session.id);
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('Session restarted'),
            backgroundColor: Color(0xFF22ab9c),
          ),
        );
      }
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('Failed: $e'),
            backgroundColor: const Color(0xFFff6b63),
          ),
        );
      }
    }
  }

  Future<void> _confirmDelete(BuildContext context) async {
    final confirm = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        backgroundColor: const Color(0xFF0f1115),
        title: const Text(
          'Delete Session',
          style: TextStyle(color: Color(0xFFf2f4f7)),
        ),
        content: Text(
          'Delete "${session.id}"?',
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
    if (confirm == true) mgr.deleteSession(session.id);
  }
}

class _MiniBadge extends StatelessWidget {
  final String label;
  final Color color;
  final IconData? icon;
  const _MiniBadge({required this.label, required this.color, this.icon});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        border: Border.all(color: color.withValues(alpha: 0.38)),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (icon != null) ...[
            Icon(icon, size: 10, color: color),
            const SizedBox(width: 3),
          ],
          Text(
            label,
            style: TextStyle(
              color: color,
              fontSize: 9,
              fontWeight: FontWeight.w700,
            ),
          ),
        ],
      ),
    );
  }
}

class _AddSessionChip extends StatelessWidget {
  final String label;
  final Color color;
  final VoidCallback onTap;
  const _AddSessionChip({
    required this.label,
    required this.color,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(6),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
        decoration: BoxDecoration(
          color: color.withValues(alpha: 0.1),
          border: Border.all(color: color.withValues(alpha: 0.4)),
          borderRadius: BorderRadius.circular(6),
        ),
        child: Text(
          label,
          style: TextStyle(
            color: color,
            fontSize: 11,
            fontWeight: FontWeight.w600,
          ),
        ),
      ),
    );
  }
}

InputDecoration _inputDec({String? hint}) => InputDecoration(
  isDense: true,
  filled: true,
  fillColor: const Color(0xFF070809),
  hintText: hint,
  hintStyle: const TextStyle(color: Color(0xFF454b54), fontSize: 13),
  contentPadding: const EdgeInsets.symmetric(horizontal: 10, vertical: 10),
  border: OutlineInputBorder(
    borderSide: const BorderSide(color: Color(0xFF20242b)),
    borderRadius: BorderRadius.circular(6),
  ),
  enabledBorder: OutlineInputBorder(
    borderSide: const BorderSide(color: Color(0xFF20242b)),
    borderRadius: BorderRadius.circular(6),
  ),
  focusedBorder: OutlineInputBorder(
    borderSide: const BorderSide(color: Color(0xFF6aa3ff)),
    borderRadius: BorderRadius.circular(6),
  ),
);
