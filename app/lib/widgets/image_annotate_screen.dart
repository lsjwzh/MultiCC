import 'dart:async';
import 'dart:convert';
import 'dart:io' show HttpDate;
import 'dart:math' as math;
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

import '../i18n.dart';
import '../services/annotation_inbox.dart';
import '../services/settings_service.dart';
import '../utils/annotation_format.dart';

/// Human-assist screenshot annotation (App half of `public/chat-annotate.js`).
///
/// The user marks points / boxes / arrows (auto-numbered, each with an
/// optional note) on a screenshot the agent posted. "Put in input" pops with
/// an [AnnotationDraft]: the annotated PNG at natural resolution plus the
/// structured `[annotation]` text block — the caller drops it into the
/// composer; nothing is sent from here.
///
/// Gesture model (raw [Listener], no gesture arena, no InteractiveViewer):
/// one finger runs the current tool (pans in 查看 mode); two fingers always
/// pinch-zoom/pan. A second finger arriving mid-draw discards the draft.
class ImageAnnotateScreen extends StatefulWidget {
  final String url;
  final Map<String, String> headers;
  final String sessionId;

  const ImageAnnotateScreen({
    super.key,
    required this.url,
    this.headers = const {},
    this.sessionId = '',
  });

  @override
  State<ImageAnnotateScreen> createState() => _ImageAnnotateScreenState();
}

enum _Tool { pan, point, box, arrow }

enum _Gesture { none, pan, draw, pinch }

const _markColor = Color(0xFFFF3B30);
const _minDragPx = 12.0;

class _Entry {
  final AnnotationMark mark;
  final TextEditingController ctrl;
  _Entry(this.mark) : ctrl = TextEditingController(text: mark.note);
}

class _ImageAnnotateScreenState extends State<ImageAnnotateScreen> {
  ui.Image? _image;
  String? _error;
  DateTime? _lastModified;
  late final String _src = annotationSourcePathFromUrl(widget.url);

  _Tool _tool = _Tool.point;
  final List<_Entry> _entries = [];
  final _overallCtrl = TextEditingController();
  bool _exporting = false;

  // View transform: screen = _offset + img * _scale.
  double _scale = 1;
  Offset _offset = Offset.zero;
  bool _userMoved = false;
  Size _viewport = Size.zero;

  // Raw pointer tracking.
  final Map<int, Offset> _pointers = {};
  _Gesture _gesture = _Gesture.none;
  Offset? _draftStart; // image coords
  Offset? _draftCur; // image coords
  Offset? _finger; // screen coords (loupe)
  double _pinchStartScale = 1;
  double _pinchStartDist = 1;
  Offset _pinchImgFocal = Offset.zero;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    for (final e in _entries) {
      e.ctrl.dispose();
    }
    _overallCtrl.dispose();
    _image?.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final res = await http
          .get(Uri.parse(widget.url), headers: widget.headers)
          .timeout(const Duration(seconds: 30));
      if (res.statusCode != 200) throw Exception('HTTP ${res.statusCode}');
      final lm = res.headers['last-modified'];
      DateTime? lastModified;
      if (lm != null && lm.isNotEmpty) {
        try {
          lastModified = HttpDate.parse(lm);
        } catch (_) {}
      }
      final codec = await ui.instantiateImageCodec(res.bodyBytes);
      final frame = await codec.getNextFrame();
      codec.dispose();
      if (!mounted) {
        frame.image.dispose();
        return;
      }
      setState(() {
        _image = frame.image;
        _lastModified = lastModified;
      });
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    }
  }

  // ── geometry ──

  double get _fitScale {
    final img = _image;
    if (img == null || _viewport.isEmpty) return 1;
    return math.min(_viewport.width / img.width, _viewport.height / img.height);
  }

  void _fit() {
    final img = _image;
    if (img == null || _viewport.isEmpty) return;
    _scale = _fitScale;
    _offset = Offset(
      (_viewport.width - img.width * _scale) / 2,
      (_viewport.height - img.height * _scale) / 2,
    );
  }

  Offset _toImage(Offset screen) => (screen - _offset) / _scale;

  Offset _clampToImage(Offset p) {
    final img = _image!;
    return Offset(
      p.dx.clamp(0.0, img.width.toDouble()),
      p.dy.clamp(0.0, img.height.toDouble()),
    );
  }

  double _clampScale(double s) {
    final fit = _fitScale;
    return s.clamp(fit * 0.5, math.max(fit * 8, 6.0)).toDouble();
  }

  // ── pointer handling ──

  void _discardDraft() {
    _draftStart = null;
    _draftCur = null;
    _finger = null;
  }

  void _startPinch() {
    final pts = _pointers.values.take(2).toList();
    final focal = (pts[0] + pts[1]) / 2;
    _pinchStartDist = math.max(1, (pts[0] - pts[1]).distance);
    _pinchStartScale = _scale;
    _pinchImgFocal = _toImage(focal);
    _gesture = _Gesture.pinch;
  }

  void _onDown(PointerDownEvent e) {
    if (_image == null) return;
    _pointers[e.pointer] = e.localPosition;
    setState(() {
      if (_pointers.length >= 2) {
        _discardDraft();
        _startPinch();
        return;
      }
      if (_tool == _Tool.pan) {
        _gesture = _Gesture.pan;
      } else {
        _gesture = _Gesture.draw;
        final p = _clampToImage(_toImage(e.localPosition));
        _draftStart = p;
        _draftCur = p;
        _finger = e.localPosition;
      }
    });
  }

  void _onMove(PointerMoveEvent e) {
    if (!_pointers.containsKey(e.pointer)) return;
    final prev = _pointers[e.pointer]!;
    _pointers[e.pointer] = e.localPosition;
    setState(() {
      switch (_gesture) {
        case _Gesture.pinch:
          if (_pointers.length < 2) return;
          final pts = _pointers.values.take(2).toList();
          final focal = (pts[0] + pts[1]) / 2;
          final dist = math.max(1.0, (pts[0] - pts[1]).distance);
          _scale = _clampScale(_pinchStartScale * dist / _pinchStartDist);
          _offset = focal - _pinchImgFocal * _scale;
          _userMoved = true;
        case _Gesture.pan:
          _offset += e.localPosition - prev;
          _userMoved = true;
        case _Gesture.draw:
          _draftCur = _clampToImage(_toImage(e.localPosition));
          _finger = e.localPosition;
        case _Gesture.none:
          break;
      }
    });
  }

  void _onUp(PointerUpEvent e) {
    if (!_pointers.containsKey(e.pointer)) return;
    _pointers.remove(e.pointer);
    setState(() {
      if (_gesture == _Gesture.draw && _pointers.isEmpty) {
        _commitDraft();
      }
      if (_pointers.isEmpty) {
        _gesture = _Gesture.none;
      } else if (_pointers.length == 1) {
        // Pinch → one finger left: keep panning with it, never draw.
        _gesture = _Gesture.pan;
      } else {
        _startPinch();
      }
    });
  }

  void _onCancel(PointerCancelEvent e) {
    _pointers.remove(e.pointer);
    setState(() {
      _discardDraft();
      _gesture = _pointers.isEmpty ? _Gesture.none : _Gesture.pan;
    });
  }

  void _onSignal(PointerSignalEvent e) {
    if (e is! PointerScrollEvent || _image == null) return;
    final anchor = _toImage(e.localPosition);
    setState(() {
      _scale = _clampScale(_scale * math.pow(0.998, e.scrollDelta.dy));
      _offset = e.localPosition - anchor * _scale;
      _userMoved = true;
    });
  }

  void _commitDraft() {
    final a = _draftStart;
    final b = _draftCur;
    _discardDraft();
    if (a == null || b == null) return;
    AnnotationMark? mark;
    switch (_tool) {
      case _Tool.point:
        mark = AnnotationMark(kind: AnnotationKind.point, ax: b.dx, ay: b.dy);
      case _Tool.box:
      case _Tool.arrow:
        if ((b - a).distance < _minDragPx) return; // mis-touch
        mark = AnnotationMark(
          kind: _tool == _Tool.box ? AnnotationKind.box : AnnotationKind.arrow,
          ax: a.dx,
          ay: a.dy,
          bx: b.dx,
          by: b.dy,
        );
      case _Tool.pan:
        return;
    }
    _entries.add(_Entry(mark));
  }

  AnnotationMark? get _draftMark {
    final a = _draftStart;
    final b = _draftCur;
    if (a == null || b == null) return null;
    switch (_tool) {
      case _Tool.point:
        return AnnotationMark(kind: AnnotationKind.point, ax: b.dx, ay: b.dy);
      case _Tool.box:
        return AnnotationMark(
          kind: AnnotationKind.box,
          ax: a.dx,
          ay: a.dy,
          bx: b.dx,
          by: b.dy,
        );
      case _Tool.arrow:
        return AnnotationMark(
          kind: AnnotationKind.arrow,
          ax: a.dx,
          ay: a.dy,
          bx: b.dx,
          by: b.dy,
        );
      case _Tool.pan:
        return null;
    }
  }

  // ── actions ──

  void _undo() {
    if (_entries.isEmpty) return;
    setState(() => _entries.removeLast().ctrl.dispose());
  }

  void _removeAt(int i) {
    setState(() => _entries.removeAt(i).ctrl.dispose());
  }

  List<AnnotationMark> _collectMarks() => [
    for (final e in _entries) e.mark..note = e.ctrl.text,
  ];

  void _recapture() {
    Navigator.of(
      context,
    ).pop(AnnotationDraft(text: annotationRefreshText(_src)));
  }

  Future<void> _finish() async {
    final img = _image;
    if (img == null || _exporting) return;
    final marks = _collectMarks();
    final text = serializeAnnotation(
      src: _src,
      width: img.width,
      height: img.height,
      marks: marks,
      note: _overallCtrl.text,
    );
    if (marks.isEmpty) {
      Navigator.of(context).pop(AnnotationDraft(text: text));
      return;
    }
    setState(() => _exporting = true);
    Uint8List? png;
    try {
      final recorder = ui.PictureRecorder();
      final canvas = Canvas(
        recorder,
        Rect.fromLTWH(0, 0, img.width.toDouble(), img.height.toDouble()),
      );
      canvas.drawImage(img, Offset.zero, Paint());
      paintAnnotationMarks(canvas, marks);
      final picture = recorder.endRecording();
      final out = await picture.toImage(img.width, img.height);
      picture.dispose();
      final data = await out.toByteData(format: ui.ImageByteFormat.png);
      out.dispose();
      png = data?.buffer.asUint8List();
    } catch (_) {
      png = null;
    }
    if (!mounted) return;
    if (png == null) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(t('annotExportFailed'))));
    }
    Navigator.of(context).pop(
      AnnotationDraft(
        png: png,
        filename: annotationExportFileName(
          _src,
          DateTime.now().millisecondsSinceEpoch,
        ),
        text: text,
      ),
    );
  }

  Future<void> _openSecretDialog() async {
    final nameCtrl = TextEditingController(text: 'ASSIST_SECRET');
    final valueCtrl = TextEditingController();
    String? error;
    bool saving = false;
    final savedName = await showDialog<String>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setD) {
          Future<void> save() async {
            final name = nameCtrl.text.trim();
            final value = valueCtrl.text;
            if (!annotationSecretNameRe.hasMatch(name)) {
              setD(() => error = t('annotSecretBadName'));
              return;
            }
            if (value.isEmpty) {
              setD(() => error = t('annotSecretEmptyValue'));
              return;
            }
            setD(() {
              saving = true;
              error = null;
            });
            final err = await _postSecret(name, value);
            if (!ctx.mounted) return;
            if (err == null) {
              Navigator.of(ctx).pop(name);
            } else {
              setD(() {
                saving = false;
                error = t('annotSecretFailed', {'error': err});
              });
            }
          }

          return AlertDialog(
            title: Text(t('annotSecretTitle')),
            content: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                TextField(
                  controller: nameCtrl,
                  autocorrect: false,
                  decoration: InputDecoration(labelText: t('annotSecretName')),
                ),
                const SizedBox(height: 8),
                TextField(
                  controller: valueCtrl,
                  obscureText: true,
                  autocorrect: false,
                  enableSuggestions: false,
                  decoration: InputDecoration(labelText: t('annotSecretValue')),
                ),
                if (error != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 8),
                    child: Text(
                      error!,
                      style: const TextStyle(
                        color: Color(0xFFb64e43),
                        fontSize: 12,
                      ),
                    ),
                  ),
              ],
            ),
            actions: [
              TextButton(
                onPressed: saving ? null : () => Navigator.of(ctx).pop(),
                child: Text(t('cancel')),
              ),
              FilledButton(
                onPressed: saving ? null : save,
                child: Text(t('save')),
              ),
            ],
          );
        },
      ),
    );
    valueCtrl.clear();
    nameCtrl.dispose();
    valueCtrl.dispose();
    if (savedName == null || !mounted) return;
    final line = annotationSecretStoredLine(savedName);
    final cur = _overallCtrl.text.trim();
    setState(() => _overallCtrl.text = cur.isEmpty ? line : '$cur $line');
  }

  /// POST /api/secrets; returns null on success, else a human-readable error.
  Future<String?> _postSecret(String name, String value) async {
    final s = SettingsService.current;
    if (s == null) return 'no server';
    try {
      final res = await http
          .post(
            Uri.parse(s.buildHttpUrl('/api/secrets')),
            headers: {
              'Content-Type': 'application/json',
              if (s.token.isNotEmpty) 'X-Access-Token': s.token,
            },
            body: jsonEncode({
              'name': name,
              'value': value,
              'sessionId': widget.sessionId,
              'source': 'user',
            }),
          )
          .timeout(const Duration(seconds: 15));
      Object? data;
      try {
        data = jsonDecode(res.body);
      } catch (_) {}
      final ok = data is Map && data['ok'] == true;
      if (res.statusCode >= 200 && res.statusCode < 300 && ok) return null;
      final msg = data is Map ? data['error'] : null;
      return msg is String && msg.isNotEmpty ? msg : 'HTTP ${res.statusCode}';
    } catch (e) {
      return '$e';
    }
  }

  // ── UI ──

  String? get _ageText {
    final lm = _lastModified;
    if (lm == null) return null;
    final min = math.max(
      0,
      (DateTime.now().difference(lm).inMilliseconds / 60000).round(),
    );
    if (min < 1) return t('annotAgeJustNow');
    if (min < 60) return t('annotAgeMinutes', {'n': '$min'});
    return t('annotAgeHours', {'n': '${(min / 60).round()}'});
  }

  String _toolLabel(_Tool tool) => switch (tool) {
    _Tool.pan => t('annotToolPan'),
    _Tool.point => t('annotToolPoint'),
    _Tool.box => t('annotToolBox'),
    _Tool.arrow => t('annotToolArrow'),
  };

  String _kindLabel(AnnotationKind k) => switch (k) {
    AnnotationKind.point => t('annotToolPoint'),
    AnnotationKind.box => t('annotToolBox'),
    AnnotationKind.arrow => t('annotToolArrow'),
  };

  static const _toolIcons = {
    _Tool.pan: Icons.pan_tool_outlined,
    _Tool.point: Icons.adjust,
    _Tool.box: Icons.crop_square,
    _Tool.arrow: Icons.north_east,
  };

  @override
  Widget build(BuildContext context) {
    final age = _ageText;
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.black,
        foregroundColor: Colors.white,
        titleSpacing: 0,
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(t('annotTitle'), style: const TextStyle(fontSize: 15)),
            if (age != null)
              Text(
                age,
                style: const TextStyle(fontSize: 11, color: Colors.white70),
              ),
          ],
        ),
        actions: [
          if (age != null)
            TextButton(
              onPressed: _recapture,
              child: Text(
                t('annotRecapture'),
                style: const TextStyle(color: Color(0xFFffb4ac), fontSize: 12),
              ),
            ),
          IconButton(
            icon: const Icon(Icons.fit_screen, size: 20),
            tooltip: t('annotResetView'),
            onPressed: () => setState(() {
              _userMoved = false;
              _fit();
            }),
          ),
        ],
      ),
      body: _error != null
          ? Center(
              child: Padding(
                padding: const EdgeInsets.all(24),
                child: Text(
                  t('annotLoadFailed', {'error': _error!}),
                  style: const TextStyle(color: Color(0xFFff8a80)),
                  textAlign: TextAlign.center,
                ),
              ),
            )
          : _image == null
          ? const Center(
              child: CircularProgressIndicator(
                strokeWidth: 2,
                color: Colors.white70,
              ),
            )
          : LayoutBuilder(
              builder: (ctx, box) => Column(
                children: [
                  _toolRow(),
                  Expanded(child: _canvas()),
                  ConstrainedBox(
                    constraints: BoxConstraints(
                      maxHeight: box.maxHeight * 0.45,
                    ),
                    child: _panel(),
                  ),
                ],
              ),
            ),
    );
  }

  Widget _toolRow() {
    return Container(
      color: const Color(0xFF1b1f24),
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      child: Row(
        children: [
          for (final tool in _Tool.values)
            Padding(
              padding: const EdgeInsets.only(right: 6),
              child: ChoiceChip(
                showCheckmark: false,
                avatar: Icon(
                  _toolIcons[tool],
                  size: 16,
                  color: _tool == tool ? Colors.white : Colors.white70,
                ),
                label: Text(_toolLabel(tool)),
                labelStyle: TextStyle(
                  fontSize: 12,
                  color: _tool == tool ? Colors.white : Colors.white70,
                ),
                selected: _tool == tool,
                selectedColor: _markColor,
                backgroundColor: const Color(0xFF2a3038),
                side: BorderSide.none,
                visualDensity: VisualDensity.compact,
                onSelected: (_) => setState(() => _tool = tool),
              ),
            ),
          const Spacer(),
          IconButton(
            icon: const Icon(Icons.undo, color: Colors.white),
            tooltip: t('annotUndo'),
            onPressed: _entries.isEmpty ? null : _undo,
          ),
        ],
      ),
    );
  }

  Widget _canvas() {
    return LayoutBuilder(
      builder: (ctx, box) {
        final size = Size(box.maxWidth, box.maxHeight);
        if (size != _viewport) {
          _viewport = size;
          if (!_userMoved) _fit();
        }
        return Listener(
          behavior: HitTestBehavior.opaque,
          onPointerDown: _onDown,
          onPointerMove: _onMove,
          onPointerUp: _onUp,
          onPointerCancel: _onCancel,
          onPointerSignal: _onSignal,
          child: ClipRect(
            child: CustomPaint(
              size: size,
              painter: _AnnotatePainter(
                image: _image!,
                scale: _scale,
                offset: _offset,
                marks: [for (final e in _entries) e.mark],
                draft: _draftMark,
                finger: _gesture == _Gesture.draw ? _finger : null,
                fingerImage: _draftCur,
              ),
            ),
          ),
        );
      },
    );
  }

  Widget _panel() {
    const fieldStyle = TextStyle(color: Colors.white, fontSize: 13);
    InputDecoration deco(String hint) => InputDecoration(
      hintText: hint,
      hintStyle: const TextStyle(color: Colors.white38, fontSize: 13),
      isDense: true,
      filled: true,
      fillColor: const Color(0xFF2a3038),
      contentPadding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(6),
        borderSide: BorderSide.none,
      ),
    );
    return Container(
      color: const Color(0xFF1b1f24),
      child: ListView(
        shrinkWrap: true,
        padding: const EdgeInsets.fromLTRB(10, 6, 10, 10),
        children: [
          if (_entries.isEmpty)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 6),
              child: Text(
                t('annotEmpty'),
                style: const TextStyle(color: Colors.white54, fontSize: 12),
              ),
            ),
          for (var i = 0; i < _entries.length; i++)
            Padding(
              padding: const EdgeInsets.only(bottom: 6),
              child: Row(
                children: [
                  CircleAvatar(
                    radius: 11,
                    backgroundColor: _markColor,
                    child: Text(
                      '${i + 1}',
                      style: const TextStyle(
                        color: Colors.white,
                        fontSize: 12,
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                  ),
                  const SizedBox(width: 6),
                  SizedBox(
                    width: 34,
                    child: Text(
                      _kindLabel(_entries[i].mark.kind),
                      style: const TextStyle(
                        color: Colors.white70,
                        fontSize: 12,
                      ),
                    ),
                  ),
                  Expanded(
                    child: TextField(
                      controller: _entries[i].ctrl,
                      style: fieldStyle,
                      decoration: deco(t('annotNoteHint')),
                    ),
                  ),
                  IconButton(
                    icon: const Icon(
                      Icons.delete_outline,
                      color: Colors.white54,
                      size: 20,
                    ),
                    tooltip: t('delete'),
                    visualDensity: VisualDensity.compact,
                    onPressed: () => _removeAt(i),
                  ),
                ],
              ),
            ),
          TextField(
            controller: _overallCtrl,
            style: fieldStyle,
            minLines: 2,
            maxLines: 4,
            decoration: deco(t('annotOverallHint')),
          ),
          const SizedBox(height: 6),
          Text(
            t('annotWarning'),
            style: const TextStyle(color: Color(0xFFffcc80), fontSize: 11),
          ),
          const SizedBox(height: 8),
          Row(
            children: [
              OutlinedButton(
                onPressed: _openSecretDialog,
                style: OutlinedButton.styleFrom(
                  foregroundColor: Colors.white,
                  side: const BorderSide(color: Colors.white38),
                ),
                child: Text(t('annotSecretButton')),
              ),
              const Spacer(),
              FilledButton(
                onPressed: _exporting ? null : _finish,
                style: FilledButton.styleFrom(backgroundColor: _markColor),
                child: _exporting
                    ? const SizedBox(
                        width: 16,
                        height: 16,
                        child: CircularProgressIndicator(
                          strokeWidth: 2,
                          color: Colors.white,
                        ),
                      )
                    : Text(t('annotInsert')),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

/// Draw numbered marks in image-pixel space. Sizes match the web canvas
/// (stroke 5, point r=22, label r=16/18px, arrow head 26). [k] enlarges them on
/// screen when zoomed far out; the exported PNG always uses k = 1.
void paintAnnotationMarks(
  Canvas canvas,
  List<AnnotationMark> marks, {
  AnnotationMark? draft,
  double k = 1,
}) {
  for (var i = 0; i < marks.length; i++) {
    _paintMark(canvas, marks[i], i + 1, k);
  }
  if (draft != null) _paintMark(canvas, draft, null, k);
}

void _paintMark(Canvas canvas, AnnotationMark m, int? number, double k) {
  final stroke = Paint()
    ..color = _markColor
    ..style = PaintingStyle.stroke
    ..strokeWidth = 5 * k;
  final fill = Paint()
    ..color = _markColor
    ..style = PaintingStyle.fill;
  final a = Offset(m.ax, m.ay);
  final b = Offset(m.bx, m.by);
  Offset label;
  switch (m.kind) {
    case AnnotationKind.point:
      canvas.drawCircle(a, 22 * k, stroke);
      label = a + Offset(18 * k, -18 * k);
    case AnnotationKind.box:
      canvas.drawRect(Rect.fromPoints(a, b), stroke);
      label = Offset(math.min(a.dx, b.dx), math.min(a.dy, b.dy));
    case AnnotationKind.arrow:
      final ang = math.atan2(b.dy - a.dy, b.dx - a.dx);
      canvas.drawLine(a, b, stroke);
      final h = 26 * k;
      final path = Path()
        ..moveTo(b.dx, b.dy)
        ..lineTo(b.dx - h * math.cos(ang - 0.4), b.dy - h * math.sin(ang - 0.4))
        ..lineTo(b.dx - h * math.cos(ang + 0.4), b.dy - h * math.sin(ang + 0.4))
        ..close();
      canvas.drawPath(path, fill);
      label = a;
  }
  if (number == null) return;
  canvas.drawCircle(label, 16 * k, fill);
  final tp = TextPainter(
    text: TextSpan(
      text: '$number',
      style: TextStyle(
        color: Colors.white,
        fontSize: 18 * k,
        fontWeight: FontWeight.bold,
        height: 1,
      ),
    ),
    textDirection: TextDirection.ltr,
  )..layout();
  tp.paint(canvas, label - Offset(tp.width / 2, tp.height / 2 - k));
  tp.dispose();
}

class _AnnotatePainter extends CustomPainter {
  final ui.Image image;
  final double scale;
  final Offset offset;
  final List<AnnotationMark> marks;
  final AnnotationMark? draft;
  final Offset? finger; // screen coords
  final Offset? fingerImage; // image coords under the finger

  _AnnotatePainter({
    required this.image,
    required this.scale,
    required this.offset,
    required this.marks,
    required this.draft,
    required this.finger,
    required this.fingerImage,
  });

  static const _loupeR = 60.0;

  void _scene(Canvas canvas, double s) {
    canvas.drawImage(
      image,
      Offset.zero,
      Paint()..filterQuality = FilterQuality.medium,
    );
    paintAnnotationMarks(
      canvas,
      marks,
      draft: draft,
      k: math.max(1.0, 0.6 / s),
    );
  }

  @override
  void paint(Canvas canvas, Size size) {
    canvas.save();
    canvas.translate(offset.dx, offset.dy);
    canvas.scale(scale);
    _scene(canvas, scale);
    canvas.restore();

    final f = finger;
    final fi = fingerImage;
    if (f == null || fi == null) return;
    // Loupe sits above the finger; flips below near the top edge.
    var c = f - const Offset(0, _loupeR + 40);
    if (c.dy - _loupeR < 0) c = f + const Offset(0, _loupeR + 40);
    c = Offset(
      c.dx.clamp(_loupeR, math.max(_loupeR, size.width - _loupeR)),
      c.dy,
    );
    final zoom = scale * 2;
    final circle = Path()..addOval(Rect.fromCircle(center: c, radius: _loupeR));
    canvas.save();
    canvas.clipPath(circle);
    canvas.drawColor(Colors.black, BlendMode.src);
    canvas.translate(c.dx, c.dy);
    canvas.scale(zoom);
    canvas.translate(-fi.dx, -fi.dy);
    _scene(canvas, zoom);
    canvas.restore();
    canvas.drawCircle(
      c,
      _loupeR,
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 2
        ..color = Colors.white,
    );
    final cross = Paint()
      ..color = _markColor
      ..strokeWidth = 1;
    canvas.drawLine(c - const Offset(12, 0), c + const Offset(12, 0), cross);
    canvas.drawLine(c - const Offset(0, 12), c + const Offset(0, 12), cross);
  }

  @override
  bool shouldRepaint(covariant _AnnotatePainter old) => true;
}
