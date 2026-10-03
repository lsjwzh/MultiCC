// 「🖥 屏幕」App 端：直连 /ws/remote-screen 讲最小 RFB 3.8（RemoteScreenRfb），
// 断流/旧 Agent 自动回退 JPEG 轮询（RemoteScreenService）。只看/可操作、
// 长按右键、滚轮脉冲、键盘条（文字 + 功能键/快捷键和弦）与 Esc 急停的
// 「解除急停」都对着 Web 版 public/chat-remote-screen.js 的语义。
import 'dart:async';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';

import '../i18n.dart';
import '../services/remote_screen_rfb.dart';
import '../services/remote_screen_service.dart';
import '../services/settings_service.dart';

/// 键盘条的功能键/快捷键：[label, spec]。spec 里 `+` 分段，修饰键映射成
/// RFB keysym，其余段按单字符或命名键解析 —— 与 Web 版 KEYS 表一致。
const List<List<String>> _keyBarSpecs = [
  ['⏎', 'return'],
  ['Esc', 'escape'],
  ['Tab', 'tab'],
  ['⌫', 'backspace'],
  ['Space', 'space'],
  ['←', 'left'],
  ['↑', 'up'],
  ['↓', 'down'],
  ['→', 'right'],
  ['⌘A', 'cmd+a'],
  ['⌘C', 'cmd+c'],
  ['⌘V', 'cmd+v'],
  ['⌘Z', 'cmd+z'],
  ['⌘Tab', 'cmd+tab'],
  ['⌘W', 'cmd+w'],
];

const Map<String, int> _namedKeysyms = {
  'return': RfbKeysyms.enter,
  'enter': RfbKeysyms.enter,
  'escape': RfbKeysyms.escape,
  'esc': RfbKeysyms.escape,
  'tab': RfbKeysyms.tab,
  'backspace': RfbKeysyms.backspace,
  'delete': RfbKeysyms.delete,
  'space': 0x20,
  'left': RfbKeysyms.left,
  'up': RfbKeysyms.up,
  'down': RfbKeysyms.down,
  'right': RfbKeysyms.right,
};

const Map<String, int> _modifierKeysyms = {
  'shift': RfbKeysyms.shiftL,
  'ctrl': RfbKeysyms.ctrlL,
  'control': RfbKeysyms.ctrlL,
  'alt': RfbKeysyms.altL,
  'option': RfbKeysyms.altL,
  'cmd': RfbKeysyms.cmdL,
  'command': RfbKeysyms.cmdL,
  'meta': RfbKeysyms.cmdL,
};

class RemoteScreenScreen extends StatefulWidget {
  const RemoteScreenScreen({super.key, required this.settings});

  final SettingsService settings;

  @override
  State<RemoteScreenScreen> createState() => _RemoteScreenScreenState();
}

class _RemoteScreenScreenState extends State<RemoteScreenScreen> {
  late final RemoteScreenService _svc;
  StreamSubscription<void>? _frameSub;
  StreamSubscription<void>? _modeSub;

  ui.Image? _image;
  bool _decoding = false;
  double? _fps;

  bool _control = false;
  bool _hadControl = false;
  bool _halted = false;
  String? _statusErr;
  Timer? _haltTimer;
  Timer? _longPress;
  int _lastX = 0;
  int _lastY = 0;
  DateTime _lastMoveSent = DateTime.fromMillisecondsSinceEpoch(0);
  final TextEditingController _textCtrl = TextEditingController();

  @override
  void initState() {
    super.initState();
    _svc = RemoteScreenService(settings: widget.settings);
    _modeSub = _svc.onModeChange.listen((_) {
      if (mounted) setState(() {});
    });
    _frameSub = _svc.onFrame.listen((_) => _renderFrame());
    _svc.connectLive();
  }

  @override
  void dispose() {
    _haltTimer?.cancel();
    _longPress?.cancel();
    _frameSub?.cancel();
    _modeSub?.cancel();
    _textCtrl.dispose();
    _image?.dispose();
    _image = null;
    // 曾经拿过操作租约就先交还再拆传输（inputOp 自带超时，dispose 终会落地）。
    if (_hadControl) {
      unawaited(
        _svc.inputOp({'op': 'release'}).whenComplete(() => _svc.dispose()),
      );
    } else {
      _svc.dispose();
    }
    super.dispose();
  }

  // ── 帧渲染 ──
  void _renderFrame() {
    final rfb = _svc.rfb;
    final fb = rfb?.framebuffer;
    if (fb == null || rfb == null || rfb.width <= 0) {
      if (mounted) setState(() {});
      return;
    }
    final now = DateTime.now();
    if (_lastFrameAt != null) {
      final dt = now.difference(_lastFrameAt!).inMicroseconds / 1e6;
      if (dt > 0.01 && dt < 5) {
        final inst = 1 / dt;
        _fps = _fps == null ? inst : _fps! * 0.7 + inst * 0.3;
      }
    }
    _lastFrameAt = now;
    if (_decoding) return; // 上一帧还在解码，跳过；下个 update 会再触发
    _decoding = true;
    final w = rfb.width, h = rfb.height;
    // BGRA → RGBA：32bit 上 R/B 互换，A/G 原位。
    final src = Uint32List.view(fb.buffer, fb.offsetInBytes, fb.lengthInBytes ~/ 4);
    final rgba = Uint8List(src.length * 4);
    final dst = Uint32List.view(rgba.buffer, 0, src.length);
    for (var i = 0; i < src.length; i++) {
      final v = src[i];
      dst[i] = (v & 0xFF00FF00) | ((v >> 16) & 0xFF) | ((v & 0xFF) << 16);
    }
    ui.decodeImageFromPixels(rgba, w, h, ui.PixelFormat.rgba8888, (img) {
      _decoding = false;
      if (!mounted) {
        img.dispose();
        return;
      }
      setState(() {
        _image?.dispose();
        _image = img;
      });
    });
  }

  DateTime? _lastFrameAt;

  // ── 操作开关 ──
  void _setControl(bool on) {
    setState(() => _control = on);
    if (on) {
      _hadControl = true;
      _startHaltPoll();
    } else {
      _haltTimer?.cancel();
      _haltTimer = null;
      _longPress?.cancel();
      _longPress = null;
    }
  }

  // RFB 无错误通道：可操作时每 3s 查一次状态，Esc 急停就亮「解除急停」。
  void _startHaltPoll() {
    _haltTimer?.cancel();
    _haltTimer = Timer.periodic(const Duration(seconds: 3), (_) async {
      if (!_control || _svc.mode != RemoteScreenMode.live) return;
      final res = await _svc.inputOp({'op': 'status'});
      final ctl = res['control'];
      final halted = ctl is Map && ctl['halted'] == true;
      if (mounted && halted != _halted) setState(() => _halted = halted);
    });
  }

  Future<void> _unhalt() async {
    final res = await _svc.inputOp({'op': 'resume'});
    if (!mounted) return;
    if (res['ok'] == false) {
      _showErr(res);
    } else {
      setState(() => _halted = false);
    }
  }

  void _showErr(Map<String, dynamic> res) {
    const codeKeys = {
      'screen-locked': 'rsErrLocked',
      'user-stopped': 'rsErrStopped',
      'busy': 'rsErrBusy',
      'protected-app': 'rsErrProtected',
      'agent-unreachable': 'rsErrAgent',
    };
    final code = res['error']?.toString();
    setState(() {
      _statusErr = code != null && codeKeys.containsKey(code)
          ? t(codeKeys[code]!)
          : (res['message']?.toString()) ?? t('rsErrUnknown');
    });
  }

  // ── 指针（仅流畅模式）──
  void _sendPointer(int mask, double dx, double dy, double dw, double dh) {
    final rfb = _svc.rfb;
    if (rfb == null || rfb.width <= 0 || dw <= 0 || dh <= 0) return;
    _lastX = ((dx / dw) * rfb.width).round().clamp(0, rfb.width - 1);
    _lastY = ((dy / dh) * rfb.height).round().clamp(0, rfb.height - 1);
    rfb.pointerEvent(mask, _lastX, _lastY);
  }

  void _onPointerDown(PointerDownEvent e, double dw, double dh) {
    if (!_control) return;
    _longPress?.cancel();
    // 长按 450ms = 右键（Agent 端 mask 4→0 沿触发 click right）。
    _longPress = Timer(const Duration(milliseconds: 450), () {
      _sendPointer(4, e.localPosition.dx, e.localPosition.dy, dw, dh);
      _sendPointer(0, e.localPosition.dx, e.localPosition.dy, dw, dh);
    });
    _sendPointer(1, e.localPosition.dx, e.localPosition.dy, dw, dh);
  }

  void _onPointerMove(PointerMoveEvent e, double dw, double dh) {
    if (!_control || e.buttons == 0) return;
    final now = DateTime.now();
    if (now.difference(_lastMoveSent).inMilliseconds < 30) return;
    _lastMoveSent = now;
    _longPress?.cancel(); // 拖动不是右键
    _sendPointer(1, e.localPosition.dx, e.localPosition.dy, dw, dh);
  }

  void _onPointerUp(PointerEvent e, double dw, double dh) {
    if (!_control) return;
    _longPress?.cancel();
    _longPress = null;
    _sendPointer(0, e.localPosition.dx, e.localPosition.dy, dw, dh);
  }

  void _wheelPulse(int mask) {
    final rfb = _svc.rfb;
    if (rfb == null || !_control) return;
    rfb.pointerEvent(mask, _lastX, _lastY);
  }

  // ── 兼容模式点按（走 HTTP，坐标按 contain 换算）──
  Future<void> _fallbackTap(Offset local, double dw, double dh) async {
    if (!_control) return;
    final w = _svc.fallbackWidth, h = _svc.fallbackHeight;
    if (w <= 0 || h <= 0 || dw <= 0 || dh <= 0) return;
    final x = ((local.dx / dw) * w).round().clamp(0, w - 1);
    final y = ((local.dy / dh) * h).round().clamp(0, h - 1);
    final res = await _svc.inputOp({'op': 'click', 'x': x, 'y': y});
    if (mounted && res['ok'] == false) _showErr(res);
  }

  // ── 键盘条 ──
  Future<void> _sendText() async {
    final text = _textCtrl.text;
    if (text.isEmpty) return;
    if (_svc.mode == RemoteScreenMode.live) {
      _svc.rfb?.typeText(text);
      _textCtrl.clear();
      return;
    }
    final res = await _svc.inputOp({'op': 'type', 'text': text});
    if (!mounted) return;
    if (res['ok'] == false) {
      _showErr(res);
    } else {
      _textCtrl.clear();
    }
  }

  Future<void> _pressSpec(String spec) async {
    if (!_control) return;
    if (_svc.mode != RemoteScreenMode.live) {
      final res = await _svc.inputOp({'op': 'press', 'keys': spec});
      if (mounted && res['ok'] == false) _showErr(res);
      return;
    }
    final rfb = _svc.rfb;
    if (rfb == null) return;
    final mods = <int>[];
    var keysym = -1;
    for (final part in spec.split('+')) {
      final mod = _modifierKeysyms[part.toLowerCase()];
      if (mod != null) {
        mods.add(mod);
        continue;
      }
      final named = _namedKeysyms[part.toLowerCase()];
      if (named != null) {
        keysym = named;
      } else if (part.length == 1) {
        keysym = part.runes.first;
      }
    }
    if (keysym < 0) return;
    if (mods.isEmpty) {
      rfb.keyEvent(true, keysym);
      rfb.keyEvent(false, keysym);
    } else {
      rfb.chord(mods, keysym);
    }
  }

  // ── UI ──
  String get _modeLabel {
    switch (_svc.mode) {
      case RemoteScreenMode.connecting:
        return t('rsConnecting');
      case RemoteScreenMode.live:
        return t('rsLiveMode');
      case RemoteScreenMode.fallback:
        return t('rsFallback');
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFF10141c),
      appBar: AppBar(
        backgroundColor: const Color(0xFF161b26),
        foregroundColor: const Color(0xFFdce6f1),
        title: Text('🖥 ${t('rsTitle')}'),
        actions: [
          // 兼容模式下留一个手动重试流畅模式的口子（连接失败 8s 后自动降级一次）。
          if (_svc.mode == RemoteScreenMode.fallback)
            IconButton(
              icon: const Icon(Icons.bolt_rounded),
              tooltip: t('retry'),
              onPressed: () => _svc.connectLive(),
            ),
          IconButton(
            icon: Icon(
              _control ? Icons.mouse_rounded : Icons.visibility_outlined,
            ),
            tooltip: t('rsModeTitle'),
            color: _control ? const Color(0xFF2ba67a) : null,
            onPressed: () => _setControl(!_control),
          ),
        ],
      ),
      body: SafeArea(
        child: Column(
          children: [
            _statusRow(),
            if (_halted) _haltBanner(),
            Expanded(child: _stage()),
            if (_control) _keyBar(),
          ],
        ),
      ),
    );
  }

  Widget _statusRow() {
    final rfb = _svc.rfb;
    final w = _svc.mode == RemoteScreenMode.live
        ? rfb?.width ?? 0
        : _svc.fallbackWidth;
    final h = _svc.mode == RemoteScreenMode.live
        ? rfb?.height ?? 0
        : _svc.fallbackHeight;
    final bits = <String>[
      if (w > 0 && h > 0) '$w×$h',
      _modeLabel,
      if (_svc.mode == RemoteScreenMode.live &&
          _fps != null &&
          _statusErr == null)
        t('rsFps', {'fps': _fps!.toStringAsFixed(1)}),
      if (_statusErr != null) _statusErr!,
    ];
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      color: const Color(0xFF161b26),
      child: Text(
        bits.join('  ·  '),
        maxLines: 2,
        overflow: TextOverflow.ellipsis,
        style: TextStyle(
          fontSize: 11.5,
          color: _statusErr == null
              ? const Color(0xFF8a9aab)
              : const Color(0xFFe07a7a),
        ),
      ),
    );
  }

  Widget _haltBanner() {
    return Container(
      width: double.infinity,
      color: const Color(0xFF5a2b2b),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
      child: Row(
        children: [
          Expanded(
            child: Text(
              t('rsErrStopped'),
              style: const TextStyle(fontSize: 12, color: Color(0xFFf0d7d7)),
            ),
          ),
          TextButton(
            onPressed: _unhalt,
            child: Text(t('rsUnhalt')),
          ),
        ],
      ),
    );
  }

  Widget _stage() {
    if (_svc.mode == RemoteScreenMode.live) {
      final img = _image;
      final rfb = _svc.rfb;
      if (img == null || rfb == null || rfb.width <= 0) {
        return const Center(child: CircularProgressIndicator());
      }
      return LayoutBuilder(
        builder: (context, constraints) {
          final size = constraints.biggest;
          final scale = size.width / rfb.width < size.height / rfb.height
              ? size.width / rfb.width
              : size.height / rfb.height;
          final dw = rfb.width * scale, dh = rfb.height * scale;
          return Center(
            child: SizedBox(
              width: dw,
              height: dh,
              child: Listener(
                onPointerDown: (e) => _onPointerDown(e, dw, dh),
                onPointerMove: (e) => _onPointerMove(e, dw, dh),
                onPointerUp: (e) => _onPointerUp(e, dw, dh),
                onPointerCancel: (e) => _onPointerUp(e, dw, dh),
                child: CustomPaint(
                  painter: _ScreenPainter(img),
                  size: Size.infinite,
                ),
              ),
            ),
          );
        },
      );
    }
    // 兼容模式：JPEG 轮询 + 点按（长按右键/拖动只在流畅模式提供）。
    final jpeg = _svc.fallbackJpeg;
    if (jpeg == null) {
      return Center(
        child: Text(
          t('rsConnecting'),
          style: const TextStyle(color: Color(0xFF8a9aab), fontSize: 13),
        ),
      );
    }
    return LayoutBuilder(
      builder: (context, constraints) {
        final size = constraints.biggest;
        final w = _svc.fallbackWidth, h = _svc.fallbackHeight;
        final iw = w > 0 ? w.toDouble() : 1470.0;
        final ih = h > 0 ? h.toDouble() : 956.0;
        final scale = size.width / iw < size.height / ih
            ? size.width / iw
            : size.height / ih;
        final dw = iw * scale, dh = ih * scale;
        return Center(
          child: SizedBox(
            width: dw,
            height: dh,
            child: GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTapUp: (e) => _fallbackTap(e.localPosition, dw, dh),
              child: Image.memory(
                jpeg,
                gaplessPlayback: true,
                fit: BoxFit.fill,
              ),
            ),
          ),
        );
      },
    );
  }

  Widget _keyBar() {
    return Container(
      color: const Color(0xFF161b26),
      padding: const EdgeInsets.fromLTRB(8, 6, 8, 6),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            children: [
              Expanded(
                child: TextField(
                  controller: _textCtrl,
                  style: const TextStyle(
                    color: Color(0xFFdce6f1),
                    fontSize: 13,
                  ),
                  decoration: InputDecoration(
                    isDense: true,
                    hintText: t('rsTypePlaceholder'),
                    hintStyle: const TextStyle(
                      color: Color(0xFF8a9aab),
                      fontSize: 12.5,
                    ),
                    filled: true,
                    fillColor: const Color(0xFF10141c),
                    border: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(6),
                      borderSide: const BorderSide(color: Color(0xFF2a3242)),
                    ),
                  ),
                  onSubmitted: (_) => _sendText(),
                ),
              ),
              const SizedBox(width: 6),
              // 滚轮脉冲（Agent 端 mask 8=上 / 16=下，沿即触发）。
              _keyChip('⬆', () => _wheelPulse(0x08)),
              _keyChip('⬇', () => _wheelPulse(0x10)),
              const SizedBox(width: 2),
              FilledButton(
                style: FilledButton.styleFrom(
                  backgroundColor: const Color(0xFF1267b5),
                  padding: const EdgeInsets.symmetric(horizontal: 12),
                  minimumSize: const Size(0, 34),
                ),
                onPressed: _sendText,
                child: Text(t('rsSend'), style: const TextStyle(fontSize: 12.5)),
              ),
            ],
          ),
          const SizedBox(height: 6),
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: Row(
              children: [
                for (final spec in _keyBarSpecs)
                  _keyChip(spec[0], () => _pressSpec(spec[1])),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _keyChip(String label, VoidCallback onTap) {
    return Padding(
      padding: const EdgeInsets.only(right: 4),
      child: OutlinedButton(
        style: OutlinedButton.styleFrom(
          foregroundColor: const Color(0xFFdce6f1),
          side: const BorderSide(color: Color(0xFF2a3242)),
          backgroundColor: const Color(0xFF10141c),
          padding: const EdgeInsets.symmetric(horizontal: 10),
          minimumSize: const Size(0, 34),
        ),
        onPressed: onTap,
        child: Text(label, style: const TextStyle(fontSize: 12.5)),
      ),
    );
  }
}

class _ScreenPainter extends CustomPainter {
  _ScreenPainter(this.image);

  final ui.Image image;

  @override
  void paint(Canvas canvas, Size size) {
    final src = Rect.fromLTWH(
      0,
      0,
      image.width.toDouble(),
      image.height.toDouble(),
    );
    canvas.drawImageRect(image, src, Offset.zero & size, Paint());
  }

  @override
  bool shouldRepaint(_ScreenPainter oldDelegate) =>
      !identical(oldDelegate.image, image);
}
