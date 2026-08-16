// 后台任务悬浮球：BackgroundTaskBoard 的可拖动入口。
//
// 之前 chat_screen 用固定 Positioned(right:14, bottom:96|160) 常驻挂
// BackgroundTaskPanel，与 pending-input FAB 一起挤占右下角。现在与 Dispatch
// 悬浮球共用同一 [FloatingDock] primitive（拖动 / 吸附 / 持久化 / 锚定），
// 各自独立的持久化 key；badge 口径 = 仍在转圈（start 态）的任务数。
//
// 与 Dispatch 球的协调：Dispatch 优先级更高，其当前锚点经 [obstacle] 传入，
// 本球在 build clamp 与 settle 两处确定性避让（同侧不重叠，优先落在上方）。
// 语义边界不变：只渲染 BackgroundTaskBoard 的行状态（spin/done/fail/stale、
// 本地 ✕ dismiss、auto-hide），不碰 background_tasks 权威快照与 monitor_*
// 状态机。
import 'package:flutter/material.dart';

import '../i18n.dart';
import '../models/background_task_board.dart';
import 'background_task_panel.dart';
import 'floating_dock.dart';

/// Persistence keys — independent from the dispatch dock's.
const String _kDockSidePref = 'multicc_bg_dock_side';
const String _kDockDyPref = 'multicc_bg_dock_dy';

class BackgroundTasksFloatingDock extends StatelessWidget {
  final List<BackgroundTaskRow> rows;
  final void Function(String key) onDismiss;
  final ValueChanged<bool>? onExpandedChanged;

  /// Same-side anchor of the dispatch dock (higher priority) — this dock
  /// yields to it so the two icons never overlap.
  final FloatingDockAnchor? obstacle;

  final double leftMinBottom;
  final double rightMinBottom;

  const BackgroundTasksFloatingDock({
    super.key,
    required this.rows,
    required this.onDismiss,
    this.onExpandedChanged,
    this.obstacle,
    this.leftMinBottom = 96,
    this.rightMinBottom = 96,
  });

  @override
  Widget build(BuildContext context) {
    final running =
        rows.where((r) => r.state == BackgroundTaskState.start).length;
    return FloatingDock(
      visible: rows.isNotEmpty,
      badgeCount: running,
      icon: Icons.terminal_rounded,
      iconColor: const Color(0xFF238636),
      iconBorder: const Color(0xFF3fb950),
      // Unified compact entry: same 24dp visible circle as the dispatch dock
      // (the user asked every draggable floating icon to shrink). FloatingDock
      // keeps the full 48dp touch/drag/a11y box around it.
      visualSize: 24,
      tooltip: (expanded) => t(
        expanded ? 'bgDockExpanded' : 'bgDockCollapsed',
        {'n': '$running'},
      ),
      panelBuilder: (context, onCollapse) => BackgroundTaskPanel(
        key: const Key('bg-dock-panel'),
        rows: rows,
        onDismiss: onDismiss,
        initiallyExpanded: true,
        onExpandedChanged: (value) {
          if (!value) onCollapse();
        },
      ),
      panelWidth: (viewportWidth) =>
          viewportWidth > 360 ? 320.0 : viewportWidth - 28,
      sidePrefKey: _kDockSidePref,
      dyPrefKey: _kDockDyPref,
      leftMinBottom: leftMinBottom,
      rightMinBottom: rightMinBottom,
      obstacle: obstacle,
      onExpandedChanged: onExpandedChanged,
      iconKey: const Key('bg-dock-icon'),
      badgeKey: const Key('bg-dock-badge'),
    );
  }
}
