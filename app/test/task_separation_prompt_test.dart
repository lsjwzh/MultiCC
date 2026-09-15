import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/services/chat_service.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/widgets/task_separation_prompt.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late SettingsService settings;
  setUpAll(() async {
    await I18n.init('zh');
    SharedPreferences.setMockInitialValues({});
    settings = await SettingsService.getInstance();
    await settings.save(host: 'http://localhost:3000', token: 'test-token');
  });
  testWidgets(
    'restores pending suggestion, retains server errors, and saves keep without duplicates',
    (tester) async {
      final events = StreamController<ChatEvent>.broadcast();
      Map<String, dynamic>? suggestion = {
        'id': 'sep_1',
        'sourceTitle': '旧任务',
        'title': '新任务',
        'reason': '目标不同',
      };
      final decisions = <String>[];
      final client = MockClient((request) async {
        expect(request.headers['X-Access-Token'], 'test-token');
        expect(
          request.url.path,
          startsWith('/api/sessions/s1/task-separation'),
        );
        if (request.method == 'POST') {
          final decision = jsonDecode(request.body)['decision'] as String;
          decisions.add(decision);
          if (decision == 'separate') {
            return http.Response(
              jsonEncode({
                'ok': false,
                'code': 'fork_source_dirty',
                'message': 'Commit source changes first',
              }),
              409,
            );
          }
          suggestion = null;
          return http.Response(
            jsonEncode({'ok': true, 'decision': 'keep'}),
            200,
          );
        }
        return http.Response.bytes(
          utf8.encode(jsonEncode({'ok': true, 'suggestion': suggestion})),
          200,
          headers: {'Content-Type': 'application/json; charset=utf-8'},
        );
      });
      await tester.pumpWidget(
        MaterialApp(
          home: TaskSeparationPrompt(
            events: events.stream,
            sessionId: 's1',
            settings: settings,
            httpClient: client,
            child: const Scaffold(body: Text('Chat')),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text(t('taskSeparationTitle')), findsOneWidget);
      events.add(ChatEvent('task_state', {}));
      await tester.pumpAndSettle();
      expect(find.byType(AlertDialog), findsOneWidget);
      await tester.tap(find.text(t('taskSeparationAccept')));
      await tester.pumpAndSettle();
      expect(
        find.textContaining('Commit source changes first'),
        findsOneWidget,
      );
      expect(find.byType(AlertDialog), findsOneWidget);
      await tester.tap(find.text(t('taskSeparationKeep')));
      await tester.pumpAndSettle();
      expect(find.byType(AlertDialog), findsNothing);
      expect(decisions, ['separate', 'keep']);
      events.add(ChatEvent('task_state', {}));
      await tester.pumpAndSettle();
      expect(find.byType(AlertDialog), findsNothing);
      await tester.pumpWidget(const SizedBox());
      await events.close();
      client.close();
    },
  );
  testWidgets('classification updates remove an expired suggestion', (
    tester,
  ) async {
    final events = StreamController<ChatEvent>.broadcast();
    bool pending = true;
    final client = MockClient(
      (_) async => http.Response(
        jsonEncode({
          'ok': true,
          'suggestion': pending ? {'id': 'sep_2', 'title': 'New'} : null,
        }),
        200,
      ),
    );
    await tester.pumpWidget(
      MaterialApp(
        home: TaskSeparationPrompt(
          events: events.stream,
          sessionId: 's1',
          settings: settings,
          httpClient: client,
          child: const Scaffold(),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.byType(AlertDialog), findsOneWidget);
    pending = false;
    events.add(ChatEvent('task_state', {}));
    await tester.pumpAndSettle();
    expect(find.byType(AlertDialog), findsNothing);
    await tester.pumpWidget(const SizedBox());
    await events.close();
    client.close();
  });
}
