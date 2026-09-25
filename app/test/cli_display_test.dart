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
    expect(cliDisplayName(' CODEX '), 'Codex');
    expect(cliDisplayName('ZCode'), 'ZCode');
    expect(cliDisplayColor('codebuddy'), AppColors.codebuddy);
  });

  test('the app names match the server adapter label for the same id', () {
    expect(cliDisplayName('claude'), 'Claude Code');
    expect(cliDisplayName('claude-exp'), 'Claude Agent SDK');
    expect(cliDisplayName('codex'), 'Codex');
    expect(cliDisplayName('codex-exp'), 'Codex Exp');
    expect(cliDisplayName('opencode'), 'OpenCode');
    expect(cliDisplayName('zcode'), 'ZCode');
    expect(cliDisplayName('qoder'), 'Qoder CN');
    expect(cliDisplayName('kimi'), 'Kimi Code');
    expect(cliDisplayName('codebuddy'), 'WorkBuddy');
    expect(cliDisplayName('dsh'), 'DSH');
    expect(cliDisplayName('gemini'), 'Gemini');
    expect(cliDisplayName('grok'), 'Grok');
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
