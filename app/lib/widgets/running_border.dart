import 'package:flutter/material.dart';

import '../theme.dart';
import '../utils/status_presentation.dart';

/// 运行中的卡片：一圈**静态**的加粗浅色描边，不再是彩虹。
///
/// 对应 Web 的 `.card-border-rainbow`（名字留在那边：JS 按类名切换状态）。两边是同
/// 一条规则的两个壳 —— 谁在跑这件事没变，变的只是它还动不动：
///   · 颜色按 [seed]（目录/会话 id）从 [ringTints] 里挑，同一个 id 每次都是同一个
///     色，彼此之间看着是随机的；没给 seed 就退回主题色，边不会整个消失。
///   · 原来是 3s 循环换色 + 带模糊光晕的阴影：逐帧重绘整张卡，而屏幕上只要一直有
///     东西在动，合成器就永远不归零（Web 端实测：关掉图形加速后这类动画约占一个
///     核里的大头）。静态描边照样看得见，而且不出帧。
///
/// 用法：把卡片包进来；[running] 为 false 时原样返回 child，调用方自己的静态边框
/// 不受影响。
class RunningBorder extends StatelessWidget {
  final bool running;
  final Widget child;
  final BorderRadius borderRadius;
  final double borderWidth;

  /// 决定颜色的 id。传 null 就用主题色（静态页、老调用点）。
  final String? seed;

  const RunningBorder({
    super.key,
    required this.running,
    required this.child,
    this.borderRadius = const BorderRadius.all(Radius.circular(8)),
    this.borderWidth = 2,
    this.seed,
  });

  @override
  Widget build(BuildContext context) {
    if (!running) return child;
    final tint = seed == null ? AppColors.codex : ringTintFor(seed);
    return Container(
      decoration: BoxDecoration(
        border: Border.all(color: tint, width: borderWidth),
        borderRadius: borderRadius,
      ),
      child: child,
    );
  }
}
