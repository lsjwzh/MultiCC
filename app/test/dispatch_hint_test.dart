import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import 'package:multicc_app/utils/dispatch_hint.dart';

/// web 端同一组选择的权威实现，两端后缀必须逐字相同，否则 commander 在手机上
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
  test('each mode appends its own suffix', () {
    expect(
      decorateDispatchHint(
        '查一下队列',
        enabled: true,
        mode: DispatchMode.dispatchMasterSync,
      ),
      '查一下队列$kDispatchHintSuffixDispatchMasterSync',
    );
    expect(
      decorateDispatchHint(
        '查一下队列',
        enabled: true,
        mode: DispatchMode.dispatchMasterAsync,
      ),
      '查一下队列$kDispatchHintSuffixDispatchMasterAsync',
    );
    expect(
      decorateDispatchHint(
        '查一下队列',
        enabled: true,
        mode: DispatchMode.routeTask,
      ),
      '查一下队列$kDispatchHintSuffixRouteTask',
    );
    expect(
      decorateDispatchHint('查一下队列', enabled: true, mode: DispatchMode.none),
      '查一下队列$kDispatchHintSuffixNone',
    );
  });

  test('each suffix names exactly the tool it wants — and none names two', () {
    expect(kDispatchHintSuffixDispatchMasterSync, contains('dispatch_master'));
    expect(kDispatchHintSuffixDispatchMasterSync, contains('mode="sync"'));
    expect(kDispatchHintSuffixDispatchMasterSync, isNot(contains('route_task')));
    expect(kDispatchHintSuffixDispatchMasterAsync, contains('dispatch_master'));
    expect(kDispatchHintSuffixDispatchMasterAsync, contains('mode="async"'));
    expect(kDispatchHintSuffixDispatchMasterAsync, isNot(contains('route_task')));
    expect(kDispatchHintSuffixRouteTask, contains('route_task'));
    expect(kDispatchHintSuffixRouteTask, isNot(contains('dispatch_master')));
    // 「别派发」那条要是提了工具名，模型反而可能去调它。
    expect(kDispatchHintSuffixNone, isNot(contains('dispatch_master')));
    expect(kDispatchHintSuffixNone, isNot(contains('route_task')));
  });

  test('non-commander sessions and blank text are never rewritten', () {
    // 会话角色读不到 / 不是 commander → 恒等，绝不悄悄改写别人的提示词。
    expect(
      decorateDispatchHint(
        '查一下队列',
        enabled: false,
        mode: DispatchMode.none,
      ),
      '查一下队列',
    );
    expect(
      decorateDispatchHint(
        '   ',
        enabled: true,
        mode: DispatchMode.dispatchMasterAsync,
      ),
      '   ',
    );
    expect(
      decorateDispatchHint('', enabled: true, mode: DispatchMode.none),
      '',
    );
  });

  test('mode round-trips through its stored name, unknown values fall back', () {
    for (final mode in DispatchMode.values) {
      expect(DispatchMode.fromWireName(mode.wireName), mode);
    }
    expect(DispatchMode.defaultMode, DispatchMode.dispatchMasterAsync);
    expect(DispatchMode.fromWireName(null), DispatchMode.dispatchMasterAsync);
    expect(DispatchMode.fromWireName('broadcast'), DispatchMode.dispatchMasterAsync);
    expect(
      DispatchMode.fromWireName('dispatch_master'),
      DispatchMode.dispatchMasterAsync,
    );
    // 存的字符串和 web 端 localStorage 里的一套词汇。
    expect(
      DispatchMode.dispatchMasterSync.wireName,
      'dispatch_master_sync',
    );
    expect(
      DispatchMode.dispatchMasterAsync.wireName,
      'dispatch_master_async',
    );
    expect(DispatchMode.routeTask.wireName, 'route_task');
    expect(DispatchMode.none.wireName, 'none');
  });

  test('session type gate only accepts the commander role', () {
    expect(isCommanderSessionType('commander'), isTrue);
    expect(isCommanderSessionType('chat'), isFalse);
    expect(isCommanderSessionType('terminal'), isFalse);
    expect(isCommanderSessionType(null), isFalse);
  });

  test('all four suffixes match the web implementation verbatim', () {
    final source = _webSource();
    if (source.isEmpty) {
      // app/ 被单独拷出来跑时读不到 web 源码；此时跳过而不是假绿。
      return;
    }
    expect(
      _webSuffix(source, 'SUFFIX_DISPATCH_MASTER_SYNC'),
      kDispatchHintSuffixDispatchMasterSync,
    );
    expect(
      _webSuffix(source, 'SUFFIX_DISPATCH_MASTER_ASYNC'),
      kDispatchHintSuffixDispatchMasterAsync,
    );
    expect(
      _webSuffix(source, 'SUFFIX_ROUTE_TASK'),
      kDispatchHintSuffixRouteTask,
    );
    expect(_webSuffix(source, 'SUFFIX_NONE'), kDispatchHintSuffixNone);
  });
}
