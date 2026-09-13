import 'package:flutter/material.dart';

import '../../services/air_service.dart';
import '../../theme.dart';
import 'air_task_status.dart';

/// Air 的侧栏（Web `public/air.html` 的 `#sidebar`）。
///
/// 频次收敛和 Web 一样：每天点的（当前工作目录、控制台、定时任务、收藏目录、
/// 最近任务、新任务）留在外面；偶尔点的（服务与文档、记忆图谱、设置中心、任务
/// 看板、开发者选项）折进「更多与系统」。手机上没有 ⌘K，找全部目录的入口就是
/// 顶上那张目录卡片。
class AirSidebar extends StatelessWidget {
  const AirSidebar({
    super.key,
    required this.data,
    required this.directoryId,
    required this.favorites,
    required this.recentTasks,
    required this.advancedMode,
    required this.serverLabel,
    required this.onSelectDirectory,
    required this.onToggleFavorite,
    required this.onOpenLibrary,
    required this.onOpenSearch,
    required this.onOpenConsole,
    required this.onOpenSchedules,
    required this.onOpenTaskBoard,
    required this.onCreateTask,
    required this.onOpenTask,
    required this.onOpenDocs,
    required this.onOpenMemory,
    required this.onOpenSettings,
    required this.onOpenAllDestinations,
    this.onOpenVoiceCall,
    this.onAdvancedModeChanged,
  });

  static const double width = 268;
  static const double _rowHeight = 46;

  final AirSnapshot? data;
  final String? directoryId;
  final List<String> favorites;
  final List<AirTask> recentTasks;
  final bool advancedMode;
  final String serverLabel;
  final ValueChanged<String> onSelectDirectory;
  final VoidCallback onToggleFavorite;
  final VoidCallback onOpenLibrary;

  /// ⌘K 那一件事：目录和任务一起搜。手机上没有 ⌘K，所以侧栏上明摆着一行。
  final VoidCallback onOpenSearch;
  final VoidCallback onOpenConsole;
  final VoidCallback onOpenSchedules;
  final VoidCallback onOpenTaskBoard;
  final VoidCallback onCreateTask;
  final ValueChanged<AirTask> onOpenTask;
  final VoidCallback onOpenDocs;
  final VoidCallback onOpenMemory;
  final VoidCallback onOpenSettings;
  final VoidCallback onOpenAllDestinations;
  final VoidCallback? onOpenVoiceCall;
  final ValueChanged<bool>? onAdvancedModeChanged;

  AirDirectory? get _directory => data?.directoryOf(directoryId);

  @override
  Widget build(BuildContext context) {
    final directory = _directory;
    final urgentCount = airUrgentTasks(data?.tasks ?? const []).length;
    final favoriteDirectories =
        (data?.directories ?? const <AirDirectory>[])
            .where((d) => favorites.contains(d.id))
            .take(AirLocalStore.favoriteLimit)
            .toList();
    return Drawer(
      width: width,
      elevation: 0,
      backgroundColor: AppColors.bgSoft,
      shape: const Border(right: BorderSide(color: AppColors.line)),
      child: SafeArea(
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
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(12, 4, 12, 8),
                children: [
                  _SpaceCard(
                    directory: directory,
                    favorite: directory != null && favorites.contains(directory.id),
                    onOpen: onOpenLibrary,
                    onToggleFavorite: onToggleFavorite,
                  ),
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
                  if (favoriteDirectories.isNotEmpty) ...[
                    const _Caption('收藏目录'),
                    for (final item in favoriteDirectories)
                      _NavRow(
                        semanticKey: 'air-favorite-${item.id}',
                        icon: Icons.star_rounded,
                        iconColor: AppColors.accent,
                        label: item.name,
                        selected: item.id == directoryId,
                        onTap: () => onSelectDirectory(item.id),
                      ),
                  ],
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
            _MoreSection(
              advancedMode: advancedMode,
              onAdvancedModeChanged: onAdvancedModeChanged,
              onOpenDocs: onOpenDocs,
              onOpenMemory: onOpenMemory,
              onOpenSettings: onOpenSettings,
              onOpenTaskBoard: onOpenTaskBoard,
              onOpenAllDestinations: onOpenAllDestinations,
              onOpenVoiceCall: onOpenVoiceCall,
            ),
            const Divider(height: 1, color: AppColors.line),
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
    );
  }
}

/// 顶上那张卡：当前工作目录 + 收藏开关。点卡片本身去目录库（Web 的
/// `.space-main`），右边的星号只收藏（Web 的 `#favorite`）。
class _SpaceCard extends StatelessWidget {
  const _SpaceCard({
    required this.directory,
    required this.favorite,
    required this.onOpen,
    required this.onToggleFavorite,
  });

  final AirDirectory? directory;
  final bool favorite;
  final VoidCallback onOpen;
  final VoidCallback onToggleFavorite;

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
              IconButton(
                key: const ValueKey('air-favorite-toggle'),
                onPressed: directory == null ? null : onToggleFavorite,
                iconSize: 17,
                visualDensity: VisualDensity.compact,
                tooltip: favorite ? '取消收藏当前工作目录' : '收藏当前工作目录',
                icon: Icon(
                  favorite ? Icons.star_rounded : Icons.star_border_rounded,
                  color: favorite ? AppColors.accent : AppColors.faint,
                ),
              ),
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

class _NavRow extends StatelessWidget {
  const _NavRow({
    required this.semanticKey,
    required this.icon,
    required this.label,
    required this.onTap,
    this.selected = false,
    this.iconColor,
    this.badge,
  });

  final String semanticKey;
  final IconData icon;
  final String label;
  final VoidCallback onTap;
  final bool selected;
  final Color? iconColor;

  /// 行尾的数字（控制台挂的是「谁在等我」的条数）。0 不显示。
  final String? badge;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      key: ValueKey(semanticKey),
      button: true,
      selected: selected,
      label: badge == null ? label : '$label，$badge 项待处理',
      child: Material(
        color: selected ? const Color(0x241678e8) : Colors.transparent,
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
                Icon(icon, size: 18, color: iconColor ?? AppColors.muted),
                const SizedBox(width: 11),
                Expanded(
                  child: Text(
                    label,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      color: selected ? AppColors.text : AppColors.muted,
                      fontSize: 13.5,
                      fontWeight: selected ? FontWeight.w600 : FontWeight.w500,
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
    required this.onOpenAllDestinations,
    required this.onOpenVoiceCall,
  });

  final bool advancedMode;
  final ValueChanged<bool>? onAdvancedModeChanged;
  final VoidCallback onOpenDocs;
  final VoidCallback onOpenMemory;
  final VoidCallback onOpenSettings;
  final VoidCallback onOpenTaskBoard;
  final VoidCallback onOpenAllDestinations;

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
