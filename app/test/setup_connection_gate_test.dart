import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/screens/setup_screen.dart';
import 'package:multicc_app/services/connection_probe_service.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(() => I18n.init('zh'));

  testWidgets('failed authentication stays on setup and persists nothing', (
    tester,
  ) async {
    SharedPreferences.setMockInitialValues(const {});
    final settings = await SettingsService.getInstance();
    final probe = ConnectionProbeService(
      client: MockClient(
        (_) async => http.Response(
          jsonEncode({'error': 'Forbidden'}),
          403,
          headers: {'content-type': 'application/json'},
        ),
      ),
    );

    await tester.pumpWidget(
      MaterialApp(
        home: SetupScreen(settings: settings, probeService: probe),
      ),
    );
    final fields = find.byType(TextField);
    expect(fields, findsNWidgets(2));
    await tester.enterText(fields.first, 'http://192.168.1.8:3000');
    await tester.enterText(fields.last, 'wrong');
    await tester.tap(find.text('验证并连接'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));

    expect(find.byKey(const ValueKey('connection-error')), findsOneWidget);
    expect(find.textContaining('访问密码不正确'), findsOneWidget);
    expect(settings.host, isEmpty);
    expect(settings.serverHistory, isEmpty);
    expect(find.byType(SetupScreen), findsOneWidget);
    await tester.pumpWidget(const SizedBox.shrink());
  });
}
