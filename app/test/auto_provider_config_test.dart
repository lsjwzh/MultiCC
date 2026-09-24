import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/models/message.dart';
import 'package:multicc_app/services/session_service.dart';
import 'package:multicc_app/widgets/ai_config_sheet.dart';
import 'package:multicc_app/widgets/model_chip.dart';

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
}
