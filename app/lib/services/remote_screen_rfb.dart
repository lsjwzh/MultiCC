import 'dart:async';
import 'dart:io' show RawZLibFilter;
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'remote_screen_source.dart';

/// JPEG bytes → straight RGBA pixels (null = undecodable).
typedef RfbJpegDecoder = Future<Uint8List?> Function(Uint8List jpeg);

/// Minimal RFB 3.8 client for the 「🖥 屏幕」 live screen.
///
/// Speaks exactly the subset the MultiCC Agent's rfb.sock serves (see
/// MultiCCAgent.swift, "RFB streaming server"): security type None, a fixed
/// 32bpp BGRA little-endian pixel format, Raw or Tight rectangles and a
/// request-driven update loop — one FramebufferUpdateRequest in, one
/// FramebufferUpdate out. A still screen answers with an empty n=0 update as
/// a keepalive (SCStream only emits on change), so this loop must keep
/// re-arming after empty updates instead of treating them as end-of-stream.
/// Because of that keepalive, silence is a verdict: no byte at all for
/// [stallTimeout] means the transport is dead (a half-open socket after the
/// phone slept or switched networks never reports onDone), and the session
/// closes so the caller reconnects. A slow link is not silence — a big update
/// crawling through a weak tunnel still delivers bytes and is left alone.
///
/// Tight is what makes it usable over a weak tunnel: Raw is 1.4MB per
/// full-screen change at 735×478 (5–8 s through a ~250KB/s frp tunnel), the
/// same screen as Tight JPEG is ~40KB and the Agent's lossless re-send of a
/// settled screen ~80KB. Only Tight + a JPEG quality level are announced —
/// no DesktopSize, so the Agent keeps this client at logical/RFB_DIV and the
/// pointer mapping is unchanged; no Cursor pseudo-encoding, so the pointer
/// stays baked into the frames. The Agent's Tight subset is fill, JPEG and
/// basic zlib (stream 0, copy filter) — see its encodeTight(). An Agent that
/// ignores SetEncodings keeps sending Raw, which is still understood.
///
/// Transport-agnostic on purpose: the caller passes any byte stream (a
/// WebSocket in production, an in-memory controller in tests). Socket frames
/// do not line up with RFB message boundaries, so reads are reassembled from
/// an accumulating buffer.
class RemoteScreenRfb with ScreenInputMixin implements ScreenSource {
  RemoteScreenRfb({
    required Stream<Uint8List> incoming,
    required void Function(Uint8List bytes) send,
    void Function()? onClosed,
    void Function()? onFrame,
    Duration stallTimeout = const Duration(seconds: 12),
    int? jpegQuality = 6,
    RfbJpegDecoder? jpegDecoder,
  }) : _send = send,
       _onClosed = onClosed,
       _onFrame = onFrame,
       _stallTimeout = stallTimeout,
       _jpegQuality = jpegQuality,
       _decodeJpeg = jpegDecoder ?? decodeJpegRgba {
    _sub = incoming.listen(
      (bytes) {
        _lastBytesAt = DateTime.now();
        _reader.add(bytes);
      },
      onError: (Object _) => _reader.close(),
      onDone: _reader.close,
      cancelOnError: true,
    );
  }

  final void Function(Uint8List bytes) _send;
  final void Function()? _onClosed;
  final void Function()? _onFrame;
  final Duration _stallTimeout;

  /// Tight JPEG level 0…9 (noVNC's default 6); null = Raw only.
  final int? _jpegQuality;
  final RfbJpegDecoder _decodeJpeg;

  /// Tight's four zlib streams; each lives as long as the connection.
  final List<RawZLibFilter?> _inflaters = List.filled(4, null);
  final _ChunkedReader _reader = _ChunkedReader();
  StreamSubscription<Uint8List>? _sub;
  Timer? _watchdog;
  DateTime _lastBytesAt = DateTime.now();
  bool _closed = false;

  /// Framebuffer geometry, valid after [run] completes its handshake.
  @override
  int width = 0;
  @override
  int height = 0;

  /// BGRA bytes, width × height × 4, mutated in place by every update.
  @override
  Uint8List? framebuffer;

  /// Monotonic counter bumped once per applied update — lets a painter skip
  /// repaints when no update arrived.
  int frameVersion = 0;

  /// Handshake, then the update loop. Completes with an error when the
  /// transport closes or the server violates the expected protocol.
  Future<void> run() async {
    _lastBytesAt = DateTime.now();
    _watchdog = Timer.periodic(_stallTimeout ~/ 4, (_) {
      if (DateTime.now().difference(_lastBytesAt) >= _stallTimeout) {
        _reader.close(); // pending read throws → run() ends → onClosed
      }
    });
    try {
      await _handshake();
      _onFrame?.call();
      final quality = _jpegQuality;
      if (quality != null) _setEncodings([7, -32 + quality.clamp(0, 9)]);
      requestUpdate(incremental: false);
      while (true) {
        final type = (await _reader.read(1))[0];
        if (type != 0) {
          throw StateError('unexpected rfb server message $type');
        }
        await _reader.read(1); // padding
        final rectCount = _u16(await _reader.read(2), 0);
        final fb = framebuffer;
        if (fb != null) {
          for (var i = 0; i < rectCount; i++) {
            final head = await _reader.read(8);
            final x = _u16(head, 0);
            final y = _u16(head, 2);
            final w = _u16(head, 4);
            final h = _u16(head, 6);
            final encoding = _u32(await _reader.read(4), 0);
            if (encoding == 7) {
              await _tightRect(fb, x, y, w, h);
              continue;
            }
            if (encoding != 0) {
              throw StateError('unsupported rfb encoding $encoding');
            }
            if (w == 0 || h == 0) continue;
            final pixels = await _reader.read(w * h * 4);
            final copyW =
                x >= width ? 0 : (x + w > width ? width - x : w); // clamp
            final rows = y >= height ? 0 : (y + h > height ? height - y : h);
            for (var row = 0; row < rows; row++) {
              final dst = ((y + row) * width + x) * 4;
              fb.setRange(dst, dst + copyW * 4, pixels, row * w * 4);
            }
          }
          frameVersion++;
          _onFrame?.call();
        } else {
          // Geometry not established (handshake skipped); drain and ignore.
          for (var i = 0; i < rectCount; i++) {
            final head = await _reader.read(8);
            final w = _u16(head, 4);
            final h = _u16(head, 6);
            await _reader.read(4 + w * h * 4);
          }
        }
        requestUpdate(incremental: true);
      }
    } finally {
      _dispose();
    }
  }

  Future<void> _handshake() async {
    final version = await _reader.read(12);
    if (version.length < 4 ||
        String.fromCharCodes(version, 0, 4) != 'RFB ') {
      throw StateError('not an rfb server');
    }
    _send(_ascii('RFB 003.008\n'));
    final typeCount = (await _reader.read(1))[0];
    if (typeCount == 0) {
      // RFB 3.8: zero types are followed by a reason string.
      final reasonLen = _u32(await _reader.read(4), 0);
      if (reasonLen > 0 && reasonLen < 4096) await _reader.read(reasonLen);
      throw StateError('rfb server requires authentication');
    }
    var supportsNone = false;
    for (var i = 0; i < typeCount; i++) {
      if ((await _reader.read(1))[0] == 1) supportsNone = true;
    }
    if (!supportsNone) throw StateError('no None security type offered');
    _send(Uint8List.fromList([1]));
    if (_u32(await _reader.read(4), 0) != 0) {
      throw StateError('rfb security handshake failed');
    }
    _send(Uint8List.fromList([0])); // ClientInit: non-shared
    final head = await _reader.read(20);
    width = _u16(head, 0);
    height = _u16(head, 2);
    if (width <= 0 || height <= 0 || width * height > 4096 * 4096) {
      throw StateError('unsupported framebuffer size');
    }
    framebuffer = Uint8List(width * height * 4);
    final nameLen = _u32(await _reader.read(4), 0);
    if (nameLen > 0 && nameLen < 65536) await _reader.read(nameLen);
  }

  /// One Tight rectangle: fill, JPEG, or basic zlib/uncompressed RGB.
  Future<void> _tightRect(Uint8List fb, int x, int y, int w, int h) async {
    final control = (await _reader.read(1))[0];
    for (var i = 0; i < 4; i++) {
      if (control & (1 << i) != 0) _inflaters[i] = null; // stream reset
    }
    final kind = control >> 4;
    if (kind == 0x8) {
      final c = await _reader.read(3); // TPIXEL: R, G, B
      _put(fb, x, y, w, h, c, 0);
      return;
    }
    if (kind == 0x9) {
      final jpeg = await _reader.read(await _compactLength());
      final rgba = await _decodeJpeg(jpeg);
      if (rgba == null || rgba.length != w * h * 4) {
        throw StateError('rfb tight jpeg undecodable');
      }
      _put(fb, x, y, w, h, rgba, 4);
      return;
    }
    if (kind & 0x8 != 0 || kind & 0x4 != 0) {
      // PNG (TightPNG) / palette / gradient: the Agent never sends these.
      throw StateError('unsupported tight compression $control');
    }
    final length = w * h * 3;
    Uint8List rgb;
    if (length < 12) {
      rgb = await _reader.read(length);
    } else {
      final z = await _reader.read(await _compactLength());
      final inflater = _inflaters[kind & 0x3] ??= RawZLibFilter.inflateFilter();
      inflater.process(z, 0, z.length);
      final out = BytesBuilder(copy: false);
      List<int>? chunk;
      while ((chunk = inflater.processed(flush: true)) != null) {
        out.add(chunk!);
      }
      rgb = out.takeBytes();
      if (rgb.length != length) {
        throw StateError('rfb tight zlib size ${rgb.length} != $length');
      }
    }
    _put(fb, x, y, w, h, rgb, 3);
  }

  /// Writes R,G,B[,A] pixels ([stride] bytes each) as an opaque w×h rect
  /// into the BGRA framebuffer, clamped to it. Stride 0 repeats the first
  /// pixel — a Tight fill.
  void _put(
    Uint8List fb,
    int x,
    int y,
    int w,
    int h,
    Uint8List src,
    int stride,
  ) {
    final copyW = x >= width ? 0 : (x + w > width ? width - x : w);
    final rows = y >= height ? 0 : (y + h > height ? height - y : h);
    for (var row = 0; row < rows; row++) {
      var d = ((y + row) * width + x) * 4;
      var s = row * w * stride;
      for (var col = 0; col < copyW; col++, d += 4, s += stride) {
        fb[d] = src[s + 2];
        fb[d + 1] = src[s + 1];
        fb[d + 2] = src[s];
        fb[d + 3] = 0xFF;
      }
    }
  }

  /// Tight "compact length": 7 bits per byte, at most 3 bytes.
  Future<int> _compactLength() async {
    var b = (await _reader.read(1))[0];
    var n = b & 0x7F;
    if (b & 0x80 != 0) {
      b = (await _reader.read(1))[0];
      n |= (b & 0x7F) << 7;
      if (b & 0x80 != 0) n |= (await _reader.read(1))[0] << 14;
    }
    return n;
  }

  void _setEncodings(List<int> encodings) {
    final m = Uint8List(4 + 4 * encodings.length);
    m[0] = 2;
    _be16(m, 2, encodings.length);
    final view = ByteData.sublistView(m);
    for (var i = 0; i < encodings.length; i++) {
      view.setInt32(4 + 4 * i, encodings[i]);
    }
    _send(m);
  }

  /// Full-screen update request; incremental after the first, which is also
  /// the loop's backpressure: the next request goes out only after the
  /// previous update (empty keepalives included) has been applied.
  void requestUpdate({required bool incremental}) {
    final m = Uint8List(10);
    m[0] = 3;
    m[1] = incremental ? 1 : 0;
    _be16(m, 6, width);
    _be16(m, 8, height);
    _send(m);
  }

  /// RFB 客户端消息的出口（键鼠编码由 [ScreenInputMixin] 统一提供）。
  @override
  void sendInput(Uint8List bytes) => _send(bytes);

  void _dispose() {
    if (_closed) return;
    _closed = true;
    _watchdog?.cancel();
    _inflaters.fillRange(0, 4, null);
    _sub?.cancel();
    _reader.close();
    _onClosed?.call();
  }
}

/// X11 keysyms the App keyboard bar and chords need.
abstract final class RfbKeysyms {
  static const backspace = 0xFF08;
  static const tab = 0xFF09;
  static const linefeed = 0xFF0A;
  static const enter = 0xFF0D;
  static const escape = 0xFF1B;
  static const left = 0xFF51;
  static const up = 0xFF52;
  static const right = 0xFF53;
  static const down = 0xFF54;
  static const delete = 0xFFFF;
  static const shiftL = 0xFFE1;
  static const ctrlL = 0xFFE3;
  static const altL = 0xFFE9;
  static const cmdL = 0xFFE7;
}

/// Reassembles arbitrary socket chunks into exact-length reads.
class _ChunkedReader {
  final List<Uint8List> _chunks = [];
  final List<Completer<Uint8List>> _waiters = [];
  final List<int> _amounts = [];
  int _bytes = 0;
  int _headOffset = 0;
  bool _closed = false;

  void add(Uint8List chunk) {
    _chunks.add(chunk);
    _bytes += chunk.length;
    _pump();
  }

  void close() {
    if (_closed) return;
    _closed = true;
    while (_waiters.isNotEmpty) {
      _waiters.removeAt(0).completeError(
        StateError('rfb-connection-closed'),
      );
    }
  }

  Future<Uint8List> read(int n) {
    if (n == 0) return Future.value(Uint8List(0));
    if (_bytes >= n) return Future.value(_take(n));
    if (_closed) {
      return Future.error(StateError('rfb-connection-closed'));
    }
    final completer = Completer<Uint8List>();
    _waiters.add(completer);
    _amounts.add(n);
    return completer.future;
  }

  void _pump() {
    while (_waiters.isNotEmpty && _bytes >= _amounts.first) {
      _waiters.removeAt(0).complete(_take(_amounts.removeAt(0)));
    }
    if (_closed && _waiters.isNotEmpty) {
      close();
    }
  }

  Uint8List _take(int n) {
    final out = Uint8List(n);
    var filled = 0;
    while (filled < n) {
      final head = _chunks.first;
      final available = head.length - _headOffset;
      final take = available < n - filled ? available : n - filled;
      out.setRange(filled, filled + take, head, _headOffset);
      filled += take;
      _headOffset += take;
      _bytes -= take;
      if (_headOffset == head.length) {
        _chunks.removeAt(0);
        _headOffset = 0;
      }
    }
    return out;
  }
}

Uint8List _ascii(String s) => Uint8List.fromList(s.codeUnits);

void _be16(Uint8List m, int at, int v) {
  m[at] = (v >> 8) & 0xFF;
  m[at + 1] = v & 0xFF;
}

int _u16(Uint8List b, int at) => (b[at] << 8) | b[at + 1];

int _u32(Uint8List b, int at) =>
    (b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3];

/// Default [RfbJpegDecoder]: the engine's native JPEG codec, read back as
/// straight RGBA.
Future<Uint8List?> decodeJpegRgba(Uint8List jpeg) async {
  final buffer = await ui.ImmutableBuffer.fromUint8List(jpeg);
  ui.ImageDescriptor? descriptor;
  ui.Codec? codec;
  ui.Image? image;
  try {
    descriptor = await ui.ImageDescriptor.encoded(buffer);
    codec = await descriptor.instantiateCodec();
    image = (await codec.getNextFrame()).image;
    final data = await image.toByteData(format: ui.ImageByteFormat.rawRgba);
    return data?.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes);
  } catch (_) {
    return null;
  } finally {
    image?.dispose();
    codec?.dispose();
    descriptor?.dispose();
    buffer.dispose();
  }
}
