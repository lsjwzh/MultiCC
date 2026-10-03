import 'dart:async';
import 'dart:typed_data';

/// Minimal RFB 3.8 client for the 「🖥 屏幕」 live screen.
///
/// Speaks exactly the subset the MultiCC Agent's rfb.sock serves (see
/// MultiCCAgent.swift, "RFB streaming server"): security type None, a fixed
/// 32bpp BGRA little-endian pixel format, Raw-encoding rectangles and a
/// request-driven update loop — one FramebufferUpdateRequest in, one
/// FramebufferUpdate out. A still screen answers with an empty n=0 update as
/// a keepalive (SCStream only emits on change), so this loop must keep
/// re-arming after empty updates instead of treating them as end-of-stream.
///
/// Transport-agnostic on purpose: the caller passes any byte stream (a
/// WebSocket in production, an in-memory controller in tests). Socket frames
/// do not line up with RFB message boundaries, so reads are reassembled from
/// an accumulating buffer.
class RemoteScreenRfb {
  RemoteScreenRfb({
    required Stream<Uint8List> incoming,
    required void Function(Uint8List bytes) send,
    void Function()? onClosed,
    void Function()? onFrame,
  }) : _send = send,
       _onClosed = onClosed,
       _onFrame = onFrame {
    _sub = incoming.listen(
      _reader.add,
      onError: (Object _) => _reader.close(),
      onDone: _reader.close,
      cancelOnError: true,
    );
  }

  final void Function(Uint8List bytes) _send;
  final void Function()? _onClosed;
  final void Function()? _onFrame;
  final _ChunkedReader _reader = _ChunkedReader();
  StreamSubscription<Uint8List>? _sub;
  bool _closed = false;

  /// Framebuffer geometry, valid after [run] completes its handshake.
  int width = 0;
  int height = 0;

  /// BGRA bytes, width × height × 4, mutated in place by every update.
  Uint8List? framebuffer;

  /// Monotonic counter bumped once per applied update — lets a painter skip
  /// repaints when no update arrived.
  int frameVersion = 0;

  /// Handshake, then the update loop. Completes with an error when the
  /// transport closes or the server violates the expected protocol.
  Future<void> run() async {
    try {
      await _handshake();
      _onFrame?.call();
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

  /// Mask bits follow RFB: left 1, middle 2, right 4, wheel-up 8, wheel-down
  /// 16. The Agent turns transitions into click/drag/scroll ops itself.
  void pointerEvent(int mask, int x, int y) {
    final m = Uint8List(6);
    m[0] = 5;
    m[1] = mask & 0xFF;
    _be16(m, 2, x.clamp(0, 0xFFFF));
    _be16(m, 4, y.clamp(0, 0xFFFF));
    _send(m);
  }

  /// Modifier keysyms are tracked Agent-side; printable keysyms become
  /// unicode type events, anything with ctrl/cmd/alt becomes a chord.
  void keyEvent(bool down, int keysym) {
    final m = Uint8List(8);
    m[0] = 4;
    m[1] = down ? 1 : 0;
    _be32(m, 4, keysym);
    _send(m);
  }

  /// Types text key-by-key (down+up per code point). CJK code points work:
  /// the Agent posts them as unicode events, not through an IME.
  void typeText(String text) {
    for (final codePoint in text.runes) {
      keyEvent(true, codePoint);
      keyEvent(false, codePoint);
    }
  }

  /// Sends a key chord like cmd+c as press/release pairs in order.
  void chord(List<int> modifierKeysyms, int keysym) {
    for (final mod in modifierKeysyms) {
      keyEvent(true, mod);
    }
    keyEvent(true, keysym);
    keyEvent(false, keysym);
    for (final mod in modifierKeysyms.reversed) {
      keyEvent(false, mod);
    }
  }

  void _dispose() {
    if (_closed) return;
    _closed = true;
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

void _be32(Uint8List m, int at, int v) {
  m[at] = (v >> 24) & 0xFF;
  m[at + 1] = (v >> 16) & 0xFF;
  m[at + 2] = (v >> 8) & 0xFF;
  m[at + 3] = v & 0xFF;
}

int _u16(Uint8List b, int at) => (b[at] << 8) | b[at + 1];

int _u32(Uint8List b, int at) =>
    (b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3];
