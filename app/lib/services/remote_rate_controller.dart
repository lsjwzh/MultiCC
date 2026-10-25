import 'dart:math' as math;

import 'package:flutter/foundation.dart';

/// 「🖥 屏幕」高清模式的码率自适应控制器（App 端，纯逻辑，可注入时钟）。
///
/// 链路是手机 → 公网隧道 → Mac 上的 Node 中继 → Agent 的 VideoToolbox 编码器，
/// 全程 TCP，容量只有几十 KB/s 且抖动大。编码器默认按屏幕尺寸算码率（约 3
/// bit/像素，1470×956 ≈ 4.2 Mbps ≈ 527 KB/s），远超链路，数据在各级缓冲里排队，
/// 越积越卡。这里用两个都能端到端观测到的信号把它拉回链路容量：
///
///   · 排队延迟 = 帧到达时刻 − 帧的 pts（发送时刻）。两端时钟不同步，但偏移是
///     常数，所以减去最近 15 秒窗口里这个差值的最小值，剩下的增量就是排队时间。
///   · RTT = ping('P') 发出到 pong(type 4) 回来的时间。Agent 重启或链路换路后
///     这个值会跳，所以只和最近 15 秒的最小 RTT 比。
///
/// 过载（排队 >200ms 或 RTT 比最小 RTT 高 400ms）就按 0.85×target 且不超过
/// 0.9×实收速率下调；排队 <80ms 连续 3 秒、实收速率又真的接近 target（排除
/// 「画面静止所以没流量」的应用受限状态）才 ×1.1 慢慢升回去。算出来的 target
/// 通过 'B' 发给 Agent，Agent 在所有客户端（App 与网页）之间取最小值。
class RemoteRateStats {
  const RemoteRateStats({
    required this.targetKbps,
    this.recvKbps = 0,
    this.rttMs,
    this.appliedKbps = 0,
    this.encodedWidth = 0,
    this.encodedHeight = 0,
  });

  /// 控制器希望 Agent 使用的码率（kbps）。null 不会出现：未测量时是初始值。
  final int targetKbps;

  /// 最近 1 秒实际收到的视频字节折算成的码率（kbps）。
  final int recvKbps;

  /// 最近一次 ping 的往返时延（ms）；还没收到 pong 时为 null。
  final int? rttMs;

  /// Agent 回报的编码器实际生效码率（kbps）；旧 Agent 不发 pong 时是 0。
  final int appliedKbps;

  /// 编码器当前的编码尺寸（config 的 width/height，降分辨率后会变小）。
  final int encodedWidth;
  final int encodedHeight;

  RemoteRateStats copyWith({
    int? targetKbps,
    int? recvKbps,
    int? rttMs,
    int? appliedKbps,
    int? encodedWidth,
    int? encodedHeight,
  }) => RemoteRateStats(
    targetKbps: targetKbps ?? this.targetKbps,
    recvKbps: recvKbps ?? this.recvKbps,
    rttMs: rttMs ?? this.rttMs,
    appliedKbps: appliedKbps ?? this.appliedKbps,
    encodedWidth: encodedWidth ?? this.encodedWidth,
    encodedHeight: encodedHeight ?? this.encodedHeight,
  );

  @override
  bool operator ==(Object other) =>
      other is RemoteRateStats &&
      other.targetKbps == targetKbps &&
      other.recvKbps == recvKbps &&
      other.rttMs == rttMs &&
      other.appliedKbps == appliedKbps &&
      other.encodedWidth == encodedWidth &&
      other.encodedHeight == encodedHeight;

  @override
  int get hashCode => Object.hash(
    targetKbps,
    recvKbps,
    rttMs,
    appliedKbps,
    encodedWidth,
    encodedHeight,
  );

  @override
  String toString() =>
      'RemoteRateStats(target: $targetKbps, recv: $recvKbps, rtt: $rttMs, '
      'applied: $appliedKbps, ${encodedWidth}x$encodedHeight)';
}

class RemoteRateController {
  RemoteRateController({
    int initialTargetKbps = 2000,
    this.minKbps = 300,
    this.maxKbps = 12000,
    int Function()? clock,
  }) : _target = initialTargetKbps.toDouble(),
       _clock = clock {
    _stats = ValueNotifier<RemoteRateStats>(RemoteRateStats(targetKbps: _target.round()));
  }

  /// 排队延迟估计窗口：两端时钟偏移在这段时间内足够稳定。
  static const int windowMs = 15000;

  /// 过载判定：最近 1 秒的平均排队延迟，以及 RTT 相对最小值的增量。
  static const int queueOverloadMs = 200;
  static const int rttOverloadMs = 400;

  /// 恢复判定：排队延迟要低于它并连续保持 [recoverHoldMs] 才升。
  static const int queueClearMs = 80;
  static const int recoverHoldMs = 3000;

  /// 两次下调至少间隔这么久（一次过载只砍一刀）。
  static const int downIntervalMs = 1000;

  /// 发送节流：变化 ≥5% 且距上次 ≥500ms；另外每 10 秒重发一次当前值，
  /// Agent 重启（编码器回到默认码率）后能自己恢复。
  static const double sendThreshold = 0.05;
  static const int sendIntervalMs = 500;
  static const int resendMs = 10000;

  final int minKbps;
  final int maxKbps;
  final int Function()? _clock;

  double _target;
  int? _lastSentKbps;
  int? _lastSentMs;
  int? _lastDownMs;
  int? _lowSinceMs;
  int _recvKbps = 0;
  int? _rttMs;
  int _appliedKbps = 0;
  int _encodedWidth = 0;
  int _encodedHeight = 0;

  /// 每帧的 (到达时刻 ms, 到达 − pts ms)。15 秒窗口，首项是排队基线。
  final List<_TimedSample> _queue = <_TimedSample>[];
  final List<_TimedSample> _bytes = <_TimedSample>[];
  final List<_TimedSample> _rtt = <_TimedSample>[];

  late final ValueNotifier<RemoteRateStats> _stats;

  /// 页面用它在状态栏显示「延迟 · 实收/目标 · 路径」。会话关闭后不再更新。
  ValueListenable<RemoteRateStats> get stats => _stats;

  int get targetKbps => _target.round();
  int get recvKbps => _recvKbps;
  int? get rttMs => _rttMs;

  /// 一帧到达：字节数进实收窗口，到达时刻与 pts 的差进排队窗口。
  void onFrame(int arrivalMs, int ptsUs, int bytes) {
    _nowHint = arrivalMs;
    final deltaMs = arrivalMs - ptsUs / 1000.0;
    _queue.add(_TimedSample(arrivalMs, deltaMs));
    _bytes.add(_TimedSample(arrivalMs, bytes.toDouble()));
    _prune(arrivalMs);
  }

  /// pong 回来：RTT 与 Agent 的实际生效码率。
  void onPong(int rttMs, int appliedKbps) {
    final now = _clock?.call() ?? _nowHint;
    if (now > 0) _rtt.add(_TimedSample(now, rttMs.toDouble()));
    _rttMs = rttMs;
    if (appliedKbps > 0) _appliedKbps = appliedKbps;
    _emit();
  }

  /// config：记录编码尺寸（降分辨率后变小），页面据此显示。
  void onConfig(int width, int height) {
    if (width <= 0 || height <= 0) return;
    _encodedWidth = width;
    _encodedHeight = height;
    _emit();
  }

  // onPong 的可选时钟缺省时用最近一帧/心跳的时间戳当窗口锚点；RTT 窗口只用来
  // 取最小值，锚点误差几秒不改变结论。
  int _nowHint = 0;

  /// 每秒调用一次。返回需要发给 Agent 的码率（kbps），没有变化时返回 null。
  int? tick(int nowMs) {
    _nowHint = nowMs;
    _prune(nowMs);
    _recvKbps = _receivedKbps(nowMs);

    final queueMean = _queueMean(nowMs);
    final overloaded = _overloaded(nowMs, queueMean);

    if (overloaded) {
      _lowSinceMs = null;
      if (_lastDownMs == null || nowMs - _lastDownMs! >= downIntervalMs) {
        final next = math.min(_target * 0.85, _recvKbps * 0.9);
        _target = math.max(minKbps.toDouble(), math.min(_target, next));
        _lastDownMs = nowMs;
      }
    } else if (queueMean < queueClearMs) {
      final since = _lowSinceMs ?? nowMs;
      _lowSinceMs = since;
      // 应用受限（画面静止时几乎没流量）不算链路有余量，保持不动。
      final appLimited = _recvKbps < 0.5 * _target;
      if (!appLimited && nowMs - since >= recoverHoldMs) {
        _target = math.min(maxKbps.toDouble(), _target * 1.1);
        _lowSinceMs = nowMs;
      }
    } else {
      _lowSinceMs = null;
    }

    _emit();
    return _send(nowMs);
  }

  void dispose() => _stats.dispose();

  int _receivedKbps(int nowMs) {
    var bytes = 0.0;
    for (final s in _bytes) {
      if (nowMs - s.at <= 1000) bytes += s.value;
    }
    return (bytes * 8 / 1000).round();
  }

  /// 最近 1 秒的平均排队延迟；没有样本（画面静止）时按 0 处理。
  double _queueMean(int nowMs) {
    if (_queue.isEmpty) return 0;
    var base = double.infinity;
    for (final s in _queue) {
      if (s.value < base) base = s.value;
    }
    var sum = 0.0;
    var count = 0;
    for (final s in _queue) {
      if (nowMs - s.at <= 1000) {
        sum += s.value - base;
        count += 1;
      }
    }
    return count == 0 ? 0 : sum / count;
  }

  bool _overloaded(int nowMs, double queueMean) {
    if (queueMean > queueOverloadMs) return true;
    final rtt = _rttMs;
    if (rtt == null || _rtt.isEmpty) return false;
    var minRtt = double.infinity;
    for (final s in _rtt) {
      if (s.value < minRtt) minRtt = s.value;
    }
    return minRtt.isFinite && rtt > minRtt + rttOverloadMs;
  }

  int? _send(int nowMs) {
    final want = _target.round();
    final last = _lastSentKbps;
    final since = _lastSentMs == null ? 1 << 30 : nowMs - _lastSentMs!;
    final changed =
        last == null ||
        (want - last).abs() / (last == 0 ? 1 : last) >= sendThreshold;
    if (!((changed && since >= sendIntervalMs) || since >= resendMs)) {
      return null;
    }
    _lastSentKbps = want;
    _lastSentMs = nowMs;
    return want;
  }

  void _prune(int nowMs) {
    _pruneList(_queue, nowMs);
    _pruneList(_bytes, nowMs);
    _pruneList(_rtt, nowMs);
  }

  void _pruneList(List<_TimedSample> list, int nowMs) {
    var drop = 0;
    while (drop < list.length && nowMs - list[drop].at > windowMs) {
      drop += 1;
    }
    if (drop > 0) list.removeRange(0, drop);
  }

  void _emit() {
    final next = RemoteRateStats(
      targetKbps: _target.round(),      recvKbps: _recvKbps,
      rttMs: _rttMs,
      appliedKbps: _appliedKbps,
      encodedWidth: _encodedWidth,
      encodedHeight: _encodedHeight,
    );
    if (_stats.value != next) _stats.value = next;
  }
}

class _TimedSample {
  const _TimedSample(this.at, this.value);
  final int at;
  final double value;
}
