import 'dart:async';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:multicc_app/services/remote_screen_rfb.dart';

/// RemoteScreenRfb 协议层单测：用一个内存 StreamController 扮演 Agent 的
/// rfb.sock（MultiCCAgent.swift 的 RFB 段），重点钉住三件事——
/// 1) 握手/ServerInit/矩形应用的字节序与位置；
/// 2) WS 帧不与 RFB 消息对齐时 _ChunkedReader 的流重组（任意切段结果一致）；
/// 3) 空保活 update（n=0）之后继续 re-arm incremental request（静止画面
///    不断流的客户端侧前提，见 Swift 端 servedAny 修复）。
void main() {
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

    // 客户端侧字节：版本串 → None → ClientInit → 全量请求 → 每个 update（含
    // 空保活）之后一个 incremental 请求，共 3 个 request。
    final flat = Uint8List.fromList(sent.expand((b) => b).toList());
    final hello = Uint8List.fromList('RFB 003.008\n'.codeUnits);
    expect(Uint8List.sublistView(flat, 0, 12), hello);
    expect(flat[12], 0x01); // security type None
    expect(flat[13], 0x00); // ClientInit
    // request #1（全量）: [3,0,pad4,be16(4),be16(2)]
    final req1 = Uint8List.sublistView(flat, 14, 24);
    expect(req1, [3, 0, 0, 0, 0, 0, 0x00, 0x04, 0x00, 0x02]);
    // request #2/#3（incremental）与 #1 只差 incremental 位。
    final req2 = Uint8List.sublistView(flat, 24, 34);
    final req3 = Uint8List.sublistView(flat, 34, 44);
    expect(req2, [3, 1, 0, 0, 0, 0, 0x00, 0x04, 0x00, 0x02]);
    expect(req3, req2);
    expect(flat.length, 44);

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

  test('非 RFB 服务端 / 非 Raw 编码都会切断', () async {
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
}
