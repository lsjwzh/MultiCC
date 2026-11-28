import 'dart:async';
import 'dart:io';
import 'dart:math' as math;
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

import '../i18n.dart';

/// Result returned when the user finishes editing an image attachment.
class EditedAttachmentImage {
  final Uint8List bytes;
  final String filename;
  const EditedAttachmentImage({required this.bytes, required this.filename});
}

/// Active interaction tool in [AttachmentImageEditorScreen].
enum ImageEditorTool { pan, crop, pen, box, arrow, text, mosaic }

/// One vector or redaction mark in image-pixel coordinates.
class EditorStrokeMark {
  final ImageEditorTool tool;
  final Color color;
  final double strokeWidth;
  final List<Offset> points;
  final String? text;

  const EditorStrokeMark({
    required this.tool,
    required this.color,
    required this.strokeWidth,
    required this.points,
    this.text,
  });

  Offset get start => points.isEmpty ? Offset.zero : points.first;
  Offset get end => points.isEmpty ? Offset.zero : points.last;
}

/// Compute the edited PNG filename for an original image name.
String editedAttachmentFilename(String originalName) {
  final base = originalName.trim().replaceAll('\\', '/').split('/').last.trim();
  if (base.isEmpty) return 'image_edited.png';
  final dot = base.lastIndexOf('.');
  final stem = dot > 0 ? base.substring(0, dot) : base;
  if (stem.isEmpty) return 'image_edited.png';
  return stem.toLowerCase().endsWith('_edited') ? '$stem.png' : '${stem}_edited.png';
}

/// Clamp [rect] into `[0..imageSize.width] x [0..imageSize.height]`, respecting
/// [minSize] and optional [aspectRatio] (`width / height`).
Rect clampCropRect(Rect rect, Size imageSize, {double minSize = 24, double? aspectRatio}) {
  final imgW = imageSize.width, imgH = imageSize.height;
  if (imgW <= 0 || imgH <= 0) return Rect.zero;
  final minW = math.min(math.max(1.0, minSize), imgW);
  final minH = math.min(math.max(1.0, minSize), imgH);
  final l0 = math.min(rect.left, rect.right), t0 = math.min(rect.top, rect.bottom);
  final r0 = math.max(rect.left, rect.right), b0 = math.max(rect.top, rect.bottom);
  var w = (r0 - l0).clamp(minW, imgW).toDouble();
  var h = (b0 - t0).clamp(minH, imgH).toDouble();

  if (aspectRatio != null && aspectRatio > 0) {
    final cx = (l0 + r0) / 2, cy = (t0 + b0) / 2;
    h = w / aspectRatio;
    if (h > imgH) { h = imgH; w = h * aspectRatio; }
    if (w > imgW) { w = imgW; h = w / aspectRatio; }
    if (w < minW) { w = minW; h = w / aspectRatio; }
    if (h < minH) { h = minH; w = h * aspectRatio; }
    if (w > imgW) { w = imgW; h = w / aspectRatio; }
    if (h > imgH) { h = imgH; w = h * aspectRatio; }
    w = w.clamp(1.0, imgW).toDouble();
    h = h.clamp(1.0, imgH).toDouble();
    return Rect.fromLTWH(
      (cx - w / 2).clamp(0.0, imgW - w).toDouble(),
      (cy - h / 2).clamp(0.0, imgH - h).toDouble(),
      w,
      h,
    );
  }
  return Rect.fromLTWH(
    l0.clamp(0.0, imgW - w).toDouble(),
    t0.clamp(0.0, imgH - h).toDouble(),
    w,
    h,
  );
}

/// Paint [marks] onto [canvas] in image-pixel coordinates.
void paintEditorMarks(Canvas canvas, List<EditorStrokeMark> marks, {Size? imageSize}) {
  for (final mark in marks) {
    _paintEditorMark(canvas, mark, imageSize: imageSize);
  }
}

void _paintEditorMark(Canvas canvas, EditorStrokeMark mark, {Size? imageSize}) {
  if (mark.points.isEmpty) return;
  switch (mark.tool) {
    case ImageEditorTool.pen:
      if (mark.points.length == 1) {
        canvas.drawCircle(mark.points.first, math.max(1.0, mark.strokeWidth / 2), Paint()..color = mark.color);
        return;
      }
      final path = Path()..moveTo(mark.points.first.dx, mark.points.first.dy);
      for (var i = 1; i < mark.points.length; i++) {
        path.lineTo(mark.points[i].dx, mark.points[i].dy);
      }
      canvas.drawPath(
        path,
        Paint()
          ..color = mark.color
          ..style = PaintingStyle.stroke
          ..strokeWidth = mark.strokeWidth
          ..strokeCap = StrokeCap.round
          ..strokeJoin = StrokeJoin.round,
      );

    case ImageEditorTool.box:
      canvas.drawRect(
        Rect.fromPoints(mark.start, mark.end),
        Paint()..color = mark.color..style = PaintingStyle.stroke..strokeWidth = mark.strokeWidth,
      );

    case ImageEditorTool.arrow:
      final a = mark.start, b = mark.end;
      final len = (b - a).distance;
      if (len < 1) return;
      final ang = math.atan2(b.dy - a.dy, b.dx - a.dx);
      final headLen = math.max(mark.strokeWidth * 3.6, 16.0);
      final shaftEnd = len > headLen * 0.7
          ? Offset(b.dx - headLen * 0.65 * math.cos(ang), b.dy - headLen * 0.65 * math.sin(ang))
          : a;
      canvas.drawLine(
        a,
        shaftEnd,
        Paint()..color = mark.color..style = PaintingStyle.stroke..strokeWidth = mark.strokeWidth..strokeCap = StrokeCap.round,
      );
      final head = Path()
        ..moveTo(b.dx, b.dy)
        ..lineTo(b.dx - headLen * math.cos(ang - 0.42), b.dy - headLen * math.sin(ang - 0.42))
        ..lineTo(b.dx - headLen * math.cos(ang + 0.42), b.dy - headLen * math.sin(ang + 0.42))
        ..close();
      canvas.drawPath(head, Paint()..color = mark.color);

    case ImageEditorTool.text:
      final content = (mark.text ?? '').trim();
      if (content.isEmpty) return;
      final fontSize = (mark.strokeWidth * 4.5).clamp(14.0, 96.0).toDouble();
      final maxW = imageSize != null ? math.max(80.0, imageSize.width * 0.8) : 600.0;
      final tp = TextPainter(
        text: TextSpan(
          text: content,
          style: TextStyle(color: mark.color, fontSize: fontSize, fontWeight: FontWeight.w600, height: 1.2),
        ),
        textDirection: TextDirection.ltr,
      )..layout(maxWidth: maxW);
      final padX = fontSize * 0.45, padY = fontSize * 0.25;
      final pillW = tp.width + padX * 2, pillH = tp.height + padY * 2;
      var left = mark.start.dx - pillW / 2, top = mark.start.dy - pillH / 2;
      if (imageSize != null) {
        left = left.clamp(0.0, math.max(0.0, imageSize.width - pillW));
        top = top.clamp(0.0, math.max(0.0, imageSize.height - pillH));
      }
      final bg = mark.color.computeLuminance() < 0.15 ? const Color(0xD9FFFFFF) : const Color(0xB811161D);
      canvas.drawRRect(
        RRect.fromRectAndRadius(Rect.fromLTWH(left, top, pillW, pillH), Radius.circular(fontSize * 0.35)),
        Paint()..color = bg,
      );
      tp.paint(canvas, Offset(left + padX, top + padY));
      tp.dispose();

    case ImageEditorTool.mosaic:
      final rect = Rect.fromPoints(mark.start, mark.end);
      if (rect.width < 1 || rect.height < 1) return;
      const shades = [Color(0xFF1F242C), Color(0xFF333B47), Color(0xFF4B5565), Color(0xFF667285)];
      final cell = math.max(8.0, mark.strokeWidth * 2.2);
      canvas.save();
      canvas.clipRect(rect);
      final paint = Paint();
      var row = 0;
      for (var y = rect.top; y < rect.bottom; y += cell, row++) {
        var col = 0;
        for (var x = rect.left; x < rect.right; x += cell, col++) {
          paint.color = shades[(row * 3 + col * 5 + (row ^ col)) % shades.length];
          canvas.drawRect(Rect.fromLTWH(x, y, cell + 0.5, cell + 0.5), paint);
        }
      }
      canvas.restore();

    case ImageEditorTool.pan:
    case ImageEditorTool.crop:
      return;
  }
}

/// Render [source] with [marks], optional [cropRect], and [quarterTurns]
/// (clockwise 90-degree increments) into a new [ui.Image].
Future<ui.Image> renderEditedUiImage(
  ui.Image source, {
  Rect? cropRect,
  int quarterTurns = 0,
  List<EditorStrokeMark> marks = const [],
}) async {
  final srcSize = Size(source.width.toDouble(), source.height.toDouble());
  final crop = cropRect == null
      ? Rect.fromLTWH(0, 0, srcSize.width, srcSize.height)
      : clampCropRect(cropRect, srcSize, minSize: 1);
  final cw = math.max(1, crop.width.round());
  final ch = math.max(1, crop.height.round());
  final turns = ((quarterTurns % 4) + 4) % 4;
  final outW = turns.isOdd ? ch : cw;
  final outH = turns.isOdd ? cw : ch;

  final recorder = ui.PictureRecorder();
  final canvas = Canvas(recorder, Rect.fromLTWH(0, 0, outW.toDouble(), outH.toDouble()));
  switch (turns) {
    case 1:
      canvas.translate(outW.toDouble(), 0);
      canvas.rotate(math.pi / 2);
    case 2:
      canvas.translate(outW.toDouble(), outH.toDouble());
      canvas.rotate(math.pi);
    case 3:
      canvas.translate(0, outH.toDouble());
      canvas.rotate(-math.pi / 2);
    default:
      break;
  }
  canvas.clipRect(Rect.fromLTWH(0, 0, cw.toDouble(), ch.toDouble()));
  canvas.translate(-crop.left, -crop.top);
  canvas.drawImage(source, Offset.zero, Paint()..filterQuality = FilterQuality.high);
  if (marks.isNotEmpty) paintEditorMarks(canvas, marks, imageSize: srcSize);

  final picture = recorder.endRecording();
  try {
    return await picture.toImage(outW, outH);
  } finally {
    picture.dispose();
  }
}

/// Encode [image] as PNG bytes.
Future<Uint8List> encodeUiImagePng(ui.Image image) async {
  final data = await image.toByteData(format: ui.ImageByteFormat.png);
  if (data == null) throw StateError('Failed to encode image as PNG');
  return data.buffer.asUint8List();
}

/// Full-screen image crop, rotate, and annotation editor for pending attachments.
class AttachmentImageEditorScreen extends StatefulWidget {
  final Uint8List? initialBytes;
  final String? localPath;
  final String? url;
  final Map<String, String> headers;
  final String filename;

  const AttachmentImageEditorScreen({
    super.key,
    this.initialBytes,
    this.localPath,
    this.url,
    this.headers = const {},
    required this.filename,
  });

  @override
  State<AttachmentImageEditorScreen> createState() => _AttachmentImageEditorScreenState();
}

enum _EditorGesture { none, pan, draw, cropDrag, pinch }

enum _CropHandle { none, move, topLeft, topRight, bottomLeft, bottomRight, top, bottom, left, right }

class _EditorSnapshot {
  final ui.Image image;
  final List<EditorStrokeMark> marks;
  const _EditorSnapshot({required this.image, required this.marks});
}

class _RatioPreset {
  final String? labelKey;
  final String? fixedLabel;
  final double? ratio;
  const _RatioPreset({this.labelKey, this.fixedLabel, this.ratio});
  String get label => labelKey != null ? t(labelKey!) : (fixedLabel ?? '');
}

const _paletteColors = [
  Color(0xFFFF3B30),
  Color(0xFFFFCC00),
  Color(0xFF34C759),
  Color(0xFF0A84FF),
  Color(0xFFFFFFFF),
  Color(0xFF111111),
];
const _strokePresets = [2.8, 5.5, 10.0];
const _ratioPresets = [
  _RatioPreset(labelKey: 'attachEditorRatioFree', ratio: null),
  _RatioPreset(fixedLabel: '1:1', ratio: 1.0),
  _RatioPreset(fixedLabel: '4:3', ratio: 4 / 3),
  _RatioPreset(fixedLabel: '16:9', ratio: 16 / 9),
];

class _AttachmentImageEditorScreenState extends State<AttachmentImageEditorScreen> {
  ui.Image? _initialImage;
  ui.Image? _currentImage;
  String? _error;
  bool _exporting = false;
  bool _transforming = false;

  ImageEditorTool _tool = ImageEditorTool.pen;
  Color _color = _paletteColors.first;
  int _strokeIndex = 1;
  List<EditorStrokeMark> _marks = [];
  final List<_EditorSnapshot> _undoStack = [];

  Rect? _cropRect;
  double? _cropRatio;
  _CropHandle _cropHandle = _CropHandle.none;
  Rect? _cropDragStartRect;
  Offset? _cropDragStartImg;

  double _scale = 1;
  Offset _offset = Offset.zero;
  bool _userMoved = false;
  Size _viewport = Size.zero;

  final Map<int, Offset> _pointers = {};
  _EditorGesture _gesture = _EditorGesture.none;
  List<Offset> _draftPoints = [];
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
    final all = Set<ui.Image>.identity();
    if (_initialImage != null) all.add(_initialImage!);
    if (_currentImage != null) all.add(_currentImage!);
    for (final s in _undoStack) {
      all.add(s.image);
    }
    for (final img in all) {
      img.dispose();
    }
    super.dispose();
  }

  void _disposeUnusedImages(Iterable<ui.Image> candidates) {
    final live = Set<ui.Image>.identity();
    if (_initialImage != null) live.add(_initialImage!);
    if (_currentImage != null) live.add(_currentImage!);
    for (final s in _undoStack) {
      live.add(s.image);
    }
    for (final img in Set<ui.Image>.identity()..addAll(candidates)) {
      if (!live.contains(img)) img.dispose();
    }
  }

  Future<void> _load() async {
    try {
      Uint8List? bytes = widget.initialBytes;
      if ((bytes == null || bytes.isEmpty) && (widget.localPath?.isNotEmpty ?? false)) {
        final file = File(widget.localPath!);
        if (await file.exists()) bytes = await file.readAsBytes();
      }
      if ((bytes == null || bytes.isEmpty) && (widget.url?.isNotEmpty ?? false)) {
        final res = await http
            .get(Uri.parse(widget.url!), headers: widget.headers)
            .timeout(const Duration(seconds: 30));
        if (res.statusCode != 200) throw Exception('HTTP ${res.statusCode}');
        bytes = res.bodyBytes;
      }
      if (bytes == null || bytes.isEmpty) throw StateError('No image source available');
      final codec = await ui.instantiateImageCodec(bytes);
      final frame = await codec.getNextFrame();
      codec.dispose();
      if (!mounted) {
        frame.image.dispose();
        return;
      }
      setState(() {
        _initialImage = frame.image;
        _currentImage = frame.image;
      });
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    }
  }

  Size get _imageSize => _currentImage == null
      ? Size.zero
      : Size(_currentImage!.width.toDouble(), _currentImage!.height.toDouble());

  double get _fitScale {
    final img = _currentImage;
    if (img == null || _viewport.isEmpty) return 1;
    return math.min(math.max(1.0, _viewport.width - 24) / img.width, math.max(1.0, _viewport.height - 24) / img.height);
  }

  void _fit() {
    final img = _currentImage;
    if (img == null || _viewport.isEmpty) return;
    _scale = _fitScale;
    _offset = Offset((_viewport.width - img.width * _scale) / 2, (_viewport.height - img.height * _scale) / 2);
  }

  Offset _toImage(Offset screen) => (screen - _offset) / _scale;
  Offset _clampToImage(Offset p) => Offset(p.dx.clamp(0.0, _imageSize.width), p.dy.clamp(0.0, _imageSize.height));
  double _clampScale(double s) => s.clamp(_fitScale * 0.5, math.max(_fitScale * 8, 6.0)).toDouble();
  double get _cropMinSize => math.min(24.0, math.min(_imageSize.width, _imageSize.height));
  double get _effectiveStrokeWidth {
    final longest = math.max(_imageSize.width, _imageSize.height);
    return _strokePresets[_strokeIndex] * (longest <= 0 ? 1.0 : (longest / 800.0).clamp(0.6, 5.0));
  }

  void _selectTool(ImageEditorTool tool) {
    if (_currentImage == null || _transforming || _exporting) return;
    setState(() {
      _discardDraft();
      _tool = tool;
      if (tool == ImageEditorTool.crop) {
        _cropRect ??= Rect.fromLTWH(0, 0, _imageSize.width, _imageSize.height);
        _userMoved = false;
        _fit();
      }
    });
  }

  void _setCropRatio(double? ratio) {
    if (_currentImage == null) return;
    setState(() {
      _cropRatio = ratio;
      final base = _cropRect ?? Rect.fromLTWH(0, 0, _imageSize.width, _imageSize.height);
      _cropRect = clampCropRect(base, _imageSize, minSize: _cropMinSize, aspectRatio: ratio);
    });
  }

  void _cancelCrop() {
    setState(() {
      _cropRect = null;
      _cropRatio = null;
      _cropHandle = _CropHandle.none;
      if (_tool == ImageEditorTool.crop) _tool = ImageEditorTool.pan;
    });
  }

  Future<void> _commitImageTransform({Rect? cropRect, int quarterTurns = 0, bool exitCrop = false}) async {
    final img = _currentImage;
    if (img == null || _transforming || _exporting) return;
    setState(() => _transforming = true);
    try {
      final next = await renderEditedUiImage(img, cropRect: cropRect, quarterTurns: quarterTurns, marks: _marks);
      if (!mounted) {
        next.dispose();
        return;
      }
      setState(() {
        _undoStack.add(_EditorSnapshot(image: img, marks: List.of(_marks)));
        _currentImage = next;
        _marks = [];
        _cropHandle = _CropHandle.none;
        if (exitCrop) {
          _cropRect = null;
          _cropRatio = null;
          _tool = ImageEditorTool.pan;
        } else if (_tool == ImageEditorTool.crop) {
          final sz = Size(next.width.toDouble(), next.height.toDouble());
          _cropRect = clampCropRect(
            Rect.fromLTWH(0, 0, sz.width, sz.height),
            sz,
            minSize: math.min(24.0, math.min(sz.width, sz.height)),
            aspectRatio: _cropRatio,
          );
        } else {
          _cropRect = null;
        }
        _userMoved = false;
        _fit();
        _transforming = false;
      });
    } catch (e) {
      if (mounted) {
        setState(() => _transforming = false);
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(t('attachEditorSaveFailed', {'error': '$e'}))),
        );
      }
    }
  }

  Future<void> _applyCrop() async {
    if (_cropRect != null) await _commitImageTransform(cropRect: _cropRect, exitCrop: true);
  }

  Future<void> _rotateClockwise() => _commitImageTransform(quarterTurns: 1);

  void _undo() {
    if (_undoStack.isEmpty || _transforming || _exporting) return;
    final oldImage = _currentImage;
    final snap = _undoStack.removeLast();
    final resized = oldImage == null || oldImage.width != snap.image.width || oldImage.height != snap.image.height;
    setState(() {
      _discardDraft();
      _currentImage = snap.image;
      _marks = List.of(snap.marks);
      _cropRect = _tool == ImageEditorTool.crop
          ? Rect.fromLTWH(0, 0, snap.image.width.toDouble(), snap.image.height.toDouble())
          : null;
      if (resized) {
        _userMoved = false;
        _fit();
      }
    });
    if (oldImage != null) _disposeUnusedImages([oldImage]);
  }

  void _reset() {
    final initImg = _initialImage;
    if (initImg == null || _transforming || _exporting) return;
    final candidates = <ui.Image>[if (_currentImage != null) _currentImage!, for (final s in _undoStack) s.image];
    setState(() {
      _discardDraft();
      _undoStack.clear();
      _currentImage = initImg;
      _marks = [];
      _cropRatio = null;
      _cropRect = _tool == ImageEditorTool.crop
          ? Rect.fromLTWH(0, 0, initImg.width.toDouble(), initImg.height.toDouble())
          : null;
      _userMoved = false;
      _fit();
    });
    _disposeUnusedImages(candidates);
  }

  Future<void> _finish() async {
    final img = _currentImage;
    if (img == null || _exporting || _transforming) return;
    setState(() => _exporting = true);
    ui.Image? rendered;
    try {
      rendered = await renderEditedUiImage(
        img,
        cropRect: _tool == ImageEditorTool.crop ? _cropRect : null,
        marks: _marks,
      );
      final png = await encodeUiImagePng(rendered);
      rendered.dispose();
      rendered = null;
      if (!mounted) return;
      Navigator.of(context).pop(
        EditedAttachmentImage(bytes: png, filename: editedAttachmentFilename(widget.filename)),
      );
    } catch (e) {
      rendered?.dispose();
      if (!mounted) return;
      setState(() => _exporting = false);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(t('attachEditorSaveFailed', {'error': '$e'}))),
      );
    }
  }

  void _discardDraft() {
    _draftPoints = [];
    _cropHandle = _CropHandle.none;
    _cropDragStartRect = null;
    _cropDragStartImg = null;
  }

  void _startPinch() {
    final pts = _pointers.values.take(2).toList();
    _pinchStartDist = math.max(1.0, (pts[0] - pts[1]).distance);
    _pinchStartScale = _scale;
    _pinchImgFocal = _toImage((pts[0] + pts[1]) / 2);
    _gesture = _EditorGesture.pinch;
  }

  _CropHandle _hitTestCrop(Offset screenPos) {
    final r = _cropRect;
    if (r == null) return _CropHandle.none;
    final p = _toImage(screenPos);
    final hit = 24.0 / math.max(0.05, _scale);
    if ((p - r.topLeft).distance <= hit) return _CropHandle.topLeft;
    if ((p - r.topRight).distance <= hit) return _CropHandle.topRight;
    if ((p - r.bottomLeft).distance <= hit) return _CropHandle.bottomLeft;
    if ((p - r.bottomRight).distance <= hit) return _CropHandle.bottomRight;
    final inX = p.dx >= r.left - hit && p.dx <= r.right + hit;
    final inY = p.dy >= r.top - hit && p.dy <= r.bottom + hit;
    if ((p.dy - r.top).abs() <= hit && inX) return _CropHandle.top;
    if ((p.dy - r.bottom).abs() <= hit && inX) return _CropHandle.bottom;
    if ((p.dx - r.left).abs() <= hit && inY) return _CropHandle.left;
    if ((p.dx - r.right).abs() <= hit && inY) return _CropHandle.right;
    return r.contains(p) ? _CropHandle.move : _CropHandle.none;
  }

  void _updateCropDrag(Offset screenPos) {
    final sr = _cropDragStartRect, sp = _cropDragStartImg;
    if (sr == null || sp == null) return;
    final sz = _imageSize, minSz = _cropMinSize, d = _toImage(screenPos) - sp;
    if (_cropHandle == _CropHandle.move) {
      _cropRect = clampCropRect(sr.shift(d), sz, minSize: minSz, aspectRatio: _cropRatio);
      return;
    }
    var l = sr.left, t0 = sr.top, r = sr.right, b = sr.bottom;
    switch (_cropHandle) {
      case _CropHandle.topLeft:
        l = (l + d.dx).clamp(0.0, r - minSz);
        t0 = (t0 + d.dy).clamp(0.0, b - minSz);
      case _CropHandle.topRight:
        r = (r + d.dx).clamp(l + minSz, sz.width);
        t0 = (t0 + d.dy).clamp(0.0, b - minSz);
      case _CropHandle.bottomLeft:
        l = (l + d.dx).clamp(0.0, r - minSz);
        b = (b + d.dy).clamp(t0 + minSz, sz.height);
      case _CropHandle.bottomRight:
        r = (r + d.dx).clamp(l + minSz, sz.width);
        b = (b + d.dy).clamp(t0 + minSz, sz.height);
      case _CropHandle.top:
        t0 = (t0 + d.dy).clamp(0.0, b - minSz);
      case _CropHandle.bottom:
        b = (b + d.dy).clamp(t0 + minSz, sz.height);
      case _CropHandle.left:
        l = (l + d.dx).clamp(0.0, r - minSz);
      case _CropHandle.right:
        r = (r + d.dx).clamp(l + minSz, sz.width);
      case _CropHandle.move:
      case _CropHandle.none:
        return;
    }
    _cropRect = clampCropRect(Rect.fromLTRB(l, t0, r, b), sz, minSize: minSz, aspectRatio: _cropRatio);
  }

  void _onDown(PointerDownEvent e) {
    if (_currentImage == null || _transforming || _exporting) return;
    _pointers[e.pointer] = e.localPosition;
    setState(() {
      if (_pointers.length >= 2) {
        _discardDraft();
        _startPinch();
        return;
      }
      if (_tool == ImageEditorTool.pan) {
        _gesture = _EditorGesture.pan;
      } else if (_tool == ImageEditorTool.crop) {
        final handle = _hitTestCrop(e.localPosition);
        if (handle == _CropHandle.none) {
          _gesture = _EditorGesture.pan;
        } else {
          _gesture = _EditorGesture.cropDrag;
          _cropHandle = handle;
          _cropDragStartRect = _cropRect;
          _cropDragStartImg = _toImage(e.localPosition);
        }
      } else {
        _gesture = _EditorGesture.draw;
        _draftPoints = [_clampToImage(_toImage(e.localPosition))];
      }
    });
  }

  void _onMove(PointerMoveEvent e) {
    if (!_pointers.containsKey(e.pointer)) return;
    final prev = _pointers[e.pointer]!;
    _pointers[e.pointer] = e.localPosition;
    setState(() {
      switch (_gesture) {
        case _EditorGesture.pinch:
          if (_pointers.length < 2) return;
          final pts = _pointers.values.take(2).toList();
          final focal = (pts[0] + pts[1]) / 2;
          _scale = _clampScale(_pinchStartScale * math.max(1.0, (pts[0] - pts[1]).distance) / _pinchStartDist);
          _offset = focal - _pinchImgFocal * _scale;
          _userMoved = true;
        case _EditorGesture.pan:
          _offset += e.localPosition - prev;
          _userMoved = true;
        case _EditorGesture.cropDrag:
          _updateCropDrag(e.localPosition);
        case _EditorGesture.draw:
          final p = _clampToImage(_toImage(e.localPosition));
          if (_tool == ImageEditorTool.pen) {
            if (_draftPoints.isEmpty || (_draftPoints.last - p).distance >= 2) _draftPoints = [..._draftPoints, p];
          } else if (_draftPoints.isNotEmpty) {
            _draftPoints = [_draftPoints.first, p];
          }
        case _EditorGesture.none:
          break;
      }
    });
  }

  void _onUp(PointerUpEvent e) {
    if (!_pointers.containsKey(e.pointer)) return;
    _pointers.remove(e.pointer);
    Offset? pendingTextPos;
    setState(() {
      if (_gesture == _EditorGesture.draw && _pointers.isEmpty) {
        if (_tool == ImageEditorTool.text && _draftPoints.isNotEmpty) {
          pendingTextPos = _draftPoints.last;
          _discardDraft();
        } else {
          _commitDraft();
        }
      } else if (_gesture == _EditorGesture.cropDrag && _pointers.isEmpty) {
        _discardDraft();
      }
      _gesture = _pointers.isEmpty ? _EditorGesture.none : (_pointers.length == 1 ? _EditorGesture.pan : _EditorGesture.pinch);
      if (_pointers.length >= 2) _startPinch();
    });
    if (pendingTextPos != null) unawaited(_promptAndAddText(pendingTextPos!));
  }

  void _onCancel(PointerCancelEvent e) {
    _pointers.remove(e.pointer);
    setState(() {
      _discardDraft();
      _gesture = _pointers.isEmpty ? _EditorGesture.none : _EditorGesture.pan;
    });
  }

  void _onSignal(PointerSignalEvent e) {
    if (e is! PointerScrollEvent || _currentImage == null) return;
    final anchor = _toImage(e.localPosition);
    setState(() {
      _scale = _clampScale(_scale * math.pow(0.998, e.scrollDelta.dy));
      _offset = e.localPosition - anchor * _scale;
      _userMoved = true;
    });
  }

  void _commitDraft() {
    final pts = _draftPoints;
    _discardDraft();
    if (pts.isEmpty || _currentImage == null) return;
    if (_tool == ImageEditorTool.pen) {
      _pushMark(EditorStrokeMark(tool: _tool, color: _color, strokeWidth: _effectiveStrokeWidth, points: List.unmodifiable(pts)));
    } else if (_tool == ImageEditorTool.box || _tool == ImageEditorTool.arrow || _tool == ImageEditorTool.mosaic) {
      if (pts.length < 2 || (pts.last - pts.first).distance < 4 / math.max(0.1, _scale)) return;
      _pushMark(EditorStrokeMark(tool: _tool, color: _color, strokeWidth: _effectiveStrokeWidth, points: [pts.first, pts.last]));
    }
  }

  void _pushMark(EditorStrokeMark mark) {
    final img = _currentImage;
    if (img == null) return;
    _undoStack.add(_EditorSnapshot(image: img, marks: List.of(_marks)));
    _marks = [..._marks, mark];
  }

  Future<void> _promptAndAddText(Offset imagePos) async {
    final ctrl = TextEditingController();
    final entered = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(t('attachEditorTextTitle')),
        content: TextField(
          controller: ctrl,
          autofocus: true,
          maxLines: 3,
          minLines: 1,
          decoration: InputDecoration(hintText: t('attachEditorTextHint')),
          onSubmitted: (v) => Navigator.of(ctx).pop(v),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(ctx).pop(), child: Text(t('cancel'))),
          FilledButton(onPressed: () => Navigator.of(ctx).pop(ctrl.text), child: Text(t('confirm'))),
        ],
      ),
    );
    ctrl.dispose();
    final trimmed = entered?.trim() ?? '';
    if (!mounted || trimmed.isEmpty) return;
    setState(() {
      _pushMark(EditorStrokeMark(
        tool: ImageEditorTool.text,
        color: _color,
        strokeWidth: _effectiveStrokeWidth,
        points: [imagePos],
        text: trimmed,
      ));
    });
  }

  EditorStrokeMark? get _draftMark {
    if (_draftPoints.isEmpty) return null;
    if (_tool != ImageEditorTool.pen && _tool != ImageEditorTool.box && _tool != ImageEditorTool.arrow && _tool != ImageEditorTool.mosaic) {
      return null;
    }
    return EditorStrokeMark(tool: _tool, color: _color, strokeWidth: _effectiveStrokeWidth, points: _draftPoints);
  }

  bool get _canReset => _undoStack.isNotEmpty || _marks.isNotEmpty || _cropRect != null;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.black,
        foregroundColor: Colors.white,
        titleSpacing: 0,
        title: Text(t('attachEditorTitle'), style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
        actions: [
          IconButton(
            key: const ValueKey('attach-editor-undo'),
            icon: const Icon(Icons.undo_rounded, size: 20),
            tooltip: t('attachEditorUndo'),
            onPressed: _undoStack.isEmpty || _transforming || _exporting ? null : _undo,
          ),
          IconButton(
            key: const ValueKey('attach-editor-reset'),
            icon: const Icon(Icons.restore_rounded, size: 20),
            tooltip: t('attachEditorReset'),
            onPressed: !_canReset || _transforming || _exporting ? null : _reset,
          ),
          Padding(
            padding: const EdgeInsets.only(right: 8, left: 4),
            child: FilledButton(
              key: const ValueKey('attach-editor-done'),
              onPressed: _currentImage == null || _exporting || _transforming ? null : _finish,
              style: FilledButton.styleFrom(
                backgroundColor: const Color(0xFF1678e8),
                foregroundColor: Colors.white,
                minimumSize: const Size(0, 34),
                padding: const EdgeInsets.symmetric(horizontal: 14),
              ),
              child: _exporting
                  ? const SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                  : Text(t('attachEditorSave'), style: const TextStyle(fontSize: 13)),
            ),
          ),
        ],
      ),
      body: _error != null
          ? Center(
              child: Padding(
                padding: const EdgeInsets.all(24),
                child: Text(_error!, style: const TextStyle(color: Color(0xFFff8a80)), textAlign: TextAlign.center),
              ),
            )
          : _currentImage == null
          ? const Center(child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white70))
          : Column(children: [Expanded(child: _buildCanvas()), _buildBottomControls()]),
    );
  }

  Widget _buildCanvas() {
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
              painter: _EditorCanvasPainter(
                image: _currentImage!,
                scale: _scale,
                offset: _offset,
                marks: _marks,
                draft: _draftMark,
                cropRect: _tool == ImageEditorTool.crop ? _cropRect : null,
              ),
            ),
          ),
        );
      },
    );
  }

  Widget _buildBottomControls() {
    return SafeArea(
      top: false,
      child: Container(
        color: const Color(0xFF161A20),
        padding: const EdgeInsets.only(top: 6, bottom: 8),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (_tool == ImageEditorTool.crop) _buildCropSubBar() else if (_tool != ImageEditorTool.pan) _buildStyleSubBar(),
            const SizedBox(height: 4),
            _buildToolStrip(),
          ],
        ),
      ),
    );
  }

  Widget _buildCropSubBar() {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 10),
      child: Row(
        children: [
          Expanded(
            child: SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: Row(
                children: [
                  for (final preset in _ratioPresets)
                    Padding(
                      padding: const EdgeInsets.only(right: 6),
                      child: ChoiceChip(
                        showCheckmark: false,
                        label: Text(preset.label),
                        labelStyle: TextStyle(fontSize: 11.5, color: _cropRatio == preset.ratio ? Colors.white : Colors.white70),
                        selected: _cropRatio == preset.ratio,
                        selectedColor: const Color(0xFF1678e8),
                        backgroundColor: const Color(0xFF262C35),
                        side: BorderSide.none,
                        visualDensity: VisualDensity.compact,
                        materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                        onSelected: (_) => _setCropRatio(preset.ratio),
                      ),
                    ),
                ],
              ),
            ),
          ),
          TextButton(
            key: const ValueKey('attach-editor-cancel-crop'),
            onPressed: _cancelCrop,
            style: TextButton.styleFrom(foregroundColor: Colors.white70, visualDensity: VisualDensity.compact, padding: const EdgeInsets.symmetric(horizontal: 8)),
            child: Text(t('attachEditorCancelCrop'), style: const TextStyle(fontSize: 12)),
          ),
          FilledButton(
            key: const ValueKey('attach-editor-apply-crop'),
            onPressed: _transforming ? null : _applyCrop,
            style: FilledButton.styleFrom(
              backgroundColor: const Color(0xFF34C759),
              foregroundColor: Colors.white,
              visualDensity: VisualDensity.compact,
              minimumSize: const Size(0, 30),
              padding: const EdgeInsets.symmetric(horizontal: 10),
            ),
            child: Text(t('attachEditorApplyCrop'), style: const TextStyle(fontSize: 12)),
          ),
        ],
      ),
    );
  }

  Widget _buildStyleSubBar() {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 2),
      child: Row(
        children: [
          if (_tool != ImageEditorTool.mosaic)
            Expanded(
              child: Row(
                children: [
                  for (final c in _paletteColors)
                    Padding(
                      padding: const EdgeInsets.only(right: 8),
                      child: GestureDetector(
                        onTap: () => setState(() => _color = c),
                        child: Container(
                          width: 24,
                          height: 24,
                          decoration: BoxDecoration(
                            color: c,
                            shape: BoxShape.circle,
                            border: Border.all(
                              color: _color == c ? const Color(0xFF1678e8) : Colors.white54,
                              width: _color == c ? 2.5 : 1.2,
                            ),
                          ),
                        ),
                      ),
                    ),
                ],
              ),
            )
          else
            const Spacer(),
          Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              for (var i = 0; i < _strokePresets.length; i++)
                Padding(
                  padding: const EdgeInsets.only(left: 6),
                  child: GestureDetector(
                    onTap: () => setState(() => _strokeIndex = i),
                    child: Container(
                      width: 26,
                      height: 26,
                      alignment: Alignment.center,
                      decoration: BoxDecoration(
                        color: _strokeIndex == i ? const Color(0xFF2D3848) : Colors.transparent,
                        borderRadius: BorderRadius.circular(13),
                        border: Border.all(color: _strokeIndex == i ? const Color(0xFF1678e8) : Colors.white24),
                      ),
                      child: Container(
                        width: 5.0 + i * 3.5,
                        height: 5.0 + i * 3.5,
                        decoration: const BoxDecoration(color: Colors.white, shape: BoxShape.circle),
                      ),
                    ),
                  ),
                ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildToolStrip() {
    final items = <(String, IconData, String, bool, VoidCallback)>[
      ('crop', Icons.crop_rounded, 'attachEditorCrop', _tool == ImageEditorTool.crop, () => _selectTool(ImageEditorTool.crop)),
      ('rotate', Icons.rotate_right_rounded, 'attachEditorRotate', false, _rotateClockwise),
      ('pen', Icons.edit_rounded, 'attachEditorPen', _tool == ImageEditorTool.pen, () => _selectTool(ImageEditorTool.pen)),
      ('box', Icons.crop_square_rounded, 'attachEditorBox', _tool == ImageEditorTool.box, () => _selectTool(ImageEditorTool.box)),
      ('arrow', Icons.north_east_rounded, 'attachEditorArrow', _tool == ImageEditorTool.arrow, () => _selectTool(ImageEditorTool.arrow)),
      ('text', Icons.text_fields_rounded, 'attachEditorText', _tool == ImageEditorTool.text, () => _selectTool(ImageEditorTool.text)),
      ('mosaic', Icons.grid_on_rounded, 'attachEditorMosaic', _tool == ImageEditorTool.mosaic, () => _selectTool(ImageEditorTool.mosaic)),
      ('pan', Icons.pan_tool_outlined, 'attachEditorPan', _tool == ImageEditorTool.pan, () => _selectTool(ImageEditorTool.pan)),
    ];
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      padding: const EdgeInsets.symmetric(horizontal: 8),
      child: Row(
        children: [
          for (final (id, icon, keyName, active, onTap) in items)
            InkWell(
              key: ValueKey('attach-editor-tool-$id'),
              onTap: onTap,
              borderRadius: BorderRadius.circular(8),
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                decoration: BoxDecoration(
                  color: active ? const Color(0xFF1678e8) : Colors.transparent,
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Icon(icon, size: 19, color: active ? Colors.white : Colors.white70),
                    const SizedBox(height: 2),
                    Text(t(keyName), style: TextStyle(fontSize: 10.5, color: active ? Colors.white : Colors.white70)),
                  ],
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class _EditorCanvasPainter extends CustomPainter {
  final ui.Image image;
  final double scale;
  final Offset offset;
  final List<EditorStrokeMark> marks;
  final EditorStrokeMark? draft;
  final Rect? cropRect;

  _EditorCanvasPainter({
    required this.image,
    required this.scale,
    required this.offset,
    required this.marks,
    required this.draft,
    required this.cropRect,
  });

  @override
  void paint(Canvas canvas, Size size) {
    final imgSize = Size(image.width.toDouble(), image.height.toDouble());
    canvas.save();
    canvas.translate(offset.dx, offset.dy);
    canvas.scale(scale);
    canvas.drawImage(image, Offset.zero, Paint()..filterQuality = FilterQuality.medium);
    paintEditorMarks(canvas, marks, imageSize: imgSize);
    if (draft != null) paintEditorMarks(canvas, [draft!], imageSize: imgSize);
    if (cropRect != null) _paintCropOverlay(canvas, imgSize, cropRect!);
    canvas.restore();
  }

  void _paintCropOverlay(Canvas canvas, Size imgSize, Rect c) {
    final inv = 1.0 / math.max(0.05, scale);
    final mask = Paint()..color = const Color(0x99000000);
    canvas.drawRect(Rect.fromLTRB(0, 0, imgSize.width, c.top), mask);
    canvas.drawRect(Rect.fromLTRB(0, c.bottom, imgSize.width, imgSize.height), mask);
    canvas.drawRect(Rect.fromLTRB(0, c.top, c.left, c.bottom), mask);
    canvas.drawRect(Rect.fromLTRB(c.right, c.top, imgSize.width, c.bottom), mask);

    final grid = Paint()..color = Colors.white54..style = PaintingStyle.stroke..strokeWidth = 1.0 * inv;
    for (var i = 1; i <= 2; i++) {
      final gx = c.left + c.width * i / 3, gy = c.top + c.height * i / 3;
      canvas.drawLine(Offset(gx, c.top), Offset(gx, c.bottom), grid);
      canvas.drawLine(Offset(c.left, gy), Offset(c.right, gy), grid);
    }
    canvas.drawRect(c, Paint()..color = Colors.white..style = PaintingStyle.stroke..strokeWidth = 1.8 * inv);

    final hLen = math.min(18.0 * inv, math.min(c.width, c.height) * 0.35);
    final hPaint = Paint()..color = Colors.white..style = PaintingStyle.stroke..strokeWidth = 3.5 * inv..strokeCap = StrokeCap.square;
    for (final (p, dx, dy) in [(c.topLeft, 1.0, 1.0), (c.topRight, -1.0, 1.0), (c.bottomLeft, 1.0, -1.0), (c.bottomRight, -1.0, -1.0)]) {
      canvas.drawLine(p, p + Offset(dx * hLen, 0), hPaint);
      canvas.drawLine(p, p + Offset(0, dy * hLen), hPaint);
    }
    final eHalf = hLen * 0.35;
    canvas.drawLine(Offset(c.center.dx - eHalf, c.top), Offset(c.center.dx + eHalf, c.top), hPaint);
    canvas.drawLine(Offset(c.center.dx - eHalf, c.bottom), Offset(c.center.dx + eHalf, c.bottom), hPaint);
    canvas.drawLine(Offset(c.left, c.center.dy - eHalf), Offset(c.left, c.center.dy + eHalf), hPaint);
    canvas.drawLine(Offset(c.right, c.center.dy - eHalf), Offset(c.right, c.center.dy + eHalf), hPaint);
  }

  @override
  bool shouldRepaint(covariant _EditorCanvasPainter oldDelegate) => true;
}
