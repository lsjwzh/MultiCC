import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../services/air_service.dart';
import '../../theme.dart';
import '../workspace_navigation_drawer.dart';
import 'air_ops.dart';
import 'air_ops_store.dart';
import 'air_task_status.dart';

/// Air 的侧栏（Web `public/air.html` 的 `#sidebar`）。
///
/// 频次收敛和 Web 一样：每天点的（当前工作目录、控制台、定时任务、最近任务、
/// 新任务）留在外面；偶尔点的（服务与文档、记忆图谱、设置中心、任务看板、开发者
/// 选项）折进「更多与系统」。手机上没有 ⌘K，找全部目录的入口就是顶上那张目录
/// 卡片。
///
/// 这里没有「收藏目录」那一组（Web 侧栏的 `.favorite-caption` + `#favorites` 也已经
/// 撤掉了）：工作目录本来就不会很多，一组随时可能空的快捷方式和它下面那条分隔线
/// 都是白占位置。找目录走目录卡片和全部目录入口。`AirLocalStore` 里那套收藏读写留着
/// （数据还在，只是不再有界面展示它）。
class AirSidebar extends StatelessWidget {
  const AirSidebar({
    super.key,
    required this.data,
    required this.directoryId,
    required this.recentTasks,
    required this.pinnedTaskIds,
    required this.advancedMode,
    required this.serverLabel,
    required this.onSelectDirectory,
    required this.onOpenLibrary,
    required this.onOpenSearch,
    required this.onOpenConsole,
    required this.onOpenSchedules,
    required this.onOpenTaskBoard,
    required this.onCreateTask,
    required this.onOpenTask,
    required this.terminalSessions,
    required this.onOpenTerminal,
    required this.onOpenDocs,
    required this.onOpenMemory,
    required this.onOpenTaskGraph,
    required this.onOpenSettings,
    required this.onOpenAllDestinations,
    required this.onOpenDestination,
    required this.ops,
    required this.onOpenPush,
    required this.onLogout,
    this.onOpenVoiceCall,
    this.onAdvancedModeChanged,
  });

  static const double width = 268;
  static const double _rowHeight = 46;

  /// 任务清单最少留这么高（同 Web `#tasks` 的 `min-height: 120px`）。再矮就不值得
  /// 让清单自己滚了：与其给它留一条十几像素的缝，不如让整条侧栏一起滚。
  static const double _listFloor = 120;

  final AirSnapshot? data;
  final String? directoryId;
  final List<AirTask> recentTasks;

  /// Pin 住的任务 id。它们已经排在 [recentTasks] 的最前面（`air_tasks_view.dart`
  /// 的 `_sidebarTasks`），这里留着只是为了在行上把「为什么它排在最上面」说出来。
  final Set<String> pinnedTaskIds;
  final bool advancedMode;
  final String serverLabel;
  final ValueChanged<String> onSelectDirectory;
  final VoidCallback onOpenLibrary;

  /// ⌘K 那一件事：目录和任务一起搜。手机上没有 ⌘K，所以侧栏上明摆着一行。
  final VoidCallback onOpenSearch;
  final VoidCallback onOpenConsole;
  final VoidCallback onOpenSchedules;
  final VoidCallback onOpenTaskBoard;
  final VoidCallback onCreateTask;
  final ValueChanged<AirTask> onOpenTask;

  /// 「更多与系统」里的 TERMINAL 一组：当前目录下的终端会话（Web 侧栏
  /// `#legacy-sessions`，按 `dirId` 筛出来的那一组）。
  final List<AirSession> terminalSessions;
  final ValueChanged<AirSession> onOpenTerminal;
  final VoidCallback onOpenDocs;
  final VoidCallback onOpenMemory;

  /// 「任务图谱」在 Web 侧是 `?view=taskgraph` 那页关联网络；App 也有原生版
  /// （`task_graph_screen.dart`），这一项交给宿主 push 那一页。
  final VoidCallback onOpenTaskGraph;
  final VoidCallback onOpenSettings;
  final VoidCallback onOpenAllDestinations;

  /// 「常用设置」那三行（Provider 配置 / 外网穿透 / 消息桥接）要去的页。它们就是
  /// 老抽屉里的三个目的地，没有原生页，整条交给宿主去开。
  final ValueChanged<WorkspaceDestination> onOpenDestination;

  /// 主机运维那几行字的同一份状态：版本行、开机时间、回执各在一处，说的却是
  /// 同一件事（见 [AirOpsStore]）。
  final AirOpsStore ops;

  /// 「推送通知」在原生侧落到设置中心的那一页（本机通知通道，不是浏览器订阅）。
  final VoidCallback onOpenPush;
  final VoidCallback onLogout;
  final VoidCallback? onOpenVoiceCall;
  final ValueChanged<bool>? onAdvancedModeChanged;

  AirDirectory? get _directory => data?.directoryOf(directoryId);

  @override
  Widget build(BuildContext context) {
    final directory = _directory;
    final urgentCount = airUrgentTasks(data?.tasks ?? const []).length;
    return Drawer(
      width: width,
      elevation: 0,
      backgroundColor: AppColors.bgSoft,
      shape: const Border(right: BorderSide(color: AppColors.line)),
      child: SafeArea(
        // 三段：顶上（品牌、目录卡、导航、「最近任务」抬头与「＋ 新任务」）、中间
        // 的任务清单、底下的运维与「更多与系统」。中间那段吃掉另外两段之外的全部
        // 高度并在内部滚 —— Web 的侧栏就是这三段（`#tasks{flex:1 1 auto}` 配上下
        // 两组的 `flex-shrink:0`），[_FillingColumn] 在滚动视图里做出同一件事：
        // 侧栏下半截那片空白本来就是留给任务清单的，不该留在页脚上面。
        child: _FillingColumn(
          minMiddle: _listFloor,
          top: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 14, 12, 6),
              child: Row(
                children: [
                  Container(
                    width: 30,
                    height: 30,
                    alignment: Alignment.center,
                    decoration: BoxDecoration(
                      gradient: const LinearGradient(
                        begin: Alignment.topLeft,
                        end: Alignment.bottomRight,
                        colors: [AppColors.accent, Color(0xFF137780)],
                      ),
                      borderRadius: BorderRadius.circular(9),
                    ),
                    child: const Text(
                      'M',
                      style: TextStyle(
                        color: AppColors.onAccent,
                        fontSize: 15,
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                  ),
                  const SizedBox(width: 10),
                  const Expanded(
                    child: Text(
                      'MultiCC Air',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: AppColors.text,
                        fontSize: 15,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  ),
                ],
              ),
            ),
            Padding(
              // 下边距是 0：清单和底下那组之间的留白归它们自己（清单下面 8px
              // 在 bottom 那一组头上），这样清单的框才能一路顶到该到的地方。
              padding: const EdgeInsets.fromLTRB(12, 4, 12, 0),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  _SpaceCard(directory: directory, onOpen: onOpenLibrary),
                  const SizedBox(height: 8),
                  _NavRow(
                    semanticKey: 'air-nav-search',
                    icon: Icons.search_rounded,
                    label: '搜索目录与任务',
                    onTap: onOpenSearch,
                  ),
                  _NavRow(
                    semanticKey: 'air-nav-console',
                    icon: Icons.dashboard_customize_outlined,
                    label: '控制台',
                    // 控制台第一个分区就是「谁在等我」，入口上挂同一个数字 ——
                    // 一处定义，两处显示（同 Web 的 `#console-badge`）。
                    badge: urgentCount > 0 ? '$urgentCount' : null,
                    onTap: onOpenConsole,
                  ),
                  _NavRow(
                    semanticKey: 'air-nav-schedules',
                    icon: Icons.schedule_rounded,
                    label: '定时任务',
                    onTap: onOpenSchedules,
                  ),
                  const _Caption('任务'),
                  Padding(
                    padding: const EdgeInsets.fromLTRB(4, 0, 4, 6),
                    child: Row(
                      children: [
                        const Expanded(
                          child: Text(
                            '最近任务',
                            style: TextStyle(
                              color: AppColors.text,
                              fontSize: 14,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                        ),
                        Text(
                          '${recentTasks.length}',
                          style: const TextStyle(
                            color: AppColors.faint,
                            fontSize: 12,
                          ),
                        ),
                      ],
                    ),
                  ),
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 4),
                    child: OutlinedButton.icon(
                      key: const ValueKey('air-sidebar-create'),
                      onPressed: directory == null ? null : onCreateTask,
                      icon: const Icon(Icons.add_rounded, size: 18),
                      label: const Text('新任务'),
                      style: OutlinedButton.styleFrom(
                        foregroundColor: AppColors.accentDark,
                        side: const BorderSide(color: AppColors.lineStrong),
                        minimumSize: const Size.fromHeight(40),
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(
                            AppColors.radiusButton,
                          ),
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(height: 6),
                ],
              ),
            ),
            ],
          ),
          middle: (height) => Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12),
            // 框的高度由剩下的高度决定，跟里面有几条任务无关：三十条在框里滚，
            // 两条也不缩框 —— 那正是这块地方以前空着的原因（Web 的 `#tasks` 是
            // 同一个契约，连 120px 的下限都一样）。
            child: SizedBox(
              height: height,
              child: ListView(
                key: const ValueKey('air-sidebar-tasks'),
                padding: EdgeInsets.zero,
                children: [
                  for (final task in recentTasks)
                    _TaskRow(
                      task: task,
                      pinned: pinnedTaskIds.contains(task.id),
                      onTap: () => onOpenTask(task),
                    ),
                  if (recentTasks.isEmpty)
                    const Padding(
                      padding: EdgeInsets.fromLTRB(6, 10, 6, 4),
                      child: Text(
                        '还没有打开过的任务。',
                        style: TextStyle(color: AppColors.faint, fontSize: 12),
                      ),
                    ),
                ],
              ),
            ),
          ),
          bottom: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
            // 清单和底下这组之间的留白。
            const SizedBox(height: 8),
            // 版本行留在折叠区外：它是「有新版本」唯一的落点，折起来就没人知道。
            AirVersionRow(store: ops),
            _MoreSection(
              advancedMode: advancedMode,
              onAdvancedModeChanged: onAdvancedModeChanged,
              onOpenDocs: onOpenDocs,
              onOpenMemory: onOpenMemory,
              onOpenTaskGraph: onOpenTaskGraph,
              onOpenSettings: onOpenSettings,
              onOpenTaskBoard: onOpenTaskBoard,
              terminalSessions: terminalSessions,
              onOpenTerminal: onOpenTerminal,
              onOpenAllDestinations: onOpenAllDestinations,
              onOpenDestination: onOpenDestination,
              onOpenVoiceCall: onOpenVoiceCall,
              ops: ops,
              onOpenPush: onOpenPush,
              onLogout: onLogout,
            ),
            const Divider(height: 1, color: AppColors.line),
            // 回执也留在折叠区外：运维动作的结果要看得见。
            AirOpsReceipt(store: ops),
            Padding(
              padding: const EdgeInsets.fromLTRB(18, 10, 18, 6),
              child: Text(
                serverLabel.isEmpty ? '未连接服务器' : serverLabel,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(
                  color: AppColors.faint,
                  fontSize: 11,
                ),
              ),
            ),
            const Padding(
              padding: EdgeInsets.fromLTRB(18, 0, 18, 12),
              child: Text(
                '让每一次对话，都有清晰的目标。',
                style: TextStyle(color: AppColors.faint, fontSize: 10.5),
              ),
            ),
            ],
          ),
        ),
      ),
    );
  }
}

/// 一条竖排，中间那段吃掉剩下的高度（[AirSidebar] 的三段就是这么来的）。
///
/// Web 那句 `#tasks{flex:1 1 auto}` 配上下两组 `flex-shrink:0` 说的是这件事：
/// 上下的固定内容各占自己的自然高度，中间那段拿走剩下的全部 —— 它的高度不由
/// 内容多少决定，多的在里面滚，少的也不缩。Flutter 这边没有「剩下的高度」这种
/// 约束（`Expanded` 要求父级高度确定，而侧栏本身是个滚动视图：矮屏、系统字体
/// 放大、「更多与系统」展开时，整条侧栏要能一起滚），所以这里把它算出来：量一次
/// 上下两段的高度，用视口高度减掉。
///
/// 量而不是写死常数：字号、有没有运维回执、终端那一组开没开都会改变它们。量到
/// 之前按估值走 —— 只有第一帧，之后每一帧都是真值。算出来的中间高度已经压到
/// [minMiddle] 还装不下时，外层这个滚动视图接手，整条侧栏一起滚。
class _FillingColumn extends StatefulWidget {
  const _FillingColumn({
    required this.top,
    required this.middle,
    required this.bottom,
    this.minMiddle = 120,
  });

  final Widget top;

  /// 中间那段：拿到分给它的高度，自己决定怎么用。
  final Widget Function(double height) middle;
  final Widget bottom;

  /// 中间那段的下限。低于它就不给它「自己滚」了，交回外层。
  final double minMiddle;

  @override
  State<_FillingColumn> createState() => _FillingColumnState();
}

class _FillingColumnState extends State<_FillingColumn> {
  /// 第一帧还没量到上下两段时用的估值 —— 只影响打开抽屉的第一帧，之后一直是
  /// 真值。估大一点：宁可第一帧清单短一行，也不要把页脚顶出屏幕。
  static const double _topGuess = 380;
  static const double _bottomGuess = 210;

  final _topKey = GlobalKey();
  final _bottomKey = GlobalKey();
  double? _topHeight;
  double? _bottomHeight;

  @override
  Widget build(BuildContext context) {
    // 布局之后读一次实际高度；变了才 setState —— 不变就什么都不做，不会自己
    // 触发下一帧（估的值和量到的值会在第二帧对齐，之后一直稳定）。
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final top = _topKey.currentContext?.size?.height;
      final bottom = _bottomKey.currentContext?.size?.height;
      if (top == null || bottom == null) return;
      if (top == _topHeight && bottom == _bottomHeight) return;
      setState(() {
        _topHeight = top;
        _bottomHeight = bottom;
      });
    });
    return LayoutBuilder(
      builder: (context, constraints) {
        final fixed = (_topHeight ?? _topGuess) + (_bottomHeight ?? _bottomGuess);
        return SingleChildScrollView(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              KeyedSubtree(key: _topKey, child: widget.top),
              widget.middle(math.max(widget.minMiddle, constraints.maxHeight - fixed)),
              KeyedSubtree(key: _bottomKey, child: widget.bottom),
            ],
          ),
        );
      },
    );
  }
}

/// 顶上那张卡：当前工作目录。点它就回目录库（Web 的 `.space-main`）。
class _SpaceCard extends StatelessWidget {
  const _SpaceCard({required this.directory, required this.onOpen});

  final AirDirectory? directory;
  final VoidCallback onOpen;

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        color: AppColors.panel,
        borderRadius: BorderRadius.circular(AppColors.radiusCard),
        border: Border.all(color: AppColors.line),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          InkWell(
            key: const ValueKey('air-space-main'),
            onTap: onOpen,
            borderRadius: const BorderRadius.vertical(
              top: Radius.circular(AppColors.radiusCard),
            ),
            child: Padding(
              padding: const EdgeInsets.fromLTRB(12, 11, 10, 11),
              child: Row(
                children: [
                  const Icon(
                    Icons.folder_open_rounded,
                    size: 18,
                    color: AppColors.accent,
                  ),
                  const SizedBox(width: 9),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(
                          directory?.name ?? '正在读取…',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            color: AppColors.text,
                            fontSize: 14,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                        Text(
                          directory?.path ?? '',
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
                  const Icon(
                    Icons.chevron_right_rounded,
                    size: 18,
                    color: AppColors.faint,
                  ),
                ],
              ),
            ),
          ),
          const Divider(height: 1, color: AppColors.line),
          Row(
            children: [
              const SizedBox(width: 12),
              const Expanded(
                child: Text(
                  '工作目录',
                  style: TextStyle(color: AppColors.faint, fontSize: 11),
                ),
              ),
              const Padding(
                padding: EdgeInsets.only(right: 12),
                child: Text(
                  '全部目录 ›',
                  style: TextStyle(color: AppColors.blue, fontSize: 11),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

/// 侧栏上的一行。原本还有「选中」和自定义图标色两档，都是给「收藏目录」那组用的
/// —— 那组撤掉之后就没有调用方了，一起去掉（留着就是一段永远走不到的高亮代码）。
class _NavRow extends StatelessWidget {
  const _NavRow({
    required this.semanticKey,
    required this.icon,
    required this.label,
    required this.onTap,
    this.badge,
  });

  final String semanticKey;
  final IconData icon;
  final String label;
  final VoidCallback onTap;

  /// 行尾的数字（控制台挂的是「谁在等我」的条数）。0 不显示。
  final String? badge;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      key: ValueKey(semanticKey),
      button: true,
      label: badge == null ? label : '$label，$badge 项待处理',
      child: Material(
        color: Colors.transparent,
        borderRadius: BorderRadius.circular(AppColors.radiusChip),
        child: InkWell(
          excludeFromSemantics: true,
          onTap: onTap,
          borderRadius: BorderRadius.circular(AppColors.radiusChip),
          child: SizedBox(
            height: AirSidebar._rowHeight,
            child: Row(
              children: [
                const SizedBox(width: 10),
                Icon(icon, size: 18, color: AppColors.muted),
                const SizedBox(width: 11),
                Expanded(
                  child: Text(
                    label,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      color: AppColors.muted,
                      fontSize: 13.5,
                      fontWeight: FontWeight.w500,
                    ),
                  ),
                ),
                if (badge != null)
                  Container(
                    margin: const EdgeInsets.only(right: 10),
                    padding: const EdgeInsets.symmetric(
                      horizontal: 6,
                      vertical: 1,
                    ),
                    decoration: BoxDecoration(
                      color: AppColors.dangerSoft,
                      borderRadius: BorderRadius.circular(
                        AppColors.radiusPill,
                      ),
                      border: Border.all(
                        color: AppColors.danger.withValues(alpha: 0.3),
                      ),
                    ),
                    child: Text(
                      badge!,
                      style: const TextStyle(
                        color: AppColors.danger,
                        fontSize: 10.5,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  )
                else
                  const SizedBox(width: 8),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _Caption extends StatelessWidget {
  const _Caption(this.text);

  final String text;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(10, 16, 10, 4),
    child: Text(
      text,
      style: const TextStyle(
        color: AppColors.faint,
        fontSize: 10,
        fontWeight: FontWeight.w600,
        letterSpacing: 1.2,
      ),
    ),
  );
}

class _TaskRow extends StatelessWidget {
  const _TaskRow({
    required this.task,
    required this.onTap,
    this.pinned = false,
  });

  final AirTask task;
  final VoidCallback onTap;

  /// Pin 住的那几条排在这份列表的最上面（Web 桌面是页头顶上那排 tab，手机宽度
  /// 和 App 就是这一份列表的置顶）。标记说明它们为什么在那儿。
  final bool pinned;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      key: ValueKey('air-side-task-${task.id}'),
      onTap: onTap,
      borderRadius: BorderRadius.circular(AppColors.radiusChip),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(10, 8, 8, 8),
        child: Row(
          children: [
            Container(
              width: 6,
              height: 6,
              decoration: BoxDecoration(
                color: task.closed ? AppColors.faint : AppColors.accent,
                shape: BoxShape.circle,
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    task.title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      color: AppColors.text,
                      fontSize: 13,
                    ),
                  ),
                  Text(
                    airLabel(task.workflowStage ?? task.status),
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
            if (pinned)
              const Padding(
                padding: EdgeInsets.only(left: 6),
                child: Icon(
                  Icons.push_pin_rounded,
                  size: 12,
                  color: AppColors.accent,
                ),
              ),
          ],
        ),
      ),
    );
  }
}

/// 「更多与系统」：偶尔点的东西。折叠起来，但**回执不折**——运维动作的结果要
/// 看得见，这是 Web 版把 `#air-ops-status` 留在折叠区外的原因。
///
/// 里面按 Web 侧栏（`public/air.html` 的 `#side-more`）分组成框：常用设置 /
/// 系统工具 / TERMINAL / 主机。这几组原来只靠留白分隔，一列行叠起来是一整片
/// 能点的东西，视线会顺着滑进下一组；各套一个框之后每一组自己成立。
///
/// 「常用设置」这一组自己还可收缩（默认展开），并且两列排布（Web `air.css` 的
/// `.frequent-settings`）：四个入口排 2×2，比一列短一半。Provider 配置在这一组里
/// 加粗变色 —— 换线路、换模型都从它进，它和旁边几行不是一个权重。
class _MoreSection extends StatelessWidget {
  const _MoreSection({
    required this.advancedMode,
    required this.onAdvancedModeChanged,
    required this.onOpenDocs,
    required this.onOpenMemory,
    required this.onOpenTaskGraph,
    required this.onOpenSettings,
    required this.onOpenTaskBoard,
    required this.terminalSessions,
    required this.onOpenTerminal,
    required this.onOpenAllDestinations,
    required this.ops,
    required this.onOpenPush,
    required this.onLogout,
    this.onOpenDestination,
    this.onOpenVoiceCall,
  });

  final bool advancedMode;
  final ValueChanged<bool>? onAdvancedModeChanged;
  final VoidCallback onOpenDocs;
  final VoidCallback onOpenMemory;
  final VoidCallback onOpenTaskGraph;
  final VoidCallback onOpenSettings;
  final VoidCallback onOpenTaskBoard;
  final List<AirSession> terminalSessions;
  final ValueChanged<AirSession> onOpenTerminal;
  final VoidCallback onOpenAllDestinations;
  final AirOpsStore ops;
  final VoidCallback onOpenPush;
  final VoidCallback onLogout;

  /// 「常用设置」那三行（Provider 配置 / 外网穿透 / 消息桥接）。它们就是老抽屉里
  /// 的三个目的地，没有自己的原生页，所以整条交给宿主去开那一页。
  final ValueChanged<WorkspaceDestination>? onOpenDestination;

  /// 机器级语音通话。原生独占 —— Web 侧没有对应页面。
  final VoidCallback? onOpenVoiceCall;

  @override
  Widget build(BuildContext context) {
    final open = onOpenDestination ?? (_) {};
    return Theme(
      data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
      child: ExpansionTile(
        key: const ValueKey('air-more-section'),
        tilePadding: const EdgeInsets.symmetric(horizontal: 18),
        childrenPadding: const EdgeInsets.fromLTRB(10, 0, 10, 6),
        title: const Text(
          '更多与系统',
          style: TextStyle(
            color: AppColors.muted,
            fontSize: 13,
            fontWeight: FontWeight.w600,
          ),
        ),
        iconColor: AppColors.faint,
        collapsedIconColor: AppColors.faint,
        children: [
          _SideGroupBox(
            groupKey: 'air-group-frequent',
            child: Theme(
              data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
              child: ExpansionTile(
                key: const ValueKey('air-more-frequent'),
                // 默认展开：折起来等于把常用入口一起藏掉，而这一组正是「天天点的
                // 那几件事」——可收缩是给它一个收起来的选择，不是默认藏起来。
                initiallyExpanded: true,
                tilePadding: const EdgeInsets.symmetric(horizontal: 8),
                childrenPadding: const EdgeInsets.fromLTRB(2, 0, 2, 4),
                dense: true,
                title: const Text(
                  '常用设置',
                  style: TextStyle(
                    color: AppColors.muted,
                    fontSize: 12,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                iconColor: AppColors.faint,
                collapsedIconColor: AppColors.faint,
                children: [
                  _Grid2(
                    children: [
                      _CompactRow(
                        semanticKey: 'air-more-provider',
                        icon: Icons.swap_horiz_rounded,
                        label: 'Provider 配置',
                        emphasized: true,
                        onTap: () => open(WorkspaceDestination.provider),
                      ),
                      _CompactRow(
                        semanticKey: 'air-more-tunnel',
                        icon: Icons.public_rounded,
                        label: '外网穿透',
                        onTap: () => open(WorkspaceDestination.tunnel),
                      ),
                      _CompactRow(
                        semanticKey: 'air-more-bridges',
                        icon: Icons.device_hub_rounded,
                        label: '消息桥接',
                        onTap: () => open(WorkspaceDestination.bridges),
                      ),
                      // 关盖运行（macOS 电源）在这里是设置中心 › 全局配置那个开关的
                      // 快捷版：点一下直接切。只在服务端答 available 时出现，非
                      // macOS 整行隐藏——不留一个点了没反应的开关。
                      if (ops.lidSleepAvailable == true)
                        _CompactRow(
                          semanticKey: 'air-more-lid-sleep',
                          icon: Icons.bedtime_outlined,
                          label: '关盖运行',
                          toggled: ops.lidSleepOn,
                          onTap: () => unawaited(ops.toggleLidSleep()),
                          trailing: _MiniSwitch(on: ops.lidSleepOn),
                        ),
                    ],
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 6),
          // Web `#side-more .global-links` 的四个全局页。和上面「常用设置」不是
          // 一类：那边是「改配置」，这边是「去某个页面」。
          _SideGroupBox(
            groupKey: 'air-group-global',
            child: Padding(
              padding: const EdgeInsets.fromLTRB(4, 4, 4, 4),
              child: _Grid2(
                children: [
                  _CompactRow(
                    semanticKey: 'air-more-docs',
                    icon: Icons.travel_explore_outlined,
                    label: '服务与文档',
                    onTap: onOpenDocs,
                  ),
                  _CompactRow(
                    semanticKey: 'air-more-memory',
                    icon: Icons.hub_outlined,
                    label: '记忆图谱',
                    onTap: onOpenMemory,
                  ),
                  // Web 的 `#side-more .global-links` 里，「任务图谱」夹在记忆图谱和
                  // 设置中心之间（`air.html`）；App 少这一行就会和 Web 对不上。
                  _CompactRow(
                    semanticKey: 'air-more-task-graph',
                    icon: Icons.account_tree_outlined,
                    label: '任务图谱',
                    onTap: onOpenTaskGraph,
                  ),
                  _CompactRow(
                    semanticKey: 'air-more-settings',
                    icon: Icons.settings_outlined,
                    label: '设置中心',
                    onTap: onOpenSettings,
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 6),
          // App 独有三行：Web Air 的侧栏里没有它们（看板在 Web 是顶层入口、
          // 「全部功能」走别的路、语音通话是原生独占）。单开一格，不跟上面那四个
          // 全局页挤在同一个框里 —— 「服务与文档 / 记忆图谱 / 任务图谱 / 设置中心」
          // 是一组，多塞三行进去，这一组的边界就说不清是哪四行了。
          _SideGroupBox(
            groupKey: 'air-group-entries',
            child: Padding(
              padding: const EdgeInsets.fromLTRB(4, 4, 4, 4),
              child: _Grid2(
                children: [
                  _CompactRow(
                    semanticKey: 'air-more-board',
                    icon: Icons.view_kanban_outlined,
                    label: '查看任务看板',
                    onTap: onOpenTaskBoard,
                  ),
                  _CompactRow(
                    semanticKey: 'air-more-all',
                    icon: Icons.apps_rounded,
                    label: '全部功能',
                    onTap: onOpenAllDestinations,
                  ),
                  if (onOpenVoiceCall != null)
                    _CompactRow(
                      semanticKey: 'air-more-voice-call',
                      icon: Icons.mic_rounded,
                      label: '语音通话 · BETA',
                      onTap: onOpenVoiceCall!,
                    ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 6),
          // Web 的 `#side-more` 里紧跟着「查看任务看板」的就是这一组（`air.html`
          // 的 `details.terminal-group`）——终端会话是这个目录里另一类存在，
          // 不属于任务列表，但也在同一个目录下。它自己是个 ExpansionTile，套上
          // 同一个框就算这一组。
          _SideGroupBox(
            groupKey: 'air-group-terminal',
            child: _TerminalGroup(
              sessions: terminalSessions,
              onOpen: onOpenTerminal,
            ),
          ),
          const SizedBox(height: 6),
          // 主机这一组：开机读数 + 运维动作 + 推送与退出登录，再加开发者选项。
          // Web 那边它拆成「最近启动」和「主机操作」两栏，App 的运维面板本来就是
          // 一整块（`AirOpsPanel`），套一个框即可。
          _SideGroupBox(
            groupKey: 'air-group-host',
            child: Padding(
              padding: const EdgeInsets.fromLTRB(4, 4, 4, 2),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  AirOpsPanel(
                    store: ops,
                    onOpenPush: onOpenPush,
                    onLogout: onLogout,
                  ),
                  Semantics(
                    key: const ValueKey('air-more-advanced'),
                    toggled: advancedMode,
                    label: '开发者选项',
                    child: Padding(
                      padding: const EdgeInsets.fromLTRB(6, 0, 4, 0),
                      child: Row(
                        children: [
                          const Icon(
                            Icons.tune_rounded,
                            size: 18,
                            color: AppColors.muted,
                          ),
                          const SizedBox(width: 11),
                          const Expanded(
                            child: Text(
                              '开发者选项',
                              style: TextStyle(
                                color: AppColors.muted,
                                fontSize: 13.5,
                              ),
                            ),
                          ),
                          Switch.adaptive(
                            value: advancedMode,
                            onChanged: onAdvancedModeChanged,
                            activeTrackColor: AppColors.accent.withValues(
                              alpha: 0.55,
                            ),
                            activeColor: AppColors.accent,
                          ),
                        ],
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// 「更多与系统」里每一组各套一个框（Web `air.css` 的 `.side-group`）。
///
/// 框很轻：一条淡边 + 半透明白底，只负责分组，不跟里面的行抢注意力。
class _SideGroupBox extends StatelessWidget {
  const _SideGroupBox({required this.groupKey, required this.child});

  /// 给测试一个抓手：Web 那边按 `.side-group` 数框，Flutter 这边没有 class 可查，
  /// 只能靠 key —— 「哪几行在同一个框里」是这次改动的全部内容。
  final String groupKey;

  final Widget child;

  @override
  Widget build(BuildContext context) => DecoratedBox(
    key: ValueKey(groupKey),
    decoration: BoxDecoration(
      color: AppColors.panel.withValues(alpha: 0.55),
      border: Border.all(color: AppColors.line),
      borderRadius: BorderRadius.circular(13),
    ),
    child: child,
  );
}

/// 两列网格（Web `.frequent-settings` 的 `grid-template-columns: 1fr 1fr`）。
///
/// 用 Row + Expanded 而不是 Wrap：Wrap 的每一格宽度由内容决定，两列的左边缘就
/// 对不齐了（「关盖运行」那行还带个开关，宽度和旁边几行差得更多）。奇数个成员时
/// 最后一行补一个空位，免得那一格自己撑满整行。
class _Grid2 extends StatelessWidget {
  const _Grid2({required this.children});

  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    final rows = <Widget>[];
    for (var i = 0; i < children.length; i += 2) {
      if (i > 0) rows.add(const SizedBox(height: 2));
      rows.add(
        Row(
          children: [
            Expanded(child: children[i]),
            const SizedBox(width: 4),
            Expanded(
              child: i + 1 < children.length
                  ? children[i + 1]
                  : const SizedBox.shrink(),
            ),
          ],
        ),
      );
    }
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: rows);
  }
}

/// 两列里的一格（Web `.sidebar-setting-row`）。
///
/// 比 [_NavRow] 矮一档也小一号字：一列摆得下 46px 的行，两列每格只有一百像素
/// 出头，按一列那套尺寸排，「Provider 配置」会被挤到换行。
class _CompactRow extends StatelessWidget {
  const _CompactRow({
    required this.semanticKey,
    required this.icon,
    required this.label,
    required this.onTap,
    this.emphasized = false,
    this.toggled,
    this.trailing,
  });

  final String semanticKey;
  final IconData icon;
  final String label;
  final VoidCallback onTap;

  /// 加粗变色（Provider 配置）。这一组里只有它是「最常点的那个入口」。
  final bool emphasized;

  /// 开关型的一格：给语义树一个状态，读屏才知道它现在开着没有。
  final bool? toggled;

  /// 行尾的尾巴（现在只有开关）。
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    final color = emphasized ? AppColors.accent : AppColors.muted;
    return Semantics(
      key: ValueKey(semanticKey),
      button: true,
      toggled: toggled,
      label: label,
      child: Material(
        color: Colors.transparent,
        borderRadius: BorderRadius.circular(9),
        child: InkWell(
          excludeFromSemantics: true,
          onTap: onTap,
          borderRadius: BorderRadius.circular(9),
          child: SizedBox(
            height: 34,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 4),
              child: Row(
                children: [
                  Icon(icon, size: 15, color: color),
                  const SizedBox(width: 7),
                  Expanded(
                    child: Text(
                      label,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: color,
                        fontSize: 12.5,
                        fontWeight: emphasized
                            ? FontWeight.w700
                            : FontWeight.w500,
                      ),
                    ),
                  ),
                  if (trailing != null) ...[
                    const SizedBox(width: 4),
                    trailing!,
                  ],
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// 关盖运行那格的迷你开关（Web `.row-switch` 的 19×11）。
///
/// 这是滑块不是勾选：行只有 34px 高，Material 的 `Switch` 缩到能放进来之后更难
/// 看清哪边是开。尺寸按 Web 那套来，两边看起来才是同一个开关。
class _MiniSwitch extends StatelessWidget {
  const _MiniSwitch({required this.on});

  final bool on;

  @override
  Widget build(BuildContext context) => AnimatedContainer(
    duration: const Duration(milliseconds: 180),
    width: 26,
    height: 15,
    padding: const EdgeInsets.all(2),
    alignment: on ? Alignment.centerRight : Alignment.centerLeft,
    decoration: BoxDecoration(
      color: on ? AppColors.accent : AppColors.line,
      borderRadius: BorderRadius.circular(999),
    ),
    child: Container(
      width: 11,
      height: 11,
      decoration: const BoxDecoration(
        color: Colors.white,
        shape: BoxShape.circle,
      ),
    ),
  );
}

/// TERMINAL 一组（Web `air.html` 的 `details.terminal-group` + `#legacy-sessions`）。
///
/// 里面是**当前目录**的终端会话 —— Web 那句 `session.dirId === directoryId` 是
/// 这一组真正的筛选条件（`kind === 'terminal'` 只是二次防御，服务端已经滤过
/// 一遍了）。点一行就开那个终端。
class _TerminalGroup extends StatelessWidget {
  const _TerminalGroup({required this.sessions, required this.onOpen});

  final List<AirSession> sessions;
  final ValueChanged<AirSession> onOpen;

  @override
  Widget build(BuildContext context) {
    return Theme(
      data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
      child: ExpansionTile(
        key: const ValueKey('air-terminal-group'),
        tilePadding: const EdgeInsets.symmetric(horizontal: 18),
        childrenPadding: const EdgeInsets.only(bottom: 4),
        title: const Text(
          'TERMINAL',
          style: TextStyle(
            color: AppColors.faint,
            fontSize: 11.5,
            fontWeight: FontWeight.w600,
            letterSpacing: 0.8,
          ),
        ),
        iconColor: AppColors.faint,
        collapsedIconColor: AppColors.faint,
        children: [
          // Web 那边空的时候就是一个空的 `<nav>`（点开什么都不显示）。手机上
          // 那样看起来像坏了，所以给一句说明 —— 空的是「这个目录没有终端」，
          // 不是「这一组坏了」。
          if (sessions.isEmpty)
            const Padding(
              padding: EdgeInsets.fromLTRB(34, 0, 18, 12),
              child: Text(
                '本目录暂无终端会话',
                style: TextStyle(color: AppColors.faint, fontSize: 12.5),
              ),
            )
          else
            for (final session in sessions)
              _NavRow(
                semanticKey: 'air-terminal-${session.id}',
                icon: Icons.terminal_rounded,
                label: session.label,
                onTap: () => onOpen(session),
              ),
        ],
      ),
    );
  }
}
