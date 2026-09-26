import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:multicc_app/models/message.dart';
import 'package:multicc_app/theme.dart';
import 'package:multicc_app/utils/cli_display.dart';

// App 侧的 CLI 展示表（app/lib/utils/cli_display.dart）就是 SessionCli.displayName /
// .color 的唯一来源。三端（服务端 cli-capability.js / Web provider-catalog.js / 这里）
// 的一致性由 tests/test-cli-display-parity.js 在 node 侧锁；这个文件守 App 自己的两条
// 规矩：未知 id 不冒充别的产品，以及每个枚举档位都能在这张表里查到。
void main() {
  test('every SessionCli tier resolves through the shared display table', () {
    for (final cli in SessionCli.values) {
      final entry = kCliDisplays[cli.name];
      expect(entry, isNotNull, reason: '${cli.name} 不在 kCliDisplays 里');
      expect(cli.displayName, entry!.name);
      expect(cli.color, entry.color);
      expect(cli.supportsProvider, !entry.providerless);
    }
  });

  test('unknown ids keep their own name instead of falling back to Claude', () {
    // 旧代码在这里回落成 'Claude'（dashboard 的两处 switch）：一个没见过的 CLI 会
    // 被显示成完全不同的产品，比露出内部 id 更难查。
    expect(cliDisplayName('mystery-cli'), 'mystery-cli');
    expect(cliDisplayName('claude-next'), 'claude-next');
    expect(cliDisplayName(''), '');
    expect(cliDisplayName(null), '');
    expect(cliDisplayColor('mystery-cli'), AppColors.faint);
    expect(cliShortMark('mystery-cli'), 'M');
    expect(cliShortMark(''), '?');
    expect(cliProviderless('mystery-cli'), isFalse);
  });

  test('ids are matched regardless of casing and padding', () {
    expect(cliDisplayName(' CODEX '), 'Codex Exec');
    expect(cliDisplayName('ZCode'), 'ZCode');
    expect(cliDisplayColor('codebuddy'), AppColors.codebuddy);
  });

  test('the app names match the server adapter label for the same id', () {
    expect(cliDisplayName('claude'), 'Claude Code');
    // 2026-09-26 扶正：两条常驻车道（claude-exp / codex-exp）拿产品名，两条一次性
    // 车道（claude = `claude -p`、codex = `codex exec`）保留各自的名字。
    expect(cliDisplayName('claude-exp'), 'Claude');
    expect(cliDisplayName('codex'), 'Codex Exec');
    expect(cliDisplayName('codex-exp'), 'Codex');
    expect(cliShortMark('claude-exp'), 'A');
    expect(cliShortMark('codex'), 'E');
    expect(cliShortMark('codex-exp'), 'X');
    expect(cliDisplayName('opencode'), 'OpenCode');
    expect(cliDisplayName('zcode'), 'ZCode');
    expect(cliDisplayName('qoder'), 'Qoder CN');
    expect(cliDisplayName('kimi'), 'Kimi Code');
    expect(cliDisplayName('codebuddy'), 'WorkBuddy');
    expect(cliDisplayName('dsh'), 'DSH');
    expect(cliDisplayName('gemini'), 'Gemini');
    expect(cliDisplayName('grok'), 'Grok');
  });

  test('the small line names the engine under the two promoted lanes', () {
    // 小字：扶正的两条常驻车道写它们底下的引擎，其余车道写自己的 id —— 终端里那行
    // 小字指的就是要跑的命令。
    expect(cliEngine('claude-exp'), 'Claude Agent SDK');
    expect(cliEngine('codex-exp'), 'Codex App Server');
    expect(cliEngine('claude'), 'claude');
    expect(cliEngine('codex'), 'codex');
    expect(cliEngine('opencode'), 'opencode');
    expect(cliEngine('mystery-cli'), 'mystery-cli');
    expect(cliEngine(null), '');
    expect(kCliDisplays['claude-exp']!.engine, 'Claude Agent SDK');
    expect(kCliDisplays['codex-exp']!.engine, 'Codex App Server');
  });

  test('the one-shot lanes are terminal-only and the resident lanes chat-only', () {
    // `claude` 是 `claude -p`、`codex` 是 `codex exec`：chat 的选择器里没有它们，
    // 终端要把这两个可执行文件跑起来，所以它们只退出 chat。
    expect(cliOffersIn('claude', 'chat'), isFalse);
    expect(cliOffersIn('claude', 'terminal'), isTrue);
    expect(cliOffersIn('codex', 'chat'), isFalse);
    expect(cliOffersIn('codex', 'terminal'), isTrue);
    expect(cliOffersIn('claude-exp', 'chat'), isTrue);
    expect(cliOffersIn('claude-exp', 'terminal'), isFalse);
    expect(cliOffersIn('codex-exp', 'chat'), isTrue);
    expect(cliOffersIn('codex-exp', 'terminal'), isFalse);
    // 两条车道都给的（如 opencode）与没听说过的 id 一样，两种会话都给。
    expect(cliOffersIn('opencode', 'chat'), isTrue);
    expect(cliOffersIn('opencode', 'terminal'), isTrue);
    expect(cliOffersIn('mystery-cli', 'chat'), isTrue);
    expect(cliOffersIn('mystery-cli', 'terminal'), isTrue);
    // 记录里的空格与大小写不改变答案。
    expect(cliOffersIn(' CLAUDE ', ' Terminal '), isTrue);
    expect(kCliDisplays['claude']!.offersIn('chat'), isFalse);
  });

  test('only the one-shot codex lane is flagged as on its way out', () {
    // 与 Web / 服务端同一条事实（src/cli/cli-capability.js DISPLAY 的 deprecated 列），
    // 由 tests/test-cli-display-parity.js 钉住三端一致。
    expect(cliDeprecated('codex'), isTrue);
    expect(cliReplacedBy('codex'), 'codex-exp');
    expect(cliDeprecated('codex-exp'), isFalse);
    expect(cliReplacedBy('codex-exp'), isNull);
    for (final id in kCliDisplays.keys.where((id) => id != 'codex')) {
      expect(cliDeprecated(id), isFalse, reason: '$id is not on the way out');
      expect(cliReplacedBy(id), isNull);
    }
    // 没听说过的 id 与退役无关，也不该抛错。
    expect(cliDeprecated('mystery-cli'), isFalse);
    expect(cliReplacedBy('mystery-cli'), isNull);
  });

  test('the five vendor-auth CLIs are the providerless set', () {
    final providerless = kCliDisplays.entries
        .where((e) => e.value.providerless)
        .map((e) => e.key)
        .toList()
      ..sort();
    expect(providerless, ['codebuddy', 'dsh', 'gemini', 'grok', 'qoder']);
  });

  test('brand colours stay distinguishable per product family', () {
    // 每个 id 都有颜色，且同一家族的两档（claude/claude-exp、codex/codex-exp）共享
    // 品牌色是有意的 —— 名字分开，颜色不另造一个。
    for (final id in kCliDisplays.keys) {
      expect(cliDisplayColor(id), isA<Color>());
      expect(cliDisplayColor(id), isNot(AppColors.faint), reason: '$id 缺品牌色');
    }
    expect(cliDisplayColor('claude'), cliDisplayColor('claude-exp'));
    expect(cliDisplayColor('codex'), cliDisplayColor('codex-exp'));
    expect(cliDisplayColor('kimi'), isNot(cliDisplayColor('zcode')));
  });
}
