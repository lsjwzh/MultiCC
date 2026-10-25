import 'dart:async';
import 'dart:convert';
import 'dart:io' show RawZLibFilter;
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:multicc_app/services/remote_screen_rfb.dart';

/// RemoteScreenRfb 协议层单测：用一个内存 StreamController 扮演 Agent 的
/// rfb.sock（MultiCCAgent.swift 的 RFB 段），重点钉住三件事——
/// 1) 握手/ServerInit/矩形应用的字节序与位置；
/// 2) WS 帧不与 RFB 消息对齐时 _ChunkedReader 的流重组（任意切段结果一致）；
/// 3) 空保活 update（n=0）之后继续 re-arm incremental request（静止画面
///    不断流的客户端侧前提，见 Swift 端 servedAny 修复）。
/// 16×8，左半红右半蓝，sips 以质量 90 编出来的真 JPEG。
const _redBlueJpeg =
    '/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAEKADAAQAAAABAAAACAAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgACAAQAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAQEBAQEBAgEBAgMCAgIDBAMDAwMEBQQEBAQEBQYFBQUFBQUGBgYGBgYGBgcHBwcHBwgICAgICQkJCQkJCQkJCf/bAEMBAQEBAgICBAICBAkGBQYJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCf/dAAQAAf/aAAwDAQACEQMRAD8A/F+vyHr9eK/Iev8AVD/Rl/8Amtv+6f8A+7x/tR/pDP8AzSH/AHPf+6Z//9k=';

Uint8List _rect(int x, int y, int w, int h, int enc) {
  final b = ByteData(12)
    ..setUint16(0, x)
    ..setUint16(2, y)
    ..setUint16(4, w)
    ..setUint16(6, h)
    ..setInt32(8, enc);
  return b.buffer.asUint8List();
}

/// Tight compact length（与 Agent 的 tightLength 同一编码）。
List<int> _tightLength(int n) => n <= 0x7F
    ? [n]
    : n <= 0x3FFF
    ? [0x80 | (n & 0x7F), n >> 7]
    : [0x80 | (n & 0x7F), 0x80 | ((n >> 7) & 0x7F), n >> 14];

/// 和 Agent 一样：一条持续的 deflate 流，每个矩形 sync flush 一次。
List<int> _deflateRect(RawZLibFilter z, List<int> rgb) {
  z.process(rgb, 0, rgb.length);
  final out = <int>[];
  List<int>? c;
  while ((c = z.processed(flush: true)) != null) {
    out.addAll(c!);
  }
  return out;
}

void main() {
  // 真 JPEG 解码要用引擎的 codec。
  TestWidgetsFlutterBinding.ensureInitialized();

  // ── 假 Agent 的完整字节流 ──
  final serverBytes = Uint8List.fromList([
    // "RFB 003.008\n"
    ...'RFB 003.008\n'.codeUnits,
    // 1 个安全类型：None
    0x01, 0x01,
    // SecurityResult OK
    0x00, 0x00, 0x00, 0x00,
    // ServerInit: 4×2 framebuffer + 32bpp BGRA truecolour PF + name
    0x00, 0x04, 0x00, 0x02, // width=4 height=2
    32, 24, 0, 1, // depth, bpp, little-endian, truecolour
    0x00, 0xFF, 0x00, 0xFF, 0x00, 0xFF, // r/g/b max = 255 (BE)
    16, 8, 0, // r/g/b shift
    0, 0, 0, // padding
    0x00, 0x00, 0x00, 0x07, ...'MultiCC'.codeUnits,
    // FramebufferUpdate #1：1 个矩形 (x=1,y=1,w=2,h=1) Raw
    0x00, 0x00, 0x00, 0x01,
    0x00, 0x01, 0x00, 0x01, 0x00, 0x02, 0x00, 0x01,
    0x00, 0x00, 0x00, 0x00, // encoding = Raw
    0x11, 0x22, 0x33, 0xFF, 0xAA, 0xBB, 0xCC, 0xDD, // 2×1 BGRA
    // FramebufferUpdate #2：空保活（n=0，静止画面）
    0x00, 0x00, 0x00, 0x00,
  ]);

  int frameAt(Uint8List fb, int x, int y, int w) => (y * w + x) * 4;

  Future<void> pumpUntil(bool Function() test, [Duration limit = const Duration(seconds: 2)]) async {
    final deadline = DateTime.now().add(limit);
    while (!test()) {
      if (DateTime.now().isAfter(deadline)) fail('condition not met in time');
      await Future<void>.delayed(const Duration(milliseconds: 5));
    }
  }

  ({RemoteScreenRfb rfb, StreamController<Uint8List> incoming}) makeRfb(
    List<Uint8List> sent,
    void Function() onFrame,
  ) {
    final incoming = StreamController<Uint8List>();
    final rfb = RemoteScreenRfb(
      incoming: incoming.stream,
      send: sent.add,
      onFrame: onFrame,
    );
    return (rfb: rfb, incoming: incoming);
  }

  test('静默判死：握手后一个字节都不来 → 会话关闭交给上层重连（半开连接）', () async {
    final incoming = StreamController<Uint8List>();
    addTearDown(incoming.close);
    var closed = false;
    final rfb = RemoteScreenRfb(
      incoming: incoming.stream,
      send: (_) {},
      onClosed: () => closed = true,
      stallTimeout: const Duration(milliseconds: 120),
    );
    final done = rfb.run().then((_) => 'ok', onError: (Object _) => 'error');
    incoming.add(Uint8List.sublistView(serverBytes, 0, 49)); // 只有握手
    await pumpUntil(() => rfb.width == 4);
    expect(closed, isFalse);
    await pumpUntil(() => closed);
    expect(await done, 'error');
  });

  test('慢而活着不误杀：大更新在弱隧道上爬了好几个阈值也照常收完', () async {
    final incoming = StreamController<Uint8List>();
    addTearDown(incoming.close);
    var closed = false;
    final rfb = RemoteScreenRfb(
      incoming: incoming.stream,
      send: (_) {},
      onClosed: () => closed = true,
      stallTimeout: const Duration(milliseconds: 150),
    );
    unawaited(rfb.run().catchError((Object _) {}));
    incoming.add(Uint8List.sublistView(serverBytes, 0, 49));
    await pumpUntil(() => rfb.width == 4);
    final before = rfb.frameVersion;
    // 4×2 整屏 Raw：4 + 12 + 32 字节，每 60ms 只到 4 字节，总共约 720ms。
    final update = Uint8List.fromList([
      0,
      0,
      0,
      1,
      0,
      0,
      0,
      0,
      0,
      4,
      0,
      2,
      0,
      0,
      0,
      0,
      ...List<int>.filled(32, 0x5A),
    ]);
    final started = DateTime.now();
    for (var i = 0; i < update.length; i += 4) {
      incoming.add(Uint8List.sublistView(update, i, i + 4));
      await Future<void>.delayed(const Duration(milliseconds: 60));
    }
    expect(
      DateTime.now().difference(started),
      greaterThan(const Duration(milliseconds: 600)),
    );
    expect(closed, isFalse, reason: '一直有字节在到，不是静默');
    await pumpUntil(() => rfb.frameVersion > before);
    expect(rfb.framebuffer![0], 0x5A);
    // 收完之后真静默了，照样判死。
    await pumpUntil(() => closed);
  });

  test('握手 + 矩形应用 + 空保活后继续请求', () async {
    final sent = <Uint8List>[];
    var frames = 0;
    final made = makeRfb(sent, () => frames++);
    final done = expectLater(made.rfb.run(), throwsStateError);

    made.incoming.add(serverBytes);
    // 2 次 update（真帧 + 空保活）都到货后才继续断言。
    await pumpUntil(() => frames >= 2 && made.rfb.frameVersion >= 2);

    expect(made.rfb.width, 4);
    expect(made.rfb.height, 2);
    final fb = made.rfb.framebuffer!;
    // 矩形 (1,1,2,1) 应用在正确位置，其余像素不动。
    final at = frameAt(fb, 1, 1, 4);
    expect(fb[at], 0x11);
    expect(fb[at + 1], 0x22);
    expect(fb[at + 2], 0x33);
    expect(fb[at + 3], 0xFF);
    expect(fb[at + 4], 0xAA);
    expect(fb[at + 7], 0xDD);
    expect(fb[frameAt(fb, 0, 0, 4)], 0x00);
    expect(fb[frameAt(fb, 3, 0, 4) + 3], 0x00);

    // 客户端侧字节：版本串 → None → ClientInit → SetEncodings → 全量请求 →
    // 每个 update（含空保活）之后一个 incremental 请求，共 3 个 request。
    final flat = Uint8List.fromList(sent.expand((b) => b).toList());
    final hello = Uint8List.fromList('RFB 003.008\n'.codeUnits);
    expect(Uint8List.sublistView(flat, 0, 12), hello);
    expect(flat[12], 0x01); // security type None
    expect(flat[13], 0x00); // ClientInit
    // SetEncodings: Tight(7) + JPEG 质量 6（-32+6=-26）。不声明 DesktopSize
    // （留在 logical/2，坐标映射不变）也不声明 Cursor（指针留在画面里）。
    expect(Uint8List.sublistView(flat, 14, 26), [
      2, 0, 0, 2,
      0, 0, 0, 7,
      0xFF, 0xFF, 0xFF, 0xE6,
    ]);
    // request #1（全量）: [3,0,pad4,be16(4),be16(2)]
    final req1 = Uint8List.sublistView(flat, 26, 36);
    expect(req1, [3, 0, 0, 0, 0, 0, 0x00, 0x04, 0x00, 0x02]);
    // request #2/#3（incremental）与 #1 只差 incremental 位。
    final req2 = Uint8List.sublistView(flat, 36, 46);
    final req3 = Uint8List.sublistView(flat, 46, 56);
    expect(req2, [3, 1, 0, 0, 0, 0, 0x00, 0x04, 0x00, 0x02]);
    expect(req3, req2);
    expect(flat.length, 56);

    made.incoming.close(); // 关流 → run() 以 rfb-connection-closed 收场
    await done;
  });

  test('WS 分段与 RFB 消息边界错开时仍重组正确', () async {
    for (final slice in [1, 3, 7, 37]) {
      final sent = <Uint8List>[];
      var frames = 0;
      final made = makeRfb(sent, () => frames++);
      final done = expectLater(made.rfb.run(), throwsStateError);

      for (var i = 0; i < serverBytes.length; i += slice) {
        final end = (i + slice > serverBytes.length) ? serverBytes.length : i + slice;
        made.incoming.add(Uint8List.sublistView(serverBytes, i, end));
        await Future<void>.delayed(Duration.zero);
      }
      await pumpUntil(() => frames >= 2 && made.rfb.frameVersion >= 2);

      final fb = made.rfb.framebuffer!;
      final at = frameAt(fb, 1, 1, 4);
      expect(fb[at], 0x11, reason: 'slice=$slice');
      expect(fb[at + 4], 0xAA, reason: 'slice=$slice');
      expect(fb[frameAt(fb, 2, 0, 4)], 0x00, reason: 'slice=$slice');

      made.incoming.close();
      await done;
    }
  });

  test('PointerEvent / KeyEvent / typeText / chord 的线上编码', () async {
    final sent = <Uint8List>[];
    final made = makeRfb(sent, () {});
    made.rfb.width = 4;
    made.rfb.height = 2;

    made.rfb.pointerEvent(1, 300, 700);
    made.rfb.keyEvent(true, 0xFF0D);
    made.rfb.typeText('中');
    made.rfb.chord([RfbKeysyms.cmdL], 0x63); // cmd+c

    expect(sent[0], [5, 0x01, 0x01, 0x2C, 0x02, 0xBC]);
    expect(sent[1], [4, 1, 0, 0, 0x00, 0x00, 0xFF, 0x0D]);
    // '中' = U+4E2D → down/up 两条 KeyEvent。
    expect(sent[2], [4, 1, 0, 0, 0x00, 0x00, 0x4E, 0x2D]);
    expect(sent[3], [4, 0, 0, 0, 0x00, 0x00, 0x4E, 0x2D]);
    // chord: cmd down → c down → c up → cmd up。
    expect(sent[4], [4, 1, 0, 0, 0x00, 0x00, 0xFF, 0xE7]);
    expect(sent[5], [4, 1, 0, 0, 0x00, 0x00, 0x00, 0x63]);
    expect(sent[6], [4, 0, 0, 0, 0x00, 0x00, 0x00, 0x63]);
    expect(sent[7], [4, 0, 0, 0, 0x00, 0x00, 0xFF, 0xE7]);
  });

  test('非 RFB 服务端 / 不支持的编码（Hextile）都会切断', () async {
    final made1 = makeRfb(<Uint8List>[], () {});
    made1.incoming.add(Uint8List.fromList('HTTP/1.1 200'.codeUnits));
    await expectLater(made1.rfb.run(), throwsStateError);
    await made1.incoming.close();

    // 握手成功后给一个 enc=1（Hextile）矩形 → 不支持即断。
    final sent = <Uint8List>[];
    final made2 = makeRfb(sent, () {});
    final done = expectLater(made2.rfb.run(), throwsStateError);
    made2.incoming.add(serverBytes);
    await pumpUntil(() => made2.rfb.frameVersion >= 1);
    made2.incoming.add(Uint8List.fromList([
      0x00, 0x00, 0x00, 0x01,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01,
      0x00, 0x00, 0x00, 0x01, // encoding = 1 → unsupported
    ]));
    await done;
    await made2.incoming.close();
  });
  test('jpegQuality: null → 不发 SetEncodings，只走 Raw（兼容旧行为）', () async {
    final sent = <Uint8List>[];
    final incoming = StreamController<Uint8List>();
    addTearDown(incoming.close);
    final rfb = RemoteScreenRfb(
      incoming: incoming.stream,
      send: sent.add,
      jpegQuality: null,
    );
    unawaited(rfb.run().catchError((Object _) {}));
    incoming.add(Uint8List.sublistView(serverBytes, 0, 49));
    await pumpUntil(() => sent.length >= 4);
    expect(sent[3][0], 3, reason: 'ClientInit 之后直接是 FramebufferUpdateRequest');
  });

  test('Tight：fill / 不足 12 字节原样 RGB / zlib 跨矩形共用一条流', () async {
    final made = makeRfb(<Uint8List>[], () {});
    unawaited(made.rfb.run().catchError((Object _) {}));
    made.incoming.add(Uint8List.sublistView(serverBytes, 0, 49));
    await pumpUntil(() => made.rfb.width == 4);

    // update 1：整行 fill + 一个像素的原样 RGB（3 字节 < 12，不进 zlib）。
    made.incoming.add(Uint8List.fromList([
      0, 0, 0, 2,
      ..._rect(0, 0, 4, 1, 7), 0x80, 0x10, 0x20, 0x30,
      ..._rect(3, 1, 1, 1, 7), 0x00, 0x40, 0x50, 0x60,
    ]));
    await pumpUntil(() => made.rfb.frameVersion >= 1);
    final fb = made.rfb.framebuffer!;
    for (var x = 0; x < 4; x++) {
      final at = frameAt(fb, x, 0, 4);
      expect(fb.sublist(at, at + 4), [0x30, 0x20, 0x10, 0xFF],
          reason: 'fill 是 R,G,B → BGRA，x=$x');
    }
    final one = frameAt(fb, 3, 1, 4);
    expect(fb.sublist(one, one + 4), [0x60, 0x50, 0x40, 0xFF]);

    // update 2/3：两个 zlib 矩形，同一条持续 deflate 流。第二个内容相同，
    // 只有靠前一块的字典才解得出来 —— 每块新建解压器会在这里失败。
    final deflater = RawZLibFilter.deflateFilter(level: 6);
    final row = [for (var i = 0; i < 4; i++) ...[0xA0 + i, 0xB0 + i, 0xC0 + i]];
    final z1 = _deflateRect(deflater, row);
    final z2 = _deflateRect(deflater, row);
    made.incoming.add(Uint8List.fromList([
      0, 0, 0, 1,
      ..._rect(0, 1, 4, 1, 7), 0x00, ..._tightLength(z1.length), ...z1,
    ]));
    await pumpUntil(() => made.rfb.frameVersion >= 2);
    made.incoming.add(Uint8List.fromList([
      0, 0, 0, 1,
      ..._rect(0, 0, 4, 1, 7), 0x00, ..._tightLength(z2.length), ...z2,
    ]));
    await pumpUntil(() => made.rfb.frameVersion >= 3);
    for (final y in [0, 1]) {
      for (var x = 0; x < 4; x++) {
        final at = frameAt(fb, x, y, 4);
        expect(fb.sublist(at, at + 4), [0xC0 + x, 0xB0 + x, 0xA0 + x, 0xFF],
            reason: 'zlib 行 y=$y x=$x');
      }
    }
  });

  test('Tight JPEG：真 JPEG 经引擎解码后按 BGRA 写进帧缓冲', () async {
    final hello = BytesBuilder()
      ..add(Uint8List.sublistView(serverBytes, 0, 18))
      ..add([0x00, 0x10, 0x00, 0x08]) // ServerInit 宽高 → 16×8
      ..add(Uint8List.sublistView(serverBytes, 22, 49));
    final jpeg = base64Decode(_redBlueJpeg);
    final made = makeRfb(<Uint8List>[], () {});
    unawaited(made.rfb.run().catchError((Object _) {}));
    made.incoming.add(hello.takeBytes());
    await pumpUntil(() => made.rfb.width == 16);
    made.incoming.add(Uint8List.fromList([
      0, 0, 0, 1,
      ..._rect(0, 0, 16, 8, 7), 0x90, ..._tightLength(jpeg.length), ...jpeg,
    ]));
    await pumpUntil(
      () => made.rfb.frameVersion >= 1,
      const Duration(seconds: 5),
    );
    final fb = made.rfb.framebuffer!;
    void near(int x, int y, List<int> bgr) {
      final at = frameAt(fb, x, y, 16);
      for (var i = 0; i < 3; i++) {
        expect((fb[at + i] - bgr[i]).abs(), lessThan(40),
            reason: '($x,$y) 通道 $i = ${fb[at + i]}，应接近 ${bgr[i]}');
      }
      expect(fb[at + 3], 0xFF);
    }

    near(2, 4, [0, 0, 255]); // 左半红：BGRA 里 R 在第 3 个字节
    near(13, 4, [255, 0, 0]); // 右半蓝
  });

  test('Tight JPEG 解不出来 → 会话切断交给上层，而不是卡住', () async {
    var closed = false;
    final incoming = StreamController<Uint8List>();
    addTearDown(incoming.close);
    final rfb = RemoteScreenRfb(
      incoming: incoming.stream,
      send: (_) {},
      onClosed: () => closed = true,
    );
    final done = rfb.run().then((_) => 'ok', onError: (Object _) => 'error');
    incoming.add(Uint8List.sublistView(serverBytes, 0, 49));
    await pumpUntil(() => rfb.width == 4);
    incoming.add(Uint8List.fromList([
      0, 0, 0, 1,
      ..._rect(0, 0, 4, 2, 7), 0x90, 5, 1, 2, 3, 4, 5, // 不是 JPEG
    ]));
    // 要当场报错，不能靠 12 秒的静默判死来兜底。
    expect(
      await done.timeout(const Duration(seconds: 2), onTimeout: () => 'hung'),
      'error',
    );
    expect(closed, isTrue);
  });
}
