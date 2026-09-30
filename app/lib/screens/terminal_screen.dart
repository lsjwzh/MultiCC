import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:xterm/xterm.dart';

import '../models/message.dart';
import '../providers/session_manager.dart';
import '../services/session_service.dart';
import '../services/settings_service.dart';
import '../services/terminal_service.dart';
import '../utils/cli_display.dart';
import '../widgets/conflict_diff_dialog.dart';
import '../widgets/terminal_copy_button.dart';
import 'memo_screen.dart';

class TerminalScreen extends StatefulWidget {
  final SettingsService settings;
  final Session session;

  const TerminalScreen({
    super.key,
    required this.settings,
    required this.session,
  });

  @override
  State<TerminalScreen> createState() => _TerminalScreenState();
}

class _TerminalScreenState extends State<TerminalScreen> {
  late TerminalService _svc;
  TerminalConnectionState _connState = TerminalConnectionState.disconnected;

  /// 用粘滞 Ctrl 版的 Terminal：键盘条的 Ctrl 键和软键盘的字母输入共享
  /// 同一个 armed 状态（见 StickyCtrlTerminal 的注释）。
  final StickyCtrlTerminal _terminal = StickyCtrlTerminal(maxLines: 5000);

  /// 长按选中的那一段文字归它管（xterm 的 TerminalView 自己建的那份拿不到），
  /// 「复制」按钮要读的就是它的 selection。
  final TerminalController _controller = TerminalController();

  @override
  void initState() {
    super.initState();
    _svc = TerminalService(
      settings: widget.settings,
      sessionId: widget.session.id,
      terminalOverride: _terminal,
    );
    _svc.onStateChange.listen((s) {
      if (mounted) setState(() => _connState = s);
    });
    _svc.connect();
  }

  @override
  void dispose() {
    _controller.dispose();
    _svc.dispose();
    _terminal.ctrlArmed.dispose();
    super.dispose();
  }

  Future<void> _confirmMerge() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        backgroundColor: const Color(0xFFffffff),
        title: const Text(
          '合并 worktree',
          style: TextStyle(fontSize: 15, color: Color(0xFF20364d)),
        ),
        content: const Text(
          '把此会话 worktree 的改动合并回基分支？\n未提交的改动会先自动提交。',
          style: TextStyle(color: Color(0xFF233249)),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('取消', style: TextStyle(color: Color(0xFF6f8096))),
          ),
          TextButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text(
              '合并',
              style: TextStyle(
                color: Color(0xFF1267b5),
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    final messenger = ScaffoldMessenger.of(context);
    messenger.showSnackBar(const SnackBar(content: Text('正在合并 worktree...')));
    try {
      final result = await SessionService(
        settings: widget.settings,
      ).mergeSession(widget.session.id);
      final hasConflict =
          result['conflicts'] is List &&
          (result['conflicts'] as List).isNotEmpty;
      String msg;
      if (result['ok'] == true) {
        msg = result['merged'] == true
            ? '✓ 已合并 ${result['commits']} 个提交回基分支'
            : '✓ ${result['message'] ?? '没有新提交需要合并'}';
      } else if (result['conflicts'] != null) {
        msg = '⚠️ 合并冲突，已 abort：${(result['conflicts'] as List).join(', ')}';
      } else {
        msg = '合并失败：${result['error'] ?? ''}';
      }
      messenger.hideCurrentSnackBar();
      messenger.showSnackBar(SnackBar(content: Text(msg)));
      if (hasConflict && mounted) {
        await showConflictDiffDialog(
          context,
          sessionId: widget.session.id,
          result: result,
        );
      }
    } catch (e) {
      messenger.hideCurrentSnackBar();
      messenger.showSnackBar(SnackBar(content: Text('合并请求失败：$e')));
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFFf4f8fd),
      appBar: PreferredSize(
        preferredSize: const Size.fromHeight(48),
        child: _TerminalAppBar(
          session: widget.session,
          connState: _connState,
          onReconnect: _svc.manualReconnect,
          onMerge: _confirmMerge,
        ),
      ),
      body: SafeArea(
        top: false,
        child: Column(
          children: [
            Expanded(
              // 浮层而不是插进 Column：TerminalView 是 autoResize 的，多一行就
              // 会 resize 远端 pty，把整屏输出重排一次。
              child: Stack(
                children: [
                  Positioned.fill(
                    child: TerminalView(
                      _terminal,
                      controller: _controller,
                      theme: _kTerminalTheme,
                      textStyle: const TerminalStyle(
                        fontSize: 13,
                        fontFamily: 'monospace',
                      ),
                      autofocus: true,
                      backgroundOpacity: 1.0,
                      padding: const EdgeInsets.all(4),
                      // 不开这个，iOS 软键盘的退格键永远敲不到 onDelete（空编辑态
                      // 下 updateEditingValue 根本不来）——手机上就「不能回退删除」。
                      deleteDetection: true,
                    ),
                  ),
                  // 长按选中文字之后才有东西可点（见 TerminalCopyButton）。
                  Positioned(
                    right: 12,
                    bottom: 12,
                    child: TerminalCopyButton(
                      terminal: _terminal,
                      controller: _controller,
                    ),
                  ),
                ],
              ),
            ),
            TerminalKeyBar(terminal: _terminal, ctrlArmed: _terminal.ctrlArmed),
          ],
        ),
      ),
    );
  }
}

class _TerminalAppBar extends StatelessWidget {
  final Session session;
  final TerminalConnectionState connState;
  final VoidCallback onReconnect;
  final VoidCallback onMerge;

  const _TerminalAppBar({
    required this.session,
    required this.connState,
    required this.onReconnect,
    required this.onMerge,
  });

  @override
  Widget build(BuildContext context) {
    Color dotColor;
    String stateLabel;
    switch (connState) {
      case TerminalConnectionState.connected:
        dotColor = const Color(0xFF1e8a55);
        stateLabel = 'Connected';
        break;
      case TerminalConnectionState.connecting:
        dotColor = const Color(0xFFa85a25);
        stateLabel = 'Connecting…';
        break;
      case TerminalConnectionState.disconnected:
        dotColor = const Color(0xFF8a9aab);
        stateLabel = 'Disconnected';
        break;
    }

    return Container(
      decoration: const BoxDecoration(
        color: Color(0xFFffffff),
        border: Border(bottom: BorderSide(color: Color(0xFFdce6f1))),
      ),
      padding: EdgeInsets.fromLTRB(
        12,
        MediaQuery.of(context).padding.top + 4,
        12,
        4,
      ),
      child: Row(
        children: [
          GestureDetector(
            onTap: () => Navigator.of(context).pop(),
            child: const Icon(
              Icons.arrow_back_rounded,
              color: Color(0xFF233249),
              size: 20,
            ),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Row(
                  children: [
                    _cliBadge(session.cli),
                    const SizedBox(width: 6),
                    Flexible(
                      child: Text(
                        session.label?.isNotEmpty == true
                            ? session.label!
                            : session.id,
                        style: const TextStyle(
                          color: Color(0xFF20364d),
                          fontWeight: FontWeight.w600,
                          fontSize: 14,
                          fontFamily: 'monospace',
                        ),
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                  ],
                ),
                Row(
                  children: [
                    Container(
                      width: 6,
                      height: 6,
                      decoration: BoxDecoration(
                        color: dotColor,
                        shape: BoxShape.circle,
                      ),
                    ),
                    const SizedBox(width: 5),
                    Text(
                      stateLabel,
                      style: const TextStyle(
                        color: Color(0xFF6f8096),
                        fontSize: 11,
                      ),
                    ),
                    const SizedBox(width: 8),
                    Text(
                      session.shortCwd,
                      style: const TextStyle(
                        color: Color(0xFF8b9cae),
                        fontSize: 11,
                        fontFamily: 'monospace',
                      ),
                      overflow: TextOverflow.ellipsis,
                    ),
                  ],
                ),
              ],
            ),
          ),
          Tooltip(
            message: '项目备忘',
            child: GestureDetector(
              onTap: () => _openMemoFromTerminal(context, session.id),
              child: const Padding(
                padding: EdgeInsets.symmetric(horizontal: 6),
                child: Icon(
                  Icons.sticky_note_2_outlined,
                  color: Color(0xFF233249),
                  size: 20,
                ),
              ),
            ),
          ),
          Tooltip(
            message: '合并 worktree',
            child: GestureDetector(
              onTap: onMerge,
              child: const Padding(
                padding: EdgeInsets.symmetric(horizontal: 6),
                child: Icon(
                  Icons.merge_type,
                  color: Color(0xFF233249),
                  size: 20,
                ),
              ),
            ),
          ),
          if (connState == TerminalConnectionState.disconnected)
            GestureDetector(
              onTap: onReconnect,
              child: const Icon(
                Icons.refresh_rounded,
                color: Color(0xFF1267b5),
                size: 20,
              ),
            ),
        ],
      ),
    );
  }
}

// Open the directory-memo screen for the terminal session's directory.
void _openMemoFromTerminal(BuildContext context, String sessionId) {
  final mgr = Provider.of<SessionManager>(context, listen: false);
  Session? s;
  for (final x in mgr.sessions) {
    if (x.id == sessionId) {
      s = x;
      break;
    }
  }
  if (s == null) {
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(const SnackBar(content: Text('Session 信息未加载')));
    return;
  }
  Directory? d;
  for (final x in mgr.directories) {
    if (x.id == s.dirId) {
      d = x;
      break;
    }
  }
  if (d == null) {
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(const SnackBar(content: Text('找不到对应工作区')));
    return;
  }
  Navigator.push(
    context,
    MaterialPageRoute<void>(
      builder: (_) => MemoScreen(directory: d!, mgr: mgr),
    ),
  );
}

Widget _cliBadge(SessionCli cli) {
  // 品牌色只有一份（utils/cli_display.dart 的家族表）。这里原先手抄了一张 11 个色值的
  // 表，其中 claude-exp 是自造的 0xFFdf7950、codex-exp 用的是 Web 的十六进制值 ——
  // 同一家族的徽标于是有两种橙、两种绿。
  final color = cliDisplayColor(cli.name);
  return Container(
    padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
    decoration: BoxDecoration(
      color: color.withOpacity(0.15),
      border: Border.all(color: color.withOpacity(0.4)),
      borderRadius: BorderRadius.circular(4),
    ),
    child: Text(
      cli.name,
      style: TextStyle(color: color, fontSize: 9, fontWeight: FontWeight.w700),
    ),
  );
}

/// 粘滞 Ctrl（Termux/Blink 惯例）：armed 时下一个字母输入自动变成 Ctrl+字母。
/// 软键盘的字母在 xterm 里走 `keyInput(keyA..keyZ)`（terminal_view 的
/// _onInsert 先按 hardware key 试），所以拦 keyInput 就同时覆盖了软键盘、
/// 键盘条和物理键盘三条来路；textInput 兜 IME 直落文本的那条路。
class StickyCtrlTerminal extends Terminal {
  StickyCtrlTerminal({super.maxLines});

  final ValueNotifier<bool> ctrlArmed = ValueNotifier<bool>(false);

  static bool _isLetter(TerminalKey key) {
    final name = key.name;
    return name.length == 4 && name.startsWith('key');
  }

  @override
  bool keyInput(
    TerminalKey key, {
    bool shift = false,
    bool alt = false,
    bool ctrl = false,
  }) {
    final armed = ctrlArmed.value && !ctrl && !alt && !shift;
    if (armed) {
      // 粘滞是一次性的：下一个键无论是什么都吃掉（Termux 行为），只有真按着
      // Ctrl 的组合键不消耗它。
      ctrlArmed.value = false;
      if (_isLetter(key)) {
        return super.keyInput(key, ctrl: true);
      }
      // 方向键等非字母键也带着 Ctrl 发（Ctrl+←→ 在 readline 里是按词跳），
      // 键位表不收的组合再按原样发一次。
      return super.keyInput(key, ctrl: true) || super.keyInput(key);
    }
    return super.keyInput(key, shift: shift, alt: alt, ctrl: ctrl);
  }

  @override
  void textInput(String text) {
    if (ctrlArmed.value && text.length == 1) {
      final c = text.codeUnitAt(0);
      final lower = c >= 0x41 && c <= 0x5A ? c + 0x20 : c;
      if (lower >= 0x61 && lower <= 0x7A) {
        ctrlArmed.value = false;
        charInput(lower, ctrl: true);
        return;
      }
    }
    super.textInput(text);
  }
}

/// Mobile-friendly key bar for common terminal keys. Public so the widget test
/// can pump it alone and assert each key emits the right byte.
class TerminalKeyBar extends StatelessWidget {
  final Terminal terminal;
  /// 粘滞 Ctrl 的开关状态。只在是 [StickyCtrlTerminal] 时由屏幕传入其自带的
  /// notifier；传 null 则不显示 Ctrl 键（退化成无粘滞的旧行为）。
  final ValueNotifier<bool>? ctrlArmed;
  const TerminalKeyBar({super.key, required this.terminal, this.ctrlArmed});

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: const BoxDecoration(
        color: Color(0xFFffffff),
        border: Border(top: BorderSide(color: Color(0xFFdce6f1))),
      ),
      padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 6),
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: Row(
          children: [
            // 回车和退格放在最左：软键盘的退格靠 deleteDetection 才工作、回车键
            // 依输入法而定，这两个是手机上「终端能不能用」的底线，必须一眼可见。
            _Key('⌫', () => terminal.keyInput(TerminalKey.backspace),
                repeat: true),
            _Key('Enter', () => terminal.keyInput(TerminalKey.enter)),
            // Ctrl+C 留成一颗实体键：中断跑飞的命令是安全操作，不该要两步。
            _Key(
              'Ctrl+C',
              () => terminal.keyInput(TerminalKey.keyC, ctrl: true),
            ),
            // 其余 Ctrl 组合（^A/^E/^W/^U/^D/^Z…）交给粘滞 Ctrl，不再逐颗枚举。
            if (ctrlArmed != null)
              _CtrlKey(ctrlArmed: ctrlArmed!),
            _Key('Tab', () => terminal.keyInput(TerminalKey.tab)),
            _Key('Esc', () => terminal.keyInput(TerminalKey.escape)),
            _Key('↑', () => terminal.keyInput(TerminalKey.arrowUp),
                repeat: true),
            _Key('↓', () => terminal.keyInput(TerminalKey.arrowDown),
                repeat: true),
            _Key('←', () => terminal.keyInput(TerminalKey.arrowLeft),
                repeat: true),
            _Key('→', () => terminal.keyInput(TerminalKey.arrowRight),
                repeat: true),
            // claude TUI 里翻长输出全靠这两个，方向键一格一格翻不动。
            _Key('PgUp', () => terminal.keyInput(TerminalKey.pageUp),
                repeat: true),
            _Key('PgDn', () => terminal.keyInput(TerminalKey.pageDown),
                repeat: true),
            _Key('Home', () => terminal.keyInput(TerminalKey.home),
                repeat: true),
            _Key('End', () => terminal.keyInput(TerminalKey.end),
                repeat: true),
          ],
        ),
      ),
    );
  }
}

/// 粘滞 Ctrl 键：点亮 = armed，下一个键消耗掉它。样式和 [_Key] 同一套，
/// 只是 armed 时换成主题蓝底白字，让「修饰键还挂着」一眼可见。
class _CtrlKey extends StatelessWidget {
  final ValueNotifier<bool> ctrlArmed;
  const _CtrlKey({required this.ctrlArmed});

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<bool>(
      valueListenable: ctrlArmed,
      builder: (context, armed, _) {
        return GestureDetector(
          // 读当前值而不是 builder 闭包里的 armed：消耗粘滞的那次 keyInput 可能
          // 还没来得及 rebuild，用旧值会把「取消」错算成「保持」。
          onTap: () => ctrlArmed.value = !ctrlArmed.value,
          child: Container(
            margin: const EdgeInsets.symmetric(horizontal: 3),
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
            decoration: BoxDecoration(
              color: armed ? const Color(0xFF1267b5) : const Color(0xFFf8fbff),
              border: Border.all(
                color: armed ? const Color(0xFF1267b5) : const Color(0xFFdce6f1),
              ),
              borderRadius: BorderRadius.circular(5),
            ),
            child: Text(
              'Ctrl',
              style: TextStyle(
                color: armed ? const Color(0xFFffffff) : const Color(0xFF233249),
                fontSize: 12,
                fontFamily: 'monospace',
                fontWeight: armed ? FontWeight.w700 : FontWeight.w400,
              ),
            ),
          ),
        );
      },
    );
  }
}

class _Key extends StatefulWidget {
  final String label;
  final VoidCallback onTap;
  /// 长按连发（Termux 行为）：按住约半秒后每 80ms 重复触发——删一行字、
  /// 连续翻页不用一下一下点。
  final bool repeat;
  const _Key(this.label, this.onTap, {this.repeat = false});

  @override
  State<_Key> createState() => _KeyState();
}

class _KeyState extends State<_Key> {
  Timer? _repeatTimer;

  void _startRepeat() {
    _repeatTimer = Timer.periodic(const Duration(milliseconds: 80), (_) {
      widget.onTap();
    });
  }

  void _stopRepeat() {
    _repeatTimer?.cancel();
    _repeatTimer = null;
  }

  @override
  void dispose() {
    _stopRepeat();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: widget.onTap,
      // 长按进入连发后 onTap 不再触发（同一手势二者取其一），
      // 抬手/取消都走 _stopRepeat 收尾。
      onLongPress: widget.repeat ? _startRepeat : null,
      onLongPressUp: _stopRepeat,
      onLongPressCancel: _stopRepeat,
      child: Container(
        margin: const EdgeInsets.symmetric(horizontal: 3),
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
        decoration: BoxDecoration(
          color: const Color(0xFFf8fbff),
          border: Border.all(color: const Color(0xFFdce6f1)),
          borderRadius: BorderRadius.circular(5),
        ),
        child: Text(
          widget.label,
          style: const TextStyle(
            color: Color(0xFF233249),
            fontSize: 12,
            fontFamily: 'monospace',
          ),
        ),
      ),
    );
  }
}

/// Terminal color theme matching web client
const _kTerminalTheme = TerminalTheme(
  cursor: Color(0xFFf0936b),
  selection: Color(0x44264f78),
  foreground: Color(0xFFe7eaee),
  background: Color(0xFF070809),
  black: Color(0xFF454b54),
  red: Color(0xFFff8a83),
  green: Color(0xFF7fd49a),
  yellow: Color(0xFFe3b341),
  blue: Color(0xFF6aa3ff),
  magenta: Color(0xFFbc8cff),
  cyan: Color(0xFF39c5cf),
  white: Color(0xFFb6bcc6),
  brightBlack: Color(0xFF5b616c),
  brightRed: Color(0xFFffb3ae),
  brightGreen: Color(0xFF56d364),
  brightYellow: Color(0xFFe3b341),
  brightBlue: Color(0xFF6aa3ff),
  brightMagenta: Color(0xFFd2a8ff),
  brightCyan: Color(0xFF56d4dd),
  brightWhite: Color(0xFFf2f4f7),
  searchHitBackground: Color(0xFFe3b341),
  searchHitBackgroundCurrent: Color(0xFF7fd49a),
  searchHitForeground: Color(0xFF070809),
);
