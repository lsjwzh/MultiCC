import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:multicc_app/models/message.dart';
import 'package:multicc_app/providers/chat_provider.dart';
import 'package:multicc_app/services/quota_service.dart';
import 'package:multicc_app/services/settings_service.dart';

/// Vendor quota fetch stub: the real one hits HTTP against the configured
/// host, and its terminal notifyListeners() would land on the disposed
/// provider after the test body ends (flutter_test's "test failed after it
/// had already completed"). A synchronous null return keeps the whole fetch
/// inside the body's microtasks, while the provider is still alive.
class _StubQuotaService extends QuotaService {
  _StubQuotaService(SettingsService settings) : super(settings: settings);

  final arkBaseUrls = <String?>[];

  @override
  Future<Map<String, dynamic>?> fetchArkQuota(String? baseUrl) async {
    arkBaseUrls.add(baseUrl);
    return null;
  }

  @override
  Future<Map<String, dynamic>?> fetchZhipuQuota(String? host) async => null;
}

/// Regression: switching provider in the app used to leave the limit bar on
/// the OLD provider until a reconnect or CLI switch, because a provider PATCH
/// (same CLI) triggers no WS broadcast. [ChatProvider.applyProviderSwitch] is
/// the app mirror of the web's updateProviderBtn() -> setProviderBaseUrl()
/// right after saveSession; these tests pin its gating flips.
///
/// Settings point at an unreachable port so the vendor quota fetches the
/// baseUrl change triggers fail fast and get swallowed (same harness trick as
/// chat_header_title_test). The provider must be disposed before the test body
/// ends - flutter_test checks pending timers inside the body.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  Future<SettingsService> settings() async {
    SharedPreferences.setMockInitialValues({
      'multicc_host': 'http://127.0.0.1:1',
      'multicc_token': '',
    });
    return SettingsService.getInstance();
  }

  SessionCliConfig configWith(String baseUrl) => SessionCliConfig(
    cli: SessionCli.claude,
    provider: 'p1',
    providerBaseUrl: baseUrl,
    model: 'm',
  );

  test(
    'applyProviderSwitch re-gates the bars immediately and notifies',
    () async {
      final s = await settings();
      final provider = ChatProvider(
        settings: s,
        sessionName: 'test-session',
        sessionCwd: '/tmp/x',
        quotaService: _StubQuotaService(s),
      );
      addTearDown(provider.dispose);

      // Cold start: no baseUrl learned yet -> official login, a Claude provider.
      expect(provider.providerBaseUrl, '');
      expect(provider.claudeLimitView, isNotNull);
      expect(provider.zhipuQuotaView, isNull);

      var notified = 0;
      provider.addListener(() => notified++);

      // Switch to a Zhipu provider: the Claude bar hides and the Zhipu bar
      // appears without any reconnect or CLI switch.
      provider.applyProviderSwitch(
        configWith('https://open.bigmodel.cn/api/anthropic'),
      );
      expect(
        provider.providerBaseUrl,
        'https://open.bigmodel.cn/api/anthropic',
      );
      // A non-Claude provider must hide the Claude subscription bar.
      expect(provider.claudeLimitView, isNull);
      // The Zhipu quota bar follows the switch immediately.
      expect(provider.zhipuQuotaView, isNotNull);
      // Listeners repaint the bars at once.
      expect(notified, greaterThan(0));

      // And back to a Claude provider: the bars flip the other way.
      provider.applyProviderSwitch(configWith('https://api.anthropic.com'));
      expect(provider.claudeLimitView, isNotNull);
      expect(provider.zhipuQuotaView, isNull);

      // The Zhipu switch fired a quota fetch whose continuation runs as a
      // microtask. Drain it while the provider is still alive — otherwise its
      // terminal notifyListeners() hits the disposed object after the body ends.
      await Future<void>.delayed(Duration.zero);
    },
  );

  test('Ark quota fetch receives the active provider baseUrl', () async {
    final s = await settings();
    final quota = _StubQuotaService(s);
    final provider = ChatProvider(
      settings: s,
      sessionName: 'test-session',
      sessionCwd: '/tmp/x',
      quotaService: quota,
    );
    addTearDown(provider.dispose);

    provider.applyProviderSwitch(
      configWith('https://ark.cn-beijing.volces.com/api/coding'),
    );
    await Future<void>.delayed(Duration.zero);

    expect(
      quota.arkBaseUrls,
      contains('https://ark.cn-beijing.volces.com/api/coding'),
    );
    expect(provider.arkQuotaView, isNotNull);
  });
}
