import 'dart:async';

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
  final providerBalanceCalls = <String>[];

  /// ark baseUrl -> response; an unmapped url answers null (an unreachable
  /// host), which is what the existing tests rely on.
  final arkResponses = <String, Map<String, dynamic>>{};
  /// ark baseUrl -> gate: that host's fetch parks until the test completes it,
  /// so a switch can land while the response is still in flight.
  final arkGates = <String, Completer<Map<String, dynamic>?>>{};
  /// Answer `null` for every provider-balance query (a transient failure).
  bool failProviderBalance = false;

  @override
  Future<Map<String, dynamic>?> fetchArkQuota(String? baseUrl) {
    arkBaseUrls.add(baseUrl);
    final gate = arkGates[baseUrl ?? ''];
    if (gate != null) return gate.future;
    return Future.value(arkResponses[baseUrl ?? '']);
  }

  @override
  Future<Map<String, dynamic>?> fetchCodexQuota() async => {
    'status': 'ok',
    'bar': {
      'text': 'Host · 1wk 8%',
      'color': '#58a6ff',
      'title': 'host account',
    },
  };

  @override
  Future<Map<String, dynamic>?> fetchProviderBalance(
    String appType,
    String providerId,
  ) async {
    providerBalanceCalls.add('$appType:$providerId');
    if (failProviderBalance) return null;
    if (providerId == 'deepseek') {
      return {
        'ok': true,
        'dto': {'kind': 'balance', 'provider': 'deepseek'},
        'bar': {
          'text': 'DeepSeek · ¥12.50',
          'color': '#3fb950',
          'title': 'provider balance',
        },
      };
    }
    if (providerId == 'official') {
      return {
        'ok': true,
        'dto': {'kind': 'window', 'provider': 'codex'},
        'bar': {
          'text': 'Selected Official · 1wk 23%',
          'color': '#58a6ff',
          'title': 'selected account',
        },
      };
    }
    return {
      'ok': true,
      'dto': {'kind': 'window', 'provider': 'codex'},
      'bar': {
        'text': 'Borrowed · 1wk 65%',
        'color': '#58a6ff',
        'title': 'lender account',
      },
    };
  }
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

  const autoSelection = SessionProviderSelection(
    protocol: 'anthropic',
    candidates: [
      SessionProviderCandidate(providerId: 'p1', priority: 1),
      SessionProviderCandidate(providerId: 'p2', priority: 2),
    ],
    maxAttempts: 2,
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

      var notified = 0;
      provider.addListener(() => notified++);

      // Switch to a Zhipu provider: the Claude bar hides and the provider's own
      // window bar (the same glm-monitor surface the removed zhipu slot polled)
      // appears without any reconnect or CLI switch — one bar, not two.
      provider.applyProviderSwitch(
        configWith('https://open.bigmodel.cn/api/anthropic'),
      );
      expect(
        provider.providerBaseUrl,
        'https://open.bigmodel.cn/api/anthropic',
      );
      // A non-Claude provider must hide the Claude subscription bar.
      expect(provider.claudeLimitView, isNull);
      // The switch fired a provider-balance fetch whose continuation runs as a
      // microtask. Drain it while the provider is still alive — otherwise its
      // terminal notifyListeners() hits the disposed object after the body ends.
      await Future<void>.delayed(Duration.zero);
      expect(provider.limitView?.text, 'Borrowed · 1wk 65%');
      // Listeners repaint the bars at once.
      expect(notified, greaterThan(0));

      // And back to a Claude provider: the subscription bar flips back.
      provider.applyProviderSwitch(configWith('https://api.anthropic.com'));
      expect(provider.claudeLimitView, isNotNull);
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

  test(
    'a failed provider-balance query keeps the last known good bar',
    () async {
      final s = await settings();
      final quota = _StubQuotaService(s);
      final provider = ChatProvider(
        settings: s,
        sessionName: 'test-session',
        sessionCwd: '/tmp/x',
        quotaService: quota,
      );
      addTearDown(provider.dispose);

      provider.applyProviderCatalog(const <Map<String, dynamic>>[
        {
          'id': 'deepseek',
          'appType': 'codex',
          'baseUrl': 'https://api.deepseek.com/v1',
        },
      ]);
      provider.applyCliConfig(
        const SessionCliConfig(
          cli: SessionCli.codex,
          provider: 'deepseek',
          providerBaseUrl: 'https://api.deepseek.com/v1',
          model: 'deepseek-test',
        ),
      );
      await Future<void>.delayed(Duration.zero);
      expect(provider.balanceView?.text, 'DeepSeek · ¥12.50');

      // The next query times out / answers ok:false. The web's
      // refreshProviderLimit returns on failure WITHOUT touching the bars (the
      // server even answers with its cached last-known-good bar for this
      // reason); nulling it here used to hide the chip until the user switched
      // provider or CLI again.
      quota.failProviderBalance = true;
      provider.refreshVendorQuotas();
      await Future<void>.delayed(Duration.zero);
      expect(provider.balanceView?.text, 'DeepSeek · ¥12.50');
    },
  );

  test('a late vendor response cannot repaint the previous provider', () async {
    final s = await settings();
    final quota = _StubQuotaService(s);
    const codingPlan = 'https://ark.cn-beijing.volces.com/api/coding';
    const agentPlan = 'https://ark.cn-beijing.volces.com/api/plan';
    quota.arkResponses[agentPlan] = {
      'status': 'ok',
      'bar': {'text': 'Agent plan · 已用 5%', 'color': '#58a6ff'},
    };
    quota.arkGates[codingPlan] = Completer<Map<String, dynamic>?>();
    final provider = ChatProvider(
      settings: s,
      sessionName: 'test-session',
      sessionCwd: '/tmp/x',
      quotaService: quota,
    );
    addTearDown(provider.dispose);

    provider.applyProviderSwitch(configWith(codingPlan));
    await Future<void>.delayed(Duration.zero);
    // The coding-plan query is still open; the switch to the agent plan must
    // still issue its own query (a bare in-flight flag suppressed it, leaving
    // the bar blank after the switch had already wiped it).
    provider.applyProviderSwitch(configWith(agentPlan));
    await Future<void>.delayed(Duration.zero);
    expect(provider.arkQuotaView?.text, 'Agent plan · 已用 5%');

    // The old plan's answer lands now: it belongs to a provider this session
    // has left, so it is dropped instead of painting the previous account's
    // quota under the new plan.
    quota.arkGates[codingPlan]!.complete({
      'status': 'ok',
      'bar': {'text': 'Coding plan · 已用 12%', 'color': '#58a6ff'},
    });
    await Future<void>.delayed(Duration.zero);
    expect(provider.arkQuotaView?.text, 'Agent plan · 已用 5%');
  });

  test(
    'borrowed Codex shows the lender limit and hides the host account',
    () async {
      final s = await settings();
      final quota = _StubQuotaService(s);
      final provider = ChatProvider(
        settings: s,
        sessionName: 'test-session',
        sessionCwd: '/tmp/x',
        quotaService: quota,
      );
      addTearDown(provider.dispose);

      provider.applyCliConfig(
        const SessionCliConfig(
          cli: SessionCli.codex,
          provider: 'official',
          providerBaseUrl: '',
          model: 'gpt-test',
        ),
      );
      provider.applyProviderSwitch(
        const SessionCliConfig(
          cli: SessionCli.codex,
          provider: 'borrowed',
          providerBaseUrl: 'https://relay.example/codex-proxy/official',
          model: 'gpt-test',
        ),
      );
      for (var i = 0; i < 3; i++) {
        await Future<void>.delayed(Duration.zero);
      }

      expect(quota.providerBalanceCalls, ['codex:official', 'codex:borrowed']);
      expect(provider.codexQuotaView, isNull);
      expect(provider.limitView?.text, 'Borrowed · 1wk 65%');
    },
  );

  test(
    'Codex limit bar follows direct and Official Provider identity',
    () async {
      final s = await settings();
      final quota = _StubQuotaService(s);
      final provider = ChatProvider(
        settings: s,
        sessionName: 'test-session',
        sessionCwd: '/tmp/x',
        quotaService: quota,
      );
      addTearDown(provider.dispose);

      provider.applyProviderCatalog(const <Map<String, dynamic>>[
        {
          'id': 'deepseek',
          'appType': 'codex',
          'baseUrl': 'https://api.deepseek.com/v1',
          'isOfficial': false,
        },
        {
          'id': 'official',
          'appType': 'codex',
          'baseUrl': '',
          'isOfficial': true,
        },
      ]);
      provider.applyCliConfig(
        const SessionCliConfig(
          cli: SessionCli.codex,
          provider: 'deepseek',
          providerBaseUrl: 'https://api.deepseek.com/v1',
          model: 'deepseek-test',
        ),
      );
      await Future<void>.delayed(Duration.zero);

      expect(provider.codexQuotaView, isNull);
      expect(provider.limitView, isNull);
      expect(provider.balanceView?.text, 'DeepSeek · ¥12.50');

      provider.applyProviderSwitch(
        const SessionCliConfig(
          cli: SessionCli.codex,
          provider: 'official',
          providerBaseUrl: '',
          model: 'gpt-test',
        ),
      );
      await Future<void>.delayed(Duration.zero);

      expect(quota.providerBalanceCalls, ['codex:deepseek', 'codex:official']);
      expect(provider.codexQuotaView, isNull);
      expect(provider.balanceView, isNull);
      expect(provider.limitView?.text, 'Selected Official · 1wk 23%');

      provider.applyProviderSwitch(
        const SessionCliConfig(
          cli: SessionCli.codex,
          provider: 'official',
          providerSelection: autoSelection,
          model: 'gpt-test',
        ),
      );
      expect(provider.activeProviderId, isNull);
      expect(provider.codexQuotaView, isNull);
      expect(provider.limitView, isNull);
    },
  );

  test(
    'Auto policy choice is not actual until a physical route event',
    () async {
      final s = await settings();
      final provider = ChatProvider(
        settings: s,
        sessionName: 'test-session',
        sessionCwd: '/tmp/x',
        quotaService: _StubQuotaService(s),
      );
      addTearDown(provider.dispose);

      provider.applyProviderCatalog(const <Map<String, dynamic>>[
        {'id': 'p1', 'baseUrl': 'https://api.deepseek.com/anthropic'},
        {'id': 'p2', 'baseUrl': 'https://open.bigmodel.cn/api/anthropic'},
      ]);
      provider.applyProviderSwitch(
        const SessionCliConfig(
          cli: SessionCli.claude,
          provider: 'p1',
          providerName: 'Configured primary',
          providerBaseUrl: 'https://api.deepseek.com/anthropic',
          model: 'primary-model',
          providerSelection: autoSelection,
        ),
      );

      expect(provider.activeProviderId, isNull);
      expect(provider.activeProviderName, isNull);
      expect(provider.activeProviderModel, isNull);
      expect(provider.providerBaseUrl, isEmpty);

      provider.applyProviderRoutingEvent('provider_auto_route', const {
        'phase': 'switched',
        'providerId': 'p2',
        'providerName': 'Working backup',
        'model': 'backup-model',
      });
      expect(provider.activeProviderId, isNull);
      expect(provider.providerBaseUrl, isEmpty);

      provider.applyProviderRoutingEvent('provider_route_event', const {
        'phase': 'selected',
        'providerId': 'p2',
        'providerName': 'Working backup',
        'model': 'backup-model',
      });
      expect(provider.activeProviderId, 'p2');
      expect(provider.activeProviderName, 'Working backup');
      expect(provider.activeProviderModel, 'backup-model');
      expect(
        provider.providerBaseUrl,
        'https://open.bigmodel.cn/api/anthropic',
      );
      await Future<void>.delayed(Duration.zero);
      // The Zhipu account's windows arrive via the Provider balance query now.
      expect(provider.limitView?.text, 'Borrowed · 1wk 65%');
    },
  );
}
