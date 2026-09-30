import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:xterm/xterm.dart';

import 'package:multicc_app/screens/terminal_screen.dart';

// 手机上「终端能不能用」的底线是键盘条里有没有回车和退格：软键盘的退格靠
// TerminalView 的 deleteDetection（terminal_screen 里已开），回车键则依输入法
// 而定。这两颗实体键必须在，且必须发出正确的字节。
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
}
