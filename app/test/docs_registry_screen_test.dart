import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/screens/docs_registry_screen.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/theme.dart';
import 'package:multicc_app/widgets/workspace_navigation_drawer.dart';

// 服务与文档 screen — list rendering, expired dimming, delete confirm flow,
// and the manual service-registration sheet. Every test unmounts the screen
// at the end so the 5s poll timer never survives the widget test.

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(() => I18n.init('zh'));

  final serviceRow = {
    'id': 'doc_svc',
    'kind': 'service',
    'title': 'vite dev server',
    'url': 'http://127.0.0.1:5173/',
    'sessionId': 'chat-01',
    'createdAt': '2026-09-01T08:00:00.000Z',
    'port': 5173,
    'startCmd': 'npm run dev',
    'status': 'up',
  };
  final pageRow = {
    'id': 'doc_page',
    'kind': 'page',
    'title': '预览报告',
    'url': '/artifacts/art_1/report.html',
    'sessionId': 'chat-02',
    'createdAt': '2026-08-31T08:00:00.000Z',
    'expired': true,
  };

  Future<SettingsService> mockSettings() async {
    SharedPreferences.setMockInitialValues({
      'multicc_host': 'http://server.example',
      'multicc_token': 'secret',
    });
    return SettingsService.getInstance();
  }

  Future<void> pumpScreen(
    WidgetTester tester, {
    required http.Client client,
    required SettingsService settings,
  }) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: buildAppTheme(),
        home: DocsRegistryScreen(settings: settings, httpClient: client),
      ),
    );
    await tester.pumpAndSettle();
  }

  testWidgets('renders kind, status, meta and dims expired rows', (tester) async {
    final settings = await mockSettings();
    await pumpScreen(
      tester,
      settings: settings,
      client: MockClient(
        (_) async => http.Response(
          jsonEncode([serviceRow, pageRow]),
          200,
          headers: {'content-type': 'application/json'},
        ),
      ),
    );

    expect(find.text('服务与文档'), findsOneWidget);
    expect(find.text('vite dev server'), findsOneWidget);
    expect(find.text('预览报告'), findsOneWidget);
    // service status chip (up → 运行中) and the expired tag.
    expect(find.text(t('docsregStatus_up')), findsOneWidget);
    expect(find.text(t('docsregExpired')), findsOneWidget);
    // meta line mentions the relative URL of the page entry.
    expect(find.textContaining('/artifacts/art_1/report.html'), findsOneWidget);
    // stop is offered (status up); start is not.
    expect(find.text(t('docsregStop')), findsOneWidget);
    expect(find.text(t('docsregStart')), findsNothing);
    // FAB for manual registration.
    expect(find.text(t('docsregAddService')), findsOneWidget);

    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('delete asks for confirmation then removes the row', (tester) async {
    final settings = await mockSettings();
    var deleted = false;
    final calls = <String>[];
    final client = MockClient((request) async {
      calls.add('${request.method} ${request.url.path}');
      if (request.method == 'DELETE') {
        deleted = true;
        return http.Response(jsonEncode({'ok': true}), 200);
      }
      return http.Response(
        jsonEncode(deleted ? [] : [serviceRow]),
        200,
        headers: {'content-type': 'application/json'},
      );
    });
    await pumpScreen(tester, settings: settings, client: client);

    await tester.tap(find.byTooltip(t('delete')));
    await tester.pumpAndSettle();
    expect(find.text(t('docsregConfirmDelete', {'title': 'vite dev server'})),
        findsOneWidget);

    // Cancel first — nothing is deleted.
    await tester.tap(find.widgetWithText(TextButton, t('cancel')));
    await tester.pumpAndSettle();
    expect(deleted, isFalse);
    expect(find.text('vite dev server'), findsOneWidget);

    // Confirm — DELETE hits the API and the refresh drops the row.
    await tester.tap(find.byTooltip(t('delete')));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(TextButton, t('delete')).last);
    await tester.pumpAndSettle();
    expect(deleted, isTrue);
    expect(calls, contains('DELETE /api/docs-registry/doc_svc'));
    expect(find.text('vite dev server'), findsNothing);
    // Empty state after the list drains.
    expect(find.textContaining(t('docsregEmpty')), findsOneWidget);

    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('registration sheet posts kind=service and refreshes', (tester) async {
    final settings = await mockSettings();
    http.Request? posted;
    final client = MockClient((request) async {
      if (request.method == 'POST' && request.url.path == '/api/docs-registry') {
        posted = request;
        return http.Response(jsonEncode(serviceRow), 201);
      }
      return http.Response(
        jsonEncode(posted == null ? [] : [serviceRow]),
        200,
        headers: {'content-type': 'application/json'},
      );
    });
    await pumpScreen(tester, settings: settings, client: client);

    await tester.tap(find.text(t('docsregAddService')));
    await tester.pumpAndSettle();

    final fields = find.byType(TextField);
    await tester.enterText(fields.at(0), 'vite dev server');
    await tester.enterText(fields.at(1), 'http://127.0.0.1:5173/');
    await tester.enterText(fields.at(2), 'npm run dev');
    await tester.pump();

    await tester.tap(find.widgetWithText(ElevatedButton, t('add')));
    await tester.pumpAndSettle();

    expect(posted, isNotNull);
    final body = jsonDecode(posted!.body) as Map<String, dynamic>;
    expect(body['kind'], 'service');
    expect(body['source'], 'user');
    expect(body['startCmd'], 'npm run dev');
    expect(body.containsKey('cwd'), isFalse);
    // The refresh after saving shows the new row.
    expect(find.text('vite dev server'), findsOneWidget);

    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('first-load failure shows the retry view', (tester) async {
    final settings = await mockSettings();
    await pumpScreen(
      tester,
      settings: settings,
      client: MockClient(
        (_) async => http.Response(
          jsonEncode({'error': 'boom'}),
          500,
          headers: {'content-type': 'application/json'},
        ),
      ),
    );

    expect(find.textContaining('boom'), findsOneWidget);
    expect(find.text(t('retry')), findsOneWidget);

    await tester.pumpWidget(const SizedBox.shrink());
  });

  test('drawer exposes the docs destination in the workspace group', () {
    // Compile-level guarantee that the nav entry is wired into the same group
    // the /manage sidebar uses (workspace, after memory).
    expect(WorkspaceNavigationDrawer.workspaceDestinations,
        contains(WorkspaceDestination.docs));
    expect(
      WorkspaceNavigationDrawer.workspaceDestinations
          .indexOf(WorkspaceDestination.docs),
      WorkspaceNavigationDrawer.workspaceDestinations
          .indexOf(WorkspaceDestination.memory) + 1,
    );
    expect(WorkspaceDestination.docs.labelKey, 'docsServices');
  });
}
