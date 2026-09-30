import 'dart:async';

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

import '../../i18n.dart';
import '../../models/message.dart';
import '../../services/air_service.dart';
import '../../services/manage_service.dart';
import '../../services/settings_service.dart';
import '../../theme.dart';
import '../../utils/status_presentation.dart';
import '../workspace_navigation_drawer.dart';
import 'air_attention_screen.dart';
import 'air_directory_search.dart';
import 'air_panels.dart';
import 'air_task_status.dart';
import 'air_task_actions.dart';

/// 控制台：跨所有工作目录看「现在有什么在跑、有什么在等我」。
///
/// 对应 Web `public/air-admin.js` 的 `renderOverview`。Web 那边它是主区域里的
/// 一页正文（跟目录首页、定时任务同级），App 这边也一样 —— 它是 Air 首页主区
/// 里的一页（`_AirMode.console`），不再是自己 push 的一条路由。所以这里没有
/// Scaffold：页头那条 AppBar（含左上角的 ☰）是宿主的，这一块只是它的正文。
///
/// 数据只来自两个地方：`/api/air` 那一份快照（任务 + 目录）和 `/api/cron`
/// （定时任务）。控制台不新开一套统计口径，也不自己算「在不在跑」。
class AirConsoleBody extends StatefulWidget {
  const AirConsoleBody({
    super.key,
    required this.settings,
    required this.onOpenTask,
    required this.onOpenLibrary,
    required this.onSelectDirectory,
    required this.onOpenDestination,
    required this.onOpenMemory,
    required this.onOpenTaskgraph,
    this.onOpenAiAssistant,
    this.onOpenSchedules,
    this.httpClient,
  });

  final SettingsService settings;
  final http.Client? httpClient;

  /// 点开一条任务。控制台是跨目录的，所以这一跳带着任务自己的目录走，不看
  /// 当前选的是哪个目录。
  final ValueChanged<AirTask> onOpenTask;

  /// 目录库（「工作目录」那一栏右上角那句、以及小字行里那条都走这里）。
  final VoidCallback onOpenLibrary;

  /// 从「工作目录」那一栏切到某个目录（回到任务主区）。
  final ValueChanged<String> onSelectDirectory;

  /// 服务与设置那四张卡：服务与文档 / 设置中心走老抽屉里的原生目的地。
  final ValueChanged<WorkspaceDestination> onOpenDestination;

  /// 「自动运行」卡和「定时任务」统计卡都去定时任务中心。宿主自己会 push 那一
  /// 页，所以这里给的是一个不带目的地的回调；宿主没接就退回老抽屉。
  final VoidCallback? onOpenSchedules;

  /// 记忆图谱在 App 里仍是网页那一页（原生版还没做），单独给一个回调。
  final VoidCallback onOpenMemory;

  /// 「任务图谱」卡（Web 工具格的第 3 格）。App 有原生页，宿主自己 push。
  final VoidCallback onOpenTaskgraph;

  /// AI Assistant 是控制台的一级入口，不再要求先进入设置中心再找一层卡片。
  final VoidCallback? onOpenAiAssistant;

  @override
  State<AirConsoleBody> createState() => _AirConsoleBodyState();
}

/// 控制台是给人看的，不是导出用的：超过这个数就只显示最近的一批，并把总数
/// 说清楚（同 Web `TASK_LIST_LIMIT`）。
const int _taskListLimit = 60;

/// 顶上那五个过滤格（同 Web `air-admin.js` 的 `tiles`）：进行中 / 等我回复 /
/// 异常 / 今日完成 / 全部。点一格，统计带和工作目录之间就展开那一格的清单；再点
/// 同一格收起。默认什么都不展开 —— 控制台第一眼是数字，不是一堵清单墙。
enum _ConsoleTile { running, waiting, error, today, all }

/// 一格的三个词：叫什么、空的时候写什么、以及它自己的 id（`name` 正好就是 Web 那边
/// 的 `data-view`，所以两边同一格的清单用的是同一个键）。
extension on _ConsoleTile {
  String get labelKey => switch (this) {
    _ConsoleTile.running => 'airAdminTileRunning',
    _ConsoleTile.waiting => 'airAdminTileWaiting',
    _ConsoleTile.error => 'airAdminTileError',
    _ConsoleTile.today => 'airAdminTileToday',
    _ConsoleTile.all => 'airAdminTileAll',
  };

  String get emptyKey => switch (this) {
    _ConsoleTile.running => 'airAdminNoRunningTasks',
    _ConsoleTile.waiting => 'airAdminNoAttentionTasks',
    _ConsoleTile.error => 'airAdminNoErrorTasks',
    _ConsoleTile.today => 'airAdminNoDoneToday',
    _ConsoleTile.all => 'airAdminNoMatchingTasks',
  };
}

/// 「今日完成」：这一轮跑成功（succeeded）或生命周期 done、且最后一次更新落在
/// 今天本地零点之后。任务没有单独的完成时间戳，[AirTask.updatedAt] 就是它结束的
/// 那一刻。（同 Web `air-admin.js` 的 `doneToday`。）
bool _doneToday(AirTask task, [DateTime? now]) {
  if (airTaskStatus(task) != CanonicalStatus.succeeded &&
      task.status != 'done') {
    return false;
  }
  final at = now ?? DateTime.now();
  final midnight = DateTime(at.year, at.month, at.day);
  return task.updatedAt >= midnight.millisecondsSinceEpoch;
}

class _AirConsoleBodyState extends State<AirConsoleBody> {
  late final AirService _service = AirService(
    settings: widget.settings,
    httpClient: widget.httpClient,
  );
  final _searchController = TextEditingController();

  /// 全文检索（同 Web 控制台挂的 `MultiCCTaskSearch`）。本地按标题筛是即时反馈，
  /// 也是服务端结果拿不到时的退路：断网、老服务没有这条路由、接口报错，都只表现
  /// 为「和以前一样按标题筛」，面板从不因为一次请求没回来而空掉。
  ///
  /// `crossDirectory` —— 控制台是跨目录的一页，检索也跨全部目录（Web 那边同一处
  /// 不传 dirId，走的就是同一条路）。
  late final AirDirectorySearch _search = AirDirectorySearch(
    _service,
    crossDirectory: true,
  );
  AirSnapshot? _data;
  List<CronTask>? _schedules;
  String _error = '';
  bool _loading = false, _cronFailed = false;
  String _query = '';
  // 状态档就是目录首页用的那一份枚举（`AirDirectoryTaskFilter`）：两处说「进行中
  // 与待处理」时必须是同一批任务 —— 控制台曾经自己写了三个值的 `_ConsoleStatus`，
  // 两个地方各判一遍，迟早分叉。
  AirDirectoryTaskFilter _status = AirDirectoryTaskFilter.open;
  String _dir = 'all';

  /// 顶上展开的是哪一格。null = 都收起（第一眼只看数字，同 Web）。
  _ConsoleTile? _tile;

  /// 搜索连不连对话正文一起搜（同 Web `consoleFilter.fullText`）。
  bool _fullText = true;

  @override
  void initState() {
    super.initState();
    _search.addListener(_onSearchChanged);
    _load();
  }

  @override
  void dispose() {
    _searchController.dispose();
    _search.dispose();
    _service.close();
    super.dispose();
  }

  /// 检索结果（含「回到本地筛选」）都是重画这一次列表的理由。
  void _onSearchChanged() {
    if (mounted) setState(() {});
  }

  /// 搜索框的每一跳都同时喂两条路：本地标题筛选立刻重画，全文结果到了再按相关度
  /// 覆盖一次。口径照 Web 的 `MultiCCTaskSearch.attach`。
  void _onQueryChanged(String value) {
    setState(() => _query = value);
    _search.search(value, null, _fullText);
  }

  /// 换了搜索范围要重新问一次服务端（两条语料的召回不同），不能只重画。
  void _onScopeChanged(bool value) {
    setState(() => _fullText = value);
    _search.search(_query, null, value);
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

  Future<void> _deleteTask(AirTask task) async {
    final deleted = await deleteAirTaskWithConfirmation(
      context: context,
      service: _service,
      taskId: task.id,
      title: task.title,
      keyPrefix: 'air-console-${task.id}',
    );
    if (deleted && mounted) await _load();
  }

  /// 「全部」那一格的清单。控制台是跨目录的，这里不按当前目录收窄 —— 目录是
  /// 执行上下文，不是「能不能看见这条任务」的前提。
  ///
  /// 有搜索词时状态那格换成「全部记录」（同 Web 的 `searchFilter()`）：默认只看在办
  /// 会把已归档任务的命中静默滤掉（服务端有结果、列表显示 0 条），而那正是「明明
  /// 搜得到却搜不到」的来源。目录那格照旧参与，它本来就是搜索范围的一部分。
  List<AirTask> get _filteredTasks {
    final needle = _query.trim().toLowerCase();
    final querying = needle.isNotEmpty;
    final status = querying ? AirDirectoryTaskFilter.all : _status;
    final rows = _tasks
        .where(status.matches)
        .where((task) => _dir == 'all' || task.dirId == _dir)
        .toList();
    if (!querying) {
      return rows..sort((a, b) => b.updatedAt.compareTo(a.updatedAt));
    }
    // 有全文结果就按相关度排（标题没命中、正文命中的任务因此能被找到）；没有
    // （还没回来 / 报错）就退回按标题筛，列表从不空着。命中池里找不到的 id
    // （任务刚被删掉）直接跳过，不编造行。
    final ids = _search.ids;
    if (ids != null && ids.isNotEmpty) {
      final rank = {for (var i = 0; i < ids.length; i++) ids[i]: i};
      final ranked = rows.where((task) => rank.containsKey(task.id)).toList()
        ..sort((a, b) => rank[a.id]!.compareTo(rank[b.id]!));
      if (ranked.isNotEmpty) return ranked;
    }
    return rows
        .where(
          (task) => '${task.title} ${_directoryName(task.dirId)}'
              .toLowerCase()
              .contains(needle),
        )
        .toList()
      ..sort((a, b) => b.updatedAt.compareTo(a.updatedAt));
  }

  @override
  Widget build(BuildContext context) {
    final data = _data;
    final tasks = _tasks;
    // 五个数字的口径照搬 Web `renderOverview`。`active` 是**生命周期**（未完成、
    // 未归档），不是 `!task.closed` —— 后者把 `workflowStage == 'done'` 也算关掉，
    // 而目录首页的「进行中与待处理」走的正是这条生命周期线
    // （`AirDirectoryTaskFilter.open`）。控制台跟它必须数出同一批任务。
    final active = tasks.where(AirDirectoryTaskFilter.open.matches).toList();
    final executing = tasks.where(airTaskRunning).toList()
      ..sort((a, b) => b.updatedAt.compareTo(a.updatedAt));
    // 「等我回复」和「异常」拆成两格：前者是要我回答 / 卡在资源上的，后者是跑出错
    // 的。两格合起来仍是 urgent —— 侧栏那个徽标数的是这个总数（同 Web）。
    final urgent = airUrgentTasks(tasks);
    final failed = urgent.where((task) => airTaskUrgency(task) == 1).toList();
    final waitingMe = urgent
        .where((task) => airTaskUrgency(task) != 1)
        .toList();
    final finished = tasks.where((task) => _doneToday(task)).toList()
      ..sort((a, b) => b.updatedAt.compareTo(a.updatedAt));
    final running = airRunningDirectories(tasks);
    final enabledSchedules = (_schedules ?? const <CronTask>[])
        .where((task) => task.enabled)
        .length;
    final rows = _filteredTasks;
    final shown = rows.take(_taskListLimit).toList();

    return RefreshIndicator(
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
                style: const TextStyle(color: AppColors.danger, fontSize: 12.5),
              ),
            ),
          if (data == null && _error.isEmpty)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 60),
              child: Center(child: CircularProgressIndicator()),
            )
          else ...[
            _Tiles(
              running: executing.length,
              runningDirectories: running.length,
              waiting: waitingMe.length,
              failed: failed.length,
              today: finished.length,
              all: active.length,
              total: tasks.length,
              selected: _tile,
              onSelect: (tile) =>
                  setState(() => _tile = _tile == tile ? null : tile),
            ),
            const SizedBox(height: 8),
            _MetaLine(
              directories: data?.directories.length ?? 0,
              enabledSchedules: enabledSchedules,
              totalSchedules: _schedules?.length,
              schedulesFailed: _cronFailed,
              onOpenLibrary: widget.onOpenLibrary,
              onOpenSchedules: _openSchedules,
            ),
            if (_tile != null) ...[
              const SizedBox(height: 10),
              _TileDrawer(
                tile: _tile!,
                executing: executing,
                waitingMe: waitingMe,
                failed: failed,
                finished: finished,
                rows: rows,
                shown: shown,
                searchController: _searchController,
                status: _status,
                dir: _dir,
                fullText: _fullText,
                directories: data?.directories ?? const [],
                directoryName: _directoryName,
                onQuery: _onQueryChanged,
                onStatus: (value) => setState(() => _status = value),
                onScope: _onScopeChanged,
                onDir: (value) => setState(() => _dir = value),
                onOpenTask: widget.onOpenTask,
                onDeleteTask: _deleteTask,
                unread: urgent.length,
                onOpenAttention: () => _openAttention(urgent),
                onClose: () => setState(() => _tile = null),
              ),
            ],
            const SizedBox(height: 15),
            // 控制台要回答的是两件「一眼扫完」的事：谁在等我，以及我有哪些目录。
            // 顺序照 Web `renderOverview`：统计带 → 小字 → 展开的清单 → 工作目录 →
            // AI Assistant → 工具格。
            _Panel(
              eyebrow: 'WORK DIRECTORIES',
              title: t('airAdminWorkDirectories'),
              action: _LinkButton(
                id: 'air-console-library',
                label: t('airAdminDirectoryLibrary'),
                onTap: widget.onOpenLibrary,
              ),
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
                    _Empty(t('airAdminNoDirectories')),
                ],
              ),
            ),
            const SizedBox(height: 15),
            _AssistantCard(
              onTap:
                  widget.onOpenAiAssistant ??
                  () => widget.onOpenDestination(WorkspaceDestination.global),
            ),
            const SizedBox(height: 15),
            _Panel(
              eyebrow: 'SYSTEM TOOLS',
              title: t('airAdminServicesAndSettings'),
              child: _ToolGrid(
                onOpenDocs: () =>
                    widget.onOpenDestination(WorkspaceDestination.docs),
                onOpenMemory: widget.onOpenMemory,
                onOpenTaskgraph: widget.onOpenTaskgraph,
                onOpenSettings: () =>
                    widget.onOpenDestination(WorkspaceDestination.global),
                onOpenSchedules: _openSchedules,
              ),
            ),
          ],
        ],
      ),
    );
  }

  /// 「谁在等我」的整页。清单已经在手上 —— 就是控制台那一格用的同一份，所以这一跳
  /// 只是把它铺开，不再去拉一次接口：两边因此不可能显示出不同的条数或顺序。
  ///
  /// 点走一条任务时先把自己收掉：宿主的 onOpenTask 会再收掉控制台，两层叠着的时候
  /// 它 pop 的是最上面那层，不先收自己就会把控制台留在屏幕上。
  void _openAttention(List<AirTask> urgent) {
    unawaited(
      Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => AirAttentionScreen(
            tasks: urgent,
            directoryName: _directoryName,
            onOpenTask: (task) {
              Navigator.of(context).pop();
              widget.onOpenTask(task);
            },
          ),
        ),
      ),
    );
  }

  /// 定时任务中心的入口有两处（「自动运行」工具卡和「定时任务」统计卡），
  /// 但它们去同一个地方 —— 宿主给了原生回调就走原生页，没给才退回老抽屉。
  void _openSchedules() {
    final handler = widget.onOpenSchedules;
    if (handler != null) {
      handler();
      return;
    }
    widget.onOpenDestination(WorkspaceDestination.cron);
  }
}

class _AssistantCard extends StatelessWidget {
  const _AssistantCard({required this.onTap});

  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Colors.transparent,
      borderRadius: BorderRadius.circular(AppColors.radiusPanel),
      child: InkWell(
        key: const ValueKey('air-console-ai-assistant'),
        onTap: onTap,
        borderRadius: BorderRadius.circular(AppColors.radiusPanel),
        child: Ink(
          decoration: BoxDecoration(
            gradient: const LinearGradient(
              colors: [Color(0xFFF0F7FF), Color(0xFFFAF7FF)],
            ),
            borderRadius: BorderRadius.circular(AppColors.radiusPanel),
            border: Border.all(color: const Color(0xFFCFE1F4)),
          ),
          padding: const EdgeInsets.all(13),
          child: Row(
            children: [
              Container(
                width: 42,
                height: 42,
                decoration: BoxDecoration(
                  gradient: const LinearGradient(
                    begin: Alignment.topLeft,
                    end: Alignment.bottomRight,
                    colors: [Color(0xFF3794EE), Color(0xFF755EC9)],
                  ),
                  borderRadius: BorderRadius.circular(13),
                ),
                child: const Icon(
                  Icons.auto_awesome_rounded,
                  color: Colors.white,
                  size: 21,
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text(
                      'AI ASSISTANT',
                      style: TextStyle(
                        color: AppColors.faint,
                        fontSize: 9.5,
                        fontWeight: FontWeight.w700,
                        letterSpacing: 1.1,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      t('airAdminAssistantTagline'),
                      style: const TextStyle(
                        color: AppColors.text,
                        fontSize: 14,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      t('airAdminAssistantDesc'),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        color: AppColors.muted,
                        fontSize: 10.5,
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 8),
              const Icon(Icons.chevron_right_rounded, color: AppColors.accent),
            ],
          ),
        ),
      ),
    );
  }
}

/// 顶上那五格（同 Web 控制台的 `tiles`）：进行中 / 等我回复 / 异常 / 今日完成 /
/// 全部。点一格，统计带和工作目录之间就展开那一格的清单；再点同一格收起。默认什么
/// 都不展开 —— 控制台第一眼是数字，不是一堵清单墙。
///
/// 统计是一条「读数带」，不是控制台的主体：数字用来确认系统活着，真正要看的是下面的
/// 任务。所以它压扁了（数字 24→19px、色条 26×3→18×2），省下来的高度全给那份清单
/// —— 同 Web `.admin-stat` 的那次收紧。
///
/// Web 是一行五张；手机上一行放不下，这里两列多行，格子的顺序不变（最后一格独占一
/// 行）。目录数和定时任务数是背景信息、不是要处理的东西，所以不在这条读数带上，降
/// 成下面那行小字（同 Web 把它们放进 `console-overview-meta`）。
class _Tiles extends StatelessWidget {
  const _Tiles({
    required this.running,
    required this.runningDirectories,
    required this.waiting,
    required this.failed,
    required this.today,
    required this.all,
    required this.total,
    required this.selected,
    required this.onSelect,
  });

  final int running;
  final int runningDirectories;
  final int waiting;
  final int failed;
  final int today;
  final int all;

  /// 全部记录的总条数。它只出现在「全部」那一格的小字里 —— 那一格的数字是**未归档**
  /// 的条数（生命周期口径），两个数说的不是一件事，所以都得写出来。
  final int total;
  final _ConsoleTile? selected;
  final ValueChanged<_ConsoleTile> onSelect;

  @override
  Widget build(BuildContext context) {
    final tiles = <(_ConsoleTile, int, String, Color?)>[
      (
        _ConsoleTile.running,
        running,
        runningDirectories > 0
            ? t('airAdminDirectoriesRunning', {'n': '$runningDirectories'})
            : t('airAdminTileRunningIdle'),
        AppColors.success,
      ),
      (
        _ConsoleTile.waiting,
        waiting,
        waiting > 0
            ? t('airAdminTileWaitingDetail')
            : t('airAdminNothingPending'),
        waiting > 0 ? AppColors.amber : null,
      ),
      (
        _ConsoleTile.error,
        failed,
        failed > 0 ? t('airAdminTileErrorDetail') : t('airAdminTileErrorNone'),
        failed > 0 ? AppColors.danger : null,
      ),
      (
        _ConsoleTile.today,
        today,
        t('airAdminTileTodayDetail'),
        AppColors.accent,
      ),
      (
        _ConsoleTile.all,
        all,
        t('airAdminTileAllDetail', {'n': '$total'}),
        AppColors.opencode,
      ),
    ];
    return Column(
      children: [
        for (var i = 0; i < tiles.length; i += 2)
          Padding(
            padding: EdgeInsets.only(bottom: i + 2 < tiles.length ? 10 : 0),
            child: IntrinsicHeight(
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  for (var j = i; j < i + 2 && j < tiles.length; j++) ...[
                    if (j > i) const SizedBox(width: 10),
                    Expanded(
                      child: _TileCard(
                        id: tiles[j].$1.name,
                        label: t(tiles[j].$1.labelKey),
                        value: tiles[j].$2,
                        detail: tiles[j].$3,
                        tone: tiles[j].$4,
                        selected: selected == tiles[j].$1,
                        onTap: () => onSelect(tiles[j].$1),
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ),
      ],
    );
  }
}

/// 统计带下面那行小字：几个工作目录、几条定时任务启用。这两项是背景信息，所以不给
/// 大数字；但每一句仍然是一个入口（同 Web 的 `console-overview-meta`）。
class _MetaLine extends StatelessWidget {
  const _MetaLine({
    required this.directories,
    required this.enabledSchedules,
    required this.totalSchedules,
    required this.schedulesFailed,
    required this.onOpenLibrary,
    required this.onOpenSchedules,
  });

  final int directories;
  final int enabledSchedules;

  /// null 表示还没读到（定时任务和任务快照是两份数据，各自会失败）。
  final int? totalSchedules;
  final bool schedulesFailed;
  final VoidCallback onOpenLibrary;
  final VoidCallback onOpenSchedules;

  @override
  Widget build(BuildContext context) {
    final total = totalSchedules;
    // 读不到时说「读不到」，不拿 0 去充数：0 条启用和「不知道有几条」是两件事，
    // 后者写成前者会让人以为定时任务被清空了。
    final scheduleText = schedulesFailed
        ? t('airScheduleLoadFailed', {'msg': t('airAdminRefreshPageRetry')})
        : total == null
        ? '${t('airAdminScheduledTasks')} · ${t('airAdminLoading')}'
        : t('airAdminMetaSchedules', {
            'n': '$enabledSchedules',
            'total': '$total',
          });
    return Wrap(
      spacing: 6,
      runSpacing: 2,
      crossAxisAlignment: WrapCrossAlignment.center,
      children: [
        _LinkButton(
          id: 'air-console-meta-directories',
          label: t('airAdminMetaDirectories', {'n': '$directories'}),
          onTap: onOpenLibrary,
        ),
        const Text('·', style: TextStyle(color: AppColors.faint, fontSize: 11)),
        _LinkButton(
          id: 'air-console-meta-schedules',
          label: scheduleText,
          onTap: onOpenSchedules,
        ),
      ],
    );
  }
}

/// 五格共用的展开区（同 Web 的 `console-filter-panel`）：换格只换标题和清单，位置
/// 就在读数带正下方 —— 点哪格就在哪里长出来，不用滚到底去找。
///
/// 「全部」多一排搜索与筛选，其余四格没有：那四格的清单口径就是上面那几格数字用的
/// 同一份数组，数字和清单不会分叉；「全部」才是需要人自己收窄的那一份。
class _TileDrawer extends StatelessWidget {
  const _TileDrawer({
    required this.tile,
    required this.executing,
    required this.waitingMe,
    required this.failed,
    required this.finished,
    required this.rows,
    required this.shown,
    required this.searchController,
    required this.status,
    required this.dir,
    required this.fullText,
    required this.directories,
    required this.directoryName,
    required this.onQuery,
    required this.onStatus,
    required this.onScope,
    required this.onDir,
    required this.onOpenTask,
    required this.onDeleteTask,
    required this.unread,
    required this.onOpenAttention,
    required this.onClose,
  });

  final _ConsoleTile tile;
  final List<AirTask> executing;
  final List<AirTask> waitingMe;
  final List<AirTask> failed;
  final List<AirTask> finished;

  /// 「全部」那一格筛完之后的清单；其余四格用不到。
  final List<AirTask> rows;
  final List<AirTask> shown;
  final TextEditingController searchController;
  final AirDirectoryTaskFilter status;
  final String dir;
  final bool fullText;
  final List<AirDirectory> directories;
  final String Function(String) directoryName;
  final ValueChanged<String> onQuery;
  final ValueChanged<AirDirectoryTaskFilter> onStatus;
  final ValueChanged<bool> onScope;
  final ValueChanged<String> onDir;
  final ValueChanged<AirTask> onOpenTask;
  final ValueChanged<AirTask> onDeleteTask;

  /// 跨目录待处理的总数。「等我回复」那一格后面挂的整页出口用它。
  final int unread;
  final VoidCallback onOpenAttention;
  final VoidCallback onClose;

  List<AirTask> get _list => switch (tile) {
    _ConsoleTile.running => executing,
    _ConsoleTile.waiting => waitingMe,
    _ConsoleTile.error => failed,
    _ConsoleTile.today => finished,
    _ConsoleTile.all => rows,
  };

  @override
  Widget build(BuildContext context) {
    final list = _list;
    final visible = tile == _ConsoleTile.all
        ? shown
        : list.take(_taskListLimit).toList();
    final total = list.length;
    return _Panel(
      eyebrow: 'ACROSS ALL WORKSPACES',
      title: t(tile.labelKey),
      note: total > visible.length
          ? t('airAdminTaskCountLimited', {
              'total': '$total',
              'shown': '${visible.length}',
            })
          : t('airAdminNItems', {'n': '$total'}),
      action: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (tile == _ConsoleTile.waiting && unread > 0)
            _LinkButton(
              id: 'air-console-attention-all',
              label: t('airAdminViewAllCount', {'n': '$unread'}),
              onTap: onOpenAttention,
            ),
          _LinkButton(
            id: 'air-console-collapse',
            label: t('airAdminCollapse'),
            onTap: onClose,
          ),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (tile == _ConsoleTile.all) ...[
            _controls(context),
            const SizedBox(height: 10),
          ],
          for (var i = 0; i < visible.length; i++) ...[
            if (i > 0) const SizedBox(height: 8),
            AirTaskTile(
              key: ValueKey('air-console-task-${visible[i].id}'),
              task: visible[i],
              directoryName: directoryName(visible[i].dirId),
              showTime: true,
              onTap: () => onOpenTask(visible[i]),
              // 删除只在「全部」那格里给：其余四格都是「现在有事」的清单，在这里
              // 删掉一条，读的人多半还没看清它是什么。
              trailing: tile == _ConsoleTile.all
                  ? AirTaskRowAction(
                      key: ValueKey('air-console-delete-${visible[i].id}'),
                      tooltip: t('airDeleteTaskAria', {
                        'title': visible[i].title,
                      }),
                      icon: const Icon(Icons.delete_outline_rounded),
                      onPressed: () => onDeleteTask(visible[i]),
                    )
                  : null,
            ),
          ],
          if (visible.isEmpty) _Empty(t(tile.emptyKey)),
        ],
      ),
    );
  }

  /// 「全部」那一格的筛选行（同 Web `#console-task-controls`）：搜索 + 状态 +
  /// 搜索范围 + 目录。
  ///
  /// 搜索范围摆在搜索框**上面**：它是这一格的语义开关（搜不搜对话正文），先定范围
  /// 再打字，比打完字再发现「原来只搜了标题」少一次返工。
  Widget _controls(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _Picker<bool>(
          pickerKey: const ValueKey('air-console-scope'),
          value: fullText,
          items: {
            true: t('airSearchScopeFull'),
            false: t('airSearchScopeBoard'),
          },
          onChanged: onScope,
        ),
        const SizedBox(height: 8),
        TextField(
          key: const ValueKey('air-console-search'),
          controller: searchController,
          onChanged: onQuery,
          textInputAction: TextInputAction.search,
          style: const TextStyle(color: AppColors.text, fontSize: 12.5),
          decoration: sheetInputDecoration(
            hint: t('airAdminSearchPlaceholder'),
          ),
        ),
        const SizedBox(height: 8),
        Row(
          children: [
            Expanded(
              child: _Picker<AirDirectoryTaskFilter>(
                pickerKey: const ValueKey('air-console-status'),
                value: status,
                // 控制台只摆 Web 那三档（进行中与待处理 / 全部记录 / 已归档）。
                // 目录首页那七档里的「运行中 / 等待回复 / 异常 / 执行成功」在这里是
                // 上面那几格数字，用点选代替下拉 —— 同一件事不给两条路。
                items: {
                  AirDirectoryTaskFilter.open: t('airAdminFilterOpen'),
                  AirDirectoryTaskFilter.all: t('airAdminFilterAll'),
                  AirDirectoryTaskFilter.archived: t('airAdminStatusArchived'),
                },
                onChanged: onStatus,
              ),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: _Picker<String>(
                pickerKey: const ValueKey('air-console-dir'),
                value: dir,
                items: {
                  'all': t('airAdminAllDirectories'),
                  for (final directory in directories)
                    directory.id: directory.name,
                },
                onChanged: onDir,
              ),
            ),
          ],
        ),
      ],
    );
  }
}

/// 一格统计。数字是读数，小字说的是这个数字数的是什么 —— 后者才是「点开能看见哪些
/// 任务」的说明，所以它给足两行（同一行里两张卡因此对齐），不截成半句话。
///
/// 选中态落在边框和底色上：五格里哪一格展开着，得一眼看得出来。
class _TileCard extends StatelessWidget {
  const _TileCard({
    required this.id,
    required this.label,
    required this.value,
    required this.detail,
    required this.selected,
    required this.onTap,
    this.tone,
  });

  final String id;
  final String label;
  final int value;
  final String detail;
  final bool selected;
  final VoidCallback onTap;
  final Color? tone;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: selected ? AppColors.well : AppColors.panel,
      borderRadius: BorderRadius.circular(AppColors.radiusCard),
      child: InkWell(
        key: ValueKey('air-console-tile-$id'),
        onTap: onTap,
        borderRadius: BorderRadius.circular(AppColors.radiusCard),
        child: Container(
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(AppColors.radiusCard),
            border: Border.all(
              color: selected ? AppColors.accent : AppColors.line,
            ),
          ),
          padding: const EdgeInsets.fromLTRB(11, 8, 11, 9),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Container(
                width: 18,
                height: 2,
                margin: const EdgeInsets.only(bottom: 5),
                decoration: BoxDecoration(
                  color: tone ?? AppColors.lineStrong,
                  borderRadius: BorderRadius.circular(AppColors.radiusPill),
                ),
              ),
              Text(
                label,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(color: AppColors.muted, fontSize: 10),
              ),
              const SizedBox(height: 2),
              Text(
                '$value',
                style: const TextStyle(
                  color: AppColors.text,
                  fontSize: 19,
                  height: 1,
                  fontWeight: FontWeight.w700,
                ),
              ),
              const SizedBox(height: 3),
              Text(
                detail,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(color: AppColors.faint, fontSize: 10),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// 控制台里那些「一句话入口」：小字括号、展开区的收起、整页出口。它们共用一种样子
/// —— 同一页上三个不同长相的链接，读的人要先认形状再认字。
class _LinkButton extends StatelessWidget {
  const _LinkButton({
    required this.id,
    required this.label,
    required this.onTap,
  });

  final String id;
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => InkWell(
    key: ValueKey(id),
    onTap: onTap,
    borderRadius: BorderRadius.circular(AppColors.radiusChip),
    child: Padding(
      padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 3),
      child: Text(
        label,
        style: const TextStyle(
          color: AppColors.accent,
          fontSize: 11.5,
          fontWeight: FontWeight.w500,
        ),
      ),
    ),
  );
}

/// 一个分区：eyebrow + 标题 + 右上角一句注（可再挂一个出口）。
class _Panel extends StatelessWidget {
  const _Panel({
    required this.eyebrow,
    required this.title,
    required this.child,
    this.note,
    this.action,
  });

  final String eyebrow;
  final String title;

  /// 右上角那句说明。有 [action] 时它说的是「一共几条、这里显示了几条」。
  final String? note;

  /// 右上角的出口。没有地方可去时不传，按钮就不出现 —— 控制台里每个分区都常驻
  /// 一个点了没反应的按钮，比没有按钮更糟。
  final Widget? action;
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
              if (action != null)
                Padding(
                  padding: const EdgeInsets.only(left: 8, top: 4),
                  child: action!,
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
    // 口径跟控制台顶上那几格、以及 Web 的 `admin-directory-row` 是同一份：
    // 「进行中」是生命周期（未完成、未归档），不是 `!task.closed` —— 后者把
    // `workflowStage == 'done'` 也算关掉，一条刚跑完还没归档的任务会被这行漏掉。
    final unfinished = tasks
        .where(AirDirectoryTaskFilter.open.matches)
        .toList();
    final executing = unfinished.where(airTaskRunning).length;
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
                    t('airAdminNInProgress', {'n': '${unfinished.length}'}),
                    style: const TextStyle(
                      color: AppColors.text,
                      fontSize: 11.5,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  Text(
                    executing > 0
                        ? t('airAdminNExecuting', {'n': '$executing'})
                        : t('airAdminNTaskCount', {'n': '${tasks.length}'}),
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

/// 工具格。五格，顺序照 Web 的 `shortcuts`：服务与文档 / 记忆图谱 / 任务图谱 /
/// 设置中心 / 自动运行。
///
/// 保险箱不在这张格子里（同 Web 的注释）：它在控制台那一页的页头工具栏上，跟这一页
/// 的其它动作并列常驻，不用滚到工具格才找得到。
class _ToolGrid extends StatelessWidget {
  const _ToolGrid({
    required this.onOpenDocs,
    required this.onOpenMemory,
    required this.onOpenTaskgraph,
    required this.onOpenSettings,
    required this.onOpenSchedules,
  });

  final VoidCallback onOpenDocs;
  final VoidCallback onOpenMemory;
  final VoidCallback onOpenTaskgraph;
  final VoidCallback onOpenSettings;
  final VoidCallback onOpenSchedules;

  @override
  Widget build(BuildContext context) {
    final tools = <(String, IconData, String, String, VoidCallback)>[
      (
        'docs',
        Icons.travel_explore_outlined,
        t('airAdminPanelDocs'),
        t('airAdminPanelDocsDesc'),
        onOpenDocs,
      ),
      (
        'memory',
        Icons.hub_outlined,
        t('airAdminPanelMemory'),
        t('airAdminMemoryShortDesc'),
        onOpenMemory,
      ),
      (
        'taskgraph',
        Icons.account_tree_outlined,
        t('airAdminPanelTaskgraph'),
        t('airAdminTaskgraphShortDesc'),
        onOpenTaskgraph,
      ),
      (
        'settings',
        Icons.settings_outlined,
        t('airAdminSettingsCenter'),
        t('airAdminSettingsShortDesc'),
        onOpenSettings,
      ),
      (
        'schedules',
        Icons.schedule_rounded,
        t('airAdminAutoRun'),
        t('airAdminAutoRunDesc'),
        onOpenSchedules,
      ),
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
