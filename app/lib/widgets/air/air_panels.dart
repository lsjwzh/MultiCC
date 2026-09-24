import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;

import '../../services/air_service.dart';
import '../../services/attachment_picker.dart';
import '../../services/settings_service.dart';
import '../../theme.dart';
import '../marquee_text.dart';
import '../voice_input_button.dart';
import 'air_role_editor.dart';
import 'air_task_config.dart';
import 'air_task_status.dart';

/// 目录库（Web `#directory-library`）：一张目录一张卡，卡上写清它现在有多少
/// 任务、有没有人在跑。手机上一列，宽屏两列。
/// 目录卡片 ⋯ 菜单里的一件动作。本机目录与远端工作区各取所需 —— Web 那边同一
/// 张菜单也是按 `dir.external` 分岔的（`public/manage-dashboard.js:918-965`）。
enum AirDirectoryAction {
  /// 「↗ 分享工作区」——本机目录才有。
  share,

  /// 「重新导入以启用操作」——远端那条记录的授权已经不能用了，拿分享链接重来
  /// 一次。
  reimport,

  /// 「↻ 刷新远端状态」。
  refresh,

  /// 「移除共享工作区」——只从本机列表里摘掉，远端那份不动。
  remove,
}

class AirDirectoryLibrary extends StatefulWidget {
  const AirDirectoryLibrary({
    super.key,
    required this.directories,
    required this.currentDirectoryId,
    required this.tasksOf,
    required this.runningDirectories,
    required this.onOpen,
    required this.onAddDirectory,
    this.onAction,
    this.addButtonKey,
  });

  final List<AirDirectory> directories;
  final String? currentDirectoryId;
  final List<AirTask> Function(String dirId) tasksOf;

  /// 有任务正在执行的目录 id —— 卡片上那圈运行环用它。
  final Set<String> runningDirectories;
  final ValueChanged<String> onOpen;
  final VoidCallback onAddDirectory;

  /// 卡片 ⋯ 菜单选中了某一件。不给就不摆那颗 ⋯。
  final void Function(AirDirectory directory, AirDirectoryAction action)?
  onAction;

  /// 新手引导第 1 步要圈住的「添加」。套在外层而不是顶掉那颗按钮自己的
  /// `ValueKey` —— 那个键是既有测试和别处 finder 在用的。
  final Key? addButtonKey;

  @override
  State<AirDirectoryLibrary> createState() => _AirDirectoryLibraryState();
}

class _AirDirectoryLibraryState extends State<AirDirectoryLibrary> {
  String _query = '';

  @override
  Widget build(BuildContext context) {
    final query = _query.trim().toLowerCase();
    final rows = widget.directories
        .where(
          (d) => query.isEmpty
              ? true
              : '${d.name} ${d.path}'.toLowerCase().contains(query),
        )
        .toList();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 16, 20, 10),
          child: Row(
            children: [
              Expanded(
                child: TextField(
                  key: const ValueKey('air-directory-search'),
                  onChanged: (v) => setState(() => _query = v),
                  style: const TextStyle(color: AppColors.text),
                  decoration: InputDecoration(
                    hintText: '搜索名称或路径',
                    prefixIcon: const Icon(Icons.search, size: 19),
                    isDense: true,
                    filled: true,
                    fillColor: AppColors.panel,
                    contentPadding: const EdgeInsets.symmetric(vertical: 12),
                    border: OutlineInputBorder(
                      borderSide: BorderSide.none,
                      borderRadius: BorderRadius.circular(AppColors.radiusCard),
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 10),
              KeyedSubtree(
                key: widget.addButtonKey,
                child: FilledButton.icon(
                  key: const ValueKey('air-add-directory'),
                  onPressed: widget.onAddDirectory,
                  icon: const Icon(Icons.add_rounded, size: 18),
                  label: const Text('添加'),
                  style: FilledButton.styleFrom(
                    backgroundColor: AppColors.accentDark,
                    minimumSize: const Size(0, 46),
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(
                        AppColors.radiusButton,
                      ),
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
        Expanded(
          child: LayoutBuilder(
            builder: (context, constraints) {
              final columns = constraints.maxWidth >= 700 ? 2 : 1;
              if (rows.isEmpty) {
                return Center(
                  child: Text(
                    _query.isEmpty ? '还没有工作目录。' : '没有匹配的工作目录。',
                    style: const TextStyle(color: AppColors.faint),
                  ),
                );
              }
              return GridView.builder(
                padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
                gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(
                  crossAxisCount: columns,
                  mainAxisExtent: 92,
                  crossAxisSpacing: 12,
                  mainAxisSpacing: 12,
                ),
                itemCount: rows.length,
                itemBuilder: (context, index) => _DirectoryCard(
                  directory: rows[index],
                  tasks: widget.tasksOf(rows[index].id),
                  running: widget.runningDirectories.contains(rows[index].id),
                  current: rows[index].id == widget.currentDirectoryId,
                  onOpen: () => widget.onOpen(rows[index].id),
                  onAction: widget.onAction == null
                      ? null
                      : (action) => widget.onAction!(rows[index], action),
                ),
              );
            },
          ),
        ),
      ],
    );
  }
}

class _DirectoryCard extends StatelessWidget {
  const _DirectoryCard({
    required this.directory,
    required this.tasks,
    required this.running,
    required this.current,
    required this.onOpen,
    this.onAction,
  });

  final AirDirectory directory;
  final List<AirTask> tasks;
  final bool running;
  final bool current;
  final VoidCallback onOpen;
  final ValueChanged<AirDirectoryAction>? onAction;

  @override
  Widget build(BuildContext context) {
    final active = tasks.where((t) => !t.closed).length;
    return Material(
      color: AppColors.panel,
      borderRadius: BorderRadius.circular(AppColors.radiusCard),
      child: InkWell(
        key: ValueKey('air-directory-${directory.id}'),
        onTap: onOpen,
        borderRadius: BorderRadius.circular(AppColors.radiusCard),
        child: Container(
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(AppColors.radiusCard),
            border: Border.all(
              color: current ? AppColors.accent : AppColors.line,
              width: current ? 1.4 : 1,
            ),
          ),
          padding: const EdgeInsets.fromLTRB(14, 12, 6, 12),
          child: Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Row(
                      children: [
                        if (running) ...[
                          Container(
                            width: 7,
                            height: 7,
                            margin: const EdgeInsets.only(right: 6),
                            decoration: const BoxDecoration(
                              color: AppColors.success,
                              shape: BoxShape.circle,
                            ),
                          ),
                        ],
                        Flexible(
                          child: Text(
                            directory.name,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                              color: AppColors.text,
                              fontSize: 15,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 2),
                    Text(
                      directory.path,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        color: AppColors.faint,
                        fontSize: 11,
                      ),
                    ),
                    const SizedBox(height: 6),
                    Text(
                      // 远端工作区那行换掉「N 个任务 · M 个未完成」：它本机没有
                      // 任务记录，硬数成 0 会读成「这个工作区是空的」，而真相是
                      // 「它的任务在对面那台机器上」。授权不能用了也要说清楚 ——
                      // 那就是菜单里「重新导入以启用操作」出现的原因。
                      directory.external
                          ? '共享工作区'
                                '${directory.interactive ? '' : ' · 授权已失效'}'
                          : '${tasks.length} 个任务 · $active 个未完成'
                                ' · ${airWorktreeSummary(directory)}',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        color: AppColors.muted,
                        fontSize: 11.5,
                      ),
                    ),
                  ],
                ),
              ),
              if (onAction != null)
                PopupMenuButton<AirDirectoryAction>(
                  key: ValueKey('air-directory-menu-${directory.id}'),
                  icon: const Icon(
                    Icons.more_vert_rounded,
                    size: 18,
                    color: AppColors.faint,
                  ),
                  tooltip: '更多操作',
                  color: AppColors.panel,
                  onSelected: onAction,
                  itemBuilder: (context) => directory.external
                      ? [
                          if (!directory.interactive)
                            const PopupMenuItem(
                              value: AirDirectoryAction.reimport,
                              child: Text('重新导入以启用操作'),
                            ),
                          const PopupMenuItem(
                            value: AirDirectoryAction.refresh,
                            child: Text('↻ 刷新远端状态'),
                          ),
                          const PopupMenuItem(
                            value: AirDirectoryAction.remove,
                            child: Text('移除共享工作区'),
                          ),
                        ]
                      : const [
                          PopupMenuItem(
                            value: AirDirectoryAction.share,
                            child: Text('↗ 分享工作区'),
                          ),
                        ],
                ),
            ],
          ),
        ),
      ),
    );
  }
}

/// 任务行。徽标说的是「这个任务现在算什么」（生命周期 + 这一轮的 runState），
/// 副行说的是「它在哪个目录、走到哪一步、卡在哪」。
///
/// 形状和 Web Air 的两份任务行同一套：**标题独占一行（最多两行），徽标 + 副行 +
/// 时间在它下面一行**。徽标原来摆在最左边（当时照抄的是 `air-admin.js` 的
/// `taskRow`），可那是一行三列的老排法：390px 的手机上徽标加行尾那排操作一共
/// 吃掉一半宽度，标题只剩 90 来 px —— 一个中文任务名被折成两条还读不完，而标题
/// 恰恰是这一行里唯一必须读全的东西。现在标题拿整行，徽标挪到它描述的那一行旁边
/// （和 `air.js` 的 `directory-task-row` 一样），Web 那边同一处也照这个改了。
///
/// 侧栏、当前目录、控制台都用这一行。Web 那边同样只有一份 `taskRow`：行长得
/// 不一样的地方，状态就会各说各话。
class AirTaskTile extends StatelessWidget {
  const AirTaskTile({
    super.key,
    required this.task,
    required this.onTap,
    this.directoryName = '',
    this.showTime = false,
    this.timeAt,
    this.trailing,
    this.selected = false,
  });

  final AirTask task;
  final VoidCallback onTap;

  /// 跨目录的列表（控制台、侧栏）要把「它在哪个目录」写在行上；当前目录的
  /// 列表里这句话是废话，留空即可（同 Web 的 `options.dir === false`）。
  final String directoryName;

  /// 行尾时间。控制台按更新时间排序，时间本身就是排序依据，要看得见。
  final bool showTime;

  /// Optional clock selected by the containing list (message or local visit).
  /// Other lists keep their existing task metadata time by leaving this null.
  final int? timeAt;
  final Widget? trailing;
  final bool selected;

  @override
  Widget build(BuildContext context) {
    final detail = airTaskDetail(task);
    final subtitle = [
      if (directoryName.isNotEmpty) directoryName,
      if (detail.isNotEmpty) detail,
      if ((task.resource['path']?.toString() ?? '').isNotEmpty)
        'WT${(task.resource['branch']?.toString() ?? '').isNotEmpty ? ' · ${task.resource['branch']}' : ''}',
      if (task.readOnly) '只读记录',
    ].join(' · ');
    final time = showTime ? airTaskTime(timeAt ?? task.updatedAt) : '';
    return Material(
      color: AppColors.panel,
      borderRadius: BorderRadius.circular(AppColors.radiusCard),
      child: InkWell(
        key: ValueKey('air-task-${task.id}'),
        onTap: onTap,
        borderRadius: BorderRadius.circular(AppColors.radiusCard),
        child: Container(
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(AppColors.radiusCard),
            border: Border.all(
              color: selected ? AppColors.accent : AppColors.line,
            ),
          ),
          padding: const EdgeInsets.fromLTRB(12, 10, 10, 10),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Text(
                      task.title,
                      key: ValueKey('air-task-title-${task.id}'),
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        color: AppColors.text,
                        fontSize: 14.5,
                        fontWeight: FontWeight.w500,
                        height: 1.35,
                      ),
                    ),
                  ),
                  // 行尾操作和标题同一行：底下那行留给副行，它在窄屏上本来也
                  // 装不下多少字。
                  if (trailing != null) ...[
                    const SizedBox(width: 4),
                    trailing!,
                  ],
                ],
              ),
              const SizedBox(height: 5),
              Row(
                children: [
                  AirTaskStatusBadge(task: task, fontSize: 10.5),
                  if (task.worktreeChanges?.pending == true) ...[
                    const SizedBox(width: 6),
                    AirWorktreeChangeBadge(task: task),
                  ],
                  // 副行自己吃掉剩下的宽度（空着也占着），时间才总在行尾。
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      subtitle,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        color: AppColors.faint,
                        fontSize: 11.5,
                      ),
                    ),
                  ),
                  if (time.isNotEmpty) ...[
                    const SizedBox(width: 8),
                    Text(
                      time,
                      style: const TextStyle(
                        color: AppColors.faint,
                        fontSize: 10.5,
                      ),
                    ),
                  ],
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class AirStatusBadge extends StatelessWidget {
  const AirStatusBadge({
    super.key,
    required this.text,
    this.closed = false,
    this.onTap,
  });

  final String text;
  final bool closed;

  /// 点了做什么。Web 的 `#task-state` 是一颗按钮（`public/air.js` 把点击接到
  /// 「打开那个任务的详情」）；App 的 Air 首页没有「当前打开的任务」这一层，
  /// 所以点开的目标交回宿主决定 —— 宿主不给就保持纯展示，不假装可点。
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    if (text.isEmpty) return const SizedBox.shrink();
    final color = closed ? AppColors.faint : AppColors.blue;
    final badge = Container(
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.10),
        borderRadius: BorderRadius.circular(AppColors.radiusPill),
        border: Border.all(color: color.withValues(alpha: 0.24)),
      ),
      child: Text(
        text,
        style: TextStyle(
          color: color,
          fontSize: 11,
          fontWeight: FontWeight.w600,
        ),
      ),
    );
    if (onTap == null) return badge;
    return Tooltip(
      message: '查看本目录正在执行的任务',
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(AppColors.radiusPill),
        child: badge,
      ),
    );
  }
}

/// 当前目录那一块统计 —— 四张卡与 Web `air.js` 的 `renderDirectoryOverview()`
/// 一一对应：进行中 / 计划任务 / 已完成 / 全部记录，连副标题都照抄。
///
/// 取值全部用同一份判定：「进行中」排除生命周期已完结的 `done`/`archived`，
/// 「正在执行」只认注册表的 spinner（`airTaskRunning`），「计划任务」是
/// `recordType === 'planned'` 且还没跑起来的那批。从前这里算的是另一组数
/// （任务/未完成/执行中/待回答），同一份快照在 Web 和 App 上会得出四个不同的
/// 数字，看上去像两套后端。
class AirDirectoryStats extends StatelessWidget {
  const AirDirectoryStats({
    super.key,
    required this.tasks,
    this.worktreeCount = 0,
  });

  final List<AirTask> tasks;
  final int worktreeCount;

  @override
  Widget build(BuildContext context) {
    final current = tasks
        .where((task) => task.status != 'done' && task.status != 'archived')
        .toList();
    final running = current.where(airTaskRunning);
    final planned = current.where(
      (task) => task.recordType == 'planned' && !airTaskRunning(task),
    );
    final done = tasks.where((task) => task.status == 'done').length;
    final archived = tasks.where((task) => task.status == 'archived').length;
    final tiles = <Widget>[
      _StatTile(
        label: '进行中',
        value: '${current.length}',
        detail: '${running.length} 个正在执行',
        tone: _StatTone.blue,
      ),
      _StatTile(label: '计划任务', value: '${planned.length}', detail: '待开始或继续规划'),
      _StatTile(
        label: '已完成',
        value: '$done',
        detail: '仍保留在本目录',
        tone: _StatTone.green,
      ),
      _StatTile(
        label: '全部记录',
        value: '${tasks.length}',
        detail: '$archived 个已归档 · $worktreeCount 个 WT',
      ),
    ];
    // Web `air.css` 的 `@media (max-width: 1040px)` 把 `#directory-stats` 从四列
    // 改成两列 —— 手机上四张卡挤成一排，副标题会被截成「待开始或继…」，那行字
    // 正是这张卡要说的意思。断点跟着 Web 走，两端的列数就不会分岔。
    if (MediaQuery.sizeOf(context).width > 1040)
      return Row(children: _spread(tiles));
    return Column(
      children: [
        Row(children: _spread(tiles.sublist(0, 2))),
        const SizedBox(height: 10),
        Row(children: _spread(tiles.sublist(2, 4))),
      ],
    );
  }

  static List<Widget> _spread(List<Widget> tiles) => [
    for (var i = 0; i < tiles.length; i++) ...[
      if (i > 0) const SizedBox(width: 10),
      Expanded(child: tiles[i]),
    ],
  ];
}

/// Web `air.css` 的 `.directory-stat`：卡片顶上那截 18×3 的色条只有 blue/green
/// 两种，其余两张是默认灰。色条是「哪张卡值得先看」的唯一提示，别省。
enum _StatTone { plain, blue, green }

/// Web `air.html` 的 `#directory-worktrees`（内容由 `air-worktrees.js` 渲染）：
/// 目录下 worktree 的生命周期拆解，外加一个「现在回收」。
///
/// 为什么单列一块：只报「有几个 worktree」看不出这个数是怎么长的 —— 本地真占着
/// 磁盘的、已经睡下只剩一条分支引用的、计划了还没落地的，是三种完全不同的状态，
/// 而用户要判断的正是「要不要现在腾地方」。口径来自服务端的 workspace registry
/// （`/api/air` 快照的 `directory.worktreeLifecycle`），客户端只读不推断。
///
/// 回收只删本地 checkout，分支与提交始终保留（下次打开这条任务时按需重建），所以
/// 这一步不需要「会丢东西」的警告；按钮变灰只说明「本地没有可收的」。
class AirWorktreePanel extends StatelessWidget {
  const AirWorktreePanel({
    super.key,
    required this.lifecycle,
    this.idleMs = 0,
    this.busy = false,
    this.onReclaim,
  });

  final AirWorktreeLifecycle lifecycle;

  /// 自动回收的闲置阈值（毫秒），来自快照的 `worktreePolicy`。
  /// 0 = 自动回收已关闭（`MULTICC_SESSION_HIBERNATE_IDLE_MS=0`）。
  final int idleMs;

  /// 正在回收：按钮换成「回收中…」并禁用，避免连点出两批回收。
  final bool busy;

  /// 「现在回收」。null = 只读（远端工作区那行没有本机 worktree 可收）。
  final VoidCallback? onReclaim;

  @override
  Widget build(BuildContext context) {
    // 默认阈值是 24 小时，说成「闲置超过 24 小时」比说 86400000 有用；服务端把
    // 自动回收关了（idleMs = 0）也要照实说，别让人以为它一直在后台收东西。
    final hours = (idleMs / 3600000).round().clamp(1, 24 * 365);
    final policy = idleMs > 0 ? '闲置超过 $hours 小时会自动回收' : '自动回收已关闭';
    final summary = [
      '${lifecycle.total} 个 Worktree',
      airWorktreeBreakdown(lifecycle),
      if (lifecycle.leased > 0) '占用中 ${lifecycle.leased}',
    ].join(' · ');
    return Container(
      margin: const EdgeInsets.only(bottom: 14),
      padding: const EdgeInsets.symmetric(vertical: 11, horizontal: 14),
      decoration: BoxDecoration(
        color: AppColors.panel,
        borderRadius: BorderRadius.circular(AppColors.radiusCard),
        border: Border.all(color: AppColors.line),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text(
                      'Worktrees',
                      style: TextStyle(color: AppColors.faint, fontSize: 11.5),
                    ),
                    const SizedBox(height: 2),
                    const Text(
                      'Worktree 生命周期',
                      style: TextStyle(
                        color: AppColors.text,
                        fontSize: 14,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ],
                ),
              ),
              if (onReclaim != null) ...[
                const SizedBox(width: 8),
                OutlinedButton(
                  key: const ValueKey('air-worktree-reclaim'),
                  onPressed: busy || lifecycle.onDisk == 0 ? null : onReclaim,
                  style: OutlinedButton.styleFrom(
                    backgroundColor: AppColors.blueSoft,
                    side: const BorderSide(color: AppColors.lineStrong),
                    padding: const EdgeInsets.symmetric(horizontal: 14),
                  ),
                  child: Text(
                    busy ? '回收中…' : '现在回收',
                    style: const TextStyle(
                      color: AppColors.accent,
                      fontSize: 12,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
              ],
            ],
          ),
          const SizedBox(height: 8),
          Text(
            summary,
            key: const ValueKey('air-worktree-summary'),
            style: const TextStyle(color: AppColors.muted, fontSize: 11.5),
          ),
          const SizedBox(height: 6),
          const Text(
            '本地留着的 checkout 会随闲置时间自动收起，分支与提交始终保留。',
            style: TextStyle(
              color: AppColors.muted,
              fontSize: 11.5,
              height: 1.5,
            ),
          ),
          Text(
            policy,
            style: const TextStyle(color: AppColors.faint, fontSize: 11),
          ),
        ],
      ),
    );
  }
}

class _StatTile extends StatelessWidget {
  const _StatTile({
    required this.label,
    required this.value,
    required this.detail,
    this.tone = _StatTone.plain,
  });

  final String label;
  final String value;
  final String detail;
  final _StatTone tone;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 12),
    decoration: BoxDecoration(
      color: AppColors.panel,
      borderRadius: BorderRadius.circular(AppColors.radiusCard),
      border: Border.all(color: AppColors.line),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Container(
          width: 18,
          height: 3,
          margin: const EdgeInsets.only(bottom: 6),
          decoration: BoxDecoration(
            color: switch (tone) {
              _StatTone.blue => const Color(0xFF4D9BEA),
              _StatTone.green => const Color(0xFF43B88A),
              _StatTone.plain => const Color(0xFFAEBFD0),
            },
            borderRadius: BorderRadius.circular(4),
          ),
        ),
        Text(
          label,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: const TextStyle(color: Color(0xFF6D8094), fontSize: 10),
        ),
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 2),
          child: Text(
            value,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(
              color: Color(0xFF2D4D68),
              fontSize: 19,
              height: 1.1,
              fontWeight: FontWeight.w700,
            ),
          ),
        ),
        Text(
          detail,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: const TextStyle(color: Color(0xFF8A9AAB), fontSize: 10.5),
        ),
      ],
    ),
  );
}

/// 统一输入框模块的提交回调。目录首页那一片和承载它的弹层
/// （`air_new_task_sheet.dart`）共用这一份签名，两处不必各写一遍参数表。
///
/// 返回「这一份草稿确实整条交出去了吗」：输入区靠它决定清不清空、角色要不要跟着
/// 清。弹层那一层读的是同一个值，含义见那边的说明。
typedef AirComposerSubmit =
    Future<bool> Function({
      required String text,
      required String cli,
      required AirTaskRuntime runtime,
      required List<AirRoleBinding> roles,
      required bool goal,
      int? goalRounds,
      int? goalBudget,
    });

/// 目录空态里的「描述任务 → 创建并执行」。跟 Web `#quick-task-form` 一样：这段
/// 文字既是任务名也是要执行的第一条消息，所以建完就直接进去，不再问一遍。
///
/// 全站只有这一个模块：侧栏那颗「＋ 新任务」开的弹层装的也是它
/// （`air_new_task_sheet.dart`），不是第二份简易表单。
class AirQuickComposer extends StatefulWidget {
  const AirQuickComposer({
    super.key,
    required this.settings,
    required this.clis,
    required this.busy,
    required this.onSubmit,
    this.service,
    this.httpClient,
    this.autofocus = false,
  });

  /// 角色库（`/api/agent-presets`）要走服务地址和令牌，角色编辑器需要它。
  final SettingsService settings;
  final List<String> clis;
  final bool busy;
  final AirService? service;

  /// 线路面板要先拉这个 CLI 的 Provider 池。宿主已经有客户端的就传进来，
  /// 测试拿它桩掉整条线。
  final http.Client? httpClient;

  /// 弹层里那一份打开就要能写字（侧栏「＋ 新任务」是「点开就写」的意思），所以
  /// 那边传 true；目录首页常驻这一片不抢焦点 —— 页面一进来就弹键盘会顶掉滚动
  /// 位置，而它本来就在最上面，够不着才需要打字。
  final bool autofocus;

  /// 返回「这一份草稿确实建出去了吗」。建成了才清空输入框和角色 —— 失败时留着，
  /// 重试就是原样再点一次（同 Web Air 只在成功后清）。
  ///
  /// [text] 是**最终正文**：附件路径已经按 Web 的写法拼在末尾（`\n\n附件：…`）。
  /// [goalRounds] / [goalBudget] 只在 [goal] 为真时才有值（Web 的
  /// `goalLimitsFromForm`：0 和空都算「不限」）。
  final AirComposerSubmit onSubmit;

  @override
  State<AirQuickComposer> createState() => _AirQuickComposerState();
}

class _AirQuickComposerState extends State<AirQuickComposer> {
  final _controller = TextEditingController();
  // Goal 的两个上限。Web 的输入框默认值就是 200 / 空（`air.html:183-184`），
  // 「0 或空」都算不限 —— 判定见 [_readLimit]。
  final _roundsCtrl = TextEditingController(text: '200');
  final _budgetCtrl = TextEditingController();
  String _cli = '';
  // 这里存的是「还没有任务的那一份角色」和「还没有任务的那一条线路」，创建时
  // 随任务一起写下去；建完就清空 —— 一个任务的上下文不该悄悄漏进下一个任务
  // （同 Web Air 的 quickRoles / quickRuntime）。
  List<AirRoleBinding> _roles = const [];
  AirTaskRuntime _runtime = const AirTaskRuntime();
  bool _goal = false;

  /// 已经传上去的附件（服务端路径 + 展示名）。创建时按 Web 的写法拼进正文，
  /// 不是单独发一份附件列表。
  final List<UploadedAttachment> _attachments = [];
  bool _uploading = false;
  String _attachError = '';

  /// 🎙 的状态文案。Web 把它摆在动作行里那格 `#quick-task-status` 上（窄屏
  /// 那格整行掉到下面一行），这里跟着摆。
  String _voiceStatus = '';

  @override
  void initState() {
    super.initState();
    _cli = widget.clis.isEmpty ? 'claude' : widget.clis.first;
    _runtime = AirTaskRuntime(cli: _cli);
  }

  @override
  void dispose() {
    _controller.dispose();
    _roundsCtrl.dispose();
    _budgetCtrl.dispose();
    super.dispose();
  }

  /// 上限输入：空 / 非数字 / 0 都是「不限」（Web 的 `Number(rounds) > 0`）。
  /// 轮次还有个 200 的硬上限，超了按 200 算（Web 的 `max="200"`）。
  static int? _readLimit(TextEditingController controller, {int? max}) {
    final raw = controller.text.trim();
    if (raw.isEmpty) return null;
    final value = int.tryParse(raw);
    if (value == null || value <= 0) return null;
    if (max != null && value > max) return max;
    return value;
  }

  /// 最终正文 = 输入框里的字 + 附件路径（Web `air.js:545` 的写法：`\n\n附件：a b`）。
  /// 后缀以空行开头，所以第一行仍然是用户写的第一行 —— 标题正是从第一行推出来的。
  String _composedText(String typed) => _attachments.isEmpty
      ? typed
      : '$typed\n\n附件：${_attachments.map((a) => a.path).join(' ')}';

  /// 转写好的话追加进草稿（Web `air.js:513-515`：有内容就空一格接上，然后
  /// 把焦点放回输入框）。光标停在末尾，接着写或者直接创建都行。
  void _appendVoiceText(String text) {
    final current = _controller.text.trim();
    final merged = current.isEmpty ? text : '$current $text';
    _controller.value = TextEditingValue(
      text: merged,
      selection: TextSelection.collapsed(offset: merged.length),
    );
  }

  Future<void> _pickAttach() async {
    final picked = await pickChatAttachment(context);
    if (picked == null || !mounted) return;
    setState(() {
      _uploading = true;
      _attachError = '';
    });
    try {
      final uploaded = await uploadChatAttachment(
        settings: widget.settings,
        picked: picked,
        httpClient: widget.httpClient,
      );
      if (mounted) setState(() => _attachments.add(uploaded));
    } catch (error) {
      // 单个文件失败而已：已经传上去的那些留着，把这一条的名字和原因说出来。
      if (mounted) {
        setState(() => _attachError = '${picked.filename} · $error');
      }
    } finally {
      if (mounted) setState(() => _uploading = false);
    }
  }

  Future<void> _pickCli() async {
    final choice = await showModalBottomSheet<String>(
      context: context,
      backgroundColor: AppColors.panel,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(
          top: Radius.circular(AppColors.radiusPanel),
        ),
      ),
      builder: (ctx) => SafeArea(
        child: ListView(
          shrinkWrap: true,
          children: [
            const Padding(
              padding: EdgeInsets.fromLTRB(20, 18, 20, 6),
              child: Text(
                'AI 工具',
                style: TextStyle(
                  color: AppColors.text,
                  fontSize: 16,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
            for (final cli in widget.clis)
              ListTile(
                title: Text(cli, style: const TextStyle(color: AppColors.text)),
                trailing: cli == _cli
                    ? const Icon(Icons.check_rounded, color: AppColors.accent)
                    : null,
                onTap: () => Navigator.pop(ctx, cli),
              ),
          ],
        ),
      ),
    );
    if (choice != null && mounted) {
      setState(() {
        _cli = choice;
        // 换 CLI 等于换了一整池 Provider 和模型，旧的线路不能带过去。
        _runtime = _runtime.withCli(choice);
      });
    }
  }

  /// 给新任务挑线路、模型和推理强度。结果先留在这一层，等创建任务时随
  /// `POST /api/air/tasks` 一起写下去 —— 第一条消息就按它执行（同 Web Air）。
  Future<void> _editRuntime() async {
    final picked = await showAirTaskRuntimeEditor(
      context,
      settings: widget.settings,
      httpClient: widget.httpClient,
      initial: _runtime,
    );
    if (picked != null && mounted) setState(() => _runtime = picked);
  }

  /// 任务还不存在，所以走编辑器的草稿模式：编辑结果先留在这一层，等创建流程
  /// 建出任务、发第一条消息之前再写下去 —— 绑定说的是「下一条消息」，那条消息
  /// 正是紧接着要发的那条。
  Future<void> _editRoles() async {
    final edited = await showAirRoleEditor(
      context,
      settings: widget.settings,
      service: widget.service,
      initial: _roles,
    );
    if (edited != null && mounted) setState(() => _roles = edited);
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        color: AppColors.panel,
        borderRadius: BorderRadius.circular(AppColors.radiusPanel),
        border: Border.all(color: AppColors.line),
      ),
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // 三颗药丸在 320px 上挤不进一行（线路那颗本身就是一句话），所以让它
          // 换行而不是横着溢出 —— Web 那边窄屏同样靠换行排。
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              Tooltip(
                message: '新任务的 AI 配置：CLI、线路与模型（创建后即生效）',
                child: _Pill(
                  key: const ValueKey('air-quick-cli'),
                  label: _cli.isEmpty ? 'AI 工具' : _cli,
                  icon: Icons.memory_rounded,
                  onTap: widget.busy ? null : _pickCli,
                ),
              ),
              Tooltip(
                message: '新任务的 AI 配置：CLI、线路与模型（创建后即生效）',
                child: _Pill(
                  key: const ValueKey('air-quick-ai'),
                  label: _runtime.routeLabel,
                  icon: Icons.tune_rounded,
                  active: _runtime.provider.isNotEmpty || _runtime.isAuto,
                  labelMaxWidth: 240,
                  onTap: widget.busy ? null : _editRuntime,
                ),
              ),
              Tooltip(
                message: '新任务的角色上下文（写入第一条消息）',
                child: _Pill(
                  key: const ValueKey('air-quick-role'),
                  label: _roles.isEmpty ? '＋ 角色' : '${_roles.length} 个角色',
                  icon: Icons.badge_outlined,
                  active: _roles.isNotEmpty,
                  onTap: widget.busy ? null : _editRoles,
                ),
              ),
            ],
          ),
          if (_attachments.isNotEmpty || _uploading || _attachError.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Wrap(
                spacing: 6,
                runSpacing: 6,
                children: [
                  for (final file in _attachments)
                    _FileChip(
                      label: file.name,
                      onRemove: widget.busy
                          ? null
                          : () => setState(() => _attachments.remove(file)),
                    ),
                  if (_uploading) const _FileChip(label: '上传中…', busy: true),
                  if (_attachError.isNotEmpty)
                    _FileChip(label: _attachError, failed: true),
                ],
              ),
            ),
          const SizedBox(height: 8),
          TextField(
            key: const ValueKey('air-quick-input'),
            controller: _controller,
            autofocus: widget.autofocus,
            maxLines: 4,
            minLines: 3,
            maxLength: 32000,
            enabled: !widget.busy,
            style: const TextStyle(color: AppColors.text, fontSize: 14.5),
            decoration: InputDecoration(
              hintText: '描述要完成的任务；创建后会把这段内容作为第一条消息执行。',
              hintStyle: const TextStyle(
                color: AppColors.faint,
                fontSize: 13.5,
              ),
              filled: true,
              fillColor: AppColors.well,
              counterText: '',
              border: OutlineInputBorder(
                borderSide: BorderSide.none,
                borderRadius: BorderRadius.circular(AppColors.radiusCard),
              ),
            ),
          ),
          // Goal 的两个上限只在勾上 Goal 之后才出现（Web `renderQuickGoalLimits`
          // 就是切这个 `hidden`）。不勾时不问 —— 不问就不该显示。
          if (_goal) ...[
            Container(
              margin: const EdgeInsets.only(top: 8),
              padding: const EdgeInsets.fromLTRB(10, 8, 10, 10),
              decoration: BoxDecoration(
                color: AppColors.well,
                borderRadius: BorderRadius.circular(AppColors.radiusCard),
                border: Border.all(color: AppColors.line),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text(
                    '🎯 Goal 模式',
                    style: TextStyle(
                      color: AppColors.muted,
                      fontSize: 12,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(height: 6),
                  // 320px 上这两个输入框挤不进一行，Wrap 让它按需换行。
                  Wrap(
                    spacing: 10,
                    runSpacing: 6,
                    crossAxisAlignment: WrapCrossAlignment.center,
                    children: [
                      _LimitField(
                        key: const ValueKey('air-quick-goal-rounds'),
                        label: '轮次上限',
                        controller: _roundsCtrl,
                        enabled: !widget.busy,
                      ),
                      _LimitField(
                        key: const ValueKey('air-quick-goal-budget'),
                        label: 'token 预算',
                        controller: _budgetCtrl,
                        hint: '不限',
                        enabled: !widget.busy,
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ],
          const SizedBox(height: 8),
          Row(
            children: [
              // 320px 宽的手机上这一行只剩 254px：Material 3 的 chip 和按钮默认
              // 都带 24px 的横向内边距，两份默认值加起来就把这一行撑出去了。
              // 尺寸跟着 Web `air.css:354` 那一行走 —— `.quick-task-actions
              // button { min-height: 32px; padding: 5px 9px; font-size: 11px; }`
              // —— 四件（🎙 / 附件 / Goal / 提交）都按这套缩。
              //
              // 顺序也照 Web `air.html:186-191`：🎙、📎、🎯，然后是提交。左边这
              // 三位装进一个 Wrap：Web 在窄屏上给这一行开了 `flex-wrap: wrap`
              // （`air.css:816`），装不下就换行，而不是硬挤。
              Expanded(
                child: Wrap(
                  spacing: 2,
                  runSpacing: 6,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    VoiceInputButton(
                      key: const ValueKey('air-quick-mic'),
                      settings: widget.settings,
                      enabled: !widget.busy,
                      onText: _appendVoiceText,
                      onStatus: (message) {
                        if (mounted) setState(() => _voiceStatus = message);
                      },
                    ),
                    IconButton(
                      key: const ValueKey('air-quick-attach'),
                      onPressed: widget.busy || _uploading ? null : _pickAttach,
                      iconSize: 19,
                      padding: EdgeInsets.zero,
                      constraints: const BoxConstraints(
                        minWidth: 32,
                        minHeight: 32,
                      ),
                      visualDensity: VisualDensity.compact,
                      tooltip: '上传图片或文件（也可以直接粘贴或拖入）',
                      icon: Icon(
                        _uploading
                            ? Icons.hourglass_top_rounded
                            : Icons.attach_file_rounded,
                        color: AppColors.faint,
                      ),
                    ),
                    Tooltip(
                      message: '以 Goal 模式发送：先预检目标与完成标准',
                      child: FilterChip(
                        key: const ValueKey('air-quick-goal'),
                        label: const Text('🎯 Goal'),
                        labelStyle: const TextStyle(fontSize: 11),
                        selected: _goal,
                        onSelected: widget.busy
                            ? null
                            : (v) => setState(() => _goal = v),
                        showCheckmark: false,
                        visualDensity: VisualDensity.compact,
                        materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                        labelPadding: const EdgeInsets.symmetric(horizontal: 2),
                        padding: const EdgeInsets.symmetric(horizontal: 6),
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 4),
              FilledButton(
                key: const ValueKey('air-quick-submit'),
                onPressed: widget.busy
                    ? null
                    : () async {
                        final text = _controller.text.trim();
                        if (text.isEmpty) return;
                        final rounds = _readLimit(_roundsCtrl, max: 200);
                        final budget = _readLimit(_budgetCtrl);
                        final sent = await widget.onSubmit(
                          text: _composedText(text),
                          cli: _cli,
                          runtime: _runtime,
                          roles: _roles,
                          goal: _goal,
                          goalRounds: _goal ? rounds : null,
                          goalBudget: _goal ? budget : null,
                        );
                        if (!sent || !mounted) return;
                        // 任务建出去了才清草稿；角色和线路也一起清 —— 一个任务
                        // 的上下文不该悄悄漏进下一个任务。附件同样清掉：它已经
                        // 随正文交出去了，留着会跟着下一个任务再发一遍。
                        setState(() {
                          _controller.clear();
                          _roles = const [];
                          _runtime = AirTaskRuntime(cli: _cli);
                          _goal = false;
                          _attachments.clear();
                          _attachError = '';
                          _roundsCtrl.text = '200';
                          _budgetCtrl.clear();
                        });
                      },
                style: FilledButton.styleFrom(
                  backgroundColor: AppColors.accentDark,
                  minimumSize: const Size(0, 36),
                  padding: const EdgeInsets.symmetric(horizontal: 9),
                  visualDensity: VisualDensity.compact,
                  tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                  textStyle: const TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w600,
                  ),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(AppColors.radiusButton),
                  ),
                ),
                child: Text(widget.busy ? '正在创建…' : '创建并执行 ↑'),
              ),
            ],
          ),
          // 🎙 的状态（Web `#quick-task-status`，窄屏那条 `flex-basis: 100%` 的
          // 规则让它整行掉到动作行下面）。
          if (_voiceStatus.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text(
                _voiceStatus,
                key: const ValueKey('air-quick-voice-status'),
                style: const TextStyle(color: AppColors.muted, fontSize: 11),
              ),
            ),
        ],
      ),
    );
  }
}

const TextStyle _pillLabelStyle = TextStyle(
  color: AppColors.text,
  fontSize: 12.5,
  fontWeight: FontWeight.w500,
);

class _Pill extends StatelessWidget {
  const _Pill({
    super.key,
    required this.label,
    required this.icon,
    required this.onTap,
    this.active = false,
    this.labelMaxWidth,
  });

  final String label;
  final IconData icon;
  final VoidCallback? onTap;
  final bool active;

  /// 线路那颗药丸的文字上限（Web `.mc-composer__pill--ai` 的 `min(68%, 320px)`）。
  /// 线路名是用户数据，长了就把旁边的按钮挤走 —— 超过上限就走跑马灯，见
  /// [MarqueeText]。别的药丸（CLI、角色）文字短且固定，不需要上限。
  final double? labelMaxWidth;

  @override
  Widget build(BuildContext context) => Material(
    color: active ? AppColors.blueSoft : AppColors.well,
    borderRadius: BorderRadius.circular(AppColors.radiusPill),
    child: InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(AppColors.radiusPill),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(AppColors.radiusPill),
          border: Border.all(color: active ? AppColors.accent : AppColors.line),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 15, color: AppColors.muted),
            const SizedBox(width: 6),
            if (labelMaxWidth == null)
              Text(label, style: _pillLabelStyle)
            else
              MarqueeText(
                text: label,
                maxWidth: labelMaxWidth!,
                style: _pillLabelStyle,
              ),
          ],
        ),
      ),
    ),
  );
}

/// Goal 上限的一个数字输入（Web `#quick-task-goal-rounds` / `-budget`）。
class _LimitField extends StatelessWidget {
  const _LimitField({
    super.key,
    required this.label,
    required this.controller,
    required this.enabled,
    this.hint,
  });

  final String label;
  final TextEditingController controller;
  final bool enabled;
  final String? hint;

  @override
  Widget build(BuildContext context) => Row(
    mainAxisSize: MainAxisSize.min,
    children: [
      Text(label, style: const TextStyle(color: AppColors.muted, fontSize: 12)),
      const SizedBox(width: 6),
      SizedBox(
        width: 72,
        child: TextField(
          controller: controller,
          enabled: enabled,
          keyboardType: TextInputType.number,
          inputFormatters: [FilteringTextInputFormatter.digitsOnly],
          style: const TextStyle(color: AppColors.text, fontSize: 12.5),
          decoration: InputDecoration(
            hintText: hint,
            hintStyle: const TextStyle(color: AppColors.faint, fontSize: 12),
            isDense: true,
            contentPadding: const EdgeInsets.symmetric(
              horizontal: 8,
              vertical: 7,
            ),
            filled: true,
            fillColor: AppColors.panel,
            border: OutlineInputBorder(
              borderRadius: BorderRadius.circular(8),
              borderSide: const BorderSide(color: AppColors.line),
            ),
            enabledBorder: OutlineInputBorder(
              borderRadius: BorderRadius.circular(8),
              borderSide: const BorderSide(color: AppColors.line),
            ),
          ),
        ),
      ),
    ],
  );
}

/// 已上传附件的那一小条（Web `#quick-task-files` 里的 chip）。
class _FileChip extends StatelessWidget {
  const _FileChip({
    required this.label,
    this.onRemove,
    this.busy = false,
    this.failed = false,
  });

  final String label;
  final VoidCallback? onRemove;
  final bool busy;
  final bool failed;

  @override
  Widget build(BuildContext context) {
    final color = failed ? AppColors.danger : AppColors.muted;
    return Container(
      padding: const EdgeInsets.fromLTRB(9, 4, 4, 4),
      decoration: BoxDecoration(
        color: failed ? AppColors.dangerSoft : AppColors.well,
        borderRadius: BorderRadius.circular(AppColors.radiusPill),
        border: Border.all(color: failed ? AppColors.danger : AppColors.line),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (busy) ...[
            const SizedBox(
              width: 11,
              height: 11,
              child: CircularProgressIndicator(strokeWidth: 1.6),
            ),
            const SizedBox(width: 6),
          ],
          ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 170),
            child: Text(
              label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(color: color, fontSize: 11.5),
            ),
          ),
          if (onRemove != null)
            InkWell(
              onTap: onRemove,
              borderRadius: BorderRadius.circular(AppColors.radiusPill),
              child: const Padding(
                padding: EdgeInsets.symmetric(horizontal: 5, vertical: 1),
                child: Text(
                  '×',
                  style: TextStyle(
                    color: AppColors.faint,
                    fontSize: 14,
                    height: 1.1,
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}
