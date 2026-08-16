// 通用可拖动悬浮球 primitive：所有「常驻悬浮入口」的统一实现。
//
// 第一次落地是 Dispatch 派发队列（DispatchFloatingDock），现在 Background
// Tasks 也复用同一套：单指拖动跟手、松手吸附最近左右边缘、位置以
// side + 归一化纵向分数持久化（只在松手时写一次，轮询 rebuild 不写放大）、
// 每次 build 按当前约束 clamp（旋转 / 窗口变化 / 悬浮带预留变化后自动回界）。
// tap 与 drag 由手势竞技场的 touch slop 天然区分，拖动绝不触发展开。
//
// 展开面板由 [panelBuilder] 提供，锚定图标：左吸附向右展开、右吸附向左，
// 下方空间不足翻到图标上方；底层透明 barrier，点空白即收起。
//
// 多悬浮入口协调：同侧不互相覆盖。高优先级入口的当前锚点通过 [obstacle]
// 传入，本 dock 在 build clamp 与 settle 两处都做确定性避让（优先推到障碍
// 上方，放不下走下方）——单向（本 dock 让位），无震荡循环。恢复持久化
// 位置时同样重新校正，所以重启 / 切会话后两个球也不会叠在一起。
import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Same-side anchor of a higher-priority floating dock that this dock must
/// never overlap. `top` is that dock's icon-top in *its* coordinate space —
/// every dock lives in the same full-screen Stack, so px are comparable.
class FloatingDockAnchor {
  final bool sideRight;
  final double top;
  const FloatingDockAnchor({required this.sideRight, required this.top});

  @override
  bool operator ==(Object other) =>
      other is FloatingDockAnchor &&
      other.sideRight == sideRight &&
      other.top == top;

  @override
  int get hashCode => Object.hash(sideRight, top);
}

typedef FloatingDockTooltipBuilder = String Function(bool expanded);

class FloatingDock extends StatefulWidget {
  /// Empty-state gate: false renders nothing at all and collapses any open
  /// panel (parent gets onExpandedChanged(false)). Callers pass queue/task
  /// emptiness here instead of parenting the widget in an if — the collapse
  /// on drain is part of the dock contract.
  final bool visible;

  /// Badge number (active/running count). 0 hides the badge.
  final int badgeCount;

  /// Glyph inside the 48dp circle (colour pair comes with the dock).
  final IconData icon;
  final Color iconColor;
  final Color iconBorder;

  /// Tooltip + semantics label, rebuilt for the current expand state so it
  /// can carry the live count ("N 个进行中 · 点按展开").
  final FloatingDockTooltipBuilder tooltip;

  /// Expanded detail panel, anchored to the icon. [onCollapse] must be wired
  /// to the panel's own collapse affordances (✕ / ▾) so they fold the dock.
  final Widget Function(BuildContext context, VoidCallback onCollapse)
  panelBuilder;

  /// Panel width for the current viewport width (each caller matches its
  /// panel's internal responsive rule).
  final double Function(double viewportWidth) panelWidth;

  /// Independent persistence keys per dock — state never shared between
  /// entries, even though the drag machinery is.
  final String sidePrefKey;
  final String dyPrefKey;

  /// Distance between the Stack bottom and the icon's bottom when snapped
  /// LEFT / RIGHT — callers pass the reserve matched to that side's floaters
  /// (input bar, pending-input FAB, …). The dock always yields upward.
  final double leftMinBottom;
  final double rightMinBottom;

  /// Upper bound for the icon top (e.g. below a header row). Defaults to the
  /// viewport margin.
  final double topMin;

  /// Higher-priority dock to yield to on the same side (see class docs).
  final FloatingDockAnchor? obstacle;

  final ValueChanged<bool>? onExpandedChanged;

  /// Reports this dock's settled/clamped anchor (side + icon top px) so a
  /// peer dock can yield to it. Fired only on change, never per rebuild —
  /// callers may store it in a plain field without setState.
  final void Function(bool sideRight, double top)? onAnchorChanged;

  /// Keys for the icon / badge, so each dock's tests target stable ids.
  final Key iconKey;
  final Key badgeKey;

  const FloatingDock({
    super.key,
    required this.visible,
    required this.badgeCount,
    required this.icon,
    required this.iconColor,
    required this.iconBorder,
    required this.tooltip,
    required this.panelBuilder,
    required this.panelWidth,
    required this.sidePrefKey,
    required this.dyPrefKey,
    this.leftMinBottom = 96,
    this.rightMinBottom = 96,
    this.topMin = 10,
    this.obstacle,
    this.onExpandedChanged,
    this.onAnchorChanged,
    this.iconKey = const Key('floating-dock-icon'),
    this.badgeKey = const Key('floating-dock-badge'),
  });

  @override
  State<FloatingDock> createState() => _FloatingDockState();
}

class _FloatingDockState extends State<FloatingDock> {
  static const double _icon = 48;
  static const double _margin = 10;
  static const double _panelGap = 8;
  static const double _obstacleGap = 8;

  bool _expanded = false;
  bool _sideRight = false;
  double _dy = 1.0; // bottom of the usable band by default (near input bar)
  Offset? _dragOffset; // live drag delta; null when snapped
  bool _prefsLoaded = false;

  // Snapped anchor from the latest build (px). The drag delta is applied on
  // top of these at event time, so settling never depends on whether a frame
  // has been built between the last move and the pointer-up.
  double _anchorLeft = 0;
  double _anchorTop = 0;

  // Last anchor reported through onAnchorChanged — the callback fires only on
  // change, so a parent can safely rebuild (post-frame) to hand the anchor to
  // a peer dock without looping.
  bool _reportedSide = false;
  double _reportedTop = -1;

  @override
  void initState() {
    super.initState();
    _loadPrefs();
  }

  Future<void> _loadPrefs() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      if (!mounted) return;
      setState(() {
        _sideRight = prefs.getString(widget.sidePrefKey) == 'right';
        _dy = prefs.getDouble(widget.dyPrefKey) ?? 1.0;
        _prefsLoaded = true;
      });
    } catch (_) {
      // Unreadable prefs are not fatal — fall back to the default placement.
      if (mounted) setState(() => _prefsLoaded = true);
    }
  }

  /// Persist exactly once per drag end (never during the drag, never on
  /// rebuild), so polling-driven rebuilds cannot cause write amplification.
  Future<void> _persist() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(widget.sidePrefKey, _sideRight ? 'right' : 'left');
      await prefs.setDouble(widget.dyPrefKey, _dy);
    } catch (_) {}
  }

  @override
  void didUpdateWidget(covariant FloatingDock oldWidget) {
    super.didUpdateWidget(oldWidget);
    // Queue drained (or snapshot reconciliation wiped it): collapse at once so
    // no stale expanded panel or badge outlives the data.
    if (!widget.visible && _expanded) _collapse();
  }

  void _expand() {
    if (!widget.visible) return;
    if (_expanded) return;
    setState(() => _expanded = true);
    widget.onExpandedChanged?.call(true);
  }

  void _collapse() {
    if (!_expanded) return;
    setState(() => _expanded = false);
    widget.onExpandedChanged?.call(false);
  }

  /// Deterministic same-side yield: never overlap [FloatingDockAnchor.obstacle].
  /// Prefers the slot above the obstacle; falls to below when above does not
  /// fit. Returns the adjusted icon top.
  double _yieldToObstacle(double top, double bandBottom) {
    final obstacle = widget.obstacle;
    if (obstacle == null || obstacle.sideRight != _sideRight) return top;
    final oTop = obstacle.top;
    if (top > oTop - _icon - _obstacleGap && top < oTop + _icon + _obstacleGap) {
      final above = oTop - _icon - _obstacleGap;
      if (above >= widget.topMin) return above;
      final below = oTop + _icon + _obstacleGap;
      if (below <= bandBottom) return below;
    }
    return top;
  }

  @override
  Widget build(BuildContext context) {
    // Empty queue/tasks → nothing at all (no reserved layout space anywhere).
    if (!widget.visible) return const SizedBox.shrink();
    // One blank frame until prefs resolve, so the icon does not flash at the
    // default spot before jumping to the persisted placement.
    if (!_prefsLoaded) return const SizedBox.shrink();
    return LayoutBuilder(
      builder: (context, constraints) {
        // The dock lives inside the chat screen's SafeArea > Stack, so these
        // constraints are already the safe-area-usable band; every clamp below
        // is therefore safe-area aware by construction.
        final size = constraints.biggest;
        if (size == Size.zero) return const SizedBox.shrink();

        double minBottom() =>
            _sideRight ? widget.rightMinBottom : widget.leftMinBottom;
        final bandBottom =
            size.height - minBottom() - _icon; // icon-top max (pre-obstacle)

        // Snapped anchor (fraction → px). Clamp on every build so rotation /
        // resize / a larger side reservation always re-fits the icon, then
        // re-run the obstacle yield so a restored or resized position still
        // cannot sit on the higher-priority dock.
        double snappedTop() {
          final span = (bandBottom - widget.topMin).clamp(0.0, double.infinity);
          final raw = widget.topMin + _dy.clamp(0.0, 1.0) * span;
          return _yieldToObstacle(raw.clamp(widget.topMin, bandBottom), bandBottom)
              .clamp(widget.topMin, bandBottom);
        }

        final double snappedLeft =
            _sideRight ? size.width - _margin - _icon : _margin;

        var iconLeft = snappedLeft;
        var iconTop = snappedTop();
        if (_dragOffset != null) {
          iconLeft += _dragOffset!.dx;
          iconTop += _dragOffset!.dy;
        }
        // During the drag only keep the icon inside the viewport (full-bleed
        // clamp, so it tracks the finger without jumping); the side-specific
        // bottom clamp and obstacle yield happen at settle time.
        iconLeft = iconLeft.clamp(
          _margin,
          (size.width - _margin - _icon).clamp(_margin, double.infinity),
        );
        iconTop = iconTop.clamp(
          widget.topMin,
          (size.height - _margin - _icon).clamp(widget.topMin, double.infinity),
        );
        // Publish the snapped anchor (pre-drag position) for event-time math.
        _anchorLeft = snappedLeft;
        final settledAnchor = snappedTop();
        _anchorTop = settledAnchor;
        if (_reportedSide != _sideRight || _reportedTop != settledAnchor) {
          _reportedSide = _sideRight;
          _reportedTop = settledAnchor;
          widget.onAnchorChanged?.call(_sideRight, settledAnchor);
        }

        // Anchor the expanded panel to the icon.
        final panelWidth = widget.panelWidth(size.width);
        var panelLeft = _sideRight
            ? iconLeft - _panelGap - panelWidth // opens leftwards
            : iconLeft + _icon + _panelGap; // opens rightwards
        panelLeft = panelLeft.clamp(
          8.0,
          (size.width - panelWidth - 8.0).clamp(8.0, double.infinity),
        );
        final availBelow =
            (size.height - minBottom()) - iconTop; // below icon top
        final availAbove = iconTop + _icon - widget.topMin; // above icon bottom
        final panelAbove =
            availBelow < 240 && availAbove > availBelow; // ~5 rows + header

        void settle() {
          // Pick the nearest horizontal edge from the live (dragged) centre,
          // then renormalise the vertical fraction against that side's usable
          // band and clamp — one deterministic landing position per release.
          // Computed from the State anchors + accumulated drag delta (both
          // current at event time), NOT from this build's locals.
          final drag = _dragOffset ?? Offset.zero;
          final centreX = _anchorLeft + drag.dx + _icon / 2;
          final liveTop = (_anchorTop + drag.dy).clamp(
            widget.topMin,
            (size.height - _margin - _icon)
                .clamp(widget.topMin, double.infinity),
          );
          final goRight = centreX > size.width / 2;
          setState(() {
            _sideRight = goRight;
            _dragOffset = null;
            final settleBottom = size.height -
                (goRight ? widget.rightMinBottom : widget.leftMinBottom) -
                _icon;
            final span =
                (settleBottom - widget.topMin).clamp(0.0, double.infinity);
            if (span <= 0) {
              _dy = 1.0;
            } else {
              // Yield to the obstacle first (it may live on the newly chosen
              // side), then normalise the adjusted top back into a fraction.
              final yielded = _yieldToObstacle(
                liveTop.clamp(widget.topMin, settleBottom),
                settleBottom,
              );
              _dy = ((yielded - widget.topMin) / span).clamp(0.0, 1.0);
            }
          });
          _persist();
        }

        final tooltip = widget.tooltip(_expanded);

        return SizedBox.fromSize(
          size: size,
          child: Stack(
            clipBehavior: Clip.none,
            children: [
              // Transparent scrim: taps on "blank" chat area collapse the
              // panel (standard popover behaviour — the list stays inert
              // while the panel is open, so the panel cannot be interacted
              // "through").
              if (_expanded)
                Positioned.fill(
                  child: GestureDetector(
                    behavior: HitTestBehavior.opaque,
                    onTap: _collapse,
                    child: const SizedBox.expand(),
                  ),
                ),
              Positioned(
                left: iconLeft,
                top: iconTop,
                child: Semantics(
                  button: true,
                  expanded: _expanded,
                  label: tooltip,
                  child: Tooltip(
                    message: tooltip,
                    child: GestureDetector(
                      // Tap vs drag: Flutter's arena requires kTouchSlop of
                      // movement before the pan recognizer wins, so a tap
                      // never fires after a real drag (and vice versa).
                      // supportedDevices left default; single-finger pan only.
                      onPanUpdate: (details) => setState(() {
                        _dragOffset = (_dragOffset ?? Offset.zero) +
                            details.delta;
                      }),
                      onPanEnd: (_) => settle(),
                      onPanCancel: settle,
                      onTap: _expanded ? _collapse : _expand,
                      child: Material(
                        key: widget.iconKey,
                        color: widget.iconColor,
                        shape: CircleBorder(
                          side: BorderSide(color: widget.iconBorder),
                        ),
                        elevation: 8,
                        child: SizedBox(
                          width: _icon,
                          height: _icon, // ≥44dp touch target
                          child: Stack(
                            clipBehavior: Clip.none,
                            children: [
                              Center(
                                child: Icon(
                                  widget.icon,
                                  size: 22,
                                  color: Colors.white,
                                ),
                              ),
                              if (widget.badgeCount > 0)
                                Positioned(
                                  key: widget.badgeKey,
                                  right: -4,
                                  top: -5,
                                  child: Container(
                                    constraints:
                                        const BoxConstraints(minWidth: 19),
                                    height: 19,
                                    padding: const EdgeInsets.symmetric(
                                      horizontal: 4,
                                    ),
                                    alignment: Alignment.center,
                                    decoration: BoxDecoration(
                                      color: const Color(0xFFd73a49),
                                      borderRadius: BorderRadius.circular(10),
                                      border: Border.all(
                                        color: const Color(0xFF0f1115),
                                      ),
                                    ),
                                    child: Text(
                                      widget.badgeCount > 99
                                          ? '99+'
                                          : '${widget.badgeCount}',
                                      style: const TextStyle(
                                        color: Colors.white,
                                        fontSize: 10,
                                        fontWeight: FontWeight.w700,
                                      ),
                                    ),
                                  ),
                                ),
                            ],
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
              if (_expanded)
                Positioned(
                  left: panelLeft,
                  top: panelAbove ? null : iconTop,
                  bottom: panelAbove
                      ? size.height - iconTop - _icon - _panelGap
                      : null,
                  child: ConstrainedBox(
                    constraints: BoxConstraints(
                      maxHeight:
                          (panelAbove ? availAbove : availBelow) - _panelGap,
                    ),
                    child: SingleChildScrollView(
                      // Narrow/short viewports degrade to scrolling instead
                      // of overflowing; normal phones render it fully.
                      child: widget.panelBuilder(context, _collapse),
                    ),
                  ),
                ),
            ],
          ),
        );
      },
    );
  }
}
