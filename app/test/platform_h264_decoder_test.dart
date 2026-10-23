import 'dart:typed_data';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:multicc_app/services/platform_h264_decoder.dart';
import 'package:multicc_app/services/remote_screen_h264.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  // 原生端用 Swift 字典回传 frame，键序随进程启动随机；bytes 排在后面时
  // 解码出来的 Uint8List 起点不是 4 的倍数，页面按 32 位读 BGRA 会抛异常。
  test('decoded frame bytes are 4-byte aligned whatever the key order', () async {
    const channel = MethodChannel(PlatformH264Decoder.platformH264Channel);
    final messenger =
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    final decoder = PlatformH264Decoder(channel: channel);
    final frames = <H264Frame>[];
    final sub = decoder.frames.listen(frames.add);
    const codec = StandardMethodCodec();
    final pixels = Uint8List(8 * 2 * 4);
    for (var i = 0; i < pixels.length; i++) {
      pixels[i] = i & 0xFF;
    }
    final orders = [
      ['width', 'height', 'seq', 'bytes'],
      ['width', 'height', 'bytes', 'seq'],
      ['bytes', 'width', 'height', 'seq'],
      ['seq', 'bytes', 'width', 'height'],
    ];
    final offsets = <int>{};
    for (final order in orders) {
      final args = <String, Object>{
        for (final k in order)
          k: switch (k) {
            'bytes' => pixels,
            'width' => 8,
            'height' => 2,
            _ => 1,
          },
      };
      final raw = codec.encodeMethodCall(MethodCall('frame', args));
      final decoded = codec.decodeMethodCall(raw);
      offsets.add(
        ((decoded.arguments as Map)['bytes'] as Uint8List).offsetInBytes % 4,
      );
      await messenger.handlePlatformMessage(channel.name, raw, (_) {});
    }
    await Future<void>.delayed(Duration.zero);

    // 前提：这些键序里确实有不对齐的，否则这个测试什么也没证明。
    expect(offsets.any((o) => o != 0), isTrue);
    expect(frames, hasLength(orders.length));
    for (final f in frames) {
      expect(f.bytes.offsetInBytes % 4, 0);
      expect(
        () => Uint32List.view(f.bytes.buffer, f.bytes.offsetInBytes, 16),
        returnsNormally,
      );
      expect(f.bytes, pixels);
    }
    await sub.cancel();
    await decoder.close();
  });

  // 重连：新解码器先建、旧解码器后关。旧实例关闭不能清掉新实例的通道回调，
  // 也不能 dispose 原生解码器 —— 否则新会话一帧都收不到，画面停在最后一帧。
  test('closing a superseded decoder keeps the new one receiving frames', () async {
    const channel = MethodChannel(PlatformH264Decoder.platformH264Channel);
    final messenger =
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    final calls = <String>[];
    messenger.setMockMethodCallHandler(channel, (call) async {
      calls.add(call.method);
      return true;
    });
    final old = PlatformH264Decoder(channel: channel);
    final fresh = PlatformH264Decoder(channel: channel);
    final frames = <H264Frame>[];
    final sub = fresh.frames.listen(frames.add);
    await old.close();
    expect(calls, isNot(contains('dispose')));

    const codec = StandardMethodCodec();
    final raw = codec.encodeMethodCall(
      MethodCall('frame', {'bytes': Uint8List(8 * 2 * 4), 'width': 8, 'height': 2}),
    );
    await messenger.handlePlatformMessage(channel.name, raw, (_) {});
    await Future<void>.delayed(Duration.zero);
    expect(frames, hasLength(1));

    await sub.cancel();
    await fresh.close();
    expect(calls, contains('dispose'));
    messenger.setMockMethodCallHandler(channel, null);
  });
}
