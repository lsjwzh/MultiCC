import 'package:flutter/material.dart';

import '../../services/air_service.dart';
import '../../theme.dart';
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
/// Web 侧栏还有一组「收藏目录」，这里没有 —— 工作目录本来就不会很多，一组随时
/// 可能空的快捷方式和它下面那条分隔线都是白占位置。`AirLocalStore` 里那套收藏
/// 读写留着（数据还在，只是不再有界面展示它）。
class AirSidebar extends StatelessWidget {
  const AirSidebar({
    super.key,
    required this.data,
    required this.directoryId,
    required this.recentTasks,
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
    required this.onOpenSettings,
    required this.onOpenAllDestinations,
    required this.ops,
    required this.onOpenPush,
    required this.onLogout,
    this.onOpenVoiceCall,
    this.onAdvancedModeChanged,
  });

  static const double width = 268;
  static const double _rowHeight = 46;

  final AirSnapshot? data;
  final String? directoryId;
  final List<AirTask> recentTasks;
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
  final VoidCallback onOpenSettings;
  final VoidCallback onOpenAllDestinations;

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
        // 整条侧栏一起滚，而不是让中间那段自己滚：短屏上「更多与系统」一展开，
        // 固定的下半截就会把版面顶破。Web 那边整条 aside 也是 `overflow: auto`。
        // 内容不够高时 Spacer 把底部那组压到屏幕下沿（同 Web 的 `.side-bottom`）。
        child: LayoutBuilder(
          builder: (context, constraints) => SingleChildScrollView(
            child: ConstrainedBox(
              constraints: BoxConstraints(minHeight: constraints.maxHeight),
              child: IntrinsicHeight(
                child: Column(
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
              padding: const EdgeInsets.fromLTRB(12, 4, 12, 8),
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
                  for (final task in recentTasks)
                    _TaskRow(task: task, onTap: () => onOpenTask(task)),
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
            // 剩下的空档都留在下面这组之前，内容不够高时底部这组就贴着下沿。
            const Spacer(),
            // 版本行留在折叠区外：它是「有新版本」唯一的落点，折起来就没人知道。
            AirVersionRow(store: ops),
            _MoreSection(
              advancedMode: advancedMode,
              onAdvancedModeChanged: onAdvancedModeChanged,
              onOpenDocs: onOpenDocs,
              onOpenMemory: onOpenMemory,
              onOpenSettings: onOpenSettings,
              onOpenTaskBoard: onOpenTaskBoard,
              terminalSessions: terminalSessions,
              onOpenTerminal: onOpenTerminal,
              onOpenAllDestinations: onOpenAllDestinations,
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
          ),
        ),
      ),
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
  const _TaskRow({required this.task, required this.onTap});

  final AirTask task;
  final VoidCallback onTap;

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
          ],
        ),
      ),
    );
  }
}

/// 「更多与系统」：偶尔点的东西。折叠起来，但**回执不折**——运维动作的结果要
/// 看得见，这是 Web 版把 `#air-ops-status` 留在折叠区外的原因。
class _MoreSection extends StatelessWidget {
  const _MoreSection({
    required this.advancedMode,
    required this.onAdvancedModeChanged,
    required this.onOpenDocs,
    required this.onOpenMemory,
    required this.onOpenSettings,
    required this.onOpenTaskBoard,
    required this.terminalSessions,
    required this.onOpenTerminal,
    required this.onOpenAllDestinations,
    required this.ops,
    required this.onOpenPush,
    required this.onLogout,
    this.onOpenVoiceCall,
  });

  final bool advancedMode;
  final ValueChanged<bool>? onAdvancedModeChanged;
  final VoidCallback onOpenDocs;
  final VoidCallback onOpenMemory;
  final VoidCallback onOpenSettings;
  final VoidCallback onOpenTaskBoard;
  final List<AirSession> terminalSessions;
  final ValueChanged<AirSession> onOpenTerminal;
  final VoidCallback onOpenAllDestinations;
  final AirOpsStore ops;
  final VoidCallback onOpenPush;
  final VoidCallback onLogout;

  /// 机器级语音通话。原生独占 —— Web 侧没有对应页面。
  final VoidCallback? onOpenVoiceCall;

  @override
  Widget build(BuildContext context) {
    return Theme(
      data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
      child: ExpansionTile(
        key: const ValueKey('air-more-section'),
        tilePadding: const EdgeInsets.symmetric(horizontal: 18),
        childrenPadding: const EdgeInsets.only(bottom: 4),
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
          _NavRow(
            semanticKey: 'air-more-docs',
            icon: Icons.travel_explore_outlined,
            label: '服务与文档',
            onTap: onOpenDocs,
          ),
          _NavRow(
            semanticKey: 'air-more-memory',
            icon: Icons.hub_outlined,
            label: '记忆图谱',
            onTap: onOpenMemory,
          ),
          _NavRow(
            semanticKey: 'air-more-settings',
            icon: Icons.settings_outlined,
            label: '设置中心',
            onTap: onOpenSettings,
          ),
          _NavRow(
            semanticKey: 'air-more-board',
            icon: Icons.view_kanban_outlined,
            label: '查看任务看板',
            onTap: onOpenTaskBoard,
          ),
          // Web 的 `#side-more` 里紧跟着「查看任务看板」的就是这一组（`air.html`
          // 的 `details.terminal-group`）——终端会话是这个目录里另一类存在，
          // 不属于任务列表，但也在同一个目录下。
          _TerminalGroup(
            sessions: terminalSessions,
            onOpen: onOpenTerminal,
          ),
          _NavRow(
            semanticKey: 'air-more-all',
            icon: Icons.apps_rounded,
            label: '全部功能',
            onTap: onOpenAllDestinations,
          ),
          // 语音通话是原生独占的，Web Air 的侧栏里没有这一行。
          if (onOpenVoiceCall != null)
            _NavRow(
              semanticKey: 'air-more-voice-call',
              icon: Icons.mic_rounded,
              label: '语音通话 · BETA',
              onTap: onOpenVoiceCall!,
            ),
          AirOpsPanel(store: ops, onOpenPush: onOpenPush, onLogout: onLogout),
          Semantics(
            key: const ValueKey('air-more-advanced'),
            toggled: advancedMode,
            label: '开发者选项',
            child: Padding(
              padding: const EdgeInsets.fromLTRB(10, 0, 8, 0),
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
                      style: TextStyle(color: AppColors.muted, fontSize: 13.5),
                    ),
                  ),
                  Switch.adaptive(
                    value: advancedMode,
                    onChanged: onAdvancedModeChanged,
                    activeTrackColor: AppColors.accent.withValues(alpha: 0.55),
                    activeColor: AppColors.accent,
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
