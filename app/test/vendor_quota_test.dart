import 'package:flutter_test/flutter_test.dart';

import 'package:multicc_app/models/chat_runtime_state.dart';
import 'package:multicc_app/models/vendor_quota.dart';

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
  });

  group('fmtQuotaNum', () {
    test('drops trailing zeros, keeps 2 decimals', () {
      expect(fmtQuotaNum(100), '100');
      expect(fmtQuotaNum(12.3456), '12.35');
      expect(fmtQuotaNum(99.487123), '99.49');
      expect(fmtQuotaNum(0.5), '0.5');
      expect(fmtQuotaNum(null), '');
    });
  });

  group('unified helpers', () {
    test('humanizeCountdown buckets: minutes, hours, days', () {
      expect(humanizeCountdown(null), '');
      expect(humanizeCountdown(-1), '');
      expect(humanizeCountdown(30 * 60000), '30m');
      expect(humanizeCountdown(3600000), '1h');
      expect(humanizeCountdown(5400000), '1.5h');
      expect(humanizeCountdown(25 * 3600000), '1d 1h');
      expect(humanizeCountdown(48 * 3600000), '2d');
      expect(humanizeCountdown(620 * 3600000), '25d 20h');
    });

    test('unifiedRemaining clamps 100 - used to [0,100]', () {
      expect(unifiedRemaining(null), null);
      expect(unifiedRemaining(0), 100);
      expect(unifiedRemaining(72.4), 28);
      expect(unifiedRemaining(100), 0);
      expect(unifiedRemaining(150), 0);
    });

    test('unifiedWindowSeg builds `<label> <remaining>% [<countdown>]`', () {
      expect(unifiedWindowSeg('5h', null, 3600000), '');
      expect(unifiedWindowSeg('5h', 72.4, 3600000), '5h 28% 1h');
      expect(unifiedWindowSeg('1wk', 50, null), '1wk 50%');
    });

    test('unifiedBalanceText renders 2-decimal amount with currency symbol', () {
      expect(unifiedBalanceText(null, 'CNY'), '');
      expect(unifiedBalanceText(110, 'CNY'), '¥110.00');
      expect(unifiedBalanceText(0, 'USD'), '\$0.00');
      expect(unifiedBalanceText(42.5, null), '42.50');
    });

    test('arkWindowLabel maps period names to compact tokens', () {
      expect(arkWindowLabel('5h'), '5h');
      expect(arkWindowLabel('weekly'), '1wk');
      expect(arkWindowLabel('monthly'), '1m');
      expect(arkWindowLabel('session'), '会话');
    });
  });

  group('formatArkQuota', () {
    test('renders percent-only periods without null/null', () {
      final value = {
        'status': 'ok',
        'fetchedAt': DateTime.now().millisecondsSinceEpoch,
        'items': [
          {
            'product': 'coding-plan',
            'subscribed': true,
            'error': null,
            'periods': [
              {'label': 'session', 'used': null, 'total': null, 'percent': 100},
              {'label': 'weekly', 'used': null, 'total': null, 'percent': 42.5},
            ],
          },
        ],
      };
      final view = formatArkQuota(
        value,
        'https://ark.cn-beijing.volces.com/api/coding/v3',
      );
      expect(view.text.contains('null'), false);
      expect(view.text, contains('会话 0%'));
      expect(view.text, contains('1wk 58%'));
      expect(view.text.contains('（当前）'), false, reason: 'plan marker lives in tooltip');
      expect(view.tooltip, contains('Coding（当前 provider）'));
      expect(view.color, VendorQuotaColor.red); // 会话 100% used → 0% remaining
    });

    test('marks the plan matching the baseUrl as current in the tooltip', () {
      final value = {
        'status': 'ok',
        'fetchedAt': DateTime.now().millisecondsSinceEpoch,
        'items': [
          {
            'product': 'agent-plan',
            'subscribed': true,
            'error': null,
            'periods': [
              {'label': 'weekly', 'used': 10, 'total': 100, 'percent': 10},
            ],
          },
        ],
      };
      final coding = formatArkQuota(value, 'https://x.volces.com/api/coding/v3');
      expect(coding.tooltip.contains('（当前 provider）'), false);
      final agent = formatArkQuota(value, 'https://x.volces.com/api/plan');
      expect(agent.tooltip, contains('Agent（当前 provider）'));
    });

    test('surfaces needs_auth / needs_install / no-plan states', () {
      expect(formatArkQuota({'status': 'needs_auth'}, '').text, contains('未登录'));
      expect(formatArkQuota({'status': 'needs_install'}, '').text, contains('未安装'));
      expect(
        formatArkQuota({'status': 'ok', 'items': []}, '').text,
        contains('无生效套餐'),
      );
      expect(formatArkQuota(null, '').text, contains('刷新'));
    });
  });

  group('formatZhipuQuota', () {
    test('renders window + weekly usage', () {
      final value = {
        'status': 'ok',
        'fetchedAt': DateTime.now().millisecondsSinceEpoch,
        'sites': [
          {
            'host': 'api.z.ai',
            'site': 'Z.ai',
            'ok': true,
            'period': '5h',
            'usedPercent': 33.333,
            'weeklyUsedPercent': 75.0,
          },
        ],
      };
      final view = formatZhipuQuota(value);
      expect(view.text, contains('5h 67%'));
      expect(view.text, contains('1wk 25%'));
      expect(view.tooltip, contains('Z.ai'));
      expect(view.color, VendorQuotaColor.yellow); // 周 75% used → 25% remaining
    });

    test('surfaces not_configured / unavailable', () {
      expect(formatZhipuQuota({'status': 'not_configured'}).text, contains('未配置'));
      expect(formatZhipuQuota({'status': 'unavailable'}).text, contains('暂不可用'));
    });
  });

  group('formatKimiQuota', () {
    test('renders available balance', () {
      final value = {
        'status': 'ok',
        'fetchedAt': DateTime.now().millisecondsSinceEpoch,
        'sites': [
          {'host': 'api.moonshot.cn', 'site': 'Moonshot', 'ok': true, 'available': 49.58, 'currency': 'CNY'},
        ],
      };
      final view = formatKimiQuota(value, null);
      expect(view.text, contains('¥49.58'));
      expect(view.tooltip, contains('Moonshot'));
      expect(view.color, VendorQuotaColor.blue);
    });

    test('falls back to cached balance when live fetch has no ok sites', () {
      final cached = {
        'status': 'ok',
        'fetchedAt': DateTime.now().millisecondsSinceEpoch,
        'sites': [
          {'host': 'api.moonshot.cn', 'site': 'Moonshot', 'ok': true, 'available': 12.34, 'currency': 'CNY'},
        ],
      };
      final live = {
        'status': 'unavailable',
        'sites': [
          {'host': 'api.moonshot.cn', 'site': 'Moonshot', 'ok': false, 'reason': 'auth_rejected'},
        ],
      };
      final view = formatKimiQuota(live, cached);
      expect(view.text, contains('¥12.34'));
      expect(view.text, contains('上次'));
      expect(view.tooltip, contains('余额刷新失败'));
    });

    test('shows short reason when unavailable and no cache', () {
      final live = {
        'status': 'unavailable',
        'sites': [
          {'host': 'api.kimi.com', 'site': 'Kimi', 'ok': false, 'reason': 'auth_rejected'},
        ],
      };
      final view = formatKimiQuota(live, null);
      expect(view.text, contains('余额暂不可用（密钥不支持余额查询）'));
      expect(view.color, VendorQuotaColor.yellow);
    });

    test('low balance turns warning / danger', () {
      Map<String, dynamic> bal(num avail) => {
        'status': 'ok',
        'fetchedAt': DateTime.now().millisecondsSinceEpoch,
        'sites': [
          {'host': 'api.moonshot.cn', 'site': 'Moonshot', 'ok': true, 'available': avail},
        ],
      };
      expect(formatKimiQuota(bal(3), null).color, VendorQuotaColor.yellow);
      expect(formatKimiQuota(bal(0), null).color, VendorQuotaColor.red);
    });

    test('subscription-page summary renders windows in canonical order', () {
      final value = {
        'status': 'ok',
        'source': 'subscription-page',
        'fetchedAt': DateTime.now().millisecondsSinceEpoch,
        'summary': [
          {'window': '1m', 'usedPercent': 80},
          {'window': '5h', 'usedPercent': 42},
          {'window': '1wk', 'usedPercent': 30},
        ],
      };
      final view = formatKimiQuota(value, null);
      final segs = view.text
          .split(' · ')
          .take(3)
          .map((s) => s.split(' ').first)
          .toList();
      expect(segs, ['5h', '1wk', '1m']);
      expect(view.text, contains('1wk 70%'));
      expect(view.tooltip, contains('1wk: 已用 30%'));
      expect(view.tooltip, contains('订阅 key 无预付余额接口'));
    });

    test('subscription-page with an empty summary reports parse failure', () {
      final view = formatKimiQuota(
        {'status': 'ok', 'source': 'subscription-page', 'summary': <Object>[]},
        null,
      );
      expect(view.text, contains('未解析出用量'));
      expect(view.color, VendorQuotaColor.yellow);
    });
  });

  group('sortWindowSegs', () {
    test('orders windows 5h → 1wk → 1m regardless of input order', () {
      expect(
        sortWindowSegs(['1wk 50%', '5h 20%', '1m 80%']),
        ['5h 20%', '1wk 50%', '1m 80%'],
      );
      expect(
        sortWindowSegs(['1m 80%', '1wk 50%', '5h 20%']),
        ['5h 20%', '1wk 50%', '1m 80%'],
      );
    });

    test('puts unknown labels last, keeping equal-rank input order', () {
      expect(
        sortWindowSegs(['会话 0%', '1wk 73%', '1m 2%', '5h 10%']),
        ['5h 10%', '1wk 73%', '1m 2%', '会话 0%'],
      );
      // stable: two unknown segments keep their input order
      expect(sortWindowSegs(['X 1%', 'Y 2%', '5h 3%']), ['5h 3%', 'X 1%', 'Y 2%']);
    });

    test('does not mutate the input and skips empties', () {
      final input = ['1wk 50%', '', '5h 20%'];
      final out = sortWindowSegs(input);
      expect(input, ['1wk 50%', '', '5h 20%']);
      expect(out, ['5h 20%', '1wk 50%']);
    });
  });

  group('formatWindowLimit (GLM/Codex unified)', () {
    const nowMs = 1_700_000_000_000;

    UsageWindowLimit limit({
      String provider = 'glm',
      String status = 'allowed',
      double? used = 50,
      int? resetsInMs = 3600000,
    }) => UsageWindowLimit(
      rateLimitType: 'five_hour',
      status: status,
      usedPercentage: used,
      resetsAtMs: resetsInMs == null ? null : nowMs + resetsInMs,
      provider: provider,
    );

    test('GLM renders a 5h window with remaining% + countdown', () {
      final v = formatWindowLimit(limit(used: 50), nowMs: nowMs);
      expect(v.text, '5h 50% 1h');
      expect(v.color, VendorQuotaColor.blue);
      expect(v.tooltip, contains('GLM Coding Plan'));
    });

    test('Codex renders a weekly (1wk) window', () {
      final v = formatWindowLimit(
        limit(provider: 'codex', used: 80, resetsInMs: 3 * 86400000),
        nowMs: nowMs,
      );
      expect(v.text, startsWith('1wk 20%'));
      expect(v.tooltip, contains('Codex 订阅周额度'));
    });

    test('rejected forces 0% remaining (red)', () {
      final v = formatWindowLimit(
        limit(status: 'rejected', used: 100),
        nowMs: nowMs,
      );
      expect(v.text.split(' ').take(2), ['5h', '0%']);
      expect(v.color, VendorQuotaColor.red);
    });

    test('low remaining turns amber/red via the shared scale', () {
      expect(
        formatWindowLimit(limit(used: 95), nowMs: nowMs).color,
        VendorQuotaColor.red,
      );
      expect(
        formatWindowLimit(limit(used: 75), nowMs: nowMs).color,
        VendorQuotaColor.yellow,
      );
    });

    test('missing percent degrades to the bare window label', () {
      final v = formatWindowLimit(limit(used: null), nowMs: nowMs);
      expect(v.text, '5h');
      expect(v.color, VendorQuotaColor.blue);
    });
  });

  group('formatQoderQuota', () {
    // Pinned clock; nextResetAt is the real top-level field the usage API
    // returns (epoch ms). Mirrors the web formatQoderQuota.
    const nowMs = 1_700_000_000_000;
    const resetAtMs = 1_700_000_000_000 + 13 * 86400000 + 8 * 3600000;

    Map<String, dynamic> okValue({
      int? nextResetAt = resetAtMs,
      Map? plan,
      num used = 3688,
      num limit = 6000,
    }) => {
      'status': 'ok',
      'fetchedAt': nowMs,
      'quota': {
        'total_quota': {
          'quota_summary': {
            'used_value': used,
            'limit_value': limit,
            'remaining_value': limit - used,
            'usage_percentage': (used / limit * 100).roundToDouble(),
          },
        },
        'plan_quota': {
          'quota_summary': {
            'used_value': used,
            'limit_value': limit,
          },
        },
        'nextResetAt': nextResetAt,
      },
      'plan': plan ?? {
        'plan_tier': 'PLAN_TIER_PRO_PLUS',
        'end_date': resetAtMs,
      },
    };

    test('renders 1m window with remaining% + countdown from nextResetAt', () {
      final v = formatQoderQuota(okValue(used: 3600), nowMs: nowMs);
      expect(v.text, startsWith('1m 40%'));
      expect(v.text, contains('13d'));
      expect(v.color, VendorQuotaColor.blue);
      expect(v.tooltip, contains('重置:'));
      expect(v.tooltip, contains('PRO_PLUS'));
    });

    test('low remaining turns amber/red via the shared scale', () {
      expect(
        formatQoderQuota(okValue(used: 5900), nowMs: nowMs).color,
        VendorQuotaColor.red,
      );
      expect(
        formatQoderQuota(okValue(used: 4500), nowMs: nowMs).color,
        VendorQuotaColor.yellow,
      );
    });

    test('falls back to plan.end_date when nextResetAt is absent', () {
      final v = formatQoderQuota(
        okValue(nextResetAt: null),
        nowMs: nowMs,
      );
      expect(v.text, startsWith('1m 39%'));
      expect(v.text, contains('13d'));
    });

    test('no reset source renders the bare window and flags it in the tooltip', () {
      final v = formatQoderQuota(
        okValue(
          nextResetAt: null,
          plan: {'plan_tier': 'PLAN_TIER_FREE'},
        ),
        nowMs: nowMs,
      );
      // Unified fallback: `<window> <remaining%>` without a countdown (same as
      // every other bar when its reset field is missing).
      expect(v.text, startsWith('1m 39%'));
      expect(v.text, isNot(contains('d')));
      expect(v.tooltip, contains('到期时间未知'));
    });

    test('surfaces needs_login / chrome_unavailable / unavailable states', () {
      expect(
        formatQoderQuota({'status': 'needs_login'}).text,
        contains('需登录'),
      );
      expect(
        formatQoderQuota({'status': 'chrome_unavailable'}).text,
        contains('无可连的 Chrome'),
      );
      expect(
        formatQoderQuota({'status': 'unavailable', 'error': 'boom'}).text,
        contains('用量暂不可用'),
      );
      expect(
        formatQoderQuota({'status': 'unavailable', 'error': 'boom'}).tooltip,
        'boom',
      );
    });

    test('null value shows the idle placeholder; loading shows loading', () {
      expect(formatQoderQuota(null).text, contains('⟳ 刷新'));
      expect(
        formatQoderQuota(null, loading: true).text,
        contains('加载中'),
      );
    });
  });

  group('formatClaudeLimit', () {
    // Pinned clock so the countdown branch (1h vs 60m) is deterministic.
    const nowMs = 1_700_000_000_000;

    UsageWindowLimit limit({
      String status = 'allowed',
      double? used = 50,
    }) =>
        UsageWindowLimit(
          rateLimitType: 'five_hour',
          status: status,
          usedPercentage: used,
          resetsAtMs: nowMs + 3600000,
          provider: 'claude',
        );

    test('merges event 5h with weekly/monthly in canonical order', () {
      final usage = {
        'status': 'ok',
        'fetchedAt': nowMs,
        'summary': [
          {'window': '1m', 'usedPercent': 80, 'label': 'Monthly limit'},
          // the page's own 5h row duplicates the event and must be dropped
          {'window': '5h', 'usedPercent': 42, 'label': 'Current session'},
          {'window': '1wk', 'usedPercent': 30, 'label': 'Weekly limit'},
        ],
      };
      final view = formatClaudeLimit(limit(), usage, nowMs: nowMs);
      final segs = view.text
          .split(' · ')
          .map((s) => s.split(' ').first)
          .toList();
      expect(segs, ['5h', '1wk', '1m']);
      expect(view.text, contains('1wk 70%'));
      expect(view.text, contains('1m 20%'));
      expect(view.text, isNot(contains('99%')));
      expect(view.tooltip, contains('周: 已用 30%'));
      expect(view.tooltip, contains('月: 已用 80%'));
    });

    test('ignores non-ok usage and renders the event 5h alone', () {
      final usage = {'status': 'unavailable', 'error': 'boom'};
      final view = formatClaudeLimit(limit(), usage, nowMs: nowMs);
      final segs = view.text
          .split(' · ')
          .map((s) => s.split(' ').first)
          .toList();
      expect(segs, ['5h']);
      expect(view.text, contains(' 50%'));
      expect(view.tooltip, contains('五小时'));
    });

    test('skips the usage page 5h row (dedup vs the event)', () {
      final usage = {
        'status': 'ok',
        'summary': [
          {'window': '5h', 'usedPercent': 99, 'label': 'Current session'},
        ],
      };
      final view = formatClaudeLimit(limit(), usage, nowMs: nowMs);
      final segs = view.text.split(' · ');
      expect(segs.length, 1);
      expect(segs.first, startsWith('5h'));
      expect(view.text, isNot(contains('99%')));
    });

    test('a rejected event forces 0% remaining', () {
      final view = formatClaudeLimit(
        limit(status: 'rejected', used: 100),
        null,
        nowMs: nowMs,
      );
      expect(view.text.split(' · ').first, startsWith('5h 0%'));
    });

    test('no usage leaves just the event 5h', () {
      final view = formatClaudeLimit(limit(), null, nowMs: nowMs);
      expect(
        view.text
            .split(' · ')
            .map((s) => s.split(' ').first)
            .toList(),
        ['5h'],
      );
    });
  });

  group('formatClaudeUsageOnly', () {
    test('null usage falls back to the idle placeholder', () {
      final view = formatClaudeUsageOnly(null);
      expect(view.text, '5h · — · ⟳ 刷新');
      expect(view.color, VendorQuotaColor.gray);
    });

    test('needs_login surfaces the open-login affordance', () {
      final view = formatClaudeUsageOnly({'status': 'needs_login'});
      expect(view.text, contains('需登录'));
      expect(view.text, contains('打开登录窗口'));
      expect(view.color, VendorQuotaColor.red);
    });

    test('chrome_unavailable surfaces the login affordance too', () {
      final view = formatClaudeUsageOnly({'status': 'chrome_unavailable'});
      expect(view.text, contains('无可连的 Chrome'));
      expect(view.color, VendorQuotaColor.yellow);
    });

    test('non-ok status renders unavailable with retry', () {
      final view = formatClaudeUsageOnly({
        'status': 'unavailable',
        'error': 'cf blocked',
      });
      expect(view.text, contains('用量暂不可用'));
      expect(view.text, contains('⟳ 重试'));
      expect(view.tooltip, contains('cf blocked'));
    });

    test('ok windows render in canonical order', () {
      final usage = {
        'status': 'ok',
        'fetchedAt': DateTime.now().millisecondsSinceEpoch,
        'summary': [
          {'window': '1m', 'usedPercent': 80},
          {'window': '1wk', 'usedPercent': 30},
          {'window': '5h', 'usedPercent': 42},
        ],
      };
      final view = formatClaudeUsageOnly(usage);
      // The first three segments are the windows (a sync suffix may follow).
      final segs = view.text
          .split(' · ')
          .take(3)
          .map((s) => s.split(' ').first)
          .toList();
      expect(segs, ['5h', '1wk', '1m']);
      expect(view.tooltip, contains('5h: 已用 42%'));
      expect(view.tooltip, contains('1wk: 已用 30%'));
    });
  });
}
