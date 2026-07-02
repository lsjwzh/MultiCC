import 'package:flutter/material.dart';

/// A border + glow that cycles through rainbow colours while [running] is true.
/// Mirrors the web `.card-border-rainbow` animation (3s linear infinite).
///
/// Wrap a card with it; when [running] is false the child is returned as-is
/// (no border decoration added) so callers can supply their own static border.
class RainbowBorder extends StatefulWidget {
  final bool running;
  final Widget child;
  final BorderRadius borderRadius;
  final double borderWidth;
  final double glowRadius;

  const RainbowBorder({
    super.key,
    required this.running,
    required this.child,
    this.borderRadius = const BorderRadius.all(Radius.circular(8)),
    this.borderWidth = 1.0,
    this.glowRadius = 14.0,
  });

  @override
  State<RainbowBorder> createState() => _RainbowBorderState();
}

class _RainbowBorderState extends State<RainbowBorder>
    with TickerProviderStateMixin {
  late AnimationController _ctrl;
  // 7 rainbow stops, matching the web @keyframes.
  static const _stops = [
    Color(0xffff0000),
    Color(0xffff8800),
    Color(0xffffff00),
    Color(0xff00ff00),
    Color(0xff0088ff),
    Color(0xff0000ff),
    Color(0xff8800ff),
  ];

  @override
  void initState() {
    super.initState();
    _ctrl = AnimationController(
      vsync: this,
      duration: const Duration(seconds: 3),
    );
    if (widget.running) _ctrl.repeat();
  }

  @override
  void didUpdateWidget(covariant RainbowBorder old) {
    super.didUpdateWidget(old);
    if (widget.running != old.running) {
      if (widget.running) {
        _ctrl.repeat();
      } else {
        _ctrl.stop();
      }
    }
  }

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  Color _colorAt(double t) {
    // t in [0,1); cycle through 7 stops and back to the first.
    final scaled = t * _stops.length;
    final i = scaled.floor() % _stops.length;
    final next = (i + 1) % _stops.length;
    final frac = scaled - scaled.floor();
    return Color.lerp(_stops[i], _stops[next], frac)!;
  }

  @override
  Widget build(BuildContext context) {
    if (!widget.running) return widget.child;
    return AnimatedBuilder(
      animation: _ctrl,
      builder: (ctx, _) {
        final c = _colorAt(_ctrl.value);
        return Container(
          decoration: BoxDecoration(
            border: Border.all(color: c, width: widget.borderWidth),
            borderRadius: widget.borderRadius,
            boxShadow: [
              BoxShadow(
                color: c.withValues(alpha: 0.53), // ~88
                blurRadius: widget.glowRadius,
                spreadRadius: 1,
              ),
            ],
          ),
          child: widget.child,
        );
      },
    );
  }
}
