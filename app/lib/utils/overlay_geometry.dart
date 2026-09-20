import 'package:flutter/material.dart';

/// 打开对话（以及目录详情）那层浮层的几何。三端是同一套规矩（Web `public/air.js`
/// 的 `#chat-layer`）：默认盖满内容区，页头留在外面当快捷入口 —— 首页那根 AppBar
/// 上的 ☰ / 状态徽章 / ⋯ 还是活的，换下一个任务不用先把对话关掉；展开态才连页头
/// （以及状态栏）一起盖。
///
/// 「页头留着」这件事就落在这两个数上，所以它们只写一份：两个浮层叠在同一层
/// Stack 里，一个压着另一个，停位不一致时上面那层会露出下面那层的拖柄。

/// 浮层默认停在哪：返回「盖住屏幕高度的比例」（`_anim` 的目标值就是这个量纲）。
double overlaySnapFraction(MediaQueryData mq) {
  final chrome = mq.padding.top + kToolbarHeight;
  // 窗口比页头还矮（横屏塌成一条、或者极端的分屏）时别算出负数：盖满就是满屏。
  if (chrome >= mq.size.height) return 1.0;
  return (mq.size.height - chrome) / mq.size.height;
}

/// 内容区的顶端 = 首页 AppBar 的下沿。浮层盖住的是它下面那一格，遮罩也从这里开始
/// —— 页头既然要留着给人点，就不能被压暗、更不能把点击吃掉。
double overlayContentTop(MediaQueryData mq) => mq.padding.top + kToolbarHeight;
