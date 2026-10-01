import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/models/message.dart';
import 'package:multicc_app/providers/chat_provider.dart';
import 'package:multicc_app/providers/session_manager.dart';
import 'package:multicc_app/services/quota_service.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/utils/cli_display.dart';
import 'package:multicc_app/widgets/chat_header.dart';
import 'package:multicc_app/widgets/run_config/run_chip.dart';

/// 「下轮生效」口径的回归：**app 上切换 CLI 后，页头还显示旧 CLI、AI 药丸还是
/// 旧车道的 Provider 池**。
///
/// 服务端在会话忙时不动活着的车道，而是把用户的选择暂存成 `pendingConfiguration`
/// 并回 `{deferred:true, cli:<旧车道>}`（src/session/pending-configuration.js）。
/// Web 侧对应的是 chat.js 的 `_pendingConfiguration`：角标/pill 读它、`dataset.pending`
/// 写「下轮生效」（chat-layout.css 的 ::after）、`desiredConfig()` 把 pending.profile
/// 并进面板初始值。App 这一侧原先在 deferred 分支里整段跳过 applyCliConfig，于是
/// 既没有 pending 概念、也没有显示口径 —— 用户切完看到的还是旧车道那一套。
///
/// 设置指向本机不可达端口：REST/WS 快速失败并被吞掉，断言全在同步路径上。
/// ChatProvider / SessionManager 必须在 body 结束前显式 dispose（SessionManager 的
/// 构造器会起 5s 周期刷新，flutter_test 在 body 内部就检查 pending timers）。
class _StubQuotaService extends QuotaService {
  _StubQuotaService(SettingsService settings) : super(settings: settings);

  /// 额度查询全部同步回 null：真实现会打网络，其收尾的 notifyListeners() 可能落在
  /// 已 dispose 的 provider 上（provider_switch_limit_bar_test 同款处理）。
  @override
  Future<Map<String, dynamic>?> fetchArkQuota(String? baseUrl) async => null;
  @override
  Future<Map<String, dynamic>?> fetchKimiQuota(String? host) async => null;
  @override
  Future<Map<String, dynamic>?> fetchOpenCodeQuota() async => null;
  @override
  Future<Map<String, dynamic>?> fetchCodexQuota() async => null;
  @override
  Future<Map<String, dynamic>?> fetchQoderQuota() async => null;
  @override
  Future<Map<String, dynamic>?> fetchClaudeUsage() async => null;
  @override
  Future<Map<String, dynamic>?> fetchIdleBars() async => null;
  @override
  Future<Map<String, dynamic>?> fetchProviderBalance(
    String appType,
    String providerId,
  ) async => null;
  @override
  Future<String?> fetchProviderBaseUrl(String sessionId) async => null;
}

/// 服务端 deferred 响应的形状（switch-cli 的返回体）。
Map<String, dynamic> deferredSwitchResponse() => {
  'ok': true,
  'changed': false,
  'deferred': true,
  'appliesOn': 'next_turn',
  // 活着的仍是旧车道：这一份是**运行时**的状态，不能拿它当显示口径。
  'cli': 'codex',
  'provider': 'p-old',
  'model': 'm-old',
  'pendingConfiguration': {
    'cli': 'claude-exp',
    'fresh': false,
    'profile': {
      'provider': 'p-new',
      'providerSelection': null,
      'model': 'm-new',
      'effort': 'high',
      'agent': null,
      'subagent': null,
      'rolePrompt': null,
    },
    'updatedAt': '2026-09-29T15:08:06.000Z',
  },
};

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(() => I18n.init('zh'));

  Future<SettingsService> settings() async {
    SharedPreferences.setMockInitialValues({
      'multicc_host': 'http://127.0.0.1:1',
      'multicc_token': '',
    });
    return SettingsService.getInstance();
  }

  group('pending 配置的解析', () {
    test('deferred 换道响应里，cli 还是旧的，待生效的那份在 pendingConfiguration', () {
      final config = SessionCliConfig.fromJson(deferredSwitchResponse());

      // 活着的车道（引擎还在上面跑）与用户选好的车道是两件事。
      expect(config.cli, SessionCli.codex);
      expect(config.deferred, isTrue);
      expect(config.pendingCli, SessionCli.claudeExp);
      expect(config.pending!.fresh, isFalse);
      expect(config.pending!.provider, 'p-new');
      expect(config.pending!.model, 'm-new');
      expect(config.pending!.effort, 'high');
      expect(config.pending!.subagent, isNull);
    });

    test('会话行里的 pendingConfiguration 让列表卡片也能显示待生效的车道', () {
      final session = Session.fromJson({
        'id': 's-1',
        'cli': 'codex',
        'createdAt': '2026-09-29T00:00:00.000Z',
        'pendingConfiguration': {
          'cli': 'claude-exp',
          'profile': {'provider': 'p-new', 'model': 'm-new'},
        },
      });

      expect(session.cli, SessionCli.codex);
      expect(session.pending?.cli, SessionCli.claudeExp);
      expect(session.pending?.provider, 'p-new');
    });

    test('没有 pendingConfiguration 时 pending 是 null（不猜）', () {
      final config = SessionCliConfig.fromJson({'cli': 'claude'});
      expect(config.pending, isNull);
      expect(config.pendingCli, isNull);
      expect(config.deferred, isFalse);
    });
  });

  group('ChatProvider 的显示口径', () {
    test('pending 换道：live cli 不动，desiredCli 指到用户选好的那条', () async {
      final s = await settings();
      final provider = ChatProvider(
        settings: s,
        sessionName: 's-pending',
        sessionCwd: '/tmp/x',
        quotaService: _StubQuotaService(s),
      );
      addTearDown(provider.dispose);

      provider.applyCliConfig(
        const SessionCliConfig(cli: SessionCli.codex, model: 'm-old'),
      );
      expect(provider.cli, SessionCli.codex);
      expect(provider.pendingConfiguration.desiredCli(provider.cli), SessionCli.codex);
      expect(provider.pendingConfiguration.hasCliSwitch(provider.cli), isFalse);

      var notified = 0;
      provider.addListener(() => notified++);
      provider.applyCliConfig(
        SessionCliConfig.fromJson(deferredSwitchResponse()),
      );

      // 关键分歧：运行时仍是旧车道（不能骗自己说已经切了），但显示口径已经
      // 是用户选的那条 —— 页头角标与 AI 药丸都读 desiredCli。
      expect(provider.cli, SessionCli.codex);
      expect(provider.pendingConfiguration.desiredCli(provider.cli), SessionCli.claudeExp);
      expect(provider.pendingConfiguration.isSet, isTrue);
      expect(provider.pendingConfiguration.hasCliSwitch(provider.cli), isTrue);
      expect(provider.pendingConfiguration.value?.provider, 'p-new');
      expect(notified, greaterThan(0));
      await Future<void>.delayed(Duration.zero);
    });

    test('服务端落实换道后，pending 记号清掉', () async {
      final s = await settings();
      final provider = ChatProvider(
        settings: s,
        sessionName: 's-applied',
        sessionCwd: '/tmp/x',
        quotaService: _StubQuotaService(s),
      );
      addTearDown(provider.dispose);

      provider.applyCliConfig(
        SessionCliConfig.fromJson(deferredSwitchResponse()),
      );
      expect(provider.pendingConfiguration.hasCliSwitch(provider.cli), isTrue);

      // 下一轮的落点：cli 已经是新车道的权威值，pending 自然消失。
      provider.applyCliConfig(
        const SessionCliConfig(cli: SessionCli.claudeExp, model: 'm-new'),
      );
      expect(provider.cli, SessionCli.claudeExp);
      expect(provider.pendingConfiguration.desiredCli(provider.cli), SessionCli.claudeExp);
      expect(provider.pendingConfiguration.hasCliSwitch(provider.cli), isFalse);
      expect(provider.pendingConfiguration.isSet, isFalse);
      await Future<void>.delayed(Duration.zero);
    });

    test('同车道换线路（AI 配置）也是 pending，但不该算换道', () async {
      final s = await settings();
      final provider = ChatProvider(
        settings: s,
        sessionName: 's-provider',
        sessionCwd: '/tmp/x',
        quotaService: _StubQuotaService(s),
      );
      addTearDown(provider.dispose);

      provider.applyCliConfig(const SessionCliConfig(cli: SessionCli.claude));
      provider.applyProviderSwitch(
        const SessionCliConfig(
          cli: SessionCli.claude,
          provider: 'p2',
          pending: SessionPendingConfiguration(
            cli: SessionCli.claude,
            provider: 'p2',
            model: 'm2',
          ),
        ),
      );

      expect(provider.pendingConfiguration.isSet, isTrue);
      expect(provider.pendingConfiguration.hasCliSwitch(provider.cli), isFalse, reason: '车道没变，角标不该挂换道记号');
      expect(provider.pendingConfiguration.desiredCli(provider.cli), SessionCli.claude);
      await Future<void>.delayed(Duration.zero);
    });

    test('下轮已应用 / 另一个端取消：applyPendingConfiguration(null) 清记号', () async {
      final s = await settings();
      final provider = ChatProvider(
        settings: s,
        sessionName: 's-clear',
        sessionCwd: '/tmp/x',
        quotaService: _StubQuotaService(s),
      );
      addTearDown(provider.dispose);

      const pending = SessionPendingConfiguration(
        cli: SessionCli.claudeExp,
        provider: 'p-new',
      );
      provider.applyPendingConfiguration(pending);
      expect(provider.pendingConfiguration.isSet, isTrue);

      // 同一个对象重复送（每条 WS 帧都是一次重建）不该反复通知。
      var notified = 0;
      provider.addListener(() => notified++);
      provider.applyPendingConfiguration(pending);
      expect(notified, 0);

      provider.applyPendingConfiguration(null);
      expect(provider.pendingConfiguration.isSet, isFalse);
      expect(provider.pendingConfiguration.desiredCli(provider.cli), provider.cli);
      expect(notified, 1);
      await Future<void>.delayed(Duration.zero);
    });
  });

  Future<void> pumpHeader(
    WidgetTester tester,
    SessionManager mgr,
    SettingsService settings,
    ChatProvider provider,
  ) => tester.pumpWidget(
    MultiProvider(
      providers: [
        ChangeNotifierProvider<SessionManager>.value(value: mgr),
        ChangeNotifierProvider<ChatProvider>.value(value: provider),
      ],
      child: MaterialApp(
        home: Scaffold(
          body: Align(
            alignment: Alignment.topCenter,
            // 窄屏（<500）：角标是紧凑形态，也是用户手机上真实的那个形态。
            child: SizedBox(
              width: 360,
              child: ChatHeader(
                settings: settings,
                mergeReady: false,
                cwd: '',
                onCwd: () {},
                onMerge: () {},
                onRole: () {},
                onMemory: () {},
                onMemo: () {},
                onShare: () {},
                onForceSync: () {},
                onChatWidth: () {},
                autoCommit: true,
                onAutoCommit: () {},
                onDebug: () {},
                onArtifacts: () {},
              ),
            ),
          ),
        ),
      ),
    ),
  );

  testWidgets('窄页头运行配置 chip 读待生效的那条车道，并挂着「下轮生效」', (tester) async {
    final s = await settings();
    final mgr = SessionManager(settings: s);
    final provider = ChatProvider(
      settings: s,
      sessionName: 's-badge',
      displayName: '任务',
      dirName: 'multicc',
      sessionCwd: '/tmp/x',
      quotaService: _StubQuotaService(s),
    );

    final pendingName = cliDisplayName(SessionCli.claudeExp.name);
    final liveName = cliDisplayName(SessionCli.codex.name);
    expect(pendingName, isNot(liveName), reason: '两条车道的显示名必须不同，否则这个断言什么都没证明');

    // 服务端还在 codex 上跑，用户刚把车道选成 claude-exp（忙碌中 → 下轮生效）。
    provider.applyCliConfig(
      SessionCliConfig.fromJson(deferredSwitchResponse()),
    );
    expect(provider.cli, SessionCli.codex);

    await pumpHeader(tester, mgr, s, provider);

    // 窄页头里 chip 是紧凑形态（只有图标 + tooltip，不写字），所以车道从 chip
    // 自己的 `cli` 上断言：必须是用户选的那条，而不是会话正跑着的 codex。
    final chip = tester.widget<RunChip>(find.byType(RunChip));
    expect(chip.cli, SessionCli.claudeExp);
    expect(chip.cli, isNot(provider.cli));
    expect(chip.pending, isNotNull);
    // 窄页头用 tooltip 承载「下轮生效」四个字（文字标记会把这一行顶爆）。
    expect(
      find.byTooltip('运行配置（${t('cliSwitchPending')}）'),
      findsOneWidget,
    );

    provider.dispose();
    mgr.dispose();
  });

  testWidgets('运行配置 chip 按待生效的那份线路/模型渲染', (tester) async {
    final s = await settings();
    final mgr = SessionManager(settings: s);
    final provider = ChatProvider(
      settings: s,
      sessionName: 's-chip',
      sessionCwd: '/tmp/x',
      quotaService: _StubQuotaService(s),
    );

    await tester.pumpWidget(
      MultiProvider(
        providers: [
          ChangeNotifierProvider<SessionManager>.value(value: mgr),
          ChangeNotifierProvider<ChatProvider>.value(value: provider),
        ],
        child: MaterialApp(
          home: Scaffold(
            body: Align(
              alignment: Alignment.topCenter,
              child: RunChip(
                sessionId: 's-chip',
                cli: SessionCli.claudeExp,
                settings: s,
                pending: const SessionPendingConfiguration(
                  cli: SessionCli.claudeExp,
                  provider: 'p-new',
                  model: 'm-new',
                ),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pump();

    // chip 显示的是 pending 里的线路 + 模型，而不是会话记录里旧车道那一份。
    expect(find.textContaining('p-new · m-new'), findsOneWidget);
    // 宽形态下「下轮生效」直接写在药丸上（web 的 [data-pending]::after 同款）。
    expect(find.text(t('cliSwitchPending')), findsOneWidget);

    provider.dispose();
    mgr.dispose();
  });
}
