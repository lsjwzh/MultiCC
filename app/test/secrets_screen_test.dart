import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/screens/secrets_screen.dart';
import 'package:multicc_app/services/manage_service.dart';
import 'package:multicc_app/services/settings_service.dart';

// 敏感信息保险箱（App 端 /manage「敏感信息」面板的镜像）——wire contract
// 对齐 src/secrets-vault.js：GET/POST /api/secrets、DELETE /api/secrets/:name、
// GET /api/secrets/:name/value（仅「显示」单条读取）。
// 红线同 web：列表只有元数据；值只在用户点显示时单条读回，绝不进对话。

http.Response _json(int status, Object body) => http.Response(
  jsonEncode(body),
  status,
  headers: {'content-type': 'application/json'},
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(() => I18n.init('zh'));

  Future<SettingsService> mockSettings() async {
    SharedPreferences.setMockInitialValues({
      'multicc_host': 'http://server.example',
      'multicc_token': 'secret',
    });
    return SettingsService.getInstance();
  }

  test('manage service hits the secrets wire contract', () async {
    final settings = await mockSettings();
    final calls = <String>[];
    final svc = ManageService(
      settings: settings,
      httpClient: MockClient((request) async {
        expect(request.headers['X-Access-Token'], 'secret');
        if (request.url.path == '/api/secrets') {
          if (request.method == 'GET') {
            calls.add('GET /api/secrets');
            return _json(200, [
              {'name': 'MY_TOKEN', 'description': '', 'source': 'user'},
            ]);
          }
          calls.add('POST ${request.body}');
          return _json(201, {
            'ok': true,
            'entry': {'name': 'MY_TOKEN'},
          });
        }
        if (request.url.path == '/api/secrets/MY_TOKEN') {
          calls.add('DELETE /api/secrets/MY_TOKEN');
          return _json(200, {'ok': true});
        }
        if (request.url.path == '/api/secrets/MY_TOKEN/value') {
          calls.add('GET value');
          return _json(200, {
            'ok': true,
            'name': 'MY_TOKEN',
            'value': 'tok-1',
          });
        }
        return _json(404, {'error': 'nope'});
      }),
    );

    expect((await svc.fetchSecrets()).length, 1);
    await svc.saveSecret('MY_TOKEN', 'tok-1', description: 'desc');
    expect(await svc.revealSecret('MY_TOKEN'), 'tok-1');
    await svc.deleteSecret('MY_TOKEN');
    expect(calls, [
      'GET /api/secrets',
      'POST {"name":"MY_TOKEN","value":"tok-1","description":"desc"}',
      'GET value',
      'DELETE /api/secrets/MY_TOKEN',
    ]);
  });

  testWidgets('settings screen lists entries and masks the add-value field', (
    tester,
  ) async {
    final settings = await mockSettings();
    var listCalls = 0;
    final screen = SecretsScreen(
      settings: settings,
      httpClient: MockClient((request) async {
        if (request.url.path == '/api/secrets' && request.method == 'GET') {
          listCalls++;
          return _json(200, [
            {
              'name': 'MY_TOKEN',
              'description': '测试条目',
              'source': 'agent',
              'updatedAt': '2026-09-19T02:03:04.000Z',
            },
          ]);
        }
        return _json(404, {'error': 'nope'});
      }),
    );
    await tester.pumpWidget(MaterialApp(home: screen));
    await tester.pumpAndSettle();

    expect(listCalls, 1);
    expect(find.byKey(const Key('secrets-row-MY_TOKEN')), findsOneWidget);
    expect(find.text('MY_TOKEN'), findsOneWidget);
    expect(find.text('测试条目'), findsOneWidget);
    // 值字段是密码框——输入的密钥绝不能明文回显。
    final field = tester.widget<TextField>(
      find.byKey(const Key('secrets-add-value')),
    );
    expect(field.obscureText, isTrue);
    // 列表是元数据：不出现任何 value 字段值（本来也没拉取）。
    expect(find.byKey(const Key('secrets-revealed-MY_TOKEN')), findsNothing);
  });

  // 「触发用户弹窗填写 key/value」的设置侧场景：填写名称+值 → POST /api/secrets
  // 直存本地保险箱，成功后清空表单并刷新列表；值不出现在任何聊天语义的位置。
  testWidgets('adding an entry posts to the vault and refreshes the list', (
    tester,
  ) async {
    final settings = await mockSettings();
    http.Request? posted;
    var version = 0;
    final screen = SecretsScreen(
      settings: settings,
      httpClient: MockClient((request) async {
        if (request.url.path == '/api/secrets' && request.method == 'POST') {
          posted = request;
          return _json(201, {
            'ok': true,
            'entry': {'name': 'NEW_KEY'},
          });
        }
        version++;
        return _json(200, [
          if (version > 1)
            {
              'name': 'NEW_KEY',
              'description': '',
              'source': 'user',
              'updatedAt': '2026-09-19T02:03:04.000Z',
            },
        ]);
      }),
    );
    await tester.pumpWidget(MaterialApp(home: screen));
    await tester.pumpAndSettle();

    await tester.enterText(
      find.byKey(const Key('secrets-add-name')),
      'NEW_KEY',
    );
    await tester.enterText(
      find.byKey(const Key('secrets-add-value')),
      'sk-live-123',
    );
    await tester.tap(find.byKey(const Key('secrets-add-save')));
    await tester.pumpAndSettle();

    // wire：POST body 只有 name/value(/description)，与安全弹框同一落点。
    expect(posted, isNotNull);
    expect(posted!.url.path, '/api/secrets');
    final body = jsonDecode(posted!.body) as Map<String, dynamic>;
    expect(body['name'], 'NEW_KEY');
    expect(body['value'], 'sk-live-123');
    // 成功后：表单清空、列表刷新出条目、明文值不在页面上。
    expect(find.widgetWithText(TextField, 'NEW_KEY'), findsNothing);
    expect(find.byKey(const Key('secrets-row-NEW_KEY')), findsOneWidget);
    expect(find.text('sk-live-123'), findsNothing);
  });

  testWidgets('reveal fetches one value on tap and hides it on tap again', (
    tester,
  ) async {
    final settings = await mockSettings();
    var revealCalls = 0;
    final screen = SecretsScreen(
      settings: settings,
      httpClient: MockClient((request) async {
        if (request.url.path == '/api/secrets/MY_TOKEN/value') {
          revealCalls++;
          return _json(200, {
            'ok': true,
            'name': 'MY_TOKEN',
            'value': 'tok-1',
          });
        }
        return _json(200, [
          {
            'name': 'MY_TOKEN',
            'description': '',
            'source': 'user',
            'updatedAt': '2026-09-19T02:03:04.000Z',
          },
        ]);
      }),
    );
    await tester.pumpWidget(MaterialApp(home: screen));
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('secrets-reveal-MY_TOKEN')));
    await tester.pumpAndSettle();
    expect(revealCalls, 1);
    expect(find.byKey(const Key('secrets-revealed-MY_TOKEN')), findsOneWidget);
    expect(find.text('tok-1'), findsOneWidget);

    await tester.tap(find.byKey(const Key('secrets-reveal-MY_TOKEN')));
    await tester.pumpAndSettle();
    expect(find.text('tok-1'), findsNothing);
  });

  testWidgets('delete asks for confirmation then removes the row', (
    tester,
  ) async {
    final settings = await mockSettings();
    var deleted = 0;
    var gone = false;
    final screen = SecretsScreen(
      settings: settings,
      httpClient: MockClient((request) async {
        if (request.method == 'DELETE') {
          deleted++;
          gone = true;
          return _json(200, {'ok': true});
        }
        return _json(200, [
          if (!gone)
            {
              'name': 'MY_TOKEN',
              'description': '',
              'source': 'user',
              'updatedAt': '2026-09-19T02:03:04.000Z',
            },
        ]);
      }),
    );
    await tester.pumpWidget(MaterialApp(home: screen));
    await tester.pumpAndSettle();

    // 先弹确认；取消不删除。
    await tester.tap(find.byKey(const Key('secrets-delete-MY_TOKEN')));
    await tester.pumpAndSettle();
    expect(find.text('删除 MY_TOKEN？'), findsOneWidget);
    await tester.tap(find.widgetWithText(TextButton, '取消'));
    await tester.pumpAndSettle();
    expect(deleted, 0);

    await tester.tap(find.byKey(const Key('secrets-delete-MY_TOKEN')));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(TextButton, '删除'));
    await tester.pumpAndSettle();
    expect(deleted, 1);
    expect(find.byKey(const Key('secrets-row-MY_TOKEN')), findsNothing);
  });
}
