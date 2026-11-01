import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/models/docs_registry_entry.dart';
import 'package:multicc_app/screens/docs_registry_screen.dart';
import 'package:multicc_app/services/air_service.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/services/ws_ticket_service.dart';
import 'package:multicc_app/widgets/air/air_computers.dart';
import 'package:multicc_app/widgets/air/air_ops.dart';
import 'package:multicc_app/widgets/air/air_ops_store.dart';
import 'package:multicc_app/widgets/chat_handoff.dart';
import 'package:multicc_app/widgets/message_bubble.dart';
import 'package:multicc_app/models/message.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(() => I18n.init('zh'));
  Future<SettingsService> entry() async {
    final settings = await SettingsService.getInstance();
    await settings.save(
      host: 'https://entry.example',
      token: 'fixture-token',
      session: 'entry-session',
      cwd: '/entry',
    );
    return settings;
  }

  setUpAll(() => SharedPreferences.setMockInitialValues({}));

  test(
    'computer scope locks the target and isolates equal task ids and directory history',
    () async {
      final local = await entry();
      final a = local.forMachine(
        'machine_a',
        '电脑甲',
        origin: 'https://remote.example',
      );
      final b = local.forMachine('machine_b', '电脑乙');
      expect(
        a.buildHttpUrl('/api/providers'),
        'https://entry.example/api/machines/machine_a/proxy/api/providers',
      );
      await a.save(session: 'same-session', cwd: '/remote');
      await a.saveChatRuntimeCache('same-task', {'balance': 5});
      expect(local.session, 'entry-session');
      expect(local.cwd, '/entry');
      expect(b.session, '');
      expect(b.readChatRuntimeCache('same-task'), isNull);
      expect(a.readChatRuntimeCache('same-task'), {'balance': 5});
      expect(() => a.save(host: 'https://wrong.example'), throwsStateError);
      final aStore = await AirLocalStore.load(scope: a.storageScope);
      final bStore = await AirLocalStore.load(scope: b.storageScope);
      await aStore.rememberTask('same-task');
      expect(bStore.recentTasks, isEmpty);
      expect(a.targetSaveLabel('保存'), '保存到 电脑甲');
      final file = a.machineFileUrl('/tmp/same.txt', inline: true);
      expect(file.path, '/air');
      expect(file.queryParameters['machine'], 'machine_a');
      expect(file.queryParameters['machineDownload'], '/tmp/same.txt');
      expect(
        a.machineResourceUrl('/artifacts/example/report.html')?.toString(),
        'https://remote.example/artifacts/example/report.html',
      );
    },
  );

  test(
    'computer WebSocket tickets preserve the target and reject a different computer',
    () async {
      final settings = (await entry()).forMachine('machine_a', '电脑甲');
      bool wrong = false;
      final client = WsTicketClient(
        post: (endpoint, {required headers, required body}) async {
          expect(endpoint.path, '/api/machines/machine_a/ws-ticket');
          expect(jsonDecode(body)['path'], '/ws/chat?session=same-id');
          return http.Response(
            jsonEncode({
              'ticket': 'fixture-ticket',
              'path': '/ws/chat',
              'proxyPath': '/ws/machines/${wrong ? 'machine_b' : 'machine_a'}',
            }),
            200,
          );
        },
      );
      Future<Uri> authorize() => client.authorize(
        socketUri: Uri.parse('wss://entry.example/ws/chat?session=same-id'),
        ticketEndpoint: Uri.parse(settings.buildHttpUrl('/api/auth/ws-ticket')),
        accessToken: settings.token,
      );
      final socket = await authorize();
      expect(socket.path, '/ws/machines/machine_a');
      expect(socket.queryParameters, {'ticket': 'fixture-ticket'});
      wrong = true;
      await expectLater(authorize(), throwsA(isA<WsTicketException>()));
    },
  );

  testWidgets(
    'console computer tab opens target settings and returns to the same computer',
    (tester) async {
      final settings = await entry();
      final requests = <String>[];
      final client = MockClient((request) async {
        requests.add(request.url.path);
        final data = request.url.path == '/api/machines'
            ? {
                'self': {'id': 'machine_entry', 'name': '入口电脑', 'local': true},
                'machines': [
                  {
                    'id': 'machine_a',
                    'name': '工作电脑',
                    'local': false,
                    'origin': 'https://remote.example',
                  },
                ],
              }
            : request.url.path.endsWith('/api/air')
            ? {
                'ok': true,
                'directories': [
                  {
                    'id': 'same-dir',
                    'name': request.url.path.contains('/proxy/')
                        ? '远程目录'
                        : '入口目录',
                    'path': '/projects',
                  },
                ],
                'tasks': [],
                'sessions': [],
              }
            : <String, dynamic>{};
        return http.Response(
          jsonEncode(data),
          200,
          headers: {'content-type': 'application/json; charset=utf-8'},
        );
      });
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: AirComputerConsole(
              settings: settings,
              httpClient: client,
              onDirectory: (_) {},
              onSettings: () {},
              child: const Text('本机任务'),
            ),
          ),
        ),
      );
      await tester.tap(find.byKey(const ValueKey('air-console-tab-2')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('工作电脑'));
      await tester.pumpAndSettle();
      expect(find.text('远程目录'), findsOneWidget);
      expect(requests, contains('/api/machines/machine_a/proxy/api/air'));
      await tester.tap(find.text('电脑设置'));
      await tester.pumpAndSettle();
      expect(find.text('当前操作与保存目标：工作电脑'), findsOneWidget);
      await tester.tap(find.text('数据与安全'));
      await tester.pumpAndSettle();
      expect(find.text('保险箱'), findsOneWidget);
      await tester.pageBack();
      await tester.pumpAndSettle();
      expect(find.text('配置保存在 工作电脑'), findsOneWidget);
      // The outer back button closes the computer settings route.
      await tester.tap(find.byTooltip('返回多电脑'));
      await tester.pumpAndSettle();
      expect(find.text('当前操作电脑：工作电脑'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
      client.close();
    },
  );

  testWidgets(
    'remote chat images and handoff use the target instead of the global connection',
    (tester) async {
      final local = await entry();
      final remote = local.forMachine('machine_a', '工作电脑');
      final requests = <Uri>[];
      final client = MockClient((request) async {
        requests.add(request.url);
        return http.Response(
          '{"error":"fixture rejection"}',
          403,
          headers: {'content-type': 'application/json; charset=utf-8'},
        );
      });
      await tester.pumpWidget(
        MaterialApp(
          home: ComputerTargetShell(
            name: '工作电脑',
            settings: remote,
            child: Scaffold(
              body: Column(
                children: [
                  MessageBubble(
                    message: ChatMessage(
                      role: MessageRole.assistant,
                      content: '![截图](/tmp/same.png)',
                    ),
                  ),
                  Builder(
                    builder: (context) => TextButton(
                      onPressed: () => showHandoffExportDialog(
                        context,
                        sessionId: 'same-session',
                        httpClient: client,
                      ),
                      child: const Text('导出测试'),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      );
      final image = tester.widget<Image>(find.byType(Image).first);
      final network = image.image as NetworkImage;
      expect(
        Uri.parse(network.url).path,
        '/api/machines/machine_a/proxy/api/download',
      );
      expect(Uri.parse(network.url).queryParameters['path'], '/tmp/same.png');
      await tester.tap(find.text('导出测试'));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const ValueKey('handoff-export-pass')),
        'fixture-passphrase',
      );
      await tester.ensureVisible(
        find.byKey(const ValueKey('handoff-export-submit')),
      );
      await tester.tap(find.byKey(const ValueKey('handoff-export-submit')));
      await tester.pumpAndSettle();
      expect(
        requests.single.path,
        '/api/machines/machine_a/proxy/api/sessions/same-session/bundle.zip',
      );
      expect(local.session, 'entry-session');
      await tester.pumpWidget(const SizedBox());
      client.close();
    },
  );

  test(
    'page urls keep single-server behaviour and scope every machine link',
    () async {
      final local = await entry();
      for (final path in [
        '/api/providers',
        '/artifacts/example/report.html',
        '/chat.html?air=1&task=tsk_1',
        '/air?view=bridges',
        '/docs/guide',
      ]) {
        expect(local.machinePageUrl(path), local.buildHttpUrl(path));
      }

      final a = local.forMachine(
        'machine_a',
        '电脑甲',
        origin: 'https://remote.example',
      );
      expect(
        a.machinePageUrl('/api/providers'),
        'https://entry.example/api/machines/machine_a/proxy/api/providers',
      );
      expect(
        a.machinePageUrl('/artifacts/example/report.html'),
        'https://remote.example/artifacts/example/report.html',
      );
      final chat = Uri.parse(a.machinePageUrl('/chat.html?air=1&task=tsk_1')!);
      expect(chat.origin, 'https://entry.example');
      expect(chat.path, '/chat.html');
      expect(chat.queryParameters, {
        'air': '1',
        'task': 'tsk_1',
        'machine': 'machine_a',
        'machineName': '电脑甲',
        'machineOrigin': 'https://remote.example',
        'token': 'fixture-token',
      });
      final bridges = Uri.parse(a.machinePageUrl('/air?view=bridges')!);
      expect(bridges.path, '/air');
      expect(bridges.queryParameters['view'], 'bridges');
      expect(bridges.queryParameters['machine'], 'machine_a');
      expect(bridges.queryParameters['machineName'], '电脑甲');
      expect(bridges.queryParameters['machineOrigin'], 'https://remote.example');

      final b = local.forMachine('machine_b', '电脑乙');
      expect(b.machinePageUrl('/artifacts/example/report.html'), isNull);
      final page = Uri.parse(b.machinePageUrl('/chat.html?task=t1')!);
      expect(page.queryParameters['machine'], 'machine_b');
      expect(page.queryParameters.containsKey('machineOrigin'), isFalse);
    },
  );

  test('machine scope follows the entry connection after a reconnect', () async {
    final local = await entry();
    final machine = local.forMachine('machine_a', '电脑甲');
    await local.save(
      host: 'https://entry-two.example',
      token: 'second-token',
    );
    expect(machine.host, 'https://entry-two.example');
    expect(machine.token, 'second-token');
    expect(
      machine.buildHttpUrl('/api/air'),
      'https://entry-two.example/api/machines/machine_a/proxy/api/air',
    );
  });

  test('docs entries open the target computer, never the entry fallback', () async {
    final local = await entry();
    DocsRegistryEntry doc(String url) => DocsRegistryEntry.fromJson({
      'id': 'doc_${url.hashCode}',
      'kind': url.startsWith('http') ? 'service' : 'page',
      'title': 'entry',
      'url': url,
    });
    final service = doc('http://127.0.0.1:5173/');
    final page = doc('/artifacts/art_1/report.html');
    final guide = doc('/docs/guide');

    final a = local.forMachine(
      'machine_a',
      '电脑甲',
      origin: 'https://remote.example:8443',
    );
    expect(
      docsRegistryEntryUri(a, service).toString(),
      'http://remote.example:5173/',
    );
    expect(
      docsRegistryEntryUri(a, page).toString(),
      'https://remote.example:8443/artifacts/art_1/report.html',
    );
    final scoped = docsRegistryEntryUri(a, guide)!;
    expect(scoped.origin, 'https://entry.example');
    expect(scoped.path, '/docs/guide');
    expect(scoped.queryParameters['machine'], 'machine_a');
    expect(scoped.queryParameters['machineName'], '电脑甲');

    // origin 未知：资源根与 loopback 都不能回落到入口电脑。
    final b = local.forMachine('machine_b', '电脑乙');
    expect(docsRegistryEntryUri(b, service), isNull);
    expect(docsRegistryEntryUri(b, page), isNull);
  });

  testWidgets(
    'machine chat resources without an origin never fall back to the entry',
    (tester) async {
      final local = await entry();
      final machine = local.forMachine('machine_b', '电脑乙');
      await tester.pumpWidget(
        Provider<SettingsService>.value(
          value: machine,
          child: MaterialApp(
            home: Scaffold(
              body: MessageBubble(
                message: ChatMessage(
                  role: MessageRole.assistant,
                  content: '[报告](/artifacts/a/report.html)',
                ),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('报告'));
      await tester.pump();
      expect(find.text(t('airMachinesUnavailable')), findsOneWidget);
      // 机器资源路径没有被改写回入口电脑；调用方应该拿不到可打开的地址。
      expect(machine.machinePageUrl('/artifacts/a/report.html'), isNull);
    },
  );

  testWidgets('machine shell offers no logout entry', (tester) async {
    final settings = await entry();
    final client = MockClient(
      (_) async => http.Response(
        '{}',
        200,
        headers: {'content-type': 'application/json; charset=utf-8'},
      ),
    );
    final store = AirOpsStore(settings: settings, httpClient: client);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: AirOpsPanel(store: store, onOpenPush: () {}, onLogout: null),
        ),
      ),
    );
    expect(find.byKey(const ValueKey('air-logout-btn')), findsNothing);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: AirOpsPanel(store: store, onOpenPush: () {}, onLogout: () {}),
        ),
      ),
    );
    expect(find.byKey(const ValueKey('air-logout-btn')), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
    store.dispose();
    client.close();
  });
}
