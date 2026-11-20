// 「🖥 屏幕」App 端：直连 /ws/remote-screen 讲最小 RFB 3.8（RemoteScreenRfb），
// 断流/旧 Agent 自动回退 JPEG 轮询（RemoteScreenService）。只看/可操作、
// 触摸模式长按 500ms = 右键、触控板拖拽松手 500ms 锁、粘住的修饰键
// （⇧ ⌘ ⌥ ⌃）、滚轮脉冲、键盘条（文字 + 功能键/快捷键和弦 + 「更多」面板）
// 与可选 Esc 急停的「解除急停」都对着 Web 版 public/chat-remote-screen.js 的语义。
import 'dart:async';
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart'
    show Clipboard, ClipboardData, HapticFeedback, SystemChrome, SystemUiMode;
import 'package:shared_preferences/shared_preferences.dart';

import '../i18n.dart';
import '../services/remote_host_actions.dart';
import '../services/remote_link.dart';
import '../services/remote_rate_controller.dart';
import '../services/remote_screen_h264.dart';
import '../services/remote_screen_rfb.dart';
import '../services/remote_frame_decoder.dart';
import '../services/remote_pointer_queue.dart';
import '../services/remote_screen_region.dart';
import '../services/remote_screen_service.dart';
import '../services/remote_screen_source.dart';
import '../services/remote_touch_controller.dart';
import '../services/settings_service.dart';
import '../services/sticky_modifiers.dart';
import '../widgets/remote_control_pod.dart';
import '../widgets/remote_key_sheet.dart';
import '../widgets/remote_rail.dart';

/// 键盘条的功能键/快捷键：[label, spec]。spec 里 `+` 分段，修饰键映射成
/// RFB keysym，其余段按单字符或命名键解析 —— 与 Web 版 KEYS 表一致。
/// ⌘ 只是 Mac 的写法：本机是 Linux 时按能力画像换成 Ctrl（见 [_remapLabel]）。
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

/// 「更多」面板：F1–F12、Home/End/PgUp/PgDn、前向 Delete、常用 ⌘ 快捷键。
const List<List<String>> _moreKeySpecs = [
  ['F1', 'f1'],
  ['F2', 'f2'],
  ['F3', 'f3'],
  ['F4', 'f4'],
  ['F5', 'f5'],
  ['F6', 'f6'],
  ['F7', 'f7'],
  ['F8', 'f8'],
  ['F9', 'f9'],
  ['F10', 'f10'],
  ['F11', 'f11'],
  ['F12', 'f12'],
  ['Home', 'home'],
  ['End', 'end'],
  ['PgUp', 'pageup'],
  ['PgDn', 'pagedown'],
  ['⌦', 'delete'],
  ['⌘Space', 'cmd+space'],
  ['⌘Q', 'cmd+q'],
  ['⌘S', 'cmd+s'],
  ['⌘F', 'cmd+f'],
  ['⌘T', 'cmd+t'],
  ['⌘N', 'cmd+n'],
  ['⇧Tab', 'shift+tab'],
  ['⌃C', 'ctrl+c'],
];

/// 按住会连发的键：初始 400ms 后每 70ms 一次（退格、前向 Delete、方向键）。
const Set<String> _repeatSpecs = {
  'backspace',
  'delete',
  'left',
  'up',
  'down',
  'right',
};

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
  'home': RfbKeysyms.home,
  'end': RfbKeysyms.end,
  'pageup': RfbKeysyms.pageUp,
  'pgup': RfbKeysyms.pageUp,
  'pagedown': RfbKeysyms.pageDown,
  'pgdn': RfbKeysyms.pageDown,
  'f1': RfbKeysyms.f1,
  'f2': RfbKeysyms.f1 + 1,
  'f3': RfbKeysyms.f1 + 2,
  'f4': RfbKeysyms.f1 + 3,
  'f5': RfbKeysyms.f1 + 4,
  'f6': RfbKeysyms.f1 + 5,
  'f7': RfbKeysyms.f1 + 6,
  'f8': RfbKeysyms.f1 + 7,
  'f9': RfbKeysyms.f1 + 8,
  'f10': RfbKeysyms.f1 + 9,
  'f11': RfbKeysyms.f1 + 10,
  'f12': RfbKeysyms.f1 + 11,
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

class _RemoteScreenScreenState extends State<RemoteScreenScreen>
    with WidgetsBindingObserver {
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
      setState(() {
        _image = image;
        _frameAge = 0;
        _inputSinceFrame = false;
      });
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

  // 「最近一帧 N 秒前」：画面冻住时 fps 读数停在最后一个值，看着像「点击没传过去」。
  // 按 1s 计时器数秒（不读 DateTime.now，widget 测试可推进）；静止屏幕上 H.264 看门狗
  // 每 ≤8s 会补一个关键帧，所以健康时不会出现，发了输入还没新帧则 5s 就提示。
  int _frameAge = 0;
  bool _inputSinceFrame = false;
  Timer? _ageTimer;
  bool get _frameAgeShown =>
      _frameAge >= 10 || (_inputSinceFrame && _frameAge >= 5);

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

  /// 粘住的修饰键（⇧ ⌘ ⌥ ⌃）：点一下 = 一次性，连点两下 = 锁定。
  final StickyModifiers _sticky = StickyModifiers();

  /// 本次「按下+松开」周期里发过按键/按钮：松手时用掉一次性修饰键。
  bool _pointerUsed = false;

  /// 键盘条「更多」面板展开中。
  /// 连发（退格 / 前向 Delete / 方向键）的计时器。
  Timer? _repeatTimer;

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

  /// 画面是否被摸过：[_lastX]/[_lastY] 的坐标域随 live（源图）与
  /// fallback（[_fallbackArea] 内）不同，没摸过时用画面中心。
  bool _hasPointer = false;

  /// fallback 滚轮靠 HTTP：多格脉冲合并成一趟循环，避免并发请求丢格。
  int _scrollPending = 0;
  bool _scrollBusy = false;
  final TextEditingController _textCtrl = TextEditingController();

  /// 捏合缩放：InteractiveViewer 的变换只改视觉框，Listener 收到的
  /// localPosition 已被 hit-test 逆变换回 contain 布局坐标，所以坐标
  /// 归一化与输入映射零改动（与 Web 版 s.zoomer 同一模型）。
  final TransformationController _xform = TransformationController();
  bool _zoomed = false;
  int _zoomPct = 100;

  /// 当前按在画面上的手指；不足两指时画面不许动（单指只做鼠标）。
  final Set<int> _viewPointers = {};

  /// 触摸手势识别（舞台永远是直接触摸），见 RemoteTouchController。
  late final RemoteTouchController _touch = RemoteTouchController(
    onPointer: _emitPointer,
    onCursor: (s, pressed) => _cursorMark.value = s == null
        ? null
        : _CursorMark(s, pressed, arrow: true),
    onHold: () => HapticFeedback.mediumImpact(),
    onRightUsed: () {
      if (mounted) setState(() => _rightOnce = false);
    },
  );

  /// 指针事件出口：舞台与悬浮操作台共用一套（坐标都是源画面像素）。
  void _emitPointer(int mask, int x, int y) {
    final source = _svc.source;
    _inputSinceFrame = true;
    _hasPointer = true;
    _lastX = x;
    _lastY = y;
    if (mask & 7 != 0) _pointerUsed = true; // 真按了键：松手时用掉一次性修饰键
    // 兼容模式没有 KeyEvent 通道：修饰键只能随每个指针/滚轮请求带过去。
    final mods = _stickyHttpMods();
    if (source != null) {
      source.pointerEvent(mask, x, y);
    } else {
      final area = _fallbackArea;
      if (area == null) return;
      if (mask == 0 || mask == 1) {
        _pointerQueue.add(
          mask,
          (area.x + x).round(),
          (area.y + y).round(),
          mods: mods,
        );
      } else if (mask == 0x08 || mask == 0x10) {
        // 兼容模式没有滚轮通道：双指滚动合并成 HTTP `scroll`，和原先那条
        // 滚轮竖条走同一条路（_wheelNotch 只读 _lastX/_lastY，上面刚写过）。
        _wheelNotch(mask == 0x08);
      } else if (mask == 4) {
        unawaited(
          _pointerQueue.drained.then(
            (_) => _svc.inputOp({
              'op': 'click',
              'x': (area.x + x).round(),
              'y': (area.y + y).round(),
              'button': 'right',
              if (mods.isNotEmpty) 'mods': mods,
            }),
          ),
        );
      }
    }
  }

  final ValueNotifier<_CursorMark?> _cursorMark = ValueNotifier(null);

  /// 悬浮操作台（触控板 + 滚轮）。舞台永远走直接触摸，操作台是第二个
  /// [RemoteTouchController] 实例 —— 两者互不知道对方存在。
  late final RemoteTouchController _pad = RemoteTouchController(
    onPointer: _emitPointer,
    onCursor: (s, pressed) =>
        _cursorMark.value = s == null ? null : _CursorMark(s, pressed),
    onHold: () => HapticFeedback.mediumImpact(),
    onRightUsed: () {
      if (mounted) setState(() => _rightOnce = false);
    },
  );

  bool _podVisible = true;
  RemotePodCorner _podCorner = RemotePodCorner.bottomRight;

  /// 操作台灵敏度：每 1 逻辑像素位移移动多少源像素。
  double _padGain = 1.0;

  /// 幕布侧栏：展开 / 收起 / 靠哪边 / 当前面板。
  bool _railOpen = true;
  bool _railLeft = false;
  String? _panel;
  Timer? _railTimer;

  /// 首次进入时侧栏带文字标签，三秒后自收（见 RemoteRail 文件头）。
  bool _railLabels = false;
  Timer? _railLabelTimer;

  /// 键盘面板（非模态）与它的键位网格。
  bool _keyOpen = false;
  bool _keyGrid = false;

  /// 放大后的取景器：点在画面上时，手指上方放大 2.4×，用来精确落点。
  bool _loupe = true;

  /// 状态 HUD：常驻内容只有错误与「画面冻住」；正常读数出现几秒后淡出。
  bool _hudOn = true;
  Timer? _hudTimer;

  static const _podPref = 'remote_screen_pod';
  static const _podGainPref = 'remote_screen_pod_gain';
  static const _podCornerPref = 'remote_screen_pod_corner';
  static const _railLeftPref = 'remote_screen_rail_left';
  static const _loupePref = 'remote_screen_loupe';
  static const _seenPref = 'remote_screen_seen';

  /// 最近一次舞台几何（视口 / 内容框偏移 / 内容框尺寸），算可见源画面与钳制视角用。
  ({Size vp, double offX, double offY, double dw, double dh})? _stageGeo;
  Matrix4? _xformAtStart;

  /// 框选源图裁剪（与 Web 版 setBoxSel 同一交互）：开启后拖一个矩形，
  /// 松开从原生截图裁剪并 fit 铺满视口，之后的
  /// 平移 / 精确点 / 双击复位全部继承。框是视口坐标，应用时经当前矩阵
  /// 的逆映射回 child 坐标，所以放大态里再框选同样成立。
  bool _boxSelOn = false;
  Rect? _boxRect;
  Offset _boxAnchor = Offset.zero;

  /// 切到过后台：回前台时重连（见 [didChangeAppLifecycleState]）。
  bool _backgrounded = false;
  bool _wasFallback = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _svc = widget.service ?? RemoteScreenService(settings: widget.settings);
    _modeSub = _svc.onModeChange.listen((_) {
      _touch.reset();
      _releaseStickyAll(rebuild: false);
      _stopRepeat();
      _hasPointer = false; // live↔fallback 的坐标域不同，旧坐标不能再用
      _decoder.clear();
      _frameAge = 0;
      _inputSinceFrame = false;
      _fps = null;
      _lastFrameAt = null;
      // live↔fallback 切换时画面尺寸会变，缩放矩阵留着只会歪，直接复位；
      // 断线自动重连（live → 连接中 → live）还是同一块屏幕，保留放大位置。
      final fallback = _svc.mode == RemoteScreenMode.fallback;
      if (fallback != _wasFallback) {
        _xform.value = Matrix4.identity();
        _zoomed = false;
        _zoomPct = 100;
      }
      _wasFallback = fallback;
      if (mounted) {
        setState(() {});
        _armHud(); // 换了通道 / 重新连上：读数再露一次，别让状态变化悄无声息
      }
    });
    _frameSub = _svc.onFrame.listen((_) => _renderFrame());
    _ageTimer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (_svc.mode != RemoteScreenMode.live || _image == null) return;
      _frameAge++;
      if (mounted && _frameAgeShown) setState(() {});
    });
    _xform.addListener(_keepViewInBounds);
    // 幕布形态：进去就吃掉状态栏，退出恢复。参考 iPad 远控 App —— 画面就是页面。
    unawaited(
      SystemChrome.setEnabledSystemUIMode(SystemUiMode.immersiveSticky),
    );
    SharedPreferences.getInstance()
        .then((prefs) {
          final pod = prefs.getBool(_podPref) ?? true;
          final gain = prefs.getDouble(_podGainPref) ?? 1.0;
          final corner = prefs.getString(_podCornerPref);
          final railLeft = prefs.getBool(_railLeftPref) ?? false;
          final loupe = prefs.getBool(_loupePref) ?? true;
          final seen = prefs.getBool(_seenPref) ?? false;
          if (!mounted) return;
          if (!seen) {
            _startRailLabels();
            unawaited(prefs.setBool(_seenPref, true));
          }
          setState(() {
            _podVisible = pod;
            _padGain = gain.clamp(0.5, 2.0);
            _podCorner = switch (corner) {
              'topLeft' => RemotePodCorner.topLeft,
              'topRight' => RemotePodCorner.topRight,
              'bottomLeft' => RemotePodCorner.bottomLeft,
              _ => RemotePodCorner.bottomRight,
            };
            _railLeft = railLeft;
            _loupe = loupe;
          });
        })
        .catchError((Object _) {});
    _armHud();
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
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.paused) {
      _backgrounded = true;
      // 进后台前把按着的按钮/修饰键/连发都放开：回前台不该带着幽灵按键。
      _touch.reset();
      _releaseStickyAll();
      _stopRepeat();
    } else if (state == AppLifecycleState.resumed && _backgrounded) {
      // 切去别的 App（比如去 GitHub Mobile 点批准）再回来：连接和 iOS 硬件
      // 解码会话多半已经死了，立刻按高清优先重连，不让画面停在几十秒前。
      _backgrounded = false;
      _touch.reset();
      _cursorMark.value = null;
      if (_permStarted && !_unsupported) _svc.resumeLive();
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _haltTimer?.cancel();
    _permTimer?.cancel();
    _ageTimer?.cancel();
    _railTimer?.cancel();
    _railLabelTimer?.cancel();
    _hudTimer?.cancel();
    _stopRepeat();
    _releaseStickyAll(rebuild: false);
    _touch.reset();
    _pad.reset();
    // 离开幕布就还回状态栏；否则别的页面会一直顶着没有状态栏的布局。
    unawaited(SystemChrome.setEnabledSystemUIMode(SystemUiMode.edgeToEdge));
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
    setState(() {
      _control = on;
      if (!on) _panel = null;
    });
    if (on) {
      _hadControl = true;
      _startHaltPoll();
      _armHud();
    } else {
      _haltTimer?.cancel();
      _haltTimer = null;
      _rightOnce = false;
      _stopRepeat();
      _releaseStickyAll(rebuild: false);
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
      'no-display': 'rsErrNoDisplay',
      'wayland-session': 'rsErrWayland',
      'interrupted': 'rsErrInterrupted',
      'clipboard-unavailable': 'rsErrClipboard',
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
  // 舞台永远 direct：单指点哪打哪。触控板的「相对移动」只属于悬浮操作台。
  ({Size src, Size area})? _gestureGeometry(double dw, double dh) {
    final source = _svc.source;
    final area = _fallbackArea;
    if (source == null && area == null) return null;
    final src = source != null
        ? Size(source.width.toDouble(), source.height.toDouble())
        : Size(area!.width, area.height);
    return (src: src, area: Size(dw, dh));
  }

  void _syncTouch(double dw, double dh) {
    final geo = _gestureGeometry(dw, dh);
    if (geo == null) return;
    _touch
      ..display = geo.area
      ..source = geo.src
      ..visible = _visibleSource(geo.src)
      ..viewScale = _xform.value.getMaxScaleOnAxis()
      ..mode = RemoteTouchMode.direct
      ..rightOnce = _rightOnce;
  }

  /// 操作台：源画面与可见块跟舞台一致，位移增益固定（不按舞台尺度放大）。
  void _syncPad() {
    final source = _svc.source;
    final area = _fallbackArea;
    if (source == null && area == null) return;
    final src = source != null
        ? Size(source.width.toDouble(), source.height.toDouble())
        : Size(area!.width, area.height);
    _pad
      ..display = const Size(remotePodPad, remotePodPad)
      ..source = src
      ..visible = _visibleSource(src)
      ..viewScale = 1
      ..mode = RemoteTouchMode.trackpad
      ..motionGain = _padGain
      ..rightOnce = _rightOnce;
  }

  void _onPointerDown(PointerDownEvent e, double dw, double dh) {
    _railHideForInput(); // 只看模式也适用：摸画面就让位
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
    final g = _stageGeo;
    if (g != null && _touch.dragging) {
      _autoPanToward(
        MatrixUtils.transformPoint(
          _xform.value,
          e.localPosition + Offset(g.offX, g.offY),
        ),
      );
    }
  }

  void _onPointerUp(PointerEvent e, double dw, double dh) {
    _railReturnSoon();
    _syncTouch(dw, dh);
    if (e is PointerCancelEvent || !_control) {
      _touch.cancel(e.pointer);
    } else {
      _touch.up(e.pointer, e.localPosition, e.position, e.timeStamp);
    }
    // 按下+松开走完一轮：一次性修饰键到此放开（锁定态不受影响）。
    if (_pointerUsed) {
      _pointerUsed = false;
      _consumeOneShots();
    }
  }

  /// 放大后拖到舞台边缘：朝那一侧推画面，远端指针能一直走到画面外沿。
  /// 边缘带 = 24px 或舞台轴长的 8%（取大），每次移动最多推 16px。
  /// [view] 是手指（或触控板虚拟光标）在视口里的位置。
  void _autoPanToward(Offset view) {
    final g = _stageGeo;
    if (g == null) return;
    final m = _xform.value;
    final s = m.getMaxScaleOnAxis();
    if (s <= 1.01) return;
    final bandX = math.max(24.0, g.vp.width * 0.08);
    final bandY = math.max(24.0, g.vp.height * 0.08);
    double push(double v, double len, double band) {
      if (v < band) return (band - v).clamp(0.0, 16.0).toDouble();
      if (v > len - band) {
        return -(v - (len - band)).clamp(0.0, 16.0).toDouble();
      }
      return 0;
    }

    final dx = push(view.dx, g.vp.width, bandX);
    final dy = push(view.dy, g.vp.height, bandY);
    if (dx == 0 && dy == 0) return;
    _clampingView = true;
    try {
      _xform.value = Matrix4.identity()
        ..translate(m.entry(0, 3) + dx, m.entry(1, 3) + dy)
        ..scale(s);
    } finally {
      _clampingView = false;
    }
    _keepViewInBounds(); // 推到内容边界就停，不留空边
    // 单指拖拽时 InteractiveViewer 的 onInteractionUpdate 每帧把矩阵写回
    // 手势起点（它以为单指不该动画面）。自动平移要成为新的起点，否则下一个
    // 移动事件就把平移撤销掉。
    _xformAtStart = _xform.value.clone();
  }

  // ── 悬浮操作台 ──
  Offset? _padViewportPoint() {
    final g = _stageGeo;
    final src = _pad.source;
    if (g == null || src.width <= 0 || src.height <= 0) return null;
    return MatrixUtils.transformPoint(
      _xform.value,
      Offset(
        _pad.cursor.dx / src.width * g.dw + g.offX,
        _pad.cursor.dy / src.height * g.dh + g.offY,
      ),
    );
  }

  /// 操作台与舞台共用 JPEG 回退的几何（点哪映射到哪块）。
  void _ensureFallbackArea() {
    if (_svc.source == null && _svc.fallbackJpeg != null) {
      _fallbackArea ??=
          _svc.viewRegion ??
          ScreenRegion(
            0,
            0,
            _svc.fallbackWidth.toDouble(),
            _svc.fallbackHeight.toDouble(),
          );
    }
  }

  void _podDown(int pointer, Offset global, Duration t) {
    if (!_control) return;
    if (_svc.source == null && _svc.fallbackJpeg == null) return;
    _ensureFallbackArea();
    _syncPad();
    _padLastGlobal = global;
    _pad.down(pointer, Offset.zero, global, t);
  }

  void _podMove(int pointer, Offset global, Duration t) {
    if (!_control) return;
    _syncPad();
    _padLastGlobal = global;
    _pad.move(pointer, Offset.zero, global, t);
    if (_pad.dragging) {
      final at = _padViewportPoint();
      if (at != null) _autoPanToward(at);
    }
  }

  void _podUp(int pointer, Duration t) {
    _syncPad();
    _pad.up(pointer, Offset.zero, _padLastGlobal, t);
    if (_pointerUsed) {
      _pointerUsed = false;
      _consumeOneShots();
    }
  }

  Offset _padLastGlobal = Offset.zero;

  void _setPodCorner(RemotePodCorner corner) {
    setState(() => _podCorner = corner);
    SharedPreferences.getInstance()
        .then((prefs) => prefs.setString(_podCornerPref, corner.name))
        .catchError((Object _) => false);
  }

  void _togglePod() {
    final on = !_podVisible;
    setState(() => _podVisible = on);
    if (!on) {
      _pad.reset();
      _cursorMark.value = null;
    }
    SharedPreferences.getInstance()
        .then((prefs) => prefs.setBool(_podPref, on))
        .catchError((Object _) => false);
    _toast(on ? t('rsPodOn') : t('rsPodOff'));
  }

  // ── 幕布：侧栏 / HUD / 面板 ──
  void _toast(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(
        SnackBar(duration: const Duration(seconds: 3), content: Text(message)),
      );
  }

  // 侧栏显隐是**意图驱动**的，不是计时器驱动的：
  //   手指落到画面上 → 收起（你开始操作远端了，chrome 让位）；
  //   抬手之后静止 [_railReturn] → 回来（你停下来了，控件该在手边）。
  // 这就是所有人都已经会的视频播放器模型。原先那版 6 秒无操作就收，结果是
  // 「读屏思考时它消失、要用时它不回来」—— 计时器在替用户做决定。
  // 现在计时器只服务「回来」这一侧：出现比消失便宜得多。
  static const Duration _railReturn = Duration(milliseconds: 1200);

  void _railHideForInput() {
    _railTimer?.cancel();
    if (_panel != null || _keyOpen) return; // 面板开着时栏是它的锚，不收
    if (_railOpen) setState(() => _railOpen = false);
    if (_railLabels) {
      _railLabelTimer?.cancel();
      setState(() => _railLabels = false);
    }
  }

  void _railReturnSoon() {
    _railTimer?.cancel();
    if (_railOpen) return;
    _railTimer = Timer(_railReturn, () {
      if (!mounted || _railOpen) return;
      setState(() => _railOpen = true);
    });
  }

  void _startRailLabels() {
    setState(() {
      _railLabels = true;
      _railOpen = true;
    });
    _railLabelTimer?.cancel();
    _railLabelTimer = Timer(const Duration(seconds: 3), () {
      if (mounted) setState(() => _railLabels = false);
    });
  }

  void _armHud() {
    _hudTimer?.cancel();
    final wasOff = !_hudOn;
    if (wasOff) setState(() => _hudOn = true);
    _hudTimer = Timer(const Duration(seconds: 4), () {
      if (!mounted) return;
      if (_statusErr != null || _frameAgeShown) return; // 告警常驻
      setState(() => _hudOn = false);
    });
  }

  // 侧栏只放**动作**，而且只放四个：返回 / 指针 / 键盘 / 更多。
  //
  // 原先是七项（返回·指针·键盘·宿主·视图·剪贴板·状态）—— 七个等权图标是菜单，
  // 不是工具栏，而且横屏手机放不下，只能靠 FittedBox 等比缩小到约 36dp，低于
  // 自己定的 44dp 命中区底线。按真实频次分：键盘高频、指针是开关、返回一次，
  // 其余四个（视图·剪贴板·宿主·状态）合起来就是一个「工具」面板，收进「更多」。
  List<RemoteRailEntry> _railEntries() => [
    RemoteRailEntry(
      id: 'back',
      icon: Icons.keyboard_arrow_left_rounded,
      label: t('rsRailBack'),
      short: t('rsRailShortBack'),
    ),
    if (_control)
      RemoteRailEntry(
        id: 'pointer',
        icon: _podVisible ? Icons.mouse_rounded : Icons.mouse_outlined,
        label: t('rsRailPointer'),
        short: t('rsRailShortPointer'),
        active: _podVisible,
      ),
    if (_control)
      RemoteRailEntry(
        id: 'keys',
        icon: Icons.keyboard_alt_outlined,
        label: t('rsRailKeys'),
        short: t('rsRailShortKeys'),
        active: _keyOpen,
      ),
    RemoteRailEntry(
      id: 'more',
      icon: Icons.tune_rounded,
      label: t('rsRailMore'),
      short: t('rsRailShortMore'),
      active: _panel != null,
      danger: _halted || _statusErr != null,
    ),
  ];

  void _onRail(String id) {
    switch (id) {
      case 'back':
        Navigator.of(context).maybePop();
        return;
      case 'pointer':
        _togglePod();
        return;
      case 'keys':
        _toggleKeyPanel();
        return;
      default:
        setState(() {
          _panel = _panel == id ? null : id;
          _railOpen = true;
          if (_panel != null) _keyOpen = false; // 两块浮层不同时占着下半屏
        });
    }
  }

  void _toggleRailSide() {
    setState(() => _railLeft = !_railLeft);
    SharedPreferences.getInstance()
        .then((prefs) => prefs.setBool(_railLeftPref, _railLeft))
        .catchError((Object _) => false);
  }

  void _toggleLoupe() {
    setState(() => _loupe = !_loupe);
    SharedPreferences.getInstance()
        .then((prefs) => prefs.setBool(_loupePref, _loupe))
        .catchError((Object _) => false);
  }

  /// 键盘面板开关。**非模态**：开着的时候画面照常可点，页面把舞台按面板高度
  /// 等比缩小（而不是盖住），所以「点远端输入框 → 打字 → 点下一个框」这个循环
  /// 不需要反复开关面板，坐标映射也自动保持正确（见 RemoteKeySheet 文件头）。
  void _toggleKeyPanel() {
    if (!_control) return;
    setState(() {
      _keyOpen = !_keyOpen;
      if (_keyOpen) {
        _panel = null;
        _railOpen = true;
      } else {
        _keyGrid = false;
      }
    });
    // 收起时把系统键盘一起放下；粘住的修饰键不动，底部浮条会接着显示。
    if (!_keyOpen) FocusManager.instance.primaryFocus?.unfocus();
  }

  /// 键位网格展开 / 收起：收起时只占输入行 + 修饰键，画面少让出约 170dp。
  void _toggleKeyGrid() => setState(() => _keyGrid = !_keyGrid);

  /// 面板本体高度（不含系统键盘与安全区）：页面据此缩小舞台，两者加起来正好
  /// 铺满底部，不留缝也不重叠。口径由组件自己给，避免页面与布局漂开。
  double get _keyPanelBody => remoteKeyPanelHeight(gridOpen: _keyGrid);

  /// 按住连发：立即一发，400ms 后每 70ms 一发（退格 / 前向 Delete / 方向键）。
  void _startRepeat(String spec) {
    _pressSpec(spec);
    _stopRepeat();
    _repeatTimer = Timer(const Duration(milliseconds: 400), () {
      _repeatTimer = Timer.periodic(
        const Duration(milliseconds: 70),
        (_) => _pressSpec(spec),
      );
    });
  }

  // ── 放大 / 框选 ──
  void _zoomTo(double scale) {
    final g = _stageGeo;
    if (g == null) return;
    if (_svc.region != null) _svc.selectRegion(null);
    final f = Offset(g.vp.width / 2, g.vp.height / 2);
    _xform.value = Matrix4.identity()
      ..translate(f.dx, f.dy)
      ..scale(scale)
      ..translate(-f.dx, -f.dy);
    _onZoomUpdate(g.vp, g.offX, g.offY, g.dw, g.dh);
  }

  void _resetZoom() {
    final g = _stageGeo;
    if (g == null) return;
    if (_svc.region != null) _svc.selectRegion(null);
    _xform.value = Matrix4.identity();
    _onZoomUpdate(g.vp, g.offX, g.offY, g.dw, g.dh);
  }

  void _toggleBoxSel() {
    _touch.reset();
    setState(() {
      _boxSelOn = !_boxSelOn;
      _boxRect = null;
      if (_boxSelOn) _panel = null;
    });
  }

  // ── 剪贴板：只在点按时搬运 ──
  Future<void> _readRemoteClipboard() async {
    final res = await _svc.readClipboard();
    if (!mounted) return;
    if (res['ok'] != true) {
      _showErr(res);
      return;
    }
    final text = res['text'] as String? ?? '';
    if (text.isEmpty) {
      _toast(t('rsClipEmpty'));
      return;
    }
    await Clipboard.setData(ClipboardData(text: text));
    if (!mounted) return;
    _toast(
      res['truncated'] == true
          ? t('rsClipCopiedTruncated', {'n': text.runes.length.toString()})
          : t('rsClipCopied', {'n': text.runes.length.toString()}),
    );
  }

  Future<void> _sendLocalClipboard({bool paste = false}) async {
    String text = '';
    try {
      final data = await Clipboard.getData(Clipboard.kTextPlain);
      text = data?.text ?? '';
    } catch (_) {}
    if (!mounted) return;
    if (text.isEmpty) {
      _toast(t('rsClipEmpty'));
      return;
    }
    final res = await _svc.writeClipboard(text);
    if (!mounted) return;
    if (res['ok'] != true) {
      _showErr(res);
      return;
    }
    if (paste) {
      await _pressSpec(_remapSpec('cmd+v'));
      if (mounted) _toast(t('rsClipPasted'));
    } else {
      _toast(t('rsClipSent'));
    }
  }

  /// 视口里看得见的那块源画面（源像素）。单指不推画面，触控板光标就限制在这里。
  Rect? _visibleSource(Size src) {
    final g = _stageGeo;
    if (g == null || g.dw <= 0 || g.dh <= 0) return null;
    final inv = Matrix4.inverted(_xform.value);
    final off = Offset(g.offX, g.offY);
    final a = MatrixUtils.transformPoint(inv, Offset.zero) - off;
    final b =
        MatrixUtils.transformPoint(inv, g.vp.bottomRight(Offset.zero)) - off;
    return Rect.fromPoints(
      Offset(a.dx / g.dw * src.width, a.dy / g.dh * src.height),
      Offset(b.dx / g.dw * src.width, b.dy / g.dh * src.height),
    );
  }

  /// 滚轮一格（[up] 为真向上滚）。live 走 RFB 指针位：Agent 只认
  /// 0x08/0x10 相对上一帧的上升沿，所以每格后面必须补一个 mask=0 的
  /// 抬起，否则同向连点第二下会被静默吞掉（与 RemoteTouchController 一致）。
  /// fallback 走 HTTP scroll，多格合并成一趟串行循环。
  void _wheelNotch(bool up) {
    if (!_control) return;
    final source = _svc.source;
    if (source != null) {
      final x = _hasPointer ? _lastX : source.width ~/ 2;
      final y = _hasPointer ? _lastY : source.height ~/ 2;
      source.pointerEvent(up ? 0x08 : 0x10, x, y);
      source.pointerEvent(0, x, y); // 抬起，下一格才算新的沿
      _inputSinceFrame = true;
      return;
    }
    if (_svc.fallbackJpeg == null) return;
    _scrollPending += up ? 3 : -3; // 一格 = 3 行，与 Agent 的 notch 同量
    if (!_scrollBusy) unawaited(_drainScroll());
  }

  Future<void> _drainScroll() async {
    _scrollBusy = true;
    try {
      final area = _fallbackArea;
      final region = _svc.viewRegion;
      final int x;
      final int y;
      if (_hasPointer && area != null) {
        x = (area.x + _lastX).round();
        y = (area.y + _lastY).round();
      } else if (region != null) {
        x = (region.x + region.width / 2).round();
        y = (region.y + region.height / 2).round();
      } else {
        // 还不知道逻辑屏幕尺寸时退回整屏中心。
        x = _svc.fallbackWidth ~/ 2;
        y = _svc.fallbackHeight ~/ 2;
      }
      while (_scrollPending != 0 && mounted) {
        final amount = _scrollPending.clamp(-50, 50).toInt();
        _scrollPending -= amount;
        final mods = _stickyHttpMods();
        final res = await _svc.inputOp({
          'op': 'scroll',
          'x': x,
          'y': y,
          'amount': amount,
          if (mods.isNotEmpty) 'mods': mods,
        });
        if (!mounted) return;
        if (res['ok'] == false) {
          _scrollPending = 0; // 报错就丢掉积压，不无限重试
          _showErr(res);
          return;
        }
        _inputSinceFrame = true;
      }
    } finally {
      _scrollBusy = false;
    }
  }

  // Fixed logical source geometry for the current fallback gesture.
  ScreenRegion? _fallbackArea;

  // ── 粘住的修饰键 ──
  /// 兼容模式 HTTP `mods`（按服务端顺序 shift,ctrl,alt,cmd）。[spec] 里已经
  /// 含有的修饰键不重复带：`⌘A` 配锁定的 ⌘ 只发一次。
  List<String> _stickyHttpMods([String? spec]) {
    final names = _sticky.httpNames;
    if (names.isEmpty) return const [];
    if (spec == null) return names;
    final parts = spec.split('+').map((p) => p.toLowerCase()).toSet();
    return [
      for (final name in names)
        if (!parts.contains(name)) name,
    ];
  }

  /// 流式通道真的按下/松开修饰键；兼容模式没有 KeyEvent 通道，只改状态，
  /// 等下一次指针/滚轮/按键请求带上 `mods`。
  void _emitSticky(StickyModifierTransition tr, {bool rebuild = true}) {
    final source = _svc.source;
    if (source != null) {
      for (final chip in tr.down) {
        source.keyEvent(true, chip.keysym);
      }
      for (final chip in tr.up) {
        source.keyEvent(false, chip.keysym);
      }
    }
    if (rebuild && mounted) setState(() {});
  }

  void _tapSticky(StickyModifierKey chip) => _emitSticky(_sticky.tap(chip));

  /// 一次性修饰键用掉了（指针一轮或一次按键之后）。
  void _consumeOneShots() {
    final tr = _sticky.consumeOneShots();
    if (tr.up.isNotEmpty) _emitSticky(tr);
  }

  /// 离开操作模式 / 切模式 / 进后台 / 断线：所有按着的修饰键全部放开。
  void _releaseStickyAll({bool rebuild = true}) =>
      _emitSticky(_sticky.releaseAll(), rebuild: rebuild);

  /// 当前点亮（一次性或锁定）的修饰键 keysym，按键和弦先按它们。
  List<int> _stickyKeysyms() => [
    for (final chip in StickyModifiers.definitions)
      if (_sticky.stateOf(chip.id) != StickyModifierState.off) chip.keysym,
  ];

  // ── 键盘条 ──
  Future<void> _sendText() async {
    final text = _textCtrl.text;
    if (text.isEmpty) return;
    if (_svc.mode == RemoteScreenMode.live) {
      _svc.source?.typeText(text);
      _textCtrl.clear();
      _consumeOneShots();
      return;
    }
    final res = await _svc.inputOp({'op': 'type', 'text': text});
    if (!mounted) return;
    if (res['ok'] == false) {
      _showErr(res);
    } else {
      _textCtrl.clear();
      _consumeOneShots();
    }
  }

  Future<void> _pressSpec(String spec) async {
    if (!_control) return;
    if (_svc.mode != RemoteScreenMode.live) {
      final mods = _stickyHttpMods(spec);
      final res = await _svc.inputOp({
        'op': 'press',
        'keys': spec,
        if (mods.isNotEmpty) 'mods': mods,
      });
      if (!mounted) return;
      if (res['ok'] == false) {
        _showErr(res);
      } else {
        _consumeOneShots();
      }
      return;
    }
    final source = _svc.source;
    if (source == null) return;
    // 粘住的修饰键已经在流里真的按着：和弦里不能重复按、更不能替它松开
    // （否则锁定的 ⌘ 会被一次 ⌘S 释放掉）。只补 spec 里还没按着的修饰键。
    final held = _stickyKeysyms();
    final mods = <int>{};
    var keysym = -1;
    for (final part in spec.split('+')) {
      final mod = _modifierKeysyms[part.toLowerCase()];
      if (mod != null) {
        if (!held.contains(mod)) mods.add(mod);
        continue;
      }
      final named = _namedKeysyms[part.toLowerCase()];
      if (named != null) {
        keysym = named;
      } else if (part.runes.length == 1) {
        // 多字节字符（中文标点等）要打 tagged keysym，否则会被当成控制键。
        keysym = keysymForText(part.runes.first);
      }
    }
    if (keysym < 0) return;
    _inputSinceFrame = true;
    if (mods.isEmpty) {
      source.keyEvent(true, keysym);
      source.keyEvent(false, keysym);
    } else {
      source.chord(mods.toList(), keysym);
    }
    _consumeOneShots();
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
    final media = MediaQuery.of(context);
    final safe = media.padding;
    final actions = remoteHostActions(_svc.hostModifier);
    final ime = media.viewInsets.bottom;
    // 键盘面板占住的底部高度 = 面板本体 + 系统键盘（没有系统键盘时补底部安全区）。
    // 舞台按这个高度**让出**而不是被盖住：画面还在、还能点，而且 contain 几何
    // 重新算一遍，「点哪打哪」的坐标映射自动跟着正确。
    final keyTaken = _keyOpen
        ? _keyPanelBody + (ime > 0 ? ime : safe.bottom)
        : 0.0;
    final phone = media.size.shortestSide < 600;
    return Scaffold(
      backgroundColor: const Color(0xFF06080c),
      // 底部占用自己算（面板 + IME），不让 Scaffold 再推一次布局。
      resizeToAvoidBottomInset: false,
      // 幕布：画面铺满整个 body（含状态栏下方），chrome 全部是浮层。
      body: Stack(
        children: [
          Positioned(
            left: 0,
            right: 0,
            top: 0,
            bottom: keyTaken,
            child: _stage(),
          ),
          // 安全信息（权限 / 急停）永远整宽置顶，HUD 排在它下面。
          Positioned(
            top: safe.top + 6,
            left: 0,
            right: 0,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                if (_permGate != null) _permBanner(),
                if (_halted) _haltBanner(),
                const SizedBox(height: 6),
                if (_hudVisible) Center(child: _hud()),
                if (_boxSelOn)
                  Padding(
                    padding: const EdgeInsets.only(top: 6),
                    child: Center(child: _boxHint()),
                  ),
              ],
            ),
          ),
          // 侧栏：竖屏右侧、可切到左侧（单手习惯）；摸画面就收、抬手停顿就回。
          Positioned.fill(
            left: _railLeft ? safe.left + 6 : null,
            right: _railLeft ? null : safe.right + 6,
            top: safe.top + 56,
            bottom: safe.bottom + 56 + keyTaken,
            child: Align(
              alignment: _railLeft
                  ? Alignment.centerLeft
                  : Alignment.centerRight,
              // 四项 44dp 在任何手机尺寸下都放得下（横屏 iPhone 可用约 260dp，
              // 内容 184dp）；这层 FittedBox 只是极窄视口下的溢出兜底。
              child: FittedBox(
                fit: BoxFit.scaleDown,
                child: RemoteRail(
                  entries: _railEntries(),
                  expanded: _railOpen,
                  showLabels: _railLabels,
                  onLeft: _railLeft,
                  onExpand: () {
                    _railTimer?.cancel();
                    setState(() => _railOpen = true);
                  },
                  onAction: _onRail,
                ),
              ),
            ),
          ),
          if (_panel != null) _panelOverlay(media, safe, actions, phone),
          // 悬浮操作台：非模态，舞台的单指语义不受它影响。
          if (_control && _podVisible && !_boxSelOn)
            RemoteControlPod(
              viewport: media.size,
              // 键盘面板开着时操作台自动停在它上沿，不被压住。
              padding: safe.copyWith(bottom: safe.bottom + keyTaken),
              corner: _podCorner,
              onCorner: _setPodCorner,
              onPointerDown: _podDown,
              onPointerMove: _podMove,
              onPointerUp: _podUp,
              padLabel: t('rsPadTitle'),
              dragLabel: t('rsPadDrag'),
            ),
          if (_keyOpen)
            Positioned(
              left: 0,
              right: 0,
              bottom: 0,
              height: keyTaken,
              child: RemoteKeySheet(
                textController: _textCtrl,
                onSend: _sendText,
                sticky: _sticky,
                onSticky: _tapSticky,
                onSpec: _pressSpec,
                onRepeatStart: _startRepeat,
                onRepeatStop: _stopRepeat,
                specs: [..._keyBarSpecs, ..._moreKeySpecs],
                repeatSpecs: _repeatSpecs,
                remapLabel: _remapLabel,
                remapSpec: _remapSpec,
                onClose: _toggleKeyPanel,
                gridOpen: _keyGrid,
                onToggleGrid: _toggleKeyGrid,
                onPaste: () => _sendLocalClipboard(paste: true),
                bottomInset: ime > 0 ? ime : safe.bottom,
              ),
            ),
          // 修饰键浮条：键盘面板收起后仍然看得见「⌘ 还按着」。
          if (_control && !_keyOpen && _sticky.anyActive)
            Positioned(
              bottom: safe.bottom + 14,
              left: 0,
              right: 0,
              child: Center(
                child: RemoteStickyStrip(sticky: _sticky, onSticky: _tapSticky),
              ),
            ),
        ],
      ),
    );
  }

  // 只看模式下 HUD 常驻：「只看 / 操作」是**状态**，所以开关长在状态上。
  // 原先这件事挂在侧栏「指针」图标上，一个图标随状态换语义（没操作权时是
  // 「取操作权」、有操作权时是「操作台开关」）—— 方案的立意正是消灭模式歧义。
  bool get _hudVisible =>
      _statusErr != null || _frameAgeShown || _hudOn || !_control;

  /// 顶部 HUD：正常读数出现几秒就淡出；错误与「画面冻住」常驻。
  Widget _hud() {
    final source = _svc.source;
    final h264 = source is RemoteScreenH264 ? source : null;
    if (_svc.mode != RemoteScreenMode.live || h264 == null) {
      return _hudBody(null, null);
    }
    return ValueListenableBuilder<RemoteRateStats>(
      valueListenable: h264.rateStats,
      builder: (_, stats, __) => ValueListenableBuilder<RemoteLinkPath>(
        valueListenable: _svc.linkPath,
        builder: (_, path, __) => _hudBody(stats, path),
      ),
    );
  }

  Widget _hudBody(RemoteRateStats? net, RemoteLinkPath? path) {
    final bits = _statusBits(net, path);
    final err = _statusErr != null;
    final warn = !err && _frameAgeShown && _inputSinceFrame;
    return GestureDetector(
      key: const ValueKey('rs-hud'),
      onTap: _control
          ? () => setState(() {
              _panel = 'more';
              _keyOpen = false;
            })
          : () {
              _setControl(true);
              _armHud();
            },
      child: Container(
        constraints: const BoxConstraints(maxWidth: 330),
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
        decoration: BoxDecoration(
          color: const Color(0xCC161b26),
          borderRadius: BorderRadius.circular(14),
          border: Border.all(
            color: err
                ? const Color(0x99e07a7a)
                : warn
                ? const Color(0x99e0b45a)
                : const Color(0xFF2a3242),
          ),
        ),
        child: Text(
          bits.join('  ·  '),
          maxLines: 2,
          overflow: TextOverflow.ellipsis,
          textAlign: TextAlign.center,
          style: TextStyle(
            fontSize: 11.5,
            color: err
                ? const Color(0xFFe07a7a)
                : warn
                ? const Color(0xFFe0b45a)
                : const Color(0xFF9fb0c6),
          ),
        ),
      ),
    );
  }

  Widget _boxHint() {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(
        color: const Color(0xCC161b26),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: const Color(0xFF4da3ff)),
      ),
      child: Text(
        t('rsBoxSelHint'),
        style: const TextStyle(fontSize: 11.5, color: Color(0xFFdce6f1)),
      ),
    );
  }

  /// 「更多」面板的落点按设备分：
  ///  · **手机 = 底部 sheet。** 原先锚在右上角（`top: safe.top + 56`），面板里的
  ///    按钮全落在单手拇指到不了的那块；底部弹出才是手机上的通用习惯，而且和
  ///    键盘面板同一个方向。带半透明遮罩，点外面收起（sheet 的既有语义）。
  ///  · **平板 = 贴着侧栏的锚定浮层。** 平板上哪儿都够得到，小卡片不挡画面，
  ///    所以不加遮罩：再点一次侧栏「更多」或面板右上角的 × 就收。
  Widget _panelOverlay(
    MediaQueryData media,
    EdgeInsets safe,
    List<RemoteHostAction> actions,
    bool phone,
  ) {
    Widget card(BorderRadius radius, EdgeInsets padding) => Material(
      key: const ValueKey('rs-panel'),
      color: const Color(0xF2161b26),
      elevation: 8,
      borderRadius: radius,
      child: SingleChildScrollView(
        padding: padding,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: _panelContent(actions),
        ),
      ),
    );
    if (!phone) {
      return Positioned(
        top: safe.top + 56,
        left: _railLeft ? safe.left + 58 : null,
        right: _railLeft ? null : safe.right + 58,
        width: math.min(286, media.size.width - 78),
        child: ConstrainedBox(
          constraints: BoxConstraints(maxHeight: media.size.height * 0.66),
          child: card(
            BorderRadius.circular(12),
            const EdgeInsets.fromLTRB(12, 6, 12, 12),
          ),
        ),
      );
    }
    return Positioned.fill(
      child: Stack(
        children: [
          Positioned.fill(
            child: GestureDetector(
              key: const ValueKey('rs-panel-scrim'),
              behavior: HitTestBehavior.opaque,
              onTap: () => setState(() => _panel = null),
              child: const ColoredBox(color: Color(0x59000000)),
            ),
          ),
          Positioned(
            left: 0,
            right: 0,
            bottom: 0,
            child: ConstrainedBox(
              constraints: BoxConstraints(maxHeight: media.size.height * 0.7),
              child: card(
                const BorderRadius.vertical(top: Radius.circular(16)),
                EdgeInsets.fromLTRB(14, 6, 14, 12 + safe.bottom),
              ),
            ),
          ),
        ],
      ),
    );
  }

  /// 「更多」面板：视图 / 剪贴板 / 宿主 / 状态 四节按频次排在一个滚动视图里。
  /// 四个独立入口是照抄结构，用户心里只有一个「工具」对象。
  List<Widget> _panelContent(List<RemoteHostAction> actions) => [
    Row(
      children: [
        Expanded(child: _panelTitle(t('rsRailMore'))),
        IconButton(
          key: const ValueKey('rs-panel-close'),
          onPressed: () => setState(() => _panel = null),
          icon: const Icon(Icons.close_rounded, size: 18),
          color: const Color(0xFF9fb0c6),
          visualDensity: VisualDensity.compact,
        ),
      ],
    ),
    ..._viewPanel(),
    if (_control) ...[
      const Divider(color: Color(0xFF2a3242), height: 16),
      ..._clipboardPanel(),
    ],
    if (_control && actions.isNotEmpty) ...[
      const Divider(color: Color(0xFF2a3242), height: 16),
      ..._hostPanel(actions),
    ],
    const Divider(color: Color(0xFF2a3242), height: 16),
    ..._statusPanel(),
  ];

  Widget _panelTitle(String text) => Padding(
    padding: const EdgeInsets.only(bottom: 6),
    child: Text(
      text,
      style: const TextStyle(
        color: Color(0xFFdce6f1),
        fontSize: 13,
        fontWeight: FontWeight.w700,
      ),
    ),
  );

  Widget _panelLine(String text, {Color color = const Color(0xFF9fb0c6)}) =>
      Padding(
        padding: const EdgeInsets.only(bottom: 3),
        child: Text(text, style: TextStyle(fontSize: 12, color: color)),
      );

  Widget _panelButton(
    String label,
    VoidCallback? onTap, {
    bool primary = false,
  }) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: OutlinedButton(
        onPressed: onTap,
        style: OutlinedButton.styleFrom(
          foregroundColor: primary
              ? const Color(0xFF10141c)
              : const Color(0xFFdce6f1),
          backgroundColor: primary
              ? const Color(0xFF2ba67a)
              : const Color(0xFF10141c),
          side: BorderSide(
            color: primary ? const Color(0xFF2ba67a) : const Color(0xFF2a3242),
          ),
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 10),
          alignment: Alignment.centerLeft,
        ),
        child: Text(label, style: const TextStyle(fontSize: 12.5)),
      ),
    );
  }

  List<Widget> _statusPanel() {
    final source = _svc.source;
    final w = _svc.mode == RemoteScreenMode.live
        ? source?.width ?? 0
        : _svc.fallbackWidth;
    final h = _svc.mode == RemoteScreenMode.live
        ? source?.height ?? 0
        : _svc.fallbackHeight;
    final wakeHint =
        _wakeMessage ??
        (_wakeState['screenLocked'] == true && _wakeState['canWake'] == true
            ? t('rsWakeLocked')
            : _wakeState['message'] as String? ?? t('rsWakeChecking'));
    return [
      _panelTitle(t('rsPanelStatus')),
      if (w > 0 && h > 0) _panelLine('$w×$h · $_modeLabel'),
      if (_svc.mode == RemoteScreenMode.live)
        _panelLine(
          _frameAgeShown
              ? t('rsFrameAge', {'s': '$_frameAge'})
              : t('rsFps', {'fps': (_fps ?? 0).toStringAsFixed(1)}),
          color: _frameAgeShown && _inputSinceFrame
              ? const Color(0xFFe0b45a)
              : const Color(0xFF9fb0c6),
        ),
      if (_statusErr != null)
        _panelLine(_statusErr!, color: const Color(0xFFe07a7a)),
      const SizedBox(height: 6),
      _panelLine(wakeHint),
      _panelButton(
        _waking ? t('rsWaking') : t('rsWake'),
        !_waking && _wakeState['canWake'] == true ? _wakeScreen : null,
      ),
      if (_svc.mode == RemoteScreenMode.fallback)
        _panelButton(t('rsRetryLive'), () => _svc.connectLive()),
      const Divider(color: Color(0xFF2a3242), height: 16),
      _panelButton(
        _control ? t('rsToViewOnly') : t('rsToControl'),
        () => _setControl(!_control),
      ),
    ];
  }

  List<Widget> _hostPanel(List<RemoteHostAction> actions) {
    return [
      _panelTitle(t('rsRailHost')),
      for (final action in actions)
        _panelButton(t(action.labelKey), () {
          setState(() => _panel = null);
          unawaited(_pressSpec(action.keys));
        }),
      _panelLine(t('rsHostHint')),
    ];
  }

  List<Widget> _viewPanel() {
    return [
      _panelTitle(t('rsRailView')),
      Row(
        children: [
          _zoomChip(t('rsZoomFit'), 1.0),
          const SizedBox(width: 6),
          _zoomChip('2×', 2.0),
          const SizedBox(width: 6),
          _zoomChip('3×', 3.0),
        ],
      ),
      const SizedBox(height: 6),
      _panelButton(t('rsBoxZoomTitle'), _toggleBoxSel, primary: _boxSelOn),
      _switchLine(t('rsLoupe'), _loupe, _toggleLoupe),
      _switchLine(t('rsPodVisible'), _podVisible, _togglePod),
      _switchLine(t('rsRailLeft'), _railLeft, _toggleRailSide),
      const SizedBox(height: 6),
      _panelLine(t('rsPodGain')),
      Row(
        children: [
          for (final gain in const [0.7, 1.0, 1.4]) ...[
            _gainChip(
              gain == 0.7
                  ? t('rsGainSlow')
                  : gain == 1.0
                  ? t('rsGainNormal')
                  : t('rsGainFast'),
              gain,
            ),
            const SizedBox(width: 6),
          ],
        ],
      ),
      const SizedBox(height: 4),
      _panelLine(t('rsZoomHint')),
      _panelLine(t('rsScrollHint')),
    ];
  }

  Widget _zoomChip(String label, double scale) {
    final active = (_xform.value.getMaxScaleOnAxis() - scale).abs() < 0.05;
    return OutlinedButton(
      onPressed: () => scale <= 1.0 ? _resetZoom() : _zoomTo(scale),
      style: OutlinedButton.styleFrom(
        foregroundColor: active
            ? const Color(0xFF10141c)
            : const Color(0xFFdce6f1),
        backgroundColor: active
            ? const Color(0xFF2ba67a)
            : const Color(0xFF10141c),
        side: BorderSide(
          color: active ? const Color(0xFF2ba67a) : const Color(0xFF2a3242),
        ),
        minimumSize: const Size(0, 32),
        padding: const EdgeInsets.symmetric(horizontal: 10),
      ),
      child: Text(label, style: const TextStyle(fontSize: 12)),
    );
  }

  Widget _gainChip(String label, double gain) {
    final active = (_padGain - gain).abs() < 0.01;
    return OutlinedButton(
      onPressed: () {
        setState(() => _padGain = gain);
        SharedPreferences.getInstance()
            .then((prefs) => prefs.setDouble(_podGainPref, gain))
            .catchError((Object _) => false);
      },
      style: OutlinedButton.styleFrom(
        foregroundColor: active
            ? const Color(0xFF10141c)
            : const Color(0xFFdce6f1),
        backgroundColor: active
            ? const Color(0xFF2ba67a)
            : const Color(0xFF10141c),
        side: BorderSide(
          color: active ? const Color(0xFF2ba67a) : const Color(0xFF2a3242),
        ),
        minimumSize: const Size(0, 32),
        padding: const EdgeInsets.symmetric(horizontal: 10),
      ),
      child: Text(label, style: const TextStyle(fontSize: 12)),
    );
  }

  Widget _switchLine(String label, bool value, VoidCallback onTap) {
    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 3),
        child: Row(
          children: [
            Expanded(
              child: Text(
                label,
                style: const TextStyle(
                  fontSize: 12.5,
                  color: Color(0xFFdce6f1),
                ),
              ),
            ),
            Switch(value: value, onChanged: (_) => onTap()),
          ],
        ),
      ),
    );
  }

  // 剪贴板只留两个动作。原先三个（读回来 / 写过去 / 写过去再粘贴）里，「写过去
  // 不粘贴」是「写过去再粘贴」的弱版，没人能说清什么时候该用它 —— 收成主按钮的
  // 长按。用户想的是「把这段贴到那边」和「把那边那段拿回来」，就这两件事。
  List<Widget> _clipboardPanel() {
    return [
      _panelTitle(t('rsRailClipboard')),
      GestureDetector(
        onLongPress: () => _sendLocalClipboard(),
        child: _panelButton(
          t('rsClipWritePaste'),
          () => _sendLocalClipboard(paste: true),
          primary: true,
        ),
      ),
      _panelButton(t('rsClipReadRemote'), _readRemoteClipboard),
      _panelLine(t('rsClipHint')),
    ];
  }

  /// 「延迟 120ms · 1.8 / 2.0 Mbps · 中继」；RTT 还没回来时省掉延迟一格。
  String? _netLabel(RemoteRateStats? stats, RemoteLinkPath? path) {
    if (stats == null) return null;
    final recv = (stats.recvKbps / 1000).toStringAsFixed(1);
    final target = (stats.targetKbps / 1000).toStringAsFixed(1);
    final via = switch (path) {
      RemoteLinkPath.lan => t('rsViaLan'),
      RemoteLinkPath.p2p => t('rsViaP2P'),
      _ => t('rsViaRelay'),
    };
    final rtt = stats.rttMs;
    if (rtt == null) {
      return t('rsNetStatsNoRtt', {
        'recv': recv,
        'target': target,
        'path': via,
      });
    }
    return t('rsNetStats', {
      'ms': '$rtt',
      'recv': recv,
      'target': target,
      'path': via,
    });
  }

  /// HUD 与状态面板共用的一行读数。
  List<String> _statusBits(RemoteRateStats? net, RemoteLinkPath? path) {
    final source = _svc.source;
    final w = _svc.mode == RemoteScreenMode.live
        ? source?.width ?? 0
        : _svc.fallbackWidth;
    final h = _svc.mode == RemoteScreenMode.live
        ? source?.height ?? 0
        : _svc.fallbackHeight;
    final netLabel = _netLabel(net, path);
    return <String>[
      if (!_control) t('rsViewOnlyTap'),
      if (w > 0 && h > 0) '$w×$h',
      _modeLabel,
      if (netLabel != null) netLabel,
      if (_boxSelOn) t('rsBoxSelHint'),
      if (_podVisible && _control) t('rsPadTag'),
      if (_svc.mode == RemoteScreenMode.live && _statusErr == null)
        if (_frameAgeShown)
          t('rsFrameAge', {'s': '$_frameAge'})
        else if (_fps != null)
          t('rsFps', {'fps': _fps!.toStringAsFixed(1)}),
      if (_statusErr != null) _statusErr!,
    ];
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
    return Stack(
      children: [
        Positioned.fill(
          child: ClipRect(
            child: Listener(
              onPointerDown: (e) => _viewPointers.add(e.pointer),
              onPointerUp: (e) => _viewPointers.remove(e.pointer),
              onPointerCancel: (e) => _viewPointers.remove(e.pointer),
              child: GestureDetector(
                // 只看模式允许双击缩放；可操作模式的连点留给远端。
                onDoubleTapDown: _control
                    ? null // 可操作时连点两下是远端双击，不是缩放
                    : (d) => _doubleTapZoom(d, vp, offX, offY, dw, dh),
                child: InteractiveViewer(
                  transformationController: _xform,
                  constrained: false,
                  // 单指永远不动画面（任何模式、放不放大都一样），只做鼠标。
                  // 双指走 scale 手势：InteractiveViewer 在缩放时让画面跟着两指
                  // 中点走，缩放与拖动同时进行，不依赖 panEnabled。
                  panEnabled: false,
                  scaleEnabled: true,
                  minScale: 1.0,
                  maxScale: 6.0,
                  boundaryMargin: const EdgeInsets.all(double.infinity),
                  onInteractionStart: (_) =>
                      _xformAtStart = _xform.value.clone(),
                  onInteractionUpdate: (_) {
                    final start = _xformAtStart;
                    // 不足两指（含捏合后剩下的那一指）不动画面；双指在「滚动」远端
                    // 时，InteractiveViewer 看到的微小比例抖动也不许动画面。
                    if (start != null &&
                        (_viewPointers.length < 2 || _touch.scrolling)) {
                      _xform.value = start.clone();
                      return;
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
        if (_loupe && _zoomed && !_boxSelOn)
          _loupeOverlay(vp, offX, offY, dw, dh),
        if (_zoomed || _svc.region != null) _zoomBadge(vp, offX, offY, dw, dh),
      ],
    );
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
              _svc.region != null
                  ? t('rsZoomFull', {'pct': '$_zoomPct'})
                  : '$_zoomPct%',
              style: const TextStyle(fontSize: 11.5, color: Color(0xFFdce6f1)),
            ),
          ),
        ),
      ),
    );
  }

  void _stopRepeat() {
    _repeatTimer?.cancel();
    _repeatTimer = null;
  }

  /// 放大取景器：双指放大之后，单指落点常常差几个像素，手指本身又把目标挡住了。
  /// 按住时在手指上方开一个 2.4× 的小窗，看到的就是要点的位置。
  Widget _loupeOverlay(
    Size vp,
    double offX,
    double offY,
    double dw,
    double dh,
  ) {
    return ValueListenableBuilder<_CursorMark?>(
      valueListenable: _cursorMark,
      builder: (context, mark, _) {
        final img = _image;
        final source = _svc.source;
        if (mark == null || !mark.pressed || img == null || source == null) {
          return const SizedBox.shrink();
        }
        final src = Size(source.width.toDouble(), source.height.toDouble());
        if (src.width <= 0 || src.height <= 0) {
          return const SizedBox.shrink();
        }
        final content = Offset(
          mark.pos.dx / src.width * dw + offX,
          mark.pos.dy / src.height * dh + offY,
        );
        final at = MatrixUtils.transformPoint(_xform.value, content);
        const d = 96.0;
        const lift = 78.0; // 指腹高度：窗口要整个在手指上方
        final left = (at.dx - d / 2).clamp(2.0, vp.width - d - 2);
        // 靠近上缘时翻到手指下方，而不是夹取 —— 夹取会把窗口压到目标自己身上。
        final above = at.dy - d - lift;
        final top = above >= 2
            ? above
            : (at.dy + 40).clamp(2.0, vp.height - d - 2);
        // 倍率是**相对**舞台的：固定 2.4 在 iPad 上会失效（画面 3× 时舞台本身
        // 已经约 2.0 源像素/逻辑像素，取景器只比它清楚不到两成，白挡视线）。
        final stage = _xform.value.getMaxScaleOnAxis() * (dw / src.width);
        return Positioned(
          left: left,
          top: top,
          child: IgnorePointer(
            child: CustomPaint(
              size: const Size(d, d),
              painter: _LoupePainter(
                img,
                mark.pos,
                src.width,
                src.height,
                math.max(2.4, stage * 2),
              ),
            ),
          ),
        );
      },
    );
  }

  /// 本机主修饰键跟着能力画像走：Linux/Windows 把 ⌘ 显示与发送成 Ctrl。
  String _remapLabel(String label) =>
      _svc.hostModifier == 'ctrl' ? label.replaceAll('⌘', 'Ctrl') : label;

  String _remapSpec(String spec) {
    if (_svc.hostModifier != 'ctrl') return spec;
    return spec
        .split('+')
        .map((part) => part.toLowerCase() == 'cmd' ? 'ctrl' : part)
        .join('+');
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

/// 本地光标 / 落点标记（源画面像素）。[arrow] = 来自悬浮操作台（画箭头），
/// 否则来自舞台上的直接触摸（画落点圈）。
class _CursorMark {
  const _CursorMark(this.pos, this.pressed, {this.arrow = false});
  final Offset pos;
  final bool pressed;
  final bool arrow;

  @override
  bool operator ==(Object other) =>
      other is _CursorMark &&
      other.pos == pos &&
      other.pressed == pressed &&
      other.arrow == arrow;

  @override
  int get hashCode => Object.hash(pos, pressed, arrow);
}

/// 触摸模式画一个落点圈；操作台画箭头光标。
class _CursorPainter extends CustomPainter {
  _CursorPainter(this.mark, this.srcW, this.srcH);
  final _CursorMark? mark;
  final double srcW;
  final double srcH;

  @override
  void paint(Canvas canvas, Size size) {
    final m = mark;
    if (m == null || srcW <= 0 || srcH <= 0) return;
    final p = Offset(
      m.pos.dx / srcW * size.width,
      m.pos.dy / srcH * size.height,
    );
    const accent = Color(0xFF4da3ff);
    if (m.arrow) {
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
  bool shouldRepaint(_CursorPainter old) => old.mark != mark;
}

/// 放大取景器：把指针附近的源画面按 2.4× 画进一个圆里。
class _LoupePainter extends CustomPainter {
  _LoupePainter(this.image, this.at, this.srcW, this.srcH, this.zoom);

  final ui.Image image;
  final Offset at;
  final double srcW;
  final double srcH;

  /// 逻辑像素 / 源像素。由页面按当前舞台倍率算（见 `_loupeOverlay`）。
  final double zoom;

  @override
  void paint(Canvas canvas, Size size) {
    if (srcW <= 0 || srcH <= 0) return;
    final radius = math.min(size.width, size.height) / 2;
    final center = Offset(size.width / 2, size.height / 2);
    canvas.save();
    canvas.clipPath(
      Path()..addOval(Rect.fromCircle(center: center, radius: radius)),
    );
    final span = radius * 2 / zoom;
    final src = Rect.fromCenter(center: at, width: span, height: span);
    // 边缘处让源矩形留在画面里，取景器不出现黑角。
    final clamped = Rect.fromLTWH(
      src.left.clamp(0.0, math.max(0.0, srcW - span)),
      src.top.clamp(0.0, math.max(0.0, srcH - span)),
      math.min(span, srcW),
      math.min(span, srcH),
    );
    canvas.drawImageRect(
      image,
      clamped,
      Rect.fromCircle(center: center, radius: radius),
      Paint()..filterQuality = FilterQuality.medium,
    );
    canvas.restore();
    canvas.drawCircle(
      center,
      radius - 1,
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 2
        ..color = const Color(0xCC4da3ff),
    );
    // 十字准星：圆心就是将要落下的那个点。
    final hair = Paint()
      ..color = const Color(0xCC4da3ff)
      ..strokeWidth = 1;
    canvas.drawLine(
      center - const Offset(9, 0),
      center + const Offset(9, 0),
      hair,
    );
    canvas.drawLine(
      center - const Offset(0, 9),
      center + const Offset(0, 9),
      hair,
    );
  }

  @override
  bool shouldRepaint(_LoupePainter old) =>
      !identical(old.image, image) || old.at != at || old.zoom != zoom;
}
