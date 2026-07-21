import 'dart:async';

import 'package:flutter/material.dart';

import '../i18n.dart';
import '../models/task_board.dart';
import '../services/manage_service.dart';
import '../services/settings_service.dart';
import '../theme.dart';
import '../utils/session_status_helpers.dart';

/// Task-board view for one directory: the AI-tagged module->task tree, filtered
/// to [dirId], with 60s polling + manual refresh, plus the interactions layered
/// on top of B1's read-only board:
///   * tapping a task row opens a detail sheet (run state, classify badge,
///     areas, sessions, cross-session message trail);
///   * status actions (done / reopen / archive) + reclassify call the
///     localhost-only write endpoints and surface [LocalOnlyException] as a
///     SnackBar;
///   * newly-filed tasks are auto-located and highlighted for 3s;
///   * retry_wait classify badges carry a "N 分钟后重试" countdown.
///
/// Real-time WS (/ws/meta `task_board_update`) is intentionally deferred (see
/// notes); this matches the web dashboard, which also polls every 60s and only
/// uses WS as a latency optimisation. Refresh also runs after each write so a
/// reclassify / status change is reflected immediately.
class TaskBoardView extends StatefulWidget {
  final SettingsService settings;
  final String dirId;

  /// Fires after each successful refresh with the count of tasks visible for
  /// [dirId], so the host tab can show "任务板(N)". Null = no badge update.
  final ValueChanged<int>? onTaskCount;

  /// Opens (or switches to) the session identified by [sessionId]. Wired by the
  /// host fleet sheet to SessionManager.openSession + switchToSession (chat) or
  /// a pushed TerminalScreen (terminal). Null = session jumping disabled.
  final void Function(String sessionId)? onOpenSession;

  const TaskBoardView({
    super.key,
    required this.settings,
    required this.dirId,
    this.onTaskCount,
    this.onOpenSession,
  });

  @override
  State<TaskBoardView> createState() => _TaskBoardViewState();
}

class _TaskBoardViewState extends State<TaskBoardView> {
  TaskBoard? _board;
  bool _loading = true;
  String? _error;
  final Set<String> _collapsed = {};
  Timer? _poll;
  bool _refreshing = false;

  // 归拢中浮窗：每次 refresh 期间短暂显示，1.5s 超时兜底隐藏（对齐 web 的
  // _tbShowGatheringFloat 1.5s 兜底）。若 server 报告 backfill.running 仍为真，
  // 浮窗会继续常驻直到那次归档结束。
  bool _gathering = false;
  Timer? _gatheringTimer;

  // 新任务自动定位 + 高亮：记录本视图曾见过的全部任务 id，每次 refresh 与新板
  // diff 出新增；取当前目录下可见的第一条新增任务，3s 黄色边框 + 滚动入视。
  // 首次加载只播种 _prevTaskIds，不高亮。
  final Set<String> _prevTaskIds = {};
  String? _highlightId;
  Timer? _highlightTimer;
  final Map<String, GlobalKey> _taskKeys = {};

  @override
  void initState() {
    super.initState();
    _refresh();
    _poll = Timer.periodic(const Duration(seconds: 60),
        (_) => _refresh(silent: true));
  }

  @override
  void dispose() {
    _poll?.cancel();
    _gatheringTimer?.cancel();
    _highlightTimer?.cancel();
    super.dispose();
  }

  Future<void> _refresh({bool silent = false}) async {
    if (!silent) setState(() => _loading = true);
    setState(() => _refreshing = true);
    _showGathering();
    try {
      final board =
          await ManageService(settings: widget.settings).fetchTaskBoard();
      if (!mounted) return;
      _detectNewAndHighlight(board);
      setState(() {
        _board = board;
        _loading = false;
        _error = null;
      });
      widget.onTaskCount?.call(_tasksForDir(widget.dirId, board).length);
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = e.toString();
      });
    } finally {
      if (mounted) setState(() => _refreshing = false);
    }
  }

  /// Diff the freshly-fetched board against [_prevTaskIds]. On a non-first load,
  /// if new task ids appeared, pick the first new task visible for this dir
  /// (sorted newest-activity first) and flag it for the 3s highlight + scroll.
  void _detectNewAndHighlight(TaskBoard board) {
    final allIds = <String>{for (final t in board.tasks) t.id};
    final newIds = _prevTaskIds.isEmpty
        ? const <String>{}
        : allIds.difference(_prevTaskIds);
    _prevTaskIds
      ..clear()
      ..addAll(allIds);
    if (newIds.isEmpty) return;
    final visible = _tasksForDir(widget.dirId, board);
    String? firstNew;
    for (final t in visible) {
      if (newIds.contains(t.id)) {
        firstNew = t.id;
        break;
      }
    }
    if (firstNew == null) return;
    _highlightId = firstNew;
    _highlightTimer?.cancel();
    _highlightTimer = Timer(const Duration(seconds: 3), () {
      if (mounted) setState(() => _highlightId = null);
    });
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final ctx = _taskKeys[_highlightId]?.currentContext;
      if (ctx != null) {
        Scrollable.ensureVisible(ctx,
            alignment: 0.3, duration: const Duration(milliseconds: 300));
      }
    });
  }

  GlobalKey _keyFor(String id) =>
      _taskKeys.putIfAbsent(id, () => GlobalKey());

  void _showGathering() {
    _gatheringTimer?.cancel();
    if (!_gathering) setState(() => _gathering = true);
    _gatheringTimer = Timer(const Duration(milliseconds: 1500), () {
      if (mounted && !(_board?.backfill?.running ?? false)) {
        setState(() => _gathering = false);
      }
    });
  }

  // ── 过滤 + 排序 (移植 public/task-board-ui.js + manage-taskboard.js) ───────
  // web 用 String.localeCompare('zh-CN',{numeric,base})；dart 无内置等价且本步不
  // 引入 intl 依赖，改用 String.compareTo 近似（注释说明）。Dart List.sort 非稳定，
  // 故每个比较返回 0 时回退到 id 做最终 tiebreak，保证与 web 一致的确定序。
  List<TaskBoardTask> _tasksForDir(String dirId, [TaskBoard? board]) {
    final b = board ?? _board;
    if (b == null) return const [];
    final modDir = {for (final m in b.modules) m.id: m.dirId};
    final tasks = b.tasks
        .where((t) =>
            t.status != 'archived' &&
            (t.dirIds.contains(dirId) || modDir[t.moduleId] == dirId))
        .toList();
    return _sortTasks(tasks);
  }

  List<TaskBoardTask> _sortTasks(List<TaskBoardTask> tasks) {
    // lastTs 降序 -> title (compareTo 近似 zh localeCompare) -> id。
    tasks.sort((a, b) {
      final byActivity = b.lastTs.compareTo(a.lastTs);
      if (byActivity != 0) return byActivity;
      final byTitle = a.title.compareTo(b.title);
      if (byTitle != 0) return byTitle;
      return a.id.compareTo(b.id);
    });
    return tasks;
  }

  List<TaskBoardModule> _sortModules(List<TaskBoardModule> modules) {
    // classify / '待归类' 排最前 -> name (compareTo 近似 zh localeCompare) -> id。
    modules.sort((a, b) {
      if (a.isPending != b.isPending) return a.isPending ? -1 : 1;
      final byName = a.name.compareTo(b.name);
      if (byName != 0) return byName;
      return a.id.compareTo(b.id);
    });
    return modules;
  }

  Future<void> _reclassifyPending() async {
    final messenger = ScaffoldMessenger.of(context);
    try {
      final r = await ManageService(settings: widget.settings)
          .reclassifyPending(dirId: widget.dirId);
      if (!mounted) return;
      messenger.showSnackBar(
        SnackBar(
          content: Text(t('reclassifyQueued', {
            'queued': '${r['queued'] ?? 0}',
            'skipped': '${r['skipped'] ?? 0}',
          })),
        ),
      );
      await _refresh(silent: true);
    } on LocalOnlyException {
      if (!mounted) return;
      messenger.showSnackBar(SnackBar(content: Text(t('localOnly'))));
    } catch (e) {
      if (!mounted) return;
      messenger.showSnackBar(
        SnackBar(content: Text(t('reclassifyFailed', {'error': '$e'}))),
      );
    }
  }

  void _openDetail(TaskBoardTask task) {
    final labels = _board?.sessionLabels ?? const <String, String>{};
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AppColors.panel,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
      ),
      builder: (sheetCtx) => _TaskDetailSheet(
        settings: widget.settings,
        task: task,
        sessionLabels: labels,
        onOpenSession: widget.onOpenSession,
        onChanged: () => _refresh(silent: true),
      ),
    );
  }

  Widget _buildTaskRow(TaskBoardTask task) {
    return _TaskRow(
      key: _keyFor(task.id),
      task: task,
      highlighted: _highlightId == task.id,
      onTap: () => _openDetail(task),
    );
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return const Center(
        child: Padding(
          padding: EdgeInsets.all(24),
          child: CircularProgressIndicator(strokeWidth: 2),
        ),
      );
    }
    final board = _board;
    if (board == null) {
      return _BoardEmpty(text: _error ?? t('noTasks'));
    }

    final tasks = _tasksForDir(widget.dirId, board);
    if (tasks.isEmpty) {
      return _BoardEmpty(text: t('noTasksHint'));
    }

    // Group tasks by module, keep only modules that have tasks here, and carry
    // orphan tasks (their module was pruned / filtered out) at the bottom so
    // they stay reachable - mirrors manage-taskboard.js renderTaskBoardSection.
    final byModule = <String, List<TaskBoardTask>>{};
    for (final t in tasks) {
      byModule.putIfAbsent(t.moduleId, () => []).add(t);
    }
    final mods =
        _sortModules(board.modules.where((m) => byModule.containsKey(m.id)).toList());
    final seen = mods.map((m) => m.id).toSet();
    final orphans =
        _sortTasks(tasks.where((t) => !seen.contains(t.moduleId)).toList());

    final showFloat =
        _gathering || (board.backfill?.running ?? false);

    return Stack(
      children: [
        ListView(
          padding: const EdgeInsets.fromLTRB(14, 8, 14, 24),
          children: [
            // 顶部统计行：『<模块数> 模块 · <任务数> 任务  🔄』
            Padding(
              padding: const EdgeInsets.only(bottom: 6),
              child: Row(
                children: [
                  Text(
                    t('taskBoardStat', {
                      'modules': '${mods.isEmpty ? 1 : mods.length}',
                      'tasks': '${tasks.length}',
                    }),
                    style:
                        const TextStyle(color: AppColors.muted, fontSize: 12),
                  ),
                  const Spacer(),
                  IconButton(
                    tooltip: t('refresh'),
                    onPressed: _refreshing ? null : () => _refresh(),
                    icon: _refreshing
                        ? const SizedBox(
                            width: 14,
                            height: 14,
                            child:
                                CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Icon(Icons.refresh_rounded,
                            size: 18, color: AppColors.muted),
                    constraints: const BoxConstraints(
                        minWidth: 32, minHeight: 32),
                    padding: EdgeInsets.zero,
                  ),
                ],
              ),
            ),
            for (final mod in mods) ...[
              _ModuleRow(
                module: mod,
                collapsed: _collapsed.contains(mod.id),
                onToggle: () => setState(() {
                  if (_collapsed.contains(mod.id)) {
                    _collapsed.remove(mod.id);
                  } else {
                    _collapsed.add(mod.id);
                  }
                }),
                onReclassifyAll:
                    mod.isPending ? _reclassifyPending : null,
              ),
              if (!_collapsed.contains(mod.id))
                for (final task in _sortTasks(byModule[mod.id]!))
                  _buildTaskRow(task),
            ],
            if (orphans.isNotEmpty)
              for (final task in orphans) _buildTaskRow(task),
          ],
        ),
        if (showFloat)
          const Positioned(
            right: 16,
            bottom: 16,
            child: _GatheringFloat(),
          ),
      ],
    );
  }
}

// ── Module row ───────────────────────────────────────────────────────────────

class _ModuleRow extends StatelessWidget {
  final TaskBoardModule module;
  final bool collapsed;
  final VoidCallback onToggle;
  final VoidCallback? onReclassifyAll;

  const _ModuleRow({
    required this.module,
    required this.collapsed,
    required this.onToggle,
    this.onReclassifyAll,
  });

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onToggle,
      borderRadius: BorderRadius.circular(6),
      child: Container(
        margin: const EdgeInsets.only(top: 8),
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 7),
        decoration: BoxDecoration(
          color: AppColors.panel2,
          borderRadius: BorderRadius.circular(6),
          border: Border.all(color: AppColors.line),
        ),
        child: Row(
          children: [
            Text(
              collapsed ? '▸' : '▾',
              style: const TextStyle(color: AppColors.muted, fontSize: 12),
            ),
            const SizedBox(width: 6),
            Flexible(
              child: Text(
                module.name,
                style: const TextStyle(
                  color: AppColors.textBright,
                  fontSize: 13,
                  fontWeight: FontWeight.w700,
                ),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
            ),
            const SizedBox(width: 6),
            Text(
              '${module.taskCount}',
              style:
                  const TextStyle(color: AppColors.faint, fontSize: 11),
            ),
            const Spacer(),
            if (onReclassifyAll != null)
              Padding(
                padding: const EdgeInsets.only(right: 6),
                child: _MiniButton(
                  label: t('reclassifyAll'),
                  onTap: onReclassifyAll!,
                ),
              ),
            Text(
              _timeAgo(module.lastTs),
              style: const TextStyle(color: AppColors.faint, fontSize: 10.5),
            ),
          ],
        ),
      ),
    );
  }
}

// ── Task row ─────────────────────────────────────────────────────────────────

class _TaskRow extends StatelessWidget {
  final TaskBoardTask task;
  final VoidCallback? onTap;
  final bool highlighted;

  const _TaskRow({
    required this.task,
    this.onTap,
    this.highlighted = false,
    super.key,
  });

  @override
  Widget build(BuildContext context) {
    final isDone = task.status == 'done';
    return Padding(
      padding: const EdgeInsets.fromLTRB(4, 2, 4, 2),
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 300),
        curve: Curves.easeOut,
        decoration: BoxDecoration(
          border: Border.all(
            color: highlighted
                ? const Color(0xFFe3b341)
                : Colors.transparent,
            width: highlighted ? 1.5 : 1,
          ),
          borderRadius: BorderRadius.circular(6),
        ),
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(6),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 2),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                // runState icon: running pulses; others are static emoji.
                Padding(
                  padding: const EdgeInsets.only(top: 2),
                  child: _runStateIcon(task.runState, isDone),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        task.title,
                        style: TextStyle(
                          color: isDone ? AppColors.faint : AppColors.text,
                          fontSize: 13,
                          decoration:
                              isDone ? TextDecoration.lineThrough : null,
                          decorationColor: AppColors.faint,
                        ),
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                      ),
                      const SizedBox(height: 3),
                      Wrap(
                        spacing: 6,
                        runSpacing: 3,
                        crossAxisAlignment: WrapCrossAlignment.center,
                        children: [
                          if (task.classification != null)
                            _classifyBadge(task.classification!),
                          Text(
                            '${t('taskRounds', {'n': '${task.refCount}'})}'
                            '${_timeAgo(task.lastTs).isEmpty ? '' : ' · ${_timeAgo(task.lastTs)}'}',
                            style: const TextStyle(
                                color: AppColors.faint, fontSize: 10.5),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _runStateIcon(String runState, bool isDone) {
    switch (runState) {
      case 'running':
        return const _RunningDot();
      case 'waiting':
        return const _EmojiDot('⏳');
      case 'error':
        return const _EmojiDot('❌');
      default:
        if (isDone) return const _EmojiDot('✅');
        if (runState == 'done') return const _EmojiDot('✅');
        return const _EmojiDot('⚪');
    }
  }
}

/// Pulsing green dot for a running task. Only this widget owns an animation
/// controller, so idle/waiting/error rows stay cheap (no tickers allocated).
class _RunningDot extends StatefulWidget {
  const _RunningDot();

  @override
  State<_RunningDot> createState() => _RunningDotState();
}

class _RunningDotState extends State<_RunningDot>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c;
  late final Animation<double> _scale;

  @override
  void initState() {
    super.initState();
    _c = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 900),
    )..repeat(reverse: true);
    _scale = Tween<double>(begin: 0.7, end: 1.15).animate(
      CurvedAnimation(parent: _c, curve: Curves.easeInOut),
    );
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _scale,
      builder: (_, __) => Transform.scale(
        scale: _scale.value,
        child: Container(
          width: 9,
          height: 9,
          decoration: const BoxDecoration(
            color: Color(0xFF7fd49a),
            shape: BoxShape.circle,
            boxShadow: [
              BoxShadow(
                color: Color(0x667fd49a),
                blurRadius: 5,
                spreadRadius: 0.5,
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _EmojiDot extends StatelessWidget {
  final String emoji;
  const _EmojiDot(this.emoji);

  @override
  Widget build(BuildContext context) =>
    Text(emoji, style: const TextStyle(fontSize: 12));
}

/// Classify-state pill. Five states mirror manage-taskboard.js
/// _tbClassificationHtml; `lastError` becomes the tooltip. retry_wait appends a
/// "N 分钟后重试" countdown computed from `nextRetryAt` (refreshed each 60s poll,
/// so no extra ticker is needed).
Widget _classifyBadge(TaskClassification c) {
  final ({Color color, String label}) style = switch (c.state) {
    'waiting_reply' => (
      color: const Color(0xFFe3b341),
      label: t('tbClassWaitingReply'),
    ),
    'running' => (
      color: const Color(0xFF6cb6ff),
      label: t('tbClassRunning'),
    ),
    'retry_wait' => (
      color: const Color(0xFFe3b341),
      label: t('tbClassRetryWait'),
    ),
    'failed' => (
      color: AppColors.danger,
      label: t('tbClassFailed'),
    ),
    _ => (
      color: AppColors.muted,
      label: t('tbClassPending'),
    ),
  };
  var label = style.label;
  if (c.state == 'retry_wait' && c.nextRetryAt != null) {
    final now = DateTime.now().millisecondsSinceEpoch;
    var m = ((c.nextRetryAt! - now) / 60000).ceil();
    if (m < 0) m = 0;
    label = '$label · ${t('tbRetryInMinutes', {'m': '$m'})}';
  }
  final chip = Container(
    padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1.5),
    decoration: BoxDecoration(
      color: style.color.withValues(alpha: 0.15),
      border: Border.all(color: style.color.withValues(alpha: 0.4)),
      borderRadius: BorderRadius.circular(4),
    ),
    child: Text(
      label,
      style: TextStyle(
        color: style.color,
        fontSize: 9.5,
        fontWeight: FontWeight.w700,
      ),
    ),
  );
  final err = c.lastError;
  return (err != null && err.isNotEmpty)
      ? Tooltip(message: err, child: chip)
      : chip;
}

// ── Task detail sheet ────────────────────────────────────────────────────────

/// Bottom sheet for one task: run state + classify badge + rounds/time, areas
/// and session chips (tappable -> jump to session), the cross-session message
/// trail (async [ManageService.fetchTaskMessages]), and the status / reclassify
/// actions. Writes are localhost-only; a 403 surfaces as a [LocalOnlyException]
/// SnackBar, other errors as a plain SnackBar.
class _TaskDetailSheet extends StatefulWidget {
  final SettingsService settings;
  final TaskBoardTask task;
  final Map<String, String> sessionLabels;
  final void Function(String sessionId)? onOpenSession;
  final VoidCallback onChanged;

  const _TaskDetailSheet({
    required this.settings,
    required this.task,
    required this.sessionLabels,
    required this.onChanged,
    this.onOpenSession,
  });

  @override
  State<_TaskDetailSheet> createState() => _TaskDetailSheetState();
}

class _TaskDetailSheetState extends State<_TaskDetailSheet> {
  List<TaskMessage>? _messages;
  bool _loadingMsgs = true;
  String? _msgError;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _loadMessages();
  }

  Future<void> _loadMessages() async {
    setState(() {
      _loadingMsgs = true;
      _msgError = null;
    });
    try {
      final msgs = await ManageService(settings: widget.settings)
          .fetchTaskMessages(widget.task.id);
      if (!mounted) return;
      setState(() {
        _messages = msgs;
        _loadingMsgs = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _msgError = e.toString();
        _loadingMsgs = false;
      });
    }
  }

  String _sessionLabel(String sid) =>
      widget.sessionLabels[sid] ?? sid;

  Future<void> _setStatus(String status) async {
    final messenger = ScaffoldMessenger.of(context);
    setState(() => _busy = true);
    try {
      await ManageService(settings: widget.settings)
          .setTaskStatus(widget.task.id, status);
      if (!mounted) return;
      Navigator.of(context).pop();
      widget.onChanged();
    } on LocalOnlyException {
      if (!mounted) return;
      messenger.showSnackBar(SnackBar(content: Text(t('localOnly'))));
    } catch (e) {
      if (!mounted) return;
      messenger.showSnackBar(SnackBar(content: Text('$e')));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _confirmArchive() async {
    final confirm = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AppColors.panel,
        title: Text(t('confirmArchive')),
        content: Text(
          widget.task.title,
          style: const TextStyle(color: AppColors.text, fontSize: 13),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: Text(t('cancel')),
          ),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            style: TextButton.styleFrom(foregroundColor: AppColors.danger),
            child: Text(t('archive')),
          ),
        ],
      ),
    );
    if (confirm == true && mounted) _setStatus('archived');
  }

  Future<void> _reclassify() async {
    final messenger = ScaffoldMessenger.of(context);
    setState(() => _busy = true);
    try {
      await ManageService(settings: widget.settings)
          .reclassifyTask(widget.task.id);
      if (!mounted) return;
      Navigator.of(context).pop();
      widget.onChanged();
    } on LocalOnlyException {
      if (!mounted) return;
      messenger.showSnackBar(SnackBar(content: Text(t('localOnly'))));
    } catch (e) {
      if (!mounted) return;
      messenger.showSnackBar(SnackBar(content: Text('$e')));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _jumpToSession(String sid) {
    // Close this detail sheet first, then hand off to the fleet sheet's opener
    // (which uses its own context / mgr and outlives this modal route).
    final open = widget.onOpenSession;
    Navigator.of(context).pop();
    if (open != null) open(sid);
  }

  ({String label, Color color, String emoji}) _runStateInfo(
      String runState, bool isDone) {
    switch (runState) {
      case 'running':
        return (
          label: t('tbRunRunning'),
          color: const Color(0xFF7fd49a),
          emoji: '🟢',
        );
      case 'waiting':
        return (
          label: t('tbRunWaiting'),
          color: const Color(0xFFe3b341),
          emoji: '⏳',
        );
      case 'error':
        return (
          label: t('tbRunError'),
          color: AppColors.danger,
          emoji: '❌',
        );
      case 'done':
        return (
          label: t('tbRunDone'),
          color: AppColors.faint,
          emoji: '✅',
        );
      default:
        if (isDone) {
          return (
            label: t('tbRunDone'),
            color: AppColors.faint,
            emoji: '✅',
          );
        }
        return (
          label: t('tbRunIdle'),
          color: AppColors.muted,
          emoji: '⚪',
        );
    }
  }

  @override
  Widget build(BuildContext context) {
    final mq = MediaQuery.of(context);
    final task = widget.task;
    final isDone = task.status == 'done';
    final rs = _runStateInfo(task.runState, isDone);
    final canReclassify = task.classification?.state != 'running';

    return SafeArea(
      child: Container(
        height: mq.size.height * 0.85,
        decoration: const BoxDecoration(
          color: AppColors.panel,
          borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
        ),
        child: Column(
          children: [
            // Header: title + close.
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 10, 8, 8),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      task.title,
                      style: TextStyle(
                        color: isDone ? AppColors.faint : AppColors.textBright,
                        fontSize: 15,
                        fontWeight: FontWeight.w700,
                        decoration:
                            isDone ? TextDecoration.lineThrough : null,
                        decorationColor: AppColors.faint,
                      ),
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                  IconButton(
                    tooltip: t('close'),
                    onPressed: () => Navigator.of(context).pop(),
                    icon: const Icon(Icons.close_rounded,
                        color: AppColors.muted, size: 20),
                    constraints: const BoxConstraints(
                        minWidth: 36, minHeight: 36),
                    padding: EdgeInsets.zero,
                  ),
                ],
              ),
            ),
            // Meta: runState + classify badge + rounds/time, areas, sessions.
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Wrap(
                    spacing: 8,
                    runSpacing: 4,
                    crossAxisAlignment: WrapCrossAlignment.center,
                    children: [
                      Text(
                        '${rs.emoji} ${rs.label}',
                        style: TextStyle(
                          color: rs.color,
                          fontSize: 11,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                      if (task.classification != null)
                        _classifyBadge(task.classification!),
                      Text(
                        '${t('taskRounds', {'n': '${task.refCount}'})}'
                        '${_timeAgo(task.lastTs).isEmpty ? '' : ' · ${_timeAgo(task.lastTs)}'}',
                        style: const TextStyle(
                            color: AppColors.faint, fontSize: 10.5),
                      ),
                    ],
                  ),
                  if (task.areas.isNotEmpty) ...[
                    const SizedBox(height: 8),
                    Wrap(
                      spacing: 6,
                      runSpacing: 4,
                      children: [
                        for (final a in task.areas) _TagChip(a),
                      ],
                    ),
                  ],
                  if (task.sessionIds.isNotEmpty) ...[
                    const SizedBox(height: 8),
                    Wrap(
                      spacing: 6,
                      runSpacing: 4,
                      children: [
                        for (final sid in task.sessionIds)
                          _TagChip(
                            widget.sessionLabels[sid] ?? sid,
                            onTap: widget.onOpenSession != null
                                ? () => _jumpToSession(sid)
                                : null,
                          ),
                      ],
                    ),
                  ],
                ],
              ),
            ),
            const Divider(height: 1, color: AppColors.line),
            // Messages section header.
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 4),
              child: Align(
                alignment: Alignment.centerLeft,
                child: Text(
                  t('tbMessages'),
                  style: const TextStyle(
                    color: AppColors.muted,
                    fontSize: 11,
                    fontWeight: FontWeight.w700,
                    letterSpacing: 0.5,
                  ),
                ),
              ),
            ),
            Expanded(child: _messagesBody()),
            const Divider(height: 1, color: AppColors.line),
            _actions(canReclassify: canReclassify),
          ],
        ),
      ),
    );
  }

  Widget _messagesBody() {
    if (_loadingMsgs) {
      return const Center(
        child: Padding(
          padding: EdgeInsets.all(20),
          child: CircularProgressIndicator(strokeWidth: 2),
        ),
      );
    }
    if (_msgError != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.error_outline, color: AppColors.danger, size: 28),
              const SizedBox(height: 8),
              Text(
                _msgError!,
                style: const TextStyle(color: AppColors.faint, fontSize: 12),
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 12),
              TextButton.icon(
                onPressed: _loadMessages,
                icon: const Icon(Icons.refresh_rounded, size: 16),
                label: Text(t('retry')),
              ),
            ],
          ),
        ),
      );
    }
    final msgs = _messages ?? const [];
    if (msgs.isEmpty) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Text(
            t('noMessages'),
            style: const TextStyle(color: AppColors.faint, fontSize: 12),
          ),
        ),
      );
    }
    return ListView.separated(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
      itemCount: msgs.length,
      separatorBuilder: (_, __) => const SizedBox(height: 10),
      itemBuilder: (_, i) => _messageRow(msgs[i]),
    );
  }

  Widget _messageRow(TaskMessage m) {
    final label = m.sessionLabel ?? _sessionLabel(m.sessionId);
    if (m.lost) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: Text(
          t('tbMsgLost'),
          style: const TextStyle(
            color: AppColors.faint,
            fontSize: 11,
            fontStyle: FontStyle.italic,
          ),
        ),
      );
    }
    final isUser = m.role == 'user';
    final roleColor = isUser ? AppColors.blue : AppColors.codex;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Text(isUser ? '👤' : '🤖', style: const TextStyle(fontSize: 11)),
            const SizedBox(width: 4),
            Flexible(
              child: Text(
                label,
                style: TextStyle(
                  color: roleColor,
                  fontSize: 10.5,
                  fontWeight: FontWeight.w700,
                  fontFamily: 'monospace',
                ),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
            ),
            const SizedBox(width: 6),
            Text(
              _timeAgo(m.ts),
              style: const TextStyle(color: AppColors.faint, fontSize: 9.5),
            ),
          ],
        ),
        const SizedBox(height: 3),
        SelectableText(
          m.text,
          style: const TextStyle(
            color: AppColors.text,
            fontSize: 12.5,
            height: 1.45,
          ),
        ),
      ],
    );
  }

  Widget _actions({required bool canReclassify}) {
    final task = widget.task;
    return Padding(
      padding: EdgeInsets.fromLTRB(
        16,
        8,
        16,
        8 + MediaQuery.of(context).padding.bottom,
      ),
      child: Row(
        children: [
          if (_busy)
            const SizedBox(
              width: 16,
              height: 16,
              child: CircularProgressIndicator(strokeWidth: 2),
            ),
          const Spacer(),
          Wrap(
            spacing: 8,
            runSpacing: 6,
            alignment: WrapAlignment.end,
            children: [
              if (canReclassify)
                _ActionButton(
                  label: t('reclassify'),
                  icon: Icons.autorenew_rounded,
                  onPressed: _busy ? null : _reclassify,
                ),
              if (task.status == 'active') ...[
                _ActionButton(
                  label: '✅ ${t('done')}',
                  icon: Icons.check_rounded,
                  filled: true,
                  onPressed: _busy ? null : () => _setStatus('done'),
                ),
                _ActionButton(
                  label: '🗄 ${t('archive')}',
                  icon: Icons.archive_outlined,
                  danger: true,
                  onPressed: _busy ? null : _confirmArchive,
                ),
              ] else if (task.status == 'done') ...[
                _ActionButton(
                  label: '♻️ ${t('reopen')}',
                  icon: Icons.restart_alt_rounded,
                  onPressed: _busy ? null : () => _setStatus('active'),
                ),
                _ActionButton(
                  label: '🗄 ${t('archive')}',
                  icon: Icons.archive_outlined,
                  danger: true,
                  onPressed: _busy ? null : _confirmArchive,
                ),
              ],
            ],
          ),
        ],
      ),
    );
  }
}

// ── Gathering float + empty state + chips + buttons ──────────────────────────

class _GatheringFloat extends StatelessWidget {
  const _GatheringFloat();

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 9),
      decoration: BoxDecoration(
        color: const Color(0xE6000000),
        borderRadius: BorderRadius.circular(8),
        boxShadow: const [
          BoxShadow(
            color: Color(0x4D000000),
            blurRadius: 12,
            offset: Offset(0, 4),
          ),
        ],
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          const SizedBox(
            width: 13,
            height: 13,
            child: CircularProgressIndicator(strokeWidth: 2),
          ),
          const SizedBox(width: 8),
          Text(
            t('taskGathering'),
            style: const TextStyle(color: AppColors.textBright, fontSize: 12.5),
          ),
        ],
      ),
    );
  }
}

class _BoardEmpty extends StatelessWidget {
  final String text;
  const _BoardEmpty({required this.text});

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 28),
        child: Text(
          text,
          textAlign: TextAlign.center,
          style: const TextStyle(color: AppColors.faint, fontSize: 12.5),
        ),
      ),
    );
  }
}

class _MiniButton extends StatelessWidget {
  final String label;
  final VoidCallback onTap;
  const _MiniButton({required this.label, required this.onTap});

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(4),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2.5),
        decoration: BoxDecoration(
          color: AppColors.accent.withValues(alpha: 0.14),
          border: Border.all(color: AppColors.accent.withValues(alpha: 0.4)),
          borderRadius: BorderRadius.circular(4),
        ),
        child: Text(
          label,
          style: const TextStyle(
            color: AppColors.accent,
            fontSize: 10.5,
            fontWeight: FontWeight.w700,
          ),
        ),
      ),
    );
  }
}

/// Small tag chip used for areas (non-tappable) and session ids (tappable ->
/// jump to session). Monospace label so session ids stay legible.
class _TagChip extends StatelessWidget {
  final String label;
  final VoidCallback? onTap;
  const _TagChip(this.label, {this.onTap});

  @override
  Widget build(BuildContext context) {
    final tappable = onTap != null;
    final color = tappable ? AppColors.blue : AppColors.muted;
    final chip = Container(
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
      decoration: BoxDecoration(
        color: AppColors.panel2,
        border: Border.all(
          color: tappable
              ? AppColors.blue.withValues(alpha: 0.4)
              : AppColors.line,
        ),
        borderRadius: BorderRadius.circular(4),
      ),
      child: Text(
        label,
        style: TextStyle(
          color: color,
          fontSize: 10.5,
          fontFamily: 'monospace',
        ),
      ),
    );
    if (!tappable) return chip;
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(4),
      child: chip,
    );
  }
}

/// Pill-style action button for the detail sheet footer. [filled] marks the
/// primary action (teal); [danger] tints archive red. A null [onPressed] dims
/// the button (used while a write is in flight).
class _ActionButton extends StatelessWidget {
  final String label;
  final IconData? icon;
  final VoidCallback? onPressed;
  final bool filled;
  final bool danger;

  const _ActionButton({
    required this.label,
    this.icon,
    this.onPressed,
    this.filled = false,
    this.danger = false,
  });

  @override
  Widget build(BuildContext context) {
    final color = danger ? AppColors.danger : AppColors.accent;
    final disabled = onPressed == null;
    return Opacity(
      opacity: disabled ? 0.4 : 1,
      child: InkWell(
        onTap: onPressed,
        borderRadius: BorderRadius.circular(8),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          decoration: BoxDecoration(
            color: filled ? color.withValues(alpha: 0.18) : AppColors.panel2,
            border: Border.all(
              color: color.withValues(alpha: filled ? 0.5 : 0.35),
            ),
            borderRadius: BorderRadius.circular(8),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (icon != null) ...[
                Icon(icon, size: 14, color: color),
                const SizedBox(width: 5),
              ],
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
      ),
    );
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

String _timeAgo(int ts) {
  if (ts <= 0) return '';
  return formatRelativeTime(
    DateTime.fromMillisecondsSinceEpoch(ts),
  );
}
