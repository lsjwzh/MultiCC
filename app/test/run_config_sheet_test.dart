// 「运行配置」面板（app/lib/widgets/run_config/）—— 以前分成换道面板 +
// AI 配置药丸的那两件事现在只有这一个入口。这里钉的是**面板本身**：两段控制、
// 固定一条的交回值、自动挑选的线路池与两条车道规则（行车道菜单 / 添加线路只列
// OpenCode 自己的原生线路）、无效遗留行的黄标，以及 chip 上那几句话。
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/models/message.dart';
import 'package:multicc_app/providers/chat_provider.dart';
import 'package:multicc_app/providers/session_manager.dart';
import 'package:multicc_app/services/quota_service.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/widgets/run_config/run_chip.dart';
import 'package:multicc_app/widgets/run_config/run_config_models.dart';
import 'package:multicc_app/widgets/run_config/run_config_sheet.dart';
import 'package:multicc_app/widgets/run_config/run_config_wire.dart';
import 'package:multicc_app/widgets/run_config/run_labels.dart';

http.Response _json(int status, Object body) => http.Response(
  jsonEncode(body),
  status,
  headers: {'content-type': 'application/json'},
);

/// 面板交回来的那份结果（异步写入，测试末尾读）。
class _Captured {
  RunConfigOutcome? value;
}

/// 弹面板。返回值写入 [out]；面板关掉之后由调用方读。
Future<void> _open(
  WidgetTester tester,
  RunConfigSheet sheet,
  _Captured out,
) async {
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: Builder(
          builder: (context) => ElevatedButton(
            key: const Key('open-run-config'),
            onPressed: () async {
              out.value = await showModalBottomSheet<RunConfigOutcome>(
                context: context,
                isScrollControlled: true,
                builder: (_) => sheet,
              );
            },
            child: const Text('open'),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.byKey(const Key('open-run-config')));
  await tester.pumpAndSettle();
}

Future<void> _save(WidgetTester tester) async {
  final save = find.widgetWithText(ElevatedButton, '保存');
  await tester.ensureVisible(save);
  await tester.tap(save);
  await tester.pumpAndSettle();
}

const _claudeProviders = <Map<String, dynamic>>[
  {
    'id': 'official',
    'name': '官方',
    'protocol': 'anthropic',
    'builtinOfficial': true,
    'modelOptions': ['claude-opus-5', 'claude-sonnet-5'],
  },
  {
    'id': 'relay',
    'name': 'Zhipu',
    'protocol': 'anthropic',
    'modelOptions': ['glm-5.2'],
  },
];

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(() => I18n.init('zh'));

  Future<SettingsService> settings({String host = 'http://127.0.0.1:1'}) async {
    SharedPreferences.setMockInitialValues({
      'multicc_host': host,
      'multicc_token': '',
    });
    return SettingsService.getInstance();
  }

  testWidgets('窄屏键盘展开时保存仍可点，旧会话不重复显示 CLI', (tester) async {
    tester.view.physicalSize = const Size(320, 600);
    tester.view.devicePixelRatio = 1;
    tester.view.viewInsets = const FakeViewPadding(bottom: 260);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.view.resetViewInsets);
    final out = _Captured();
    await _open(
      tester,
      const RunConfigSheet(
        cli: SessionCli.claude,
        providers: _claudeProviders,
        provider: 'relay',
        model: '',
        effort: 'medium',
        cliAvailability: {
          SessionCli.claudeExp: true,
          SessionCli.codexExp: true,
        },
      ),
      out,
    );
    expect(tester.takeException(), isNull);
    expect(find.byKey(const Key('run-cli-option-claude')), findsNothing);
    expect(find.byKey(const Key('run-cli-option-claude-exp')), findsOneWidget);
    expect(find.textContaining('Agent SDK'), findsNothing);
    expect(find.textContaining('App Server'), findsNothing);
    final save = find.widgetWithText(ElevatedButton, '保存');
    expect(save.hitTestable(), findsOneWidget);
    await tester.tap(save);
    await tester.pumpAndSettle();
    expect(out.value?.switchToCli, isNull);
    expect(out.value?.provider, 'relay');
  });

  // ── 固定一条 ────────────────────────────────────────────────────────────

  testWidgets('固定一条：线路、模型、推理强度一起交回去', (tester) async {
    final out = _Captured();
    await _open(
      tester,
      const RunConfigSheet(
        cli: SessionCli.claude,
        providers: _claudeProviders,
        provider: 'relay',
        model: '',
        effort: 'medium',
      ),
      out,
    );

    // 两段控制默认落在「固定一条」，面板上只有一条主线（没有线路池那一堆）。
    expect(find.text('运行配置'), findsOneWidget);
    expect(find.byKey(const Key('run-mode-fixed')), findsOneWidget);
    expect(find.byKey(const Key('run-order-order')), findsNothing);
    expect(find.byKey(const Key('run-cli-option-claude-exp')), findsOneWidget);
    // 用不了的车道折在「未安装的 N 个」底下，点开才铺出来。
    expect(find.byKey(const Key('run-cli-option-codex-exp')), findsNothing);
    expect(find.byKey(const Key('run-cli-unavailable-toggle')), findsOneWidget);
    await tester.tap(find.byKey(const Key('run-cli-unavailable-toggle')));
    await tester.pumpAndSettle();
    // chat 里 codex 给的是常驻那条（codex-exp），一次性车道退出 chat 了。
    expect(find.byKey(const Key('run-cli-option-codex-exp')), findsOneWidget);
    expect(find.byKey(const Key('run-cli-option-codex')), findsNothing);

    // 模型下拉：线路自带的候选 + 「自定义…」。面板比测试窗口高，先滚到它。
    final modelPicker = find.byType(DropdownButtonFormField<String>).at(1);
    await tester.ensureVisible(modelPicker);
    await tester.pumpAndSettle();
    await tester.tap(modelPicker);
    await tester.pumpAndSettle();
    expect(find.text('自定义…'), findsWidgets);
    await tester.tap(find.text('glm-5.2').last);
    await tester.pumpAndSettle();

    // 强度是一排短段：claude 有 low/medium/high/xhigh 四档。
    for (final key in const [
      'run-effort-low',
      'run-effort-medium',
      'run-effort-high',
      'run-effort-xhigh',
    ]) {
      expect(find.byKey(Key(key)), findsOneWidget);
    }
    await tester.tap(find.byKey(const Key('run-effort-xhigh')));
    await tester.pumpAndSettle();

    await _save(tester);
    expect(out.value?.provider, 'relay');
    expect(out.value?.model, 'glm-5.2');
    expect(out.value?.effort, 'xhigh');
    expect(out.value?.providerSelection, isNull, reason: '固定一条就是手动档');
    expect(out.value?.switchToCli, isNull, reason: '车道没换');
  });

  testWidgets('固定一条：换了 CLI 要带回 switchToCli；没线路的车道说自己的账号', (tester) async {
    final out = _Captured();
    await _open(
      tester,
      const RunConfigSheet(
        cli: SessionCli.claude,
        providers: _claudeProviders,
        provider: 'relay',
        model: '',
        effort: 'medium',
        cliAvailability: {SessionCli.claude: true, SessionCli.qoder: true},
      ),
      out,
    );

    // qoder 没有 Provider 池：卡片上写「使用 <CLI> 自己的账号」，选它不该出现线路下拉。
    expect(find.byKey(const Key('run-cli-option-qoder')), findsOneWidget);
    await tester.tap(find.byKey(const Key('run-cli-option-qoder')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('run-providerless-note')), findsOneWidget);
    // 卡片上的理由 + 下面那句说明，说的是同一件事。
    expect(find.text('使用 Qoder CN 自己的账号'), findsNWidgets(2));

    await _save(tester);
    expect(out.value?.provider, '', reason: '没有池子的车道 provider 留空');
    expect(out.value?.switchToCli, 'qoder');
  });

  testWidgets('两段控制：自动挑选 ⇄ 固定一条', (tester) async {
    final out = _Captured();
    await _open(
      tester,
      const RunConfigSheet(
        cli: SessionCli.claude,
        providers: _claudeProviders,
        provider: 'relay',
        model: 'glm-5.2',
        effort: 'medium',
      ),
      out,
    );
    expect(find.byKey(const Key('run-cli-option-claude-exp')), findsOneWidget);

    await tester.tap(find.byKey(const Key('run-mode-auto')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('run-order-order')), findsOneWidget);
    expect(find.byKey(const Key('run-cli-option-claude-exp')), findsNothing);
    // 空池子先给一句提示，而且存不出去。
    expect(find.text('池子还是空的，先添加线路'), findsOneWidget);

    await tester.tap(find.byKey(const Key('run-mode-fixed')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('run-cli-option-claude-exp')), findsOneWidget);
    expect(find.byKey(const Key('run-order-order')), findsNothing);
    expect(out.value, isNull);
  });

  // ── 自动挑选 ────────────────────────────────────────────────────────────

  const pool = SessionProviderSelection(
    protocol: 'anthropic',
    candidates: [
      SessionProviderCandidate(
        providerId: 'cheap',
        model: 'glm-4.5-flash',
        priority: 1,
        cli: 'claude',
      ),
      SessionProviderCandidate(
        providerId: 'strong',
        model: 'glm-5.2',
        priority: 2,
        cli: 'claude',
      ),
    ],
    maxAttempts: 2,
    sticky: false,
  );

  const poolProviders = <Map<String, dynamic>>[
    {
      'id': 'cheap',
      'name': '便宜线',
      'protocol': 'anthropic',
      'modelOptions': ['glm-4.5-flash'],
    },
    {
      'id': 'strong',
      'name': '主力线',
      'protocol': 'anthropic',
      'modelOptions': ['glm-5.2'],
    },
  ];

  testWidgets('按顺序的池子：行、模型下拉、更多里的策略，保存原样写回', (tester) async {
    final out = _Captured();
    await _open(
      tester,
      const RunConfigSheet(
        cli: SessionCli.claude,
        providers: poolProviders,
        provider: 'cheap',
        model: 'glm-4.5-flash',
        effort: 'medium',
        providerSelection: pool,
      ),
      out,
    );

    // 老池子直接开在自动挑选那一段上。
    expect(find.byKey(const Key('run-pool-row-claude:cheap')), findsOneWidget);
    expect(find.byKey(const Key('run-pool-row-claude:strong')), findsOneWidget);
    expect(find.text('便宜线'), findsOneWidget);
    expect(find.text('主力线'), findsOneWidget);
    expect(
      find.byKey(const Key('run-pool-model-claude:strong')),
      findsOneWidget,
    );
    // 按顺序没有档位可选（那是按难度才有的东西）。
    expect(find.byKey(const Key('run-pool-tier-claude:cheap-1')), findsNothing);

    // 「▸ 更多」里才放策略开关。
    expect(find.byKey(const Key('run-sticky')), findsNothing);
    await tester.ensureVisible(find.byKey(const Key('run-auto-more-toggle')));
    await tester.tap(find.byKey(const Key('run-auto-more-toggle')));
    await tester.pumpAndSettle();
    expect(
      tester.widget<SwitchListTile>(find.byKey(const Key('run-sticky'))).value,
      isFalse,
      reason: '池子里的 sticky=false 要回显',
    );
    expect(find.byKey(const Key('run-max-attempts-2')), findsOneWidget);

    await _save(tester);
    final saved = out.value?.providerSelection;
    expect(saved?.cliSwitch, 'failover');
    expect(saved?.routing, isNull);
    expect(saved?.sticky, isFalse);
    expect(saved?.candidates, hasLength(2));
    expect(saved?.candidates.map((c) => c.cli), ['claude', 'claude']);
    expect(saved?.candidates.first.model, 'glm-4.5-flash');
    // 面板交回的第一条就是这一轮真跑的那条。
    expect(out.value?.provider, 'cheap');
    expect(out.value?.model, 'glm-4.5-flash');
  });

  testWidgets('按难度：Jev 就绪状态 + 档位来源，两档都写得出', (tester) async {
    final out = _Captured();
    await _open(
      tester,
      const RunConfigSheet(
        cli: SessionCli.claude,
        providers: poolProviders,
        provider: 'cheap',
        model: 'glm-4.5-flash',
        effort: 'medium',
        providerSelection: pool,
      ),
      out,
    );

    await tester.tap(find.byKey(const Key('run-order-difficulty')));
    await tester.pumpAndSettle();
    // 池子里没有 routing 块 = 还没配过 Jev。
    expect(find.byKey(const Key('run-jev-status')), findsOneWidget);
    expect(find.textContaining('先配置 Jev'), findsOneWidget);
    // 默认「交给 Jev」：档位由价格表算，面板上不标。
    expect(find.byKey(const Key('run-tiering-jev')), findsOneWidget);
    expect(find.byKey(const Key('run-pool-tier-claude:cheap-1')), findsNothing);

    await tester.tap(find.byKey(const Key('run-tiering-manual')));
    await tester.pumpAndSettle();
    expect(
      find.byKey(const Key('run-pool-tier-claude:cheap-1')),
      findsOneWidget,
    );
    expect(
      find.byKey(const Key('run-pool-tier-claude:strong-3')),
      findsOneWidget,
    );
    // 手点一下「便宜线 = 简单」：没点的那条按模型名猜（主力线归复杂）。
    await tester.ensureVisible(
      find.byKey(const Key('run-pool-tier-claude:cheap-1')),
    );
    await tester.tap(find.byKey(const Key('run-pool-tier-claude:cheap-1')));
    await tester.pumpAndSettle();

    await _save(tester);
    final routing = out.value?.providerSelection?.routing;
    expect(routing?.provider, 'jev');
    expect(routing?.tiers, ['t1', 't2']);
    expect(out.value?.providerSelection?.cliSwitch, 'routing');
    expect(out.value?.providerSelection?.candidates.map((c) => c.tier), [
      't1',
      't2',
    ]);
  });

  testWidgets('交给 Jev：写价格档，候选不带 tier，面板不暴露的旋钮原样带回', (tester) async {
    final out = _Captured();
    await _open(
      tester,
      RunConfigSheet(
        cli: SessionCli.claude,
        providers: poolProviders,
        provider: 'cheap',
        model: 'glm-4.5-flash',
        effort: 'medium',
        providerSelection: const SessionProviderSelection(
          protocol: 'anthropic',
          candidates: [
            SessionProviderCandidate(
              providerId: 'cheap',
              model: 'glm-4.5-flash',
              priority: 1,
              cli: 'claude',
            ),
            SessionProviderCandidate(
              providerId: 'strong',
              model: 'glm-5.2',
              priority: 2,
              cli: 'claude',
            ),
          ],
          maxAttempts: 2,
          routing: SessionProviderRouting(
            apiKeyName: 'my-key',
            model: 'typesafe-ai/jev',
            timeoutMs: 4000,
          ),
        ),
      ),
      out,
    );

    // 池子里带着 routing 块 = 配过 Jev 了。
    expect(
      find.byKey(const Key('run-order-difficulty')),
      findsOneWidget,
      reason: 'routing 在 = 按难度',
    );
    expect(find.textContaining('Jev（判断消息难度的小模型）已就绪'), findsOneWidget);

    await _save(tester);
    final saved = out.value?.providerSelection;
    expect(saved?.routing?.tiering, 'price');
    expect(saved?.routing?.tiers, isEmpty);
    expect(saved?.routing?.apiKeyName, 'my-key');
    expect(saved?.routing?.model, 'typesafe-ai/jev');
    expect(saved?.routing?.timeoutMs, 4000);
    expect(saved?.candidates.map((c) => c.tier), [null, null]);
  });

  // ── 车道规则 ────────────────────────────────────────────────────────────

  testWidgets('行首车道菜单：跑不了的车道灰着并说明理由', (tester) async {
    final out = _Captured();
    // relay 是 responses 协议：挂不到 claude 车道上（那是面板给不了的组合）。
    await _open(
      tester,
      const RunConfigSheet(
        cli: SessionCli.claude,
        providers: [
          {
            'id': 'relay',
            'name': 'Responses 中继',
            'protocol': 'openai_responses',
          },
          {'id': 'strong', 'name': '主力线', 'protocol': 'openai_responses'},
        ],
        provider: 'relay',
        model: '',
        effort: 'medium',
        cliAvailability: {SessionCli.claude: true, SessionCli.codexExp: true},
        providerSelection: SessionProviderSelection(
          protocol: 'openai_responses',
          candidates: [
            SessionProviderCandidate(
              providerId: 'relay',
              priority: 1,
              cli: 'claude',
            ),
            SessionProviderCandidate(
              providerId: 'strong',
              priority: 2,
              cli: 'claude',
            ),
          ],
          maxAttempts: 2,
        ),
      ),
      out,
    );

    await tester.tap(find.byKey(const Key('run-pool-lane-claude:relay')));
    await tester.pumpAndSettle();
    // claude 是 anthropic 车道，跑不了 responses 线路；zcode / kimi 还要 baseUrl。
    expect(find.text('协议不兼容'), findsWidgets);
    expect(find.text('需要 baseUrl + token'), findsWidgets);

    // 换成 codex（responses 车道，菜单里排最前的那条）就合法了 —— 行 id 跟着车道走。
    await tester.tap(find.text('Codex').first);
    await tester.pumpAndSettle();
    expect(
      find.byKey(const Key('run-pool-row-codex-exp:relay')),
      findsOneWidget,
    );

    await _save(tester);
    expect(out.value?.providerSelection?.candidates.first.cli, 'codex-exp');
    expect(out.value?.switchToCli, 'codex-exp', reason: '池子第一条换了车道');
  });

  testWidgets('遗留的无效行：黄标 + 原因，但不进候选也不算有效行', (tester) async {
    final out = _Captured();
    await _open(
      tester,
      const RunConfigSheet(
        cli: SessionCli.claude,
        providers: poolProviders,
        provider: 'cheap',
        model: 'glm-4.5-flash',
        effort: 'medium',
        // OpenCode 原生线路只能跑在 opencode 车道上 —— 这条是坏的，留着给用户改。
        providerSelection: SessionProviderSelection(
          protocol: 'anthropic',
          candidates: [
            SessionProviderCandidate(
              providerId: 'cheap',
              priority: 1,
              cli: 'claude',
            ),
            SessionProviderCandidate(
              providerId: 'strong',
              priority: 2,
              cli: 'claude',
            ),
            SessionProviderCandidate(
              providerId: 'opencode-native:opencodego',
              priority: 3,
              cli: 'claude',
            ),
          ],
          maxAttempts: 2,
        ),
      ),
      out,
    );

    final bad = find.byKey(
      const Key('run-pool-row-claude:opencode-native:opencodego'),
    );
    expect(bad, findsOneWidget, reason: '坏行留在面板上，不能被静默丢掉');
    expect(
      find.byKey(
        const Key('run-pool-row-problem-claude:opencode-native:opencodego'),
      ),
      findsOneWidget,
    );
    expect(
      find.textContaining('OpenCode 原生线路只能跑在 OpenCode 车道上'),
      findsOneWidget,
    );

    // 另外两条有效 → 仍能存，只是坏行不上 wire。
    await _save(tester);
    expect(out.value?.providerSelection?.candidates, hasLength(2));
    expect(out.value?.providerSelection?.candidates.map((c) => c.providerId), [
      'cheap',
      'strong',
    ]);
  });

  testWidgets('添加线路：只列能用到的组合，OpenCode 那一组只列它自己的原生线路', (tester) async {
    final s = await settings(host: 'http://server.example');
    final client = MockClient((request) async {
      final cli = request.url.queryParameters['cli'] ?? '';
      if (request.url.path == '/api/opencode/models') {
        return _json(200, {
          'models': [
            {'provider': 'opencodego', 'model': 'kimi-k2', 'label': 'K2'},
          ],
        });
      }
      if (request.url.path == '/api/codex/models') {
        return _json(200, {'ok': true, 'models': const []});
      }
      if (request.url.path == '/api/providers') {
        if (cli == 'opencode') {
          return _json(200, {
            'providers': [
              {'id': 'oc-managed', 'name': 'OC 中继', 'protocol': 'anthropic'},
            ],
          });
        }
        return _json(200, {
          'providers': [
            {'id': '$cli-line', 'name': '$cli 线路', 'protocol': 'anthropic'},
          ],
        });
      }
      return _json(404, {'error': 'not found'});
    });

    final out = _Captured();
    await _open(
      tester,
      RunConfigSheet(
        cli: SessionCli.claude,
        providers: poolProviders,
        provider: 'cheap',
        model: 'glm-4.5-flash',
        effort: 'medium',
        settings: s,
        httpClient: client,
        cliAvailability: {
          SessionCli.claude: true,
          SessionCli.codexExp: true,
          SessionCli.opencode: true,
        },
        providerSelection: const SessionProviderSelection(
          protocol: 'anthropic',
          candidates: [
            SessionProviderCandidate(
              providerId: 'cheap',
              priority: 1,
              cli: 'claude',
            ),
            SessionProviderCandidate(
              providerId: 'opencode-native:opencodego',
              priority: 2,
              cli: 'opencode',
            ),
          ],
          maxAttempts: 2,
        ),
      ),
      out,
    );

    await tester.ensureVisible(find.byKey(const Key('run-add-line')));
    await tester.tap(find.byKey(const Key('run-add-line')));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('run-add-line-search')), findsOneWidget);
    // OpenCode 组里只有它自己的原生线路（中继那一条要回上面的 claude 组找）。
    expect(
      find.byKey(const Key('run-add-line-opencode-opencode-native:opencodego')),
      findsOneWidget,
    );
    expect(
      find.byKey(const Key('run-add-line-opencode-oc-managed')),
      findsNothing,
    );
    expect(find.textContaining('上面的线路也都能跑'), findsOneWidget);
    // 已经在池子里的那条挂着 ✓，点不动。
    expect(find.text('✓ 已在池里'), findsOneWidget);
    expect(
      tester
          .widget<ListTile>(
            find.byKey(
              const Key('run-add-line-opencode-opencode-native:opencodego'),
            ),
          )
          .onTap,
      isNull,
    );

    // 搜索能过滤，点一条就把行加进池子。
    await tester.enterText(find.byKey(const Key('run-add-line-search')), '线路');
    await tester.pumpAndSettle();
    await tester.tap(
      find.byKey(const Key('run-add-line-codex-exp-codex-exp-line')),
    );
    await tester.pumpAndSettle();
    expect(
      find.byKey(const Key('run-pool-row-codex-exp:codex-exp-line')),
      findsOneWidget,
    );
  });

  testWidgets('添加线路：整批取不到时说加载失败并给重试，不是「没有可用线路」', (tester) async {
    final s = await settings(host: 'http://server.example');
    var calls = 0;
    final client = MockClient((request) async {
      if (request.url.path == '/api/opencode/models') {
        return _json(200, {'models': const []});
      }
      calls += 1;
      return _json(500, {'error': 'boom'});
    });

    final out = _Captured();
    await _open(
      tester,
      RunConfigSheet(
        cli: SessionCli.claude,
        providers: poolProviders,
        provider: 'cheap',
        model: '',
        effort: 'medium',
        settings: s,
        httpClient: client,
        cliAvailability: {SessionCli.claude: true, SessionCli.codexExp: true},
        providerSelection: pool,
      ),
      out,
    );
    await tester.ensureVisible(find.byKey(const Key('run-add-line')));
    await tester.tap(find.byKey(const Key('run-add-line')));
    await tester.pumpAndSettle();

    expect(find.text('线路列表加载失败'), findsOneWidget);
    expect(find.text('没有可用线路'), findsNothing);
    final before = calls;
    await tester.tap(find.byKey(const Key('run-add-line-retry')));
    await tester.pumpAndSettle();
    expect(calls, greaterThan(before), reason: '重试要真的再打一次');
  });

  // ── 页头 chip ───────────────────────────────────────────────────────────

  testWidgets('chip：固定一条写 CLI · 线路 · 模型，自动挑选写池子条数', (tester) async {
    final s = await settings();
    final mgr = SessionManager(settings: s);
    final provider = ChatProvider(
      settings: s,
      sessionName: 's-chip',
      sessionCwd: '/tmp/x',
      quotaService: _NullQuotaService(s),
    );
    // SessionManager 有一条 5s 周期刷新，ChatService 还挂着重连定时器 ——
    // pending timer 的检查在 tearDown 之前，所以必须在测试体里收干净。
    var disposed = false;
    void disposeAll() {
      if (disposed) return;
      disposed = true;
      provider.dispose();
      mgr.dispose();
    }

    addTearDown(disposeAll);
    await tester.pumpWidget(
      MultiProvider(
        providers: [
          ChangeNotifierProvider<SessionManager>.value(value: mgr),
          ChangeNotifierProvider<ChatProvider>.value(value: provider),
        ],
        child: MaterialApp(
          home: Scaffold(
            body: Column(
              children: [
                RunChip(
                  sessionId: 's-chip',
                  cli: SessionCli.claude,
                  settings: s,
                ),
              ],
            ),
          ),
        ),
      ),
    );
    await tester.pump();
    // 线路段说「官方」（不是半中半英的「官方 Provider」），强度也是中文档名。
    expect(find.textContaining('Claude · 官方 · 默认 · 中'), findsOneWidget);

    // 会话切到自动挑选：chip 说「⚡ 自动 · 按顺序 · N 条」。
    provider.applyProviderSwitch(
      const SessionCliConfig(cli: SessionCli.claude, providerSelection: pool),
    );
    await tester.pump();
    expect(find.textContaining('⚡ 自动 · 按顺序 · 2 条'), findsOneWidget);

    await tester.pumpWidget(const SizedBox());
    disposeAll();
  });

  // ── 文案与折叠 ──────────────────────────────────────────────────────────

  test('车道标签只展示产品名（镜像 Web cliChoiceLabel）', () {
    expect(cliChoiceLabel('claude'), 'Claude');
    expect(cliChoiceLabel('claude-exp'), 'Claude');
    expect(cliChoiceLabel('codex'), 'Codex');
    expect(cliChoiceLabel('codex-exp'), 'Codex');
    expect(cliChoiceLabel('opencode'), 'OpenCode');
    expect(cliChoiceLabel('zcode'), 'ZCode');
    expect(cliChoiceLabel('kimi'), 'Kimi Code');
  });

  test('chip 的强度写中文档名，不写 wire 值', () {
    expect(effortChipLabel(SessionCli.claude, 'medium'), '中');
    expect(effortChipLabel(SessionCli.claude, 'xhigh'), '最高');
    expect(
      effortChipLabel(SessionCli.claude, ''),
      '中',
      reason: '空串 = 车道默认 medium',
    );
    expect(effortChipLabel(SessionCli.codexExp, 'minimal'), '最低');
    expect(
      effortChipLabel(SessionCli.zcode, 'medium'),
      '',
      reason: '不支持强度的车道不写',
    );
  });

  test('chip 的线路段把「官方 Provider」收成「官方」', () {
    expect(runProviderChipLabel('', providers: const []), '官方');
    expect(runProviderChipLabel(null, providers: const []), '官方');
    expect(
      runProviderChipLabel(
        'relay',
        providers: const [
          {'id': 'relay', 'name': 'Zhipu'},
        ],
      ),
      'Zhipu',
    );
  });

  testWidgets('未安装的车道默认折起来，点开才铺出来', (tester) async {
    final out = _Captured();
    await _open(
      tester,
      const RunConfigSheet(
        cli: SessionCli.claude,
        providers: _claudeProviders,
        provider: 'relay',
        model: '',
        effort: 'medium',
      ),
      out,
    );

    // 只有会话现在这条能用：其余全折在「▸ 未安装的 N 个」底下。
    expect(find.byKey(const Key('run-cli-option-claude-exp')), findsOneWidget);
    expect(find.byKey(const Key('run-cli-option-codex-exp')), findsNothing);
    expect(find.byKey(const Key('run-cli-option-opencode')), findsNothing);
    expect(find.textContaining('未安装的'), findsOneWidget);

    await tester.tap(find.byKey(const Key('run-cli-unavailable-toggle')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('run-cli-option-codex-exp')), findsOneWidget);
    expect(find.byKey(const Key('run-cli-option-opencode')), findsOneWidget);
    expect(find.textContaining('未安装的'), findsOneWidget, reason: '计数行还在，只是换成 ▾');

    // 再点一次收回去。
    await tester.tap(find.byKey(const Key('run-cli-unavailable-toggle')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('run-cli-option-codex-exp')), findsNothing);
  });

  testWidgets('行首车道菜单每个产品只提供一条现代车道', (tester) async {
    final out = _Captured();
    await _open(
      tester,
      const RunConfigSheet(
        cli: SessionCli.claude,
        providers: poolProviders,
        provider: 'cheap',
        model: 'glm-4.5-flash',
        effort: 'medium',
        providerSelection: pool,
      ),
      out,
    );

    await tester.tap(find.byKey(const Key('run-pool-lane-claude:cheap')));
    await tester.pumpAndSettle();
    final items = tester
        .widgetList<PopupMenuItem<String>>(find.byType(PopupMenuItem<String>))
        .map((item) => item.value)
        .toList();
    expect(items, containsAll(['claude-exp', 'codex-exp']));
    expect(items, isNot(contains('claude')));
    expect(items, isNot(contains('codex')));
    expect(find.text('Codex'), findsOneWidget);
    expect(find.text('Kimi Code'), findsOneWidget);
    expect(find.text('OpenCode'), findsOneWidget);
  });
}

/// 额度查询全部同步回 null：真实现会打网络，收尾的 notifyListeners() 可能落在
/// 已 dispose 的 provider 上。
class _NullQuotaService extends QuotaService {
  _NullQuotaService(SettingsService settings) : super(settings: settings);

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
