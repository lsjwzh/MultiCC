// 悬浮操作台：圆盘触控板 + 滚轮胶囊。
//
// 参考 iPad 远控 App 的做法 —— 精度输入是「临时工具」，不是全局模式：
// 画面上的单指永远点哪打哪，需要用触控板时把手指放到这块圆盘上。
// 它不改变画面手势，也就不存在「我现在到底是触摸还是鼠标」的心智负担。
//
// 组件只认指针回调，不认识远端；坐标一律沿用 [RemoteTouchController]
// 那套（global = 视口坐标，trackpad 只用位移）。
//
// 这里原先还贴着一条 34×150 的滚轮胶囊（带箭头和可拖握把）—— 那是桌面滚动条
// 移植到触屏上的产物，手机上没人用滚动条滚页面。现在舞台与圆盘都支持「双指
// 平行滑动 = 滚远端」（见 RemoteTouchController._scrollAnchor），胶囊整条删掉，
// 浮层面积少掉约四成。代价：只能用一根手指的用户失去滚动手势，记在方案 §16。
import 'dart:async';

import 'package:flutter/material.dart';

const double remotePodPad = 148;

enum RemotePodCorner { topLeft, topRight, bottomLeft, bottomRight }

class RemoteControlPod extends StatefulWidget {
  const RemoteControlPod({
    super.key,
    required this.viewport,
    required this.padding,
    required this.corner,
    required this.onCorner,
    required this.onPointerDown,
    required this.onPointerMove,
    required this.onPointerUp,
    this.padLabel,
    this.dragLabel,
    this.idleOpacity = 0.4,
  });

  /// 可放置区域（整块幕布，含安全区）。
  final Size viewport;
  final EdgeInsets padding;

  /// 停靠角；松手后按圆盘中心就近吸附。
  final RemotePodCorner corner;
  final ValueChanged<RemotePodCorner> onCorner;

  final void Function(int pointer, Offset global, Duration timeStamp)
  onPointerDown;
  final void Function(int pointer, Offset global, Duration timeStamp)
  onPointerMove;
  final void Function(int pointer, Duration timeStamp) onPointerUp;

  final String? padLabel;
  final String? dragLabel;

  /// 静止时的透明度。
  final double idleOpacity;

  @override
  State<RemoteControlPod> createState() => _RemoteControlPodState();
}

class _RemoteControlPodState extends State<RemoteControlPod> {
  /// 拖动中的临时位移（相对停靠位置）。松手吸附后清零。
  Offset _drag = Offset.zero;
  bool _dragging = false;
  bool _idle = false;
  Timer? _idleTimer;

  static const Size _size = Size(
    remotePodPad,
    remotePodPad + 26, // 顶部拖动把手
  );

  @override
  void initState() {
    super.initState();
    _armIdle();
  }

  @override
  void dispose() {
    _idleTimer?.cancel();
    super.dispose();
  }

  void _armIdle() {
    _idleTimer?.cancel();
    _idleTimer = Timer(const Duration(seconds: 3), () {
      if (mounted && !_dragging) setState(() => _idle = true);
    });
  }

  void _wake() {
    if (_idle) setState(() => _idle = false);
    _armIdle();
  }

  /// 停靠位置（左上角），按安全区与视口夹取。
  Offset _base() {
    final p = widget.padding;
    final vp = widget.viewport;
    final left = p.left + 12;
    final right = vp.width - p.right - 12 - _size.width;
    final top = p.top + 12;
    final bottom = vp.height - p.bottom - 12 - _size.height;
    final x =
        widget.corner == RemotePodCorner.topLeft ||
            widget.corner == RemotePodCorner.bottomLeft
        ? left
        : right;
    final y =
        widget.corner == RemotePodCorner.topLeft ||
            widget.corner == RemotePodCorner.topRight
        ? top
        : bottom;
    return Offset(x, y);
  }

  Offset _clampToViewport(Offset at) {
    final p = widget.padding;
    final vp = widget.viewport;
    final minX = p.left + 4.0;
    final maxX = vp.width - p.right - 4.0 - _size.width;
    final minY = p.top + 4.0;
    final maxY = vp.height - p.bottom - 4.0 - _size.height;
    return Offset(
      at.dx.clamp(minX, maxX < minX ? minX : maxX),
      at.dy.clamp(minY, maxY < minY ? minY : maxY),
    );
  }

  void _endDrag() {
    final box = _clampToViewport(_base() + _drag);
    final center = box + Offset(_size.width / 2, _size.height / 2);
    final right = center.dx > widget.viewport.width / 2;
    final bottom = center.dy > widget.viewport.height / 2;
    final corner = right
        ? (bottom ? RemotePodCorner.bottomRight : RemotePodCorner.topRight)
        : (bottom ? RemotePodCorner.bottomLeft : RemotePodCorner.topLeft);
    setState(() {
      _dragging = false;
      _drag = Offset.zero;
    });
    if (corner != widget.corner) widget.onCorner(corner);
    _armIdle();
  }

  Widget _grip() {
    return Semantics(
      label: widget.dragLabel,
      child: GestureDetector(
        key: const ValueKey('rs-pod-grip'),
        behavior: HitTestBehavior.opaque,
        onPanStart: (_) {
          _wake();
          setState(() => _dragging = true);
        },
        onPanUpdate: (d) {
          _wake();
          setState(() => _drag += d.delta);
        },
        onPanEnd: (_) => _endDrag(),
        onPanCancel: _endDrag,
        child: SizedBox(
          height: 20,
          width: _size.width,
          child: Center(
            child: Container(
              width: 34,
              height: 6,
              decoration: BoxDecoration(
                color: const Color(0x66dce6f1),
                borderRadius: BorderRadius.circular(3),
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _pad() {
    return Semantics(label: widget.padLabel, child: _padSurface());
  }

  Widget _padSurface() {
    return Listener(
      key: const ValueKey('rs-pod-pad'),
      behavior: HitTestBehavior.opaque,
      onPointerDown: (e) {
        _wake();
        widget.onPointerDown(e.pointer, e.position, e.timeStamp);
      },
      onPointerMove: (e) {
        _wake();
        widget.onPointerMove(e.pointer, e.position, e.timeStamp);
      },
      onPointerUp: (e) => widget.onPointerUp(e.pointer, e.timeStamp),
      onPointerCancel: (e) => widget.onPointerUp(e.pointer, e.timeStamp),
      child: Container(
        width: remotePodPad,
        height: remotePodPad,
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          color: const Color(0xCC1f2633),
          border: Border.all(color: const Color(0xFF39445a), width: 1.2),
        ),
        child: Center(
          child: Container(
            width: 54,
            height: 36,
            decoration: BoxDecoration(
              color: const Color(0x3310141c),
              borderRadius: BorderRadius.circular(9),
              border: Border.all(color: const Color(0x5539445a)),
            ),
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final at = _clampToViewport(_base() + _drag);
    return Positioned(
      left: at.dx,
      top: at.dy,
      child: AnimatedOpacity(
        key: const ValueKey('rs-pod'),
        opacity: _idle && !_dragging ? widget.idleOpacity : 1,
        duration: const Duration(milliseconds: 180),
        child: SizedBox(
          width: _size.width,
          height: _size.height,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [_grip(), _pad()],
          ),
        ),
      ),
    );
  }
}
