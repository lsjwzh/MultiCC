import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/models/message.dart';
import 'package:multicc_app/screens/provider_screen.dart';
import 'package:multicc_app/services/agy_accounts_service.dart';
import 'package:multicc_app/services/agy_models_service.dart';
import 'package:multicc_app/services/air_service.dart';
import 'package:multicc_app/services/session_service.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/widgets/air/air_task_config.dart';
import 'package:multicc_app/widgets/create_session_dialog.dart';
import 'package:multicc_app/widgets/run_config/run_config_sheet.dart';
import 'package:multicc_app/widgets/run_config/run_config_wire.dart';
import 'package:shared_preferences/shared_preferences.dart';

http.Response _json(int status, Object body) => http.Response(
  jsonEncode(body),
  status,
  headers: {'content-type': 'application/json; charset=utf-8'},
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  const localId = '1111222233334444';
  const sshRemoteId = 'aaaabbbbccccdddd';
  const relayRemoteId = '5555666677778888';

  setUpAll(() => I18n.init('zh'));

  setUp(() {
    AgyAccountsService.clearCache();
    AgyModelsService.forAccount(null).clearCache();
    AgyModelsService.forAccount(localId).clearCache();
    AgyModelsService.forAccount(sshRemoteId).clearCache();
    AgyModelsService.forAccount(relayRemoteId).clearCache();
    SharedPreferences.setMockInitialValues({
      'multicc_host': 'http://127.0.0.1:8787',
      'multicc_token': 'test-token',
      runConfigSubagentGuideKey: true,
    });
  });

  Future<SettingsService> buildSettings() => SettingsService.getInstance();

  test('AgyAccountsSnapshot 过滤非法 id 并按本地/SSH/借道共享格式化选项文案', () {
    final snap = AgyAccountsSnapshot.fromJson({
      'cli': {'installed': true},
      'local': {'loggedIn': true, 'email': 'host@example.com'},
      'active': sshRemoteId,
      'accounts': [
        {
          'id': localId,
          'label': '本机隔离号',
          'email': 'local@example.com',
          'kind': 'local',
          'loggedIn': true,
          'active': false,
        },
        {
          'id': sshRemoteId,
          'label': 'MacPro 反重力',
          'email': 'pro@example.com',
          'kind': 'remote',
          'remote': {'transport': 'ssh', 'sshTarget': 'user@macpro'},
          'loggedIn': true,
          'active': true,
        },
        {
          'id': relayRemoteId,
          'label': '团队专线号',
          'kind': 'remote',
          'remote': {'transport': 'relay'},
          'loggedIn': true,
          'active': false,
        },
        {
          'id': 'invalid-non-hex',
          'label': '脏数据',
          'loggedIn': true,
        },
      ],
    });

    expect(snap.accounts.map((a) => a.id), [
      localId,
      sshRemoteId,
      relayRemoteId,
    ]);
    expect(snap.defaultOptionLabel, '跟随全局默认（MacPro 反重力）');
    expect(snap.findById(localId)!.optionLabel, '本机隔离号 · local@example.com');
    expect(
      snap.findById(sshRemoteId)!.optionLabel,
      'MacPro 反重力 · SSH 借用 · pro@example.com',
    );
    expect(
      snap.findById(relayRemoteId)!.optionLabel,
      '团队专线号 · 远程共享 · 已登录',
    );
    expect(snap.chipLabelFor(null), 'MacPro 反重力');
    expect(snap.chipLabelFor(relayRemoteId), '团队专线号');
  });

  test('sessionAIConfigPatchBody 与 AirTaskRuntime/AirService 完整携带 cliAccounts.agy', () async {
    final s = await buildSettings();
    final setBody = sessionAIConfigPatchBody(
      provider: '',
      model: 'gemini-4-carbon',
      effort: 'high',
      cliAccounts: {'agy': sshRemoteId},
    );
    expect(setBody['cliAccounts'], {'agy': sshRemoteId});

    final clearBody = sessionAIConfigPatchBody(
      provider: '',
      model: '',
      effort: '',
      cliAccounts: {'agy': null},
    );
    expect(clearBody['cliAccounts'], {'agy': null});

    final seeded = AirTaskRuntime.fromLast({
      'cli': 'agy',
      'cliAccounts': {'agy': sshRemoteId},
      'model': 'gemini-4-carbon',
      'effort': 'high',
    })!.copyWith(agyAccountName: 'MacPro 反重力');
    expect(seeded.agyAccountId, sshRemoteId);
    expect(seeded.routeName, 'MacPro 反重力');

    http.Request? capturedPatch;
    final client = MockClient((req) async {
      if (req.method == 'PATCH' && req.url.path == '/api/sessions/task-demo1') {
        capturedPatch = req;
        return _json(200, {'ok': true});
      }
      return _json(404, {'error': 'not found'});
    });
    final air = AirService(settings: s, httpClient: client);
    await air.patchSessionCliAccounts('task-demo1', {'agy': sshRemoteId});
    expect(capturedPatch, isNotNull);
    expect(jsonDecode(capturedPatch!.body), {
      'cliAccounts': {'agy': sshRemoteId},
    });
  });

  testWidgets('RunConfigSheet 支持选择远程 SSH agy 账号、按账号重拉模型并在切回默认时清空覆盖', (
    tester,
  ) async {
    final s = await buildSettings();
    final requestedModelAccounts = <String?>[];
    final client = MockClient((req) async {
      if (req.url.path == '/api/agy/accounts') {
        return _json(200, {
          'cli': {'installed': true},
          'local': {'loggedIn': false},
          'active': null,
          'accounts': [
            {
              'id': localId,
              'label': '本机一号',
              'email': 'local@example.com',
              'kind': 'local',
              'loggedIn': true,
            },
            {
              'id': sshRemoteId,
              'label': '远程 MacPro',
              'email': 'remote@example.com',
              'kind': 'remote',
              'remote': {'transport': 'ssh'},
              'loggedIn': true,
            },
          ],
        });
      }
      if (req.url.path == '/api/agy/models') {
        final acct = req.url.queryParameters['accountId'];
        requestedModelAccounts.add(acct);
        if (acct == sshRemoteId) {
          return _json(200, {
            'source': 'ssh',
            'models': [
              {'model': 'gemini-4-carbon', 'label': 'Gemini 4 Carbon (Pro)'},
            ],
            'efforts': {
              'agy': {
                'gemini-4-carbon': ['low', 'high'],
              },
            },
          });
        }
        return _json(200, {
          'source': 'cli',
          'models': [
            {'model': 'gemini-4-flash', 'label': 'Gemini 4 Flash'},
          ],
          'efforts': {
            'agy': {
              'gemini-4-flash': ['low', 'medium'],
            },
          },
        });
      }
      if (req.url.path == '/api/subagent-defaults') {
        return _json(200, {'defaults': {}});
      }
      return _json(200, {'providers': []});
    });

    RunConfigOutcome? picked;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (context) => ElevatedButton(
              key: const Key('open'),
              onPressed: () async {
                picked = await showModalBottomSheet<RunConfigOutcome>(
                  context: context,
                  isScrollControlled: true,
                  builder: (_) => RunConfigSheet(
                    cli: SessionCli.agy,
                    providers: const [],
                    provider: '',
                    model: '',
                    effort: '',
                    cliAvailability: const {SessionCli.agy: true},
                    settings: s,
                    httpClient: client,
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

    final picker = find.byKey(const ValueKey('run-agy-account-picker'));
    expect(picker, findsOneWidget);
    expect(find.text('本机 agy 登录（默认）'), findsOneWidget);

    await tester.tap(picker);
    await tester.pumpAndSettle();
    await tester.tap(find.text('远程 MacPro · SSH 借用 · remote@example.com').last);
    await tester.pumpAndSettle();

    expect(requestedModelAccounts, contains(sshRemoteId));
    expect(
      find.text('远程 SSH 借用 · remote@example.com'),
      findsOneWidget,
    );

    final save = find.widgetWithText(ElevatedButton, '保存');
    await tester.ensureVisible(save);
    await tester.tap(save);
    await tester.pumpAndSettle();

    expect(picked, isNotNull);
    expect(picked!.cliAccounts, {'agy': sshRemoteId});
    expect(picked!.providerLabel, '远程 MacPro');

    // 再次打开并把已绑定的远程账号切回第一项「本机 agy 登录（默认）」-> 写出 {'agy': null} 清除会话覆盖
    RunConfigOutcome? cleared;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (context) => ElevatedButton(
              key: const Key('open-clear'),
              onPressed: () async {
                cleared = await showModalBottomSheet<RunConfigOutcome>(
                  context: context,
                  isScrollControlled: true,
                  builder: (_) => RunConfigSheet(
                    cli: SessionCli.agy,
                    agyAccountId: sshRemoteId,
                    providers: const [],
                    provider: '',
                    model: '',
                    effort: '',
                    cliAvailability: const {SessionCli.agy: true},
                    settings: s,
                    httpClient: client,
                  ),
                );
              },
              child: const Text('open-clear'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.byKey(const Key('open-clear')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('run-agy-account-picker')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('本机 agy 登录（默认）').last);
    await tester.pumpAndSettle();
    final saveClear = find.widgetWithText(ElevatedButton, '保存');
    await tester.ensureVisible(saveClear);
    await tester.tap(saveClear);
    await tester.pumpAndSettle();

    expect(cleared, isNotNull);
    expect(cleared!.cliAccounts, {'agy': null});
  });

  testWidgets('RunConfigSheet 遇到已删除的 agyAccountId 时自动回退默认并给出提示', (
    tester,
  ) async {
    final s = await buildSettings();
    final client = MockClient((req) async {
      if (req.url.path == '/api/agy/accounts') {
        return _json(200, {
          'cli': {'installed': true},
          'local': {'loggedIn': false},
          'active': null,
          'accounts': const [],
        });
      }
      if (req.url.path == '/api/agy/models') {
        return _json(200, {'source': 'cli', 'models': const []});
      }
      return _json(200, {});
    });

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: RunConfigSheet(
            cli: SessionCli.agy,
            agyAccountId: 'deadbeefcafebabe',
            providers: const [],
            provider: '',
            model: '',
            effort: '',
            cliAvailability: const {SessionCli.agy: true},
            settings: s,
            httpClient: client,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(
      find.text('之前选的账户已不存在，保存后将改回默认账号。'),
      findsOneWidget,
    );
  });

  testWidgets('CreateSessionDialog 在选择 Antigravity 时可指定远程共享账号并返回 cliAccounts', (
    tester,
  ) async {
    final s = await buildSettings();
    final client = MockClient((req) async {
      if (req.url.path == '/api/agy/accounts') {
        return _json(200, {
          'cli': {'installed': true},
          'local': {'loggedIn': false},
          'active': null,
          'accounts': [
            {
              'id': relayRemoteId,
              'label': '团队专线号',
              'kind': 'remote',
              'remote': {'transport': 'relay'},
              'loggedIn': true,
            },
          ],
        });
      }
      if (req.url.path == '/api/agy/models') {
        return _json(200, {
          'source': 'relay',
          'models': [
            {'model': 'gemini-4-carbon', 'label': 'Gemini 4 Carbon'},
          ],
        });
      }
      if (req.url.path == '/api/cli-tools') {
        return _json(200, {
          'tools': {
            'agy': {'installed': true},
          },
        });
      }
      return _json(200, {'providers': []});
    });

    CreateSessionResult? created;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (context) => ElevatedButton(
              key: const Key('open-create'),
              onPressed: () async {
                created = await showDialog<CreateSessionResult>(
                  context: context,
                  builder: (_) => CreateSessionDialog(
                    kind: SessionKind.chat,
                    defaultCli: SessionCli.agy,
                    cliAvailability: const {SessionCli.agy: true},
                    providers: const [],
                    settings: s,
                    selfLoad: true,
                    httpClient: client,
                  ),
                );
              },
              child: const Text('create'),
            ),
          ),
        ),
      ),
    );

    await tester.tap(find.byKey(const Key('open-create')));
    await tester.pumpAndSettle();

    final picker = find.byKey(
      const ValueKey('create-session-agy-account-picker'),
    );
    expect(picker, findsOneWidget);
    await tester.tap(picker);
    await tester.pumpAndSettle();
    await tester.tap(find.text('团队专线号 · 远程共享 · 已登录').last);
    await tester.pumpAndSettle();

    final submit = find.widgetWithText(ElevatedButton, t('create'));
    await tester.ensureVisible(submit);
    await tester.tap(submit);
    await tester.pumpAndSettle();

    expect(created, isNotNull);
    expect(created!.cli, SessionCli.agy);
    expect(created!.cliAccounts, {'agy': relayRemoteId});
  });

  testWidgets('ProviderScreen 展示 Antigravity 账号卡片并支持将远程账号设为全局默认与恢复本机默认', (
    tester,
  ) async {
    final s = await buildSettings();
    String? activeId;
    final calls = <String>[];
    Map<String, dynamic> statePayload() => {
      'cli': {'installed': true},
      'local': {'loggedIn': true, 'email': 'local@example.com'},
      'active': activeId,
      'accounts': [
        {
          'id': sshRemoteId,
          'label': 'MacPro 反重力号',
          'email': 'pro@example.com',
          'kind': 'remote',
          'remote': {'transport': 'ssh'},
          'loggedIn': true,
          'active': activeId == sshRemoteId,
        },
      ],
    };
    final client = MockClient((req) async {
      calls.add('${req.method} ${req.url.path}');
      if (req.method == 'GET' && req.url.path == '/api/providers') {
        return _json(200, {
          'providers': const [],
          'defaults': {'claude': null, 'codex': null},
          'ccSwitchAvailable': false,
        });
      }
      if (req.method == 'GET' && req.url.path == '/api/agy/accounts') {
        return _json(200, statePayload());
      }
      if (req.method == 'POST' &&
          req.url.path == '/api/agy/accounts/$sshRemoteId/activate') {
        activeId = sshRemoteId;
        return _json(200, statePayload());
      }
      if (req.method == 'POST' &&
          req.url.path == '/api/agy/accounts/deactivate') {
        activeId = null;
        return _json(200, statePayload());
      }
      return _json(200, {'ok': true});
    });

    await tester.pumpWidget(
      MaterialApp(
        home: ProviderScreen(settings: s, httpClient: client),
      ),
    );
    await tester.pumpAndSettle();

    final card = find.byKey(const ValueKey('provider-agy-accounts-card'));
    await tester.scrollUntilVisible(
      card,
      250,
      scrollable: find.byType(Scrollable).first,
    );
    await tester.pumpAndSettle();

    expect(card, findsOneWidget);
    expect(find.text('MacPro 反重力号'), findsOneWidget);
    expect(find.text('远程 SSH 借用 · pro@example.com'), findsOneWidget);

    final activateBtn = find.byKey(
      const ValueKey('provider-agy-activate-$sshRemoteId'),
    );
    await tester.ensureVisible(activateBtn);
    await tester.tap(activateBtn);
    await tester.pumpAndSettle();

    expect(calls, contains('POST /api/agy/accounts/$sshRemoteId/activate'));
    expect(find.text('全局默认'), findsOneWidget);

    final deactivateBtn = find.byKey(
      const ValueKey('provider-agy-deactivate'),
    );
    await tester.ensureVisible(deactivateBtn);
    await tester.tap(deactivateBtn);
    await tester.pumpAndSettle();

    expect(calls, contains('POST /api/agy/accounts/deactivate'));
  });
}
