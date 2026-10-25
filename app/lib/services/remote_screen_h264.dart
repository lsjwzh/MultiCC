import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';

import 'remote_rate_controller.dart';
import 'remote_screen_source.dart';

// 「🖥 屏幕」高清流畅模式（App 端）：/ws/remote-screen?mode=h264 上的字节流。
//
// 帧格式与 Agent/Web 端完全一致（见 scripts/macos-agent/MultiCCAgentH264.swift）：
//   [type u8][len u32 BE][payload]
//     type 1 config  payload = JSON {"codec":"avc1.PPCCLL","width":W,"height":H,
//                                    "inputWidth":IW,"inputHeight":IH}
//     type 2 key     payload = [pts µs u64 BE][Annex B，SPS/PPS 在前]
//     type 3 delta   payload = [pts µs u64 BE][Annex B]
//     type 4 pong    payload = [token u32 BE][applied kbps u32 BE]
// App → 服务端：'K'（1 字节，要关键帧）、'B' + kbps u32（本客户端码率上限，
// 0 = 撤销）、'P' + token u32（ping）、RFB KeyEvent、RFB PointerEvent。
//
// 码率自适应：隧道容量只有几十 KB/s，而 Agent 默认按屏幕像素给码率（约 4.2 Mbps），
// 数据在各级缓冲排队越积越卡。RemoteRateController 用「到达时刻 − pts」的排队增量
// 和 ping/pong 的 RTT 判断过载，每秒算一次目标码率并用 'B' 发给 Agent；Agent 在所有
// 客户端之间取最小值。降码率同时可能降编码分辨率，所以指针坐标域改用 config 的
// inputWidth/inputHeight（主屏逻辑点），缺省回落到编码尺寸。
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
const int h264Pong = 4;
const int h264ReqKey = 0x4B;
const int h264Cap = 0x42;
const int h264Ping = 0x50;

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
    Duration pingInterval = const Duration(seconds: 1),
    Duration rateInterval = const Duration(seconds: 1),
    RemoteRateController? rateController,
    DateTime Function()? now,
  }) : _incoming = incoming,
       _send = send,
       _decoder = decoder,
       _onClosed = onClosed,
       _onFrame = onFrame,
       _firstFrameTimeout = firstFrameTimeout,
       _stallTimeout = stallTimeout,
       _recoveryTimeout = recoveryTimeout,
       _pingInterval = pingInterval,
       _rateInterval = rateInterval,
       _now = now ?? DateTime.now {
    _rate = rateController ?? RemoteRateController(clock: _clockMs);
    _ownsRate = rateController == null;
  }

  final Stream<Uint8List> _incoming;
  final void Function(Uint8List bytes) _send;
  final H264Decoder _decoder;
  final void Function()? _onClosed;
  final void Function()? _onFrame;
  final Duration _firstFrameTimeout;
  final Duration _stallTimeout;
  final Duration _recoveryTimeout;
  final Duration _pingInterval;
  final Duration _rateInterval;
  final DateTime Function() _now;
  late final RemoteRateController _rate;
  late final bool _ownsRate;

  int _clockMs() => _now().millisecondsSinceEpoch;

  /// 当前会话的码率/延迟统计（页面状态栏用）。
  ValueListenable<RemoteRateStats> get rateStats => _rate.stats;

  final _Buffer _buf = _Buffer();
  StreamSubscription<Uint8List>? _sub;
  StreamSubscription<H264Frame>? _frameSub;
  StreamSubscription<String>? _errSub;
  Timer? _firstTimer;
  Timer? _watchdog;
  Timer? _pingTimer;
  Timer? _rateTimer;
  int _pingToken = 0;
  final Map<int, int> _pings = <int, int>{}; // token → 发出时刻 ms
  DateTime? _lastDecodedAt;

  bool _closed = false;
  bool _gotFrame = false;
  bool _sawKey = false;
  int _encodedWidth = 0;
  int _encodedHeight = 0;
  int _inputWidth = 0; // 指针坐标域（主屏逻辑点），来自 config.inputWidth
  int _inputHeight = 0;
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
    // 走节流：一串坏帧会连着报错，每次都强要关键帧的话，服务端每收到一个 'K'
    // 就丢掉其后所有帧直到关键帧，弱链路被一个接一个的大关键帧堵死。
    _errSub = _decoder.errors.listen((_) => requestKeyFrame());
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
    // 心跳：每秒一个 'P'，Agent 立刻回 pong，用它量 RTT 并读回实际生效码率。
    _pingTimer = Timer.periodic(_pingInterval, (_) => _sendPing());
    // 码率控制：每秒评估一次，需要变才发 'B'（另有 10 秒重发兜底）。
    _rateTimer = Timer.periodic(_rateInterval, (_) {
      if (_closed) return;
      final kbps = _rate.tick(_clockMs());
      if (kbps != null) _sendCap(kbps);
    });
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

  /// 页面按 [width]×[height]（解码后的帧缓冲）归一化出 x/y；Agent 对 H.264
  /// 通道的指针坐标按主屏逻辑点理解（config.inputWidth/inputHeight）。原生解码器
  /// 会把宽度压到 ≤1280，码率自适应还会让 Agent 主动降编码分辨率，两域都不等。
  /// 旧 Agent 不发 input*，回落到编码尺寸（以前的行为）。
  @override
  void pointerEvent(int mask, int x, int y) {
    final tw = _inputWidth > 0 ? _inputWidth : _encodedWidth;
    final th = _inputHeight > 0 ? _inputHeight : _encodedHeight;
    if (tw > 0 &&
        th > 0 &&
        width > 0 &&
        height > 0 &&
        (tw != width || th != height)) {
      x = (x * tw / width).round().clamp(0, tw - 1);
      y = (y * th / height).round().clamp(0, th - 1);
    }
    super.pointerEvent(mask, x, y);
  }

  /// 'P' + token：Agent 立刻回 pong（type 4，回带同一 token 与实际生效码率）。
  void _sendPing() {
    if (_closed) return;
    final token = _pingToken;
    _pingToken = (_pingToken + 1) & 0xFFFFFFFF;
    _pings[token] = _clockMs();
    // 只留最近几个令牌：pong 丢了也不会让表无限长。
    if (_pings.length > 8) _pings.remove(_pings.keys.first);
    final m = Uint8List(5);
    m[0] = h264Ping;
    _be32(m, 1, token);
    _send(m);
  }

  /// 'B' + kbps：本客户端的码率上限（0 = 撤销）。Agent 在共享编码器上取最小值。
  void _sendCap(int kbps) {
    if (_closed) return;
    final m = Uint8List(5);
    m[0] = h264Cap;
    _be32(m, 1, kbps < 0 ? 0 : kbps);
    _send(m);
  }

  /// 主动发一次当前目标码率（测试与「Agent 重启后恢复」用）。
  void sendRateCap([int? kbps]) => _sendCap(kbps ?? _rate.targetKbps);

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
          // 旧 Agent 不发 input*：它们就是编码尺寸（以前的行为）。
          _inputWidth = (cfg['inputWidth'] as num?)?.toInt() ?? 0;
          _inputHeight = (cfg['inputHeight'] as num?)?.toInt() ?? 0;
          _rate.onConfig(_encodedWidth, _encodedHeight);
        }
      } catch (_) {
        // 坏 config 只是拿不到编码尺寸，关键帧里还有 SPS/PPS。
      }
      return;
    }
    if (type == h264Pong) {
      if (payload.length < 8) return;
      final token = ByteData.sublistView(payload, 0, 4).getUint32(0, Endian.big);
      final applied = ByteData.sublistView(
        payload,
        4,
        8,
      ).getUint32(0, Endian.big);
      final sentAt = _pings.remove(token);
      if (sentAt != null) {
        final rtt = _clockMs() - sentAt;
        _rate.onPong(rtt < 0 ? 0 : rtt, applied);
      } else {
        _rate.onPong(0, applied); // 对不上令牌：只更新实际码率
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
    // 编码字节数与本帧到达时刻：排队延迟和实收速率的原始输入。
    _rate.onFrame(_clockMs(), pts, payload.length);
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
    _stopTimers();
    _sub?.cancel();
    _sub = null;
    _frameSub?.cancel();
    _frameSub = null;
    _errSub?.cancel();
    _errSub = null;
    if (_ownsRate) _rate.dispose();
    unawaited(_decoder.close());
    _onClosed?.call();
  }

  void dispose() {
    if (_closed) return;
    _closed = true;
    _stopTimers();
    _sub?.cancel();
    _sub = null;
    _frameSub?.cancel();
    _frameSub = null;
    _errSub?.cancel();
    _errSub = null;
    if (_ownsRate) _rate.dispose();
    unawaited(_decoder.close());
  }

  void _stopTimers() {
    _watchdog?.cancel();
    _watchdog = null;
    _firstTimer?.cancel();
    _firstTimer = null;
    _pingTimer?.cancel();
    _pingTimer = null;
    _rateTimer?.cancel();
    _rateTimer = null;
  }
}

void _be32(Uint8List m, int at, int v) {
  m[at] = (v >> 24) & 0xFF;
  m[at + 1] = (v >> 16) & 0xFF;
  m[at + 2] = (v >> 8) & 0xFF;
  m[at + 3] = v & 0xFF;
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
