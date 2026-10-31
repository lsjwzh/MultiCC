// 「🖥 屏幕」画面旁的滚轮竖条：一条胶囊里上下拖动 = 连续滚动，
// 点 ▲ / ▼ = 滚一格、按住 = 连发。只发 [onNotch]（up=true 向上滚），
// 具体走 RFB 指针还是 HTTP scroll 由页面决定，本组件不认识远端。
//
// 交互用裸 Listener：GestureDetector 有 18px 触摸容差和手势竞技场延迟，
// 滚轮要跟手就必须在 onPointerMove 的增量上直接结算。每个区域单独记
// 一个按着的 pointer，第二根手指不会串台。
import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show HapticFeedback;

const Color _kRailBgIdle = Color(0x99161b26);
const Color _kRailBgActive = Color(0xE6161b26);
const Color _kRailBorder = Color(0xFF2a3242);
const Color _kRailIcon = Color(0xFFdce6f1);

/// 滚轮竖条的固定宽度（放置函数与组件共用）。
const double remoteWheelRailWidth = 34;

/// 按未放大的 contain 几何算竖条落点。padX/padY 是左右/上下的信箱边宽
/// （`(viewport - content) / 2`）。刻意不跟缩放矩阵走：捏合缩放时竖条
/// 不跳，也不会突然压到画面中心。
///
/// 优先级：左右黑边够宽 → 右侧黑边里；上下黑边够高 → 下方黑边右下角；
/// 全屏铺满 → 贴右边缘浮在画面上。
Rect remoteWheelRailRect(Size vp, double padX, double padY) {
  const w = remoteWheelRailWidth;
  final px = padX < 0 ? 0.0 : padX;
  final py = padY < 0 ? 0.0 : padY;
  final vh = vp.height;
  // a. 横屏：左右有黑边，整条塞进右侧黑边，垂直居中，不压内容。
  if (px >= w + 12) {
    final h = math.min(260.0, vh * 0.6);
    final left = vp.width - px + (px - w) / 2;
    return Rect.fromLTWH(left, (vh - h) / 2, w, h);
  }
  // b. 竖屏：上下有黑边，塞进下方黑边，靠右下角，不压内容。
  // 竖条至少 96 高（两端箭头各 34 + 一截握把），黑边不够就走 c。
  if (py >= 112) {
    final h = math.min(220.0, py - 16);
    final left = vp.width - w - 8;
    return Rect.fromLTWH(left, vh - py + (py - h) / 2, w, h);
  }
  // c. 全屏铺满：右侧浮层，高度取视口一半，且至少给到 120（视口太矮时让位）。
  final h = math.max(
    math.min(220.0, vh * 0.5),
    math.min(120.0, math.max(0.0, vh - 16)),
  );
  return Rect.fromLTWH(vp.width - w - 6, (vh - h) / 2, w, h);
}

/// 滚轮竖条。父级给尺寸（宽 34），箭头各 34 高，中间是滚动握把。
class RemoteWheelRail extends StatefulWidget {
  const RemoteWheelRail({
    super.key,
    required this.onNotch,
    this.step = 18,
    this.semanticLabel,
    this.upLabel,
    this.downLabel,
  });

  /// 滚一格。up=true 向上滚（内容向下跟手，与 RemoteTouchController
  /// 的双指滚动同向）。
  final void Function(bool up) onNotch;

  /// 握把拖多少逻辑像素发一格。
  final double step;

  final String? semanticLabel;
  final String? upLabel;
  final String? downLabel;

  @override
  State<RemoteWheelRail> createState() => _RemoteWheelRailState();
}

class _RemoteWheelRailState extends State<RemoteWheelRail> {
  /// 握把上按着的手指；第二根手指忽略。
  int? _gripPointer;
  double _dragAcc = 0;

  /// 脊线相位：跟手累积的纵向位移，画出来像滚轮在转。
  double _phase = 0;

  /// 箭头上按着的手指与连发定时器。
  int? _arrowPointer;
  Timer? _repeatDelay;
  Timer? _repeatTimer;

  /// 任意区域被按住时胶囊变亮。
  bool _touched = false;

  void _setTouched(bool v) {
    if (_touched == v || !mounted) return;
    setState(() => _touched = v);
  }

  void _notch(bool up) {
    unawaited(HapticFeedback.selectionClick());
    widget.onNotch(up);
  }

  // ── 握把：拖动连续滚 ──
  void _gripDown(PointerDownEvent e) {
    if (_gripPointer != null) return;
    _gripPointer = e.pointer;
    _dragAcc = 0;
    _setTouched(true);
  }

  void _gripMove(PointerMoveEvent e) {
    if (_gripPointer != e.pointer) return;
    final step = widget.step > 0 ? widget.step : 18.0;
    final dy = e.delta.dy;
    _dragAcc += dy;
    _phase += dy;
    while (_dragAcc.abs() >= step) {
      // 手指向下 = 内容向下跟手 = 滚轮向上（自然方向，与触控板两指滚动一致）。
      final up = _dragAcc > 0;
      _dragAcc += up ? -step : step;
      _notch(up);
    }
    setState(() {}); // 脊线相位跟手滚动
  }

  void _gripEnd(PointerEvent e) {
    if (_gripPointer != e.pointer) return;
    _gripPointer = null;
    _dragAcc = 0;
    _setTouched(false);
  }

  // ── 箭头：点一下滚一格，按住 350ms 后每 90ms 连发 ──
  void _arrowDown(PointerDownEvent e, bool up) {
    if (_arrowPointer != null) return;
    _arrowPointer = e.pointer;
    _setTouched(true);
    _notch(up);
    _repeatDelay = Timer(const Duration(milliseconds: 350), () {
      if (!mounted || _arrowPointer != e.pointer) return;
      _repeatTimer = Timer.periodic(const Duration(milliseconds: 90), (_) {
        _notch(up);
      });
    });
  }

  void _arrowEnd(PointerEvent e) {
    if (_arrowPointer != e.pointer) return;
    _arrowPointer = null;
    _repeatDelay?.cancel();
    _repeatDelay = null;
    _repeatTimer?.cancel();
    _repeatTimer = null;
    _setTouched(false);
  }

  @override
  void dispose() {
    _repeatDelay?.cancel();
    _repeatTimer?.cancel();
    super.dispose();
  }

  Widget _arrow({required bool up}) {
    return Semantics(
      button: true,
      label: up ? (widget.upLabel ?? 'Up') : (widget.downLabel ?? 'Down'),
      onTap: () => _notch(up),
      child: Listener(
        behavior: HitTestBehavior.opaque,
        onPointerDown: (e) => _arrowDown(e, up),
        onPointerUp: _arrowEnd,
        onPointerCancel: _arrowEnd,
        child: SizedBox(
          height: 34,
          child: Center(
            child: Icon(
              up
                  ? Icons.keyboard_arrow_up_rounded
                  : Icons.keyboard_arrow_down_rounded,
              size: 24,
              color: _kRailIcon,
            ),
          ),
        ),
      ),
    );
  }

  Widget _grip() {
    return Listener(
      behavior: HitTestBehavior.opaque,
      onPointerDown: _gripDown,
      onPointerMove: _gripMove,
      onPointerUp: _gripEnd,
      onPointerCancel: _gripEnd,
      child: CustomPaint(painter: _WheelGripPainter(phase: _phase)),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Semantics(
      container: true,
      label: widget.semanticLabel,
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: _touched ? _kRailBgActive : _kRailBgIdle,
          borderRadius: BorderRadius.circular(remoteWheelRailWidth / 2),
          border: Border.all(color: _kRailBorder),
        ),
        child: ClipRRect(
          borderRadius: BorderRadius.circular(remoteWheelRailWidth / 2),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              _arrow(up: true),
              Expanded(child: _grip()),
              _arrow(up: false),
            ],
          ),
        ),
      ),
    );
  }
}

/// 握把脊线：每 ~6px 一道短横线，整组按 [phase] 平移，像滚轮在指下转。
class _WheelGripPainter extends CustomPainter {
  _WheelGripPainter({required this.phase});

  final double phase;

  static const double _spacing = 6;
  static const double _halfWidth = 7;

  @override
  void paint(Canvas canvas, Size size) {
    if (size.height <= 0 || size.width <= 0) return;
    final paint = Paint()
      ..color = const Color(0x66dce6f1)
      ..strokeWidth = 1.4
      ..strokeCap = StrokeCap.round;
    final cx = size.width / 2;
    // 相位取模后再往前退一格，保证最上面也有线、整组随拖动平移。
    var y = phase % _spacing;
    if (y > 0) y -= _spacing;
    for (; y <= size.height; y += _spacing) {
      canvas.drawLine(
        Offset(cx - _halfWidth, y),
        Offset(cx + _halfWidth, y),
        paint,
      );
    }
  }

  @override
  bool shouldRepaint(_WheelGripPainter oldDelegate) =>
      oldDelegate.phase != phase;
}
