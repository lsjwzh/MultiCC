// 「🖥 屏幕」App 端：直连 /ws/remote-screen 讲最小 RFB 3.8（RemoteScreenRfb），
// 断流/旧 Agent 自动回退 JPEG 轮询（RemoteScreenService）。只看/可操作、
// 显式「右键」一次性按钮（长按保持为按住拖动）、滚轮脉冲、键盘条（文字 + 功能键/快捷键和弦）与可选 Esc 急停的
// 「解除急停」都对着 Web 版 public/chat-remote-screen.js 的语义。
import 'dart:async';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show HapticFeedback;
import 'package:shared_preferences/shared_preferences.dart';

import '../i18n.dart';
import '../services/remote_screen_rfb.dart';
import '../services/remote_frame_decoder.dart';
import '../services/remote_pointer_queue.dart';
import '../services/remote_screen_region.dart';
import '../services/remote_screen_service.dart';
import '../services/remote_touch_controller.dart';
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
  const RemoteScreenScreen({
    super.key,
    required this.settings,
    this.initialControl = false,
    this.service,
  });

  final SettingsService settings;
  final RemoteScreenService? service;

  /// 聊天里点 `#rs=control` 直达链接进来时直接处于可操作模式（与 Web 一致）。
  final bool initialControl;

  @override
  State<RemoteScreenScreen> createState() => _RemoteScreenScreenState();
}

class _RemoteScreenScreenState extends State<RemoteScreenScreen> {
  late final RemoteScreenService _svc;
  StreamSubscription<void>? _frameSub;
  StreamSubscription<void>? _modeSub;

  ui.Image? _image;
  late final RemoteFrameDecoder _decoder = RemoteFrameDecoder(
    onImage: (image) {
      if (!mounted) {
        image.dispose();
        return;
      }
      final previous = _image;
      setState(() => _image = image);
      // The old painter can still be in the current layer tree until paint.
      if (previous != null) {
        WidgetsBinding.instance.addPostFrameCallback((_) => previous.dispose());
      }
    },
  );
  late final RemotePointerQueue _pointerQueue = RemotePointerQueue((
    body,
  ) async {
    final result = await _svc.inputOp(body);
    if (mounted &&
        result['ok'] == false &&
        !RemotePointerQueue.unsupported(result)) {
      _showErr(result);
    }
    return result;
  });
  double? _fps;

  bool _waking = false;
  Map<String, dynamic> _wakeState = {};
  String? _wakeMessage;
  bool _control = false;
  bool _hadControl = false;
  bool _halted = false;
  String? _statusErr;
  Timer? _haltTimer;
  Timer? _permTimer;
  // 点亮后的下一次轻点按右键发送，用掉即复位（与 Web 版「右键」按钮同语义）。
  // 长按不再等于右键：按住不动再拖是推动/拖拽，右键必须显式点亮。
  bool _rightOnce = false;

  /// 横幅独立于取帧权限门：屏录、辅助功能通过后，急停警告仍须保留。
  Map<String, dynamic>? _permGate;
  bool _permStarted = false;
  bool _permChecking = false;
  bool _permRestarting = false;
  int _permEpoch = 0;
  String? _permResult;
  DateTime? _lastPermCheck;

  /// 服务端明说本平台不支持时的整页收敛态（见 RemoteScreenService
  /// .supportsRemoteScreen）。为真时不去查权限、不连 agent，只显示原因。
  bool _unsupported = false;

  int _lastX = 0;
  int _lastY = 0;
  final TextEditingController _textCtrl = TextEditingController();

  /// 捏合缩放：InteractiveViewer 的变换只改视觉框，Listener 收到的
  /// localPosition 已被 hit-test 逆变换回 contain 布局坐标，所以坐标
  /// 归一化与输入映射零改动（与 Web 版 s.zoomer 同一模型）。
  final TransformationController _xform = TransformationController();
  bool _zoomed = false;
  int _zoomPct = 100;
  final Set<int> _viewPointers = {};
  bool _viewMulti = false;

  /// 触摸手势识别（直接触摸 / 触控板两档），见 RemoteTouchController。
  late final RemoteTouchController _touch = RemoteTouchController(
    onPointer: (mask, x, y) {
      final source = _svc.source;
      _lastX = x;
      _lastY = y;
      if (source != null) {
        source.pointerEvent(mask, x, y);
      } else {
        final area = _fallbackArea;
        if (area == null) return;
        if (mask == 0 || mask == 1) {
          _pointerQueue.add(mask, (area.x + x).round(), (area.y + y).round());
        } else if (mask == 4) {
          unawaited(
            _pointerQueue.drained.then(
              (_) => _svc.inputOp({
                'op': 'click',
                'x': (area.x + x).round(),
                'y': (area.y + y).round(),
                'button': 'right',
              }),
            ),
          );
        }
      }
    },
    onCursor: (s, pressed) =>
        _cursorMark.value = s == null ? null : _CursorMark(s, pressed),
    onHold: () => HapticFeedback.mediumImpact(),
    onRightUsed: () {
      if (mounted) setState(() => _rightOnce = false);
    },
    onFollow: _followCursor,
  );
  final ValueNotifier<_CursorMark?> _cursorMark = ValueNotifier(null);

  /// 触控板模式：一指滑动带虚拟光标走；偏好会记住（只对流畅模式生效）。
  bool _trackpad = false;
  static const _trackpadPref = 'remote_screen_trackpad';

  /// 最近一次舞台几何（视口 / 内容框偏移 / 内容框尺寸），放大态下视角跟随光标用。
  ({Size vp, double offX, double offY, double dw, double dh})? _stageGeo;
  Matrix4? _xformAtStart;

  /// 框选源图裁剪（与 Web 版 setBoxSel 同一交互）：开启后拖一个矩形，
  /// 松开从原生截图裁剪并 fit 铺满视口，之后的
  /// 平移 / 精确点 / 双击复位全部继承。框是视口坐标，应用时经当前矩阵
  /// 的逆映射回 child 坐标，所以放大态里再框选同样成立。
  bool _boxSelOn = false;
  Rect? _boxRect;
  Offset _boxAnchor = Offset.zero;

  @override
  void initState() {
    super.initState();
    _svc = widget.service ?? RemoteScreenService(settings: widget.settings);
    _modeSub = _svc.onModeChange.listen((_) {
      _touch.reset();
      _decoder.clear();
      // live↔fallback 切换时画面尺寸会变，缩放矩阵留着只会歪，直接复位。
      _xform.value = Matrix4.identity();
      _zoomed = false;
      _zoomPct = 100;
      if (mounted) setState(() {});
    });
    _frameSub = _svc.onFrame.listen((_) => _renderFrame());
    _xform.addListener(_keepViewInBounds);
    SharedPreferences.getInstance()
        .then((prefs) {
          final on = prefs.getBool(_trackpadPref) ?? false;
          if (mounted && on != _trackpad) setState(() => _trackpad = on);
        })
        .catchError((Object _) {});
    if (widget.initialControl) {
      _control = true;
      _hadControl = true;
      _startHaltPoll();
    }
    _checkPermsThenConnect();
  }

  /// 未通过桌面权限时每两秒复查；出帧后每十秒检查急停监听状态。
  Future<void> _checkPermsThenConnect() async {
    // 先问「这台机器能不能做」。不支持的平台（现在的 Windows / Linux）连
    // agent socket 都不存在：去查权限只会拿到一堆假红，去 connectLive()
    // 只会空转重连。直接在源头收敛，把原因写在页面上。
    final supported = await _svc.supportsRemoteScreen();
    if (!mounted) return;
    if (supported == false) {
      setState(() => _unsupported = true);
      return;
    }
    await _refreshPerms();
    if (!mounted) return;
    _permTimer?.cancel();
    _permTimer = Timer.periodic(const Duration(seconds: 2), (_) {
      if (_permStarted &&
          _lastPermCheck != null &&
          DateTime.now().difference(_lastPermCheck!) <
              const Duration(seconds: 10)) {
        return;
      }
      unawaited(_refreshPerms());
    });
  }

  Future<void> _refreshPerms() async {
    if (_permChecking || _permRestarting) return;
    _permChecking = true;
    final epoch = _permEpoch;
    final perms = await _svc.agentPermissions();
    final wake = await _svc.wakeScreen();
    if (mounted && !_waking) setState(() => _wakeState = wake);
    _permChecking = false;
    _lastPermCheck = DateTime.now();
    if (!mounted || _permRestarting || epoch != _permEpoch) return;
    _applyPerms(perms);
  }

  void _applyPerms(Map<String, dynamic> perms) {
    setState(
      () => _permGate =
          RemoteScreenService.allPermissionsReady(perms) && _permResult == null
          ? null
          : Map<String, dynamic>.from(perms),
    );
    if (!_permStarted && RemoteScreenService.desktopPermissionsReady(perms)) {
      _permStarted = true;
      _svc.connectLive();
    }
  }

  Future<void> _wakeScreen() async {
    if (_waking || _wakeState['canWake'] != true) return;
    setState(() {
      _waking = true;
      _wakeMessage = '正在唤起屏幕，请稍候…';
    });
    final result = await _svc.wakeScreen(request: true);
    if (!mounted) return;
    setState(() {
      _waking = false;
      _wakeMessage = result['message'] as String? ?? '唤起失败，请手动重试。';
      if (result['ok'] == true) _wakeState = result;
    });
    if (result['ok'] == true) _svc.connectLive();
  }

  Future<void> _restartAgent() async {
    if (_permRestarting || _permGate?['local'] != true) return;
    setState(() {
      _permRestarting = true;
      _permEpoch++;
      _permResult = t('airGlobalPermissionsRestarting');
    });
    final reply = await _svc.restartAgentPermissions();
    if (!mounted) return;
    setState(() {
      _permRestarting = false;
      _permResult = reply['ok'] == true
          ? t('airGlobalPermissionsRestarted')
          : t('airGlobalPermissionsRestartFailed', {
              'message': '${reply['error'] ?? ''}',
            });
    });
    if (reply['ok'] == true) _applyPerms(reply);
  }

  @override
  void dispose() {
    _haltTimer?.cancel();
    _permTimer?.cancel();
    _touch.reset();
    _decoder.dispose();
    _cursorMark.dispose();
    _xform.removeListener(_keepViewInBounds);
    _xform.dispose();
    _frameSub?.cancel();
    _modeSub?.cancel();
    _textCtrl.dispose();
    _image?.dispose();
    _image = null;
    // 曾经拿过操作租约就先交还再拆传输（inputOp 自带超时，dispose 终会落地）。
    if (_hadControl) {
      unawaited(
        _pointerQueue.drained
            .then((_) => _svc.inputOp({'op': 'release'}))
            .whenComplete(() => _svc.dispose()),
      );
    } else {
      _svc.dispose();
    }
    super.dispose();
  }

  // ── 帧渲染 ──
  void _renderFrame() {
    final source = _svc.source;
    final fb = source?.framebuffer;
    if (fb == null || source == null || source.width <= 0) {
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
    _decoder.add(fb, source.width, source.height);
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
      _rightOnce = false;
      _touch.reset();
    }
  }

  // RFB 无错误通道：可操作时每 3s 查一次状态，用户按了 Esc（可选急停）就亮「解除急停」。
  void _startHaltPoll() {
    _haltTimer?.cancel();
    _haltTimer = Timer.periodic(const Duration(seconds: 3), (_) async {
      if (!_control) return;
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
      'accessibility-not-granted': 'rsErrAx',
      'screen-recording-not-granted': 'rsErrSr',
    };
    final code = res['error']?.toString();
    setState(() {
      _statusErr = code != null && codeKeys.containsKey(code)
          ? t(codeKeys[code]!)
          : (res['message']?.toString()) ?? t('rsErrUnknown');
    });
  }

  // ── 指针（流式 / JPEG 共用手势控制器）──
  // 手势识别全在 RemoteTouchController（纯 Dart，单测覆盖）；这里只做装配。
  bool get _trackpadActive =>
      _trackpad && _control && _svc.mode == RemoteScreenMode.live;

  void _syncTouch(double dw, double dh) {
    final source = _svc.source;
    final area = _fallbackArea;
    if (source == null && area == null) return;
    _touch
      ..display = Size(dw, dh)
      ..source = source != null
          ? Size(source.width.toDouble(), source.height.toDouble())
          : Size(area!.width, area.height)
      ..viewScale = _xform.value.getMaxScaleOnAxis()
      ..mode = _trackpadActive
          ? RemoteTouchMode.trackpad
          : RemoteTouchMode.direct
      ..rightOnce = _rightOnce;
  }

  void _onPointerDown(PointerDownEvent e, double dw, double dh) {
    if (!_control) return;
    if (_svc.source == null) {
      if (_svc.fallbackJpeg == null) return;
      _fallbackArea =
          _svc.viewRegion ??
          ScreenRegion(
            0,
            0,
            _svc.fallbackWidth.toDouble(),
            _svc.fallbackHeight.toDouble(),
          );
    }
    _syncTouch(dw, dh);
    _touch.down(e.pointer, e.localPosition, e.position, e.timeStamp);
  }

  void _onPointerMove(PointerMoveEvent e, double dw, double dh) {
    if (!_control) return;
    _syncTouch(dw, dh);
    _touch.move(e.pointer, e.localPosition, e.position, e.timeStamp);
  }

  void _onPointerUp(PointerEvent e, double dw, double dh) {
    _syncTouch(dw, dh);
    if (e is PointerCancelEvent || !_control) {
      _touch.cancel(e.pointer);
    } else {
      _touch.up(e.pointer, e.localPosition, e.position, e.timeStamp);
    }
  }

  void _toggleTrackpad() {
    _touch.reset(); // 切档先把按着的键松开
    _cursorMark.value = null;
    final on = !_trackpad;
    setState(() => _trackpad = on);
    SharedPreferences.getInstance()
        .then((prefs) => prefs.setBool(_trackpadPref, on))
        .catchError((Object _) => false);
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(
        SnackBar(
          duration: const Duration(seconds: 4),
          content: Text(
            on
                ? '触控板模式：滑动移动光标 · 轻点单击 · 按住后再拖 = 拖拽 · 双指滑动 = 滚动 · 双指轻点 = 右键 · 双指捏合缩放'
                : '触摸模式：手指点哪、拖到哪',
          ),
        ),
      );
  }

  /// 触控板放大态：光标靠近视口边缘时把视角推过去，光标始终在可见区域内。
  void _followCursor(Offset src) {
    final g = _stageGeo;
    final source = _svc.source;
    if (g == null || source == null || !_zoomed || source.width <= 0) return;
    final m = _xform.value;
    final s = m.getMaxScaleOnAxis();
    final vx = (src.dx / source.width * g.dw + g.offX) * s + m.entry(0, 3);
    final vy = (src.dy / source.height * g.dh + g.offY) * s + m.entry(1, 3);
    const margin = 56.0;
    double push(double v, double len) {
      if (v < margin) return margin - v;
      if (v > len - margin) return len - margin - v;
      return 0;
    }

    final dx = push(vx, g.vp.width), dy = push(vy, g.vp.height);
    if (dx == 0 && dy == 0) return;
    _xform.value = Matrix4.identity()
      ..translate(m.entry(0, 3) + dx, m.entry(1, 3) + dy)
      ..scale(s);
    _onZoomUpdate(g.vp, g.offX, g.offY, g.dw, g.dh);
  }

  void _wheelPulse(int mask) {
    if (!_control) return;
    final source = _svc.source;
    if (source != null) {
      source.pointerEvent(mask, _lastX, _lastY);
      return;
    }
    final area = _svc.viewRegion;
    if (_svc.fallbackJpeg == null || area == null) return;
    unawaited(
      _svc.inputOp({
        'op': 'scroll',
        'x': (area.x + area.width / 2).round(),
        'y': (area.y + area.height / 2).round(),
        'amount': mask == 0x08 ? 3 : -3,
      }),
    );
  }

  // Fixed logical source geometry for the current fallback gesture.
  ScreenRegion? _fallbackArea;

  // ── 键盘条 ──
  Future<void> _sendText() async {
    final text = _textCtrl.text;
    if (text.isEmpty) return;
    if (_svc.mode == RemoteScreenMode.live) {
      _svc.source?.typeText(text);
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
    final source = _svc.source;
    if (source == null) return;
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
      source.keyEvent(true, keysym);
      source.keyEvent(false, keysym);
    } else {
      source.chord(mods, keysym);
    }
  }

  // ── UI ──
  String get _modeLabel {
    if (_svc.error == 'region-unavailable') return '服务端尚不支持局部清晰化，请更新后手动重启';
    if (_svc.region != null) {
      return _svc.fallbackJpeg == null ? '正在获取选区原始细节…' : '局部清晰';
    }
    switch (_svc.mode) {
      case RemoteScreenMode.connecting:
        return t('rsConnecting');
      case RemoteScreenMode.live:
        return _svc.h264Active ? t('rsLiveModeH264') : t('rsLiveMode');
      case RemoteScreenMode.fallback:
        return t('rsFallback');
    }
  }

  /// 本平台做不了远程屏幕时的整页。只留标题栏 + 一句原因：这页原本的
  /// 控件（流畅模式 / 控制 / 框选 / 唤起屏幕）在没有 agent 的平台上全是
  /// 死按钮，不如整页说清楚，而不是让用户对着空视口猜。
  Widget _unsupportedScaffold() {
    return Scaffold(
      backgroundColor: const Color(0xFF10141c),
      appBar: AppBar(
        backgroundColor: const Color(0xFF161b26),
        foregroundColor: const Color(0xFFdce6f1),
        title: Text('🖥 ${t('rsTitle')}'),
      ),
      body: SafeArea(
        child: Center(
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 32),
            child: Text(
              t('rsErrPlatform'),
              textAlign: TextAlign.center,
              style: const TextStyle(
                color: Color(0xFF9fb0c6),
                fontSize: 15,
                height: 1.6,
              ),
            ),
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    if (_unsupported) return _unsupportedScaffold();
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
          if (_control && _svc.mode == RemoteScreenMode.live)
            IconButton(
              icon: Icon(
                _trackpad ? Icons.mouse_outlined : Icons.touch_app_outlined,
              ),
              tooltip: _trackpad ? '触控板模式（点按切回触摸）' : '触摸模式（点按切到触控板）',
              color: _trackpad ? const Color(0xFF2ba67a) : null,
              onPressed: _toggleTrackpad,
            ),
          if (_control)
            IconButton(
              icon: const Icon(Icons.ads_click),
              tooltip: t('rsRightClickHint'),
              color: _rightOnce ? const Color(0xFF2ba67a) : null,
              onPressed: () => setState(() => _rightOnce = !_rightOnce),
            ),
          IconButton(
            icon: const Icon(Icons.crop_free),
            tooltip: t('rsBoxZoomTitle'),
            color: _boxSelOn ? const Color(0xFF2ba67a) : null,
            onPressed: () {
              _touch.reset();
              setState(() {
                _boxSelOn = !_boxSelOn;
                _boxRect = null;
              });
            },
          ),
        ],
      ),
      body: SafeArea(
        child: Column(
          children: [
            _statusRow(),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12),
              child: Row(
                children: [
                  OutlinedButton(
                    onPressed: !_waking && _wakeState['canWake'] == true
                        ? _wakeScreen
                        : null,
                    child: Text(_waking ? '正在唤起…' : '唤起屏幕'),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      _wakeMessage ??
                          (_wakeState['screenLocked'] == true &&
                                  _wakeState['canWake'] == true
                              ? '屏幕已锁定，点击“唤起屏幕”恢复画面。'
                              : _wakeState['message'] as String? ??
                                    '正在检查自动解锁状态…'),
                    ),
                  ),
                ],
              ),
            ),
            if (_permGate != null) _permBanner(),
            if (_halted) _haltBanner(),
            Expanded(child: _stage()),
            if (_control) _keyBar(),
          ],
        ),
      ),
    );
  }

  Widget _statusRow() {
    final source = _svc.source;
    final w = _svc.mode == RemoteScreenMode.live
        ? source?.width ?? 0
        : _svc.fallbackWidth;
    final h = _svc.mode == RemoteScreenMode.live
        ? source?.height ?? 0
        : _svc.fallbackHeight;
    final bits = <String>[
      if (w > 0 && h > 0) '$w×$h',
      _modeLabel,
      if (_boxSelOn) t('rsBoxSelHint'),
      if (_trackpadActive) '触控板',
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

  Widget _permBanner() {
    final gate = _permGate!;
    final local = gate['local'] == true;
    Widget row(String key, String label) {
      final ok = gate[key] == true;
      final mark = ok
          ? '✓'
          : gate[key] == false
          ? '✗'
          : '?';
      return Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            '$label $mark',
            style: const TextStyle(fontSize: 12.5, color: Color(0xFFf0d7a0)),
          ),
          if (gate[key] == false && local) ...[
            const SizedBox(width: 6),
            OutlinedButton(
              style: OutlinedButton.styleFrom(
                foregroundColor: const Color(0xFFffcc55),
                side: const BorderSide(color: Color(0xFF7a5a20)),
                padding: const EdgeInsets.symmetric(horizontal: 8),
                minimumSize: const Size(0, 30),
              ),
              onPressed: _permRestarting
                  ? null
                  : () => _svc.openPermission(key),
              child: Text(
                t('rsPermOpen'),
                style: const TextStyle(fontSize: 11.5),
              ),
            ),
          ],
        ],
      );
    }

    return Container(
      width: double.infinity,
      color: const Color(0xFF2c2210),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Wrap(
            spacing: 12,
            runSpacing: 4,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              Text(
                t('rsPermTitle'),
                style: const TextStyle(
                  fontSize: 12.5,
                  fontWeight: FontWeight.w600,
                  color: Color(0xFFffcc55),
                ),
              ),
              row('screenRecording', t('rsPermScreen')),
              row('accessibility', t('rsPermAx')),
            ],
          ),
          const SizedBox(height: 3),
          if (_permResult != null)
            Text(
              _permResult!,
              style: const TextStyle(fontSize: 11.5, color: Color(0xFFf0d7a0)),
            ),
          if (local && gate['agentApp'] is String)
            SelectableText(
              gate['agentApp'] as String,
              style: const TextStyle(fontSize: 11.5, color: Color(0xFFb8a878)),
            ),
          if (local)
            TextButton(
              onPressed: _permRestarting ? null : _restartAgent,
              child: Text(t('airGlobalPermissionsRestart')),
            ),
          if (!RemoteScreenService.desktopPermissionsReady(gate))
            Text(
              local ? t('rsPermHint') : t('rsPermRemote'),
              style: const TextStyle(fontSize: 11.5, color: Color(0xFFb8a878)),
            ),
        ],
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
          TextButton(onPressed: _unhalt, child: Text(t('rsUnhalt'))),
        ],
      ),
    );
  }

  Widget _stage() {
    if (_svc.mode == RemoteScreenMode.live) {
      final img = _image;
      final source = _svc.source;
      if (img == null || source == null || source.width <= 0) {
        return const Center(child: CircularProgressIndicator());
      }
      return LayoutBuilder(
        builder: (context, constraints) {
          final size = constraints.biggest;
          final scale = size.width / source.width < size.height / source.height
              ? size.width / source.width
              : size.height / source.height;
          return _zoomStage(
            size,
            source.width * scale,
            source.height * scale,
            Listener(
              behavior: HitTestBehavior.opaque,
              onPointerDown: (e) => _onPointerDown(
                e,
                source.width * scale,
                source.height * scale,
              ),
              onPointerMove: (e) => _onPointerMove(
                e,
                source.width * scale,
                source.height * scale,
              ),
              onPointerUp: (e) =>
                  _onPointerUp(e, source.width * scale, source.height * scale),
              onPointerCancel: (e) =>
                  _onPointerUp(e, source.width * scale, source.height * scale),
              child: Stack(
                fit: StackFit.expand,
                children: [
                  CustomPaint(
                    painter: _ScreenPainter(img),
                    size: Size.infinite,
                  ),
                  // 本地光标 / 落点：不等往返就跟手（IgnorePointer，不抢手势）
                  IgnorePointer(
                    child: ValueListenableBuilder<_CursorMark?>(
                      valueListenable: _cursorMark,
                      builder: (context, mark, _) => CustomPaint(
                        painter: _CursorPainter(
                          mark,
                          source.width.toDouble(),
                          source.height.toDouble(),
                          _trackpadActive,
                        ),
                        size: Size.infinite,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          );
        },
      );
    }
    // 兼容/选区模式：源图 JPEG + HTTP 点击、拖拽、显式右键。
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
        final iw = _svc.viewRegion?.width ?? (w > 0 ? w.toDouble() : 1470.0);
        final ih = _svc.viewRegion?.height ?? (h > 0 ? h.toDouble() : 956.0);
        final scale = size.width / iw < size.height / ih
            ? size.width / iw
            : size.height / ih;
        return _zoomStage(
          size,
          iw * scale,
          ih * scale,
          Listener(
            behavior: HitTestBehavior.opaque,
            onPointerDown: (e) => _onPointerDown(e, iw * scale, ih * scale),
            onPointerMove: (e) => _onPointerMove(e, iw * scale, ih * scale),
            onPointerUp: (e) => _onPointerUp(e, iw * scale, ih * scale),
            onPointerCancel: (e) => _onPointerUp(e, iw * scale, ih * scale),
            child: Image.memory(jpeg, gaplessPlayback: true, fit: BoxFit.fill),
          ),
        );
      },
    );
  }

  // ── 捏合缩放容器（live / fallback 共用）──
  // child 固定为 contain 尺寸（dw×dh），先平移到视口中心再交给
  // InteractiveViewer；boundaryMargin 无限 + 自己 clamp：放大时内容不许拉出
  // 视口，未放大时（内容比视口窄的一侧）保持居中 —— 与 Web 版 clampPan 同义。
  Widget _zoomStage(Size vp, double dw, double dh, Widget child) {
    final offX = (vp.width - dw) / 2, offY = (vp.height - dh) / 2;
    _stageGeo = (vp: vp, offX: offX, offY: offY, dw: dw, dh: dh);
    final pad = _trackpadActive;
    return Stack(
      children: [
        Positioned.fill(
          child: ClipRect(
            child: Listener(
              onPointerDown: (e) {
                _viewPointers.add(e.pointer);
                if (_viewPointers.length >= 2) _setViewMulti(true);
              },
              onPointerUp: (e) {
                _viewPointers.remove(e.pointer);
                if (_viewPointers.isEmpty) _setViewMulti(false);
              },
              onPointerCancel: (e) {
                _viewPointers.remove(e.pointer);
                if (_viewPointers.isEmpty) _setViewMulti(false);
              },
              child: GestureDetector(
                // 只看模式允许双击缩放；可操作模式的连点留给远端。
                onDoubleTapDown: _control || pad
                    ? null // 触控板里连点两下是双击，不是缩放
                    : (d) => _doubleTapZoom(d, vp, offX, offY, dw, dh),
                child: InteractiveViewer(
                  transformationController: _xform,
                  constrained: false,
                  // 触控板：单指/双指平行滑动归手势控制器（光标 / 滚轮），视角靠跟随光标。
                  // 可操作的触摸模式：单指只操作远端，平移视角要双指 —— 单指开着
                  // 平移的话，松手时的惯性会把画面甩走。
                  panEnabled: !pad && (!_control || _viewMulti),
                  scaleEnabled: true,
                  minScale: 1.0,
                  maxScale: 6.0,
                  boundaryMargin: const EdgeInsets.all(double.infinity),
                  onInteractionStart: (_) =>
                      _xformAtStart = _xform.value.clone(),
                  onInteractionUpdate: (_) {
                    // One finger operates the remote at every zoom level.
                    // After a pinch, keep the remaining finger local until lift.
                    if (_control && !pad && !_viewMulti) {
                      final start = _xformAtStart;
                      if (start != null) _xform.value = start.clone();
                      return;
                    }
                    // 双指在「滚动」远端：InteractiveViewer 看到的微小比例抖动不许动画面
                    final start = _xformAtStart;
                    if (pad && _touch.scrolling && start != null) {
                      _xform.value = start.clone();
                    }
                    _onZoomUpdate(vp, offX, offY, dw, dh);
                  },
                  child: Transform.translate(
                    offset: Offset(offX, offY),
                    child: SizedBox(width: dw, height: dh, child: child),
                  ),
                ),
              ),
            ),
          ),
        ),
        // 框选放大：opaque 层独占指针（IV / Listener 都不进 hit path），
        // 画完自动退出，双击与 % 徽标复位照常可用（徽标在本层之上）。
        if (_boxSelOn)
          Positioned.fill(
            child: GestureDetector(
              behavior: HitTestBehavior.opaque,
              onPanStart: (d) => setState(() {
                _boxAnchor = d.localPosition;
                _boxRect = Rect.fromPoints(_boxAnchor, d.localPosition);
              }),
              onPanUpdate: (d) => setState(() {
                _boxRect = Rect.fromPoints(_boxAnchor, d.localPosition);
              }),
              onPanEnd: (_) => _finishBoxSel(vp, offX, offY, dw, dh),
              onPanCancel: () => setState(() {
                _boxRect = null;
                _boxSelOn = false;
              }),
            ),
          ),
        if (_boxSelOn && _boxRect != null && !_boxRect!.isEmpty)
          Positioned.fromRect(
            rect: _boxRect!,
            child: IgnorePointer(
              child: Container(
                decoration: BoxDecoration(
                  border: Border.all(
                    color: const Color(0xFF4da3ff),
                    width: 1.5,
                  ),
                  color: const Color(0x244da3ff),
                ),
              ),
            ),
          ),
        if (_zoomed || _svc.region != null) _zoomBadge(vp, offX, offY, dw, dh),
      ],
    );
  }

  void _setViewMulti(bool on) {
    if (_viewMulti == on) return;
    _viewMulti = on;
    if (mounted) setState(() {});
  }

  // Undo the view transform and letterboxing before asking the server to
  // crop the native screenshot. A nested selection adds the current origin.
  Future<void> _finishBoxSel(
    Size vp,
    double offX,
    double offY,
    double dw,
    double dh,
  ) async {
    final r = _boxRect;
    setState(() {
      _boxRect = null;
      _boxSelOn = false;
    });
    if (r == null || r.width < 24 || r.height < 24) return;
    final inv = Matrix4.inverted(_xform.value);
    final a = MatrixUtils.transformPoint(inv, r.topLeft) - Offset(offX, offY);
    final b =
        MatrixUtils.transformPoint(inv, r.bottomRight) - Offset(offX, offY);
    final previous = _svc.viewRegion;
    if (!await _svc.ensureScreenSize() || !mounted) return;
    final area =
        previous ??
        ScreenRegion(
          0,
          0,
          _svc.fallbackWidth.toDouble(),
          _svc.fallbackHeight.toDouble(),
        );
    final selected = area.select(Rect.fromPoints(a, b), dw, dh);
    if (selected == null) return;
    _svc.selectRegion(selected);
    _zoomed = false;
    _zoomPct = 100;
    _xform.value = Matrix4.identity();
    if (mounted) setState(() {});
  }

  void _onZoomUpdate(Size vp, double offX, double offY, double dw, double dh) {
    final m = _xform.value;
    final s = m.getMaxScaleOnAxis();
    double clampAxis(double t, double off, double len, double vlen) {
      // 内容盖满视口：边缘不许进视口；没盖满：居中（不放大时画面永远在正中）。
      // 不能用 `a < b ? a : b` 排上下界：铺满一轴时 a 是 -0.0、b 是 0.0，
      // double.clamp(0.0, -0.0) 会抛 ArgumentError，钳制整段失效、画面漂走。
      if (s * len <= vlen) return (vlen - s * len) / 2 - s * off;
      return t.clamp(vlen - s * (off + len), -s * off).toDouble();
    }

    final tx = clampAxis(m.entry(0, 3), offX, dw, vp.width);
    final ty = clampAxis(m.entry(1, 3), offY, dh, vp.height);
    _clampingView = true;
    try {
      _xform.value = Matrix4.identity()
        ..translate(tx, ty)
        ..scale(s);
    } finally {
      _clampingView = false;
    }
    final zoomed = s > 1.01;
    final pct = (s * 100).round();
    if (mounted && (zoomed != _zoomed || _zoomPct != pct)) {
      setState(() {
        _zoomed = zoomed;
        _zoomPct = pct;
      });
    }
  }

  // InteractiveViewer 松手后的惯性平移 / 缩放回弹直接改矩阵、不走 onInteractionUpdate，
  // 边界又是无限的 —— 不在这里兜住，松手后画面会滑出视口。
  bool _clampingView = false;
  void _keepViewInBounds() {
    final g = _stageGeo;
    if (g == null || _clampingView) return;
    _onZoomUpdate(g.vp, g.offX, g.offY, g.dw, g.dh);
  }

  void _doubleTapZoom(
    TapDownDetails d,
    Size vp,
    double offX,
    double offY,
    double dw,
    double dh,
  ) {
    final f = d.localPosition; // 视口坐标 = 双击锚点
    if (_svc.region != null) {
      _svc.selectRegion(null);
      _xform.value = Matrix4.identity();
      return;
    }
    final s2 = _zoomed ? 1.0 : 2.5;
    _xform.value = Matrix4.identity()
      ..translate(f.dx, f.dy)
      ..scale(s2)
      ..translate(-f.dx, -f.dy);
    _onZoomUpdate(vp, offX, offY, dw, dh);
  }

  Widget _zoomBadge(Size vp, double offX, double offY, double dw, double dh) {
    return Positioned(
      top: 10,
      right: 10,
      child: Semantics(
        label: t('rsZoomReset'),
        button: true,
        child: GestureDetector(
          onTap: () {
            if (_svc.region != null) _svc.selectRegion(null);
            _xform.value = Matrix4.identity();
            _onZoomUpdate(vp, offX, offY, dw, dh);
          },
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
            decoration: BoxDecoration(
              color: const Color(0xCC161b26),
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: const Color(0xFF2a3242)),
            ),
            child: Text(
              _svc.region != null ? '全屏 · $_zoomPct%' : '$_zoomPct%',
              style: const TextStyle(fontSize: 11.5, color: Color(0xFFdce6f1)),
            ),
          ),
        ),
      ),
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
                child: Text(
                  t('rsSend'),
                  style: const TextStyle(fontSize: 12.5),
                ),
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

/// 本地光标 / 落点标记（源画面像素）。
class _CursorMark {
  const _CursorMark(this.pos, this.pressed);
  final Offset pos;
  final bool pressed;

  @override
  bool operator ==(Object other) =>
      other is _CursorMark && other.pos == pos && other.pressed == pressed;

  @override
  int get hashCode => Object.hash(pos, pressed);
}

/// 触摸模式画一个落点圈；触控板模式画箭头光标。
class _CursorPainter extends CustomPainter {
  _CursorPainter(this.mark, this.srcW, this.srcH, this.trackpad);
  final _CursorMark? mark;
  final double srcW;
  final double srcH;
  final bool trackpad;

  @override
  void paint(Canvas canvas, Size size) {
    final m = mark;
    if (m == null || srcW <= 0 || srcH <= 0) return;
    final p = Offset(
      m.pos.dx / srcW * size.width,
      m.pos.dy / srcH * size.height,
    );
    const accent = Color(0xFF4da3ff);
    if (trackpad) {
      final path = Path()
        ..moveTo(p.dx, p.dy)
        ..lineTo(p.dx, p.dy + 18)
        ..lineTo(p.dx + 4.5, p.dy + 14)
        ..lineTo(p.dx + 8, p.dy + 21)
        ..lineTo(p.dx + 10.5, p.dy + 20)
        ..lineTo(p.dx + 7, p.dy + 13)
        ..lineTo(p.dx + 12.5, p.dy + 13)
        ..close();
      canvas.drawPath(
        path,
        Paint()..color = m.pressed ? accent : const Color(0xFFFFFFFF),
      );
      canvas.drawPath(
        path,
        Paint()
          ..style = PaintingStyle.stroke
          ..strokeWidth = 1.2
          ..color = const Color(0xFF10141c),
      );
      return;
    }
    if (m.pressed) {
      canvas.drawCircle(p, 16, Paint()..color = accent.withValues(alpha: 0.28));
    }
    canvas.drawCircle(
      p,
      16,
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 2
        ..color = accent,
    );
  }

  @override
  bool shouldRepaint(_CursorPainter old) =>
      old.mark != mark || old.trackpad != trackpad;
}
