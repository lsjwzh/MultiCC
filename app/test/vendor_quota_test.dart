import 'package:flutter_test/flutter_test.dart';

import 'package:multicc_app/models/vendor_quota.dart';

// The app no longer formats vendor bars — the server renders them once and the
// app only resolves their {cd:}/{ago:} tokens (covered, with the web, by the
// golden parity tests in app/test/quota_bar_render_test.dart +
// tests/test-quota-bar-parity.js). What remains here is the baseUrl gating that
// decides which vendor bar to fetch, and the [vendorViewFromBar] bridge that
// turns a server bar into a paintable [VendorQuotaView].

void main() {
  group('baseUrl gating', () {
    test('ark matches *.volces.com only', () {
      expect(isArkBaseUrl('https://ark.cn-beijing.volces.com/api/coding/v3'), true);
      expect(isArkBaseUrl('https://open.volces.com/api/v3'), true);
      expect(isArkBaseUrl('https://api.moonshot.cn/v1'), false);
      expect(isArkBaseUrl('https://notvolces.com'), false);
      expect(isArkBaseUrl(''), false);
      expect(isArkBaseUrl(null), false);
    });

    test('zhipu matches z.ai / bigmodel.cn', () {
      expect(isZhipuBaseUrl('https://api.z.ai/api/paas/v4'), true);
      expect(isZhipuBaseUrl('https://open.bigmodel.cn/api/paas/v4'), true);
      expect(isZhipuBaseUrl('https://z.ai'), true);
      expect(isZhipuBaseUrl('https://api.moonshot.cn'), false);
      expect(isZhipuBaseUrl('https://notz.ai.example.com'), false);
    });

    test('kimi matches moonshot/kimi hosts', () {
      expect(isKimiBaseUrl('https://api.moonshot.cn/v1'), true);
      expect(isKimiBaseUrl('https://api.kimi.com/coding/'), true);
      expect(isKimiBaseUrl('https://api.kimi.ai'), true);
      expect(isKimiBaseUrl('https://api.z.ai'), false);
      expect(isKimiBaseUrl('https://moonshot.cn.example.com'), false);
    });

    test('arkPlanFromBaseUrl detects coding vs agent plan', () {
      expect(arkPlanFromBaseUrl('https://ark.cn-beijing.volces.com/api/coding/v3'), 'coding-plan');
      expect(arkPlanFromBaseUrl('https://ark.cn-beijing.volces.com/api/plan'), 'agent-plan');
      expect(arkPlanFromBaseUrl('https://ark.cn-beijing.volces.com/api/v3'), null);
    });

    test('host helpers pass the baseUrl host through for the ?host= query', () {
      expect(zhipuHostFromBaseUrl('https://open.bigmodel.cn/api/paas/v4'), 'open.bigmodel.cn');
      expect(kimiHostFromBaseUrl('https://api.moonshot.cn/v1'), 'api.moonshot.cn');
      expect(hostFromBaseUrl(''), '');
      expect(hostFromBaseUrl(null), '');
    });

    test('deepseek matches *.deepseek.com', () {
      expect(isDeepseekBaseUrl('https://api.deepseek.com/v1'), true);
      expect(isDeepseekBaseUrl('https://deepseek.com'), true);
      expect(isDeepseekBaseUrl('https://api.z.ai'), false);
      expect(isDeepseekBaseUrl(''), false);
      expect(isDeepseekBaseUrl(null), false);
    });
  });

  group('balanceBarVisibleFor', () {
    test('shows under codex / opencode regardless of baseUrl', () {
      expect(balanceBarVisibleFor('codex', ''), true);
      expect(balanceBarVisibleFor('opencode', null), true);
      expect(balanceBarVisibleFor('codex', 'https://api.z.ai'), true);
    });

    test('shows under any CLI when the provider points at DeepSeek', () {
      expect(balanceBarVisibleFor('zcode', 'https://api.deepseek.com/v1'), true);
      expect(balanceBarVisibleFor('claude', 'https://deepseek.com'), true);
    });

    test('hides under claude / qoder / zcode with a non-DeepSeek provider', () {
      // This is the residue the gate exists to kill: a DeepSeek balance bar must
      // not linger after switching to a CLI/provider that has no such balance.
      expect(balanceBarVisibleFor('claude', 'https://api.anthropic.com'), false);
      expect(balanceBarVisibleFor('qoder', ''), false);
      expect(balanceBarVisibleFor('zcode', 'https://open.bigmodel.cn'), false);
    });
  });

  group('vendorViewFromBar', () {
    test('returns null when there is no bar', () {
      expect(vendorViewFromBar(null), isNull);
    });

    test('resolves text / color / tooltip from a server bar verbatim', () {
      const now = 1_700_000_000_000;
      final v = vendorViewFromBar(
        const {
          'text': 'DeepSeek 余额 · ¥87.69',
          'color': '#58a6ff',
          'title': '路由供应商余额',
          'action': null,
        },
        now: now,
      )!;
      expect(v.text, 'DeepSeek 余额 · ¥87.69');
      expect(v.color, VendorQuotaColor.blue);
      expect(v.tooltip, '路由供应商余额');
    });

    test('expands {cd:<epochMs>} and {ago:<epochMs>} at the pinned now', () {
      const now = 1_700_000_000_000;
      final v = vendorViewFromBar(
        const {
          // deadline 39m in the future (now + 39*60000) → "39m";
          // fetched 30s ago (now - 30000) → "30s 前".
          'text': '5h 100% {cd:1700002340000} · {ago:1699999970000} ⟳',
          'color': '#8b949e',
          'title': '',
          'action': null,
        },
        now: now,
      )!;
      expect(v.text, '5h 100% 39m · 30s 前 ⟳');
    });

    test('a past deadline reads as "1m", never an empty segment', () {
      const now = 1_700_000_000_000;
      final v = vendorViewFromBar(
        const {
          'text': '1m 0% {cd:1699999999000}',
          'color': '#f85149',
          'title': '',
          'action': null,
        },
        now: now,
      )!;
      // A deadline already in the past collapses to the 1m floor so the bar's
      // separators stay well-formed rather than going blank.
      expect(v.text, '1m 0% 1m');
      expect(v.color, VendorQuotaColor.red);
    });

    test('state picks the named alternative render', () {
      const now = 1_700_000_000_000;
      final v = vendorViewFromBar(
        const {
          'text': 'OpenCode Go 余量 · ⟳ 刷新',
          'color': '#8b949e',
          'title': 'idle',
          'action': null,
          'states': {
            'loading': {
              'text': 'OpenCode Go：加载中…',
              'color': '#8b949e',
              'title': 'fetching',
              'action': null,
            },
          },
        },
        state: 'loading',
        now: now,
      )!;
      expect(v.text, 'OpenCode Go：加载中…');
      expect(v.tooltip, 'fetching');
    });

    test('an unknown state falls back to the default render, not a blank', () {
      const now = 1_700_000_000_000;
      final v = vendorViewFromBar(
        const {
          'text': 'Codex 余量 · ⟳ 刷新',
          'color': '#8b949e',
          'title': 'idle',
          'action': null,
          'states': {
            'loading': {
              'text': 'Codex：加载中…',
              'color': '#8b949e',
              'title': '',
              'action': null,
            },
          },
        },
        state: 'nope',
        now: now,
      )!;
      expect(v.text, 'Codex 余量 · ⟳ 刷新');
    });

    test('an unreadable color falls back to gray, not a crash', () {
      final v = vendorViewFromBar(
        const {'text': 'x', 'color': 'not-a-color', 'title': '', 'action': null},
      )!;
      expect(v.color, VendorQuotaColor.gray);
    });

    test('the server action field passes through for the tap dispatch', () {
      final login = vendorViewFromBar(
        const {'text': 'Claude 订阅 · 需登录', 'color': '#d29922', 'title': '', 'action': 'login'},
      )!;
      expect(login.action, 'login');
      final plain = vendorViewFromBar(
        const {'text': 'Claude 5h 50%', 'color': '#58a6ff', 'title': '', 'action': null},
      )!;
      expect(plain.action, isNull);
    });
  });

  group('isClaudeProviderBaseUrl (web isClaudeProvider mirror)', () {
    test('empty baseUrl means the official login — a Claude provider', () {
      expect(isClaudeProviderBaseUrl(null), isTrue);
      expect(isClaudeProviderBaseUrl(''), isTrue);
      expect(isClaudeProviderBaseUrl('   '), isTrue);
    });

    test('anthropic / claude hosts are Claude providers', () {
      expect(isClaudeProviderBaseUrl('https://api.anthropic.com'), isTrue);
      expect(isClaudeProviderBaseUrl('https://api.claude.ai/v1'), isTrue);
      expect(isClaudeProviderBaseUrl('https://EU.api.anthropic.com'), isTrue);
    });

    test('other vendors are not', () {
      expect(isClaudeProviderBaseUrl('https://open.bigmodel.cn/api/anthropic'), isFalse);
      expect(isClaudeProviderBaseUrl('https://ark.cn-beijing.volces.com/api/v3'), isFalse);
      expect(isClaudeProviderBaseUrl('https://api.moonshot.cn/anthropic'), isFalse);
    });
  });

  group('providerMatchesCli (web mirror, table-driven)', () {
    const zhipu = 'https://open.bigmodel.cn/api/anthropic';
    const cases = <List<Object>>[
      // opencode windows only show under the opencode CLI.
      ['opencode', 'opencode', zhipu, true],
      ['opencode', 'claude', zhipu, false],
      ['opencode', 'codex', zhipu, false],
      ['opencode', 'qoder', zhipu, false],
      // codex windows show under codex + opencode.
      ['codex', 'codex', zhipu, true],
      ['codex', 'opencode', '', true],
      ['codex', 'claude', '', false],
      // glm windows: codex/opencode anywhere; under any other CLI only via a
      // Zhipu baseUrl (the web rule is cli-agnostic for glm + Zhipu — even the
      // qoder CLI shows the window when the provider routes through Zhipu).
      ['glm', 'codex', '', true],
      ['glm', 'opencode', '', true],
      ['glm', 'claude', zhipu, true],
      ['glm', 'qoder', zhipu, true],
      ['glm', 'claude', 'https://api.deepseek.com/anthropic', false],
      ['glm', 'claude', '', false],
      // claude windows: claude + opencode, never codex/qoder.
      ['claude', 'claude', '', true],
      ['claude', 'opencode', '', true],
      ['claude', 'codex', '', false],
      ['claude', 'qoder', '', false],
    ];
    for (final c in cases) {
      test('${c[0]} window under ${c[1]} cli (baseUrl ${c[2] == '' ? "(none)" : c[2]}) → ${c[3]}', () {
        expect(
          providerMatchesCli(c[0] as String, c[1] as String, c[2] as String?),
          c[3] as bool,
        );
      });
    }
  });
}
