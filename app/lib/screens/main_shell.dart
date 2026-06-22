import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:timeago/timeago.dart' as timeago;

import '../models/message.dart';
import '../providers/chat_provider.dart';
import '../providers/session_manager.dart';
import '../services/session_service.dart';
import '../services/settings_service.dart';
import '../services/manage_service.dart';
import '../services/workspace_service.dart';
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
      return '思考中';
    case 'editing':
      return '编辑中';
    case 'running':
      return '运行中';
    case 'waiting':
      return '等待';
    default:
      return 'idle';
  }
}

String _mergeReadyLabel(SessionStatus status) {
  final bits = <String>[];
  if (status.dirty) bits.add('有未提交改动');
  if (status.ahead > 0) bits.add('${status.ahead} 个提交领先');
  final detail = bits.isEmpty ? '有可合并内容' : bits.join('，');
  return '$detail，可合并回 ${status.baseBranch ?? '基分支'}';
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
                  child: Container(color: Colors.black.withOpacity(scrimOp)),
                ),
              ),
            ),
            Positioned(
              left: 0,
              right: 0,
              top: top,
              height: h - top,
              child: ClipRRect(
                borderRadius:
                    BorderRadius.vertical(top: Radius.circular(radius)),
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

class _DirectoryListBody extends StatelessWidget {
  final SettingsService settings;
  const _DirectoryListBody({required this.settings});

  @override
  Widget build(BuildContext context) {
    final mgr = context.watch<SessionManager>();

    return Scaffold(
      backgroundColor: const Color(0xFF070809),
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
              '${mgr.directories.length} dirs · ${mgr.sessions.where((s) => !s.isAux).length} sessions',
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
            tooltip: 'New directory',
            onPressed: () => _showNewDirectoryDialog(context, mgr),
          ),
          IconButton(
            icon: const Icon(Icons.refresh_rounded, size: 20),
            onPressed: mgr.loadDashboard,
          ),
          IconButton(
            icon: const Icon(Icons.settings_outlined, size: 20),
            onPressed: () => Navigator.of(context).push(
              MaterialPageRoute(
                builder: (_) => SettingsScreen(settings: settings),
              ),
            ),
          ),
        ],
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(57),
          child: Column(
            children: [
              _KpiRow(settings: settings),
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

    return RefreshIndicator(
      onRefresh: mgr.loadDashboard,
      color: const Color(0xFF6aa3ff),
      backgroundColor: const Color(0xFF0f1115),
      child: ListView.builder(
        padding: const EdgeInsets.all(12),
        itemCount: mgr.directories.length,
        itemBuilder: (_, i) => _DirectoryCard(
          directory: mgr.directories[i],
          settings: settings,
          mgr: mgr,
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
            label: '活跃会话', value: '$active', color: const Color(0xFF3ad6c5),
            onTap: () => _showSessionSheet(context, mgr, '活跃会话', mgr.activeSessions, '🟢'),
          ),
          const SizedBox(width: 8),
          _KpiTile(
            label: '等待输入', value: '$waiting', color: const Color(0xFFe3b341),
            onTap: () => _showSessionSheet(context, mgr, '等待输入', mgr.waitingSessions, '⏳'),
          ),
          const SizedBox(width: 8),
          _KpiTile(
            label: '定时任务', value: null, color: const Color(0xFF6aa3ff),
            onTap: () => Navigator.of(context).push(MaterialPageRoute(
              builder: (_) => CronScreen(settings: settings))),
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
  const _KpiTile({required this.label, required this.value, required this.color, required this.onTap});

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
              Container(width: 7, height: 7, decoration: BoxDecoration(color: color, shape: BoxShape.circle)),
              const SizedBox(width: 7),
              Expanded(
                child: Text(label,
                  style: const TextStyle(color: Color(0xFF8a909b), fontSize: 12),
                  overflow: TextOverflow.ellipsis),
              ),
              if (value != null) ...[
                const SizedBox(width: 4),
                Text(value!, style: TextStyle(color: color, fontSize: 15, fontWeight: FontWeight.w700)),
              ] else
                const Icon(Icons.chevron_right, size: 16, color: Color(0xFF5b616c)),
            ],
          ),
        ),
      ),
    );
  }
}

// Bottom-sheet list of sessions ("dir / alias"); tap an entry to jump to it.
void _showSessionSheet(BuildContext context, SessionManager mgr, String title,
    List<Session> sessions, String prefix) {
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
      borderRadius: BorderRadius.vertical(top: Radius.circular(16))),
    builder: (sheetCtx) => SafeArea(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(18, 14, 18, 8),
            child: Row(children: [
              Text('$prefix $title',
                style: const TextStyle(color: Color(0xFFe7eaee), fontSize: 15, fontWeight: FontWeight.w600)),
              const Spacer(),
              Text('${sessions.length}',
                style: const TextStyle(color: Color(0xFF8a909b), fontSize: 13)),
            ]),
          ),
          if (sessions.isEmpty)
            const Padding(
              padding: EdgeInsets.fromLTRB(18, 8, 18, 24),
              child: Align(alignment: Alignment.centerLeft,
                child: Text('没有符合的会话', style: TextStyle(color: Color(0xFF5b616c), fontSize: 13))),
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
                    title: Text(dir.isNotEmpty ? '$dir / $alias' : alias,
                      style: const TextStyle(color: Color(0xFFe7eaee), fontSize: 14),
                      overflow: TextOverflow.ellipsis),
                    trailing: const Icon(Icons.arrow_forward_ios, size: 13, color: Color(0xFF5b616c)),
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

  const _DirectoryCard({
    required this.directory,
    required this.settings,
    required this.mgr,
  });

  @override
  State<_DirectoryCard> createState() => _DirectoryCardState();
}

class _DirectoryCardState extends State<_DirectoryCard> {
  bool _open = true;
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
    widget.mgr.reportWaiting(widget.directory.id, const {}); // drop stale entries
    super.dispose();
  }

  PopupMenuItem<String> _dirMenuItem(String value, IconData icon, String label, {bool danger = false}) {
    final color = danger ? const Color(0xFFff6b63) : const Color(0xFFe7eaee);
    return PopupMenuItem<String>(
      value: value,
      height: 40,
      child: Row(children: [
        Icon(icon, size: 16, color: color),
        const SizedBox(width: 10),
        Text(label, style: TextStyle(color: color, fontSize: 14)),
      ]),
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
    final hasSessions = widget.directory.totalSessions > 0;

    return Container(
      margin: const EdgeInsets.only(bottom: 14),
      decoration: BoxDecoration(
        color: const Color(0xFF0f1115),
        border: Border.all(color: const Color(0xFF20242b)),
        borderRadius: BorderRadius.circular(8),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withValues(alpha: 0.18),
            blurRadius: 22,
            offset: const Offset(0, 10),
          ),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          InkWell(
            onTap: () => setState(() => _open = !_open),
            borderRadius: const BorderRadius.vertical(top: Radius.circular(8)),
            child: Padding(
              padding: const EdgeInsets.fromLTRB(14, 14, 10, 12),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Container(
                        width: 34,
                        height: 34,
                        decoration: BoxDecoration(
                          color: const Color(0xFF070809),
                          border: Border.all(color: const Color(0xFF20242b)),
                          borderRadius: BorderRadius.circular(8),
                        ),
                        child: Icon(
                          _open
                              ? Icons.keyboard_arrow_down_rounded
                              : Icons.keyboard_arrow_right_rounded,
                          color: const Color(0xFF8a909b),
                          size: 22,
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
                                color: Color(0xFFf2f4f7),
                                fontWeight: FontWeight.w700,
                                fontSize: 16,
                              ),
                              overflow: TextOverflow.ellipsis,
                            ),
                            const SizedBox(height: 3),
                            Text(
                              widget.directory.path,
                              style: const TextStyle(
                                color: Color(0xFF6aa3ff),
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
                          color: Color(0xFF8a909b),
                        ),
                        tooltip: '项目备忘 (multicc.memo.md)',
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
                          minWidth: 36,
                          minHeight: 36,
                        ),
                      ),
                      // push / rename / delete collapsed into a ⋯ menu (header
                      // kept to memo + overflow so it stays uncluttered).
                      PopupMenuButton<String>(
                        icon: const Icon(Icons.more_horiz_rounded, size: 19, color: Color(0xFF8a909b)),
                        tooltip: '更多操作',
                        color: const Color(0xFF161b22),
                        padding: EdgeInsets.zero,
                        constraints: const BoxConstraints(minWidth: 36, minHeight: 36),
                        onSelected: (v) {
                          switch (v) {
                            case 'push': _pushDirectory(context); break;
                            case 'rename': _confirmRenameDirectory(context); break;
                            case 'delete': _confirmDeleteDirectory(context); break;
                          }
                        },
                        itemBuilder: (_) => [
                          _dirMenuItem('push', Icons.cloud_upload_outlined, 'Git 推送'),
                          _dirMenuItem('rename', Icons.drive_file_rename_outline_rounded, '改名'),
                          const PopupMenuDivider(),
                          _dirMenuItem('delete', Icons.delete_outline_rounded, '删除目录', danger: true),
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
                        label: 'sessions',
                        value: widget.directory.totalSessions.toString(),
                      ),
                      _ProjectStatPill(
                        label: 'active',
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
                ],
              ),
            ),
          ),
          if (_open) ...[
            const Divider(height: 1, color: Color(0xFF14171c)),
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 12, 14, 4),
              child: Wrap(
                spacing: 6,
                runSpacing: 6,
                children: [
                  _AddSessionChip(
                    label: '+ Claude Term',
                    color: _kClaudeColor,
                    onTap: () =>
                        _createSession(SessionCli.claude, SessionKind.terminal),
                  ),
                  _AddSessionChip(
                    label: '+ Claude Chat',
                    color: _kClaudeColor,
                    onTap: () =>
                        _createSession(SessionCli.claude, SessionKind.chat),
                  ),
                  _AddSessionChip(
                    label: '+ Codex Term',
                    color: _kCodexColor,
                    onTap: () =>
                        _createSession(SessionCli.codex, SessionKind.terminal),
                  ),
                  _AddSessionChip(
                    label: '+ Codex Chat',
                    color: _kCodexColor,
                    onTap: () =>
                        _createSession(SessionCli.codex, SessionKind.chat),
                  ),
                ],
              ),
            ),
            EventTimeline(events: _workspace.events),
            if (!hasSessions)
              Container(
                width: double.infinity,
                margin: const EdgeInsets.fromLTRB(14, 10, 14, 14),
                padding: const EdgeInsets.symmetric(
                  horizontal: 12,
                  vertical: 16,
                ),
                decoration: BoxDecoration(
                  color: const Color(0xFF070809).withValues(alpha: 0.65),
                  border: Border.all(color: const Color(0xFF20242b)),
                  borderRadius: BorderRadius.circular(8),
                ),
                child: const Text(
                  'No sessions yet',
                  textAlign: TextAlign.center,
                  style: TextStyle(color: Color(0xFF5b616c), fontSize: 12),
                ),
              )
            else ...[
              _SessionGroup(
                title: 'Claude Terminals',
                color: _kClaudeColor,
                sessions: groups['claude_terminal']!,
                mgr: widget.mgr,
                settings: widget.settings,
                statuses: _workspace.statuses,
                pendingNotes: _workspace.pendingNotes,
              ),
              _SessionGroup(
                title: 'Claude Chats',
                color: _kClaudeColor,
                sessions: groups['claude_chat']!,
                mgr: widget.mgr,
                settings: widget.settings,
                statuses: _workspace.statuses,
                pendingNotes: _workspace.pendingNotes,
              ),
              _SessionGroup(
                title: 'Codex Terminals',
                color: _kCodexColor,
                sessions: groups['codex_terminal']!,
                mgr: widget.mgr,
                settings: widget.settings,
                statuses: _workspace.statuses,
                pendingNotes: _workspace.pendingNotes,
              ),
              _SessionGroup(
                title: 'Codex Chats',
                color: _kCodexColor,
                sessions: groups['codex_chat']!,
                mgr: widget.mgr,
                settings: widget.settings,
                statuses: _workspace.statuses,
                pendingNotes: _workspace.pendingNotes,
              ),
              const SizedBox(height: 10),
            ],
          ],
        ],
      ),
    );
  }

  Future<void> _createSession(SessionCli cli, SessionKind kind) async {
    final navigator = Navigator.of(context);
    final messenger = ScaffoldMessenger.of(context);

    // Step 1: pick a provider (both claude & codex)
    final appType = cli == SessionCli.codex ? 'codex' : 'claude';
    String? provider;
    try {
      final d = await ManageService(settings: widget.settings).fetchProviders(appType);
      final providers = (d['providers'] as List? ?? [])
          .map((e) => (e as Map).cast<String, dynamic>())
          .toList();
      if (providers.isNotEmpty) {
        final picked = await showModalBottomSheet<String>(
          context: context,
          backgroundColor: const Color(0xFF0f1115),
          shape: const RoundedRectangleBorder(
            borderRadius: BorderRadius.vertical(top: Radius.circular(14)),
          ),
          builder: (_) => SafeArea(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const Padding(
                  padding: EdgeInsets.fromLTRB(18, 16, 18, 8),
                  child: Text(
                    '选择该会话使用的 Provider',
                    style: TextStyle(
                      color: Color(0xFFf2f4f7),
                      fontSize: 15,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
                ListTile(
                  dense: true,
                  title: const Text('默认登录 / 订阅', style: TextStyle(color: Color(0xFFe7eaee), fontSize: 14)),
                  trailing: provider == null ? const Icon(Icons.check_rounded, size: 18, color: Color(0xFF7fd49a)) : null,
                  onTap: () => Navigator.pop(context, ''),
                ),
                for (final p in providers)
                  ListTile(
                    dense: true,
                    title: Text(
                      (p['name'] as String? ?? '') + (p['isOfficial'] == true ? ' · 订阅' : ''),
                      style: const TextStyle(color: Color(0xFFe7eaee), fontSize: 14),
                    ),
                    subtitle: p['model'] != null && (p['model'] as String).isNotEmpty
                        ? Text(p['model'] as String, style: const TextStyle(color: Color(0xFF8a909b), fontSize: 11))
                        : null,
                    trailing: p['id'] == provider ? const Icon(Icons.check_rounded, size: 18, color: Color(0xFF7fd49a)) : null,
                    onTap: () => Navigator.pop(context, p['id'] as String),
                  ),
                const SizedBox(height: 6),
              ],
            ),
          ),
        );
        if (picked == null) return; // cancelled
        if (!mounted) return;
        provider = picked.isEmpty ? null : picked;
      }
    } catch (_) {
      // If provider fetch fails, continue without provider selection
    }

    // Step 2: pick a model (claude only)
    String? model;
    if (cli == SessionCli.claude) {
      final picked = await showClaudeModelPicker(context, current: widget.settings.defaultModel);
      if (picked == null) return; // cancelled
      if (!mounted) return;
      model = picked.isEmpty ? null : picked;
    }
    try {
      final s = await widget.mgr.createSessionInDir(
        dirId: widget.directory.id,
        cli: cli,
        kind: kind,
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
      const SnackBar(content: Text('正在推送到远程…'), duration: Duration(seconds: 30)),
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
            ? '已推送 $ahead 个提交 → $remote/$branch'
            : '无待推送提交';
        messenger.showSnackBar(SnackBar(content: Text(msg)));
      } else {
        messenger.showSnackBar(SnackBar(
          content: Text('推送失败：${r['error'] ?? '未知错误'}'),
          backgroundColor: const Color(0xFFff6b63),
        ));
      }
    } catch (e) {
      if (!mounted) return;
      messenger.hideCurrentSnackBar();
      messenger.showSnackBar(SnackBar(
        content: Text('推送失败：$e'),
        backgroundColor: const Color(0xFFff6b63),
      ));
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

// Compact per-directory event timeline for the status board.
// Collapsed by default (a "🕔 活动 (N) ▾" bar); tap to expand the recent events.
// Keeps the project card compact — the timeline used to always show 8 rows.
class EventTimeline extends StatefulWidget {
  final List<Map<String, dynamic>> events;
  const EventTimeline({super.key, required this.events});

  @override
  State<EventTimeline> createState() => _EventTimelineState();
}

class _EventTimelineState extends State<EventTimeline> {
  bool _open = false;

  @override
  Widget build(BuildContext context) {
    if (widget.events.isEmpty) return const SizedBox.shrink();
    final recent = widget.events.reversed.take(8).toList();
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
              child: Row(children: [
                const Text('🕔 ', style: TextStyle(fontSize: 11)),
                Text('活动 (${widget.events.length})',
                  style: const TextStyle(
                    color: Color(0xFF5b616c), fontSize: 11, fontWeight: FontWeight.w600)),
                const Spacer(),
                Icon(_open ? Icons.expand_less_rounded : Icons.expand_more_rounded,
                  size: 16, color: const Color(0xFF5b616c)),
              ]),
            ),
          ),
          if (_open)
            Padding(
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
            ),
        ],
      ),
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

  const _SessionGroup({
    required this.title,
    required this.color,
    required this.sessions,
    required this.mgr,
    required this.settings,
    required this.statuses,
    required this.pendingNotes,
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
              return Wrap(
                spacing: gap,
                runSpacing: gap,
                children: [
                  for (final s in sessions)
                    SizedBox(
                      width: cardWidth,
                      child: SessionCard(
                        session: s,
                        mgr: mgr,
                        settings: settings,
                        liveStatus: statuses[s.id],
                        pendingNotes: pendingNotes[s.id] ?? 0,
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
  const SessionCard({
    super.key,
    required this.session,
    required this.mgr,
    required this.settings,
    this.liveStatus,
    this.pendingNotes = 0,
  });

  @override
  Widget build(BuildContext context) {
    final cliColor = session.cli == SessionCli.codex
        ? _kCodexColor
        : _kClaudeColor;
    final ago = timeago.format(
      session.lastActivity ?? session.createdAt,
      locale: 'en_short',
    );
    final live = liveStatus;
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

    return Container(
      decoration: BoxDecoration(
        color: const Color(0xFF070809),
        border: Border.all(color: const Color(0xFF20242b)),
        borderRadius: BorderRadius.circular(8),
      ),
      child: InkWell(
        onTap: () => _open(context),
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
                  padding:
                      const EdgeInsets.symmetric(horizontal: 7, vertical: 5),
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
                      icon: const Icon(Icons.merge_type_rounded, size: 15, color: Color(0xFF070809)),
                      label: Text(_mergeReadyLabel(live!),
                        style: const TextStyle(color: Color(0xFF070809), fontSize: 12, fontWeight: FontWeight.w600)),
                      style: TextButton.styleFrom(
                        backgroundColor: const Color(0xFFe3b341),
                        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                        minimumSize: const Size(0, 28),
                        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                      ),
                      onPressed: () => _mergeSession(context),
                    ),
                  PopupMenuButton<String>(
                    icon: const Icon(Icons.more_horiz_rounded, size: 18, color: Color(0xFF8a909b)),
                    tooltip: '更多操作',
                    color: const Color(0xFF161b22),
                    padding: EdgeInsets.zero,
                    constraints: const BoxConstraints(minWidth: 160),
                    onSelected: (v) {
                      switch (v) {
                        case 'rename': _rename(context); break;
                        case 'merge': _mergeSession(context); break;
                        case 'diff':
                          showSessionDiffDialog(context, settings: settings, sessionId: session.id);
                          break;
                        case 'note': _leaveNote(context); break;
                        case 'restart': _restart(context); break;
                        case 'delete': _confirmDelete(context); break;
                      }
                    },
                    itemBuilder: (_) => [
                      _menuItem('rename', Icons.edit_outlined, '改名'),
                      if (!mergeReady) _menuItem('merge', Icons.merge_type_rounded, '合并 worktree'),
                      _menuItem('diff', Icons.difference_outlined, '查看 Diff'),
                      _menuItem('note', Icons.mail_outline_rounded, '留言'),
                      if (session.isTerminal) _menuItem('restart', Icons.restart_alt_rounded, 'Restart'),
                      const PopupMenuDivider(),
                      _menuItem('delete', Icons.delete_outline_rounded, '删除', danger: true),
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

  PopupMenuItem<String> _menuItem(String value, IconData icon, String label, {bool danger = false}) {
    final color = danger ? const Color(0xFFff6b63) : const Color(0xFFe7eaee);
    return PopupMenuItem<String>(
      value: value,
      height: 40,
      child: Row(children: [
        Icon(icon, size: 16, color: color),
        const SizedBox(width: 10),
        Text(label, style: TextStyle(color: color, fontSize: 14)),
      ]),
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

// ═══════════════════════════════════════════════════════════════════════════════
//  NEW DIRECTORY DIALOG
// ═══════════════════════════════════════════════════════════════════════════════

Future<void> _showNewDirectoryDialog(
  BuildContext context,
  SessionManager mgr,
) async {
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
            if (error != null) ...[
              const SizedBox(height: 10),
              Text(
                error!,
                style: const TextStyle(color: Color(0xFFff6b63), fontSize: 12),
              ),
            ],
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
