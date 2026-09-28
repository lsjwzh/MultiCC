import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/models/message.dart';
import 'package:multicc_app/widgets/message_bubble.dart';

// 「长按 → 复制内容」必须复制到东西，而且要是这条消息里的东西。
//
// 这条链路曾经两头都断：纯工具轮（模型只发工具调用、没有正文）的消息点「复制内容」
// 静默什么都不做，用户看到的就是「长按之后没有复制功能」；长按工具输出时复制到的
// 又是正文。iOS 上没有兜底 —— 正文段落有系统工具条，代码块和工具卡都没有。
//
// 「复制内容」现在长在系统选择工具条上（长按选中 → iOS 的系统条，App 的动作追加在
// 系统条目之后，见 `_MessageSelection`），所以这里的 long-press 同时也是那条链路的
// 端到端证明：长按必须真的落到选择上，工具条才弹得出来。
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(() => I18n.init('zh'));

  late List<String> copied;

  setUp(() {
    copied = [];
    TestWidgetsFlutterBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, (call) async {
          if (call.method == 'Clipboard.setData') {
            copied.add((call.arguments as Map)['text'] as String);
          }
          return null;
        });
  });

  ToolCall bashCall() => ToolCall(
    id: 't1',
    name: 'Bash',
    inputJson: '{"command":"ls -la"}',
    result: 'drwxr-xr-x a.txt',
    isDone: true,
  );

  /// 长按 [target]，点「复制内容」，把剪贴板留下。iOS 平台，走真实手势。
  ///
  /// [expandWith] 用来先点开折叠着的工具卡（输出默认不渲染）。
  Future<void> longPressAndCopy(
    WidgetTester tester,
    ChatMessage msg,
    Finder target, {
    Finder? expandWith,
  }) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
    try {
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SingleChildScrollView(child: MessageBubble(message: msg)),
          ),
        ),
      );
      await tester.pumpAndSettle();

      if (expandWith != null) {
        await tester.tap(expandWith.first);
        await tester.pumpAndSettle();
      }

      final rect = tester.getRect(target);
      final gesture = await tester.startGesture(rect.center);
      await tester.pump(const Duration(milliseconds: 700));
      await gesture.up();
      await tester.pumpAndSettle();

      expect(find.text('复制内容'), findsOneWidget, reason: '长按没打开菜单');
      await tester.tap(find.text('复制内容'));
      await tester.pumpAndSettle();
    } finally {
      debugDefaultTargetPlatformOverride = null;
    }
  }

  test('copyable text covers the whole message, not just the prose', () {
    // 纯工具轮：没有正文，只有工具调用 —— 这里曾经返回空串。
    final toolOnly = messageCopyText(
      ChatMessage(role: MessageRole.assistant, content: '', toolCalls: [bashCall()]),
    );
    expect(toolOnly, contains('ls -la'));
    expect(toolOnly, contains('drwxr-xr-x a.txt'));

    // 正文 + 工具：两样都要在。
    final mixed = messageCopyText(
      ChatMessage(
        role: MessageRole.assistant,
        content: '我看了下目录。',
        toolCalls: [bashCall()],
      ),
    );
    expect(mixed, contains('我看了下目录。'));
    expect(mixed, contains('drwxr-xr-x a.txt'));

    // 真的什么都没有 —— 交给调用方去提示，不是在这里假装有。
    expect(
      messageCopyText(ChatMessage(role: MessageRole.assistant, content: '  ')),
      '',
    );
  });

  testWidgets('a tool-only turn copies its tool output, not nothing', (
    tester,
  ) async {
    await longPressAndCopy(
      tester,
      ChatMessage(role: MessageRole.assistant, content: '', toolCalls: [bashCall()]),
      find.textContaining('drwxr-xr-x'),
      expandWith: find.text('Bash'),
    );

    expect(copied, hasLength(1));
    expect(copied.single, contains('ls -la'));
    expect(copied.single, contains('drwxr-xr-x a.txt'));
  });

  testWidgets('选中哪几句就只复制哪几句，不是整条消息', (tester) async {
    // 「复制内容」是整条消息（含工具输出），系统工具条的「Copy / 拷贝」是**当前
    // 选中的那一段** —— 用户要的「选择性复制几句」就是后者。这里钉住的是：选中
    // 范围确实可调（长按落一个字，按住往右拖会拉长），且 Copy 只拿走选中的部分。
    const long =
        '第一句话讲的是登录接口已经改成走统一网关。'
        '第二句话讲的是老的 token 校验分支已经删掉了。'
        '第三句话讲的是回归测试补了 12 条，全部通过。';

    debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
    try {
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SingleChildScrollView(
              child: MessageBubble(
                message: ChatMessage(
                  role: MessageRole.assistant,
                  content: long,
                  id: 'm-1',
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      final bubble = tester.getRect(find.byType(MessageBubble));
      final gesture = await tester.startGesture(
        Offset(bubble.left + 60, bubble.top + 30),
      );
      await tester.pump(const Duration(milliseconds: 700));
      // 按住不放往右拖 —— 真机上就是「长按选中之后拖那一下」。
      for (var i = 0; i < 8; i++) {
        await gesture.moveBy(const Offset(30, 0));
        await tester.pump(const Duration(milliseconds: 40));
      }
      await gesture.up();
      await tester.pumpAndSettle();

      await tester.tap(find.text('Copy'));
      await tester.pumpAndSettle();

      expect(copied, hasLength(1));
      expect(copied.single, isNotEmpty);
      // 是整条消息里的一段，但不是整条 —— 拖出来的选区就这么多。
      expect(long, contains(copied.single));
      expect(copied.single.length, lessThan(long.length));
    } finally {
      debugDefaultTargetPlatformOverride = null;
    }
  });

  testWidgets('an empty message says so instead of silently doing nothing', (
    tester,
  ) async {
    await longPressAndCopy(
      tester,
      ChatMessage(
        role: MessageRole.assistant,
        content: '',
        toolCalls: [
          // isDone 必须为真：未完成的工具卡带转圈动画，pumpAndSettle 永不收敛。
          // 这个调用的 inputJson 里没有 command/file_path/description，result 也
          // 是空的 —— 正是「有工具卡但一个字都复制不出来」的那种消息。
          ToolCall(
            id: 't1',
            name: 'TodoWrite',
            inputJson: '{"todos":[]}',
            isDone: true,
          ),
        ],
      ),
      find.text('TodoWrite'),
    );

    expect(copied, isEmpty);
    expect(find.text('这条消息没有可复制的内容'), findsOneWidget);
  });
}
