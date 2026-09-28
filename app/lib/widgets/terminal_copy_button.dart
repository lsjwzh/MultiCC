import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:xterm/xterm.dart';

/// 终端里长按选中一段文字之后浮出来的「复制」按钮。
///
/// xterm 的 `TerminalView` 在长按（`onLongPressStart`）时**只做选择**：它没有
/// iOS 那样的系统工具条，也不把长按回调给宿主 —— 手指抬起来之后，选中的文字既
/// 没有菜单也没有按钮，除了重敲一遍没有别的出口。Web 端用的是 xterm.js，长按由
/// 浏览器接管并弹出系统复制菜单，所以这条差距只出现在 App 上。
///
/// 它只监听 [controller] 与 [terminal]，不改变终端尺寸：调用方要把它浮在终端之
/// 上，不要插进 `Column` —— `TerminalView` 是 autoResize 的，任何高度变化都会
/// resize 远端 pty，让整屏输出重排。
class TerminalCopyButton extends StatefulWidget {
  const TerminalCopyButton({
    super.key,
    required this.terminal,
    required this.controller,
  });

  final Terminal terminal;
  final TerminalController controller;

  @override
  State<TerminalCopyButton> createState() => _TerminalCopyButtonState();
}

class _TerminalCopyButtonState extends State<TerminalCopyButton> {
  /// 上一次算出来的「选区还在不在」。存下来是为了让下面的通知能早退：终端每写
  /// 一段都会通知一次，结论没变就一次 setState 都不做。
  bool _hasSelection = false;

  @override
  void initState() {
    super.initState();
    _bind();
  }

  @override
  void didUpdateWidget(TerminalCopyButton old) {
    super.didUpdateWidget(old);
    if (old.controller != widget.controller || old.terminal != widget.terminal) {
      old.controller.removeListener(_recheck);
      old.terminal.removeListener(_recheck);
      _bind();
    }
  }

  @override
  void dispose() {
    widget.controller.removeListener(_recheck);
    widget.terminal.removeListener(_recheck);
    super.dispose();
  }

  void _bind() {
    widget.controller.addListener(_recheck);
    widget.terminal.addListener(_recheck);
    _hasSelection = _computeHasSelection();
  }

  bool _computeHasSelection() =>
      terminalSelectionText(widget.terminal, widget.controller) != null;

  void _recheck() {
    final has = _computeHasSelection();
    if (has == _hasSelection || !mounted) return;
    setState(() => _hasSelection = has);
  }

  Future<void> _copy() async {
    final text = terminalSelectionText(widget.terminal, widget.controller);
    if (text == null) {
      // 选区已经没了（滚出缓冲区、远端清屏）：收掉按钮，而不是复制一个空串。
      if (mounted) setState(() => _hasSelection = false);
      return;
    }
    await Clipboard.setData(ClipboardData(text: text));
    if (!mounted) return;
    widget.controller.clearSelection();
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(
        content: Text('已复制'),
        duration: Duration(milliseconds: 1200),
        behavior: SnackBarBehavior.floating,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    if (!_hasSelection) return const SizedBox.shrink();
    return GestureDetector(
      onTap: _copy,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
        decoration: BoxDecoration(
          color: const Color(0xFF0965cf),
          borderRadius: BorderRadius.circular(18),
          boxShadow: const [
            BoxShadow(
              color: Color(0x40000000),
              blurRadius: 10,
              offset: Offset(0, 2),
            ),
          ],
        ),
        child: const Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.copy_rounded, size: 16, color: Colors.white),
            SizedBox(width: 6),
            Text(
              '复制',
              style: TextStyle(
                color: Colors.white,
                fontSize: 13,
                fontWeight: FontWeight.w600,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// 当前选区的文本；没有选中、选区已脱离缓冲区、或选中的只是空白时返回 null。
///
/// 第三种情况是真的：远端清屏（`ESC[2J ESC[3J`）把格子抹成空白，但选区锚点还
/// 挂在行上，`controller.selection` 依旧非空 —— 只问「选了吗」会把一块空白当成
/// 有内容，点下去复制出来是个空串。
@visibleForTesting
String? terminalSelectionText(Terminal terminal, TerminalController controller) {
  final selection = controller.selection;
  if (selection == null) return null;
  final text = terminal.buffer.getText(selection);
  return text.trim().isEmpty ? null : text;
}
