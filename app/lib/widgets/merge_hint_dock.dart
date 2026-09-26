// 「当前 worktree 有可合并内容」提示的两半：琥珀色横幅（查看 Diff / 合并 / 收起）
// 与收起后的那颗悬浮球（web 的 `#merge-hint` 与 `#merge-hint-fab`，
// chat-merge-hint.js）。
//
// 收起态以前是输入区上方一颗贴着右边缘的药丸 —— 位置由布局定死，挡着什么就只能
// 整个展开。现在与派发 / 后台任务 / 定时发送三个球共用同一个 [FloatingDock]
// primitive：按住跟手、松手吸附最近的左右边缘、位置按 side + 归一化纵向分数持久化，
// 旋转或改窗口大小自己回到界内。优先级最低 —— 那三个球的锚点经 [obstacle] /
// [extraObstacles] 递进来，同侧不互相压住。
//
// 收起是外面的事（[onCollapse]）：横幅自己只画这一屏，横幅与球的切换由 chat_screen
// 拿着一个 bool 决定，和 web 那边 `#merge-hint.collapsed` 的口径一致。
import 'package:flutter/material.dart';

import '../i18n.dart';
import 'floating_dock.dart';

/// 持久化 key：与本机其它悬浮球完全独立，各自记住各自的位置。
const String _kDockSidePref = 'multicc_merge_dock_side';
const String _kDockDyPref = 'multicc_merge_dock_dy';

/// 面板宽度：[FloatingDock] 用它算锚点，横幅自己也得按这个宽度排版 ——
/// 它的文案行是一条 Expanded，没有宽度约束会撑满整块屏幕（面板在 Stack 里
/// 只有 left/top，拿到的是满屏的松约束）。
double _panelWidth(double viewportWidth) =>
    viewportWidth > 400 ? 360.0 : viewportWidth - 28;

/// 琥珀色横幅本体。收起按钮只回调 [onCollapse]：横幅不持有收起状态。
class MergeHintBar extends StatelessWidget {
  final String text;
  final VoidCallback onMerge;
  final VoidCallback onDiff;
  final VoidCallback onCollapse;

  const MergeHintBar({
    super.key,
    required this.text,
    required this.onMerge,
    required this.onDiff,
    required this.onCollapse,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.fromLTRB(10, 0, 10, 6),
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      decoration: BoxDecoration(
        color: const Color(0xFFfff8eb),
        border: Border.all(color: const Color(0xFFa85a25)),
        borderRadius: BorderRadius.circular(8),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withValues(alpha: 0.28),
            blurRadius: 16,
            offset: const Offset(0, 8),
          ),
        ],
      ),
      child: Row(
        children: [
          const Icon(
            Icons.merge_type_rounded,
            size: 16,
            color: Color(0xFFa85a25),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              text,
              style: const TextStyle(color: Color(0xFFa85a25), fontSize: 12),
            ),
          ),
          TextButton(
            onPressed: onDiff,
            style: TextButton.styleFrom(
              foregroundColor: const Color(0xFFa85a25),
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
              minimumSize: Size.zero,
              side: const BorderSide(color: Color(0xFFa85a25)),
            ),
            child: Text(
              t('viewDiff'),
              style: const TextStyle(fontWeight: FontWeight.w600),
            ),
          ),
          const SizedBox(width: 6),
          TextButton(
            onPressed: onMerge,
            style: TextButton.styleFrom(
              foregroundColor: const Color(0xFFf4f8fd),
              backgroundColor: const Color(0xFFa85a25),
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
              minimumSize: Size.zero,
            ),
            child: Text(
              t('merge'),
              style: const TextStyle(fontWeight: FontWeight.w700),
            ),
          ),
          IconButton(
            key: const Key('merge-hint-collapse'),
            onPressed: onCollapse,
            icon: const Icon(Icons.keyboard_arrow_down_rounded, size: 20),
            tooltip: t('mergeHintCollapse'),
            visualDensity: VisualDensity.compact,
            padding: EdgeInsets.zero,
            constraints: const BoxConstraints(minWidth: 26, minHeight: 26),
            color: const Color(0xFFa85a25),
          ),
        ],
      ),
    );
  }
}

/// 收起态：贴边那颗可拖动的球，点开是同一个横幅（锚在球旁边）。
class MergeHintDock extends StatelessWidget {
  final String text;
  final VoidCallback onMerge;
  final VoidCallback onDiff;

  /// 同侧更高优先级入口的锚点（派发 / 后台任务 / 定时发送）。
  final FloatingDockAnchor? obstacle;
  final List<FloatingDockAnchor> extraObstacles;

  final double leftMinBottom;
  final double rightMinBottom;

  const MergeHintDock({
    super.key,
    required this.text,
    required this.onMerge,
    required this.onDiff,
    this.obstacle,
    this.extraObstacles = const <FloatingDockAnchor>[],
    this.leftMinBottom = 96,
    this.rightMinBottom = 96,
  });

  @override
  Widget build(BuildContext context) {
    return FloatingDock(
      // 父层只在「有可合并内容 + 已收起」时挂它，所以这里恒为可见。
      visible: true,
      badgeCount: 0,
      icon: Icons.merge_type_rounded,
      // 与横幅同一套琥珀色：球的形状变了，身份不变。
      iconColor: const Color(0xFFa85a25),
      iconBorder: const Color(0xFFa85a25),
      // 统一的小号球（与其它三个悬浮入口同一个 24dp）。
      visualSize: 24,
      tooltip: (expanded) =>
          t(expanded ? 'mergeHintCollapse' : 'mergeHintExpand'),
      panelBuilder: (context, onCollapse) => SizedBox(
        width: _panelWidth(MediaQuery.sizeOf(context).width),
        child: MergeHintBar(
          text: text,
          onMerge: onMerge,
          onDiff: onDiff,
          onCollapse: onCollapse,
        ),
      ),
      panelWidth: _panelWidth,
      sidePrefKey: _kDockSidePref,
      dyPrefKey: _kDockDyPref,
      leftMinBottom: leftMinBottom,
      rightMinBottom: rightMinBottom,
      obstacle: obstacle,
      extraObstacles: extraObstacles,
      // 沿用旧收起态那颗药丸的 key：测试与无障碍都按它找「收起后的入口」。
      iconKey: const Key('merge-hint-fab'),
    );
  }
}
