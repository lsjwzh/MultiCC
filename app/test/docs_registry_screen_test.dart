import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/screens/directory_artifacts_screen.dart';
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

  // ── 排列方式（按时间 / 按目录）────────────────────────────────────────────

  testWidgets('scope switch groups rows by directory, orphan group last', (
    tester,
  ) async {
    final settings = await mockSettings();
    final alpha = {
      'id': 'doc_alpha',
      'kind': 'page',
      'title': 'Alpha 报告',
      'url': '/artifacts/a/a.html',
      'dir': '/Users/me/alpha',
      'createdAt': '2026-09-02T08:00:00.000Z',
    };
    final beta = {
      'id': 'doc_beta',
      'kind': 'file',
      'title': 'Beta 数据',
      'url': '/artifacts/b/b.csv',
      'dir': '/Users/me/beta',
      'createdAt': '2026-09-01T08:00:00.000Z',
    };
    final orphan = {
      'id': 'doc_orphan',
      'kind': 'page',
      'title': '无目录报告',
      'url': '/artifacts/c/c.html',
      'createdAt': '2026-08-31T08:00:00.000Z',
    };
    await pumpScreen(
      tester,
      settings: settings,
      client: MockClient(
        (_) async => http.Response(
          jsonEncode([alpha, beta, orphan]),
          200,
          headers: {'content-type': 'application/json'},
        ),
      ),
    );

    // 默认按时间：与改动前一样是平铺列表，没有组头。
    expect(find.text(t('docsScopeTime')), findsOneWidget);
    expect(find.text(t('docsScopeDir')), findsOneWidget);
    expect(find.text('alpha'), findsNothing);
    expect(find.text('/Users/me/alpha'), findsNothing);
    expect(find.text('Alpha 报告'), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('docs-scope-dir')));
    await tester.pumpAndSettle();

    // 组头：目录名 + 绝对路径副行；dir 为空的一组用「未归属目录」。
    expect(find.text('alpha'), findsOneWidget);
    expect(find.text('/Users/me/alpha'), findsOneWidget);
    expect(find.text('beta'), findsOneWidget);
    expect(find.text(t('docsNoDir')), findsOneWidget);
    // 组序 = 服务端响应里首次出现的顺序，dir 为空的一组垫底。
    final yAlpha = tester.getTopLeft(find.text('alpha')).dy;
    final yBeta = tester.getTopLeft(find.text('beta')).dy;
    final yOrphan = tester.getTopLeft(find.text(t('docsNoDir'))).dy;
    expect(yAlpha, lessThan(yBeta));
    expect(yBeta, lessThan(yOrphan));
    // 三个条目都还在（分组不是过滤）。
    expect(find.text('Alpha 报告'), findsOneWidget);
    expect(find.text('Beta 数据'), findsOneWidget);
    expect(find.text('无目录报告'), findsOneWidget);

    // 切回按时间：组头消失。
    await tester.tap(find.byKey(const ValueKey('docs-scope-time')));
    await tester.pumpAndSettle();
    expect(find.text('alpha'), findsNothing);

    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('scope choice is persisted locally', (tester) async {
    final settings = await mockSettings();
    await pumpScreen(
      tester,
      settings: settings,
      client: MockClient(
        (_) async => http.Response(
          jsonEncode([]),
          200,
          headers: {'content-type': 'application/json'},
        ),
      ),
    );

    await tester.tap(find.byKey(const ValueKey('docs-scope-dir')));
    await tester.pumpAndSettle();

    final prefs = await SharedPreferences.getInstance();
    expect(prefs.getString('multicc_docs_scope'), 'dir');

    await tester.pumpWidget(const SizedBox.shrink());
  });

  // ── 永久保留（与置顶独立的第二个开关）──────────────────────────────────────

  testWidgets('permanent toggle PATCHes on its own and marks the row', (
    tester,
  ) async {
    final settings = await mockSettings();
    var permanent = false;
    final patches = <Map<String, dynamic>>[];
    Map<String, dynamic> row() => {
      'id': 'doc_perm',
      'kind': 'page',
      'title': '报告',
      'url': '/artifacts/x/r.html',
      'createdAt': '2026-08-31T08:00:00.000Z',
      // 置顶本来就开着：两个开关必须互不影响。
      'pinned': true,
      'permanent': permanent,
    };
    final client = MockClient((request) async {
      if (request.method == 'PATCH') {
        final body = jsonDecode(request.body) as Map<String, dynamic>;
        patches.add(body);
        if (body.containsKey('permanent')) {
          permanent = body['permanent'] == true;
        }
        // content-type 必须给：没有 charset 时 http 按 latin1 编码响应体，
        // 中文标题会直接抛「Contains invalid characters」。
        return http.Response(
          jsonEncode(row()),
          200,
          headers: {'content-type': 'application/json'},
        );
      }
      return http.Response(
        jsonEncode([row()]),
        200,
        headers: {'content-type': 'application/json'},
      );
    });
    await pumpScreen(tester, settings: settings, client: client);

    // 初始：置顶开着、永久保留关着。
    expect(find.byTooltip(t('docsregUnpin')), findsOneWidget);
    expect(find.byTooltip(t('artifactKeepForever')), findsOneWidget);
    expect(find.text('🔒'), findsNothing);

    await tester.tap(find.byKey(const ValueKey('docsreg-permanent-doc_perm')));
    await tester.pumpAndSettle();

    // 只发了 permanent —— pinned 由服务端保留，不被这条 PATCH 覆盖。
    expect(patches, [
      {'permanent': true},
    ]);
    expect(find.text(t('docsregPermanentOn')), findsOneWidget);
    expect(find.text('🔒'), findsOneWidget);
    expect(find.byTooltip(t('artifactKeepForeverOff')), findsOneWidget);
    // 置顶依旧开着。
    expect(find.byTooltip(t('docsregUnpin')), findsOneWidget);

    // 让第一条 SnackBar 自己收掉（4s）—— 否则第二条只会排队，不在屏幕上。
    await tester.pump(const Duration(seconds: 5));
    await tester.pumpAndSettle();

    // 再点一次取消（回执文案换成「已取消永久保留」）。
    await tester.tap(find.byKey(const ValueKey('docsreg-permanent-doc_perm')));
    await tester.pumpAndSettle();
    expect(patches.last, {'permanent': false});
    expect(find.text(t('docsregPermanentOff')), findsOneWidget);
    expect(find.text('🔒'), findsNothing);

    await tester.pumpWidget(const SizedBox.shrink());
  });

  // ── 本目录产物（目录卡上那颗按钮打开的页面）────────────────────────────────

  group('DirectoryArtifactsScreen', () {
    Future<void> pumpArtifacts(
      WidgetTester tester, {
      required http.Client client,
      required SettingsService settings,
    }) async {
      await tester.pumpWidget(
        MaterialApp(
          theme: buildAppTheme(),
          home: DirectoryArtifactsScreen(
            dirId: 'dir-1',
            dirName: 'Fleet One',
            dirPath: '/Users/me/fleet',
            settings: settings,
            httpClient: client,
          ),
        ),
      );
      await tester.pumpAndSettle();
    }

    Map<String, dynamic> artifact({
      required String id,
      required String title,
      bool pinned = false,
      bool permanent = false,
    }) => {
      'id': id,
      'kind': 'page',
      'title': title,
      'url': '/artifacts/$id/index.html',
      'createdAt': '2026-09-01T08:00:00.000Z',
      'pinned': pinned,
      'permanent': permanent,
      'dir': '/Users/me/fleet',
    };

    testWidgets('scopes by ?dir=, hides services, toggles both flags', (
      tester,
    ) async {
      final settings = await mockSettings();
      final gets = <Uri>[];
      final patches = <Map<String, dynamic>>[];
      var permanent = false;
      var pinned = false;
      final client = MockClient((request) async {
        if (request.method == 'PATCH') {
          final body = jsonDecode(request.body) as Map<String, dynamic>;
          patches.add(body);
          if (body.containsKey('permanent')) permanent = body['permanent'] == true;
          if (body.containsKey('pinned')) pinned = body['pinned'] == true;
          return http.Response(
            jsonEncode(
              artifact(id: 'art', title: '报告', pinned: pinned, permanent: permanent),
            ),
            200,
            headers: {'content-type': 'application/json'},
          );
        }
        gets.add(request.url);
        return http.Response(
          jsonEncode([
            artifact(id: 'art', title: '报告', pinned: pinned, permanent: permanent),
            serviceRow,
          ]),
          200,
          headers: {'content-type': 'application/json'},
        );
      });
      await pumpArtifacts(tester, client: client, settings: settings);

      // 只问这一个目录。
      expect(gets.single.queryParameters, {'dir': '/Users/me/fleet'});
      // 标题 + 目录名 + 副标题。
      expect(find.text(t('airDirArtifacts')), findsOneWidget);
      expect(find.text('Fleet One'), findsOneWidget);
      expect(find.text(t('airDirArtifactsHint')), findsOneWidget);
      // 产物在，服务不在（服务留在「服务与文档」页）。
      expect(find.text('报告'), findsOneWidget);
      expect(find.text('vite dev server'), findsNothing);
      expect(find.text('🔒'), findsNothing);

      await tester.tap(find.byKey(const ValueKey('dir-artifact-permanent-art')));
      await tester.pumpAndSettle();
      expect(patches, [
        {'permanent': true},
      ]);
      expect(find.text(t('docsregPermanentOn')), findsOneWidget);
      expect(find.text('🔒'), findsOneWidget);

      await tester.tap(find.byKey(const ValueKey('dir-artifact-pin-art')));
      await tester.pumpAndSettle();
      expect(patches.last, {'pinned': true});
      // 置顶不影响永久保留。
      expect(find.text('🔒'), findsOneWidget);
      expect(find.byTooltip(t('docsregUnpin')), findsOneWidget);

      // 页尾那条去「服务与文档」的入口。
      expect(find.text(t('docsServices')), findsOneWidget);

      await tester.pumpWidget(const SizedBox.shrink());
    });

    testWidgets('empty list shows the empty state', (tester) async {
      final settings = await mockSettings();
      await pumpArtifacts(
        tester,
        settings: settings,
        client: MockClient(
          (_) async => http.Response(
            jsonEncode([serviceRow]),
            200,
            headers: {'content-type': 'application/json'},
          ),
        ),
      );

      expect(find.text(t('airDirArtifactsEmpty')), findsOneWidget);
      expect(find.text('vite dev server'), findsNothing);

      await tester.pumpWidget(const SizedBox.shrink());
    });

    testWidgets('a failed refresh keeps the last good list and warns', (
      tester,
    ) async {
      final settings = await mockSettings();
      var fail = false;
      await pumpArtifacts(
        tester,
        settings: settings,
        client: MockClient((_) async {
          if (fail) {
            return http.Response(
              jsonEncode({'error': 'boom'}),
              500,
              headers: {'content-type': 'application/json'},
            );
          }
          return http.Response(
            jsonEncode([artifact(id: 'art', title: '报告')]),
            200,
            headers: {'content-type': 'application/json'},
          );
        }),
      );
      expect(find.text('报告'), findsOneWidget);

      fail = true;
      await tester.tap(find.byTooltip(t('refresh')));
      await tester.pumpAndSettle();

      // 列表还在（上一份好数据），顶上多一行错误。
      expect(find.text('报告'), findsOneWidget);
      expect(find.textContaining('boom'), findsOneWidget);

      await tester.pumpWidget(const SizedBox.shrink());
    });
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

  group('rewriteLoopbackUrl', () {
    // Mirror cases with the web panel's rewriteLoopbackUrl
    // (tests/test-docs-registry.js) — both ends must stay in lockstep.
    test('swaps loopback host, keeps port/path/query/protocol', () {
      expect(rewriteLoopbackUrl('http://127.0.0.1:8770/', '192.168.1.5'),
          'http://192.168.1.5:8770/');
      expect(rewriteLoopbackUrl('http://127.0.0.1:8770/x?a=1', '192.168.1.5'),
          'http://192.168.1.5:8770/x?a=1');
      expect(
          rewriteLoopbackUrl('https://localhost:5173/',
              'macbook.tail94695a.ts.net'),
          'https://macbook.tail94695a.ts.net:5173/');
      expect(rewriteLoopbackUrl('http://LOCALHOST:8770/', '192.168.1.5'),
          'http://192.168.1.5:8770/');
      expect(rewriteLoopbackUrl('http://[::1]:8770/', '192.168.1.5'),
          'http://192.168.1.5:8770/');
    });

    test('leaves non-loopback, relative and local-view URLs untouched', () {
      expect(rewriteLoopbackUrl('http://example.com:8080/', '192.168.1.5'),
          'http://example.com:8080/');
      expect(rewriteLoopbackUrl('https://192.168.1.9:443/', '192.168.1.5'),
          'https://192.168.1.9:443/');
      expect(rewriteLoopbackUrl('/artifacts/abc/report.html', '192.168.1.5'),
          '/artifacts/abc/report.html');
      expect(rewriteLoopbackUrl('ftp://127.0.0.1:21/', '192.168.1.5'),
          'ftp://127.0.0.1:21/', reason: 'non-http scheme untouched');
      // Local (loopback) browsing keeps the URL exactly as recorded.
      expect(rewriteLoopbackUrl('http://127.0.0.1:8770/', 'localhost'),
          'http://127.0.0.1:8770/');
      expect(rewriteLoopbackUrl('http://127.0.0.1:8770/', '127.0.0.1'),
          'http://127.0.0.1:8770/');
      expect(rewriteLoopbackUrl('http://127.0.0.1:8770/', '[::1]'),
          'http://127.0.0.1:8770/');
      // Degenerate inputs pass through untouched.
      expect(rewriteLoopbackUrl('', '192.168.1.5'), '');
      expect(rewriteLoopbackUrl('http://127.0.0.1:8770/', ''),
          'http://127.0.0.1:8770/');
      expect(rewriteLoopbackUrl('not a url', '192.168.1.5'), 'not a url');
    });

    test('isLoopbackHost recognizes the loopback family only', () {
      for (final h in ['localhost', '127.0.0.1', '::1', '[::1]', 'LOCALHOST']) {
        expect(isLoopbackHost(h), isTrue, reason: h);
      }
      for (final h
          in ['192.168.1.5', 'example.com', '[fd00::5]', '127.0.0.2']) {
        expect(isLoopbackHost(h), isFalse, reason: h);
      }
    });
  });
}
