import 'dart:async';
import 'dart:math' as math;
import 'dart:ui' show Offset, Rect, Size;

/// 「🖥 屏幕」触摸手势 → RFB 指针事件。纯 Dart，不碰 Widget，方便单测。
///
/// 两种模式（对照 UU 远程的「触摸 / 鼠标」两档）：
///  · [RemoteTouchMode.direct]  手指点哪远端点哪。按下**立即**有本地落点反馈，
///    推动超过 [slop] 才按下左键（按在最初落点上）并逐点跟随；轻点才是单击。
///    没有任何延迟计时器，也没有长按右键 —— 右键走显式「右键」按钮。
///  · [RemoteTouchMode.trackpad] 触控板：一指滑动带着虚拟光标走（带加速度），
///    轻点 = 点击，按住不动 [holdDelay] 后再拖 = 拖拽，未放大时双指平行滑动 = 滚动，
///    双指轻点 = 右键，放大后手指位移按缩放比例变细（精确定位）。
///
/// 单指只做鼠标、从不移动画面；画面的缩放与平移只归双指（放大后双指一律交给
/// 缩放手势，同时缩放和拖动）。所以触控板光标被限制在 [visible] 里，不会走到
/// 看不见的地方。
///
/// 坐标约定：输出一律是**源画面像素**（RFB 帧缓冲坐标）；输入 `local` 是
/// 内容局部坐标（直接模式的绝对映射），`global` 是视口坐标（触控板的相对位移
/// 用它 —— 双指挪动画面时 local 会被带着动，会算出幽灵位移）。
enum RemoteTouchMode { direct, trackpad }

class RemoteTouchController {
  RemoteTouchController({
    required this.onPointer,
    this.onCursor,
    this.onHold,
    this.onRightUsed,
    this.holdDelay = const Duration(milliseconds: 350),
    this.moveInterval = const Duration(milliseconds: 8),
    this.tapMax = const Duration(milliseconds: 300),
    this.slop = 6.0,
    this.scrollStep = 24.0,
  });

  /// RFB PointerEvent：mask 1 左 / 4 右 / 8 滚轮上 / 16 滚轮下，坐标是源画面像素。
  final void Function(int mask, int x, int y) onPointer;

  /// 本地光标/落点标记（源画面像素）；`null` = 隐藏。
  final void Function(Offset? source, bool pressed)? onCursor;

  /// 触控板长按进入拖拽时回调（界面给一下触觉反馈）。
  final void Function()? onHold;

  /// 「右键」一次性开关被这次点击用掉（界面据此熄灯）。
  final void Function()? onRightUsed;

  final Duration holdDelay;
  final Duration moveInterval;
  final Duration tapMax;
  final double slop;
  final double scrollStep;

  RemoteTouchMode mode = RemoteTouchMode.direct;

  /// 点亮后的下一次点击按右键发送；用掉后由本类复位并回调 [onRightUsed]。
  bool rightOnce = false;

  /// 当前显示尺寸（contain 后的内容框）、源画面尺寸、视图缩放倍数。
  Size display = Size.zero;
  Size source = Size.zero;
  double viewScale = 1;

  /// 视口里看得见的那块源画面（源像素）；`null` = 整个源画面。触控板光标不出这块。
  Rect? visible;

  /// 触控板虚拟光标（源画面像素）；界面可读它画光标。
  Offset cursor = Offset.zero;

  /// 双指正在「滚动」（而不是捏合缩放）。界面据此压住 InteractiveViewer 的缩放抖动。
  bool get scrolling => _scrolling;

  bool get _ready =>
      display.width > 0 &&
      display.height > 0 &&
      source.width > 0 &&
      source.height > 0;

  final Map<int, _Pt> _pts = {};
  int? _primary;
  Duration _lastT = Duration.zero;
  Offset _downLocal = Offset.zero;
  Offset _downGlobal = Offset.zero;
  Offset _lastGlobal = Offset.zero;
  Offset _lastSrc = Offset.zero;
  bool _moved = false;
  bool _dragging = false; // 直接模式：左键已按下
  bool _holding = false; // 触控板：长按进入的拖拽中
  Duration? _lastSentAt;
  _Move? _pending;
  Timer? _holdTimer;
  Timer? _flushTimer;
  Timer? _fadeTimer;

  // 双指
  bool _multi = false;
  bool _tapCandidate = false;
  bool _scrolling = false;
  bool _pinching = false;
  Duration _multiStart = Duration.zero;
  double _d0 = 0;
  Offset _c0 = Offset.zero;
  Offset _lastC = Offset.zero;
  double _scrollAcc = 0;

  // ── 输入 ──

  void down(int id, Offset local, Offset global, Duration t) {
    _fadeTimer?.cancel();
    _pts[id] = _Pt(local, global);
    if (_pts.length >= 2) {
      if (_multi) {
        _tapCandidate = false; // 第三指 / 补落：不再是干净的双指轻点
      } else {
        _enterMulti(t);
      }
      return;
    }
    _multi = false;
    _primary = id;
    _lastT = t;
    _downLocal = local;
    _downGlobal = global;
    _lastGlobal = global;
    _moved = false;
    _dragging = false;
    _holding = false;
    _lastSentAt = null;
    _pending = null;
    if (!_ready) return;
    if (mode == RemoteTouchMode.direct) {
      final s = _toSource(local);
      _lastSrc = s;
      onPointer(0, s.dx.round(), s.dy.round()); // 光标先跳过来：H.264 画面里立刻可见
      onCursor?.call(s, true);
    } else {
      if (cursor == Offset.zero) {
        cursor = Offset(source.width / 2, source.height / 2);
      }
      // 双指把画面挪走后光标可能留在视口外：先拉回看得见的地方，
      // 免得接下来的轻点点在看不见的位置。
      final seen = _keepVisible(cursor);
      if (seen != cursor) {
        cursor = seen;
        onPointer(0, cursor.dx.round(), cursor.dy.round());
      }
      _holdTimer?.cancel();
      _holdTimer = Timer(holdDelay, _fireHold);
      onCursor?.call(cursor, false);
    }
  }

  void move(int id, Offset local, Offset global, Duration t) {
    final p = _pts[id];
    if (p == null) return;
    p.local = local;
    p.global = global;
    if (!_ready) return;
    if (_multi) {
      _multiMove(t);
      return;
    }
    if (id != _primary) return;
    if (mode == RemoteTouchMode.direct) {
      _directMove(local, global, t);
    } else {
      _padMove(global, t);
    }
  }

  void up(int id, Offset local, Offset global, Duration t) {
    final p = _pts.remove(id);
    if (p == null) return;
    if (_multi) {
      _multiUp(t);
      return;
    }
    if (!_ready || id != _primary) return;
    _holdTimer?.cancel();
    // Deliver the last held-position sample before the release. The Agent
    // needs a held move to start a live drag, including very short gestures.
    _flush(t);
    _cancelFlush();
    if (mode == RemoteTouchMode.direct) {
      _directUp(local);
    } else {
      _padUp(t);
    }
    _primary = null;
  }

  /// 系统打断 / 页面离开：有按下的左键必须松开。
  void cancel(int id) {
    final had = _pts.remove(id) != null;
    if (!had) return;
    _holdTimer?.cancel();
    _cancelFlush();
    if (_multi) {
      if (_pts.isEmpty) _endMulti();
      return;
    }
    _releaseIfHeld();
    _primary = null;
    _hide();
  }

  /// 切模式 / 失去操作权 / dispose：松手、清状态。
  void reset() {
    _holdTimer?.cancel();
    _cancelFlush();
    _fadeTimer?.cancel();
    _releaseIfHeld();
    _pts.clear();
    _primary = null;
    _endMulti();
  }

  // ── 直接模式 ──

  void _directMove(Offset local, Offset global, Duration t) {
    if (!_dragging) {
      if ((global - _downGlobal).distance <= slop) return;
      _moved = true;
      _dragging = true;
      final s = _toSource(_downLocal); // 按在最初落点上，不是越过死区后的位置
      onPointer(1, s.dx.round(), s.dy.round());
    }
    final s = _toSource(local);
    _lastSrc = s;
    _queue(1, s, t);
    onCursor?.call(s, true);
  }

  void _directUp(Offset local) {
    if (_dragging) {
      final s = _toSource(local);
      onPointer(0, s.dx.round(), s.dy.round());
      _dragging = false;
    } else {
      _click(_toSource(_downLocal));
    }
    _fade();
  }

  // ── 触控板 ──

  void _fireHold() {
    if (_pts.length != 1 || _moved || _multi) return;
    _holding = true;
    onPointer(1, cursor.dx.round(), cursor.dy.round());
    onCursor?.call(cursor, true);
    onHold?.call();
  }

  void _padMove(Offset global, Duration t) {
    if (!_moved && !_holding) {
      if ((global - _downGlobal).distance <= slop) return;
      _moved = true;
      _holdTimer?.cancel();
      _lastGlobal = _downGlobal; // 从按下点起算，死区内的位移也算进去
    }
    final dt = math.max(1, (t - _lastT).inMicroseconds) / 1e6;
    final d = global - _lastGlobal;
    final speed = d.distance / dt;
    final gain =
        (source.width / display.width) /
        math.max(0.1, viewScale) *
        (1 + math.min(_accelMax, speed / _accelSpeed));
    cursor = _keepVisible(
      Offset(cursor.dx + d.dx * gain, cursor.dy + d.dy * gain),
    );
    _lastGlobal = global;
    _lastT = t;
    _queue(_holding ? 1 : 0, cursor, t);
    onCursor?.call(cursor, _holding);
  }

  void _padUp(Duration t) {
    if (_holding) {
      onPointer(0, cursor.dx.round(), cursor.dy.round());
      _holding = false;
    } else if (!_moved) {
      _click(cursor); // 没拖、没进长按 = 轻点（不设时限，免得 300~350ms 之间落空）
    }
    onCursor?.call(cursor, false);
  }

  // ── 双指 ──

  void _enterMulti(Duration t) {
    _holdTimer?.cancel();
    _cancelFlush();
    final wasSingleStill = !_moved && !_dragging && !_holding && !_multi;
    _releaseIfHeld();
    _multi = true;
    _scrolling = false;
    _pinching = false;
    _scrollAcc = 0;
    _multiStart = t;
    _tapCandidate = wasSingleStill;
    final pair = _pair();
    if (pair != null) {
      _d0 = (pair.$1.global - pair.$2.global).distance;
      _c0 = (pair.$1.global + pair.$2.global) / 2;
      _lastC = _c0;
    }
    if (mode == RemoteTouchMode.direct) onCursor?.call(null, false);
  }

  void _multiMove(Duration t) {
    final pair = _pair();
    if (pair == null) return;
    final d = (pair.$1.global - pair.$2.global).distance;
    final c = (pair.$1.global + pair.$2.global) / 2;
    if (!_scrolling && !_pinching) {
      final dd = (d - _d0).abs();
      final dc = (c - _c0).distance;
      if (math.max(dd, dc) < 10) return;
      _tapCandidate = false;
      // 放大后双指只管画面（缩放 + 拖动），没放大时画面无处可挪，平行滑动才是滚轮。
      if (mode == RemoteTouchMode.direct || viewScale > 1.01 || dd > dc * 0.8) {
        _pinching = true; // 捏合缩放交给 InteractiveViewer
      } else {
        _scrolling = true;
        _lastC = _c0;
      }
    }
    if (!_scrolling) return;
    _scrollAcc += c.dy - _lastC.dy;
    _lastC = c;
    while (_scrollAcc.abs() >= scrollStep) {
      // 手指向下 = 内容向下 = 滚轮上（触屏的「自然」方向）
      final up = _scrollAcc > 0;
      _scrollAcc += up ? -scrollStep : scrollStep;
      final x = cursor.dx.round(), y = cursor.dy.round();
      onPointer(up ? 0x08 : 0x10, x, y);
      onPointer(0, x, y); // 滚轮是瞬时脉冲，抬回去下一格才算新的沿
    }
  }

  void _multiUp(Duration t) {
    if (_pts.isNotEmpty) return; // 还剩手指：等全部抬起再收尾
    if (mode == RemoteTouchMode.trackpad &&
        _tapCandidate &&
        !_scrolling &&
        !_pinching &&
        t - _multiStart <= tapMax) {
      _click(cursor, forceRight: true); // 触控板的双指轻点 = 右键
    }
    _endMulti();
  }

  void _endMulti() {
    _multi = false;
    _tapCandidate = false;
    _scrolling = false;
    _pinching = false;
    _scrollAcc = 0;
  }

  (_Pt, _Pt)? _pair() {
    if (_pts.length < 2) return null;
    final it = _pts.values.iterator..moveNext();
    final a = it.current;
    it.moveNext();
    return (a, it.current);
  }

  // ── 公共小件 ──

  void _click(Offset s, {bool forceRight = false}) {
    final x = s.dx.round(), y = s.dy.round();
    if (forceRight || rightOnce) {
      if (rightOnce) {
        rightOnce = false;
        onRightUsed?.call();
      }
      onPointer(4, x, y);
      onPointer(0, x, y);
    } else {
      onPointer(1, x, y);
      onPointer(0, x, y);
    }
  }

  void _releaseIfHeld() {
    if (_dragging) {
      onPointer(0, _lastSrc.dx.round(), _lastSrc.dy.round());
      _dragging = false;
    }
    if (_holding) {
      onPointer(0, cursor.dx.round(), cursor.dy.round());
      _holding = false;
    }
  }

  void _queue(int mask, Offset s, Duration t) {
    _pending = _Move(mask, s);
    final last = _lastSentAt;
    if (last == null || t - last >= moveInterval) {
      _flushTimer?.cancel();
      _flushTimer = null;
      _flush(t);
    } else {
      _flushTimer ??= Timer(moveInterval, () {
        _flushTimer = null;
        _flush(null);
      });
    }
  }

  void _flush(Duration? t) {
    final m = _pending;
    if (m == null) return;
    _pending = null;
    _lastSentAt = t;
    onPointer(m.mask, m.pos.dx.round(), m.pos.dy.round());
  }

  void _cancelFlush() {
    _flushTimer?.cancel();
    _flushTimer = null;
    _pending = null;
  }

  void _fade() {
    onCursor?.call(_lastSrc, false);
    _fadeTimer?.cancel();
    _fadeTimer = Timer(const Duration(milliseconds: 600), () {
      onCursor?.call(null, false);
    });
  }

  void _hide() {
    if (mode == RemoteTouchMode.direct) onCursor?.call(null, false);
  }

  // 手写夹取：double.clamp(0.0, -0.0) 会抛 ArgumentError。
  Offset _keepVisible(Offset c) {
    double within(double v, double lo, double hi) =>
        v < lo ? lo : (v > hi ? hi : v);
    var left = 0.0, top = 0.0;
    var right = source.width - 1, bottom = source.height - 1;
    final v = visible;
    if (v != null) {
      left = math.max(left, v.left);
      top = math.max(top, v.top);
      right = math.min(right, v.right - 1);
      bottom = math.min(bottom, v.bottom - 1);
    }
    if (right < left || bottom < top) {
      // 可见块与源画面不相交（几何还没就绪）：退回整个源画面。
      left = top = 0;
      right = source.width - 1;
      bottom = source.height - 1;
    }
    return Offset(within(c.dx, left, right), within(c.dy, top, bottom));
  }

  Offset _toSource(Offset local) => Offset(
    (local.dx / display.width * source.width).clamp(0.0, source.width - 1),
    (local.dy / display.height * source.height).clamp(0.0, source.height - 1),
  );

  // 加速度：每秒 1200 逻辑像素时增益翻倍，封顶 2.5 倍。
  static const double _accelSpeed = 1200;
  static const double _accelMax = 1.5;
}

class _Pt {
  _Pt(this.local, this.global);
  Offset local;
  Offset global;
}

class _Move {
  const _Move(this.mask, this.pos);
  final int mask;
  final Offset pos;
}
