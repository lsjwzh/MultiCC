// 右缘（或左缘）竖栏：幕布形态下唯一常驻的控制入口。
//
// 每个图标 = 一个动作或一个面板。收起后只剩一条 10dp 的触条：远控第一需求
// 是看清远端，所以常态下的 chrome 必须几乎为零（参考 iPad 远控 App 的做法）。
import 'package:flutter/material.dart';

const Color _kRailBg = Color(0xE6161b26);
const Color _kRailBorder = Color(0xFF2a3242);
const Color _kRailIcon = Color(0xFFdce6f1);
const Color _kRailAccent = Color(0xFF2ba67a);
const Color _kRailDanger = Color(0xFFe07a7a);

/// 侧栏宽度（放置函数与组件共用）。
const double remoteRailWidth = 48;
const double remoteRailItem = 44;

class RemoteRailEntry {
  const RemoteRailEntry({
    required this.id,
    required this.icon,
    required this.label,
    this.active = false,
    this.danger = false,
  });

  final String id;
  final IconData icon;

  /// 长按气泡与无障碍标签。
  final String label;
  final bool active;
  final bool danger;
}

class RemoteRail extends StatelessWidget {
  const RemoteRail({
    super.key,
    required this.entries,
    required this.expanded,
    required this.onExpand,
    required this.onAction,
  });

  final List<RemoteRailEntry> entries;

  /// false = 只画一条触条（点它展开）。
  final bool expanded;
  final VoidCallback onExpand;
  final void Function(String id) onAction;

  @override
  Widget build(BuildContext context) {
    if (!expanded) {
      return Semantics(
        button: true,
        label: MaterialLocalizations.of(context).showMenuTooltip,
        child: GestureDetector(
          key: const ValueKey('rs-rail-handle'),
          behavior: HitTestBehavior.opaque,
          onTap: onExpand,
          onLongPress: onExpand,
          child: Container(
            width: 10,
            height: 78,
            decoration: BoxDecoration(
              color: const Color(0x99161b26),
              borderRadius: BorderRadius.circular(5),
              border: Border.all(color: _kRailBorder),
            ),
            child: Center(
              child: Container(
                width: 3,
                height: 34,
                decoration: BoxDecoration(
                  color: const Color(0x66dce6f1),
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
            ),
          ),
        ),
      );
    }
    return Container(
      key: const ValueKey('rs-rail'),
      width: remoteRailWidth,
      padding: const EdgeInsets.symmetric(vertical: 4),
      decoration: BoxDecoration(
        color: _kRailBg,
        borderRadius: BorderRadius.circular(remoteRailWidth / 2),
        border: Border.all(color: _kRailBorder),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          for (final entry in entries)
            _RailButton(entry: entry, onTap: () => onAction(entry.id)),
        ],
      ),
    );
  }
}

class _RailButton extends StatelessWidget {
  const _RailButton({required this.entry, required this.onTap});

  final RemoteRailEntry entry;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final color = entry.danger
        ? _kRailDanger
        : entry.active
        ? _kRailAccent
        : _kRailIcon;
    return Semantics(
      button: true,
      selected: entry.active,
      label: entry.label,
      excludeSemantics: true,
      child: Tooltip(
        message: entry.label,
        preferBelow: false,
        waitDuration: const Duration(milliseconds: 350),
        child: InkResponse(
          key: ValueKey('rs-rail-${entry.id}'),
          onTap: onTap,
          radius: remoteRailItem / 2,
          child: SizedBox(
            width: remoteRailItem,
            height: remoteRailItem,
            child: Icon(entry.icon, size: 22, color: color),
          ),
        ),
      ),
    );
  }
}
