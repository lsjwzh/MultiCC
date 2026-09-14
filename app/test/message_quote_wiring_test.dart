import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

// 引用功能的**接线守卫**。
//
// 它证明不了行为 —— 行为在 message_quote_test / message_quote_provider_test /
// message_quote_sheet_test 里测。这条守的是另一种坏法：整条链路里任何一处接口
// 悄悄断掉（没人登记输入框通道、事件没转发、气泡不问一下有没有输入框），功能
// 都是**无声消失**的 —— 不抛错、不留痕，只是少了那一行。断哪儿都得让测试说话。
//
// 同样的守卫在 Web 侧有先例（tests/test-chat-history-view.js 对 chat.js 的断言）。

String readSource(String relative) {
  final candidates = [
    File(relative),
    File('../$relative'),
  ];
  for (final file in candidates) {
    if (file.existsSync()) return file.readAsStringSync();
  }
  fail('找不到 $relative（工作目录 ${Directory.current.path}）');
}

void main() {
  test('输入框那一层把通道登记给 provider，并在销毁时摘掉', () {
    final screen = readSource('lib/screens/chat_screen.dart');
    expect(screen, contains('late final void Function(String) _quoteInserter'));
    expect(screen, contains('_syncQuoteInserter(provider);'));
    expect(screen, contains('provider.quoteInserter = _quoteInserter;'));
    // 摘除也要认得出是自己挂的：provider 比页面活得久。
    expect(screen, contains('_quoteInserterHost?.quoteInserter == _quoteInserter'));
    // 插进输入框：插在草稿上面 + 光标停在末尾 + 聚焦（折叠态会因此展开）。
    expect(
      screen,
      contains('_composerCtrl.text = composerTextWithQuote(_composerCtrl.text, block);'),
    );
    expect(screen, contains('_composerFocus.requestFocus();'));
    expect(screen, contains("import '../services/message_quote.dart';"));
  });

  test('气泡弹层问「有没有输入框」，并复用同一份文案', () {
    final bubble = readSource('lib/widgets/message_bubble.dart');
    expect(bubble, contains('buildMessageQuote(message)'));
    // 没有输入框就别摆入口 —— 摆了也点不出结果。
    expect(bubble, contains('provider?.quoteInserter == null'));
    expect(bubble, contains("I18n.of('msgQuoteAction')"));
    expect(bubble, contains("I18n.of('msgQuoteUnavailable')"));
    expect(bubble, contains("import '../services/message_quote.dart';"));
    // 没落库的消息说清楚引用不了，而不是生成一个假身份。
    expect(bubble, contains("if ((message.id ?? '').isEmpty)"));
  });

  test('归属事件从 WS 一路转到 provider，中间没人吞掉', () {
    expect(
      readSource('lib/services/chat_service.dart'),
      contains("case 'chat_history_annotation':"),
    );
    expect(
      readSource('lib/services/chat_service.dart'),
      contains("_emit('chat_history_annotation', msg);"),
    );
    // 壳要把它复合成本地 id，否则服务端按执行会话 id 指认的消息谁也认不出来。
    final view = readSource('lib/services/chat_shell_view.dart');
    expect(view, contains("case 'chat_history_annotation':"));
    final provider = readSource('lib/providers/chat_provider.dart');
    expect(provider, contains("case 'chat_history_annotation':"));
    expect(provider, contains('message.applyAttribution(record);'));
    // 就地打标：不重建列表（重建会打断正在流式的那条）。
    expect(provider, contains('if (applied > 0) notifyListeners();'));
  });
}
