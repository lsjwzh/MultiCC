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
import 'package:multicc_app/services/air_service.dart';
import 'package:multicc_app/services/auto_commit.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/widgets/chat_header.dart';

Session _session(String id, {required bool autoCommit}) => Session(
  id: id,
  kind: SessionKind.chat,
  createdAt: DateTime(2026),
  autoCommit: autoCommit,
);

/// 只记值、不发请求的 SessionManager：opening a task chat must not start a
/// full dashboard fetch in the middle of this test.
class _Manager extends SessionManager {
  _Manager({required super.settings});

  @override
  Future<void> loadDashboard() async {}
}

Future<SettingsService> _settings() async {
  SharedPreferences.setMockInitialValues({
    'multicc_host': 'http://127.0.0.1:1',
    'multicc_token': '',
  });
  return SettingsService.getInstance();
}

Widget _host(
  SessionManager manager,
  ChatProvider provider,
  SettingsService settings,
) => MultiProvider(
  providers: [
    ChangeNotifierProvider<SessionManager>.value(value: manager),
    ChangeNotifierProvider<ChatProvider>.value(value: provider),
  ],
  child: MaterialApp(
    home: Scaffold(
      body: Align(
        alignment: Alignment.topCenter,
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
            autoCommit: manager.autoCommitFor(provider.sessionName),
            onAutoCommit: () {},
            onDebug: () {},
            onArtifacts: () {},
          ),
        ),
      ),
    ),
  ),
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(() => I18n.init('zh'));

  // The App header used to read the switch from the fleet list only. Task-bound
  // sessions (`task-*`) are deliberately absent from `/api/sessions`, so the
  // lookup always missed and fell back to the "on" default — the menu showed
  // 「自动提交✓」 forever even though the server had `autoCommit: false`.
  test('fleet session keeps its own value', () {
    final sessions = [_session('plain', autoCommit: false)];
    expect(sessionAutoCommitOf(sessions, 'plain'), false);
  });

  test('hidden task-bound session resolves from the cached value', () {
    final sessions = [_session('plain', autoCommit: true)];
    expect(
      sessionAutoCommitOf(
        sessions,
        'task-88a969353c0b716636b714b302483a39',
        cached: {'task-88a969353c0b716636b714b302483a39': false},
      ),
      false,
    );
  });

  test('unknown session still defaults to on, like the server', () {
    expect(sessionAutoCommitOf(const [], 'missing'), true);
  });

  test('fleet row wins over a stale cache entry', () {
    final sessions = [_session('plain', autoCommit: true)];
    expect(
      sessionAutoCommitOf(sessions, 'plain', cached: {'plain': false}),
      true,
    );
  });

  // End-to-end through the real path: `/api/air/tasks/:id/open` carries the
  // switch for the hidden session, opening it caches that value, and the ⋯ menu
  // renders the truth instead of the stuck 「自动提交✓」.
  testWidgets('opening a task chat caches its autoCommit and the ⋯ menu shows it',
      (tester) async {
    final settings = await _settings();
    final client = MockClient((request) async {
      expect(request.url.path, '/api/air/tasks/stock/open');
      return http.Response(
        '{"ok":true,"session":{"id":"task-stock","kind":"chat",'
        '"label":"库存同步","autoCommit":false,"taskBoundTaskId":"stock"}}',
        200,
        headers: {'content-type': 'application/json; charset=utf-8'},
      );
    });
    addTearDown(client.close);
    final service = AirService(settings: settings, httpClient: client);
    final session = await service.openTaskSession('stock');
    expect(session.autoCommit, false);

    final manager = _Manager(settings: settings);
    final provider = manager.openSession(session);
    // Not in the fleet list at all — the old lookup defaulted to true here.
    expect(manager.sessions.any((s) => s.id == session.id), false);
    expect(manager.autoCommitFor(session.id), false);

    await tester.pumpWidget(_host(manager, provider, settings));
    await tester.tap(find.byTooltip(t('moreActions')));
    await tester.pumpAndSettle();
    expect(find.text(t('autoCommitOff')), findsOneWidget);
    expect(find.text(t('autoCommitOn')), findsNothing);

    manager.dispose();
  });
}
