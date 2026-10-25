// 「🖥 屏幕」高清流畅模式的 App 端单测：WS 字节流切帧、输入编码、
// 解码帧回填与断流/首帧超时的回落通知。平台解码器用假的替换。
import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:multicc_app/services/remote_screen_h264.dart';

class _DecoderCall {
  _DecoderCall(this.bytes, this.timestampUs, this.key, this.width, this.height);
  final Uint8List bytes;
  final int timestampUs;
  final bool key;
  final int width;
  final int height;
}

class _RecordingDecoder implements H264Decoder {
  final StreamController<H264Frame> _frames =
      StreamController<H264Frame>.broadcast();
  final StreamController<String> _errors = StreamController<String>.broadcast();
  final List<_DecoderCall> calls = <_DecoderCall>[];
  bool closed = false;

  @override
  Stream<H264Frame> get frames => _frames.stream;

  @override
  Stream<String> get errors => _errors.stream;

  @override
  Future<bool> open() async => true;

  @override
  void decode(
    Uint8List annexB, {
    required int timestampUs,
    required bool key,
    required int width,
    required int height,
  }) {
    calls.add(_DecoderCall(annexB, timestampUs, key, width, height));
  }

  @override
  Future<void> close() async {
    closed = true;
  }

  void emit(Uint8List bytes, int w, int h) {
    _frames.add(H264Frame(bytes: bytes, width: w, height: h, key: true));
  }
}

Uint8List _frame(int type, List<int> payload) {
  final out = Uint8List(5 + payload.length);
  out[0] = type;
  out[1] = (payload.length >> 24) & 0xFF;
  out[2] = (payload.length >> 16) & 0xFF;
  out[3] = (payload.length >> 8) & 0xFF;
  out[4] = payload.length & 0xFF;
  out.setRange(5, out.length, payload);
  return out;
}

const List<int> _annexB = [0, 0, 0, 1, 0x65, 0x88, 0x84, 0x00];

Uint8List _sample(int type, {int pts = 256}) {
  final d = ByteData(8);
  d.setUint64(0, pts, Endian.big);
  return _frame(type, [...d.buffer.asUint8List(), ..._annexB]);
}

Uint8List _config(int w, int h) =>
    _frame(h264Config, utf8.encode(jsonEncode({'width': w, 'height': h})));

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test(
    'stalled decoding requests a key frame then falls back if recovery fails',
    () {
      fakeAsync((clock) {
        final incoming = StreamController<Uint8List>();
        final decoder = _RecordingDecoder();
        final sent = <Uint8List>[];
        var closed = 0;
        final session = RemoteScreenH264(
          incoming: incoming.stream,
          send: sent.add,
          decoder: decoder,
          onClosed: () => closed++,
          now: () => DateTime(2026).add(clock.elapsed),
        );
        unawaited(session.run());
        decoder.emit(Uint8List(4), 1, 1);
        clock.flushMicrotasks();
        sent.clear();
        clock.elapse(const Duration(seconds: 4));
        expect(sent, [
          [h264ReqKey],
        ]);
        expect(closed, 0);
        decoder.emit(Uint8List(4), 1, 1);
        clock.flushMicrotasks();
        clock.elapse(const Duration(seconds: 8));
        expect(
          closed,
          0,
          reason: 'a recovered frame resets the stall deadline',
        );
        clock.elapse(const Duration(seconds: 4));
        expect(closed, 1);
        expect(decoder.closed, isTrue);
        unawaited(incoming.close());
        clock.flushMicrotasks();
      });
    },
  );

  test('一串解码错误只要一个关键帧：错误也走 500ms 节流，不连发 K 堵死弱链路', () {
    fakeAsync((clock) {
      final incoming = StreamController<Uint8List>();
      final decoder = _RecordingDecoder();
      final sent = <Uint8List>[];
      final session = RemoteScreenH264(
        incoming: incoming.stream,
        send: sent.add,
        decoder: decoder,
        now: () => DateTime(2026).add(clock.elapsed),
      );
      unawaited(session.run());
      clock.flushMicrotasks();
      clock.elapse(const Duration(seconds: 1));
      sent.clear(); // 启动时的 'K'
      for (var i = 0; i < 5; i++) {
        decoder._errors.add('bad frame');
        clock.elapse(const Duration(milliseconds: 20));
      }
      expect(sent, [
        [h264ReqKey],
      ]);
      clock.elapse(const Duration(milliseconds: 500));
      decoder._errors.add('bad frame');
      clock.flushMicrotasks();
      expect(sent.length, 2, reason: 'a later error may ask again');
      session.dispose();
      unawaited(incoming.close());
      clock.flushMicrotasks();
    });
  });

  test('按 5 字节头切帧：跨 WS 消息的帧能拼回，delta 先到不送解码器', () async {
    final incoming = StreamController<Uint8List>();
    final sent = <Uint8List>[];
    final decoder = _RecordingDecoder();
    addTearDown(incoming.close);

    final session = RemoteScreenH264(
      incoming: incoming.stream,
      send: sent.add,
      decoder: decoder,
    );
    unawaited(session.run());
    await Future<void>.delayed(Duration.zero);

    // 连上先要一个关键帧。
    expect(sent, [
      [h264ReqKey],
    ]);

    final all = BytesBuilder()
      ..add(_config(4, 2))
      ..add(_sample(h264Delta)) // 关键帧之前：应被丢掉
      ..add(_sample(h264Key))
      ..add(_sample(h264Delta));
    final bytes = all.takeBytes();
    // 故意在帧头中间、载荷中间切开。
    for (var i = 0; i < bytes.length; i += 7) {
      final end = i + 7 < bytes.length ? i + 7 : bytes.length;
      incoming.add(Uint8List.fromList(bytes.sublist(i, end)));
    }
    await Future<void>.delayed(const Duration(milliseconds: 20));

    expect(decoder.calls.length, 2, reason: 'delta 在关键帧前应被丢掉');
    expect(decoder.calls[0].key, isTrue);
    expect(decoder.calls[0].width, 4);
    expect(decoder.calls[0].height, 2);
    expect(decoder.calls[0].timestampUs, 256);
    expect(decoder.calls[0].bytes, _annexB);
    expect(decoder.calls[1].key, isFalse);

    session.dispose();
    expect(decoder.closed, isTrue);
  });

  test('输入编码与 RFB 完全一致（PointerEvent / KeyEvent / 文字 / 和弦）', () async {
    final incoming = StreamController<Uint8List>();
    final sent = <Uint8List>[];
    final decoder = _RecordingDecoder();
    addTearDown(incoming.close);
    final session = RemoteScreenH264(
      incoming: incoming.stream,
      send: sent.add,
      decoder: decoder,
    );
    unawaited(session.run());
    await Future<void>.delayed(Duration.zero);
    sent.clear(); // 丢掉启动时的 'K'

    session.pointerEvent(1, 10, 20);
    session.keyEvent(true, 0x41);
    session.typeText('A');
    session.chord(<int>[0xFFE7], 0x63);

    expect(sent[0], [5, 1, 0, 10, 0, 20]);
    expect(sent[1], [4, 1, 0, 0, 0, 0, 0, 0x41]);
    expect(sent[2], [4, 1, 0, 0, 0, 0, 0, 0x41]);
    expect(sent[3], [4, 0, 0, 0, 0, 0, 0, 0x41]);
    // 和弦：cmd down → c down → c up → cmd up
    expect(sent[4], [4, 1, 0, 0, 0, 0, 0xFF, 0xE7]);
    expect(sent[5], [4, 1, 0, 0, 0, 0, 0, 0x63]);
    expect(sent[6], [4, 0, 0, 0, 0, 0, 0, 0x63]);
    expect(sent[7], [4, 0, 0, 0, 0, 0, 0xFF, 0xE7]);

    session.dispose();
  });

  test('帧被原生解码器压小后，指针坐标按编码尺寸（屏幕逻辑点）放大回去', () async {
    final incoming = StreamController<Uint8List>();
    final sent = <Uint8List>[];
    final decoder = _RecordingDecoder();
    addTearDown(incoming.close);
    final session = RemoteScreenH264(
      incoming: incoming.stream,
      send: sent.add,
      decoder: decoder,
    );
    unawaited(session.run());
    await Future<void>.delayed(Duration.zero);
    incoming.add(_config(1470, 956));
    await Future<void>.delayed(Duration.zero);
    // iOS/Android 解码器：1470×956 压成 1280×832。
    decoder.emit(Uint8List(1280 * 832 * 4), 1280, 832);
    await Future<void>.delayed(Duration.zero);
    sent.clear();

    session.pointerEvent(1, 640, 416); // 帧缓冲正中 → 屏幕正中 (735,478)
    session.pointerEvent(0, 1279, 831); // 右下角 → (1469,955)
    session.pointerEvent(0, 0, 0);
    expect(sent[0], [5, 1, 735 >> 8, 735 & 255, 478 >> 8, 478 & 255]);
    expect(sent[1], [5, 0, 1469 >> 8, 1469 & 255, 955 >> 8, 955 & 255]);
    expect(sent[2], [5, 0, 0, 0, 0, 0]);

    session.dispose();
  });

  test('解码帧回填 BGRA 画面并向服务报 live 帧', () async {
    final incoming = StreamController<Uint8List>();
    final sent = <Uint8List>[];
    final decoder = _RecordingDecoder();
    var frames = 0;
    addTearDown(incoming.close);
    final session = RemoteScreenH264(
      incoming: incoming.stream,
      send: sent.add,
      decoder: decoder,
      onFrame: () => frames++,
    );
    unawaited(session.run());
    await Future<void>.delayed(Duration.zero);

    final bgra = Uint8List.fromList(List<int>.filled(4 * 2 * 4, 0x22));
    decoder.emit(bgra, 4, 2);
    await Future<void>.delayed(Duration.zero);

    expect(session.width, 4);
    expect(session.height, 2);
    expect(session.framebuffer, same(bgra));
    expect(session.frameVersion, 1);
    expect(frames, 1);

    session.dispose();
  });

  test('首帧超时与传输结束都会通知服务切换（先退 RFB 再退轮询）', () async {
    final incoming = StreamController<Uint8List>();
    final decoder = _RecordingDecoder();
    var closed = 0;
    final session = RemoteScreenH264(
      incoming: incoming.stream,
      send: (_) {},
      decoder: decoder,
      firstFrameTimeout: const Duration(milliseconds: 20),
      onClosed: () => closed++,
    );
    unawaited(session.run());
    await Future<void>.delayed(const Duration(milliseconds: 60));
    expect(closed, 1);
    session.dispose();
    expect(closed, 1, reason: 'dispose 不应重复通知');

    final incoming2 = StreamController<Uint8List>();
    final decoder2 = _RecordingDecoder();
    var closed2 = 0;
    addTearDown(incoming2.close);
    final session2 = RemoteScreenH264(
      incoming: incoming2.stream,
      send: (_) {},
      decoder: decoder2,
      onClosed: () => closed2++,
    );
    unawaited(session2.run());
    await Future<void>.delayed(Duration.zero);
    await incoming2.close();
    await Future<void>.delayed(Duration.zero);
    expect(closed2, 1);
    expect(decoder2.closed, isTrue);
  });
}
