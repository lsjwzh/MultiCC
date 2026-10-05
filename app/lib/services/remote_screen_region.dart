import 'dart:ui';

/// A source crop in main-screen logical points, never JPEG pixel coordinates.
class ScreenRegion {
  const ScreenRegion(this.x, this.y, this.width, this.height);
  final double x, y, width, height;

  Map<String, double> toMap() => {
    'x': x,
    'y': y,
    'width': width,
    'height': height,
  };

  Offset point(Offset local, double dw, double dh) => Offset(
    x + (local.dx / dw).clamp(0.0, 1.0) * width,
    y + (local.dy / dh).clamp(0.0, 1.0) * height,
  );

  ScreenRegion? select(Rect box, double dw, double dh) {
    final clipped = box.intersect(Rect.fromLTWH(0, 0, dw, dh));
    if (clipped.isEmpty || dw <= 0 || dh <= 0) return null;
    final a = point(clipped.topLeft, dw, dh);
    final b = point(clipped.bottomRight, dw, dh);
    if (b.dx - a.dx < 1 || b.dy - a.dy < 1) return null;
    return ScreenRegion(a.dx, a.dy, b.dx - a.dx, b.dy - a.dy);
  }
}
