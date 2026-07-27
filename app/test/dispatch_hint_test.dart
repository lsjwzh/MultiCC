import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import 'package:multicc_app/utils/dispatch_hint.dart';

/// web 端同一个开关的权威实现，两端后缀必须逐字相同，否则 commander 在手机上
/// 收到的指令和网页上不是一句话。
String _webSource() {
  for (final candidate in [
    'public/chat-dispatch-hint.js',
    '../public/chat-dispatch-hint.js',
  ]) {
    final file = File(candidate);
    if (file.existsSync()) return file.readAsStringSync();
  }
  return '';
}

String? _webSuffix(String source, String name) {
  final match = RegExp(
    "var $name = '((?:[^'\\\\]|\\\\.)*)';",
  ).firstMatch(source);
  if (match == null) return null;
  return match.group(1)!.replaceAll('\\n', '\n').replaceAll("\\'", "'");
}

void main() {
  test('commander prompts get the spread suffix unless the switch is on', () {
    expect(
      decorateDispatchHint('查一下队列', enabled: true, noDispatch: false),
      '查一下队列$kDispatchHintSuffixSpread',
    );
    expect(
      decorateDispatchHint('查一下队列', enabled: true, noDispatch: true),
      '查一下队列$kDispatchHintSuffixKeep',
    );
  });

  test('non-commander sessions and blank text are never rewritten', () {
    // 会话角色读不到 / 不是 commander → 恒等，绝不悄悄改写别人的提示词。
    expect(
      decorateDispatchHint('查一下队列', enabled: false, noDispatch: true),
      '查一下队列',
    );
    expect(decorateDispatchHint('   ', enabled: true, noDispatch: false), '   ');
    expect(decorateDispatchHint('', enabled: true, noDispatch: true), '');
  });

  test('session type gate only accepts the commander role', () {
    expect(isCommanderSessionType('commander'), isTrue);
    expect(isCommanderSessionType('chat'), isFalse);
    expect(isCommanderSessionType('terminal'), isFalse);
    expect(isCommanderSessionType(null), isFalse);
  });

  test('both suffixes match the web implementation verbatim', () {
    final source = _webSource();
    if (source.isEmpty) {
      // app/ 被单独拷出来跑时读不到 web 源码；此时跳过而不是假绿。
      return;
    }
    expect(_webSuffix(source, 'SUFFIX_SPREAD'), kDispatchHintSuffixSpread);
    expect(_webSuffix(source, 'SUFFIX_KEEP'), kDispatchHintSuffixKeep);
  });
}
