import 'dart:async';
import 'dart:io' as io;

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import 'remote_screen_h264.dart';

/// H.264 平台解码器（iOS VideoToolbox / Android MediaCodec）。
///
/// 通道：`com.multicc.multicc_app/h264`
///   Dart → 原生  create / decode {bytes, pts, key, width, height} / dispose
///   原生 → Dart  frame {bytes(BGRA), width, height, seq, key}
///                error {message}
///
/// 原生侧负责把帧降到 ≤1280 宽，BGRA 回传；页面按 4 字节/像素直接画，
/// 与 RFB 的 framebuffer 同一路径。
class PlatformH264Decoder implements H264Decoder {
  PlatformH264Decoder({MethodChannel? channel})
    : _channel = channel ?? const MethodChannel(platformH264Channel) {
    _owner = this;
    _channel.setMethodCallHandler(_onCall);
  }

  static const String platformH264Channel = 'com.multicc.multicc_app/h264';

  /// 通道与原生解码器都是全局唯一的：重连时新实例先建、旧实例后关，
  /// 旧实例不能再去 dispose 原生解码器或清掉通道回调 —— 否则新会话
  /// 收不到任何帧（输入照常送达，画面却停在最后一帧）。
  static PlatformH264Decoder? _owner;

  /// 只有移动端有解码插件；桌面/Web 端一律回落到 RFB。
  static H264Decoder? create() {
    if (kIsWeb) return null;
    if (!io.Platform.isIOS && !io.Platform.isAndroid) return null;
    return PlatformH264Decoder();
  }

  final MethodChannel _channel;
  final StreamController<H264Frame> _frames =
      StreamController<H264Frame>.broadcast();
  final StreamController<String> _errors = StreamController<String>.broadcast();
  bool _closed = false;

  @override
  Stream<H264Frame> get frames => _frames.stream;

  @override
  Stream<String> get errors => _errors.stream;

  @override
  Future<bool> open() async {
    try {
      final ok = await _channel.invokeMethod<bool>('create');
      return ok == true;
    } catch (_) {
      return false; // 未注册插件 / 平台不支持
    }
  }

  @override
  void decode(
    Uint8List annexB, {
    required int timestampUs,
    required bool key,
    required int width,
    required int height,
  }) {
    if (_closed) return;
    _channel
        .invokeMethod<void>('decode', <String, dynamic>{
          'bytes': annexB,
          'pts': timestampUs,
          'key': key,
          'width': width,
          'height': height,
        })
        .then<void>((_) {}, onError: (Object _) {});
  }

  Future<dynamic> _onCall(MethodCall call) async {
    if (_closed) return null;
    final args = call.arguments;
    if (call.method == 'frame' && args is Map) {
      final bytes = args['bytes'];
      final w = (args['width'] as num?)?.toInt() ?? 0;
      final h = (args['height'] as num?)?.toInt() ?? 0;
      if (bytes is Uint8List && w > 0 && h > 0) {
        _frames.add(
          H264Frame(
            // StandardMessageCodec 解出的 Uint8List 是消息缓冲区里的视图，起点
            // 随原生端字典的键序（Swift 每次进程启动随机）落在任意字节上；
            // 页面要按 32 位整读做 BGRA→RGBA，不是 4 字节对齐就先拷一份。
            bytes: bytes.offsetInBytes % 4 == 0
                ? bytes
                : Uint8List.fromList(bytes),
            width: w,
            height: h,
            key: args['key'] == true,
          ),
        );
      }
    } else if (call.method == 'error') {
      final message = args is Map ? '${args['message'] ?? ''}' : '$args';
      _errors.add(message.isEmpty ? 'decode-failed' : message);
    }
    return null;
  }

  @override
  Future<void> close() async {
    if (_closed) return;
    _closed = true;
    if (identical(_owner, this)) {
      try {
        await _channel.invokeMethod<void>('dispose');
      } catch (_) {}
      // 等 dispose 往返期间可能已有新实例接手。
      if (identical(_owner, this)) {
        _owner = null;
        _channel.setMethodCallHandler(null);
      }
    }
    await _frames.close();
    await _errors.close();
  }
}
