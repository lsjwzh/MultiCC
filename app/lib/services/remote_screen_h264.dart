import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'remote_screen_source.dart';

// 「🖥 屏幕」高清流畅模式（App 端）：/ws/remote-screen?mode=h264 上的字节流。
//
// 帧格式与 Agent/Web 端完全一致（见 scripts/macos-agent/MultiCCAgentH264.swift）：
//   [type u8][len u32 BE][payload]
//     type 1 config  payload = JSON {"codec":"avc1.PPCCLL","width":W,"height":H}
//     type 2 key     payload = [pts µs u64 BE][Annex B，SPS/PPS 在前]
//     type 3 delta   payload = [pts µs u64 BE][Annex B]
// App → 服务端：'K'（1 字节，要关键帧）、RFB KeyEvent、RFB PointerEvent。
//
// 解码交给平台（iOS VideoToolbox / Android MediaCodec，见 platform_h264_decoder
// .dart 与原生实现）。解出来的 BGRA 帧与 RFB 的 framebuffer 一样是 4 字节/像素，
// 页面沿用同一套 _ScreenPainter，不用区分编码。
//
// WS 上的文本消息是 P2P 信令（rtc-hello 等）。App 不发起 WebRTC，一律忽略；
// 直连与否对 App 没有影响，中继就是这条 WS。

const int h264Config = 1;
const int h264Key = 2;
const int h264Delta = 3;
const int h264ReqKey = 0x4B;

/// 单帧上限与桥一致（remote-screen-h264-bridge.js 的 maxFrameBytes）。
const int _maxFrameBytes = 8 * 1024 * 1024;

class H264Frame {
  H264Frame({
    required this.bytes,
    required this.width,
    required this.height,
    this.key = false,
  });

  /// BGRA，width × height × 4。
  final Uint8List bytes;
  final int width;
  final int height;
  final bool key;
}

/// 平台解码器接口。测试里可以塞一个假的；生产用 PlatformH264Decoder。
abstract class H264Decoder {
  /// 建立解码器。false = 本机平台不支持/初始化失败，调用方应退回 RFB。
  Future<bool> open();

  /// 送一个 access unit（Annex B，含起始码）。异步执行，不阻塞调用方。
  ///
  /// [width]/[height] 来自 config 消息（编码尺寸，与主屏逻辑点一致）；
  /// MediaCodec 第一次创建时要用它。pts 是本机单调递增的微秒时间戳。
  void decode(
    Uint8List annexB, {
    required int timestampUs,
    required bool key,
    required int width,
    required int height,
  });

  /// 解出的帧；顺序与送进去的一致，尺寸可能被平台降采样（≤1280 宽）。
  Stream<H264Frame> get frames;

  /// 解码失败/积压丢帧。订阅方应重新要关键帧。
  Stream<String> get errors;

  Future<void> close();
}

class RemoteScreenH264 with ScreenInputMixin implements ScreenSource {
  RemoteScreenH264({
    required Stream<Uint8List> incoming,
    required void Function(Uint8List bytes) send,
    required H264Decoder decoder,
    void Function()? onClosed,
    void Function()? onFrame,
    Duration firstFrameTimeout = const Duration(seconds: 10),
    Duration stallTimeout = const Duration(seconds: 4),
    Duration recoveryTimeout = const Duration(seconds: 12),
    DateTime Function()? now,
  }) : _incoming = incoming,
       _send = send,
       _decoder = decoder,
       _onClosed = onClosed,
       _onFrame = onFrame,
       _firstFrameTimeout = firstFrameTimeout,
       _stallTimeout = stallTimeout,
       _recoveryTimeout = recoveryTimeout,
       _now = now ?? DateTime.now;

  final Stream<Uint8List> _incoming;
  final void Function(Uint8List bytes) _send;
  final H264Decoder _decoder;
  final void Function()? _onClosed;
  final void Function()? _onFrame;
  final Duration _firstFrameTimeout;
  final Duration _stallTimeout;
  final Duration _recoveryTimeout;
  final DateTime Function() _now;

  final _Buffer _buf = _Buffer();
  StreamSubscription<Uint8List>? _sub;
  StreamSubscription<H264Frame>? _frameSub;
  StreamSubscription<String>? _errSub;
  Timer? _firstTimer;
  Timer? _watchdog;
  DateTime? _lastDecodedAt;

  bool _closed = false;
  bool _gotFrame = false;
  bool _sawKey = false;
  int _encodedWidth = 0;
  int _encodedHeight = 0;
  DateTime _lastKeyRequest = DateTime.fromMillisecondsSinceEpoch(0);

  @override
  int width = 0;
  @override
  int height = 0;
  @override
  Uint8List? framebuffer;

  /// 已解出的帧数（页面显示 fps 时也用它）。
  int frameVersion = 0;

  Future<void> run() async {
    if (_closed) return;
    _frameSub = _decoder.frames.listen(_onDecoded, onError: (Object _) {});
    _errSub = _decoder.errors.listen((_) => requestKeyFrame(force: true));
    _sub = _incoming.listen(
      _onChunk,
      onError: (Object _) => _fail(),
      onDone: _fail,
      cancelOnError: true,
    );
    _firstTimer = Timer(_firstFrameTimeout, () {
      if (!_gotFrame) _fail();
    });
    // Agent 接到新客户端会重放 config 并马上编一个关键帧；这里再要一次，
    // 兼顾「config 之后 Gop 内没有关键帧」的边角情况（节流会合并）。
    requestKeyFrame(force: true);
    _watchdog = Timer.periodic(_stallTimeout, (_) {
      final last = _lastDecodedAt;
      if (last == null || _closed) return;
      final idle = _now().difference(last);
      if (idle >= _recoveryTimeout) {
        _fail();
      } else if (idle >= _stallTimeout) {
        // Capture is change-driven: requesting a key also refreshes a still
        // image, and recovers a decoder that stopped producing output.
        requestKeyFrame();
      }
    });
  }

  @override
  void sendInput(Uint8List bytes) {
    if (!_closed) _send(bytes);
  }

  /// 页面按 [width]×[height]（解码后的帧缓冲）归一化出 x/y，而 Agent 对 H.264
  /// 通道的指针坐标按编码尺寸（= 屏幕逻辑点）理解。原生解码器会把宽度压到 ≤1280
  /// （1470×956 → 1280×832），两域不等时必须放大回去，否则光标总落在点击处的左上方。
  @override
  void pointerEvent(int mask, int x, int y) {
    final ew = _encodedWidth, eh = _encodedHeight;
    if (ew > 0 &&
        eh > 0 &&
        width > 0 &&
        height > 0 &&
        (ew != width || eh != height)) {
      x = (x * ew / width).round().clamp(0, ew - 1);
      y = (y * eh / height).round().clamp(0, eh - 1);
    }
    super.pointerEvent(mask, x, y);
  }

  /// 向 Agent 要一个关键帧（断流恢复、解码器重置后都从这里续上）。
  void requestKeyFrame({bool force = false}) {
    if (_closed) return;
    final now = _now();
    if (!force && now.difference(_lastKeyRequest).inMilliseconds < 500) {
      return;
    }
    _lastKeyRequest = now;
    _send(Uint8List.fromList(const [h264ReqKey]));
  }

  void _onChunk(Uint8List chunk) {
    if (_closed || chunk.isEmpty) return;
    _buf.add(chunk);
    while (!_closed && _buf.length >= 5) {
      final type = _buf.byteAt(0);
      final length = _buf.uint32At(1);
      if (length > _maxFrameBytes) {
        _fail();
        return;
      }
      if (_buf.length < 5 + length) return;
      _buf.take(5);
      final payload = _buf.take(length);
      _handle(type, payload);
    }
  }

  void _handle(int type, Uint8List payload) {
    if (type == h264Config) {
      try {
        final cfg = jsonDecode(utf8.decode(payload));
        if (cfg is Map) {
          _encodedWidth = (cfg['width'] as num?)?.toInt() ?? 0;
          _encodedHeight = (cfg['height'] as num?)?.toInt() ?? 0;
        }
      } catch (_) {
        // 坏 config 只是拿不到编码尺寸，关键帧里还有 SPS/PPS。
      }
      return;
    }
    if (type != h264Key && type != h264Delta) return; // 向前兼容：忽略未知类型
    if (payload.length <= 8) return;
    final key = type == h264Key;
    if (key) {
      _sawKey = true;
    } else if (!_sawKey) {
      // 关键帧之前解码器无从起步；直接丢，等关键帧。
      requestKeyFrame();
      return;
    }
    final pts = ByteData.sublistView(payload, 0, 8).getUint64(0, Endian.big);
    final annexB = Uint8List.sublistView(payload, 8);
    _decoder.decode(
      annexB,
      timestampUs: pts,
      key: key,
      width: _encodedWidth,
      height: _encodedHeight,
    );
  }

  void _onDecoded(H264Frame frame) {
    if (_closed || frame.width <= 0 || frame.height <= 0) return;
    _gotFrame = true;
    _lastDecodedAt = _now();
    _firstTimer?.cancel();
    _firstTimer = null;
    width = frame.width;
    height = frame.height;
    framebuffer = frame.bytes;
    frameVersion += 1;
    _onFrame?.call();
  }

  /// 传输/解码失败：通知服务端切换（服务会先退 RFB，再退 JPEG）。
  void _fail() {
    if (_closed) return;
    _closed = true;
    _watchdog?.cancel();
    _firstTimer?.cancel();
    _firstTimer = null;
    _sub?.cancel();
    _sub = null;
    _frameSub?.cancel();
    _frameSub = null;
    _errSub?.cancel();
    _errSub = null;
    unawaited(_decoder.close());
    _onClosed?.call();
  }

  void dispose() {
    if (_closed) return;
    _closed = true;
    _watchdog?.cancel();
    _firstTimer?.cancel();
    _firstTimer = null;
    _sub?.cancel();
    _sub = null;
    _frameSub?.cancel();
    _frameSub = null;
    _errSub?.cancel();
    _errSub = null;
    unawaited(_decoder.close());
  }
}

/// 切帧缓冲：WS 消息边界与帧边界无关（浏览器端也一样），按 5 字节头切。
///
/// 用「块列表 + 首块偏移」而不是单一可增长数组：一条 WS 消息通常就是一整帧
/// （中继模式），偶尔跨消息；块列表不用为每个小 WS 消息反复搬动大缓冲。
class _Buffer {
  final List<Uint8List> _chunks = <Uint8List>[];
  int _offset = 0; // 首块已消费的字节
  int _bytes = 0;

  int get length => _bytes;

  void add(Uint8List chunk) {
    if (chunk.isEmpty) return;
    _chunks.add(chunk);
    _bytes += chunk.length;
  }

  int byteAt(int i) => _peek(i);

  int uint32At(int i) =>
      (_peek(i) << 24) |
      (_peek(i + 1) << 16) |
      (_peek(i + 2) << 8) |
      _peek(i + 3);

  int _peek(int i) {
    var need = i;
    for (var k = 0; k < _chunks.length; k++) {
      final start = k == 0 ? _offset : 0;
      final available = _chunks[k].length - start;
      if (need < available) return _chunks[k][start + need];
      need -= available;
    }
    throw RangeError('h264-buffer-underrun');
  }

  Uint8List take(int n) {
    final out = Uint8List(n);
    var filled = 0;
    while (filled < n) {
      final chunk = _chunks.first;
      final available = chunk.length - _offset;
      final take = available < n - filled ? available : n - filled;
      out.setRange(filled, filled + take, chunk, _offset);
      filled += take;
      _offset += take;
      _bytes -= take;
      if (_offset == chunk.length) {
        _chunks.removeAt(0);
        _offset = 0;
      }
    }
    return out;
  }
}
