import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

/// WebRTC 对端的最小接口：只够「🖥 屏幕」用。
///
/// 信令状态机和帧复用器（[RemoteScreenP2pMux]）只依赖这个接口，单测塞假对端；
/// 真实现是 `remote_screen_p2p_webrtc.dart` 里的 flutter_webrtc 版本。
/// DataChannel 由客户端创建（标签 `screen`、有序），所以 [createOffer] 之前
/// 对端已经建好 DataChannel 才能把 SCTP 谈进 offer。
abstract class RtcPeer {
  /// DataChannel 打开。
  Stream<void> get opened;

  /// DataChannel 关闭 / 连接失败（只会报一次）。
  Stream<void> get closed;

  /// DataChannel 上收到的原始分片（字节流，不保证帧边界）。
  Stream<Uint8List> get incoming;

  /// 本地收集到的 ICE candidate，字段与信令一致：
  /// `{candidate, sdpMid, sdpMLineIndex}`。
  Stream<Map<String, dynamic>> get candidates;

  bool get isOpen;

  /// 生成并设置本地 offer，返回 SDP。
  Future<String> createOffer();

  Future<void> acceptAnswer(String sdp);

  Future<void> addCandidate({
    required String candidate,
    String? sdpMid,
    int? sdpMLineIndex,
  });

  void send(Uint8List bytes);

  Future<void> close();
}

typedef RtcPeerFactory =
    Future<RtcPeer> Function(List<Map<String, dynamic>> iceServers);

/// 一帧的上限，与 Agent / 服务端桥一致（`remote-screen-h264-bridge.js`）。
const int _maxFrameBytes = 8 * 1024 * 1024;

/// rtc-active 之前先攒着的 DataChannel 帧总量上限。切换时服务端会补关键帧，
/// 攒太多没有意义，真超了就直接丢掉等新关键帧。
const int _maxEarlyBytes = 8 * 1024 * 1024;

/// 「🖥 屏幕」直连复用器：一条 WS（中继 + 信令）加一条 DataChannel（直连）。
///
/// 帧只认一个来源，规则与网页端 `public/chat-remote-screen-h264.js` 对齐：
///
///   · 收到 `rtc-active{on:true}` 之前，[frames] 只吐 WS 二进制；
///     这段时间到达的 DataChannel 字节按 5 字节头拼成整帧后先攒着；
///   · `rtc-active{on:true}` 之后丢弃 WS 上的残余帧（切换前已在路上的），
///     吐 DataChannel 的整帧；
///   · `rtc-active{on:false}`、DataChannel 关闭、打开/ICE 超时 → 丢掉残余半帧，
///     改回吐 WS（服务端切换时会补关键帧）。
///
/// 输入（[send]）在直连期间走 DataChannel，否则走 WS。直连失败静默留在 WS，
/// 每条活流连接最多自动重试一次（[retryDelay] 之后）。
class RemoteScreenP2pMux {
  RemoteScreenP2pMux({
    required RtcPeerFactory peerFactory,
    required void Function(Uint8List bytes) sendWs,
    required void Function(Map<String, dynamic> signal) sendSignal,
    required void Function(bool direct) onDirectChanged,
    this.openTimeout = const Duration(seconds: 10),
    this.retryDelay = const Duration(seconds: 30),
    this.maxRetries = 1,
  }) : _peerFactory = peerFactory,
       _sendWs = sendWs,
       _sendSignal = sendSignal,
       _onDirectChanged = onDirectChanged;

  final RtcPeerFactory _peerFactory;
  final void Function(Uint8List bytes) _sendWs;
  final void Function(Map<String, dynamic> signal) _sendSignal;
  final void Function(bool direct) _onDirectChanged;

  /// ICE / DataChannel 打开的上限（验收要求约 10 秒）。
  final Duration openTimeout;

  final Duration retryDelay;
  final int maxRetries;

  final StreamController<Uint8List> _frames = StreamController<Uint8List>();

  /// 交给 RemoteScreenH264 的**完整帧**（5 字节头 + payload）。
  Stream<Uint8List> get frames => _frames.stream;

  bool _disposed = false;
  bool _direct = false;
  bool _helloSeen = false;
  bool _starting = false;
  int _retries = 0;
  List<Map<String, dynamic>> _iceServers = const [];
  RtcPeer? _peer;
  Timer? _openTimer;
  Timer? _retryTimer;
  final List<StreamSubscription<dynamic>> _peerSubs = [];
  final _accumulator = _FrameAccumulator();
  final List<Uint8List> _earlyFrames = [];
  int _earlyBytes = 0;

  /// 画面当前是否走 DataChannel（服务端 rtc-active 说了算）。
  bool get direct => _direct;

  /// WS 上的文本消息（P2P 信令）。
  void onWsText(String text) {
    if (_disposed) return;
    dynamic decoded;
    try {
      decoded = jsonDecode(text);
    } catch (_) {
      return;
    }
    if (decoded is! Map) return;
    final msg = decoded.cast<String, dynamic>();
    final type = msg['t'];
    if (type == 'rtc-hello') {
      final raw = msg['iceServers'];
      _iceServers = raw is List
          ? [
              for (final entry in raw)
                if (entry is Map) entry.cast<String, dynamic>(),
            ]
          : const [];
      _helloSeen = true;
      unawaited(_startAttempt());
      return;
    }
    if (type == 'rtc-answer') {
      final peer = _peer;
      final sdp = msg['sdp'];
      if (peer != null && sdp is String && sdp.isNotEmpty) {
        unawaited(
          peer.acceptAnswer(sdp).catchError((Object _) => _failAttempt()),
        );
      }
      return;
    }
    if (type == 'rtc-ice') {
      final peer = _peer;
      final candidate = msg['candidate'];
      if (peer != null && candidate is Map) {
        final value = candidate['candidate'];
        if (value is String && value.isNotEmpty) {
          final mid = candidate['sdpMid'];
          final index = candidate['sdpMLineIndex'];
          unawaited(
            peer
                .addCandidate(
                  candidate: value,
                  sdpMid: mid is String ? mid : null,
                  sdpMLineIndex: index is int ? index : null,
                )
                .catchError((Object _) {}),
          );
        }
      }
      return;
    }
    if (type == 'rtc-active') {
      if (msg['on'] == true) {
        _flushEarlyFrames();
        _setDirect(true);
      } else {
        _leaveDirect();
      }
    }
  }

  /// WS 上的二进制帧（中继）。
  void onWsBinary(Uint8List bytes) {
    if (_disposed || bytes.isEmpty) return;
    // 直连期间 WS 上的残余帧一律丢掉：解码顺序只认一个来源。
    if (_direct) return;
    _emit(bytes);
  }

  /// 输入：直连期间走 DataChannel，否则走 WS。
  void send(Uint8List bytes) {
    if (_disposed || bytes.isEmpty) return;
    final peer = _peer;
    if (_direct && peer != null && peer.isOpen) {
      try {
        peer.send(bytes);
        return;
      } catch (_) {
        // DataChannel 刚好关了：这一笔回中继，别丢输入。
      }
    }
    _sendWs(bytes);
  }

  Future<void> dispose() async {
    if (_disposed) return;
    _disposed = true;
    _openTimer?.cancel();
    _openTimer = null;
    _retryTimer?.cancel();
    _retryTimer = null;
    await _detachPeer();
    _accumulator.clear();
    _earlyFrames.clear();
    _earlyBytes = 0;
    if (!_frames.isClosed) await _frames.close();
  }

  Future<void> _startAttempt() async {
    if (_disposed || _starting || _peer != null || !_helloSeen) return;
    _starting = true;
    try {
      final created = await _peerFactory(_iceServers);
      if (_disposed || _peer != null) {
        await created.close();
        return;
      }
      _peer = created;
      _peerSubs.add(
        created.opened.listen((_) {
          _openTimer?.cancel();
          _openTimer = null;
        }),
      );
      _peerSubs.add(
        created.closed.listen((_) {
          if (_peer == created) _failAttempt();
        }),
      );
      _peerSubs.add(created.incoming.listen(_onDataChannelBytes));
      _peerSubs.add(
        created.candidates.listen((candidate) {
          if (_peer != created) return;
          _sendSignal({'t': 'rtc-ice', 'candidate': candidate});
        }),
      );
      _openTimer?.cancel();
      _openTimer = Timer(openTimeout, () {
        final current = _peer;
        if (!_disposed &&
            current != null &&
            identical(current, created) &&
            !current.isOpen) {
          _failAttempt();
        }
      });
      final sdp = await created.createOffer();
      if (_disposed || _peer != created) return;
      if (sdp.isEmpty) {
        _failAttempt();
        return;
      }
      _sendSignal({'t': 'rtc-offer', 'sdp': sdp});
    } catch (_) {
      _failAttempt();
    } finally {
      _starting = false;
    }
  }

  void _onDataChannelBytes(Uint8List chunk) {
    if (_disposed || chunk.isEmpty) return;
    _accumulator.add(chunk);
    while (!_disposed) {
      final length = _accumulator.nextLength;
      if (length == null) return;
      if (length > _maxFrameBytes) {
        _accumulator.clear();
        _failAttempt();
        return;
      }
      if (_accumulator.length < 5 + length) return;
      final frame = _accumulator.take(5 + length);
      if (_direct) {
        _emit(frame);
      } else {
        // rtc-active 还没到（两条通道的先后顺序不保证）：先攒着。
        if (_earlyBytes + frame.length > _maxEarlyBytes) {
          _earlyFrames.clear();
          _earlyBytes = 0;
        }
        _earlyFrames.add(frame);
        _earlyBytes += frame.length;
      }
    }
  }

  void _flushEarlyFrames() {
    if (_earlyFrames.isEmpty) return;
    for (final frame in _earlyFrames) {
      _emit(frame);
    }
    _earlyFrames.clear();
    _earlyBytes = 0;
  }

  void _emit(Uint8List frame) {
    if (_disposed || _frames.isClosed) return;
    _frames.add(frame);
  }

  void _setDirect(bool next) {
    if (_direct == next) return;
    _direct = next;
    if (!_disposed) _onDirectChanged(next);
  }

  /// 服务端说直连没了（rtc-active{on:false}）：残余半帧作废，回中继。
  void _leaveDirect() {
    _accumulator.clear();
    _earlyFrames.clear();
    _earlyBytes = 0;
    _setDirect(false);
    if (_peer != null) _failAttempt();
  }

  void _failAttempt() {
    if (_disposed) return;
    _openTimer?.cancel();
    _openTimer = null;
    _retryTimer?.cancel();
    _retryTimer = null;
    final hadPeer = _peer != null;
    unawaited(_detachPeer());
    _accumulator.clear();
    _earlyFrames.clear();
    _earlyBytes = 0;
    _setDirect(false);
    if (hadPeer) _sendSignal({'t': 'rtc-close'});
    if (!_helloSeen || _retries >= maxRetries || _disposed) return;
    _retries += 1;
    _retryTimer = Timer(retryDelay, () {
      _retryTimer = null;
      if (_disposed) return;
      unawaited(_startAttempt());
    });
  }

  Future<void> _detachPeer() async {
    final peer = _peer;
    _peer = null;
    for (final sub in _peerSubs) {
      unawaited(sub.cancel());
    }
    _peerSubs.clear();
    if (peer != null) {
      try {
        await peer.close();
      } catch (_) {}
    }
  }
}

/// 按 5 字节头把 DataChannel 字节流切成整帧（分片边界与帧边界无关）。
///
/// 与 `remote_screen_h264.dart` 里的 `_Buffer` 同一思路：块列表 + 首块偏移，
/// 不为了每个 16KB 分片反复搬动整帧。
class _FrameAccumulator {
  final List<Uint8List> _chunks = <Uint8List>[];
  int _offset = 0;
  int _bytes = 0;

  int get length => _bytes;

  /// 够 5 字节头时返回 payload 长度，否则 null。
  int? get nextLength {
    if (_bytes < 5) return null;
    return (_peek(1) << 24) |
        (_peek(2) << 16) |
        (_peek(3) << 8) |
        _peek(4);
  }

  void add(Uint8List chunk) {
    if (chunk.isEmpty) return;
    _chunks.add(chunk);
    _bytes += chunk.length;
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

  void clear() {
    _chunks.clear();
    _offset = 0;
    _bytes = 0;
  }

  int _peek(int i) {
    var need = i;
    for (var k = 0; k < _chunks.length; k++) {
      final start = k == 0 ? _offset : 0;
      final available = _chunks[k].length - start;
      if (need < available) return _chunks[k][start + need];
      need -= available;
    }
    throw RangeError('p2p-frame-underrun');
  }
}
