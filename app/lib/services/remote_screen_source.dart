import 'dart:typed_data';

/// 「🖥 屏幕」活流源的公共面：几何、最新一帧的 BGRA 字节，以及 RFB 输入事件。
///
/// 两条活流都满足它：
///   · [RemoteScreenRfb]   —— 原版 RFB 3.8（Agent 的 rfb.sock，逐像素更新）
///   · [RemoteScreenH264]  —— 高清流畅模式（Agent 的 h264.sock，H.264，
///     由平台解码器解成 BGRA，帧格式与 RFB 一样是 4 字节/像素）
///
/// 屏幕页只认这个接口：投影、坐标换算、点击/键盘都走同一套代码，所以以后再加
/// 一种编码（AV1 等）不用碰页面。
abstract interface class ScreenSource {
  int get width;
  int get height;

  /// BGRA 字节，width × height × 4；还没出帧时为 null。
  Uint8List? get framebuffer;

  void pointerEvent(int mask, int x, int y);
  void keyEvent(bool down, int keysym);
  void typeText(String text);
  void chord(List<int> modifierKeysyms, int keysym);
}

/// RFB 输入编码（键鼠事件是 RFB 协议的一部分，H.264 模式复用 Agent 的同一个
/// rfbPointer/rfbKey 入口，所以两种模式发的是完全相同的字节）。
///
/// 与 MultiCCAgent.swift 的 RFB 段一致：
///   PointerEvent [5][mask u8][x be16][y be16]
///   KeyEvent     [4][down u8][pad u16][keysym be32]
mixin ScreenInputMixin implements ScreenSource {
  /// 把一段编码好的 RFB 客户端消息写给 Agent。
  void sendInput(Uint8List bytes);

  /// Mask bits follow RFB: left 1, middle 2, right 4, wheel-up 8, wheel-down
  /// 16. The Agent turns transitions into click/drag/scroll ops itself.
  @override
  void pointerEvent(int mask, int x, int y) {
    final m = Uint8List(6);
    m[0] = 5;
    m[1] = mask & 0xFF;
    _be16(m, 2, x.clamp(0, 0xFFFF));
    _be16(m, 4, y.clamp(0, 0xFFFF));
    sendInput(m);
  }

  /// Modifier keysyms are tracked Agent-side; printable keysyms become
  /// unicode type events, anything with ctrl/cmd/alt becomes a chord.
  @override
  void keyEvent(bool down, int keysym) {
    final m = Uint8List(8);
    m[0] = 4;
    m[1] = down ? 1 : 0;
    _be32(m, 4, keysym);
    sendInput(m);
  }

  /// Types text key-by-key (down+up per code point). CJK code points work:
  /// the Agent posts them as unicode events, not through an IME.
  ///
  /// Every code point above 0xFF is tagged (0x01000000 | cp). Untagged values
  /// in 0xFE00…0xFFFF are function keys on the Agent, so a raw fullwidth
  /// character used to press one: "（" (U+FF08) was BackSpace, "）" (U+FF09)
  /// Tab, "－" (U+FF0D) Return, "；" (U+FF1B) Esc. Newline/tab go out as
  /// Return/Tab, matching the Web client and CONTRACT §4.
  @override
  void typeText(String text) {
    // "\r\n" (pasted Windows text) is one line break, not two Returns.
    for (final codePoint in text.replaceAll('\r\n', '\n').runes) {
      final keysym = keysymForText(codePoint);
      keyEvent(true, keysym);
      keyEvent(false, keysym);
    }
  }

  /// Sends a key chord like cmd+c as press/release pairs in order.
  @override
  void chord(List<int> modifierKeysyms, int keysym) {
    for (final mod in modifierKeysyms) {
      keyEvent(true, mod);
    }
    keyEvent(true, keysym);
    keyEvent(false, keysym);
    for (final mod in modifierKeysyms.reversed) {
      keyEvent(false, mod);
    }
  }
}

/// A printable code point as an X11 keysym. Codepoints above 0xFF must be
/// tagged, otherwise they fall into the X11 function-key range (0xFE00–0xFFFF)
/// and are executed as keys instead of typed as text. Newline and tab are sent
/// as Return and Tab.
int keysymForText(int codePoint) {
  if (codePoint == 0x0A || codePoint == 0x0D) return 0xFF0D; // Return
  if (codePoint == 0x09) return 0xFF09; // Tab
  return codePoint > 0xFF ? 0x01000000 | codePoint : codePoint;
}

void _be16(Uint8List m, int at, int v) {
  m[at] = (v >> 8) & 0xFF;
  m[at + 1] = v & 0xFF;
}

void _be32(Uint8List m, int at, int v) {
  m[at] = (v >> 24) & 0xFF;
  m[at + 1] = (v >> 16) & 0xFF;
  m[at + 2] = (v >> 8) & 0xFF;
  m[at + 3] = v & 0xFF;
}
