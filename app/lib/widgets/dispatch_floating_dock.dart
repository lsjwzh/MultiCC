// 派发悬浮球：Dispatch 队列的可拖动入口。
//
// 之前的挂载方式是 Stack 里一个固定 Positioned（left:14 / bottom:96），
// 收起态图标永远钉在左下角，且与 pending-input FAB、后台任务弹幕一样
// 占着固定悬浮位。现在图标可以单指拖到任意高度，松手后吸附到最近的
// 左右边缘；吸附侧 + 归一化高度持久化（拖动结束才写，避免写放大），
// 重启 / 切会话 / 方向与窗口尺寸变化后按当前约束 clamp 恢复。
//
// 展开态复用 DispatchQueuePanel（方向 / 对端 / 模式 / 排位 / 运行状态 /
// 刷新全部在面板里），锚定到图标：左吸附时面板向右展开、右吸附时向左，
// 下方空间不足翻到图标上方；底层放一块透明 barrier，点空白处即收起。
//
// 语义边界不变：这只是 DispatchQueueEntry 的展示层，与暂存消息队列、
// TaskBoard / 后台任务（background_tasks）无关；DTO 不带 prompt 文本。
import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../i18n.dart';
import '../models/dispatch_queue.dart';
import 'chat_runtime_panels.dart';

/// How the icon position is persisted: side ('left'/'right') plus a vertical
/// fraction (0.0 = top margin, 1.0 = bottom limit of the usable band). A side
/// + fraction survives width changes (an edge stays an edge) better than two
/// raw fractions would.
const String _kDockSidePref = 'multicc_dispatch_dock_side';
const String _kDockDyPref = 'multicc_dispatch_dock_dy';

class DispatchFloatingDock extends StatefulWidget {
  final List<DispatchQueueEntry> entries;
  final String Function(String sessionId) resolveName;
  final Future<void> Function()? onRefresh;
  final ValueChanged<DispatchQueueEntry>? onOpenSession;
  final ValueChanged<bool>? onExpandedChanged;

  /// Distance between the parent Stack's bottom edge and the icon's bottom
  /// when snapped LEFT — keeps the icon clear of the input bar (and its send
  /// button). The chat screen passes a value matched to its input area.
  final double leftMinBottom;

  /// Same, but when snapped RIGHT, where the pending-input FAB and the
  /// background-task danmaku already float (chat_screen stacks them bottom:
  /// 96–160 + panel body). Deterministic priority: the dock always yields
  /// upward; it never sits on top of those controls.
  final double rightMinBottom;

  const DispatchFloatingDock({
    super.key,
    required this.entries,
    required this.resolveName,
    this.onRefresh,
    this.onOpenSession,
    this.onExpandedChanged,
    this.leftMinBottom = 96,
    this.rightMinBottom = 96,
  });

  @override
  State<DispatchFloatingDock> createState() => _DispatchFloatingDockState();
}

class _DispatchFloatingDockState extends State<DispatchFloatingDock> {
  static const double _icon = 48;
  static const double _margin = 10;
  static const double _panelGap = 8;

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
        _sideRight = prefs.getString(_kDockSidePref) == 'right';
        _dy = prefs.getDouble(_kDockDyPref) ?? 1.0;
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
      await prefs.setString(_kDockSidePref, _sideRight ? 'right' : 'left');
      await prefs.setDouble(_kDockDyPref, _dy);
    } catch (_) {}
  }

  @override
  void didUpdateWidget(covariant DispatchFloatingDock oldWidget) {
    super.didUpdateWidget(oldWidget);
    // Queue drained (or snapshot reconciliation wiped it): collapse at once so
    // no stale expanded panel or badge outlives the data.
    if (widget.entries.isEmpty && _expanded) _collapse();
  }

  void _expand() {
    if (widget.entries.isEmpty) return;
    if (_expanded) return;
    setState(() => _expanded = true);
    widget.onExpandedChanged?.call(true);
  }

  void _collapse() {
    if (!_expanded) return;
    setState(() => _expanded = false);
    widget.onExpandedChanged?.call(false);
  }

  @override
  Widget build(BuildContext context) {
    // Empty queue → nothing at all (no reserved layout space anywhere).
    if (widget.entries.isEmpty) return const SizedBox.shrink();
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

        final activeCount = widget.entries
            .where((entry) => !entry.terminal)
            .length;

        double minBottom() =>
            _sideRight ? widget.rightMinBottom : widget.leftMinBottom;

        // Snapped anchor (fraction → px). Clamp on every build so rotation /
        // resize / a larger right-side reservation always re-fits the icon.
        double snappedTop() {
          final bottomLimit =
              size.height - minBottom() - _icon; // icon-top max
          final span = (bottomLimit - _margin).clamp(0.0, double.infinity);
          return _margin + _dy.clamp(0.0, 1.0) * span;
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
        // bottom clamp happens at settle time.
        iconLeft = iconLeft.clamp(
          _margin,
          (size.width - _margin - _icon).clamp(_margin, double.infinity),
        );
        iconTop = iconTop.clamp(
          _margin,
          (size.height - _margin - _icon).clamp(_margin, double.infinity),
        );
        // Publish the snapped anchor (pre-drag position) for event-time math.
        _anchorLeft = snappedLeft;
        _anchorTop = snappedTop();

        // Anchor the expanded panel to the icon.
        final panelWidth =
            size.width > 388 ? 360.0 : size.width - 28; // matches the panel
        var panelLeft = _sideRight
            ? iconLeft - _panelGap - panelWidth // opens leftwards
            : iconLeft + _icon + _panelGap; // opens rightwards
        panelLeft = panelLeft.clamp(
          8.0,
          (size.width - panelWidth - 8.0).clamp(8.0, double.infinity),
        );
        final availBelow =
            (size.height - minBottom()) - iconTop; // below icon top
        final availAbove = iconTop + _icon - _margin; // above icon bottom
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
            _margin,
            (size.height - _margin - _icon).clamp(_margin, double.infinity),
          );
          final goRight = centreX > size.width / 2;
          setState(() {
            _sideRight = goRight;
            _dragOffset = null;
            final bottomLimit = size.height -
                (goRight ? widget.rightMinBottom : widget.leftMinBottom) -
                _icon;
            final span = (bottomLimit - _margin).clamp(0.0, double.infinity);
            _dy = span <= 0 ? 1.0 : ((liveTop - _margin) / span).clamp(0.0, 1.0);
          });
          _persist();
        }

        final tooltip = _expanded
            ? t('dispatchDockExpanded', {'n': '$activeCount'})
            : t('dispatchDockCollapsed', {'n': '$activeCount'});

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
                        key: const Key('dispatch-dock-icon'),
                        color: const Color(0xFF1f6feb),
                        shape: const CircleBorder(
                          side: BorderSide(color: Color(0xFF6aa3ff)),
                        ),
                        elevation: 8,
                        child: SizedBox(
                          width: _icon,
                          height: _icon, // ≥44dp touch target
                          child: Stack(
                            clipBehavior: Clip.none,
                            children: [
                              const Center(
                                child: Icon(
                                  Icons.swap_vert_rounded,
                                  size: 22,
                                  color: Colors.white,
                                ),
                              ),
                              if (activeCount > 0)
                                Positioned(
                                  key: const Key('dispatch-dock-badge'),
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
                                      activeCount > 99
                                          ? '99+'
                                          : '$activeCount',
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
                      child: DispatchQueuePanel(
                        key: const Key('dispatch-dock-panel'),
                        entries: widget.entries,
                        resolveName: widget.resolveName,
                        onRefresh: widget.onRefresh,
                        onOpenSession: widget.onOpenSession,
                        onExpandedChanged: (value) {
                          if (!value) _collapse();
                        },
                        initiallyExpanded: true,
                      ),
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
