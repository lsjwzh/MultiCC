import 'package:flutter_test/flutter_test.dart';

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
  });
}
