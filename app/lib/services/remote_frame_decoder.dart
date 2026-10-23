import 'dart:async';
import 'dart:typed_data';
import 'dart:ui' as ui;

typedef RemotePixelDecoder =
    Future<ui.Image> Function(Uint8List pixels, int width, int height);

/// At most one decode in flight and one latest snapshot waiting behind it.
/// A final update arriving during decode must paint even if capture then idles.
class RemoteFrameDecoder {
  RemoteFrameDecoder({required this.onImage, RemotePixelDecoder? decode})
    : _decode = decode ?? _decodePixels;

  final void Function(ui.Image) onImage;
  final RemotePixelDecoder _decode;
  ({Uint8List pixels, int width, int height})? _pending;
  bool _decoding = false;
  int _epoch = 0;
  bool _disposed = false;

  void add(Uint8List pixels, int width, int height) {
    if (_disposed || width <= 0 || height <= 0) return;
    _pending = (
      pixels: Uint8List.fromList(pixels),
      width: width,
      height: height,
    );
    if (!_decoding) unawaited(_drain());
  }

  void clear() {
    _epoch++;
    _pending = null;
  }

  void dispose() {
    clear();
    _disposed = true;
  }

  Future<void> _drain() async {
    _decoding = true;
    try {
      while (_pending != null && !_disposed) {
        final frame = _pending!;
        final epoch = _epoch;
        _pending = null;
        try {
          final image = await _decode(frame.pixels, frame.width, frame.height);
          if (_disposed || epoch != _epoch) {
            image.dispose();
          } else {
            onImage(image);
          }
        } catch (_) {
          // A bad frame must not leave the decoder permanently busy.
        }
      }
    } finally {
      _decoding = false;
    }
  }

  static Future<ui.Image> _decodePixels(Uint8List pixels, int w, int h) {
    final result = Completer<ui.Image>();
    ui.decodeImageFromPixels(
      pixels,
      w,
      h,
      ui.PixelFormat.bgra8888,
      result.complete,
    );
    return result.future;
  }
}
