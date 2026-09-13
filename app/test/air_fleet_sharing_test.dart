import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/services/air_service.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/widgets/air/air_fleet_sharing.dart';
import 'package:multicc_app/widgets/air/air_panels.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// 一条被记下来的请求：方法 + 路径 + 请求体。
class _Call {
  _Call(this.method, this.path, this.body);

  final String method;
  final String path;
  final Map<String, dynamic> body;
}

/// 工作区分享这条路上的假服务端：分享的增/列/撤，外部舰队的导入/列/刷/删。
MockClient _client(
  List<_Call> calls, {
  List<Map<String, dynamic>>? shares,
  List<Map<String, dynamic>>? fleets,
  int createStatus = 200,
}) => MockClient((request) async {
  final path = request.url.path;
  Map<String, dynamic> body = const {};
  if (request.body.isNotEmpty) {
    body = (jsonDecode(request.body) as Map).cast<String, dynamic>();
  }
  calls.add(_Call(request.method, path, body));

  Map<String, dynamic> json = const {'ok': true};
  if (path.endsWith('/shares')) {
    json = {'ok': true, 'shares': shares ?? const []};
  } else if (path.endsWith('/share') && request.method == 'POST') {
    if (createStatus != 200) {
      return http.Response(
        jsonEncode({'ok': false, 'message': '密码至少要 6 位'}),
        createStatus,
        headers: {'content-type': 'application/json; charset=utf-8'},
      );
    }
    json = {
      'ok': true,
      'token': 'fleet_share_new',
      'url': 'https://host/fleet-share/fleet_share_new',
      'expiresAt': '2026-09-20T10:00:00.000Z',
      'maxAccesses': body['maxAccesses'] ?? 10,
      'accessCount': 0,
      'remainingAccesses': body['maxAccesses'] ?? 10,
      'expired': false,
    };
  } else if (path == '/api/external-fleets') {
    json = {'ok': true, 'fleets': fleets ?? const []};
  } else if (path == '/api/external-fleets/import') {
    json = {
      'ok': true,
      'fleet': {
        'id': 'ef1',
        'name': body['alias'] == null || '${body['alias']}'.isEmpty
            ? '远端工作区'
            : body['alias'],
        'alias': body['alias'] ?? '',
        'sourceOrigin': 'https://remote.example',
        'shareUrl': body['shareUrl'] ?? '',
        'sourceFleetId': 'f1',
        'sessionCount': 2,
        'interactive': true,
      },
    };
  }
  return http.Response(
    jsonEncode(json),
    200,
    headers: {'content-type': 'application/json; charset=utf-8'},
  );
});

Future<SettingsService> _settings() async {
  SharedPreferences.setMockInitialValues({
    'multicc_host': 'http://localhost:3000',
  });
  return SettingsService.getInstance();
}

const _directory = AirDirectory(id: 'd1', name: '前端', path: '/w/front');

void main() {
  setUpAll(() => I18n.init('zh'));

  group('分享工作区', () {
    testWidgets('密码不到 6 位就不发请求，先说要几位', (tester) async {
      final calls = <_Call>[];
      final settings = await _settings();
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Builder(
              builder: (context) => TextButton(
                onPressed: () => showFleetShareDialog(
                  context,
                  directory: _directory,
                  settings: settings,
                  service: AirService(settings: settings, httpClient: _client(calls)),
                ),
                child: const Text('开'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('开'));
      await tester.pumpAndSettle();

      await tester.enterText(find.byType(TextField).first, '12345');
      await tester.tap(find.byKey(const ValueKey('fleet-share-create')));
      await tester.pumpAndSettle();

      expect(find.text('访问密码至少 6 位。'), findsOneWidget);
      expect(
        calls.where((c) => c.method == 'POST'),
        isEmpty,
        reason: '本地就该拦下来，不该白跑一趟服务端',
      );
    });

    testWidgets('签发一次：带上三个参数，成功后把链接摆出来', (tester) async {
      final calls = <_Call>[];
      final settings = await _settings();
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Builder(
              builder: (context) => TextButton(
                onPressed: () => showFleetShareDialog(
                  context,
                  directory: _directory,
                  settings: settings,
                  service: AirService(settings: settings, httpClient: _client(calls)),
                ),
                child: const Text('开'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('开'));
      await tester.pumpAndSettle();

      final fields = find.byType(TextField);
      await tester.enterText(fields.at(0), 'hunter2secret'); // 密码
      await tester.enterText(fields.at(1), '30'); // 有效天数
      await tester.enterText(fields.at(2), '3'); // 最多导入次数
      await tester.tap(find.byKey(const ValueKey('fleet-share-create')));
      await tester.pumpAndSettle();

      final post = calls.firstWhere(
        (c) => c.method == 'POST' && c.path.endsWith('/share'),
      );
      expect(post.path, '/api/fleets/d1/share');
      expect(post.body['password'], 'hunter2secret');
      expect(post.body['expiresInDays'], 30);
      expect(post.body['maxAccesses'], 3);

      expect(find.text('分享链接已生成'), findsOneWidget);
      expect(find.text('https://host/fleet-share/fleet_share_new'), findsOneWidget);
    });

    testWidgets('打开就先问一次现有的分享，签发完再问一次', (tester) async {
      final calls = <_Call>[];
      final settings = await _settings();
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Builder(
              builder: (context) => TextButton(
                onPressed: () => showFleetShareDialog(
                  context,
                  directory: _directory,
                  settings: settings,
                  service: AirService(settings: settings, httpClient: _client(calls)),
                ),
                child: const Text('开'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('开'));
      await tester.pumpAndSettle();

      expect(
        calls.where((c) => c.path == '/api/fleets/d1/shares').length,
        1,
      );

      await tester.enterText(find.byType(TextField).first, 'hunter2secret');
      await tester.tap(find.byKey(const ValueKey('fleet-share-create')));
      await tester.pumpAndSettle();

      expect(
        calls.where((c) => c.path == '/api/fleets/d1/shares').length,
        2,
        reason: '刚签发的那条要出现在「现有分享」里',
      );
    });

    testWidgets('现有分享把「剩余几次」和截止时间念出来，撤销要过一道确认', (tester) async {
      final calls = <_Call>[];
      final settings = await _settings();
      final client = _client(
        calls,
        shares: [
          {
            'token': 'tk1',
            'url': 'https://host/fleet-share/tk1',
            'expiresAt': '2026-09-20T10:00:00.000Z',
            'maxAccesses': 10,
            'accessCount': 4,
            'remainingAccesses': 6,
            'expired': false,
          },
        ],
      );
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Builder(
              builder: (context) => TextButton(
                onPressed: () => showFleetShareDialog(
                  context,
                  directory: _directory,
                  settings: settings,
                  service: AirService(settings: settings, httpClient: client),
                ),
                child: const Text('开'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('开'));
      await tester.pumpAndSettle();

      expect(find.textContaining('剩余 6/10 次'), findsOneWidget);

      await tester.tap(find.byKey(const ValueKey('fleet-share-revoke-tk1')));
      await tester.pumpAndSettle();
      expect(find.text('撤销这个工作区分享？已发出的链接会立即失效。'), findsOneWidget);

      // 确认之前不发请求 —— 撤销是不可逆的，一下点错链接就废了。
      expect(calls.where((c) => c.method == 'DELETE'), isEmpty);

      await tester.tap(find.byKey(const ValueKey('fleet-share-revoke-confirm')));
      await tester.pumpAndSettle();

      final del = calls.firstWhere((c) => c.method == 'DELETE');
      expect(del.path, '/api/fleets/d1/share/tk1');
    });
  });

  group('导入共享工作区', () {
    testWidgets('三个字段都发出去，回来把导入到的名字交回调用方', (tester) async {
      final calls = <_Call>[];
      final settings = await _settings();
      ExternalFleet? imported;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Builder(
              builder: (context) => TextButton(
                onPressed: () async {
                  imported = await showFleetImportDialog(
                    context,
                    settings: settings,
                    service: AirService(
                      settings: settings,
                      httpClient: _client(calls),
                    ),
                  );
                },
                child: const Text('开'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('开'));
      await tester.pumpAndSettle();

      final fields = find.byType(TextField);
      await tester.enterText(fields.at(0), 'https://remote.example/fleet-share/abc');
      await tester.enterText(fields.at(1), 'pw123456');
      await tester.enterText(fields.at(2), '远程开发机');
      await tester.tap(find.byKey(const ValueKey('fleet-import-submit')));
      await tester.pumpAndSettle();

      final post = calls.firstWhere(
        (c) => c.path == '/api/external-fleets/import',
      );
      expect(post.body['shareUrl'], 'https://remote.example/fleet-share/abc');
      expect(post.body['password'], 'pw123456');
      expect(post.body['alias'], '远程开发机');
      expect(imported?.name, '远程开发机');
    });

    testWidgets('链接或密码空着就不发请求', (tester) async {
      final calls = <_Call>[];
      final settings = await _settings();
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Builder(
              builder: (context) => TextButton(
                onPressed: () => showFleetImportDialog(
                  context,
                  settings: settings,
                  service: AirService(settings: settings, httpClient: _client(calls)),
                ),
                child: const Text('开'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('开'));
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const ValueKey('fleet-import-submit')));
      await tester.pumpAndSettle();
      expect(find.text('请先粘贴分享链接。'), findsOneWidget);

      await tester.enterText(find.byType(TextField).first, 'https://x/fleet-share/a');
      await tester.tap(find.byKey(const ValueKey('fleet-import-submit')));
      await tester.pumpAndSettle();
      expect(find.text('请填写分享密码。'), findsOneWidget);

      expect(calls, isEmpty);
    });

    test('快照把远端工作区并进目录列表，源站顶替路径位', () {
      final snapshot = AirSnapshot.fromJson(
        {
          'ok': true,
          'clis': const ['claude'],
          'directories': [
            {'id': 'd1', 'name': '前端', 'path': '/w/front'},
          ],
          'tasks': const [],
        },
        externalFleets: const [
          ExternalFleet(
            id: 'ef1',
            name: '远程开发机',
            sourceOrigin: 'https://remote.example',
            shareUrl: 'https://remote.example/fleet-share/abc',
            sourceFleetId: 'f1',
            sessionCount: 2,
            interactive: false,
          ),
        ],
      );

      expect(snapshot.directories.map((d) => d.id), ['d1', 'ef1']);
      final remote = snapshot.directoryOf('ef1')!;
      expect(remote.external, isTrue);
      expect(remote.interactive, isFalse);
      // 本机没有它的目录，路径位放源站 —— 放一个假路径会读成「这是本机的」。
      expect(remote.path, 'https://remote.example');
      expect(snapshot.externalFleetOf('ef1')?.name, '远程开发机');
      expect(snapshot.externalFleetOf('d1'), isNull);
    });
  });

  group('目录卡片上的菜单', () {
    Future<void> pumpLibrary(
      WidgetTester tester,
      AirDirectory directory,
      List<AirDirectoryAction> picked,
    ) async {
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(900, 1400);
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: AirDirectoryLibrary(
              directories: [directory],
              currentDirectoryId: null,
              tasksOf: (_) => const [],
              runningDirectories: const {},
              favorites: const [],
              onOpen: (_) {},
              onAddDirectory: () {},
              onToggleFavorite: (_) {},
              onAction: (dir, action) => picked.add(action),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
    }

    testWidgets('本机目录只有「分享工作区」，不给远端那三项', (tester) async {
      final picked = <AirDirectoryAction>[];
      await pumpLibrary(tester, _directory, picked);

      // 收藏星星还在 —— 本机目录照旧能收藏。
      expect(find.byIcon(Icons.star_border_rounded), findsOneWidget);

      await tester.tap(find.byKey(const ValueKey('air-directory-menu-d1')));
      await tester.pumpAndSettle();

      expect(find.text('↗ 分享工作区'), findsOneWidget);
      expect(find.text('↻ 刷新远端状态'), findsNothing);
      expect(find.text('移除共享工作区'), findsNothing);

      await tester.tap(find.text('↗ 分享工作区'));
      await tester.pumpAndSettle();
      expect(picked, [AirDirectoryAction.share]);
    });

    testWidgets('远端工作区：授权失效时先请人重新导入，且不给收藏', (tester) async {
      final picked = <AirDirectoryAction>[];
      await pumpLibrary(
        tester,
        const AirDirectory(
          id: 'ef1',
          name: '远程开发机',
          path: 'https://remote.example',
          external: true,
          externalFleetId: 'ef1',
        ),
        picked,
      );

      expect(find.text('共享工作区 · 授权已失效'), findsOneWidget);
      expect(
        find.byIcon(Icons.star_border_rounded),
        findsNothing,
        reason: '收藏是按本机目录 id 存的，为一个远端 id 存一份没有意义',
      );

      await tester.tap(find.byKey(const ValueKey('air-directory-menu-ef1')));
      await tester.pumpAndSettle();

      expect(find.text('重新导入以启用操作'), findsOneWidget);
      expect(find.text('↻ 刷新远端状态'), findsOneWidget);
      expect(find.text('移除共享工作区'), findsOneWidget);
      expect(find.text('↗ 分享工作区'), findsNothing);
    });

    testWidgets('远端工作区授权还在时就不提「重新导入」', (tester) async {
      final picked = <AirDirectoryAction>[];
      await pumpLibrary(
        tester,
        const AirDirectory(
          id: 'ef1',
          name: '远程开发机',
          path: 'https://remote.example',
          external: true,
          externalFleetId: 'ef1',
          interactive: true,
        ),
        picked,
      );

      expect(find.text('共享工作区'), findsOneWidget);

      await tester.tap(find.byKey(const ValueKey('air-directory-menu-ef1')));
      await tester.pumpAndSettle();

      expect(find.text('重新导入以启用操作'), findsNothing);
      expect(find.text('↻ 刷新远端状态'), findsOneWidget);

      await tester.tap(find.text('↻ 刷新远端状态'));
      await tester.pumpAndSettle();
      expect(picked, [AirDirectoryAction.refresh]);
    });
  });
}
