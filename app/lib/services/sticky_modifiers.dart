import 'remote_screen_rfb.dart' show RfbKeysyms;

/// 「粘住」的修饰键（⇧ ⌘ ⌥ ⌃）。纯逻辑，不碰 Widget：页面只管把它返回的
/// down/up 翻译成 KeyEvent 或 HTTP `mods`，方便单测。
///
/// 语义（与 Web 版一致，见 CONTRACT §6）：
///  · 点一下 = 一次性（one-shot）：作用于下一次指针按下+松开或一次按键，之后自动放开。
///  · 快速连点两下 = 锁定（locked）：一直按着，直到再点一下或离开操作模式。
///  · 点亮的芯片再点一下 = 放开；连点第二下在 [doubleTapWindow] 内则算锁定。
enum StickyModifierState { off, once, locked }

class StickyModifierKey {
  const StickyModifierKey({
    required this.id,
    required this.label,
    required this.keysym,
    required this.httpName,
  });

  /// 内部判重用的名字，也是 HTTP `mods` 里的名字（shift / cmd / alt / ctrl）。
  final String id;

  /// 芯片上的符号（⇧ ⌘ ⌥ ⌃），不翻译。
  final String label;

  /// RFB 修饰键 keysym（流式通道真的按下/松开的那个键）。
  final int keysym;

  /// 兼容模式 HTTP 请求 `mods` 数组里的字符串。
  final String httpName;
}

/// 一次动作要发的键：down 是先按下的，up 是要松开的。
typedef StickyModifierTransition = ({
  List<StickyModifierKey> down,
  List<StickyModifierKey> up,
});

class StickyModifiers {
  StickyModifiers({
    DateTime Function()? clock,
    this.doubleTapWindow = const Duration(milliseconds: 320),
  }) : _clock = clock ?? DateTime.now;

  /// 界面按这个顺序画芯片（⇧ ⌘ ⌥ ⌃）。
  static const List<StickyModifierKey> definitions = [
    StickyModifierKey(
      id: 'shift',
      label: '⇧',
      keysym: RfbKeysyms.shiftL,
      httpName: 'shift',
    ),
    StickyModifierKey(
      id: 'cmd',
      label: '⌘',
      keysym: RfbKeysyms.cmdL,
      httpName: 'cmd',
    ),
    StickyModifierKey(
      id: 'alt',
      label: '⌥',
      keysym: RfbKeysyms.altL,
      httpName: 'alt',
    ),
    StickyModifierKey(
      id: 'ctrl',
      label: '⌃',
      keysym: RfbKeysyms.ctrlL,
      httpName: 'ctrl',
    ),
  ];

  final Duration doubleTapWindow;
  final DateTime Function() _clock;
  final Map<String, StickyModifierState> _states = {
    for (final d in definitions) d.id: StickyModifierState.off,
  };
  String? _lastId;
  DateTime? _lastAt;

  StickyModifierState stateOf(String id) =>
      _states[id] ?? StickyModifierState.off;

  bool get anyActive =>
      _states.values.any((s) => s != StickyModifierState.off);

  /// HTTP `mods`，按服务端的规范顺序 shift, ctrl, alt, cmd。
  List<String> get httpNames => [
    for (final id in const ['shift', 'ctrl', 'alt', 'cmd'])
      if (stateOf(id) != StickyModifierState.off)
        definitions.firstWhere((d) => d.id == id).httpName,
  ];

  /// 点一下芯片：返回这次要真的按下/松开的修饰键。
  StickyModifierTransition tap(StickyModifierKey chip) {
    final now = _clock();
    final prevId = _lastId;
    final prevAt = _lastAt;
    final doubleTap =
        prevId == chip.id &&
        prevAt != null &&
        now.difference(prevAt) <= doubleTapWindow;
    _lastId = chip.id;
    _lastAt = now;
    final state = stateOf(chip.id);
    if (doubleTap && state == StickyModifierState.once) {
      // 第二下落在「刚点亮」的窗口里：锁定。键已经按着，不用再发 down。
      _states[chip.id] = StickyModifierState.locked;
      return (down: const <StickyModifierKey>[], up: const <StickyModifierKey>[]);
    }
    if (state == StickyModifierState.off) {
      _states[chip.id] = StickyModifierState.once;
      return (down: [chip], up: const <StickyModifierKey>[]);
    }
    _states[chip.id] = StickyModifierState.off;
    return (down: const <StickyModifierKey>[], up: [chip]);
  }

  /// 一次性芯片被一次指针按下+松开或一次按键用掉：返回要松开的那些。
  /// 锁定态不受影响。
  StickyModifierTransition consumeOneShots() {
    final up = <StickyModifierKey>[];
    for (final d in definitions) {
      if (_states[d.id] == StickyModifierState.once) {
        _states[d.id] = StickyModifierState.off;
        up.add(d);
      }
    }
    return (down: const <StickyModifierKey>[], up: up);
  }

  /// 离开操作模式 / 切模式 / App 进后台 / 断线：全部放开。
  StickyModifierTransition releaseAll() {
    final up = <StickyModifierKey>[];
    for (final d in definitions) {
      if (_states[d.id] != StickyModifierState.off) {
        _states[d.id] = StickyModifierState.off;
        up.add(d);
      }
    }
    _lastId = null;
    _lastAt = null;
    return (down: const <StickyModifierKey>[], up: up);
  }
}
