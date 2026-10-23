// The wire golden contract — the App half.
//
// The H.264 channel carries the same bytes through three programs: this App
// encodes input and parses frames, src/remote-screen-h264-bridge.js relays
// them, and the Agent (MultiCCAgentH264.swift h264Session) decodes input. Each
// end used to assert its own hand-copied bytes, so an encoding change on one
// side stayed green everywhere. All three now answer to one table,
// tests/fixtures/remote-screen-wire.json (bridge: tests/test-remote-screen-h264.js,
// agent: tests/test-macos-agent.js).
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:multicc_app/services/remote_screen_h264.dart';
import 'package:multicc_app/services/remote_screen_source.dart';

Map<String, dynamic> _loadFixture() {
  for (final candidate in [
    'tests/fixtures/remote-screen-wire.json',
    '../tests/fixtures/remote-screen-wire.json',
  ]) {
    final file = File(candidate);
    if (file.existsSync()) {
      return jsonDecode(file.readAsStringSync()) as Map<String, dynamic>;
    }
  }
  throw StateError('remote-screen-wire.json not found relative to CWD');
}

String _hex(List<int> bytes) =>
    bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();

Uint8List _bytes(String hex) => Uint8List.fromList([
  for (var i = 0; i < hex.length; i += 2)
    int.parse(hex.substring(i, i + 2), radix: 16),
]);

class _Input with ScreenInputMixin implements ScreenSource {
  final sent = <String>[];
  @override
  int width = 0;
  @override
  int height = 0;
  @override
  Uint8List? framebuffer;
  @override
  void sendInput(Uint8List bytes) => sent.add(_hex(bytes));
}

class _Decoder implements H264Decoder {
  final frames0 = StreamController<H264Frame>.broadcast();
  final calls = <Map<String, Object>>[];
  @override
  Stream<H264Frame> get frames => frames0.stream;
  @override
  Stream<String> get errors => const Stream<String>.empty();
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
    calls.add({
      'annexB': _hex(annexB),
      'pts': timestampUs,
      'key': key,
      'size': '${width}x$height',
    });
  }

  @override
  Future<void> close() async {}
}

void main() {
  final fixture = _loadFixture();
  final clientToAgent = (fixture['clientToAgent'] as List)
      .cast<Map<String, dynamic>>();
  final agentToClient = (fixture['agentToClient'] as List)
      .cast<Map<String, dynamic>>();
  final scaling = (fixture['decodedScaling'] as List)
      .cast<Map<String, dynamic>>();

  test('every input message encodes to the golden bytes', () {
    for (final c in clientToAgent.where((c) => c['kind'] != 'keyRequest')) {
      final input = _Input();
      if (c['kind'] == 'pointer') {
        input.pointerEvent(c['mask'] as int, c['x'] as int, c['y'] as int);
      } else {
        input.keyEvent(c['down'] as bool, c['keysym'] as int);
      }
      expect(input.sent, [c['hex']], reason: c['name'] as String);
    }
  });

  test('key-frame request and decoded→encoded pointer scaling match', () async {
    final keyRequest = clientToAgent.singleWhere(
      (c) => c['kind'] == 'keyRequest',
    );
    for (final c in scaling) {
      final sent = <String>[];
      final incoming = StreamController<Uint8List>();
      final decoder = _Decoder();
      final session = RemoteScreenH264(
        incoming: incoming.stream,
        send: (b) => sent.add(_hex(b)),
        decoder: decoder,
      );
      await session.run();
      expect(sent, [keyRequest['hex']], reason: 'run() asks for a key frame');
      final encoded = (c['encoded'] as List).cast<int>();
      final decoded = (c['decoded'] as List).cast<int>();
      final config = utf8.encode(
        jsonEncode({
          'codec': 'avc1.640028',
          'width': encoded[0],
          'height': encoded[1],
        }),
      );
      incoming.add(
        Uint8List.fromList([
          1,
          ...[24, 16, 8, 0].map((s) => (config.length >> s) & 0xFF),
          ...config,
        ]),
      );
      await Future<void>.delayed(Duration.zero);
      decoder.frames0.add(
        H264Frame(
          bytes: Uint8List(decoded[0] * decoded[1] * 4),
          width: decoded[0],
          height: decoded[1],
        ),
      );
      await Future<void>.delayed(Duration.zero);
      sent.clear();
      session.pointerEvent(c['mask'] as int, c['x'] as int, c['y'] as int);
      expect(sent, [c['hex']], reason: '${c['name']}: ${c['why']}');
      session.dispose();
      await incoming.close();
    }
  });

  test('agent frames parse to the golden fields at any chunking', () async {
    final stream = [
      for (final f in agentToClient) ..._bytes(f['hex'] as String),
    ];
    final config = agentToClient.singleWhere((f) => f['type'] == 1);
    final json = config['json'] as Map<String, dynamic>;
    final want = [
      for (final f in agentToClient.where((f) => f['type'] != 1))
        {
          'annexB': f['annexBHex'],
          'pts': f['pts'],
          'key': f['type'] == 2,
          'size': '${json['width']}x${json['height']}',
        },
    ];
    for (final cut in [1, 3, 7, 64]) {
      final incoming = StreamController<Uint8List>();
      final decoder = _Decoder();
      final session = RemoteScreenH264(
        incoming: incoming.stream,
        send: (_) {},
        decoder: decoder,
      );
      await session.run();
      for (var i = 0; i < stream.length; i += cut) {
        final end = i + cut < stream.length ? i + cut : stream.length;
        incoming.add(Uint8List.fromList(stream.sublist(i, end)));
      }
      await Future<void>.delayed(Duration.zero);
      expect(decoder.calls, want, reason: 'cut $cut');
      session.dispose();
      await incoming.close();
    }
  });
}
