import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/models/message.dart';
import 'package:multicc_app/services/auto_provider_routing.dart';
import 'package:multicc_app/services/session_service.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/widgets/ai_config_sheet.dart';
import 'package:multicc_app/widgets/model_chip.dart';

http.Response _json(int status, Object body) => http.Response(
  jsonEncode(body),
  status,
  headers: {'content-type': 'application/json'},
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() => I18n.init('zh'));

  const selection = SessionProviderSelection(
    protocol: 'anthropic',
    candidates: [
      SessionProviderCandidate(providerId: 'p1', model: 'model-a', priority: 1),
      SessionProviderCandidate(providerId: 'p2', model: 'model-b', priority: 2),
    ],
    maxAttempts: 2,
    sticky: false,
  );

  test('session DTOs parse and preserve the additive Auto selection', () {
    final json = selection.toJson();
    final session = Session.fromJson({
      'id': 'chat-1',
      'kind': 'chat',
      'cli': 'claude',
      'createdAt': '2026-08-25T00:00:00.000Z',
      'provider': 'p1',
      'providerSelection': json,
      'cliStates': {
        'claude': {'provider': 'p1', 'providerSelection': json},
      },
    });
    final config = SessionCliConfig.fromJson({
      'cli': 'claude',
      'provider': 'p1',
      'providerSelection': json,
    });

    expect(session.providerSelection?.protocol, 'anthropic');
    expect(session.providerSelection?.candidates[1].model, 'model-b');
    expect(session.providerSelection?.sticky, isFalse);
    expect(
      session.cliStates[SessionCli.claude]?.providerSelection?.maxAttempts,
      2,
    );
    expect(session.copyWith(label: 'renamed').providerSelection, isNotNull);
    expect(config.providerSelection?.candidates, hasLength(2));
    expect(config.providerSelection?.toJson(), json);
  });

  test('session DTOs preserve explicit mixed-trust authorization', () {
    const mixed = SessionProviderSelection(
      protocol: 'anthropic',
      candidates: [
        SessionProviderCandidate(providerId: 'official', priority: 1),
        SessionProviderCandidate(providerId: 'relay', priority: 2),
      ],
      maxAttempts: 2,
      allowCrossTrust: true,
    );

    final json = mixed.toJson();
    expect(json['allowCrossTrust'], isTrue);
    expect(json['candidates'][0]['model'], isNull);
    expect(parseProviderSelection(json)?.allowCrossTrust, isTrue);
    final legacy = Map<String, dynamic>.from(json)..remove('allowCrossTrust');
    expect(parseProviderSelection(legacy)?.allowCrossTrust, isFalse);
  });

  test('PATCH body sends Auto config and manual save explicitly clears it', () {
    final auto = sessionAIConfigPatchBody(
      provider: 'p1',
      providerSelection: selection,
      model: 'model-a',
      effort: 'medium',
    );
    expect(auto['provider'], 'p1');
    expect(auto['providerSelection'], selection.toJson());

    final manual = sessionAIConfigPatchBody(
      provider: 'p2',
      model: 'model-b',
      effort: 'high',
    );
    expect(manual.containsKey('providerSelection'), isTrue);
    expect(manual['providerSelection'], isNull);
  });

  test('Auto title does not claim the configured primary before routing', () {
    expect(autoProviderRouteLabel('anthropic', null), 'Auto · Anthropic → 待路由');
    expect(
      autoProviderRouteLabel('anthropic', 'Working backup'),
      'Auto · Anthropic → Working backup',
    );
  });

  testWidgets('Auto pool exposes routes, priorities, models and policy', (
    tester,
  ) async {
    AIConfigResult? result;
    const providers = <Map<String, dynamic>>[
      {
        'id': 'p1',
        'name': 'No quota primary',
        'protocol': 'anthropic',
        'isOfficial': false,
        'modelOptions': ['model-a'],
      },
      {
        'id': 'p2',
        'name': 'Working backup',
        'protocol': 'anthropic',
        'isOfficial': false,
        'modelOptions': ['model-b'],
      },
    ];

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (context) => ElevatedButton(
              key: const Key('open-auto-config'),
              onPressed: () async {
                result = await showModalBottomSheet<AIConfigResult>(
                  context: context,
                  isScrollControlled: true,
                  builder: (_) => const AIConfigSheet(
                    cli: SessionCli.claude,
                    providers: providers,
                    provider: 'p1',
                    providerSelection: selection,
                    model: 'model-a',
                    effort: 'medium',
                  ),
                );
              },
              child: const Text('open'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.byKey(const Key('open-auto-config')));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('auto-provider-section')), findsOneWidget);
    expect(find.text('No quota primary'), findsOneWidget);
    expect(find.text('Working backup'), findsOneWidget);
    expect(find.byKey(const Key('auto-candidate-priority-p1')), findsOneWidget);
    expect(find.byKey(const Key('auto-candidate-model-p2')), findsOneWidget);
    expect(find.byKey(const Key('auto-provider-max-attempts')), findsOneWidget);
    final sticky = tester.widget<SwitchListTile>(
      find.byKey(const Key('auto-provider-sticky')),
    );
    expect(sticky.value, isFalse);

    final save = find.widgetWithText(ElevatedButton, '保存');
    await tester.ensureVisible(save);
    await tester.tap(save);
    await tester.pumpAndSettle();

    expect(result?.provider, 'p1');
    expect(result?.providerSelection?.protocol, 'anthropic');
    expect(result?.providerSelection?.candidates, hasLength(2));
    expect(result?.providerSelection?.candidates.first.model, 'model-a');
    expect(result?.providerSelection?.sticky, isFalse);
  });

  testWidgets('picker can enter Auto mode and return to manual mode', (
    tester,
  ) async {
    const providers = <Map<String, dynamic>>[
      {
        'id': 'p1',
        'name': 'Primary',
        'protocol': 'anthropic',
        'isOfficial': false,
      },
      {
        'id': 'p2',
        'name': 'Backup',
        'protocol': 'anthropic',
        'isOfficial': false,
      },
    ];
    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(
          body: SizedBox(
            width: 380,
            height: 900,
            child: AIConfigSheet(
              cli: SessionCli.claude,
              providers: providers,
              provider: 'p1',
              model: '',
              effort: 'medium',
            ),
          ),
        ),
      ),
    );

    await tester.tap(find.byType(DropdownButtonFormField<String>).first);
    await tester.pumpAndSettle();
    await tester.tap(find.text('⚡ Auto · Anthropic').last);
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('auto-provider-section')), findsOneWidget);
    expect(
      tester
          .widget<Checkbox>(find.byKey(const Key('auto-candidate-enabled-p1')))
          .value,
      isTrue,
    );
    expect(
      tester
          .widget<Checkbox>(find.byKey(const Key('auto-candidate-enabled-p2')))
          .value,
      isTrue,
    );

    await tester.tap(find.byType(DropdownButtonFormField<String>).first);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Primary').last);
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('auto-provider-section')), findsNothing);
  });

  testWidgets(
    'existing Auto pool exposes Official and warns when mixed trust is enabled',
    (tester) async {
      AIConfigResult? result;
      const providers = <Map<String, dynamic>>[
        {
          'id': 'official',
          'name': 'Official',
          'protocol': 'anthropic',
          'isOfficial': true,
        },
        {
          'id': 'p1',
          'name': 'Managed primary',
          'protocol': 'anthropic',
          'isOfficial': false,
        },
        {
          'id': 'p2',
          'name': 'Managed backup',
          'protocol': 'anthropic',
          'isOfficial': false,
        },
      ];

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Builder(
              builder: (context) => ElevatedButton(
                key: const Key('open-mixed-auto-config'),
                onPressed: () async {
                  result = await showModalBottomSheet<AIConfigResult>(
                    context: context,
                    isScrollControlled: true,
                    builder: (_) => const AIConfigSheet(
                      cli: SessionCli.claude,
                      providers: providers,
                      provider: 'p1',
                      providerSelection: selection,
                      model: 'model-a',
                      effort: 'medium',
                    ),
                  );
                },
                child: const Text('open'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.byKey(const Key('open-mixed-auto-config')));
      await tester.pumpAndSettle();

      final official = find.byKey(const Key('auto-candidate-enabled-official'));
      expect(official, findsOneWidget);
      await tester.ensureVisible(official);
      await tester.tap(official);
      await tester.pumpAndSettle();

      expect(
        find.byKey(const Key('auto-provider-cross-trust-warning')),
        findsOneWidget,
      );
      expect(
        find.text('已选择 Official 与自管 Provider：同一对话上下文可能在自动切换时发送给多个上游。'),
        findsOneWidget,
      );

      final save = find.widgetWithText(ElevatedButton, '保存');
      await tester.ensureVisible(save);
      await tester.tap(save);
      await tester.pumpAndSettle();

      expect(result?.providerSelection?.allowCrossTrust, isTrue);
      expect(
        result?.providerSelection?.candidates
            .firstWhere((candidate) => candidate.providerId == 'official')
            .model,
        isNull,
      );
    },
  );

  // 借道线路（没有 modelOptions / aliasMap 的中继）以前在 App 里是个空白文本框，
  // 手打才能填；Web 已改为候选里给本机 Claude 目录。这条锁定 App 的同等行为，
  // 并确保「自定义…」这条手打路径没被下拉吃掉。
  testWidgets(
    'a borrowed Claude line suggests the local catalog and still allows custom ids',
    (tester) async {
      AIConfigResult? result;
      const providers = <Map<String, dynamic>>[
        {
          'id': 'relay',
          'name': 'Leo-Claude 借道',
          'protocol': 'anthropic',
          'isOfficial': false,
        },
        {
          'id': 'managed',
          'name': 'Managed backup',
          'protocol': 'anthropic',
          'isOfficial': false,
          'modelOptions': ['model-a'],
        },
      ];
      const pool = SessionProviderSelection(
        protocol: 'anthropic',
        candidates: [
          SessionProviderCandidate(
            providerId: 'relay',
            model: 'relay-model-x1',
            priority: 1,
          ),
          SessionProviderCandidate(
            providerId: 'managed',
            model: 'model-a',
            priority: 2,
          ),
        ],
        maxAttempts: 2,
        sticky: true,
      );

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Builder(
              builder: (context) => ElevatedButton(
                key: const Key('open-borrowed-auto-config'),
                onPressed: () async {
                  result = await showModalBottomSheet<AIConfigResult>(
                    context: context,
                    isScrollControlled: true,
                    builder: (_) => const AIConfigSheet(
                      cli: SessionCli.claude,
                      providers: providers,
                      provider: 'relay',
                      providerSelection: pool,
                      model: '',
                      effort: 'medium',
                    ),
                  );
                },
                child: const Text('open'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.byKey(const Key('open-borrowed-auto-config')));
      await tester.pumpAndSettle();

      // 配置里已有的自定义 id 不会丢：落到「自定义…」并回显原值。
      expect(
        find.byKey(const Key('auto-candidate-model-custom-relay')),
        findsOneWidget,
      );
      expect(find.text('relay-model-x1'), findsOneWidget);

      final relaySelect = find.byKey(
        const Key('auto-candidate-model-relay'),
      );
      await tester.ensureVisible(relaySelect);
      await tester.tap(relaySelect);
      await tester.pumpAndSettle();
      expect(find.text('claude-opus-5'), findsWidgets);
      expect(find.text('claude-sonnet-5'), findsWidgets);
      expect(find.text('自定义…'), findsWidgets);

      await tester.tap(find.text('claude-opus-5').last);
      await tester.pumpAndSettle();
      expect(
        find.byKey(const Key('auto-candidate-model-custom-relay')),
        findsNothing,
      );

      // 自带 modelOptions 的行不受影响，菜单里不该混入本机 Claude 目录。
      final managedSelect = find.byKey(
        const Key('auto-candidate-model-managed'),
      );
      await tester.ensureVisible(managedSelect);
      await tester.tap(managedSelect);
      await tester.pumpAndSettle();
      expect(find.text('model-a'), findsWidgets);
      expect(find.text('claude-sonnet-5'), findsNothing);
      await tester.tap(find.text('model-a').last);
      await tester.pumpAndSettle();

      final save = find.widgetWithText(ElevatedButton, '保存');
      await tester.ensureVisible(save);
      await tester.tap(save);
      await tester.pumpAndSettle();

      String? modelOf(String providerId) => result?.providerSelection?.candidates
          .firstWhere((candidate) => candidate.providerId == providerId)
          .model;
      expect(modelOf('relay'), 'claude-opus-5');
      expect(modelOf('managed'), 'model-a');
    },
  );

  // ── 难度路由（按难度）同步自 web 的 auto-provider-editor ────────────────────
  // 2026-09-24 web 重写了 Auto 编辑器：多了「按顺序 / 按难度」两种选线路方式、
  // 每行的档位（简单/中等/复杂）、Jev key 步骤。App 这一侧原本只会写顺序池 ——
  // 于是 web 上配好的按难度池被手机打开再保存，routing 就会被静默抹掉，退化成
  // 顺序池。下面这几条把这个坑和新的折算规则都钉住。

  const routedSelection = SessionProviderSelection(
    protocol: 'anthropic',
    candidates: [
      SessionProviderCandidate(
        providerId: 'cheap',
        model: 'glm-4.5-flash',
        priority: 1,
        tier: 't1',
      ),
      SessionProviderCandidate(
        providerId: 'strong',
        model: 'glm-5.2',
        priority: 2,
        tier: 't2',
      ),
    ],
    maxAttempts: 2,
    routing: SessionProviderRouting(
      apiKeyName: 'my-key',
      onUnknown: 'priority',
      tiers: ['t1', 't2'],
      model: 'typesafe-ai/jev',
      timeoutMs: 4000,
      escalation: {'retry': 0.5},
    ),
  );

  test('a difficulty-routed pool survives the trip through the App', () {
    final json = routedSelection.toJson();
    final parsed = parseProviderSelection(json);
    expect(parsed?.routing?.tiers, ['t1', 't2']);
    expect(parsed?.routing?.onUnknown, 'priority');
    expect(parsed?.candidates.first.tier, 't1');
    // 面板不暴露的旋钮原样带回：从手机重新保存不能把 API/网页配好的东西重置。
    expect(parsed?.routing?.model, 'typesafe-ai/jev');
    expect(parsed?.routing?.timeoutMs, 4000);
    expect(parsed?.routing?.escalation, {'retry': 0.5});
    expect(parsed?.routing?.apiKeyName, 'my-key');
    expect(parsed?.toJson(), json);
  });

  test('an unrouted pool still serializes exactly as it always did', () {
    final json = selection.toJson();
    expect(json.containsKey('routing'), isFalse);
    expect((json['candidates'] as List).first, {
      'providerId': 'p1',
      'model': 'model-a',
      'priority': 1,
      'enabled': true,
    });
  });

  test('rungs compact into a ladder the server accepts', () {
    const routes = [
      AutoRoutedRoute(providerId: 'a', model: null, priority: 1, rung: 1),
      AutoRoutedRoute(providerId: 'b', model: null, priority: 2, rung: 1),
      AutoRoutedRoute(providerId: 'c', model: null, priority: 3, rung: 3),
    ];
    final result = serializeAutoRouting(routes: routes, onUnknown: 'weak');
    expect(result.ok, isTrue);
    // 只有顺序有意义：1/1/3 折算成 t1/t1/t2，用户不用自己补齐空档。
    expect(result.routing?.tiers, ['t1', 't2']);
    expect(
      result.candidates.map((candidate) => candidate.tier),
      ['t1', 't1', 't2'],
    );
    expect(result.routing?.onUnknown, 'weak');
    // 没有旧块、又选了服务端默认值时，onUnknown 不落 wire。
    final plain = serializeAutoRouting(routes: routes, onUnknown: 'strong');
    expect(plain.routing?.toJson().containsKey('onUnknown'), isFalse);

    final oneTier = serializeAutoRouting(
      routes: const [
        AutoRoutedRoute(providerId: 'a', model: null, priority: 1, rung: 2),
        AutoRoutedRoute(providerId: 'b', model: null, priority: 2, rung: 2),
      ],
      onUnknown: 'strong',
    );
    expect(oneTier.ok, isFalse);
    expect(oneTier.code, 'provider_routing_requires_tiers');
  });

  test('an untouched row is guessed from its model name, a picked one is not', () {
    final plan = resolveAutoRungs(
      rowTexts: const ['便宜线（glm-4.5-flash）', '主力线（glm-5.2）'],
      chosenRungs: const [null, null],
    );
    expect(plan.ceiling, 2);
    expect(plan.rungs, [1, 2], reason: 'flash 归简单，强模型归复杂');
    // 手点过的档位不被重猜覆盖（web 的 dataset.rung vs dataset.value）。
    final picked = resolveAutoRungs(
      rowTexts: const ['便宜线（glm-4.5-flash）', '主力线（glm-5.2）'],
      chosenRungs: const [2, null],
    );
    expect(picked.rungs, [2, 2]);
    // 名字分不出高下时，第一条按顺序接简单任务（绝不是单档池）。
    final blind = resolveAutoRungs(
      rowTexts: const ['甲', '乙'],
      chosenRungs: const [null, null],
    );
    expect(blind.rungs, [1, 2]);
  });

  testWidgets('the App can route by difficulty and writes the ladder', (
    tester,
  ) async {
    AIConfigResult? result;
    const providers = <Map<String, dynamic>>[
      {
        'id': 'cheap',
        'name': '便宜线',
        'protocol': 'anthropic',
        'isOfficial': false,
        'modelOptions': ['glm-4.5-flash'],
      },
      {
        'id': 'strong',
        'name': '主力线',
        'protocol': 'anthropic',
        'isOfficial': false,
        'modelOptions': ['glm-5.2'],
      },
    ];
    const pool = SessionProviderSelection(
      protocol: 'anthropic',
      candidates: [
        SessionProviderCandidate(
          providerId: 'cheap',
          model: 'glm-4.5-flash',
          priority: 1,
        ),
        SessionProviderCandidate(
          providerId: 'strong',
          model: 'glm-5.2',
          priority: 2,
        ),
      ],
      maxAttempts: 2,
    );

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (context) => ElevatedButton(
              key: const Key('open-routed-auto-config'),
              onPressed: () async {
                result = await showModalBottomSheet<AIConfigResult>(
                  context: context,
                  isScrollControlled: true,
                  builder: (_) => const AIConfigSheet(
                    cli: SessionCli.claude,
                    providers: providers,
                    provider: 'cheap',
                    providerSelection: pool,
                    model: 'glm-4.5-flash',
                    effort: 'medium',
                  ),
                );
              },
              child: const Text('open'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.byKey(const Key('open-routed-auto-config')));
    await tester.pumpAndSettle();

    // 顺序池：没有档位按钮，也就没有 routing 块。
    expect(find.byKey(const Key('auto-candidate-tier-cheap')), findsNothing);
    expect(find.byKey(const Key('auto-provider-jev')), findsNothing);

    await tester.tap(find.byKey(const Key('auto-route-mode-routing')));
    await tester.pumpAndSettle();

    // 打开「按难度」就有 Jev 那一条，而且没给 settings 时只说 key 放哪儿。
    expect(find.byKey(const Key('auto-provider-jev')), findsOneWidget);
    expect(find.textContaining('vercel-api-key'), findsOneWidget);
    expect(find.byKey(const Key('auto-jev-key-input')), findsNothing);
    // 档位：flash 那条自动归「简单」，主力线归「复杂」。
    final cheapChip = tester.widget<Container>(
      find.descendant(
        of: find.byKey(const Key('auto-candidate-tier-cheap-1')),
        matching: find.byType(Container),
      ),
    );
    expect(cheapChip.decoration, isNotNull);
    expect(find.text('判断不了难度时（Jev 超时或没连上）'), findsOneWidget);

    final save = find.widgetWithText(ElevatedButton, '保存');
    await tester.ensureVisible(save);
    await tester.tap(save);
    await tester.pumpAndSettle();

    final routing = result?.providerSelection?.routing;
    expect(routing?.provider, 'jev');
    expect(routing?.tiers, ['t1', 't2']);
    expect(routing?.apiKeyName, 'vercel-api-key');
    expect(
      result?.providerSelection?.candidates.map((candidate) => candidate.tier),
      ['t1', 't2'],
    );
  });

  testWidgets('choosing a tier by hand moves a line up the ladder', (
    tester,
  ) async {
    AIConfigResult? result;
    const providers = <Map<String, dynamic>>[
      {
        'id': 'cheap',
        'name': '便宜线',
        'protocol': 'anthropic',
        'isOfficial': false,
        'modelOptions': ['glm-4.5-flash'],
      },
      {
        'id': 'strong',
        'name': '主力线',
        'protocol': 'anthropic',
        'isOfficial': false,
        'modelOptions': ['glm-5.2'],
      },
    ];
    const pool = SessionProviderSelection(
      protocol: 'anthropic',
      candidates: [
        SessionProviderCandidate(
          providerId: 'cheap',
          model: 'glm-4.5-flash',
          priority: 1,
        ),
        SessionProviderCandidate(
          providerId: 'strong',
          model: 'glm-5.2',
          priority: 2,
        ),
      ],
      maxAttempts: 2,
    );

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (context) => ElevatedButton(
              key: const Key('open-tier-pick'),
              onPressed: () async {
                result = await showModalBottomSheet<AIConfigResult>(
                  context: context,
                  isScrollControlled: true,
                  builder: (_) => const AIConfigSheet(
                    cli: SessionCli.claude,
                    providers: providers,
                    provider: 'cheap',
                    providerSelection: pool,
                    model: 'glm-4.5-flash',
                    effort: 'medium',
                  ),
                );
              },
              child: const Text('open'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.byKey(const Key('open-tier-pick')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('auto-route-mode-routing')));
    await tester.pumpAndSettle();

    // 把便宜线也放到「复杂」：两行同一档，保存必须被拦住（web 同一条规则）。
    final cheapComplex = find.byKey(const Key('auto-candidate-tier-cheap-2'));
    await tester.ensureVisible(cheapComplex);
    await tester.tap(cheapComplex);
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('auto-provider-summary')), findsOneWidget);
    final summary = tester.widget<Text>(
      find.byKey(const Key('auto-provider-summary')),
    );
    expect(summary.data, contains('还差一步'));

    final save = find.widgetWithText(ElevatedButton, '保存');
    await tester.ensureVisible(save);
    await tester.tap(save);
    await tester.pumpAndSettle();
    expect(result, isNull, reason: '单档池不能存出去');
    expect(find.byKey(const Key('auto-provider-error')), findsOneWidget);

    // 改回「简单」就恢复成一档一线，能存。
    final cheapSimple = find.byKey(const Key('auto-candidate-tier-cheap-1'));
    await tester.ensureVisible(cheapSimple);
    await tester.tap(cheapSimple);
    await tester.pumpAndSettle();
    await tester.ensureVisible(save);
    await tester.tap(save);
    await tester.pumpAndSettle();
    expect(result?.providerSelection?.routing?.tiers, ['t1', 't2']);
  });

  testWidgets('the Jev step walks the key from missing to connected', (
    tester,
  ) async {
    SharedPreferences.setMockInitialValues({
      'multicc_host': 'http://server.example',
      'multicc_token': 'secret',
    });
    final settings = await SettingsService.getInstance();
    AIConfigResult? result;
    final calls = <String>[];
    final client = MockClient((request) async {
      if (request.url.path == '/api/secrets') {
        if (request.method == 'GET') {
          calls.add('GET /api/secrets');
          // 第一次查：保险箱里没有这条 key。
          return _json(200, const []);
        }
        calls.add('POST ${request.body}');
        return _json(201, {
          'ok': true,
          'entry': {'name': 'vercel-api-key'},
        });
      }
      if (request.url.path == '/api/auto-provider/routing/test') {
        final body = jsonDecode(request.body) as Map;
        calls.add('TEST ${body['apiKeyName']}');
        return _json(200, {'ok': true, 'tier': 't1', 'latencyMs': 412});
      }
      return _json(404, {'error': 'not found'});
    });
    const providers = <Map<String, dynamic>>[
      {
        'id': 'cheap',
        'name': '便宜线',
        'protocol': 'anthropic',
        'isOfficial': false,
        'modelOptions': ['glm-4.5-flash'],
      },
      {
        'id': 'strong',
        'name': '主力线',
        'protocol': 'anthropic',
        'isOfficial': false,
        'modelOptions': ['glm-5.2'],
      },
    ];
    const pool = SessionProviderSelection(
      protocol: 'anthropic',
      candidates: [
        SessionProviderCandidate(
          providerId: 'cheap',
          model: 'glm-4.5-flash',
          priority: 1,
        ),
        SessionProviderCandidate(
          providerId: 'strong',
          model: 'glm-5.2',
          priority: 2,
        ),
      ],
      maxAttempts: 2,
    );

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (context) => ElevatedButton(
              key: const Key('open-jev-auto-config'),
              onPressed: () async {
                result = await showModalBottomSheet<AIConfigResult>(
                  context: context,
                  isScrollControlled: true,
                  builder: (_) => AIConfigSheet(
                    cli: SessionCli.claude,
                    providers: providers,
                    provider: 'cheap',
                    providerSelection: pool,
                    model: 'glm-4.5-flash',
                    effort: 'medium',
                    settings: settings,
                    httpClient: client,
                  ),
                );
              },
              child: const Text('open'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.byKey(const Key('open-jev-auto-config')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('auto-route-mode-routing')));
    await tester.pumpAndSettle();

    // 查过一次，缺 key：给出步骤和粘贴框。
    expect(calls, contains('GET /api/secrets'));
    expect(find.text('还差一步：连接 Jev'), findsOneWidget);
    expect(find.byKey(const Key('auto-jev-key-input')), findsOneWidget);

    // 粘贴 + 保存并测试：key 只进保险箱，测试走服务端。
    await tester.enterText(
      find.byKey(const Key('auto-jev-key-input')),
      'vck_test_key',
    );
    await tester.tap(find.byKey(const Key('auto-jev-key-save')));
    await tester.pumpAndSettle();

    expect(
      calls.any((call) => call.startsWith('POST ') && call.contains('vercel-api-key')),
      isTrue,
      reason: 'key 走 POST /api/secrets，条目名与 routing.apiKeyName 一致',
    );
    expect(calls, contains('TEST vercel-api-key'));
    expect(find.text('Jev 已连接'), findsOneWidget);
    expect(find.byKey(const Key('auto-jev-result')), findsOneWidget);
    expect(find.byKey(const Key('auto-jev-key-input')), findsNothing);
    expect(result, isNull, reason: '还没点保存，面板仍开着');
  });
}
