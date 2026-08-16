// 派发悬浮球：Dispatch 队列的可拖动入口。
//
// 拖动 / 吸附 / 持久化 / 面板锚定全部来自共享的 [FloatingDock] primitive
// （floating_dock.dart），这里只提供 Dispatch 特有的三样东西：badge 口径
// （非终态条目数）、展开面板（DispatchQueuePanel 原样复用：方向 / 对端 /
// 模式 / 排位 / 运行状态 / 刷新）和面板宽度规则。Background Tasks 悬浮球
// 用同一 primitive、各自独立的持久化 key。
//
// 语义边界不变：这只是 DispatchQueueEntry 的展示层，与暂存消息队列、
// TaskBoard / 后台任务（background_tasks）无关；DTO 不带 prompt 文本。
import 'package:flutter/material.dart';

import '../i18n.dart';
import '../models/dispatch_queue.dart';
import 'chat_runtime_panels.dart';
import 'floating_dock.dart';

/// How the icon position is persisted: side ('left'/'right') plus a vertical
/// fraction (0.0 = top margin, 1.0 = bottom limit of the usable band). A side
/// + fraction survives width changes (an edge stays an edge) better than two
/// raw fractions would.
const String _kDockSidePref = 'multicc_dispatch_dock_side';
const String _kDockDyPref = 'multicc_dispatch_dock_dy';

class DispatchFloatingDock extends StatelessWidget {
  final List<DispatchQueueEntry> entries;
  final String Function(String sessionId) resolveName;
  final Future<void> Function()? onRefresh;
  final ValueChanged<DispatchQueueEntry>? onOpenSession;
  final ValueChanged<bool>? onExpandedChanged;

  /// See [FloatingDock.onAnchorChanged] — the chat screen forwards this to
  /// the background-tasks dock as its obstacle anchor.
  final void Function(bool sideRight, double top)? onAnchorChanged;

  /// Distance between the parent Stack's bottom edge and the icon's bottom
  /// when snapped LEFT — keeps the icon clear of the input bar (and its send
  /// button). The chat screen passes a value matched to its input area.
  final double leftMinBottom;

  /// Same, but when snapped RIGHT, where the pending-input FAB already floats
  /// (chat_screen stacks it at bottom ~160). Deterministic priority: the dock
  /// always yields upward; it never sits on top of those controls.
  final double rightMinBottom;

  const DispatchFloatingDock({
    super.key,
    required this.entries,
    required this.resolveName,
    this.onRefresh,
    this.onOpenSession,
    this.onExpandedChanged,
    this.onAnchorChanged,
    this.leftMinBottom = 96,
    this.rightMinBottom = 96,
  });

  @override
  Widget build(BuildContext context) {
    final activeCount = entries.where((entry) => !entry.terminal).length;
    return FloatingDock(
      visible: entries.isNotEmpty,
      badgeCount: activeCount,
      icon: Icons.swap_vert_rounded,
      iconColor: const Color(0xFF1f6feb),
      iconBorder: const Color(0xFF6aa3ff),
      tooltip: (expanded) => t(
        expanded ? 'dispatchDockExpanded' : 'dispatchDockCollapsed',
        {'n': '$activeCount'},
      ),
      panelBuilder: (context, onCollapse) => DispatchQueuePanel(
        key: const Key('dispatch-dock-panel'),
        entries: entries,
        resolveName: resolveName,
        onRefresh: onRefresh,
        onOpenSession: onOpenSession,
        onExpandedChanged: (value) {
          if (!value) onCollapse();
        },
        initiallyExpanded: true,
      ),
      // Matches DispatchQueuePanel's own responsive width rule.
      panelWidth: (viewportWidth) =>
          viewportWidth > 388 ? 360.0 : viewportWidth - 28,
      sidePrefKey: _kDockSidePref,
      dyPrefKey: _kDockDyPref,
      leftMinBottom: leftMinBottom,
      rightMinBottom: rightMinBottom,
      onExpandedChanged: onExpandedChanged,
      onAnchorChanged: onAnchorChanged,
      iconKey: const Key('dispatch-dock-icon'),
      badgeKey: const Key('dispatch-dock-badge'),
    );
  }
}
