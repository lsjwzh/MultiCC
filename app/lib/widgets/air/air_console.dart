import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

import '../../models/message.dart';
import '../../services/air_service.dart';
import '../../services/manage_service.dart';
import '../../services/settings_service.dart';
import '../../theme.dart';
import '../workspace_navigation_drawer.dart';
import 'air_panels.dart';
import 'air_task_status.dart';

/// 控制台：跨所有工作目录看「现在有什么在跑、有什么在等我」。
///
/// 对应 Web `public/air-admin.js` 的 `renderOverview`。Web 那边它是一层盖在当前
/// 页面上的浮层（点一条任务浮层自己让开）；手机上并排放不下，所以这边是一条
/// 独立页面 —— 分区的顺序、每张卡上的数字和每个筛选的含义都照搬。
///
/// 数据只来自两个地方：`/api/air` 那一份快照（任务 + 目录）和 `/api/cron`
/// （定时任务）。控制台不新开一套统计口径，也不自己算「在不在跑」。
class AirConsoleScreen extends StatefulWidget {
  const AirConsoleScreen({
    super.key,
    required this.settings,
    required this.onOpenTask,
    required this.onOpenTasks,
    required this.onOpenLibrary,
    required this.onSelectDirectory,
    required this.onOpenDestination,
    required this.onOpenMemory,
    required this.onOpenWebConsole,
    this.httpClient,
  });

  final SettingsService settings;
  final http.Client? httpClient;

  /// 点开一条任务。控制台是跨目录的，所以这一跳带着任务自己的目录走，不看
  /// 当前选的是哪个目录。
  final ValueChanged<AirTask> onOpenTask;

  /// 回到任务主区（「新建任务」和「进行中任务」卡片都走这里 —— App 的任务页
  /// 顶上就是输入区，所以这两件事落在同一个地方）。
  final VoidCallback onOpenTasks;
  final VoidCallback onOpenLibrary;

  /// 从「工作目录」那一栏切到某个目录（回到任务主区）。
  final ValueChanged<String> onSelectDirectory;

  /// 服务与设置那四张卡：服务与文档 / 设置中心 / 自动运行走老抽屉里的原生目的地。
  final ValueChanged<WorkspaceDestination> onOpenDestination;

  /// 记忆图谱在 App 里仍是网页那一页（原生版还没做），单独给一个回调。
  final VoidCallback onOpenMemory;

  /// 控制台里的一切都在原生页上；想用网页版留一个明确的出口。
  final VoidCallback onOpenWebConsole;

  @override
  State<AirConsoleScreen> createState() => _AirConsoleScreenState();
}

/// 控制台是给人看的，不是导出用的：超过这个数就只显示最近的一批，并把总数
/// 说清楚（同 Web `TASK_LIST_LIMIT`）。
const int _taskListLimit = 60;

enum _ConsoleStatus { open, all, archived }

class _AirConsoleScreenState extends State<AirConsoleScreen> {
  late final AirService _service = AirService(
    settings: widget.settings,
    httpClient: widget.httpClient,
  );
  final _search = TextEditingController();
  AirSnapshot? _data;
  List<CronTask>? _schedules;
  String _error = '';
  bool _loading = false, _cronFailed = false;
  String _query = '';
  _ConsoleStatus _status = _ConsoleStatus.open;
  String _dir = 'all';

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _search.dispose();
    _service.close();
    super.dispose();
  }

  /// 两份数据一起拉，但能不能各自失败要分开算：定时任务读不到不该让整个控制台
  /// 变成一页错误 —— 任务和目录才是这一页的主体。
  Future<void> _load() async {
    if (_loading) return;
    _loading = true;
    try {
      final snapshot = await _service.load();
      if (!mounted) return;
      setState(() {
        _data = snapshot;
        _error = '';
      });
    } catch (error) {
      if (mounted) setState(() => _error = error.toString());
    } finally {
      _loading = false;
    }
    try {
      final tasks = await ManageService(
        settings: widget.settings,
        httpClient: widget.httpClient,
      ).fetchCronTasks();
      if (!mounted) return;
      setState(() {
        _schedules = tasks;
        _cronFailed = false;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _schedules = null;
        _cronFailed = true;
      });
    }
  }

  List<AirTask> get _tasks => _data?.tasks ?? const [];

  String _directoryName(String dirId) =>
      _data?.directoryOf(dirId)?.name ?? dirId;

  /// 「全部任务」这一份列表。控制台是跨目录的，这里不按当前目录收窄 —— 目录是
  /// 执行上下文，不是「能不能看见这条任务」的前提。
  List<AirTask> get _filteredTasks {
    final needle = _query.trim().toLowerCase();
    final rows = _tasks
        .where(
          (task) => switch (_status) {
            _ConsoleStatus.all => true,
            _ConsoleStatus.archived => task.status == 'archived',
            _ConsoleStatus.open => !task.closed,
          },
        )
        .where((task) => _dir == 'all' || task.dirId == _dir)
        .where(
          (task) =>
              needle.isEmpty ||
              '${task.title} ${_directoryName(task.dirId)}'.toLowerCase()
                  .contains(needle),
        )
        .toList()
      ..sort((a, b) => b.updatedAt.compareTo(a.updatedAt));
    return rows;
  }

  @override
  Widget build(BuildContext context) {
    final data = _data;
    final tasks = _tasks;
    final active = tasks.where((task) => !task.closed).toList();
    final executing = active.where(airTaskRunning).toList();
    final waiting = active.where((task) => airTaskUrgency(task) < 3).toList();
    final running = airRunningDirectories(tasks);
    final enabledSchedules = (_schedules ?? const <CronTask>[])
        .where((task) => task.enabled)
        .length;
    final urgent = airUrgentTasks(tasks);
    final rows = _filteredTasks;
    final shown = rows.take(_taskListLimit).toList();

    return Scaffold(
      backgroundColor: AppColors.bg,
      appBar: AppBar(
        backgroundColor: AppColors.panel,
        foregroundColor: AppColors.text,
        elevation: 0,
        scrolledUnderElevation: 0,
        title: const Text(
          '控制台',
          style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
        ),
        actions: [
          PopupMenuButton<String>(
            key: const ValueKey('air-console-menu'),
            icon: const Icon(Icons.more_horiz_rounded),
            tooltip: '更多操作',
            color: AppColors.panel,
            onSelected: (value) {
              switch (value) {
                case 'library':
                  widget.onOpenLibrary();
                case 'create':
                  widget.onOpenTasks();
                case 'refresh':
                  _load();
                case 'web':
                  widget.onOpenWebConsole();
              }
            },
            itemBuilder: (context) => const [
              PopupMenuItem(value: 'library', child: Text('浏览工作目录')),
              PopupMenuItem(value: 'create', child: Text('新建任务')),
              PopupMenuItem(value: 'refresh', child: Text('刷新')),
              PopupMenuItem(value: 'web', child: Text('在网页里打开控制台')),
            ],
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          key: const ValueKey('air-console'),
          padding: const EdgeInsets.fromLTRB(16, 14, 16, 28),
          children: [
            if (_error.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(bottom: 12),
                child: Text(
                  _error,
                  style: const TextStyle(
                    color: AppColors.danger,
                    fontSize: 12.5,
                  ),
                ),
              ),
            if (data == null && _error.isEmpty)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 60),
                child: Center(child: CircularProgressIndicator()),
              )
            else ...[
              _Stats(
                directories: data?.directories.length ?? 0,
                runningDirectories: running.length,
                active: active.length,
                executing: executing.length,
                waiting: waiting.length,
                enabledSchedules: enabledSchedules,
                totalSchedules: _schedules?.length,
                schedulesLoading: _schedules == null && !_cronFailed,
                schedulesFailed: _cronFailed,
                onOpenTasks: widget.onOpenTasks,
                onOpenLibrary: widget.onOpenLibrary,
                onOpenSchedules: () => widget.onOpenDestination(
                  WorkspaceDestination.cron,
                ),
              ),
              const SizedBox(height: 15),
              _Panel(
                eyebrow: 'ACROSS ALL WORKSPACES',
                title: '谁在等我',
                note: '按紧急度排序，点击直达',
                child: Column(
                  children: [
                    for (final task in urgent)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 8),
                        child: AirTaskTile(
                          // 同一条任务在「谁在等我」和「全部任务」里各出现一次，
                          // 两个分区因此各给一份自己的标识。
                          key: ValueKey('air-console-urgent-${task.id}'),
                          task: task,
                          directoryName: _directoryName(task.dirId),
                          showTime: true,
                          onTap: () => widget.onOpenTask(task),
                        ),
                      ),
                    if (urgent.isEmpty)
                      const _Empty('没有正在等待或正在执行的任务。'),
                  ],
                ),
              ),
              const SizedBox(height: 15),
              _Panel(
                eyebrow: 'ALL TASKS · 全部目录',
                title: '全部任务',
                note: rows.length > shown.length
                    ? '${rows.length} 条 · 显示最近 ${shown.length} 条'
                    : '${rows.length} 条',
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    TextField(
                      key: const ValueKey('air-console-search'),
                      controller: _search,
                      onChanged: (value) => setState(() => _query = value),
                      style: const TextStyle(
                        color: AppColors.text,
                        fontSize: 13,
                      ),
                      decoration: sheetInputDecoration(hint: '搜索标题或目录'),
                    ),
                    const SizedBox(height: 8),
                    Row(
                      children: [
                        Expanded(
                          child: _Picker<_ConsoleStatus>(
                            pickerKey: const ValueKey('air-console-status'),
                            value: _status,
                            items: const {
                              _ConsoleStatus.open: '进行中与待处理',
                              _ConsoleStatus.all: '全部记录',
                              _ConsoleStatus.archived: '已归档',
                            },
                            onChanged: (value) =>
                                setState(() => _status = value),
                          ),
                        ),
                        const SizedBox(width: 8),
                        Expanded(
                          child: _Picker<String>(
                            pickerKey: const ValueKey('air-console-dir'),
                            value: _dir,
                            items: {
                              'all': '全部目录',
                              for (final directory
                                  in data?.directories ??
                                      const <AirDirectory>[])
                                directory.id: directory.name,
                            },
                            onChanged: (value) => setState(() => _dir = value),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 10),
                    for (final task in shown)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 8),
                        child: AirTaskTile(
                          key: ValueKey('air-console-task-${task.id}'),
                          task: task,
                          directoryName: _directoryName(task.dirId),
                          showTime: true,
                          onTap: () => widget.onOpenTask(task),
                        ),
                      ),
                    if (rows.isEmpty)
                      const _Empty('没有符合条件的任务。换个关键词或放宽筛选。'),
                  ],
                ),
              ),
              const SizedBox(height: 15),
              _Panel(
                eyebrow: 'WORK DIRECTORIES',
                title: '工作目录',
                note: '目录库与搜索在右上角',
                child: Column(
                  children: [
                    for (final directory
                        in data?.directories ?? const <AirDirectory>[])
                      _DirectoryRow(
                        directory: directory,
                        tasks: tasks
                            .where((task) => task.dirId == directory.id)
                            .toList(),
                        running: running.contains(directory.id),
                        onTap: () => widget.onSelectDirectory(directory.id),
                      ),
                    if ((data?.directories ?? const []).isEmpty)
                      const _Empty('还没有工作目录。'),
                  ],
                ),
              ),
              const SizedBox(height: 15),
              _Panel(
                eyebrow: 'SYSTEM TOOLS',
                title: '服务与设置',
                child: _ToolGrid(
                  onOpenDocs: () =>
                      widget.onOpenDestination(WorkspaceDestination.docs),
                  onOpenMemory: widget.onOpenMemory,
                  onOpenSettings: () =>
                      widget.onOpenDestination(WorkspaceDestination.global),
                  onOpenSchedules: () =>
                      widget.onOpenDestination(WorkspaceDestination.cron),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// 四张统计卡。Web 是四列一行，手机上一行放不下，改成两列两行。
class _Stats extends StatelessWidget {
  const _Stats({
    required this.directories,
    required this.runningDirectories,
    required this.active,
    required this.executing,
    required this.waiting,
    required this.enabledSchedules,
    required this.totalSchedules,
    required this.schedulesLoading,
    required this.schedulesFailed,
    required this.onOpenTasks,
    required this.onOpenLibrary,
    required this.onOpenSchedules,
  });

  final int directories;
  final int runningDirectories;
  final int active;
  final int executing;
  final int waiting;
  final int enabledSchedules;

  /// null 表示还没读到（定时任务和任务快照是两份数据，各自会失败）。
  final int? totalSchedules;
  final bool schedulesLoading;
  final bool schedulesFailed;
  final VoidCallback onOpenTasks;
  final VoidCallback onOpenLibrary;
  final VoidCallback onOpenSchedules;

  @override
  Widget build(BuildContext context) {
    final scheduleDetail = schedulesFailed
        ? '定时任务读取失败，下拉重试'
        : schedulesLoading
        ? '正在读取…'
        : '共 ${totalSchedules ?? 0} 条规则';
    return Column(
      children: [
        Row(
          children: [
            Expanded(
              child: _StatCard(
                label: '工作目录',
                value: '$directories',
                detail: runningDirectories > 0
                    ? '$runningDirectories 个目录正在跑'
                    : '统一目录库',
                tone: AppColors.accent,
                onTap: onOpenLibrary,
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: _StatCard(
                label: '进行中任务',
                value: '$active',
                detail: '$executing 个正在执行',
                tone: AppColors.success,
                onTap: onOpenTasks,
              ),
            ),
          ],
        ),
        const SizedBox(height: 10),
        Row(
          children: [
            Expanded(
              child: _StatCard(
                label: '等待处理',
                value: '$waiting',
                detail: waiting > 0 ? '等待回答、资源或重试' : '当前没有要处理的事',
                tone: waiting > 0 ? AppColors.amber : null,
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: _StatCard(
                label: '定时任务',
                value: schedulesLoading || schedulesFailed
                    ? '—'
                    : '$enabledSchedules',
                detail: scheduleDetail,
                tone: AppColors.opencode,
                onTap: onOpenSchedules,
              ),
            ),
          ],
        ),
      ],
    );
  }
}

class _StatCard extends StatelessWidget {
  const _StatCard({
    required this.label,
    required this.value,
    required this.detail,
    this.tone,
    this.onTap,
  });

  final String label;
  final String value;
  final String detail;
  final Color? tone;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: AppColors.panel,
      borderRadius: BorderRadius.circular(AppColors.radiusCard),
      child: InkWell(
        key: ValueKey('air-stat-$label'),
        onTap: onTap,
        borderRadius: BorderRadius.circular(AppColors.radiusCard),
        child: Container(
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(AppColors.radiusCard),
            border: Border.all(color: AppColors.line),
          ),
          padding: const EdgeInsets.fromLTRB(13, 11, 13, 12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Container(
                width: 26,
                height: 3,
                margin: const EdgeInsets.only(bottom: 9),
                decoration: BoxDecoration(
                  color: tone ?? AppColors.lineStrong,
                  borderRadius: BorderRadius.circular(AppColors.radiusPill),
                ),
              ),
              Text(
                label,
                style: const TextStyle(color: AppColors.muted, fontSize: 11),
              ),
              const SizedBox(height: 4),
              Text(
                value,
                style: const TextStyle(
                  color: AppColors.text,
                  fontSize: 24,
                  height: 1,
                  fontWeight: FontWeight.w700,
                ),
              ),
              const SizedBox(height: 6),
              Text(
                detail,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(color: AppColors.faint, fontSize: 11),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// 一个分区：eyebrow + 标题 + 右上角一句注。
class _Panel extends StatelessWidget {
  const _Panel({
    required this.eyebrow,
    required this.title,
    required this.child,
    this.note,
  });

  final String eyebrow;
  final String title;
  final String? note;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        color: AppColors.panel,
        borderRadius: BorderRadius.circular(AppColors.radiusPanel),
        border: Border.all(color: AppColors.line),
      ),
      padding: const EdgeInsets.fromLTRB(13, 12, 13, 13),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      eyebrow,
                      style: const TextStyle(
                        color: AppColors.faint,
                        fontSize: 9.5,
                        fontWeight: FontWeight.w700,
                        letterSpacing: 1.1,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      title,
                      style: const TextStyle(
                        color: AppColors.text,
                        fontSize: 15,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ],
                ),
              ),
              if (note != null)
                Padding(
                  padding: const EdgeInsets.only(left: 8, top: 12),
                  child: Text(
                    note!,
                    style: const TextStyle(
                      color: AppColors.faint,
                      fontSize: 10.5,
                    ),
                  ),
                ),
            ],
          ),
          const SizedBox(height: 10),
          child,
        ],
      ),
    );
  }
}

class _Empty extends StatelessWidget {
  const _Empty(this.text);

  final String text;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 10),
    child: Text(
      text,
      style: const TextStyle(color: AppColors.faint, fontSize: 12.5),
    ),
  );
}

/// 一个下拉筛选。手机上没有 ⌘K，条件就只能摆出来点。
class _Picker<T> extends StatelessWidget {
  const _Picker({
    required this.pickerKey,
    required this.value,
    required this.items,
    required this.onChanged,
  });

  final Key pickerKey;
  final T value;
  final Map<T, String> items;
  final ValueChanged<T> onChanged;

  @override
  Widget build(BuildContext context) {
    final safe = items.containsKey(value) ? value : items.keys.first;
    return Container(
      decoration: BoxDecoration(
        color: AppColors.well,
        borderRadius: BorderRadius.circular(AppColors.radiusChip),
        border: Border.all(color: AppColors.line),
      ),
      padding: const EdgeInsets.symmetric(horizontal: 10),
      child: DropdownButton<T>(
        key: pickerKey,
        value: safe,
        isDense: true,
        isExpanded: true,
        underline: const SizedBox.shrink(),
        icon: const Icon(
          Icons.expand_more_rounded,
          size: 18,
          color: AppColors.faint,
        ),
        style: const TextStyle(color: AppColors.text, fontSize: 12),
        dropdownColor: AppColors.panel,
        items: [
          for (final entry in items.entries)
            DropdownMenuItem<T>(
              value: entry.key,
              child: Text(
                entry.value,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(color: AppColors.text, fontSize: 12),
              ),
            ),
        ],
        onChanged: (next) {
          if (next != null) onChanged(next);
        },
      ),
    );
  }
}

/// 目录行：名字 + 路径，右边是「几个没做完 / 几个在跑」。有任务在跑的目录带一
/// 个点 —— Web 那边是整行转彩虹圈，App 沿用目录库里那颗绿点的做法：一个标记
/// 在两处长得一样，比两处各发明一个更不容易读错。
class _DirectoryRow extends StatelessWidget {
  const _DirectoryRow({
    required this.directory,
    required this.tasks,
    required this.running,
    required this.onTap,
  });

  final AirDirectory directory;
  final List<AirTask> tasks;
  final bool running;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final unfinished = tasks.where((task) => !task.closed).length;
    final executing = tasks.where(airTaskRunning).length;
    return Material(
      color: Colors.transparent,
      child: InkWell(
        key: ValueKey('air-console-dir-${directory.id}'),
        onTap: onTap,
        borderRadius: BorderRadius.circular(AppColors.radiusChip),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(2, 9, 2, 9),
          child: Row(
            children: [
              if (running)
                Container(
                  width: 7,
                  height: 7,
                  margin: const EdgeInsets.only(right: 6),
                  decoration: const BoxDecoration(
                    color: AppColors.success,
                    shape: BoxShape.circle,
                  ),
                ),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      directory.name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        color: AppColors.text,
                        fontSize: 13.5,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    Text(
                      directory.path,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        color: AppColors.faint,
                        fontSize: 10.5,
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 8),
              Column(
                crossAxisAlignment: CrossAxisAlignment.end,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    '$unfinished 进行中',
                    style: const TextStyle(
                      color: AppColors.text,
                      fontSize: 11.5,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  Text(
                    executing > 0 ? '$executing 执行中' : '${tasks.length} 个任务',
                    style: TextStyle(
                      color: executing > 0
                          ? AppColors.success
                          : AppColors.faint,
                      fontSize: 10.5,
                    ),
                  ),
                ],
              ),
              const Icon(
                Icons.chevron_right_rounded,
                size: 16,
                color: AppColors.faint,
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _ToolGrid extends StatelessWidget {
  const _ToolGrid({
    required this.onOpenDocs,
    required this.onOpenMemory,
    required this.onOpenSettings,
    required this.onOpenSchedules,
  });

  final VoidCallback onOpenDocs;
  final VoidCallback onOpenMemory;
  final VoidCallback onOpenSettings;
  final VoidCallback onOpenSchedules;

  @override
  Widget build(BuildContext context) {
    final tools = <(String, IconData, String, String, VoidCallback)>[
      ('docs', Icons.travel_explore_outlined, '服务与文档', '本地服务、网页和文件', onOpenDocs),
      ('memory', Icons.hub_outlined, '记忆图谱', '项目与会话记忆', onOpenMemory),
      ('settings', Icons.settings_outlined, '设置中心', 'Provider、通知与连接', onOpenSettings),
      ('schedules', Icons.schedule_rounded, '自动运行', '固定任务定时规则', onOpenSchedules),
    ];
    return Column(
      children: [
        for (var i = 0; i < tools.length; i += 2)
          Padding(
            padding: EdgeInsets.only(bottom: i + 2 < tools.length ? 8 : 0),
            child: Row(
              children: [
                for (var j = i; j < i + 2 && j < tools.length; j++) ...[
                  if (j > i) const SizedBox(width: 8),
                  Expanded(
                    child: _ToolCard(
                      id: tools[j].$1,
                      icon: tools[j].$2,
                      title: tools[j].$3,
                      detail: tools[j].$4,
                      onTap: tools[j].$5,
                    ),
                  ),
                ],
              ],
            ),
          ),
      ],
    );
  }
}

class _ToolCard extends StatelessWidget {
  const _ToolCard({
    required this.id,
    required this.icon,
    required this.title,
    required this.detail,
    required this.onTap,
  });

  final String id;
  final IconData icon;
  final String title;
  final String detail;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: AppColors.bgSoft,
      borderRadius: BorderRadius.circular(AppColors.radiusCard),
      child: InkWell(
        key: ValueKey('air-console-tool-$id'),
        onTap: onTap,
        borderRadius: BorderRadius.circular(AppColors.radiusCard),
        child: Container(
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(AppColors.radiusCard),
            border: Border.all(color: AppColors.line),
          ),
          padding: const EdgeInsets.fromLTRB(12, 11, 12, 12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(icon, size: 17, color: AppColors.accent),
              const SizedBox(height: 7),
              Text(
                title,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(
                  color: AppColors.text,
                  fontSize: 13,
                  fontWeight: FontWeight.w600,
                ),
              ),
              const SizedBox(height: 2),
              Text(
                detail,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(color: AppColors.faint, fontSize: 10.5),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
