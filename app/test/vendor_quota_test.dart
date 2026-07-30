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
      expect(view.text, contains('Coding（当前）'));
      expect(view.text, contains('会话 100%'));
      expect(view.text, contains('周 42.5%'));
      expect(view.color, VendorQuotaColor.red); // maxPct 100 >= 90
    });

    test('marks the plan matching the baseUrl as current', () {
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
      expect(coding.text.contains('（当前）'), false);
      final agent = formatArkQuota(value, 'https://x.volces.com/api/plan');
      expect(agent.text, contains('Agent（当前）'));
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
      expect(view.text, contains('Z.ai 5h 33.33%'));
      expect(view.text, contains('周 75%'));
      expect(view.color, VendorQuotaColor.yellow); // maxPct 75 >= 70
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
          {'host': 'api.moonshot.cn', 'site': 'Moonshot', 'ok': true, 'available': 49.58},
        ],
      };
      final view = formatKimiQuota(value, null);
      expect(view.text, contains('Moonshot ¥49.58'));
      expect(view.color, VendorQuotaColor.blue);
    });

    test('falls back to cached balance when live fetch has no ok sites', () {
      final cached = {
        'status': 'ok',
        'fetchedAt': DateTime.now().millisecondsSinceEpoch,
        'sites': [
          {'host': 'api.moonshot.cn', 'site': 'Moonshot', 'ok': true, 'available': 12.34},
        ],
      };
      final live = {
        'status': 'unavailable',
        'sites': [
          {'host': 'api.moonshot.cn', 'site': 'Moonshot', 'ok': false, 'reason': 'auth_rejected'},
        ],
      };
      final view = formatKimiQuota(live, cached);
      expect(view.text, contains('Moonshot ¥12.34'));
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
