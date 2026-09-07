import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/models/message.dart';
import 'package:multicc_app/providers/session_manager.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/widgets/ai_config_sheet.dart';

class HiddenExecutionManager extends SessionManager {
  HiddenExecutionManager(SettingsService settings) : super(settings: settings);
  String? requested;
  @override
  Future<void> loadDashboard() async {}
  @override
  Future<SessionCliConfig> fetchSessionCliConfig(String id) async {
    requested = id;
    return SessionCliConfig(cli: SessionCli.zcode, model: 'fixture-model');
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(() => I18n.init('zh'));
  testWidgets('hidden task execution can open AI config without a Fleet record', (tester) async {
    SharedPreferences.setMockInitialValues({'multicc_host': 'http://127.0.0.1:1'});
    final settings = await SettingsService.getInstance();
    final manager = HiddenExecutionManager(settings);
    try {
      await tester.pumpWidget(ChangeNotifierProvider<SessionManager>.value(
        value: manager,
        child: MaterialApp(home: Scaffold(body: Builder(builder: (context) => TextButton(
          onPressed: () => openAIConfigSheet(context, settings: settings, sessionId: 'task-hidden'),
          child: const Text('configure'),
        )))),
      ));
      expect(manager.sessions, isEmpty);
      await tester.tap(find.text('configure'));
      await tester.pumpAndSettle();
      expect(manager.requested, 'task-hidden');
      expect(find.byType(AIConfigSheet), findsOneWidget);
      expect(find.text(I18n.of('sessionNotLoaded')), findsNothing);
    } finally {
      await tester.pumpWidget(const SizedBox.shrink());
      manager.dispose();
    }
  });
}
