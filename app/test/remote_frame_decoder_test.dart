import 'dart:async';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter_test/flutter_test.dart';
import 'package:multicc_app/services/remote_frame_decoder.dart';

Future<ui.Image> image() async {
  final recorder = ui.PictureRecorder();
  ui.Canvas(recorder).drawColor(const ui.Color(0xff123456), ui.BlendMode.src);
  final picture = recorder.endRecording();
  final result = await picture.toImage(1, 1);
  picture.dispose();
  return result;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test(
    'final update during decode is shown without another frame or gesture',
    () async {
      final gate = Completer<ui.Image>();
      final decoded = <int>[];
      final painted = <ui.Image>[];
      final done = Completer<void>();
      final decoder = RemoteFrameDecoder(
        decode: (pixels, w, h) async {
          decoded.add(pixels.first);
          return decoded.length == 1 ? gate.future : image();
        },
        onImage: (frame) {
          painted.add(frame);
          if (painted.length == 2) done.complete();
        },
      );
      decoder.add(Uint8List.fromList([1, 0, 0, 255]), 1, 1);
      decoder.add(Uint8List.fromList([2, 0, 0, 255]), 1, 1);
      final last = Uint8List.fromList([3, 0, 0, 255]);
      decoder.add(last, 1, 1);
      last[0] =
          99; // The source framebuffer is mutable; snapshots must be owned.
      gate.complete(await image());
      await done.future;
      expect(decoded, [1, 3]);
      decoder.dispose();
      for (final frame in painted) {
        frame.dispose();
      }
    },
  );

  test(
    'switching source drops an old in-flight result and paints the new source',
    () async {
      final gate = Completer<ui.Image>();
      final painted = <ui.Image>[];
      final done = Completer<void>();
      var calls = 0;
      final decoder = RemoteFrameDecoder(
        decode: (_, w, h) => ++calls == 1 ? gate.future : image(),
        onImage: (frame) {
          painted.add(frame);
          done.complete();
        },
      );
      decoder.add(Uint8List(4), 1, 1);
      decoder.clear();
      decoder.add(Uint8List(4), 1, 1);
      gate.complete(await image());
      await done.future;
      expect(calls, 2);
      expect(painted, hasLength(1));
      decoder.dispose();
      painted.single.dispose();
    },
  );

  test('a decode that never answers does not freeze later frames', () async {
    final painted = <ui.Image>[];
    final done = Completer<void>();
    var calls = 0;
    final decoder = RemoteFrameDecoder(
      decodeTimeout: const Duration(milliseconds: 20),
      decode: (_, w, h) =>
          ++calls == 1 ? Completer<ui.Image>().future : image(),
      onImage: (frame) {
        painted.add(frame);
        done.complete();
      },
    );
    decoder.add(Uint8List(4), 1, 1);
    decoder.add(Uint8List(4), 1, 1);
    await done.future.timeout(const Duration(seconds: 2));
    expect(calls, 2);
    decoder.dispose();
    painted.single.dispose();
  });

  test('the default decoder turns BGRA pixels into an image', () async {
    final done = Completer<ui.Image>();
    final decoder = RemoteFrameDecoder(onImage: done.complete);
    decoder.add(Uint8List.fromList([0x56, 0x34, 0x12, 0xff]), 1, 1);
    final img = await done.future.timeout(const Duration(seconds: 5));
    expect([img.width, img.height], [1, 1]);
    decoder.dispose();
    img.dispose();
  });
}
