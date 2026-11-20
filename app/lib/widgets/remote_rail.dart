// 右缘（或左缘）竖栏：幕布形态下唯一常驻的控制入口。
//
// 每个图标 = 一个动作或一个面板。收起后画面上只剩一条 10dp 的细线：远控第一
// 需求是看清远端，所以常态下的 chrome 必须几乎为零。
//
// 两条不显而易见的规则：
//  · **画的是 10dp，摸的是 44dp。** 触条的命中区按 Material 的最小可点尺寸
//    外扩（透明），否则收起之后要在动着的画面边缘戳一条 10dp 的线才能回来。
//  · **触条认轻点也认横向滑入。** 从边缘往里一划就展开，是手机上「拉抽屉」的
//    肌肉记忆；只在收起态挂这个手势，所以不会抢走画面上的拖拽。
//  · 首次进入时 [showLabels] 为真：图标旁边直接写字，三秒后自己收成图标。
//    用一次演示代替说明书 —— 提示卡没人看。
import 'package:flutter/material.dart';

const Color _kRailBg = Color(0xE6161b26);
const Color _kRailBorder = Color(0xFF2a3242);
const Color _kRailIcon = Color(0xFFdce6f1);
const Color _kRailAccent = Color(0xFF2ba67a);
const Color _kRailDanger = Color(0xFFe07a7a);

/// 侧栏宽度（放置函数与组件共用）。
const double remoteRailWidth = 48;
const double remoteRailItem = 44;

/// 收起态触条：画 10dp，命中区 [remoteRailItem]。
const double remoteRailHandlePaint = 10;
const double remoteRailHandleHeight = 96;

/// 带文字标签时的栏宽（首次进入的一次性演示）。
const double remoteRailLabelledWidth = 168;

class RemoteRailEntry {
  const RemoteRailEntry({
    required this.id,
    required this.icon,
    required this.label,
    this.short,
    this.active = false,
    this.danger = false,
  });

  final String id;
  final IconData icon;

  /// 长按气泡与无障碍标签（一句话，说清这一项管什么）。
  final String label;

  /// 首次进入时写在图标旁边的短名；缺省就用 [label]。
  final String? short;
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
    this.showLabels = false,
    this.onLeft = false,
  });

  final List<RemoteRailEntry> entries;

  /// false = 只画一条触条（点它、或从边缘往里一划都能展开）。
  final bool expanded;
  final VoidCallback onExpand;
  final void Function(String id) onAction;

  /// 首次进入：图标旁边写字（见文件头）。
  final bool showLabels;

  /// 栏贴在左缘：触条的「往里划」方向要跟着镜像。
  final bool onLeft;

  @override
  Widget build(BuildContext context) {
    if (!expanded) return _handle(context);
    return _bar();
  }

  /// 收起态：10dp 的线画在 44dp 的透明命中区中间；轻点或往里划都展开。
  Widget _handle(BuildContext context) {
    return Semantics(
      button: true,
      label: MaterialLocalizations.of(context).showMenuTooltip,
      child: GestureDetector(
        key: const ValueKey('rs-rail-handle'),
        behavior: HitTestBehavior.opaque,
        onTap: onExpand,
        onLongPress: onExpand,
        // 往里划 = 展开。看位移而不是甩动速度：慢慢拖也该开。只在收起态挂这个
        // 手势，所以画面上的拖拽不受影响；onExpand 幂等，重复调用无副作用。
        // 能走到 update 就说明已经越过了横向拖拽死区（约 18dp），所以任何一帧
        // 的朝内位移都算真的在往里拉 —— 不要按单帧位移设阈值：甩动被拆成 50 步，
        // 每步只有不到 1dp。
        onHorizontalDragUpdate: (d) {
          final inward = onLeft ? d.delta.dx : -d.delta.dx;
          if (inward > 0) onExpand();
        },
        child: SizedBox(
          width: remoteRailItem,
          height: remoteRailHandleHeight,
          child: Center(
            child: Container(
              width: remoteRailHandlePaint,
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
        ),
      ),
    );
  }

  Widget _bar() {
    return Container(
      key: const ValueKey('rs-rail'),
      width: showLabels ? remoteRailLabelledWidth : remoteRailWidth,
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
            _RailButton(
              entry: entry,
              onTap: () => onAction(entry.id),
              showLabel: showLabels,
            ),
        ],
      ),
    );
  }
}

class _RailButton extends StatelessWidget {
  const _RailButton({
    required this.entry,
    required this.onTap,
    this.showLabel = false,
  });

  final RemoteRailEntry entry;
  final VoidCallback onTap;
  final bool showLabel;

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
            width: showLabel ? remoteRailLabelledWidth - 8 : remoteRailItem,
            height: remoteRailItem,
            child: showLabel
                ? Row(
                    children: [
                      SizedBox(
                        width: remoteRailItem,
                        child: Icon(entry.icon, size: 22, color: color),
                      ),
                      Expanded(
                        child: Text(
                          entry.short ?? entry.label,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(fontSize: 12.5, color: color),
                        ),
                      ),
                    ],
                  )
                : Icon(entry.icon, size: 22, color: color),
          ),
        ),
      ),
    );
  }
}
