import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:xterm/xterm.dart';

import 'package:multicc_app/screens/terminal_screen.dart';

// 手机上「终端能不能用」的底线是键盘条里有没有回车和退格：软键盘的退格靠
// TerminalView 的 deleteDetection（terminal_screen 里已开），回车键则依输入法
// 而定。这两颗实体键必须在，且必须发出正确的字节。
//
// 之外的三件套（Termux/Blink 的移动端惯例）也在这里钉死：
// 粘滞 Ctrl（点亮后下一个字母自动 ^X）、长按连发（⌫/方向/PgUp 按住重复）、
// PgUp/PgDn（claude TUI 翻长输出）。
void main() {
  testWidgets('TerminalKeyBar has backspace and enter, and they emit the right bytes',
      (tester) async {
    final terminal = Terminal();
    final sent = <String>[];
    terminal.onOutput = sent.add;

    await tester.pumpWidget(MaterialApp(
      home: Scaffold(body: TerminalKeyBar(terminal: terminal)),
    ));

    // 在最左，不用横滚就能看到。
    final row = tester.widget<SingleChildScrollView>(
        find.byType(SingleChildScrollView));
    expect(row.scrollDirection, Axis.horizontal, reason: 'key bar stays a single row');

    await tester.tap(find.text('⌫'));
    await tester.pump();
    await tester.tap(find.text('Enter'));
    await tester.pump();

    expect(sent.join(''), contains('\x7f'), reason: '⌫ sends DEL');
    expect(sent.join(''), contains('\r'), reason: 'Enter sends CR');
  });

  testWidgets('PgUp/PgDn keys emit the scroll escape sequences',
      (tester) async {
    final terminal = Terminal();
    final sent = <String>[];
    terminal.onOutput = sent.add;

    await tester.pumpWidget(MaterialApp(
      home: Scaffold(body: TerminalKeyBar(terminal: terminal)),
    ));

    await tester.tap(find.text('PgUp'));
    await tester.pump();
    await tester.tap(find.text('PgDn'));
    await tester.pump();

    expect(sent.join(''), contains('\x1b[5~'), reason: 'PgUp sends CSI 5~');
    expect(sent.join(''), contains('\x1b[6~'), reason: 'PgDn sends CSI 6~');
  });

  testWidgets('sticky Ctrl: next letter becomes Ctrl+letter, once',
      (tester) async {
    final terminal = StickyCtrlTerminal();
    final sent = <String>[];
    terminal.onOutput = sent.add;

    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: TerminalKeyBar(terminal: terminal, ctrlArmed: terminal.ctrlArmed),
      ),
    ));

    // 点亮 Ctrl。
    await tester.tap(find.text('Ctrl'));
    await tester.pump();
    expect(terminal.ctrlArmed.value, isTrue, reason: 'tapping Ctrl arms it');

    // 软键盘字母在 xterm 里走 keyInput(keyX)（terminal_view._onInsert 先按
    // hardware key 试），armed 时应变成 ^X。
    terminal.keyInput(TerminalKey.keyU);
    expect(sent.join(''), contains('\x15'), reason: 'armed Ctrl + u = ^U');
    expect(terminal.ctrlArmed.value, isFalse, reason: 'sticky is one-shot');

    // 消耗掉之后字母回到原样。
    sent.clear();
    terminal.keyInput(TerminalKey.keyU);
    expect(sent.join(''), isNot(contains('\x15')), reason: 'next u is a plain u');

    // 再点一次 Ctrl 可取消，不产生输出。
    await tester.tap(find.text('Ctrl'));
    await tester.pump();
    await tester.tap(find.text('Ctrl'));
    await tester.pump();
    expect(terminal.ctrlArmed.value, isFalse, reason: 'double-tap disarms');

    // textInput 兜底路径（IME 直落文本）：armed 时单个字母也转 ^X。
    sent.clear();
    terminal.ctrlArmed.value = true;
    terminal.textInput('c');
    expect(sent.join(''), contains('\x03'), reason: 'textInput path maps c to ^C');
    expect(terminal.ctrlArmed.value, isFalse);

    // 中文整串提交不 consumed：原样发送、粘滞不误伤。
    sent.clear();
    terminal.ctrlArmed.value = true;
    terminal.textInput('你好');
    expect(sent.join(''), '你好');
    expect(terminal.ctrlArmed.value, isTrue, reason: 'multi-char text keeps armed');
    terminal.ctrlArmed.value = false;
  });

  testWidgets('long-press on ⌫ repeats the delete byte',
      (tester) async {
    final terminal = Terminal();
    final sent = <String>[];
    terminal.onOutput = sent.add;

    await tester.pumpWidget(MaterialApp(
      home: Scaffold(body: TerminalKeyBar(terminal: terminal)),
    ));

    final gesture = await tester.startGesture(tester.getCenter(find.text('⌫')));
    await tester.pump(const Duration(milliseconds: 700)); // 过长按阈值
    await tester.pump(const Duration(milliseconds: 400)); // 连发 ~5 次
    await gesture.up();
    await tester.pump();

    final delCount = '\x7f'.allMatches(sent.join('')).length;
    expect(delCount, greaterThanOrEqualTo(3),
        reason: 'holding ⌫ fires repeatedly (got $delCount)');

    // 抬手后必须停。
    await tester.pump(const Duration(milliseconds: 300));
    final after = '\x7f'.allMatches(sent.join('')).length;
    expect(after, delCount, reason: 'repeat stops on release');
  });
}
