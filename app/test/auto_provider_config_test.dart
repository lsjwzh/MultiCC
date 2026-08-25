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
    await tester.tap(find.text('⚡ Auto · Anthropic · 自管').last);
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
}
