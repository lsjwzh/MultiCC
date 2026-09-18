import 'package:flutter/material.dart';

/// 一段「有上限宽度、装不下就走跑马灯」的文字。
///
/// 线路名是用户数据（Provider 的显示名想写多长就多长），而它旁边往往还站着真正
/// 的按钮：名字长了不该把别人挤出屏幕，也不该被省略号吃掉 —— 省掉的正是这句话
/// 里唯一有信息量的那段。所以先量一次：装得下就原样渲染（不动、不建动画，测试里
/// `pumpAndSettle` 不会等它），装不下就让文字待在自己的裁剪框里来回走，◆ 和边框
/// 保持不动。
///
/// 和 Web 是同一套语义（`public/composer.css` 的 `.mc-composer__pill--ai` +
/// `public/air.js` 的 `setPillText`）：上限宽度、真实溢出才动、`prefers-reduced-
/// motion` / 系统「减少动态效果」时退回省略号。
class MarqueeText extends StatefulWidget {
  const MarqueeText({
    super.key,
    required this.text,
    this.style,
    this.maxWidth = 220,
    this.gap = 12,
    this.pixelsPerSecond = 26,
  });

  final String text;
  final TextStyle? style;

  /// 文字的上限宽度。装得下时按内容收缩，装不下时就是它被裁剪的宽度。
  final double maxWidth;

  /// 走到头之前在末端留出的余量：不留的话最后一个字贴着边框，像被切掉。
  final double gap;

  /// 跑马灯速度。名字越长走得越久，但两端各停一下的节奏不变。
  final double pixelsPerSecond;

  @override
  State<MarqueeText> createState() => _MarqueeTextState();
}

class _MarqueeTextState extends State<MarqueeText>
    with SingleTickerProviderStateMixin {
  AnimationController? _controller;
  bool _pendingSync = false;

  @override
  void dispose() {
    _controller?.dispose();
    super.dispose();
  }

  double _textWidth(TextStyle style) {
    final painter = TextPainter(
      text: TextSpan(text: widget.text, style: style),
      maxLines: 1,
      textDirection: TextDirection.ltr,
    )..layout();
    return painter.width;
  }

  /// 建/停动画都放在帧后：build 期间启动 ticker 会把这一帧的重建排进自己里。
  void _sync(double distance, bool animate) {
    if (_pendingSync) return;
    _pendingSync = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _pendingSync = false;
      if (!mounted) return;
      final controller = _controller;
      if (distance <= 0 || !animate) {
        controller?.stop();
        controller?.value = 0;
        return;
      }
      final duration = Duration(
        milliseconds: (distance / widget.pixelsPerSecond * 1000)
            .round()
            .clamp(1600, 12000)
            .toInt(),
      );
      // 第一帧还没有 controller，滚动层就没进树 —— 建好之后要让这一帧重画，
      // 否则文字会停在原地直到下一次别的重建（看上去就是「跑马灯不跑」）。
      final created = controller == null;
      if (created) {
        _controller = AnimationController(vsync: this, duration: duration);
      }
      final target = _controller!;
      target.duration = duration;
      if (!target.isAnimating) target.repeat(reverse: true);
      if (created) setState(() {});
    });
  }

  @override
  Widget build(BuildContext context) {
    final style = widget.style ?? DefaultTextStyle.of(context).style;
    final animate = MediaQuery.maybeOf(context)?.disableAnimations != true;
    final overflow = _textWidth(style) - widget.maxWidth;
    final scrolling = overflow > 0 && animate;
    _sync(scrolling ? overflow + widget.gap : 0, animate);
    final text = Text(
      widget.text,
      style: style,
      maxLines: 1,
      softWrap: false,
      overflow: scrolling ? TextOverflow.visible : TextOverflow.ellipsis,
    );
    // 装得下、或系统要求减少动效：一条普通的、带省略号的文字，宽度照旧有上限。
    if (!scrolling) {
      return ConstrainedBox(
        constraints: BoxConstraints(maxWidth: widget.maxWidth),
        child: text,
      );
    }
    final controller = _controller;
    final distance = overflow + widget.gap;
    return SizedBox(
      width: widget.maxWidth,
      child: ClipRect(
        child: controller == null
            ? text
            : AnimatedBuilder(
                animation: controller,
                builder: (_, child) => Transform.translate(
                  offset: Offset(-controller.value * distance, 0),
                  child: child,
                ),
                child: text,
              ),
      ),
    );
  }
}
