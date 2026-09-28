import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:xterm/xterm.dart';

import 'package:multicc_app/widgets/terminal_copy_button.dart';

// 终端长按只做选择，没有系统工具条：选中的文字必须有「复制」这个出口。
//
// 这条测的是那个出口本身 —— 选区一出现按钮就得在，点一下剪贴板里就是选中的
// 那几行（而不是空串、也不是整屏），点完选区收掉。xterm 的 render 层负责
// 「长按 → setSelection」，那是它自己的代码，这里不重复测。

Terminal terminalWith(String text) {
  final terminal = Terminal(maxLines: 100);
  terminal.write(text);
  return terminal;
}

/// 把整个缓冲区选上，等价于用户长按后一路拖到底。
void selectAll(Terminal terminal, TerminalController controller) {
  controller.setSelection(
    terminal.buffer.createAnchor(0, 0),
    terminal.buffer.createAnchor(
      terminal.viewWidth,
      terminal.buffer.height - 1,
    ),
    mode: SelectionMode.line,
  );
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('selection text is read from the live selection, null when nothing selected', () {
    final terminal = terminalWith('hello world\r\nsecond line\r\n');
    final controller = TerminalController();

    expect(terminalSelectionText(terminal, controller), isNull);

    selectAll(terminal, controller);
    final text = terminalSelectionText(terminal, controller);
    expect(text, isNotNull);
    expect(text, contains('hello world'));
    expect(text, contains('second line'));

    controller.clearSelection();
    expect(terminalSelectionText(terminal, controller), isNull);
  });

  testWidgets('copy button appears with a selection and copies exactly it', (
    tester,
  ) async {
    final terminal = terminalWith('hello world\r\nsecond line\r\n');
    final controller = TerminalController();
    addTearDown(controller.dispose);

    final copied = <String>[];
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
      SystemChannels.platform,
      (call) async {
        if (call.method == 'Clipboard.setData') {
          copied.add((call.arguments as Map)['text'] as String);
        }
        return null;
      },
    );

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Stack(
            children: [
              Positioned.fill(
                child: TerminalView(terminal, controller: controller),
              ),
              Positioned(
                right: 12,
                bottom: 12,
                child: TerminalCopyButton(
                  terminal: terminal,
                  controller: controller,
                ),
              ),
            ],
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    // 没选区 = 没有按钮。
    expect(find.text('复制'), findsNothing);

    selectAll(terminal, controller);
    await tester.pumpAndSettle();
    expect(find.text('复制'), findsOneWidget);

    await tester.tap(find.text('复制'));
    await tester.pumpAndSettle();

    expect(copied, hasLength(1));
    expect(copied.single, contains('hello world'));
    expect(copied.single, contains('second line'));

    // 复制完选区收掉，按钮跟着消失。
    expect(controller.selection, isNull);
    expect(find.text('复制'), findsNothing);
  });

  testWidgets('a selection wiped by a remote clear-screen hides the button', (
    tester,
  ) async {
    final terminal = terminalWith('only line\r\n');
    final controller = TerminalController();
    addTearDown(controller.dispose);

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Stack(
            children: [
              Positioned.fill(
                child: TerminalView(terminal, controller: controller),
              ),
              Positioned(
                right: 12,
                bottom: 12,
                child: TerminalCopyButton(
                  terminal: terminal,
                  controller: controller,
                ),
              ),
            ],
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    selectAll(terminal, controller);
    await tester.pumpAndSettle();
    expect(find.text('复制'), findsOneWidget);

    // 远端清屏：格子被抹成空白，但选区锚点还挂在行上（controller.selection 依旧
    // 非空、也不会有任何通知）—— 按钮不能傻挂着，挂着的那个点下去只会复制空串。
    terminal.write('\x1b[2J\x1b[3J\x1b[H');
    await tester.pumpAndSettle();
    expect(find.text('复制'), findsNothing);
  });
}
