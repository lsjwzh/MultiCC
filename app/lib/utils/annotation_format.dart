/// Pure helpers for the human-assist screenshot annotation (App half).
///
/// The text block is model-facing and MUST stay byte-for-byte identical to the
/// web implementation in `public/chat-annotate.js` (serializeAnnotation /
/// refreshText / sourcePathFromUrl / exportFileName). Change both together.
library;

enum AnnotationKind { point, box, arrow }

/// One mark in natural image pixels. `b` is unused for points.
class AnnotationMark {
  final AnnotationKind kind;
  final double ax;
  final double ay;
  final double bx;
  final double by;
  String note;

  AnnotationMark({
    required this.kind,
    required this.ax,
    required this.ay,
    double? bx,
    double? by,
    this.note = '',
  }) : bx = bx ?? ax,
       by = by ?? ay;

  String get kindName => kind.name;
}

double _clamp01(double v) => v.isNaN ? 0 : v.clamp(0.0, 1.0).toDouble();

/// JS: `(Math.round(clamp01(v) * 1000) / 1000).toFixed(3)` — identical for
/// non-negative input (Dart rounds half away from zero, JS half up).
String _fmt(double v) =>
    ((_clamp01(v) * 1000).round() / 1000).toStringAsFixed(3);

final _newlineRun = RegExp(r'\s*[\r\n]+\s*');

/// Trim + collapse newline runs (and the whitespace hugging them) to one space.
String annotationOneLine(String? s) =>
    (s ?? '').trim().replaceAll(_newlineRun, ' ');

String serializeAnnotation({
  required String src,
  required int width,
  required int height,
  required List<AnnotationMark> marks,
  String note = '',
}) {
  final w = width < 1 ? 1 : width;
  final h = height < 1 ? 1 : height;
  final lines = <String>[
    '[annotation] src=${src.isEmpty ? '-' : src} size=${w}x$h',
  ];
  for (var i = 0; i < marks.length; i++) {
    final m = marks[i];
    String geo;
    switch (m.kind) {
      case AnnotationKind.box:
        final x1 = m.ax < m.bx ? m.ax : m.bx;
        final x2 = m.ax < m.bx ? m.bx : m.ax;
        final y1 = m.ay < m.by ? m.ay : m.by;
        final y2 = m.ay < m.by ? m.by : m.ay;
        geo = '${_fmt(x1 / w)},${_fmt(y1 / h)}-${_fmt(x2 / w)},${_fmt(y2 / h)}';
      case AnnotationKind.arrow:
        geo =
            '${_fmt(m.ax / w)},${_fmt(m.ay / h)}->${_fmt(m.bx / w)},${_fmt(m.by / h)}';
      case AnnotationKind.point:
        geo = '${_fmt(m.ax / w)},${_fmt(m.ay / h)}';
    }
    final text = annotationOneLine(m.note);
    lines.add(
      '#${i + 1} ${m.kindName} $geo${text.isNotEmpty ? ' — $text' : ''}',
    );
  }
  final overall = annotationOneLine(note);
  if (overall.isNotEmpty) lines.add('note: $overall');
  lines.add('[/annotation]');
  return lines.join('\n');
}

String annotationRefreshText(String src) =>
    '[annotation-refresh] src=${src.isEmpty ? '-' : src}\n'
    '截图已过期或页面已变化，请重新截图后再问我。';

/// `/api/download?path=<abs>&inline=1` → `<abs>`; anything else → ''.
String annotationSourcePathFromUrl(String url) {
  final uri = Uri.tryParse(url);
  if (uri == null || uri.path != '/api/download') return '';
  return uri.queryParameters['path'] ?? '';
}

String annotationExportFileName(String src, int epochMillis) {
  var base = src
      .split(RegExp(r'[\\/]'))
      .last
      .replaceFirst(RegExp(r'\.[^.]*$'), '');
  if (base.isEmpty) base = 'image';
  return 'annotated-$base-$epochMillis.png';
}

/// Line appended to the overall note after a secret was stored. Model-facing
/// literal, kept identical to the web side — the value itself never appears.
String annotationSecretStoredLine(String name) =>
    '敏感值已存入本地保险箱，环境变量名 $name（值不在对话里）';

final annotationSecretNameRe = RegExp(r'^[A-Za-z0-9_.\-]{1,64}$');
