import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:multicc_app/models/message.dart';
import 'package:multicc_app/services/manage_service.dart';
import 'package:multicc_app/services/opencode_models_service.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/widgets/run_config/run_config_sheet.dart';
import 'package:multicc_app/widgets/run_config/run_config_wire.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test(
    'provider request uses the same CLI compatibility filter as Web',
    () async {
      SharedPreferences.setMockInitialValues({
        'multicc_host': 'http://server.example',
        'multicc_token': 'token',
      });
      final settings = await SettingsService.getInstance();
      late http.Request captured;
      final service = ManageService(
        settings: settings,
        httpClient: MockClient((request) async {
          captured = request;
          return http.Response(
            jsonEncode({'providers': [], 'defaults': {}}),
            200,
            headers: {'content-type': 'application/json'},
          );
        }),
      );

      await service.fetchProvidersForCli('opencode');

      expect(captured.url.path, '/api/providers');
      expect(captured.url.queryParameters, {'cli': 'opencode'});
    },
  );

  testWidgets(
    'picker includes both managed pools and OpenCode-native providers',
    (tester) async {
      final providers = mergeOpenCodeNativeProviders(
        const [
          {
            'id': 'claude-relay',
            'name': 'Anthropic Relay',
            'appType': 'claude',
            'modelOptions': ['claude-sonnet'],
          },
          {
            'id': 'codex-relay',
            'name': 'OpenAI Relay',
            'appType': 'codex',
            'modelOptions': ['gpt-5'],
          },
        ],
        const [
          OpenCodeModel(
            provider: 'opencode',
            model: 'big-pickle',
            label: 'opencode/big-pickle (OpenCode Zen)',
          ),
          OpenCodeModel(
            provider: 'opencodego',
            model: 'kimi-k2.5',
            label: 'opencodego/kimi-k2.5',
          ),
        ],
      );
      RunConfigOutcome? result;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Builder(
              builder: (context) => ElevatedButton(
                key: const Key('open'),
                onPressed: () async {
                  result = await showModalBottomSheet<RunConfigOutcome>(
                    context: context,
                    isScrollControlled: true,
                    builder: (_) => RunConfigSheet(
                      cli: SessionCli.opencode,
                      providers: providers,
                      provider: '',
                      model: 'opencode/big-pickle',
                      effort: '',
                    ),
                  );
                },
                child: const Text('open'),
              ),
            ),
          ),
        ),
      );

      await tester.tap(find.byKey(const Key('open')));
      await tester.pumpAndSettle();
      expect(find.textContaining('OpenCode Zen'), findsOneWidget);

      final linePicker = find.byType(DropdownButtonFormField<String>).first;
      await tester.ensureVisible(linePicker);
      await tester.pumpAndSettle();
      await tester.tap(linePicker);
      await tester.pumpAndSettle();
      expect(find.textContaining('Anthropic Relay'), findsWidgets);
      expect(find.textContaining('OpenAI Relay'), findsWidgets);
      expect(find.textContaining('OpenCode Go'), findsWidgets);
      await tester.tap(find.textContaining('OpenCode Zen').last);
      await tester.pumpAndSettle();

      final save = find.widgetWithText(ElevatedButton, '保存');
      await tester.ensureVisible(save);
      await tester.tap(save);
      await tester.pumpAndSettle();

      expect(result, isNotNull);
      expect(result!.provider, isEmpty);
      expect(result!.model, 'opencode/big-pickle');
      expect(result!.providerLabel, 'OpenCode Zen');
    },
  );
}
