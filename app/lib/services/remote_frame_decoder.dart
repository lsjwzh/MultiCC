import 'dart:async';
import 'dart:typed_data';
import 'dart:ui' as ui;

typedef RemotePixelDecoder =
    Future<ui.Image> Function(Uint8List pixels, int width, int height);

/// At most one decode in flight and one latest snapshot waiting behind it.
/// A final update arriving during decode must paint even if capture then idles.
class RemoteFrameDecoder {
  RemoteFrameDecoder({
    required this.onImage,
    RemotePixelDecoder? decode,
    this.decodeTimeout = const Duration(seconds: 2),
  }) : _decode = decode ?? _decodePixels;

  final void Function(ui.Image) onImage;
  final RemotePixelDecoder _decode;

  /// A decode that never answers must not freeze the picture: input keeps
  /// working while the last image stays up, which reads as "taps do nothing".
  final Duration decodeTimeout;
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
        final pending = _decode(frame.pixels, frame.width, frame.height);
        try {
          final image = await pending.timeout(decodeTimeout);
          if (_disposed || epoch != _epoch) {
            image.dispose();
          } else {
            onImage(image);
          }
        } on TimeoutException {
          unawaited(
            pending.then((late) => late.dispose(), onError: (Object _) {}),
          );
        } catch (_) {
          // A bad frame must not leave the decoder permanently busy.
        }
      }
    } finally {
      _decoding = false;
    }
  }

  // decodeImageFromPixels drops engine errors and never calls back; this is
  // the same pipeline with failures surfaced to _drain.
  static Future<ui.Image> _decodePixels(Uint8List pixels, int w, int h) async {
    final buffer = await ui.ImmutableBuffer.fromUint8List(pixels);
    final descriptor = ui.ImageDescriptor.raw(
      buffer,
      width: w,
      height: h,
      pixelFormat: ui.PixelFormat.bgra8888,
    );
    try {
      final codec = await descriptor.instantiateCodec();
      try {
        return (await codec.getNextFrame()).image;
      } finally {
        codec.dispose();
      }
    } finally {
      descriptor.dispose();
      buffer.dispose();
    }
  }
}
